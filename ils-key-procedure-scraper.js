#!/usr/bin/env node
/**
 * ILS Hospitals Key Procedure Scraper (Node.js)
 * ---------------------------------------------------------------
 * Two passes:
 *   1. https://ilshospitals.com/key-procedures/ — one server-rendered page
 *      holding ALL 115 procedure cards (the "View More" button only expands
 *      CSS-clamped rows; there is no pagination). Gives name, slug, URL, icon
 *      and the search keyword. That pass alone produces key_procedures.json.
 *   2. every https://ilshospitals.com/key-procedures/<slug>/ page, for the body
 *      content, the sidebar cross-references (sibling procedures + the doctors
 *      who perform it + the department the procedure belongs to) and the full
 *      SEO block: meta_title, meta_description, canonical, robots, keywords,
 *      og:*, twitter:*, every <script type="application/ld+json"> parsed as
 *      JSON, the flattened MedicalProcedure node and the BreadcrumbList.
 *
 * The sidebar's "Doctors -> View All" link points at
 * /doctors-list/?spec=<id>, and that id is the department's WP post id — the
 * only place the procedure -> department edge exists in the markup. It is
 * resolved against ils_departments.json, and the sidebar doctors against
 * ils_doctors.json, so all three datasets join.
 *
 * DELIBERATELY SKIPPED, do not "fix" these back in:
 *   - the bg-faq card section: its three cards are randomized PER REQUEST
 *     (three successive fetches of one URL returned three different triples
 *     drawn from the same nine faq-lists pages), so capturing them would make
 *     every rerun diff for no reason. The head's FAQPage ld+json blocks mirror
 *     that same random pick, and those ARE kept — `extractSeo` captures every
 *     ld+json block verbatim and silently dropping one would misreport what the
 *     page emits. `randomized_faq_schema` flags it, and it is the one reason a
 *     --refresh rerun legitimately produces a diff in `seo.json_ld`;
 *   - the video-testimonial carousel and the lead-capture form, which are
 *     byte-identical site-wide;
 *   - the banner's "Find a Doctor" / "Book Appointment" buttons, likewise.
 * Note also that the nav megamenu carries 15 key-procedures links of its own,
 * so every procedure-link selector here is scoped to its section rather than
 * run over the whole document.
 *
 * NOTE on this site's SEO: procedure pages ship TWO page-specific meta blocks
 * in the same order as department and doctor pages — the theme's first, AIOSEO's
 * second — so shared `extractSeo`'s last-non-empty-wins resolution yields the
 * AIOSEO values. That is right for title/description/canonical/keywords but
 * wrong for og:image, where AIOSEO overwrites the procedure icon with the
 * generic site logo, and the theme's own twitter:url is the placeholder
 * https://metatags.io/. `seo.og_theme` / `seo.twitter_theme` therefore keep the
 * first-wins (theme) reading alongside. There are FOUR ld+json blocks: the
 * theme's MedicalProcedure (promoted to seo.medical_procedure), a
 * MedicalOrganization whose name and postal address routinely disagree, the
 * generic FAQPage, and the AIOSEO @graph.
 *
 * Requires: axios, cheerio
 *   npm install axios cheerio
 *
 * Usage:
 *   node ils-key-procedure-scraper.js                    # all 115 -> ils_key_procedures.json
 *   node ils-key-procedure-scraper.js --index-only       # just key_procedures.json
 *   node ils-key-procedure-scraper.js --slug angioplasty --out one.json
 *   node ils-key-procedure-scraper.js --limit 20
 *   node ils-key-procedure-scraper.js --from-list key_procedures.json
 *   node ils-key-procedure-scraper.js --from-cache       # reparse cached HTML, no network
 *   node ils-key-procedure-scraper.js --refresh          # re-fetch, overwrite cache
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

const LISTING_URL = "https://ilshospitals.com/key-procedures/";
const REST_URL =
  "https://ilshospitals.com/wp-json/wp/v2/key-procedures?per_page=100&_fields=id,slug,link,date,modified,title";
const DEPARTMENTS_FULL = path.resolve(__dirname, "ils_departments.json");
const DOCTORS_FULL = path.resolve(__dirname, "ils_doctors.json");

const collapse = (s) => (s || "").replace(/\s+/g, " ").trim() || null;

/** The theme emits <img src=""> for the 35 procedures that have no icon. */
const imgSrc = (el) => {
  const src = (el.attr("src") || "").trim();
  return src || null;
};

