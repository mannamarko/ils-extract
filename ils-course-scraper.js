#!/usr/bin/env node
/**
 * ILS Hospitals Course Scraper (Node.js)
 * ---------------------------------------------------------------
 * Extracts the courses listed on
 *   https://ilshospitals.com/academia/courses/
 * into JSON (default ils_courses.json).
 *
 * WHAT A "COURSE" IS HERE. Courses are NOT their own WordPress post type. They
 * live in the shared `academia-list` custom post type, which also holds ILS
 * Times newsletters, book launches and conferences (18 items total via WP REST,
 * only a handful of which are courses). The `/academia/courses/` page
 * (a normal WP page, postid-10119) is the ONLY authoritative list of which
 * academia-list items are courses — it hand-picks 3 cards. So pass 1 drives off
 * the listing page's cards, not the REST collection; REST is used only to
 * back-fill each course's post id and publish/modified dates by slug.
 *
 * TWO-PASS PATTERN (as with doctors/procedures/packages):
 *   pass 1  parse the listing cards (`.csr-sec-item` that link to
 *           /academia-list/<slug>/) -> {slug, url, title, thumbnail, excerpt};
 *           writes the small index courses.json.
 *   pass 2  visit each /academia-list/<slug>/ detail page for the banner
 *           heading, body content, gallery/flyer images, application links and
 *           the full SEO block.
 *
 * DETAIL PAGE SHAPE. The body is one `section.csr-sec-for-page` block: a heading
 * (`h2.comm-black-header`, empty on some courses — the title is then only in the
 * banner) plus paragraphs, followed by an optional row of anchor-wrapped flyer /
 * photo images and the occasional external application link (e.g. the DMLT
 * course links out to smfwb.formflix.org). Images and links are pulled out
 * separately as well as left inline in `content`.
 *
 * SEO. Unlike departments/posts, these pages ship a SINGLE meta + ld+json block
 * (AIOSEO), which here is page-specific and correct for title/description and
 * carries a self-referential canonical — so shared `extractSeo` is used almost
 * unchanged. Two consequences are structural, not per-page defects: there is no
 * theme block, so `no_post_specific_schema` / `no_post_specific_meta` always
 * fire, and AIOSEO sets og:image to the generic site logo (flagged
 * `og_image_generic_logo`). The ld+json @graph holds BreadcrumbList / WebPage /
 * Organization / WebSite only — no Course schema.
 *
 * Requires: axios, cheerio (npm install axios cheerio)
 *
 * Usage:
 *   node ils-course-scraper.js                       # all -> ils_courses.json
 *   node ils-course-scraper.js --slug <slug>
 *   node ils-course-scraper.js --limit 1
 *   node ils-course-scraper.js --from-list courses.json
 *   node ils-course-scraper.js --index-only          # pass 1 only -> courses.json
 *   node ils-course-scraper.js --from-cache          # reparse cached HTML, no network
 *   node ils-course-scraper.js --refresh             # re-fetch, overwrite cache
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

const LISTING_URL = "https://ilshospitals.com/academia/courses/";
const REST_URL =
  "https://ilshospitals.com/wp-json/wp/v2/academia-list?per_page=100&_fields=id,slug,link,date,modified,title";
const SITE_ORIGIN = "https://ilshospitals.com";
const LOCAL_INDEX = path.resolve(__dirname, "courses.json");
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

// ---------- pass 1: the courses listing ----------

/**
 * Resolve the list of courses to visit, as [{ slug, url, title, thumbnail,
 * excerpt }]. The /academia/courses/ page is authoritative for *which*
 * academia-list items count as courses; --from-list replays a prior index.
 */
async function loadCourseList(fromList) {
  if (fromList) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), fromList), "utf-8"));
    console.log(`[info] course list from ${fromList}: ${raw.length} entries`);
    return raw.map((c) => ({
      slug: c.slug,
      url: c.url,
      title: c.title || null,
      thumbnail: c.thumbnail || null,
      excerpt: c.excerpt || null,
    }));
  }

  const { html } = await fetchHtml(LISTING_URL, "courses/_listing");
  if (!html) throw new Error(`could not load the courses listing at ${LISTING_URL}`);
  const $ = cheerio.load(html);

  const seen = new Map();
  $(".csr-sec-item").each((_, el) => {
    const $c = $(el);
    const href = $c.find('a[href*="/academia-list/"]').first().attr("href");
    if (!href) return; // non-course card (e.g. an academia sub-section link)
    const url = absoluteUrl(href);
    const slug = slugFromUrl(url);
    if (!slug || slug === "academia-list" || seen.has(slug)) return;
    seen.set(slug, {
      slug,
      url,
      title: collapse($c.find("h3").first().text()),
      thumbnail: absoluteUrl($c.find("img").first().attr("src")),
      excerpt: collapse($c.find(".csr-sec-item-text p, p").first().text()),
    });
  });

  console.log(`[info] course list from ${LISTING_URL}: ${seen.size} entries`);
  return [...seen.values()];
}

