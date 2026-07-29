#!/usr/bin/env node
/**
 * ILS Hospitals Department Scraper (Node.js)
 * ---------------------------------------------------------------
 * Visits every https://ilshospitals.com/departments/<slug>/ page and pulls:
 *   - id (WordPress post id), name, slug, url, icon, visible breadcrumb,
 *     heading, content (the department body HTML), content_text,
 *     published_date / modified_date
 *   - FULL SEO block from the page's own <head>: meta_title, meta_description,
 *     canonical, robots, keywords, og:*, twitter:*, every
 *     <script type="application/ld+json"> parsed as JSON, plus the flattened
 *     MedicalSpecialty node and the BreadcrumbList.
 *
 * Scope is deliberately content + id + SEO. The sidebar (Key Procedures,
 * Doctors, lead form), the video-testimonial carousel and the FAQ card links
 * are skipped — the last two are byte-identical on all 60 pages, and the first
 * two are separate content types.
 *
 * NOTE on this site's SEO: department pages ship TWO page-specific meta blocks,
 * in the OPPOSITE order from blog posts — the theme's block comes first, the
 * AIOSEO block second. Both are page-specific here (unlike on posts, where
 * AIOSEO emits homepage values), so shared `extractSeo`'s last-non-empty-wins
 * resolution yields the AIOSEO values. That is right for title/description/url
 * but wrong for og:image, where AIOSEO overwrites the department icon with the
 * generic site logo. `seo.og_theme` / `seo.twitter_theme` therefore keep the
 * first-wins (theme) reading alongside, and `seo_issues` flags the divergence.
 * The BreadcrumbList also lives in the AIOSEO block here, not the theme block.
 *
 * Requires: axios, cheerio
 *   npm install axios cheerio
 *
 * Usage:
 *   node ils-department-scraper.js                          # all 60 -> ils_departments.json
 *   node ils-department-scraper.js --slug cardiology --out one.json
 *   node ils-department-scraper.js --limit 5
 *   node ils-department-scraper.js --from-list departments.json
 *   node ils-department-scraper.js --from-cache             # reparse cached HTML, no network
 *   node ils-department-scraper.js --refresh                # re-fetch, overwrite cache
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
  findNode,
  trimOrNull,
  extractBreadcrumbs,
  extractSeo,
} = require("./scrape-lib");

const LISTING_URL = "https://ilshospitals.com/departments/";
const REST_URL =
  "https://ilshospitals.com/wp-json/wp/v2/departments?per_page=100&_fields=id,slug,link,date,modified,title";
const LOCAL_INDEX = path.resolve(__dirname, "departments.json");

// ---------- department list ----------

/**
 * Resolve the list of departments to visit, as [{ slug, url, name, id, ... }].
 * The WP REST collection is authoritative (it carries the post id and the
 * publish/modified dates); the committed departments.json and the listing page
 * are fallbacks that still yield slug/url/name/icon.
 */
async function loadDepartmentList(fromList) {
  if (fromList) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), fromList), "utf-8"));
    console.log(`[info] department list from ${fromList}: ${raw.length} entries`);
    return raw.map((d) => ({ slug: d.slug, url: d.url, name: d.name, icon: d.icon || null }));
  }

  const { data } = await fetchJson(REST_URL, "api/departments");
  if (Array.isArray(data) && data.length) {
    console.log(`[info] department list from WP REST: ${data.length} entries`);
    return data.map((d) => ({
      id: d.id,
      slug: d.slug,
      url: d.link,
      name: d.title && d.title.rendered ? d.title.rendered : null,
      published_date: d.date || null,
      modified_date: d.modified || null,
    }));
  }

  console.warn("[warn] REST list unavailable, falling back to the listing page.");
  const { html } = await fetchHtml(LISTING_URL, "departments/_listing");
  if (!html) throw new Error("could not load a department list from REST, --from-list or the listing page");
  const $ = cheerio.load(html);
  const seen = new Map();
  $('.opd-card-li a[href*="/departments/"]').each((_, el) => {
    const $a = $(el);
    const url = $a.attr("href");
    const slug = slugFromUrl(url);
    if (!slug || slug === "departments" || seen.has(slug)) return;
    seen.set(slug, {
      slug,
      url,
      name: trimOrNull($a.find(".title-treatment").first().text()),
      icon: $a.find(".icon-box img").first().attr("src") || null,
    });
  });
  console.log(`[info] department list from ${LISTING_URL}: ${seen.size} entries`);
  return [...seen.values()];
}

