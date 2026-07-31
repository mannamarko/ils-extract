#!/usr/bin/env node
/**
 * ILS Hospitals Press & Media Scraper (Node.js)
 * ---------------------------------------------------------------
 * Extracts the press coverage listed at
 *   https://ilshospitals.com/press-and-media/
 * into JSON (default ils_press_and_media.json + the small index
 * press_and_media.json).
 *
 * WHAT A "PRESS AND MEDIA" ENTRY IS HERE. Press items are their own WordPress
 * custom post type (`press-and-media`, 97 items via WP REST). The hub page is
 * a flat grid of `.csr-sec-item` cards — the same theme markup CSR and events
 * reuse — but with a twist: the card's anchor is NOT a link to a detail page.
 * It is one of two shapes:
 *
 *   kind = "clipping"          80 items. `a[data-lightbox="example-set"]` whose
 *                              href is the featured image itself (a scan of the
 *                              newspaper clipping). The card is the whole story;
 *                              there is nothing to click through to.
 *   kind = "external_article"  17 items. `a[target="_blank"]` pointing off-site
 *                              at the publication that ran the piece. The href
 *                              is the post's `content` pasted verbatim, so
 *                              three of them carry the trailing "\n\n&nbsp;"
 *                              from the editor (recorded raw AND cleaned,
 *                              flagged `external_url_malformed_markup`).
 *
 * NO PAGINATION. All 97 cards render on the single /press-and-media/ page
 * (confirmed: /press-and-media/page/2/ 500s), same as /csr/ and /gallery/.
 * The card order is exactly REST `date DESC` (verified 97/97), so
 * `listing_position` is recorded but nothing depends on parsing order.
 *
 * TWO-PASS PATTERN (as with csr/events/doctors/procedures/packages):
 *   pass 1  the authoritative list comes from WP REST
 *           /wp-json/wp/v2/press-and-media (id, slug, url, dates, title,
 *           content, featured_media), enriched by ONE batched
 *           /wp-json/wp/v2/media?include=<ids> call for each clipping's image
 *           (source_url, dimensions, mime, alt, caption) and by the hub page
 *           itself for the card title, anchor kind and lightbox/external href.
 *           Writes the small index press_and_media.json.
 *   pass 2  visit each /press-and-media/<slug>/ page for its banner heading,
 *           rendered breadcrumb and full SEO block.
 *
 * JOINING CARDS TO POSTS. The cards carry no slug, no post id and no link back
 * to the CPT, so the join key is the image: card `<img src>` == the featured
 * media `source_url`. All 97 featured images are distinct (verified), so the
 * mapping is unambiguous; a card that fails to match is reported
 * `card_unmatched` rather than guessed at by title (several publications
 * appear two or three times under the same name).
 *
 * THE DETAIL PAGES ARE NOT DETAIL PAGES. /press-and-media/<slug>/ resolves 200
 * and swaps in the item's `<title>`, banner `<h2>` and breadcrumb leaf — and
 * then renders the ENTIRE 97-card listing again as its body. There is no
 * per-item view anywhere on the site (the clipping is only ever reachable via
 * the hub's lightbox). That is the single biggest defect of this content type,
 * so it is recorded per record as `detail_page_renders_full_listing` — it fires
 * on all 97 by design, and the cards are deliberately NOT re-parsed there
 * (they would duplicate the hub 97 times for no information).
 *
 * OTHER DEFECTS RECORDED, NOT CORRECTED:
 *   - `invalid_publish_date`  2 posts are dated in the year 0202
 *     (content-media-solution, media-bulletins) — a typo'd 2025 that WordPress
 *     accepted. Kept verbatim; `published_date_valid: false` marks them.
 *   - `missing_title`         1 post (slug "17609") was never given a title, so
 *     its card renders an empty `<h3>` and its slug fell back to the post id.
 *   - `image_missing_alt`     every card `<img>` ships with NO alt attribute at
 *     all, and all 97 media records have empty `alt_text` — 97 clippings of
 *     text that is invisible to search and to screen readers.
 *   - `media_mime_mismatch`   36 media records are served as `.webp` but
 *     registered `image/jpeg` in the media library.
 *   - `missing_meta_description` the 80 clippings have empty post content, and
 *     AIOSEO derives the description from content — so their pages ship no
 *     description (and no og:description) at all. The 17 external ones "have"
 *     one: the raw article URL.
 *   - `og_image_generic_logo` / `og_image_ignores_featured_image` — og:image is
 *     the site logo on every page even though each post HAS a featured image.
 *
 * SEO. Like csr/events/gallery, these pages ship a SINGLE meta + ld+json block
 * (AIOSEO) rather than the theme+AIOSEO pair posts/departments carry, so
 * `no_post_specific_schema` / `no_post_specific_meta` are structural here and
 * dropped from the tally. The AIOSEO @graph is BreadcrumbList / Organization /
 * WebPage / WebSite only — no Article/NewsArticle node for the coverage itself,
 * recorded structurally rather than worked around. There is no twitter:url meta
 * on these pages at all, so the `twitter_url_placeholder` check other scrapers
 * run cannot fire; `missing_twitter_url` is recorded instead.
 *
 * Requires: axios, cheerio (npm install axios cheerio)
 *
 * Usage:
 *   node ils-press-media-scraper.js                     # all -> ils_press_and_media.json
 *   node ils-press-media-scraper.js --slug aajkaal
 *   node ils-press-media-scraper.js --limit 5
 *   node ils-press-media-scraper.js --from-list press_and_media.json
 *   node ils-press-media-scraper.js --index-only        # pass 1 only -> press_and_media.json
 *   node ils-press-media-scraper.js --from-cache        # reparse cached HTML, no network
 *   node ils-press-media-scraper.js --refresh           # re-fetch, overwrite cache
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const {
  REQUEST_DELAY_MS,
  CACHE_DIR,
  cacheMode,
  sleep,
  normalizeHtmlWhitespace,
  fetchHtml,
  fetchJson,
  trimOrNull,
  extractBreadcrumbs,
  extractSeo,
} = require("./scrape-lib");

const HUB_URL = "https://ilshospitals.com/press-and-media/";
const REST_URL =
  "https://ilshospitals.com/wp-json/wp/v2/press-and-media?per_page=100&orderby=date&order=desc" +
  "&_fields=id,slug,link,date,modified,title,content,featured_media";
const MEDIA_URL = "https://ilshospitals.com/wp-json/wp/v2/media";
const SITE_ORIGIN = "https://ilshospitals.com";

const collapse = (s) => (s || "").replace(/\s+/g, " ").trim() || null;

/**
 * REST hands back entity-encoded titles ("The Telegraph &#8211; My Kolkata")
 * while the hub cards render the decoded text, so titles are decoded here to
 * keep both halves of a record — and `content_text` — in the same alphabet.
 */
