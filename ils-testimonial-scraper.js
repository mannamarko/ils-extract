#!/usr/bin/env node
/**
 * ILS Hospitals Testimonial Scraper (Node.js)
 * ---------------------------------------------------------------
 * Extracts every patient testimonial listed at
 *   https://ilshospitals.com/testimonial/
 * into JSON (default ils_testimonials.json + the small index testimonials.json).
 *
 * WHAT A "TESTIMONIAL" IS HERE. Its own WordPress custom post type
 * (`testimonial`, 68 items via WP REST, no pagination — X-WP-Total: 68). Every
 * one is a patient success-story video embedded from YouTube plus a short
 * write-up; there is no text-only variant in this corpus.
 *
 * THE LISTING DOES NOT LINK TO DETAIL PAGES. Each card on /testimonial/ is
 * `div.testimonial-main-card > a > div.card`, but that wrapping `<a>` has NO
 * href at all — the cards are decorative, not navigation. REST is therefore
 * the only route to a testimonial's URL; the listing is walked once purely to
 * cross-check the card count against REST (`count_mismatch`) and is not a
 * source of per-item data.
 *
 * TWO-PASS PATTERN (as with events/doctors/procedures/packages):
 *   pass 1  WP REST /wp-json/wp/v2/testimonial is the sole and authoritative
 *           list (id, slug, url, dates, title, content — content doubles as a
 *           fallback if a detail page's own content section is ever missing).
 *           Writes the small index testimonials.json.
 *   pass 2  visit each /testimonial/<slug>/ detail page for the video, the
 *           thumbnail, the write-up and the full SEO block.
 *
 * TWO VIDEO PROVIDERS. 47 of the 68 embed a YouTube `/embed/<id>` iframe; the
 * other 21 embed a Facebook `facebook.com/plugins/video.php?...&href=<encoded
 * FB video/reel URL>&...` iframe instead (confirmed by walking every cached
 * detail page's iframe src). `extractVideo` handles both: for YouTube it
 * records the bare id, for Facebook it decodes the `href` query param to
 * recover the canonical facebook.com/.../videos/<id>/ or /reel/<id>/ URL. No
 * third provider was found in this corpus.
 *
 * A MARKUP BUG THAT SHAPES THE PARSER. `.video-box a.play-video`'s `href`
 * attribute is not a URL — it literally contains the raw, unescaped
 * `<p><iframe src="https://www.youtube.com/embed/<ID>" ...></iframe></p>`
 * markup verbatim inside the attribute value. The YouTube id is therefore
 * recovered by regexing the anchor's own outer HTML rather than reading
 * `.attr("href")`, and every occurrence is recorded as `malformed_video_href`
 * rather than silently normalized away.
 *
 * SECTION SKIPPED ON PURPOSE. The "Other testimonials" carousel at the foot of
 * every detail page is RANDOMIZED — two fetches of the same page returned
 * different, differently-ordered slug sets — so capturing it would make every
 * rerun diff for no reason. Same call as the "Other Health Packages" /
 * "Other FAQs" strips. Do not "restore" it.
 *
 * SEO. Like events/FAQs, testimonial pages ship a SINGLE meta + ld+json block
 * (AIOSEO), page-specific and correct for title/description with a
 * self-referential canonical, so shared `extractSeo` is used unchanged. There
 * being no theme block is structural rather than a per-page defect, so
 * `no_post_specific_schema` / `no_post_specific_meta` are dropped from the
 * tally. What IS recorded:
 *   - `no_videoobject_schema` — the headline finding. Every page exists solely
 *     to host a patient testimonial video, yet the AIOSEO @graph carries
 *     BreadcrumbList / WebPage / Organization / WebSite only — there is no
 *     VideoObject/Clip schema anywhere, so the video is invisible to video rich
 *     results.
 *   - `malformed_video_href` — see above.
 *   - `no_video_found` — no YouTube id could be recovered at all.
 *   - `og_image_generic_logo`, `twitter_url_placeholder` — as elsewhere.
 *
 * Requires: axios, cheerio (npm install axios cheerio)
 *
 * Usage:
 *   node ils-testimonial-scraper.js                       # all -> ils_testimonials.json
 *   node ils-testimonial-scraper.js --slug <slug>
 *   node ils-testimonial-scraper.js --limit 1
 *   node ils-testimonial-scraper.js --from-list testimonials.json
 *   node ils-testimonial-scraper.js --index-only          # pass 1 only -> testimonials.json
 *   node ils-testimonial-scraper.js --from-cache          # reparse cached HTML, no network
 *   node ils-testimonial-scraper.js --refresh             # re-fetch, overwrite cache
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
  graphNodes,
  extractBreadcrumbs,
  extractSeo,
} = require("./scrape-lib");

const LISTING_URL = "https://ilshospitals.com/testimonial/";
const REST_URL =
  "https://ilshospitals.com/wp-json/wp/v2/testimonial?per_page=100&_fields=id,slug,link,date,modified,title,content";
const SITE_ORIGIN = "https://ilshospitals.com";

const collapse = (s) => (s || "").replace(/\s+/g, " ").trim() || null;
const normTitle = (s) => collapse(s || "").toLowerCase();

function absoluteUrl(href) {
  if (!href) return null;
  const h = href.trim();
  if (!h || h === "#") return null;
  if (/^(mailto:|tel:)/i.test(h)) return h;
  try {
    return new URL(h, SITE_ORIGIN).href;
  } catch (e) {
    return h;
  }
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

/** True when no node in any ld+json block is a video schema type. */
function hasVideoSchema(json_ld) {
  return graphNodes(json_ld).some((n) => {
    if (!n) return false;
    const t = n["@type"];
    const types = Array.isArray(t) ? t : [t];
    return types.some((x) => x === "VideoObject" || x === "Clip");
  });
}

