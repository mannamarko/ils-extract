#!/usr/bin/env node
/**
 * ILS Hospitals HTML Sitemap Scraper (Node.js)
 * ---------------------------------------------------------------
 * Extracts the human-facing sitemap at
 *   https://ilshospitals.com/sitemap/
 * into JSON (default ils_sitemap.json), preserving CATEGORY, LINK TEXT and
 * SEQUENCE exactly as the page renders them.
 *
 * ONE PAGE, NO CPT, NO PAGINATION — like the gallery scraper, this is a single
 * `page-template-footer-bottom-page` page (page id 10433), so there is no
 * pass 1 / pass 2 split, no index file and no WP REST call. Fetch once, parse.
 *
 * PAGE SHAPE. The whole sitemap is one AIOSEO-generated block,
 * `div.aioseo-html-sitemap`, whose direct children are 26 section divs
 * (interleaved with `<br>` separators, which are skipped) named
 * `aioseo-html-<post-type-or-taxonomy>-sitemap`. Each section is exactly:
 *   <div class="aioseo-html-<type>-sitemap"><h4>Category</h4><ul><li><a/></li>…</ul></div>
 * The markup is unusually clean for this site: all 1824 `<li>` carry exactly
 * one `<a>`, no nested `<ul>`, no empty link text, no extra inline markup, no
 * external hrefs, every href absolute with a trailing slash, and — across the
 * whole page — **zero duplicate URLs**. So `position` (within section),
 * `global_position` (document order across all sections) and `category` are a
 * faithful 1:1 record of what the page renders; nothing is deduplicated,
 * re-sorted or merged. `entries_flat` repeats the same rows in pure document
 * order as a compact (global_position, category, name, url) tuple so the
 * sequence can be verified end to end without walking the sections.
 *
 * SECTION ORDER IS THE PAGE'S, NOT ALPHABETICAL. AIOSEO emits post types in
 * registration order (Posts, Academia-List, Pages, Academia, Events, …) and
 * taxonomies last; it is deliberately preserved rather than normalized, since
 * "sequence should be matched" is the point of this extract.
 *
 * WHAT THE SECTIONS ACTUALLY CONTAIN (the audit-worthy part):
 *  - **"Posts" lists 3 links, not 465.** They are the placeholder stubs
 *    /blog-1/, /blog-2/, /blog-3/ — the real 465 blog posts under /blog/… are
 *    absent from the HTML sitemap entirely (they ARE in sitemap.xml). Recorded
 *    as `section_omits_known_records` on that section, not worked around.
 *  - **"Gallery" is a CPT, not the photo page.** 85 posts at /gallery/<slug>/,
 *    one per photo on /gallery/ — a different URL space from
 *    `ils_gallery.json`, which stores image `src`. Compared by count only.
 *  - **"OPD Schedules & Appointments" is per-department, not per-doctor.**
 *    229 /opd-schedules/<slug>/ URLs named after departments (with duplicate
 *    display names disambiguated by a -2/-3 slug suffix), whereas
 *    `ils_opd_schedules.json` holds 374 per-doctor records keyed by
 *    /doctor-list/ URLs. Count-only comparison; the two are not the same set.
 *  - **"Academia-List" is three datasets in one CPT** (courses + ILS Times
 *    issues + publications), plus a live /academia-list/test/ stub.
 *  - **"tie-up-list" ships a raw slug as its heading** where every other
 *    section has a human label ("Departments", "Key Procedures", …) — the CPT
 *    was registered without a plural label. Flagged `heading_is_raw_slug`.
 *  - The last four sections are taxonomies, and two carry misleading labels:
 *    `aol_ad_category` is headed "ILS Hospitals" and `aol_ad_type` "Department"
 *    (the taxonomy's singular label leaking through). Recorded verbatim with
 *    `heading_looks_like_term_name`, not corrected.
 *
 * XML CROSS-CHECK. /sitemap.xml is NOT the AIOSEO sitemap — it is a stale
 * third-party dump ("created with Free Online Sitemap Generator
 * www.xml-sitemaps.com"), so the two disagree badly in both directions
 * (716 HTML-only, 147 XML-only on the observed run). That divergence is
 * reported under `xml_audit` as a finding; neither side is treated as truth.
 *
 * DATASET CROSS-CHECK. Where a section maps onto a dataset another scraper in
 * this repo already produced, `dataset_audit` diffs them — by URL set where
 * both sides speak the same URL space, by count where they don't (see above).
 * Every mapping degrades to `{ status: "dataset_missing" }` if the file has
 * not been scraped yet, so this script always runs standalone.
 *
 * SEO. Single AIOSEO meta + ld+json block, no theme block — so the
 * `no_post_specific_*` codes are structural here (as on the gallery/archive
 * pages) and are dropped from the tally.
 *
 * Requires: axios, cheerio (npm install axios cheerio)
 *
 * Usage:
 *   node ils-sitemap-scraper.js                 # -> ils_sitemap.json
 *   node ils-sitemap-scraper.js --out one.json
 *   node ils-sitemap-scraper.js --from-cache    # reparse cached HTML, no network
 *   node ils-sitemap-scraper.js --refresh       # re-fetch, overwrite cache
 *   node ils-sitemap-scraper.js --no-xml        # skip the /sitemap.xml cross-check
 *   node ils-sitemap-scraper.js --no-dataset-check   # skip the ils_*.json diffs
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const {
  CACHE_DIR,
  cacheMode,
  trimOrNull,
  slugFromUrl,
  fetchHtml,
  extractBreadcrumbs,
  extractSeo,
} = require("./scrape-lib");

const SITEMAP_URL = "https://ilshospitals.com/sitemap/";
const SITEMAP_XML = "https://ilshospitals.com/sitemap.xml";
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

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch (e) {
    return null;
  }
}

/** "aioseo-html-key-procedures-sitemap" -> "key-procedures" */
function sectionTypeFromClass(cls) {
  const m = /aioseo-html-(.+)-sitemap/.exec(cls || "");
  return m ? m[1] : null;
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

// ---------- sitemap body ----------

/**
 * Walk `div.aioseo-html-sitemap` in document order. Section sequence and
 * per-section entry sequence are both preserved as emitted; `global_position`
 * is the running index across the whole page.
 */
function extractSections($) {
  const root = $("div.aioseo-html-sitemap").first();
  const sections = [];
  let globalPosition = 0;

  root.children("div").each((_, div) => {
    const $div = $(div);
    const css_class = $div.attr("class") || null;
    const type = sectionTypeFromClass(css_class);
    // Only AIOSEO section divs; anything else in there is not a category.
    if (!type) return;

    const category = collapse($div.children("h4").first().text());
    const issues = [];
    if (!category) issues.push("heading_missing");
    // Every other section has a human label; a bare slug means the CPT was
    // registered without one.
    if (category && category === type) issues.push("heading_is_raw_slug");

    const entries = [];
    const seenInSection = new Set();
    $div.find("ul > li").each((_, li) => {
      const $li = $(li);
      const $a = $li.find("a").first();
      const url = absoluteUrl($a.attr("href"));
      const name = collapse($a.text());
      const entryIssues = [];

      if (!url) entryIssues.push("missing_href");
      if (!name) entryIssues.push("empty_link_text");
      if ($li.find("a").length > 1) entryIssues.push("multiple_links_in_item");
      if (url && !url.startsWith(SITE_ORIGIN)) entryIssues.push("external_url");
      if (url && seenInSection.has(url)) entryIssues.push("duplicate_url_in_section");
      if (url) seenInSection.add(url);

      globalPosition += 1;
      entries.push({
        position: entries.length + 1,
        global_position: globalPosition,
        name,
        url,
        path: url ? pathOf(url) : null,
        slug: url ? slugFromUrl(url) : null,
        issues: entryIssues,
      });
    });

    if (!entries.length) issues.push("section_empty");

    sections.push({
      position: sections.length + 1,
      category,
      type,
      css_class,
      entry_count: entries.length,
      entries,
      issues,
    });
  });

  return sections;
}

// ---------- /sitemap.xml cross-check ----------

function auditXml(xml, htmlUrls) {
  if (!xml) return null;
  const $ = cheerio.load(xml, { xmlMode: true });
  const urls = [];
  $("loc").each((_, el) => {
    const u = $(el).text().trim();
    if (u) urls.push(u);
  });
  const xmlSet = new Set(urls);
  const htmlSet = new Set(htmlUrls);

  const html_only = [...htmlSet].filter((u) => !xmlSet.has(u));
  const xml_only = [...xmlSet].filter((u) => !htmlSet.has(u));

  const issues = [];
  if (html_only.length) issues.push("urls_missing_from_xml_sitemap");
  if (xml_only.length) issues.push("urls_missing_from_html_sitemap");
  // The XML is a third-party dump, not AIOSEO's — worth stating outright.
  if (/xml-sitemaps\.com/i.test(xml)) issues.push("xml_sitemap_third_party_generated");

  return {
    url: SITEMAP_XML,
    xml_url_count: xmlSet.size,
    html_url_count: htmlSet.size,
    in_both: [...htmlSet].filter((u) => xmlSet.has(u)).length,
    html_only_count: html_only.length,
    xml_only_count: xml_only.length,
    html_only,
    xml_only,
    issues,
  };
}

// ---------- dataset cross-check ----------

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), "utf-8"));
  } catch (e) {
    return null;
  }
};

