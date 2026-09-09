#!/usr/bin/env node
/**
 * ILS Hospitals Speciality Scraper (Node.js)
 * ---------------------------------------------------------------
 * Visits every https://ilshospitals.com/specialities/<slug>/ page listed in
 * the public sitemap and pulls:
 *   - id (WordPress post id), title, slug, url, banner_image, visible
 *     breadcrumb, heading, content (the speciality body HTML), content_text,
 *     the sidebar doctor slugs, published_date / modified_date
 *   - FULL SEO block from the page's own <head>: meta_title, meta_description,
 *     canonical, robots, keywords, og:*, twitter:*, every
 *     <script type="application/ld+json"> parsed as JSON, plus the
 *     BreadcrumbList — and, authoritative on top of that, the plugin's own
 *     `aioseo_head_json` straight from the REST API.
 *
 * SCOPE: the `specialities` CPT holds 73 posts, but only the 13 in the sitemap
 * are standalone pages. The other 60 are service/benefit line-items
 * ("CT Scan", "10% discount on health checkup package", ...) reused as list
 * rows on other templates, and they have no page of their own. The 13 are
 * therefore pinned in SITEMAP_SLUGS rather than taken from the REST list.
 *
 * Scope is deliberately content + id + doctors + SEO. The video-testimonial
 * carousel and the FAQ card links are skipped — both are byte-identical on all
 * 13 pages because they are site-wide, not per-speciality.
 *
 * NOTE on this site's SEO: speciality pages behave like department pages —
 * the theme's meta block comes first, the AIOSEO block second, and both are
 * page-specific. Shared `extractSeo`'s last-non-empty-wins resolution therefore
 * yields the AIOSEO values, which is right for title/description/url but wrong
 * for og:image, where AIOSEO overwrites with the generic site logo.
 * `seo.og_theme` / `seo.twitter_theme` keep the first-wins (theme) reading
 * alongside, and `seo_issues` flags the divergence.
 *
 * Requires: axios, cheerio
 *   npm install axios cheerio
 *
 * Usage:
 *   node ils-speciality-scraper.js                          # all 13 -> ils_specialities.json
 *   node ils-speciality-scraper.js --slug blood-bank --out one.json
 *   node ils-speciality-scraper.js --limit 5
 *   node ils-speciality-scraper.js --from-list specialities.json
 *   node ils-speciality-scraper.js --from-cache             # reparse cached HTML, no network
 *   node ils-speciality-scraper.js --refresh                # re-fetch, overwrite cache
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

const REST_URL =
  "https://ilshospitals.com/wp-json/wp/v2/specialities?per_page=100&_fields=id,slug,link,date,modified,title,aioseo_head_json";

/**
 * The 13 slugs the sitemap advertises, in sitemap order. Pinned on purpose —
 * see the SCOPE note above.
 */
const SITEMAP_SLUGS = [
  "surgical-oncology",
  "medical-oncology",
  "radiation-oncology",
  "pediatric-oncology",
  "hemato-oncology",
  "preventive-oncology",
  "bone-marrow-transplant",
  "immunotherapy",
  "oncopathology",
  "medical-genetics",
  "nuclear-medicine",
  "blood-bank",
  "pain-and-palliative-care",
];

// ---------- speciality list ----------

/**
 * Resolve the list of specialities to visit, as [{ slug, url, title, id, ... }].
 * The WP REST collection is authoritative (it carries the post id, the
 * publish/modified dates and the AIOSEO block); --from-list is the offline
 * fallback. There is no listing page to fall back to — the CPT is registered
 * with has_archive: false, so /specialities/ itself 404s.
 */