/** slug -> icon, from the committed index (REST does not expose the icon). */
function loadIconIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCAL_INDEX, "utf-8"));
    return new Map(raw.map((d) => [d.slug, d.icon || null]));
  } catch (e) {
    return new Map();
  }
}

// ---------- page parsing ----------

const collapse = (s) => (s || "").replace(/\s+/g, " ").trim() || null;

/** First-non-empty-wins over the meta tags — i.e. the theme's earlier block. */
function resolveFirst(metaAll, key) {
  for (const m of metaAll) {
    if (m.key.toLowerCase() === key && m.content && m.content.trim()) return m.content;
  }
  return null;
}

/** Last-non-empty-wins, matching `extractSeo`'s own resolution. */
function resolveLast(metaAll, key) {
  let val = null;
  for (const m of metaAll) {
    if (m.key.toLowerCase() === key && m.content && m.content.trim()) val = m.content;
  }
  return val;
}

/** Flatten the department's MedicalSpecialty ld+json node. */
function extractMedicalSpecialty(blocks) {
  const ms = findNode(blocks, "MedicalSpecialty");
  if (!ms) return null;
  return {
    name: trimOrNull(ms.name),
    alternate_name: trimOrNull(ms.alternateName),
    description: trimOrNull(ms.description),
    url: trimOrNull(ms.url),
    image: typeof ms.image === "string" ? trimOrNull(ms.image) : ms.image || null,
  };
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
    crumbs.push({ name: collapse($(el).text()), url: $(el).attr("href") || null });
  });
  const current = collapse(span.children("strong").first().text());
  if (current) crumbs.push({ name: current, url: null });
  return crumbs;
}

