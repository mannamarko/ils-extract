#!/usr/bin/env node
/**
 * ILS Hospitals CSR Scraper (Node.js)
 * ---------------------------------------------------------------
 * Extracts the CSR initiatives listed at
 *   https://ilshospitals.com/csr/
 * into JSON (default ils_csr.json + the small index csr.json).
 *
 * WHAT A "CSR" ENTRY IS HERE. CSR initiatives are their own WordPress custom
 * post type (`csr`, 13 items via WP REST): the /csr/ hub lists them as
 * `.csr-sec-item` cards, each linking to a detail page /csr/<slug>/. This is
 * the post type the theme's `.csr-sec-item` / `section.csr-sec-for-page`
 * classes are actually named for (ils-event-scraper.js's events reuse the
 * same theme templates, not the other way around).
 *
 * NO PAGINATION. All 13 cards render on the single /csr/ page (confirmed:
 * /csr/page/2/ 500s), unlike /events/ which does paginate. So pass 1 fetches
 * the hub exactly once rather than walking /csr/page/N/.
 *
 * TWO-PASS PATTERN (as with events/courses/doctors/procedures/packages):
 *   pass 1  the authoritative list comes from WP REST /wp-json/wp/v2/csr (id,
 *           slug, url, publish/modified dates, title); the /csr/ hub is walked
 *           once to enrich each entry's card thumbnail + excerpt, matched by
 *           slug. Writes the small index csr.json.
 *   pass 2  visit each /csr/<slug>/ detail page for the banner heading, body
 *           content, gallery images, outbound links and the full SEO block.
 *
 * DETAIL PAGE SHAPE. Banner in `section.page-banner`; body is one
 * `section.csr-sec-for-page` block: an `.owl-carousel` of un-linked photos on
 * one side, an `h2` heading + (sometimes) a descriptive `<p>` on the other.
 * Several entries (e.g. csr-day-2026) ship photos with NO accompanying text —
 * that is a real content gap, not a parsing miss, so `no_body_text` is
 * recorded rather than treated as an error. WP REST exposes no `content` for
 * this post type at all (always ""), so the HTML is the only source, same as
 * `faq-lists`.
 *
 * SECTION SKIPPED ON PURPOSE. Every detail page carries an "Other CSR" strip
 * (`section.other-csr-sec`) showing a handful of sibling entries. Two fetches
 * of the same page returned different subsets, so — like the "Other Health
 * Packages" / "Other FAQs" / "Other testimonials" strips elsewhere — it is
 * RANDOMIZED and deliberately not captured.
 *
 * SEO. Like events/courses/faq-lists, CSR pages ship a SINGLE meta + ld+json
 * block (AIOSEO), page-specific and correct for title/description with a
 * self-referential canonical, so shared `extractSeo` is used almost unchanged.
 * Two consequences are structural rather than per-page defects and are
 * therefore dropped from the tally: there is no theme block, so
 * `no_post_specific_schema` / `no_post_specific_meta` always fire. The AIOSEO
 * @graph carries BreadcrumbList / WebPage / Organization / WebSite / ImageObject
 * only — there is no Article/Event-style schema for the initiative itself
 * (recorded structurally, not worked around) — and og:image is the generic
 * site logo (flagged `og_image_generic_logo`).
 *
 * Requires: axios, cheerio (npm install axios cheerio)
 *
 * Usage:
 *   node ils-csr-scraper.js                       # all -> ils_csr.json
 *   node ils-csr-scraper.js --slug <slug>
 *   node ils-csr-scraper.js --limit 1
 *   node ils-csr-scraper.js --from-list csr.json
 *   node ils-csr-scraper.js --index-only          # pass 1 only -> csr.json
 *   node ils-csr-scraper.js --from-cache          # reparse cached HTML, no network
 *   node ils-csr-scraper.js --refresh             # re-fetch, overwrite cache
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const {
  REQUEST_DELAY_MS,
  CACHE_DIR,
  cacheMode,
  sleep,
  slugFromUrl,
  normalizeHtmlWhitespace,
  fetchHtml,
  fetchJson,
  trimOrNull,
  extractBreadcrumbs,
  extractSeo,
} = require("./scrape-lib");

const HUB_URL = "https://ilshospitals.com/csr/";
const REST_URL =
  "https://ilshospitals.com/wp-json/wp/v2/csr?per_page=100&_fields=id,slug,link,date,modified,title";
const SITE_ORIGIN = "https://ilshospitals.com";
const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "svg", "avif"];

const collapse = (s) => (s || "").replace(/\s+/g, " ").trim() || null;

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

function isImageUrl(url) {
  if (!url) return false;
  try {
    const m = new URL(url, SITE_ORIGIN).pathname.match(/\.([a-z0-9]{2,5})$/i);
    return !!m && IMAGE_EXTS.includes(m[1].toLowerCase());
  } catch (e) {
    return false;
  }
}

// ---------- pass 1: the CSR hub ----------

/**
 * Card enrichment map: slug -> { thumbnail, excerpt }, from the single /csr/
 * page. Best-effort — REST is the authoritative list, so a missing card just
 * leaves those fields null. Some cards' excerpt is literally "..." in the
 * source (csr-day-2026); that is kept verbatim rather than nulled out.
 */