// ---------- pass 1: the testimonial list ----------

/**
 * Card titles off the /testimonial/ listing, for a best-effort count/name
 * cross-check only — the cards carry no href to join by slug.
 */
async function loadListingTitles() {
  const { html } = await fetchHtml(LISTING_URL, "testimonials/_listing");
  if (!html) return { titles: [], seo: null };
  const $ = cheerio.load(html);
  const titles = [];
  $(".testimonial-main-card .card-title").each((_, el) => titles.push(collapse($(el).text())));

  const banner = $("section.page-banner").first();
  const seo = extractSeo($, LISTING_URL);
  seo.breadcrumbs = extractBreadcrumbs(seo.json_ld);
  const seo_issues = seo.seo_issues.filter(
    (c) => c !== "no_post_specific_schema" && c !== "no_post_specific_meta"
  );
  if (seo.og.image && /\/logo\.[a-z]+$/i.test(seo.og.image)) seo_issues.push("og_image_generic_logo");
  seo.seo_issues = seo_issues;

  const listing = {
    url: LISTING_URL,
    title: collapse(banner.find("h2").first().text()),
    breadcrumb: extractVisibleBreadcrumb($, banner),
    card_count: titles.length,
    seo,
    seo_issues,
  };
  return { titles, listing };
}

/**
 * Resolve the testimonials to visit, as [{ id, slug, url, title, content,
 * published_date, modified_date }]. WP REST is authoritative for which posts
 * exist; --from-list replays a prior index (and then the listing is not
 * fetched at all).
 */