const decodeHtml = (s) => collapse(s ? cheerio.load(`<x>${s}</x>`)("x").text() : null);

function absoluteUrl(href) {
  if (!href) return null;
  const h = (href || "").trim();
  if (!h || h === "#") return null;
  if (/^(mailto:|tel:)/i.test(h)) return h;
  try {
    return new URL(h, SITE_ORIGIN).href;
  } catch (e) {
    return h;
  }
}

/**
 * The external hrefs are the post `content` pasted straight into the template,
 * so they can carry the editor's trailing newlines and a literal `&nbsp;`
 * ("https://biznewsdesk.com/...\n\n "). Return { url, raw, malformed }: `url`
 * is the first whitespace-delimited token, `raw` the untouched attribute.
 */
function cleanExternalHref(href) {
  const raw = href == null ? null : String(href);
  if (raw === null) return { url: null, raw: null, malformed: false };
  const stripped = raw.replace(/&nbsp;/gi, " ").replace(/\u00a0/g, " ").trim();
  const first = stripped.split(/\s+/)[0] || null;
  // Compared against the untouched attribute, not a trimmed copy: String.trim()
  // eats U+00A0, which would hide the very defect this is here to record.
  return { url: first, raw, malformed: first !== raw };
}

/** A publish date the site typed wrong (the two year-0202 posts) is still kept. */
function isValidDate(d) {
  if (!d) return false;
  const t = Date.parse(d);
  if (Number.isNaN(t)) return false;
  const year = Number(String(d).slice(0, 4));
  return year >= 1990 && year <= new Date().getFullYear() + 1;
}

/** The breadcrumb the page actually renders, in the banner. */
function extractVisibleBreadcrumb($, banner) {
  const span = banner
    .find("span")
    .filter((_, el) => $(el).find("a").length > 0)
    .first();
  if (!span.length) return [];
  const crumbs = [];
  span.children("a").each((_, el) => {
    crumbs.push({ name: collapse($(el).text()), url: absoluteUrl($(el).attr("href")) });
  });
  const current = collapse(span.children("strong").first().text());
  if (current) crumbs.push({ name: current, url: null });
  return crumbs;
}

// ---------- pass 1: the hub grid ----------

/**
 * Parse the 97 cards of section.press-media-sec into
 * [{ position, card_title, image_src, kind, lightbox_href, external_url, ... }].
 * Keyed downstream by `image_src`, the only field that ties a card to its post.
 */
