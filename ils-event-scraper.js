#!/usr/bin/env node
/**
 * ILS Hospitals Event Scraper (Node.js)
 * ---------------------------------------------------------------
 * Extracts the events listed at
 *   https://ilshospitals.com/events/
 * into JSON (default ils_events.json + the small index events.json).
 *
 * WHAT AN "EVENT" IS HERE. Events are their own WordPress custom post type
 * (`event`, 34 items via WP REST): the /events/ archive lists them as
 * `.csr-sec-item` cards, each linking to a detail page /event/<slug>/. Structure
 * mirrors the academia `course` pages almost exactly (same theme templates).
 *
 * TWO-PASS PATTERN (as with courses/doctors/procedures/packages):
 *   pass 1  the authoritative list comes from WP REST
 *           /wp-json/wp/v2/event (id, slug, url, publish/modified dates, title);
 *           the /events/ archive pages (paginated /events/page/N/) are walked
 *           only to enrich each event's card thumbnail + excerpt, matched by
 *           slug. Writes the small index events.json.
 *   pass 2  visit each /event/<slug>/ detail page for the banner heading, body
 *           content, gallery images, outbound links and the full SEO block.
 *
 * DETAIL PAGE SHAPE. Banner in `section.page-banner`; body is one
 * `section.csr-sec-for-page` block (`h2.comm-black-header` headings + paragraphs
 * + an optional row of anchor-wrapped photos). Images and links are pulled out
 * separately as well as left inline in `content`.
 *
 * SEO. Like courses, event pages ship a SINGLE meta + ld+json block (AIOSEO),
 * page-specific and correct for title/description with a self-referential
 * canonical, so shared `extractSeo` is used almost unchanged. Two consequences
 * are structural rather than per-page defects and are therefore dropped from the
 * tally: there is no theme block, so `no_post_specific_schema` /
 * `no_post_specific_meta` always fire. The AIOSEO @graph carries
 * BreadcrumbList / WebPage / Organization / WebSite / ImageObject only — there
 * is NO Event schema anywhere (recorded structurally, not worked around) — and
 * og:image is the generic site logo (flagged `og_image_generic_logo`).
 *
 * Requires: axios, cheerio (npm install axios cheerio)
 *
 * Usage:
 *   node ils-event-scraper.js                       # all -> ils_events.json
 *   node ils-event-scraper.js --slug <slug>
 *   node ils-event-scraper.js --limit 1
 *   node ils-event-scraper.js --from-list events.json
 *   node ils-event-scraper.js --index-only          # pass 1 only -> events.json
 *   node ils-event-scraper.js --from-cache          # reparse cached HTML, no network
 *   node ils-event-scraper.js --refresh             # re-fetch, overwrite cache
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

const LISTING_URL = "https://ilshospitals.com/events/";
const REST_URL =
  "https://ilshospitals.com/wp-json/wp/v2/event?per_page=100&_fields=id,slug,link,date,modified,title";
const SITE_ORIGIN = "https://ilshospitals.com";
const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "svg", "avif"];
const MAX_LISTING_PAGES = 20; // guard; the archive is only ~2 pages

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

// ---------- pass 1: the events listing ----------

/**
 * Card enrichment map: slug -> { thumbnail, excerpt } gathered by walking the
 * paginated /events/ archive. Best-effort — REST is the authoritative list, so
 * a missing card just leaves those fields null.
 */
async function loadCardEnrichment() {
  const bySlug = new Map();
  for (let page = 1; page <= MAX_LISTING_PAGES; page++) {
    const url = page === 1 ? LISTING_URL : `${LISTING_URL}page/${page}/`;
    const { html } = await fetchHtml(url, `events/_listing-p${page}`);
    if (!html) break; // 404 past the last page
    const $ = cheerio.load(html);

    let found = 0;
    $(".csr-sec-item").each((_, el) => {
      const $c = $(el);
      const href = $c.find('a[href*="/event/"]').first().attr("href");
      if (!href) return;
      const slug = slugFromUrl(absoluteUrl(href));
      if (!slug || slug === "event" || bySlug.has(slug)) return;
      bySlug.set(slug, {
        thumbnail: absoluteUrl($c.find("img").first().attr("src")) || null,
        excerpt: collapse($c.find(".csr-sec-item-text p, .csr-bottom p, p").first().text()),
      });
      found++;
    });

    if (!found) break; // page rendered no new cards; stop paginating
  }
  console.log(`[info] listing enrichment: ${bySlug.size} event cards`);
  return bySlug;
}