/**
 * Section type -> the dataset another scraper in this repo already wrote.
 * `urls` present  => compare by URL set (and therefore by count).
 * `count` present => the two sides live in different URL spaces (see header),
 *                    so only the totals are comparable; `note` says why.
 */
const DATASET_MAP = [
  { type: "post", file: "ils_blogs_v2.json", urls: (d) => d.map((x) => x.post_url) },
  { type: "page", file: "ils_seolinks.json", urls: (d) => d.map((x) => x.url) },
  { type: "event", file: "ils_events.json", urls: (d) => d.map((x) => x.url) },
  { type: "doctor-list", file: "ils_doctors.json", urls: (d) => d.map((x) => x.url) },
  { type: "csr", file: "ils_csr.json", urls: (d) => d.map((x) => x.url) },
  { type: "award", file: "ils_awards.json", urls: (d) => d.map((x) => x.detail_url) },
  { type: "departments", file: "ils_departments.json", urls: (d) => d.map((x) => x.url) },
  { type: "key-procedures", file: "ils_key_procedures.json", urls: (d) => d.map((x) => x.url) },
  { type: "job", file: "ils_careers.json", urls: (d) => d.map((x) => x.url) },
  { type: "testimonial", file: "ils_testimonials.json", urls: (d) => (d.testimonials || []).map((x) => x.url) },
  { type: "faq-lists", file: "ils_faqs.json", urls: (d) => (d.categories || []).map((x) => x.url) },
  {
    type: "faq-question-answer",
    file: "ils_faqs.json",
    urls: (d) => (d.standalone_questions || []).map((x) => x.url),
  },
  {
    type: "tie-up-list",
    file: "ils_tie_ups.json",
    // The CPT is insurance records + the orphans that render nowhere. The two
    // lists name the detail URL differently (`post_link` vs `url`).
    urls: (d) => [...(d.insurance || []), ...(d.cpt_orphans || [])].map((x) => x.post_link || x.url),
  },
  {
    type: "leadership-team",
    file: "ils_members.json",
    // Only the 3 with a post id are the CPT; the other 7 are board-of-directors
    // cards with no post behind them.
    urls: (d) => d.filter((x) => x.id != null).map((x) => x.detail_url),
  },
  {
    type: "hospital",
    file: "ils_hospitals.json",
    count: (d) => (Array.isArray(d) ? d.length : null),
    note: "ils_hospitals.json predates scrape-lib and stores no page URL",
  },
  {
    type: "gallery",
    file: "ils_gallery.json",
    count: (d) => (d.images || []).length,
    note: "sitemap lists the gallery CPT (/gallery/<slug>/); ils_gallery.json stores image src from the single /gallery/ page",
  },
  {
    type: "opd-schedules",
    file: "ils_opd_schedules.json",
    count: (d) => (Array.isArray(d) ? d.length : null),
    note: "sitemap lists per-department /opd-schedules/ URLs; ils_opd_schedules.json holds per-doctor records keyed by /doctor-list/ URLs",
  },
  {
    type: "academia-list",
    files: ["ils_courses.json", "ils_times.json", "ils_publications.json"],
    count: (list) =>
      list.reduce((n, d) => n + (d == null ? 0 : Array.isArray(d) ? d.length : (d.items || []).length), 0),
    note: "one CPT holding three datasets (courses + ILS Times + publications)",
  },
];