async function loadSpecialityList(fromList) {
  if (fromList) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), fromList), "utf-8"));
    console.log(`[info] speciality list from ${fromList}: ${raw.length} entries`);
    return raw.map((s) => ({ slug: s.slug, url: s.url, title: s.title || s.name }));
  }

  const { data } = await fetchJson(REST_URL, "api/specialities");
  if (!Array.isArray(data) || !data.length) {
    throw new Error("could not load a speciality list from REST or --from-list");
  }

  const bySlug = new Map(data.map((s) => [s.slug, s]));
  const missing = SITEMAP_SLUGS.filter((s) => !bySlug.has(s));
  if (missing.length) console.warn(`[warn] not in the REST collection: ${missing.join(", ")}`);

  const list = SITEMAP_SLUGS.filter((s) => bySlug.has(s)).map((slug) => {
    const s = bySlug.get(slug);
    return {
      id: s.id,
      slug: s.slug,
      url: s.link,
      title: s.title && s.title.rendered ? s.title.rendered : null,
      published_date: s.date || null,
      modified_date: s.modified || null,
      aioseo: s.aioseo_head_json || null,
    };
  });
  console.log(`[info] speciality list from WP REST: ${list.length}/${data.length} entries kept (sitemap pages only)`);
  return list;
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

/**
 * Cheap well-formedness check on the body HTML. Unbalanced WP markup is what
 * breaks React hydration once this lands in dangerouslySetInnerHTML, and it is
 * far cheaper to catch here than to debug in the browser.
 */
function unbalancedTags(html) {
  if (!html) return [];
  const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "source", "area", "col", "embed", "wbr"]);
  const stack = [];
  const bad = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, closing, rawName, selfClosing] = m;
    const name = rawName.toLowerCase();
    if (VOID.has(name) || selfClosing === "/") continue;
    if (!closing) {
      stack.push(name);
      continue;
    }
    const idx = stack.lastIndexOf(name);
    if (idx === -1) bad.push(`stray </${name}>`);
    else stack.splice(idx, 1);
  }
  for (const name of stack) bad.push(`unclosed <${name}>`);
  return bad;
}