function parseHubCards($) {
  const cards = [];
  $("section.press-media-sec .row > div").each((_, el) => {
    const $card = $(el);
    const $a = $card.find("> a").first();
    const $img = $card.find("img").first();
    const src = absoluteUrl($img.attr("src"));
    if (!src) return;

    const isLightbox = $a.attr("data-lightbox") !== undefined;
    const ext = isLightbox ? { url: null, raw: null, malformed: false } : cleanExternalHref($a.attr("href"));

    cards.push({
      position: cards.length + 1,
      card_title: collapse($card.find(".csr-bottom h3").first().text()),
      image_src: src,
      image_alt: trimOrNull($img.attr("alt")), // always null: no alt attribute is ever emitted
      kind: isLightbox ? "clipping" : "external_article",
      lightbox_href: isLightbox ? absoluteUrl($a.attr("href")) : null,
      lightbox_group: $a.attr("data-lightbox") || null,
      external_url: ext.url ? absoluteUrl(ext.url) : null,
      external_url_raw: ext.raw,
      external_url_malformed: ext.malformed,
      link_target: $a.attr("target") || null,
    });
  });
  return cards;
}

/** Fetch the hub once: its cards, plus the page itself for the hub SEO record. */
async function loadHub() {
  const { html } = await fetchHtml(HUB_URL, "press-and-media/_hub");
  if (!html) return { cards: [], hub: null };
  const $ = cheerio.load(html);
  const cards = parseHubCards($);

  const banner = $("section.page-banner").first();
  const seo = extractSeo($, HUB_URL);
  seo.breadcrumbs = extractBreadcrumbs(seo.json_ld); // BreadcrumbList lives in the AIOSEO @graph
  const issues = seo.seo_issues.filter(
    (c) => c !== "no_post_specific_schema" && c !== "no_post_specific_meta"
  );
  if (seo.og.image && /\/logo\.[a-z]+$/i.test(seo.og.image)) issues.push("og_image_generic_logo");
  if (cards.length && cards.every((c) => !c.image_alt)) issues.push("image_missing_alt");
  seo.seo_issues = issues;

  const hub = {
    url: HUB_URL,
    title: collapse(banner.find("h2").first().text()),
    breadcrumb: extractVisibleBreadcrumb($, banner),
    item_count: cards.length,
    seo,
    seo_issues: issues,
  };
  console.log(`[info] hub: ${cards.length} press cards`);
  return { cards, hub };
}

/**
 * One batched /wp/v2/media call per 100 featured-media ids -> Map(id -> media).
 * Chunked rather than one request per post: 97 ids fit in a single call today,
 * but the CPT grows every month.
 */
async function loadMedia(ids) {
  const byId = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const url =
      `${MEDIA_URL}?include=${chunk.join(",")}&per_page=100` +
      "&_fields=id,source_url,alt_text,caption,title,mime_type,date,media_details";
    const { data } = await fetchJson(url, `api/press-and-media-media-${i / 100 + 1}`);
    if (!Array.isArray(data)) continue;
    for (const m of data) byId.set(m.id, m);
  }
  console.log(`[info] media: ${byId.size}/${unique.length} featured images resolved`);
  return byId;
}

/** Fold a WP media record into the compact image block kept on each entry. */
function buildImage(media, card) {
  if (!media) {
    return card
      ? { media_id: null, src: card.image_src, alt: null, caption: null, mime_type: null, width: null, height: null, filename: null, media_title: null }
      : null;
  }
  const d = media.media_details || {};
  return {
    media_id: media.id,
    src: media.source_url || (card && card.image_src) || null,
    alt: trimOrNull(media.alt_text),
    caption: collapse(cheerio.load(media.caption ? media.caption.rendered || "" : "").text()),
    media_title: collapse(media.title && media.title.rendered),
    mime_type: media.mime_type || null,
    width: d.width ?? null,
    height: d.height ?? null,
    filename: d.file ? d.file.split("/").pop() : null,
    uploaded_date: media.date || null,
  };
}

/** True when the file extension and the registered mime type disagree. */
function mimeMismatch(image) {
  if (!image || !image.src || !image.mime_type) return false;
  const ext = (image.src.match(/\.([a-z0-9]{2,5})(?:$|\?)/i) || [])[1];
  if (!ext) return false;
  const sub = (image.mime_type.split("/")[1] || "").toLowerCase();
  if (sub === "jpeg" && /^jpe?g$/i.test(ext)) return false; // .jpg registered image/jpeg is correct
  return sub !== ext.toLowerCase();
}