// ---------- listing page ----------

/** One <li class="opd-card-li"> — the shared card markup, used by the listing
 *  page and by the detail page's "Other Key Procedures" sidebar alike. */
function parseProcedureCard($, el) {
  const $li = $(el);
  const $a = $li.find("a").first();
  const url = $a.attr("href") || null;
  return {
    name: collapse($a.find("p.title-treatment").text()),
    slug: slugFromUrl(url),
    url,
    icon: imgSrc($a.find(".icon-box img").first()),
    keyword: collapse($li.attr("data-filter-keyword")),
  };
}

async function buildIndex() {
  console.log(`[info] Fetching listing: ${LISTING_URL}`);
  const { html } = await fetchHtml(LISTING_URL, "key-procedures/_listing");
  if (!html) throw new Error(`could not load ${LISTING_URL}`);

  const $ = cheerio.load(html);
  const procedures = [];
  const seen = new Set();
  // Scoped to the listing section: the nav megamenu holds key-procedures links too.
  $("section.keytreatments-procedure li.opd-card-li").each((_, el) => {
    const entry = parseProcedureCard($, el);
    if (!entry.slug || seen.has(entry.slug)) return;
    seen.add(entry.slug);
    procedures.push(entry);
  });

  console.log(`[info] listing: ${procedures.length} procedures (${procedures.filter((p) => !p.icon).length} with no icon)`);
  return procedures;
}

// ---------- cross-references ----------

/** id -> {name, slug, url, icon} for the departments the ?spec= link targets. */
function loadDepartmentIndex() {
  const byId = new Map();
  try {
    for (const d of JSON.parse(fs.readFileSync(DEPARTMENTS_FULL, "utf-8"))) {
      if (d.id == null) continue;
      byId.set(d.id, { name: d.name || null, slug: d.slug || null, url: d.url || null, icon: d.icon || null });
    }
  } catch (e) {
    console.warn("[warn] ils_departments.json unavailable — departments will not be resolved.");
  }
  return byId;
}

/** slug -> {id, name, url} so sidebar doctors carry their WP post id. */
function loadDoctorIndex() {
  const bySlug = new Map();
  try {
    for (const d of JSON.parse(fs.readFileSync(DOCTORS_FULL, "utf-8"))) {
      if (!d.slug) continue;
      bySlug.set(d.slug, { id: d.id ?? null, name: d.name || null, url: d.url || null });
    }
  } catch (e) {
    console.warn("[warn] ils_doctors.json unavailable — doctor ids will not be resolved.");
  }
  return bySlug;
}

/** id -> {published_date, modified_date} from the WP REST collection. */
async function loadRestDates() {
  const dates = new Map();
  for (let page = 1; page <= 20; page++) {
    const { data } = await fetchJson(`${REST_URL}&page=${page}`, `api/key-procedures-p${page}`);
    if (!Array.isArray(data) || !data.length) break;
    for (const d of data) dates.set(d.id, { published_date: d.date || null, modified_date: d.modified || null });
    if (data.length < 100) break;
  }
  if (dates.size) console.log(`[info] REST dates for ${dates.size} procedures`);
  else console.warn("[warn] REST dates unavailable, falling back to article:* meta.");
  return dates;
}

// ---------- detail page parsing ----------

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

/** Flatten the theme's MedicalProcedure ld+json node. */
function extractMedicalProcedure(blocks) {
  const mp = findNode(blocks, "MedicalProcedure");
  if (!mp) return null;
  return {
    name: trimOrNull(mp.name),
    alternate_name: trimOrNull(mp.alternateName),
    description: trimOrNull(mp.description),
    url: trimOrNull(mp.url),
  };
}