async function loadTestimonialList(fromList) {
  if (fromList) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), fromList), "utf-8"));
    console.log(`[info] testimonial list from ${fromList}: ${raw.length} entries`);
    return { listing: null, list: raw };
  }

  const { data } = await fetchJson(REST_URL, "api/testimonial");
  if (!Array.isArray(data) || !data.length) {
    throw new Error(`could not load the testimonial list from ${REST_URL}`);
  }

  const { titles, listing } = await loadListingTitles();
  if (listing && titles.length !== data.length) {
    listing.seo_issues.push("count_mismatch");
    console.log(`[warn] listing cards (${titles.length}) != REST testimonials (${data.length})`);
  }
  const titleSet = new Set(titles.map(normTitle));

  const list = data.map((d) => {
    const url = d.link || `${SITE_ORIGIN}/testimonial/${d.slug}/`;
    return {
      id: d.id ?? null,
      slug: d.slug,
      url,
      title: collapse(d.title && d.title.rendered) || null,
      content: (d.content && d.content.rendered) || null,
      on_listing: titleSet.has(normTitle(d.title && d.title.rendered)),
      published_date: d.date || null,
      modified_date: d.modified || null,
    };
  });
  console.log(`[info] testimonial list from REST: ${list.length} entries`);
  return { listing, list };
}

// ---------- pass 2: a testimonial detail page ----------

/**
 * The embedded video. This deliberately regexes the RAW page HTML rather than
 * anything cheerio has parsed: the surrounding markup bug (an `href` whose
 * value is unescaped nested markup, see file header) makes parse5 mis-tokenize
 * the anchor's attributes, and for Facebook's URL shape (no attribute with its
 * own quoted value between `href=` and `src=` to "resync" the parser on) the
 * reconstructed DOM ends up with `src` split across several bogus attributes —
 * verified empirically: cheerio's re-serialized output no longer contains the
 * literal `src="https://..."` substring at all for 21/68 pages, while the raw
 * HTML always does. Handles both providers found in this corpus: YouTube
 * embeds and Facebook plugin embeds, the latter carrying the real
 * facebook.com video/reel URL url-encoded inside the plugin's own `href` query
 * param.
 */
function extractVideo(rawHtml) {
  const start = rawHtml.indexOf("video-testimonial");
  if (start < 0) return { video: null, malformedHref: false };
  const end = rawHtml.indexOf("sub-sec-title", start);
  const slice = rawHtml.slice(start, end > start ? end : start + 4000);

  const malformedHref = /href\s*=\s*"\s*<p>\s*<iframe/i.test(slice);
  const srcMatch = slice.match(/<iframe[^>]*\ssrc="([^"]+)"/i);
  const iframeSrc = srcMatch ? srcMatch[1].replace(/&#0?38;/g, "&").replace(/&amp;/g, "&") : null;

  let video = null;
  const ytMatch = iframeSrc && iframeSrc.match(/youtube\.com\/embed\/([A-Za-z0-9_-]+)/);
  if (ytMatch) {
    video = {
      provider: "youtube",
      youtube_id: ytMatch[1],
      embed_url: `https://www.youtube.com/embed/${ytMatch[1]}`,
      watch_url: `https://www.youtube.com/watch?v=${ytMatch[1]}`,
    };
  } else if (iframeSrc && /facebook\.com\/plugins\/video\.php/.test(iframeSrc)) {
    let watch_url = null;
    try {
      watch_url = new URL(iframeSrc).searchParams.get("href");
    } catch (e) {
      watch_url = null;
    }
    video = { provider: "facebook", youtube_id: null, embed_url: iframeSrc, watch_url };
  } else if (iframeSrc) {
    video = { provider: "unknown", youtube_id: null, embed_url: iframeSrc, watch_url: null };
  }

  return { video, malformedHref };
}