function auditDatasets(sections) {
  const results = [];
  for (const map of DATASET_MAP) {
    const section = sections.find((s) => s.type === map.type);
    if (!section) continue;

    const files = map.files || [map.file];
    const loaded = files.map(readJson);
    if (loaded.every((d) => d == null)) {
      results.push({
        section: section.category,
        type: map.type,
        dataset_files: files,
        sitemap_count: section.entry_count,
        dataset_count: null,
        status: "dataset_missing",
      });
      continue;
    }

    const sitemapUrls = section.entries.map((e) => e.url).filter(Boolean);

    if (map.urls) {
      const datasetUrls = (map.urls(loaded[0]) || []).filter(Boolean);
      const dSet = new Set(datasetUrls);
      const sSet = new Set(sitemapUrls);
      const in_sitemap_not_in_dataset = [...sSet].filter((u) => !dSet.has(u));
      const in_dataset_not_in_sitemap = [...dSet].filter((u) => !sSet.has(u));
      results.push({
        section: section.category,
        type: map.type,
        dataset_files: files,
        comparison: "urls",
        sitemap_count: section.entry_count,
        dataset_count: datasetUrls.length,
        delta: section.entry_count - datasetUrls.length,
        in_sitemap_not_in_dataset,
        in_dataset_not_in_sitemap,
        status:
          in_sitemap_not_in_dataset.length || in_dataset_not_in_sitemap.length ? "differs" : "match",
      });
    } else {
      const datasetCount = map.files ? map.count(loaded) : map.count(loaded[0]);
      results.push({
        section: section.category,
        type: map.type,
        dataset_files: files,
        comparison: "count",
        note: map.note,
        sitemap_count: section.entry_count,
        dataset_count: datasetCount,
        delta: datasetCount == null ? null : section.entry_count - datasetCount,
        status: datasetCount === section.entry_count ? "count_match" : "count_differs",
      });
    }
  }
  return results;
}