/**
 * Resolve the list of events to visit, as [{ id, slug, url, title, thumbnail,
 * excerpt, published_date, modified_date }]. WP REST is authoritative for which
 * posts exist; --from-list replays a prior index.
 */
async function loadEventList(fromList) {
  if (fromList) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), fromList), "utf-8"));
    console.log(`[info] event list from ${fromList}: ${raw.length} entries`);
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

  const { data } = await fetchJson(REST_URL, "api/event");
  if (!Array.isArray(data) || !data.length) {
    throw new Error(`could not load the event list from ${REST_URL}`);
  }
  const cards = await loadCardEnrichment();

  const list = data.map((d) => {
    const url = d.link || `${SITE_ORIGIN}/event/${d.slug}/`;
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
  console.log(`[info] event list from REST: ${list.length} entries`);
  return list;
}

// ---------- pass 2: an event detail page ----------

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
 * Pull the gallery/photo images out of the content section. Each is
 * { src, full, alt } where `full` is the anchor target when the image is
 * wrapped in a link to a full-size image (the site's lightbox pattern).
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
 * Non-image anchor targets inside the content section — registration portals,
 * downloadable brochures, external references. Image-file links are excluded
 * (they belong to extractImages). De-duplicated, in document order.
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

function scrapeEvent(html, entry) {
  const $ = cheerio.load(html);
  const url = entry.url;

  // WP stamps the post id on <body class="... postid-18602 ...">; rel=shortlink
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
  const content = normalizeHtmlWhitespace(body.length ? body.html().trim() : null);
  const content_text = collapse(body.text());
  const images = extractImages($, body);
  const links = extractLinks($, body);

  const seo = extractSeo($, url);
  seo.breadcrumbs = extractBreadcrumbs(seo.json_ld); // BreadcrumbList lives in the AIOSEO @graph

  // Event-specific defects, layered on extractSeo's own list. The two
  // no_post_specific_* codes are structural for this post type (there is no
  // theme block at all), so they are dropped here to keep the tally meaningful.
  const issues = seo.seo_issues.filter(
    (c) => c !== "no_post_specific_schema" && c !== "no_post_specific_meta"
  );
  if (seo.og.image && /\/logo\.[a-z]+$/i.test(seo.og.image)) issues.push("og_image_generic_logo");
  if (seo.twitter.url && seo.twitter.url.replace(/\/$/, "") !== (url || "").replace(/\/$/, ""))
    issues.push("twitter_url_placeholder");
  if (entry.id != null && pageId != null && entry.id !== pageId) issues.push("id_mismatch_with_rest");
  if (!content) issues.push("empty_content");
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
    content,
    content_text,
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
    out: "ils_events.json",
    indexOut: "events.json",
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

  let list = await loadEventList(fromList);
  if (slug) list = list.filter((e) => e.slug === slug);
  if (limit) list = list.slice(0, limit);
  if (!list.length) {
    console.error("[error] no events matched.");
    process.exit(1);
  }

  // Write the small pass-1 index (unless we're replaying one).
  if (!fromList) {
    const indexPath = path.resolve(process.cwd(), indexOut);
    fs.writeFileSync(indexPath, JSON.stringify(list, null, 2), "utf-8");
    console.log(`[info] pass 1: ${list.length} events -> ${indexPath}`);
  }
  if (indexOnly) {
    console.log("[done] --index-only: stopping after pass 1.");
    return;
  }

  const results = [];
  for (const entry of list) {
    console.log(`[info] Fetching event: ${entry.url}`);
    const { html, fromCache: cached } = await fetchHtml(entry.url, `event/${entry.slug}`);
    if (!html) {
      console.error(`  [error] no HTML for ${entry.url}`);
      continue;
    }
    try {
      results.push(scrapeEvent(html, entry));
    } catch (e) {
      console.error(`  [error] failed to parse ${entry.url}: ${e.message}`);
    }
    if (!cached) await sleep(REQUEST_DELAY_MS);
  }

  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");

  const tally = {};
  for (const e of results) for (const k of e.seo_issues || []) tally[k] = (tally[k] || 0) + 1;
  const empty = results.filter((e) => !e.content).length;
  console.log(`[done] Scraped ${results.length}/${list.length} events -> ${outPath}`);
  if (empty) console.log(`[warn] ${empty} events had no content`);
  console.log("[seo]  issue tally:", tally);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
