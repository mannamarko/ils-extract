#!/usr/bin/env node
/**
 * ILS Hospitals Gallery Scraper (Node.js)
 * ---------------------------------------------------------------
 * Extracts the photo gallery at
 *   https://ilshospitals.com/gallery/
 * into JSON (default ils_gallery.json).
 *
 * ONE PAGE, NO CPT, NO PAGINATION. Unlike every other scraper in this repo,
 * "Gallery" is not a WordPress post type with an index + detail pages — it is
 * a single static `page-template-gallery` page (`page-template-gallery.php`
 * per `<body class="... page-template page-template-gallery ...">`) whose
 * body is one flat grid of 85 photos, all rendered server-side with no
 * "load more" / infinite-scroll JS. So there is no pass 1 / pass 2 split and
 * no WP REST call: fetch the page once, parse the grid.
 *
 * PAGE SHAPE. Banner in `section.page-banner`; the grid itself is
 * `section.gallery-page`, a flat list of `div.gallery-card > a[data-lightbox]
 * > img`. Each anchor's `href` and `data-title` back a lightbox (Fancybox-style)
 * viewer; on every card observed here `href` is byte-identical to the `<img>`'s
 * `src` (there is no separate "full size" asset), so `full` in the output is
 * only ever non-null if a future edit breaks that assumption. `data-title` is
 * a short slug/label ("Cathlab", "OT", "cmr-surgical-versius-clinical") rather
 * than a caption — several photos share the same title (e.g. 4x "OT", 6x
 * "cmr-surgical-versius-clinical"), which is recorded as-is, not deduplicated.
 * No `alt` text is ever set (every `<img>` ships `alt="ils-gallery"`, a
 * generic placeholder rather than a real description) — flagged
 * `generic_alt_text` per image.
 *
 * SEO. Like the CPT archives (events/csr/faq-lists), this page ships a SINGLE
 * meta + ld+json block (AIOSEO) rather than the theme+AIOSEO pair most
 * departments/doctors/posts carry — so `no_post_specific_schema` /
 * `no_post_specific_meta` are structural here too and dropped from the tally.
 * Unlike those archives, though, AIOSEO here IS configured with a real,
 * page-specific meta description (unusual for this site) and a
 * self-referential canonical, so shared `extractSeo` needs no other
 * adjustment.
 *
 * Requires: axios, cheerio (npm install axios cheerio)
 *
 * Usage:
 *   node ils-gallery-scraper.js                # -> ils_gallery.json
 *   node ils-gallery-scraper.js --out one.json
 *   node ils-gallery-scraper.js --from-cache   # reparse cached HTML, no network
 *   node ils-gallery-scraper.js --refresh      # re-fetch, overwrite cache
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const {
  CACHE_DIR,
  cacheMode,
  trimOrNull,
  fetchHtml,
  extractBreadcrumbs,
  extractSeo,
} = require("./scrape-lib");

const GALLERY_URL = "https://ilshospitals.com/gallery/";
const SITE_ORIGIN = "https://ilshospitals.com";

const collapse = (s) => (s || "").replace(/\s+/g, " ").trim() || null;

function absoluteUrl(href) {
  if (!href) return null;
  const h = href.trim();
  if (!h || h === "#") return null;
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

function extractGalleryImages($) {
  const images = [];
  $("section.gallery-page .gallery-card").each((_, el) => {
    const $card = $(el);
    const $a = $card.find("a[data-lightbox]").first();
    const $img = $card.find("img").first();
    const src = absoluteUrl($img.attr("src"));
    if (!src) return;
    const full = absoluteUrl($a.attr("href"));
    images.push({
      position: images.length + 1,
      src,
      full: full && full !== src ? full : null,
      title: trimOrNull($a.attr("data-title")),
      alt: trimOrNull($img.attr("alt")),
    });
  });
  return images;
}

function scrapeGallery(html) {
  const $ = cheerio.load(html);
  const banner = $("section.page-banner").first();
  const title = collapse(banner.find("h2").first().text());

  const images = extractGalleryImages($);
  const generic_alt_count = images.filter((i) => i.alt && /^ils-gallery$/i.test(i.alt)).length;

  const seo = extractSeo($, GALLERY_URL);
  seo.breadcrumbs = extractBreadcrumbs(seo.json_ld); // BreadcrumbList lives in the AIOSEO @graph

  // The two no_post_specific_* codes are structural for this page (there is no
  // theme meta/schema block at all, only AIOSEO's), so they are dropped here to
  // keep the tally meaningful.
  const issues = seo.seo_issues.filter(
    (c) => c !== "no_post_specific_schema" && c !== "no_post_specific_meta"
  );
  if (!images.length) issues.push("no_images");
  if (generic_alt_count === images.length && images.length) issues.push("generic_alt_text");
  seo.seo_issues = issues;

  return {
    url: GALLERY_URL,
    title,
    breadcrumb: extractVisibleBreadcrumb($, banner),
    image_count: images.length,
    images,
    seo,
    seo_issues: issues,
  };
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { out: "ils_gallery.json", fromCache: false, refresh: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--out":
        opts.out = args[++i];
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
  const { out, fromCache, refresh } = parseArgs();
  cacheMode.fromCache = fromCache;
  cacheMode.refresh = refresh;
  if (fromCache) console.log(`[info] --from-cache: reading HTML from ${CACHE_DIR}, no network.`);
  if (refresh) console.log("[info] --refresh: re-fetching, overwriting cache.");

  const { html } = await fetchHtml(GALLERY_URL, "gallery/_page");
  if (!html) {
    console.error(`[error] could not load ${GALLERY_URL}`);
    process.exit(1);
  }

  const result = scrapeGallery(html);
  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");

  console.log(`[done] Scraped ${result.image_count} gallery images -> ${outPath}`);
  console.log("[seo]  issue tally:", result.seo_issues);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