async function loadCardEnrichment() {
  const bySlug = new Map();
  const { html } = await fetchHtml(HUB_URL, "csr/_hub");
  if (!html) return bySlug;
  const $ = cheerio.load(html);

  $(".csr-sec-item").each((_, el) => {
    const $c = $(el);
    const href = $c.closest(".row > div").find('a[href*="/csr/"]').first().attr("href");
    if (!href) return;
    const slug = slugFromUrl(absoluteUrl(href));
    if (!slug || slug === "csr" || bySlug.has(slug)) return;
    bySlug.set(slug, {
      thumbnail: absoluteUrl($c.find("img").first().attr("src")) || null,
      excerpt: collapse($c.find(".csr-sec-item-text p, .csr-bottom p, p").first().text()),
    });
  });
  console.log(`[info] hub enrichment: ${bySlug.size} CSR cards`);
  return bySlug;
}

/**
 * Resolve the list of CSR entries to visit, as [{ id, slug, url, title,
 * thumbnail, excerpt, published_date, modified_date }]. WP REST is
 * authoritative for which posts exist; --from-list replays a prior index.
 */
async function loadCsrList(fromList) {
  if (fromList) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), fromList), "utf-8"));
    console.log(`[info] CSR list from ${fromList}: ${raw.length} entries`);
    return raw.map((e) => ({
      id: e.id ?? null,
      slug: e.slug,
      url: e.url,
      title: e.title || null,
      thumbnail: e.thumbnail || null,
      excerpt: e.excerpt || null,
      published_date: e.published_date || null,
      modified_date: e.modified_date || null,
    }));
  }

  const { data } = await fetchJson(REST_URL, "api/csr");
  if (!Array.isArray(data) || !data.length) {
    throw new Error(`could not load the CSR list from ${REST_URL}`);
  }
  const cards = await loadCardEnrichment();

  const list = data.map((d) => {
    const url = d.link || `${SITE_ORIGIN}/csr/${d.slug}/`;
    const card = cards.get(d.slug) || {};
    return {
      id: d.id ?? null,
      slug: d.slug,
      url,
      title: collapse(d.title && d.title.rendered) || null,
      thumbnail: card.thumbnail || null,
      excerpt: card.excerpt || null,
      published_date: d.date || null,
      modified_date: d.modified || null,
    };
  });
  if (cards.size !== list.length) {
    console.log(`[warn] hub cards (${cards.size}) != REST csr (${list.length})`);
  }
  console.log(`[info] CSR list from REST: ${list.length} entries`);
  return list;
}

// ---------- pass 2: a /csr/<slug>/ detail page ----------

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

/**
 * The carousel photos plus any other images inside the content section. Each
 * is { src, full, alt } where `full` is the anchor target when the image is
 * wrapped in a link to a full-size image; the carousel photos here are NOT
 * link-wrapped, so `full` is null for those.
 */
function extractImages($, body) {
  const images = [];
  body.find("img[src]").each((_, el) => {
    const $img = $(el);
    const src = absoluteUrl($img.attr("src"));
    if (!src) return;
    const parentHref = absoluteUrl($img.parent("a").attr("href"));
    images.push({
      src,
      full: parentHref && isImageUrl(parentHref) && parentHref !== src ? parentHref : null,
      alt: trimOrNull($img.attr("alt")),
    });
  });
  return images;
}

/**
 * Non-image anchor targets inside the content section. De-duplicated, in
 * document order. The carousel itself carries none, but kept for parity with
 * the other scrapers and in case a future entry embeds a reference link.
 */
function extractLinks($, body) {
  const seen = new Set();
  const links = [];
  body.find("a[href]").each((_, el) => {
    const url = absoluteUrl($(el).attr("href"));
    if (!url || isImageUrl(url) || seen.has(url)) return;
    seen.add(url);
    links.push({ text: collapse($(el).text()), url });
  });
  return links;
}