// ---------- assembly ----------

function scrapeSitemap(html) {
  const $ = cheerio.load(html);
  const banner = $("section.page-banner").first();
  const title = collapse(banner.find("h2").first().text());

  const sections = extractSections($);
  const entries_flat = [];
  for (const s of sections) {
    for (const e of s.entries) {
      entries_flat.push({
        global_position: e.global_position,
        section_position: s.position,
        category: s.category,
        position: e.position,
        name: e.name,
        url: e.url,
      });
    }
  }

  const issues = [];
  // Page-wide duplicate check (the per-section one only sees its own section).
  const seen = new Map();
  for (const e of entries_flat) {
    if (!e.url) continue;
    seen.set(e.url, (seen.get(e.url) || 0) + 1);
  }
  const duplicate_urls = [...seen].filter(([, n]) => n > 1).map(([url, count]) => ({ url, count }));
  if (duplicate_urls.length) issues.push("duplicate_urls_across_sections");
  if (!sections.length) issues.push("no_sections");

  // Taxonomy sections whose heading is a term name rather than the taxonomy's
  // plural label — recorded, never corrected.
  for (const s of sections) {
    if (/^aol_/.test(s.type) && s.category && !/^(Application Status)$/.test(s.category)) {
      s.issues.push("heading_looks_like_term_name");
    }
  }

  const seo = extractSeo($, SITEMAP_URL);
  seo.breadcrumbs = extractBreadcrumbs(seo.json_ld); // BreadcrumbList lives in the AIOSEO @graph
  // Structural on this page (AIOSEO block only, no theme block) — same as the
  // gallery/archive pages, so dropped from the tally rather than reported.
  seo.seo_issues = seo.seo_issues.filter(
    (c) => c !== "no_post_specific_schema" && c !== "no_post_specific_meta"
  );

  return {
    url: SITEMAP_URL,
    title,
    breadcrumb: extractVisibleBreadcrumb($, banner),
    section_count: sections.length,
    entry_count: entries_flat.length,
    sections,
    entries_flat,
    duplicate_urls,
    seo,
    issues,
  };
}