function scrapeDepartment(html, entry, iconIndex) {
  const $ = cheerio.load(html);
  const url = entry.url;

  // WP stamps the post id on <body class="... postid-1949 ...">; rel=shortlink
  // carries the same id and backs it up when a theme change drops the class.
  const bodyClass = $("body").attr("class") || "";
  const classMatch = bodyClass.match(/\bpostid-(\d+)\b/);
  const shortlink = $('link[rel="shortlink"]').attr("href") || "";
  const shortMatch = shortlink.match(/[?&]p=(\d+)/);
  const id = classMatch ? Number(classMatch[1]) : shortMatch ? Number(shortMatch[1]) : null;

  const banner = $("section.page-banner").first();
  const name = collapse(banner.find("h2").first().text()) || entry.name || null;
  const icon =
    iconIndex.get(entry.slug) ||
    entry.icon ||
    banner.find(".grd-box img").first().attr("src") ||
    null;

  const body = $("section.bg-center-list-details .center-details").first();
  const heading = collapse(body.find("h2").first().text());
  const content = normalizeHtmlWhitespace(body.length ? body.html().trim() : null);
  const content_text = collapse(body.text());

  const seo = extractSeo($, url);
  const meta = seo.meta_all;

  // Theme block reading. On these pages the theme's meta tags precede AIOSEO's,
  // so first-wins recovers what AIOSEO later overwrites (notably og:image).
  const og_theme = {
    title: resolveFirst(meta, "og:title"),
    description: resolveFirst(meta, "og:description"),
    type: resolveFirst(meta, "og:type"),
    url: resolveFirst(meta, "og:url"),
    image: resolveFirst(meta, "og:image"),
    site_name: resolveFirst(meta, "og:site_name"),
    locale: resolveFirst(meta, "og:locale"),
  };
  const twitter_theme = {
    card: resolveFirst(meta, "twitter:card"),
    title: resolveFirst(meta, "twitter:title"),
    description: resolveFirst(meta, "twitter:description"),
    image: resolveFirst(meta, "twitter:image"),
    url: resolveFirst(meta, "twitter:url"),
  };

  seo.keywords = resolveLast(meta, "keywords");
  seo.og_theme = og_theme;
  seo.twitter_theme = twitter_theme;
  seo.medical_specialty = extractMedicalSpecialty(seo.json_ld);
  // Passed every block, not json_ld_by_source.post: on department pages the
  // BreadcrumbList sits inside the AIOSEO @graph.
  seo.breadcrumbs = extractBreadcrumbs(seo.json_ld);
  seo.article_published_time = resolveLast(meta, "article:published_time");
  seo.article_modified_time = resolveLast(meta, "article:modified_time");

  // Department-specific defects, layered on top of extractSeo's own list.
  const issues = [...seo.seo_issues];
  if (!seo.medical_specialty) issues.push("no_medical_specialty_schema");
  if (seo.twitter.url && seo.twitter.url.replace(/\/$/, "") !== (url || "").replace(/\/$/, ""))
    issues.push("twitter_url_placeholder");
  if (og_theme.image && seo.og.image && og_theme.image !== seo.og.image && /\/logo\.[a-z]+$/i.test(seo.og.image))
    issues.push("og_image_generic_logo");
  if (og_theme.title && seo.og.title && og_theme.title.trim() !== seo.og.title.trim())
    issues.push("og_title_conflict");
  if (entry.id != null && id != null && entry.id !== id) issues.push("id_mismatch_with_rest");
  if (!content) issues.push("empty_content");
  seo.seo_issues = issues;

  return {
    id: id ?? entry.id ?? null,
    name,
    slug: entry.slug,
    url,
    icon,
    breadcrumb: extractVisibleBreadcrumb($, banner),
    heading,
    content,
    content_text,
    published_date: entry.published_date || seo.article_published_time || null,
    modified_date: entry.modified_date || seo.article_modified_time || null,
    seo,
    seo_issues: issues,
  };
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    out: "ils_departments.json",
    limit: null,
    slug: null,
    fromList: null,
    fromCache: false,
    refresh: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--out":
        opts.out = args[++i];
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
  const { out, limit, slug, fromList, fromCache, refresh } = parseArgs();
  cacheMode.fromCache = fromCache;
  cacheMode.refresh = refresh;
  if (fromCache) console.log(`[info] --from-cache: reading HTML from ${CACHE_DIR}, no network.`);
  if (refresh) console.log("[info] --refresh: re-fetching every page, overwriting cache.");

  let list = await loadDepartmentList(fromList);
  if (slug) list = list.filter((d) => d.slug === slug);
  if (limit) list = list.slice(0, limit);
  if (!list.length) {
    console.error("[error] no departments matched.");
    process.exit(1);
  }

  const iconIndex = loadIconIndex();
  const results = [];

  for (const entry of list) {
    console.log(`[info] Fetching department: ${entry.url}`);
    const { html, fromCache: cached } = await fetchHtml(entry.url, `departments/${entry.slug}`);
    if (!html) {
      console.error(`  [error] no HTML for ${entry.url}`);
      continue;
    }
    try {
      results.push(scrapeDepartment(html, entry, iconIndex));
    } catch (e) {
      console.error(`  [error] failed to parse ${entry.url}: ${e.message}`);
    }
    if (!cached) await sleep(REQUEST_DELAY_MS);
  }

  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");

  // Summary of the SEO defects this run observed, so problems stay visible.
  const tally = {};
  for (const d of results) for (const k of d.seo_issues || []) tally[k] = (tally[k] || 0) + 1;
  const empty = results.filter((d) => !d.content).length;
  console.log(`[done] Scraped ${results.length}/${list.length} departments -> ${outPath}`);
  if (empty) console.log(`[warn] ${empty} departments had no content`);
  console.log("[seo]  issue tally:", tally);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