/**
 * The MedicalOrganization node names one unit ("ILS Hospitals, Raipur") while
 * carrying another's street address ("Salt Lake City..."). Detect by checking
 * whether the unit named in `name` appears anywhere in the postal address.
 */
function medicalOrgAddressAgrees(blocks) {
  const org = findNode(blocks, "MedicalOrganization");
  if (!org || !org.name || !org.address) return true;
  const unit = String(org.name).split(",").pop().trim().toLowerCase();
  if (!unit) return true;
  const addr = Object.values(org.address).join(" ").toLowerCase();
  // "saltlake" in the name vs "Salt Lake City" in the address is the same unit.
  return addr.includes(unit) || addr.replace(/\s+/g, "").includes(unit.replace(/\s+/g, ""));
}

/** The sidebar's "Doctors" cards. */
function parseSidebarDoctors($, sidebar, doctorIndex) {
  const doctors = [];
  sidebar.find("li.doc-opd-card-li").each((_, el) => {
    const $li = $(el);
    const url = $li.find("a.a-d-details").attr("href") || null;
    const slug = slugFromUrl(url);
    const lines = $li
      .find(".content-box p.title-treatment")
      .map((_, p) => collapse($(p).text()))
      .get();
    const known = (slug && doctorIndex.get(slug)) || null;
    doctors.push({
      id: known ? known.id : null,
      name: collapse($li.find(".content-box h4").first().text()),
      slug,
      url,
      photo: imgSrc($li.find(".icon-box img").first()),
      speciality: lines[0] || null,
      hospital: lines[1] || null,
    });
  });
  return doctors;
}