/** slug -> { id, published_date, modified_date }, from the WP REST collection. */
async function loadRestMeta() {
  const map = new Map();
  const { data } = await fetchJson(REST_URL, "api/academia-list");
  if (Array.isArray(data)) {
    for (const d of data) {
      map.set(d.slug, {
        id: d.id,
        published_date: d.date || null,
        modified_date: d.modified || null,
      });
    }
    console.log(`[info] REST academia-list meta: ${map.size} entries`);
  } else {
    console.warn("[warn] REST academia-list unavailable; ids/dates will be page-derived only.");
  }
  return map;
}

// ---------- pass 2: a course detail page ----------

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
 * Pull the gallery/flyer images out of the content section. Each is
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
 * Non-image anchor targets inside the content section — application portals,
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

function scrapeCourse(html, entry, restMeta) {
  const $ = cheerio.load(html);
  const url = entry.url;

  // WP stamps the post id on <body class="... postid-11323 ...">; rel=shortlink
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

  const rest = restMeta.get(entry.slug) || {};

  // Course-specific defects, layered on extractSeo's own list. The two
  // no_post_specific_* codes are structural for this post type (there is no
  // theme block at all), so they are dropped here to keep the tally meaningful.
  const issues = seo.seo_issues.filter(
    (c) => c !== "no_post_specific_schema" && c !== "no_post_specific_meta"
  );
  if (seo.og.image && /\/logo\.[a-z]+$/i.test(seo.og.image)) issues.push("og_image_generic_logo");
  if (seo.twitter.url && seo.twitter.url.replace(/\/$/, "") !== (url || "").replace(/\/$/, ""))
    issues.push("twitter_url_placeholder");
  if (rest.id != null && pageId != null && rest.id !== pageId) issues.push("id_mismatch_with_rest");
  if (!content) issues.push("empty_content");
  seo.seo_issues = issues;

  return {
    id: pageId ?? rest.id ?? null,
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
    published_date: rest.published_date || null,
    modified_date: rest.modified_date || null,
    seo,
    seo_issues: issues,
  };
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    out: "ils_courses.json",
    indexOut: "courses.json",
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

  let list = await loadCourseList(fromList);
  if (slug) list = list.filter((c) => c.slug === slug);
  if (limit) list = list.slice(0, limit);
  if (!list.length) {
    console.error("[error] no courses matched.");
    process.exit(1);
  }

  // Write the small pass-1 index (unless we're replaying one).
  if (!fromList) {
    const indexPath = path.resolve(process.cwd(), indexOut);
    fs.writeFileSync(indexPath, JSON.stringify(list, null, 2), "utf-8");
    console.log(`[info] pass 1: ${list.length} courses -> ${indexPath}`);
  }
  if (indexOnly) {
    console.log("[done] --index-only: stopping after pass 1.");
    return;
  }

  const restMeta = await loadRestMeta();
  const results = [];

  for (const entry of list) {
    console.log(`[info] Fetching course: ${entry.url}`);
    const { html, fromCache: cached } = await fetchHtml(entry.url, `academia-list/${entry.slug}`);
    if (!html) {
      console.error(`  [error] no HTML for ${entry.url}`);
      continue;
    }
    try {
      results.push(scrapeCourse(html, entry, restMeta));
    } catch (e) {
      console.error(`  [error] failed to parse ${entry.url}: ${e.message}`);
    }
    if (!cached) await sleep(REQUEST_DELAY_MS);
  }

  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");

  const tally = {};
  for (const c of results) for (const k of c.seo_issues || []) tally[k] = (tally[k] || 0) + 1;
  const empty = results.filter((c) => !c.content).length;
  console.log(`[done] Scraped ${results.length}/${list.length} courses -> ${outPath}`);
  if (empty) console.log(`[warn] ${empty} courses had no content`);
  console.log("[seo]  issue tally:", tally);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