/**
 * Resolve the list of press entries to visit, as
 * [{ id, slug, url, title, kind, image, external_url, ... }]. WP REST is
 * authoritative for which posts exist; --from-list replays a prior index.
 */
async function loadPressList(fromList) {
  if (fromList) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), fromList), "utf-8"));
    console.log(`[info] press list from ${fromList}: ${raw.length} entries`);
    return { list: raw, hub: null };
  }

  const { data } = await fetchJson(REST_URL, "api/press-and-media");
  if (!Array.isArray(data) || !data.length) {
    throw new Error(`could not load the press list from ${REST_URL}`);
  }

  const { cards, hub } = await loadHub();
  const media = await loadMedia(data.map((d) => d.featured_media));
  const cardBySrc = new Map();
  for (const c of cards) if (!cardBySrc.has(c.image_src)) cardBySrc.set(c.image_src, c);
  const matchedSrc = new Set();

  const list = data.map((d) => {
    const m = media.get(d.featured_media) || null;
    const card = (m && cardBySrc.get(m.source_url)) || null;
    if (card) matchedSrc.add(card.image_src);

    const contentHtml = normalizeHtmlWhitespace((d.content && d.content.rendered) || "") || null;
    const contentText = decodeHtml(contentHtml);
    // For external items the post content IS the article URL; the card href is
    // the same string, so it only backs the card up when the hub row is missing.
    const contentUrl = contentText && /^https?:\/\//i.test(contentText) ? contentText.split(/\s+/)[0] : null;
    const kind = card ? card.kind : contentUrl ? "external_article" : "clipping";

    return {
      id: d.id ?? null,
      slug: d.slug,
      url: d.link || `${SITE_ORIGIN}/press-and-media/${d.slug}/`,
      title: decodeHtml(d.title && d.title.rendered),
      card_title: card ? card.card_title : null,
      listing_position: card ? card.position : null,
      kind,
      publication: (card && card.card_title) || decodeHtml(d.title && d.title.rendered),
      external_url: (card && card.external_url) || contentUrl || null,
      external_url_raw: card ? card.external_url_raw : null,
      external_url_malformed: card ? card.external_url_malformed : false,
      lightbox_href: card ? card.lightbox_href : null,
      image: buildImage(m, card),
      content_html: contentHtml,
      content_text: contentText,
      published_date: d.date || null,
      published_date_valid: isValidDate(d.date),
      modified_date: d.modified || null,
    };
  });

  const orphans = cards.filter((c) => !matchedSrc.has(c.image_src));
  if (cards.length && cards.length !== list.length) {
    console.log(`[warn] hub cards (${cards.length}) != REST press posts (${list.length})`);
  }
  if (orphans.length) {
    console.log(`[warn] ${orphans.length} hub cards matched no REST post (by featured image)`);
  }
  console.log(`[info] press list from REST: ${list.length} entries`);
  return { list, hub, orphans };
}

// ---------- pass 2: a /press-and-media/<slug>/ page ----------