function scrapeTestimonial(html, entry) {
  const $ = cheerio.load(html);
  const url = entry.url;

  // WP stamps the post id on <body class="... postid-17817 ...">; unlike
  // events/faqs, these pages carry no rel=shortlink fallback (confirmed absent
  // on every sample), so the body class is the only source.
  const bodyClass = $("body").attr("class") || "";
  const classMatch = bodyClass.match(/\bpostid-(\d+)\b/);
  const pageId = classMatch ? Number(classMatch[1]) : null;

  const banner = $("section.page-banner").first();
  const title = collapse(banner.find("h2").first().text()) || entry.title || null;

  const section = $("section.csr-sec-for-page").first();
  const { video, malformedHref } = extractVideo(html);
  const thumbnail = absoluteUrl(section.find(".video-box img").first().attr("src"));

  const contentEl = section.find(".tesi-content").first();
  const content_html = contentEl.length
    ? normalizeHtmlWhitespace(contentEl.html().trim())
    : normalizeHtmlWhitespace(entry.content ? entry.content.trim() : null);
  const content_text = contentEl.length ? collapse(contentEl.text()) : collapse(entry.content);

  const seo = extractSeo($, url);
  seo.breadcrumbs = extractBreadcrumbs(seo.json_ld);

  // The two no_post_specific_* codes are structural for this post type (there
  // is no theme meta/schema block at all), so they are dropped here to keep the
  // tally meaningful.
  const issues = seo.seo_issues.filter(
    (c) => c !== "no_post_specific_schema" && c !== "no_post_specific_meta"
  );
  if (!hasVideoSchema(seo.json_ld)) issues.push("no_videoobject_schema");
  if (malformedHref) issues.push("malformed_video_href");
  if (!video) issues.push("no_video_found");
  if (seo.og.image && /\/logo\.[a-z]+$/i.test(seo.og.image)) issues.push("og_image_generic_logo");
  if (seo.twitter.url && seo.twitter.url.replace(/\/$/, "") !== (url || "").replace(/\/$/, ""))
    issues.push("twitter_url_placeholder");
  if (entry.id != null && pageId != null && entry.id !== pageId) issues.push("id_mismatch_with_rest");
  if (!content_html) issues.push("empty_content");
  seo.seo_issues = issues;

  return {
    id: pageId ?? entry.id ?? null,
    title,
    slug: entry.slug,
    url,
    video,
    thumbnail,
    content_html,
    content_text,
    breadcrumb: extractVisibleBreadcrumb($, banner),
    published_date: entry.published_date || null,
    modified_date: entry.modified_date || null,
    seo,
    seo_issues: issues,
  };
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    out: "ils_testimonials.json",
    indexOut: "testimonials.json",
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

  const { listing, list: allTestimonials } = await loadTestimonialList(fromList);
  let list = allTestimonials;
  if (slug) list = list.filter((e) => e.slug === slug);
  if (limit) list = list.slice(0, limit);
  if (!list.length) {
    console.error("[error] no testimonials matched.");
    process.exit(1);
  }

  // Write the small pass-1 index (unless we're replaying one).
  if (!fromList) {
    const indexPath = path.resolve(process.cwd(), indexOut);
    fs.writeFileSync(indexPath, JSON.stringify(allTestimonials, null, 2), "utf-8");
    console.log(`[info] pass 1: ${allTestimonials.length} testimonials -> ${indexPath}`);
  }
  if (indexOnly) {
    console.log("[done] --index-only: stopping after pass 1.");
    return;
  }

  const testimonials = [];
  for (const entry of list) {
    console.log(`[info] Fetching testimonial: ${entry.url}`);
    const { html, fromCache: cached } = await fetchHtml(entry.url, `testimonial/${entry.slug}`);
    if (!html) {
      console.error(`  [error] no HTML for ${entry.url}`);
      continue;
    }
    try {
      testimonials.push(scrapeTestimonial(html, entry));
    } catch (e) {
      console.error(`  [error] failed to parse ${entry.url}: ${e.message}`);
    }
    if (!cached) await sleep(REQUEST_DELAY_MS);
  }

  const payload = { listing, testimonials };
  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");

  const tally = {};
  for (const t of testimonials) for (const k of t.seo_issues || []) tally[k] = (tally[k] || 0) + 1;
  if (listing) for (const k of listing.seo_issues || []) tally[k] = (tally[k] || 0) + 1;
  const noVideo = testimonials.filter((t) => !t.video).length;

  console.log(
    `[done] Scraped ${testimonials.length}/${list.length} testimonials -> ${outPath}`
  );
  if (noVideo) console.log(`[warn] ${noVideo} testimonials had no resolvable video`);
  console.log("[seo]  issue tally:", tally);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