function scrapeCsr(html, entry) {
  const $ = cheerio.load(html);
  const url = entry.url;

  // WP stamps the post id on <body class="... postid-18285 ...">; rel=shortlink
  // carries the same id and backs it up if the class is ever dropped.
  const bodyClass = $("body").attr("class") || "";
  const classMatch = bodyClass.match(/\bpostid-(\d+)\b/);
  const shortlink = $('link[rel="shortlink"]').attr("href") || "";
  const shortMatch = shortlink.match(/[?&]p=(\d+)/);
  const pageId = classMatch ? Number(classMatch[1]) : shortMatch ? Number(shortMatch[1]) : null;

  const banner = $("section.page-banner").first();
  const title = collapse(banner.find("h2").first().text()) || entry.title || null;

  const body = $("section.csr-sec-for-page").first();
  const heading = collapse(body.find("h2").first().text());
  // The text (if any) lives in the second col-md-6, alongside the heading;
  // the carousel col has only images. Grabbing every <p> under the body
  // naturally skips the carousel (it has none).
  const body_text_html = normalizeHtmlWhitespace(
    body
      .find("p")
      .map((_, p) => $.html(p))
      .get()
      .join("") || null
  );
  const content_text = collapse(body.find("p").text());
  const images = extractImages($, body);
  const links = extractLinks($, body);

  const seo = extractSeo($, url);
  seo.breadcrumbs = extractBreadcrumbs(seo.json_ld); // BreadcrumbList lives in the AIOSEO @graph

  // CSR-specific defects, layered on extractSeo's own list. The two
  // no_post_specific_* codes are structural for this post type (there is no
  // theme block at all), so they are dropped here to keep the tally meaningful.
  const issues = seo.seo_issues.filter(
    (c) => c !== "no_post_specific_schema" && c !== "no_post_specific_meta"
  );
  if (seo.og.image && /\/logo\.[a-z]+$/i.test(seo.og.image)) issues.push("og_image_generic_logo");
  if (seo.twitter.url && seo.twitter.url.replace(/\/$/, "") !== (url || "").replace(/\/$/, ""))
    issues.push("twitter_url_placeholder");
  if (entry.id != null && pageId != null && entry.id !== pageId) issues.push("id_mismatch_with_rest");
  if (!content_text) issues.push("no_body_text");
  if (!images.length) issues.push("no_images");
  seo.seo_issues = issues;

  return {
    id: pageId ?? entry.id ?? null,
    title,
    slug: entry.slug,
    url,
    thumbnail: entry.thumbnail || null,
    excerpt: entry.excerpt || null,
    breadcrumb: extractVisibleBreadcrumb($, banner),
    heading,
    body_html: body_text_html,
    body_text: content_text,
    image_count: images.length,
    images,
    links,
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
    out: "ils_csr.json",
    indexOut: "csr.json",
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

  let list = await loadCsrList(fromList);
  if (slug) list = list.filter((e) => e.slug === slug);
  if (limit) list = list.slice(0, limit);
  if (!list.length) {
    console.error("[error] no CSR entries matched.");
    process.exit(1);
  }

  // Write the small pass-1 index (unless we're replaying one).
  if (!fromList) {
    const indexPath = path.resolve(process.cwd(), indexOut);
    fs.writeFileSync(indexPath, JSON.stringify(list, null, 2), "utf-8");
    console.log(`[info] pass 1: ${list.length} CSR entries -> ${indexPath}`);
  }
  if (indexOnly) {
    console.log("[done] --index-only: stopping after pass 1.");
    return;
  }

  const results = [];
  for (const entry of list) {
    console.log(`[info] Fetching CSR entry: ${entry.url}`);
    const { html, fromCache: cached } = await fetchHtml(entry.url, `csr/${entry.slug}`);
    if (!html) {
      console.error(`  [error] no HTML for ${entry.url}`);
      continue;
    }
    try {
      results.push(scrapeCsr(html, entry));
    } catch (e) {
      console.error(`  [error] failed to parse ${entry.url}: ${e.message}`);
    }
    if (!cached) await sleep(REQUEST_DELAY_MS);
  }

  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");

  const tally = {};
  for (const e of results) for (const k of e.seo_issues || []) tally[k] = (tally[k] || 0) + 1;
  const empty = results.filter((e) => !e.body_text).length;
  console.log(`[done] Scraped ${results.length}/${list.length} CSR entries -> ${outPath}`);
  if (empty) console.log(`[warn] ${empty} CSR entries had no body text`);
  console.log("[seo]  issue tally:", tally);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