function scrapeSpeciality(html, entry) {
  const $ = cheerio.load(html);
  const url = entry.url;

  // WP stamps the post id on <body class="... postid-17169 ...">; rel=shortlink
  // carries the same id and backs it up when a theme change drops the class.
  const bodyClass = $("body").attr("class") || "";
  const classMatch = bodyClass.match(/\bpostid-(\d+)\b/);
  const shortlink = $('link[rel="shortlink"]').attr("href") || "";
  const shortMatch = shortlink.match(/[?&]p=(\d+)/);
  const id = classMatch ? Number(classMatch[1]) : shortMatch ? Number(shortMatch[1]) : null;

  const banner = $("section.page-banner").first();
  const title = collapse(banner.find("h2").first().text()) || entry.title || null;
  const banner_image = banner.find(".grd-box img").first().attr("src") || null;

  // `.center-details` matches both columns; the body is the one carrying the
  // post-content wrapper classes, the other is the doctors/lead-form sidebar.
  const body = $("section.bg-center-list-details .center-details.custom-post-content").first();
  const heading = collapse(body.find("h2").first().text());
  const content = normalizeHtmlWhitespace(body.length ? body.html().trim() : null);
  const content_text = collapse(body.text());

  // Sidebar doctors, in render order, de-duplicated. Three of the 13 pages have
  // none — an empty array there is correct, not a parse failure.
  const sidebar = $("section.bg-center-list-details .center-details.other-random-list").first();
  const doctor_slugs = [];
  sidebar.find('.doctor-opd-card-ul a[href*="/doctor-list/"]').each((_, el) => {
    const slug = slugFromUrl($(el).attr("href"));
    if (slug && slug !== "doctor-list" && !doctor_slugs.includes(slug)) doctor_slugs.push(slug);
  });
  const viewAll = sidebar.find('a[href*="doctors-list"]').first().attr("href") || "";
  const specMatch = viewAll.match(/[?&]spec=(\d+)/);

  // The "Other Specialities" widget — a curated, perfectly symmetric
  // many-to-many across the 13 pages (verified: every edge is reciprocal and
  // no page lists itself). 10 pages carry it; surgical-oncology, blood-bank
  // and pain-and-palliative-care are linked from nowhere and show none.
  const related_specialities = [];
  sidebar
    .find('.opd-card-ul a[href*="/specialities/"]')
    .each((_, el) => {
      const $a = $(el);
      const relatedSlug = slugFromUrl($a.attr("href"));
      if (!relatedSlug || relatedSlug === "specialities") return;
      if (relatedSlug === entry.slug) return;
      if (related_specialities.some((r) => r.slug === relatedSlug)) return;
      related_specialities.push({
        slug: relatedSlug,
        title: collapse($a.find(".title-treatment").first().text()),
        icon: $a.find(".icon-box img").first().attr("src") || null,
      });
    });

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
  // Passed every block, not json_ld_by_source.post: like department pages, the
  // BreadcrumbList sits inside the AIOSEO @graph.
  seo.breadcrumbs = extractBreadcrumbs(seo.json_ld);
  seo.article_published_time = resolveLast(meta, "article:published_time");
  seo.article_modified_time = resolveLast(meta, "article:modified_time");
  // The plugin's own JSON, straight from REST. This is what the importer maps
  // into the DB — it is the same data the <head> renders, without the
  // two-blocks-fighting ambiguity above.
  seo.aioseo_head_json = entry.aioseo || null;

  // Speciality-specific defects, layered on top of extractSeo's own list.
  const issues = [...seo.seo_issues];
  if (seo.twitter.url && seo.twitter.url.replace(/\/$/, "") !== (url || "").replace(/\/$/, ""))
    issues.push("twitter_url_placeholder");
  if (og_theme.image && seo.og.image && og_theme.image !== seo.og.image && /\/logo\.[a-z]+$/i.test(seo.og.image))
    issues.push("og_image_generic_logo");
  if (og_theme.title && seo.og.title && og_theme.title.trim() !== seo.og.title.trim())
    issues.push("og_title_conflict");
  if (!seo.meta_description) issues.push("empty_meta_description");
  if (entry.id != null && id != null && entry.id !== id) issues.push("id_mismatch_with_rest");
  if (!content) issues.push("empty_content");
  if (!banner_image) issues.push("no_banner_image");
  const unbalanced = unbalancedTags(content);
  if (unbalanced.length) issues.push("unbalanced_content_html");
  seo.seo_issues = issues;

  return {
    id: id ?? entry.id ?? null,
    title,
    slug: entry.slug,
    url,
    banner_image,
    breadcrumb: extractVisibleBreadcrumb($, banner),
    heading,
    content,
    content_text,
    doctor_slugs,
    doctors_filter_id: specMatch ? specMatch[1] : null,
    related_specialities,
    published_date: entry.published_date || seo.article_published_time || null,
    modified_date: entry.modified_date || seo.article_modified_time || null,
    seo,
    seo_issues: issues,
    content_html_issues: unbalanced,
  };
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    out: "ils_specialities.json",
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

  let list = await loadSpecialityList(fromList);
  if (slug) list = list.filter((s) => s.slug === slug);
  if (limit) list = list.slice(0, limit);
  if (!list.length) {
    console.error("[error] no specialities matched.");
    process.exit(1);
  }

  const results = [];

  for (const entry of list) {
    console.log(`[info] Fetching speciality: ${entry.url}`);
    const { html, fromCache: cached } = await fetchHtml(entry.url, `specialities/${entry.slug}`);
    if (!html) {
      console.error(`  [error] no HTML for ${entry.url}`);
      continue;
    }
    try {
      results.push(scrapeSpeciality(html, entry));
    } catch (e) {
      console.error(`  [error] failed to parse ${entry.url}: ${e.message}`);
    }
    if (!cached) await sleep(REQUEST_DELAY_MS);
  }

  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");

  // Summary of the defects this run observed, so problems stay visible.
  const tally = {};
  for (const s of results) for (const k of s.seo_issues || []) tally[k] = (tally[k] || 0) + 1;
  const empty = results.filter((s) => !s.content).length;
  const noDoctors = results.filter((s) => !s.doctor_slugs.length).length;
  const noRelated = results.filter((s) => !s.related_specialities.length).length;
  console.log(`[done] Scraped ${results.length}/${list.length} specialities -> ${outPath}`);
  console.log(
    `[done] ${empty} with empty content, ${noDoctors} with no sidebar doctors, ${noRelated} with no related specialities.`,
  );
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`       ${k}: ${v}`);
  }
  for (const s of results) {
    if (s.content_html_issues.length) {
      console.warn(`[warn] ${s.slug}: ${s.content_html_issues.join(", ")}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