function scrapeProcedure(html, entry, refs) {
  const { departmentIndex, doctorIndex, restDates } = refs;
  const $ = cheerio.load(html);
  const url = entry.url;
  const data_issues = [];

  // WP stamps the post id on <body class="... postid-931 ...">.
  const classMatch = ($("body").attr("class") || "").match(/\bpostid-(\d+)\b/);
  const id = classMatch ? Number(classMatch[1]) : null;

  const banner = $("section.page-banner").first();
  const name = collapse(banner.find("h2").first().text()) || entry.name || null;

  // Two .center-details divs exist (body + sidebar), so .dtls-treatment is
  // required to pick the body — .first() alone would be fragile.
  const body = $(".center-details.dtls-treatment").first();
  const heading = collapse(body.find("h2").first().text());
  const content = normalizeHtmlWhitespace(body.length ? body.html().trim() : null) || null;
  const content_text = collapse(body.text());
  if (!content) data_issues.push("empty_content");
  if (!entry.icon) data_issues.push("missing_icon");

  // ---- sidebar cross-references ----
  const sidebar = $(".center-details.other-random-list").first();

  const specHref = sidebar.find('a[href*="/doctors-list/?spec="]').attr("href") || "";
  const specMatch = specHref.match(/[?&]spec=(\d+)/);
  const departmentId = specMatch ? Number(specMatch[1]) : null;
  let department = null;
  if (departmentId == null) {
    data_issues.push("no_department_link");
  } else {
    const d = departmentIndex.get(departmentId);
    if (!d) data_issues.push("unknown_department_id");
    department = {
      id: departmentId,
      name: d ? d.name : null,
      slug: d ? d.slug : null,
      url: d ? d.url : null,
    };
  }

  const related_procedures = sidebar
    .find("li.opd-card-li")
    .map((_, el) => parseProcedureCard($, el))
    .get()
    .filter((p) => p.slug && p.slug !== entry.slug);

  const doctors = parseSidebarDoctors($, sidebar, doctorIndex);
  if (!doctors.length) data_issues.push("no_doctors_listed");
  const unresolvedDoctors = doctors.filter((d) => d.id == null).length;
  if (unresolvedDoctors) data_issues.push("unresolved_doctor_slug");

  // ---- SEO ----
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
  seo.medical_procedure = extractMedicalProcedure(seo.json_ld);
  // Passed every block, not json_ld_by_source.post: the BreadcrumbList sits
  // inside the AIOSEO @graph here, as on department pages.
  seo.breadcrumbs = extractBreadcrumbs(seo.json_ld);
  seo.article_published_time = resolveLast(meta, "article:published_time");
  seo.article_modified_time = resolveLast(meta, "article:modified_time");

  // Procedure-specific defects, layered on top of extractSeo's own list.
  const issues = [...seo.seo_issues];
  if (!seo.medical_procedure) issues.push("no_medical_procedure_schema");
  if (!medicalOrgAddressAgrees(seo.json_ld)) issues.push("medical_org_schema_address_mismatch");
  // The FAQPage nodes are drawn at random per request, so this block of the
  // captured schema is not reproducible between runs.
  if (seo.json_ld.some((b) => b && b["@type"] === "FAQPage")) issues.push("randomized_faq_schema");
  if (twitter_theme.url && !twitter_theme.url.includes("ilshospitals.com")) issues.push("twitter_url_placeholder");
  if (og_theme.image && seo.og.image && og_theme.image !== seo.og.image && /\/logo\.[a-z]+$/i.test(seo.og.image))
    issues.push("og_image_generic_logo");
  if (og_theme.title && seo.og.title && og_theme.title.trim() !== seo.og.title.trim()) issues.push("og_title_conflict");
  for (const k of ["empty_content", "missing_icon", "no_department_link", "no_doctors_listed"]) {
    if (data_issues.includes(k)) issues.push(k);
  }
  seo.seo_issues = issues;

  const rest = restDates.get(id) || {};

  return {
    id,
    name,
    slug: entry.slug,
    url,
    icon: entry.icon || null,
    keyword: entry.keyword || null,
    breadcrumb: extractVisibleBreadcrumb($, banner),
    heading,
    content,
    content_text,
    department,
    related_procedures,
    doctors,
    published_date: rest.published_date || seo.article_published_time || null,
    modified_date: rest.modified_date || seo.article_modified_time || null,
    seo,
    seo_issues: issues,
    data_issues,
  };
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    out: "ils_key_procedures.json",
    indexOut: "key_procedures.json",
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

  let list;
  if (fromList) {
    list = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), fromList), "utf-8"));
    console.log(`[info] procedure list from ${fromList}: ${list.length} entries`);
  } else {
    list = await buildIndex();
    const indexPath = path.resolve(process.cwd(), indexOut);
    fs.writeFileSync(indexPath, JSON.stringify(list, null, 2), "utf-8");
    console.log(`[done] Index: ${list.length} procedures -> ${indexPath}`);
  }

  if (indexOnly) return;

  if (slug) list = list.filter((p) => p.slug === slug);
  if (limit) list = list.slice(0, limit);
  if (!list.length) {
    console.error("[error] no procedures matched.");
    process.exit(1);
  }

  const refs = {
    departmentIndex: loadDepartmentIndex(),
    doctorIndex: loadDoctorIndex(),
    restDates: await loadRestDates(),
  };

  const results = [];
  let done = 0;
  for (const entry of list) {
    done += 1;
    console.log(`[info] (${done}/${list.length}) Fetching procedure: ${entry.url}`);
    const { html, fromCache: cached } = await fetchHtml(entry.url, `key-procedures/${entry.slug}`);
    if (!html) {
      console.error(`  [error] no HTML for ${entry.url}`);
      continue;
    }
    try {
      results.push(scrapeProcedure(html, entry, refs));
    } catch (e) {
      console.error(`  [error] failed to parse ${entry.url}: ${e.message}`);
    }
    if (!cached) await sleep(REQUEST_DELAY_MS);
  }

  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");

  // Summary of the SEO defects this run observed, so problems stay visible.
  const tally = {};
  for (const p of results) for (const k of p.seo_issues || []) tally[k] = (tally[k] || 0) + 1;
  const noContent = results.filter((p) => !p.content).length;
  const noDept = results.filter((p) => !p.department).length;
  console.log(`[done] Scraped ${results.length}/${list.length} procedures -> ${outPath}`);
  if (noContent) console.log(`[warn] ${noContent} procedures had no content`);
  if (noDept) console.log(`[warn] ${noDept} procedures had no department link`);
  console.log("[seo]  issue tally:", tally);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