function scrapePressItem(html, entry) {
  const $ = cheerio.load(html);
  const url = entry.url;

  // WP stamps the post id on <body class="... postid-15208 ...">; rel=shortlink
  // carries the same id and backs it up if the class is ever dropped.
  const bodyClass = $("body").attr("class") || "";
  const classMatch = bodyClass.match(/\bpostid-(\d+)\b/);
  const shortlink = $('link[rel="shortlink"]').attr("href") || "";
  const shortMatch = shortlink.match(/[?&]p=(\d+)/);
  const pageId = classMatch ? Number(classMatch[1]) : shortMatch ? Number(shortMatch[1]) : null;

  const banner = $("section.page-banner").first();
  const heading = collapse(banner.find("h2").first().text());
  // The body is the hub grid verbatim — counted, never re-parsed (see header).
  const listing_card_count = $("section.press-media-sec .row > div").length;

  const seo = extractSeo($, url);
  seo.breadcrumbs = extractBreadcrumbs(seo.json_ld); // BreadcrumbList lives in the AIOSEO @graph

  // Press-specific defects, layered on extractSeo's own list. The two
  // no_post_specific_* codes are structural for this post type (there is no
  // theme block at all), so they are dropped here to keep the tally meaningful.
  const issues = seo.seo_issues.filter(
    (c) => c !== "no_post_specific_schema" && c !== "no_post_specific_meta"
  );
  if (seo.og.image && /\/logo\.[a-z]+$/i.test(seo.og.image)) issues.push("og_image_generic_logo");
  if (seo.og.image && entry.image && entry.image.src && seo.og.image !== entry.image.src)
    issues.push("og_image_ignores_featured_image");
  if (!seo.twitter.url) issues.push("missing_twitter_url");
  if (!seo.meta_description) issues.push("missing_meta_description");
  if (!seo.og.description) issues.push("missing_og_description");
  if (listing_card_count > 1) issues.push("detail_page_renders_full_listing");
  if (entry.id != null && pageId != null && entry.id !== pageId) issues.push("id_mismatch_with_rest");
  if (!entry.title) issues.push("missing_title");
  if (entry.published_date && !entry.published_date_valid) issues.push("invalid_publish_date");
  if (entry.external_url_malformed) issues.push("external_url_malformed_markup");
  if (entry.kind === "external_article" && !entry.external_url) issues.push("external_link_missing");
  if (!entry.image || !entry.image.src) issues.push("no_featured_image");
  if (entry.image && !entry.image.alt) issues.push("image_missing_alt");
  if (mimeMismatch(entry.image)) issues.push("media_mime_mismatch");
  if (entry.listing_position == null) issues.push("card_unmatched");
  seo.seo_issues = issues;

  return {
    id: pageId ?? entry.id ?? null,
    title: entry.title,
    heading,
    slug: entry.slug,
    url,
    kind: entry.kind,
    publication: entry.publication,
    listing_position: entry.listing_position,
    breadcrumb: extractVisibleBreadcrumb($, banner),
    external_url: entry.external_url,
    external_url_raw: entry.external_url_raw,
    lightbox_href: entry.lightbox_href,
    image: entry.image,
    content_html: entry.content_html,
    content_text: entry.content_text,
    published_date: entry.published_date,
    published_date_valid: entry.published_date_valid,
    modified_date: entry.modified_date,
    listing_card_count,
    seo,
    seo_issues: issues,
  };
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    out: "ils_press_and_media.json",
    indexOut: "press_and_media.json",
    limit: null,
    slug: null,
    fromList: null,
    indexOnly: false,
    fromCache: false,
    refresh: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--out":
        opts.out = args[++i];
        break;
      case "--index-out":
        opts.indexOut = args[++i];
        break;
      case "--limit":
        opts.limit = parseInt(args[++i], 10);
        break;
      case "--slug":
        opts.slug = args[++i];
        break;
      case "--from-list":
        opts.fromList = args[++i];
        break;
      case "--index-only":
        opts.indexOnly = true;
        break;
      case "--from-cache":
        opts.fromCache = true;
        break;
      case "--refresh":
        opts.refresh = true;
        break;
      default:
        break;
    }
  }
  return opts;
}

async function main() {
  const { out, indexOut, limit, slug, fromList, indexOnly, fromCache, refresh } = parseArgs();
  cacheMode.fromCache = fromCache;
  cacheMode.refresh = refresh;
  if (fromCache) console.log(`[info] --from-cache: reading HTML from ${CACHE_DIR}, no network.`);
  if (refresh) console.log("[info] --refresh: re-fetching every page, overwriting cache.");

  const { list: all, hub } = await loadPressList(fromList);
  let list = all;
  if (slug) list = list.filter((e) => e.slug === slug);
  if (limit) list = list.slice(0, limit);
  if (!list.length) {
    console.error("[error] no press entries matched.");
    process.exit(1);
  }

  // Write the small pass-1 index (unless we're replaying one).
  if (!fromList) {
    const indexPath = path.resolve(process.cwd(), indexOut);
    fs.writeFileSync(indexPath, JSON.stringify(all, null, 2), "utf-8");
    console.log(`[info] pass 1: ${all.length} press entries -> ${indexPath}`);
  }
  if (indexOnly) {
    console.log("[done] --index-only: stopping after pass 1.");
    return;
  }

  const items = [];
  for (const entry of list) {
    console.log(`[info] Fetching press entry: ${entry.url}`);
    const { html, fromCache: cached } = await fetchHtml(entry.url, `press-and-media/${entry.slug}`);
    if (!html) {
      console.error(`  [error] no HTML for ${entry.url}`);
      continue;
    }
    try {
      items.push(scrapePressItem(html, entry));
    } catch (e) {
      console.error(`  [error] failed to parse ${entry.url}: ${e.message}`);
    }
    if (!cached) await sleep(REQUEST_DELAY_MS);
  }

  const result = { hub, items };
  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");

  const tally = {};
  for (const e of items) for (const k of e.seo_issues || []) tally[k] = (tally[k] || 0) + 1;
  const kinds = {};
  for (const e of items) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  console.log(`[done] Scraped ${items.length}/${list.length} press entries -> ${outPath}`);
  console.log("[info] kinds:", kinds);
  console.log("[seo]  issue tally:", tally);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