function tallyIssues(result) {
  const tally = {};
  const bump = (c) => (tally[c] = (tally[c] || 0) + 1);
  result.issues.forEach(bump);
  result.seo.seo_issues.forEach(bump);
  for (const s of result.sections) {
    s.issues.forEach(bump);
    for (const e of s.entries) e.issues.forEach(bump);
  }
  if (result.xml_audit) result.xml_audit.issues.forEach(bump);
  for (const d of result.dataset_audit || []) {
    if (d.status === "differs") bump("dataset_urls_differ");
    if (d.status === "count_differs") bump("dataset_count_differs");
    if (d.status === "dataset_missing") bump("dataset_missing");
  }
  return tally;
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    out: "ils_sitemap.json",
    fromCache: false,
    refresh: false,
    xml: true,
    datasetCheck: true,
  };
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
      case "--no-xml":
        opts.xml = false;
        break;
      case "--no-dataset-check":
        opts.datasetCheck = false;
        break;
      default:
        break;
    }
  }
  return opts;
}

async function main() {
  const { out, fromCache, refresh, xml, datasetCheck } = parseArgs();
  cacheMode.fromCache = fromCache;
  cacheMode.refresh = refresh;
  if (fromCache) console.log(`[info] --from-cache: reading HTML from ${CACHE_DIR}, no network.`);
  if (refresh) console.log("[info] --refresh: re-fetching, overwriting cache.");

  const { html } = await fetchHtml(SITEMAP_URL, "sitemap/index");
  if (!html) {
    console.error(`[error] could not load ${SITEMAP_URL}`);
    process.exit(1);
  }

  const result = scrapeSitemap(html);

  if (xml) {
    const { html: smXml } = await fetchHtml(SITEMAP_XML, "sitemap/sitemap_xml");
    result.xml_audit = auditXml(
      smXml,
      result.entries_flat.map((e) => e.url).filter(Boolean)
    );
    if (!result.xml_audit) console.warn("[warn] /sitemap.xml unavailable — skipping XML cross-check.");
  } else {
    result.xml_audit = null;
  }

  result.dataset_audit = datasetCheck ? auditDatasets(result.sections) : null;
  result.issue_tallies = tallyIssues(result);

  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");

  console.log(`[done] ${result.section_count} categories / ${result.entry_count} links -> ${outPath}`);
  for (const s of result.sections) {
    console.log(`  ${String(s.position).padStart(2)}. ${(s.category || "(no heading)").padEnd(34)} ${String(s.entry_count).padStart(4)}  [${s.type}]`);
  }
  if (result.xml_audit) {
    const x = result.xml_audit;
    console.log(`[xml]  html=${x.html_url_count} xml=${x.xml_url_count} both=${x.in_both} html-only=${x.html_only_count} xml-only=${x.xml_only_count}`);
  }
  for (const d of result.dataset_audit || []) {
    if (d.status === "match" || d.status === "count_match") continue;
    const extra =
      d.comparison === "urls"
        ? ` (+${d.in_sitemap_not_in_dataset.length} sitemap-only / +${d.in_dataset_not_in_sitemap.length} dataset-only)`
        : "";
    console.log(`[data] ${d.section}: sitemap=${d.sitemap_count} dataset=${d.dataset_count} ${d.status}${extra}`);
  }
  console.log("[seo]  issue tally:", result.issue_tallies);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
