#!/usr/bin/env node
/**
 * ILS Hospitals Doctor Scraper (Node.js)
 * ---------------------------------------------------------------
 * Two passes:
 *   1. https://ilshospitals.com/doctors-list/ — one server-rendered page that
 *      holds ALL 375 doctor cards (no pagination). Each card carries the WP
 *      post id, the details-page URL, the photo, the speciality/qualification
 *      lines and — most usefully — pipe-delimited department and hospital ids
 *      (`data-speciality="|2512||893|"`, `data-hospitals="|341|"`). The page's
 *      filter sidebar doubles as an id -> name map for both. That pass alone
 *      produces doctors.json.
 *   2. every https://ilshospitals.com/doctor-list/<slug>/ page, for the full
 *      profile (description body, department list, education / advanced skills
 *      / experience blocks, per-hospital availability, booking link) plus the
 *      complete SEO block: meta_title, meta_description, canonical, robots,
 *      keywords, og:*, twitter:*, every <script type="application/ld+json">
 *      parsed as JSON, and the BreadcrumbList.
 *
 * The department ids on the cards match the WP post ids already captured in
 * ils_departments.json exactly (all 60, both ways), so `departments` is
 * resolved to {id, name, slug, url, icon} and the two datasets join cleanly.
 *
 * OPD TIMINGS. If ils_opd_schedules.json (from ils-opd-scraper.js) is present,
 * each hospital_availability entry gains a `timings` array of {day, time} for
 * that unit, joined by doctor post id + hospital id. Run OPD before doctors to
 * populate it; when the file is missing the scraper still runs and `timings` is
 * simply []. See scrape order: departments -> opd -> doctors -> key procedures.
 *
 * NOTE on this site's SEO: doctor pages ship TWO page-specific meta blocks in
 * the same order as department pages — the theme's first, AIOSEO's second — so
 * shared `extractSeo`'s last-non-empty-wins resolution yields the AIOSEO values.
 * That is right for title/description/canonical/keywords but wrong for
 * og:image, where AIOSEO overwrites the doctor's photo with the generic site
 * logo, and the theme's own twitter:url is the placeholder https://metatags.io/.
 * `seo.og_theme` / `seo.twitter_theme` therefore keep the first-wins (theme)
 * reading alongside. There is only ONE ld+json block site-wide here (AIOSEO's),
 * carrying BreadcrumbList/Organization/WebPage/WebSite and no Physician or
 * Person node at all — recorded as `no_physician_schema` rather than worked
 * around.
 *
 * Requires: axios, cheerio
 *   npm install axios cheerio
 *
 * Usage:
 *   node ils-doctor-scraper.js                        # all 375 -> ils_doctors.json
 *   node ils-doctor-scraper.js --index-only           # just doctors.json
 *   node ils-doctor-scraper.js --slug dr-om-tantia --out one.json
 *   node ils-doctor-scraper.js --limit 20
 *   node ils-doctor-scraper.js --from-list doctors.json
 *   node ils-doctor-scraper.js --from-cache           # reparse cached HTML, no network
 *   node ils-doctor-scraper.js --refresh              # re-fetch, overwrite cache
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

const LISTING_URL = "https://ilshospitals.com/doctors-list/";
const REST_URL = "https://ilshospitals.com/wp-json/wp/v2/doctor-list?per_page=100&_fields=id,slug,link,date,modified,title";
const DEPARTMENTS_FULL = path.resolve(__dirname, "ils_departments.json");
const DEPARTMENTS_INDEX = path.resolve(__dirname, "departments.json");
const OPD_SCHEDULES = path.resolve(__dirname, "ils_opd_schedules.json");

const collapse = (s) => (s || "").replace(/\s+/g, " ").trim() || null;

/** "|2512||893||12448|" -> [2512, 893, 12448] */
function parsePipeIds(value) {
  if (!value) return [];
  const ids = [];
  for (const part of value.split("|")) {
    const n = parseInt(part, 10);
    if (Number.isFinite(n) && !ids.includes(n)) ids.push(n);
  }
  return ids;
}

/**
 * The theme renders a "Book Appointment" anchor even when the doctor has no
 * booking link, degrading the href to "#?utm_source=...". Treat that as absent.
 */
function normalizeBookingUrl(href) {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  return trimmed;
}

// ---------- listing page ----------

/**
 * The filter sidebar ships three id -> name maps as checkbox inputs, tagged by
 * data-type: "doctor" (375), "speciality" (60 departments), "hospitals" (5).
 */
function parseFilterMap($, type) {
  const map = new Map();
  $(`input.filterCheckbox[data-type="${type}"]`).each((_, el) => {
    const id = parseInt($(el).attr("value"), 10);
    const title = collapse($(el).attr("data-title"));
    if (Number.isFinite(id) && title && !map.has(id)) map.set(id, title);
  });
  return map;
}

/** One <li class="d-list-li doctorCard"> from the listing page. */
function parseCard($, el) {
  const $card = $(el).find("div.card").first();
  const detailsUrl = $card.find("a.btn-dtc").attr("href") || null;
  const booking = $card.find("a.appointmentLink").first();

  // The card body has, in order: speciality, qualification, hospital name(s).
  const lines = $card
    .find(".d-content-box p.dtls-p")
    .map((_, p) => collapse($(p).text()))
    .get();

  const id = parseInt($card.attr("data-doctorid"), 10);

  return {
    id: Number.isFinite(id) ? id : null,
    name: collapse($card.find(".d-content-box h4").first().text()),
    slug: slugFromUrl(detailsUrl),
    url: detailsUrl,
    photo: $card.find("img.img-d").first().attr("src") || null,
    speciality: lines[0] || null,
    qualification: lines[1] || null,
    hospitals_text: lines[2] || null,
    hospital_ids: parsePipeIds($card.attr("data-hospitals")),
    department_ids: parsePipeIds($card.attr("data-speciality")),
    booking_url: normalizeBookingUrl(booking.attr("href")),
    first_hospital_id: parseInt(booking.attr("data-first-hospital"), 10) || null,
    first_department_id: parseInt(booking.attr("data-first-department"), 10) || null,
  };
}

/**
 * Build the doctor index from the listing page. Returns
 * { doctors, departmentNames, hospitalNames }.
 */
async function buildIndex() {
  console.log(`[info] Fetching listing: ${LISTING_URL}`);
  const { html } = await fetchHtml(LISTING_URL, "doctors/_listing");
  if (!html) throw new Error(`could not load ${LISTING_URL}`);

  const $ = cheerio.load(html);
  const doctors = [];
  const seen = new Set();
  $("li.doctorCard").each((_, el) => {
    const entry = parseCard($, el);
    if (!entry.slug || seen.has(entry.slug)) return;
    seen.add(entry.slug);
    doctors.push(entry);
  });

  const departmentNames = parseFilterMap($, "speciality");
  const hospitalNames = parseFilterMap($, "hospitals");
  console.log(
    `[info] listing: ${doctors.length} doctors, ${departmentNames.size} departments, ${hospitalNames.size} hospitals`
  );
  return { doctors, departmentNames, hospitalNames };
}

// ---------- cross-references ----------

/**
 * id -> {name, slug, url, icon} for the 60 departments. ils_departments.json
 * is authoritative (it carries the WP post id the cards key on);
 * departments.json is a name-only fallback, so it can only fill in slug/url
 * once the listing's own id -> name map has named the department.
 */
function loadDepartmentIndex(departmentNames) {
  const byId = new Map();
  try {
    for (const d of JSON.parse(fs.readFileSync(DEPARTMENTS_FULL, "utf-8"))) {
      if (d.id == null) continue;
      byId.set(d.id, { name: d.name || null, slug: d.slug || null, url: d.url || null, icon: d.icon || null });
    }
  } catch (e) {
    /* fall through to the name-matched fallback */
  }
  if (byId.size) return byId;

  console.warn("[warn] ils_departments.json unavailable, matching departments.json on name.");
  let byName = new Map();
  try {
    byName = new Map(
      JSON.parse(fs.readFileSync(DEPARTMENTS_INDEX, "utf-8")).map((d) => [d.name, d])
    );
  } catch (e) {
    return byId;
  }
  for (const [id, name] of departmentNames) {
    const d = byName.get(name);
    if (d) byId.set(id, { name: d.name || null, slug: d.slug || null, url: d.url || null, icon: d.icon || null });
  }
  return byId;
}

/** Expand the card's department ids into full records; unknown ids kept as-is. */
function resolveDepartments(ids, departmentIndex, departmentNames, issues) {
  return ids.map((id) => {
    const d = departmentIndex.get(id);
    if (!d) {
      if (!issues.includes("unknown_department_id")) issues.push("unknown_department_id");
      return { id, name: departmentNames.get(id) || null, slug: null, url: null, icon: null };
    }
    return { id, name: d.name || departmentNames.get(id) || null, slug: d.slug, url: d.url, icon: d.icon };
  });
}

/** Expand the card's hospital ids. One orphan id (17361) has no hospital post. */
function resolveHospitals(ids, hospitalNames, issues) {
  return ids.map((id) => {
    const name = hospitalNames.get(id) || null;
    if (!name && !issues.includes("unknown_hospital_id")) issues.push("unknown_hospital_id");
    return { id, name };
  });
}

/** id -> {published_date, modified_date} from the WP REST collection. */
async function loadRestDates() {
  const dates = new Map();
  for (let page = 1; page <= 20; page++) {
    const { data } = await fetchJson(`${REST_URL}&page=${page}`, `api/doctor-list-p${page}`);
    if (!Array.isArray(data) || !data.length) break;
    for (const d of data) dates.set(d.id, { published_date: d.date || null, modified_date: d.modified || null });
    if (data.length < 100) break;
  }
  if (dates.size) console.log(`[info] REST dates for ${dates.size} doctors`);
  else console.warn("[warn] REST dates unavailable, falling back to article:* meta.");
  return dates;
}

/**
 * doctor id -> (hospital id -> timings[]) from ils_opd_schedules.json, produced
 * by ils-opd-scraper.js. The OPD schedule keys on the same doctor post id and
 * hospital id as the doctor cards, so it folds straight into
 * hospital_availability. Missing file degrades to a warning and no merge, so the
 * doctor scraper still runs standalone (same contract as ils_departments.json).
 */
function loadOpdSchedules() {
  const byDoctor = new Map();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(OPD_SCHEDULES, "utf-8"));
  } catch (e) {
    console.warn("[warn] ils_opd_schedules.json unavailable; run ils-opd-scraper.js first to merge OPD timings.");
    return byDoctor;
  }
  for (const rec of raw) {
    if (rec.doctor_id == null || !Array.isArray(rec.schedule)) continue;
    const byHospital = new Map();
    for (const h of rec.schedule) {
      if (h.hospital_id == null) continue;
      byHospital.set(h.hospital_id, Array.isArray(h.timings) ? h.timings : []);
    }
    if (byHospital.size) byDoctor.set(rec.doctor_id, byHospital);
  }
  console.log(`[info] OPD schedules for ${byDoctor.size} doctors`);
  return byDoctor;
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

/**
 * The banner card renders label/value pairs as sibling <p class="dtls-p">,
 * where the label carries .text-blue ("Specialization", "Advance Skills") and
 * the value is whatever non-label paragraphs follow it. "Experience : 30 years"
 * is a bare line with no label, and reads "Experience : years" when unset.
 */
function parseBannerCard($, card) {
  const out = {
    specialization: null,
    advance_skills: null,
    experience_years: null,
    experience_text: null,
  };
  let label = null;

  card.find(".d-content-box > p.dtls-p").each((_, el) => {
    const $p = $(el);
    const text = collapse($p.text());
    if ($p.hasClass("text-blue")) {
      label = (text || "").toLowerCase();
      return;
    }
    if (/^Experience\s*:/i.test(text || "")) {
      out.experience_text = text;
      const m = text.match(/(\d+(?:\.\d+)?)/);
      out.experience_years = m ? Number(m[1]) : null;
      label = null;
      return;
    }
    if (/^Share Doctor Profile/i.test(text || "")) return;
    if (!text) return;
    if (label === "specialization") out.specialization = out.specialization || text;
    else if (label === "advance skills") out.advance_skills = out.advance_skills || text;
  });

  return out;
}

/**
 * The main column renders each block as <p class="p-title-20">Label</p>
 * followed by <ul class="appoint-ul">. Blocks with no data are HTML-commented
 * out by the theme, and cheerio does not surface comments as elements, so
 * walking the live <p class="p-title-20"> nodes yields exactly the present
 * blocks — the count varies per doctor (3 or 4).
 */
function parseDetailSections($, column) {
  const sections = [];
  column.find("p.p-title-20").each((_, el) => {
    const $p = $(el);
    const label = collapse($p.text());
    if (!label) return;
    // Stop at the next label so a block that renders no list (Dr. Mayank
    // Dokania's "Education") cannot adopt the following block's <ul>.
    let $ul = null;
    for (const sib of $p.nextAll().toArray()) {
      const $sib = $(sib);
      if ($sib.is("p.p-title-20")) break;
      if ($sib.is("ul.appoint-ul")) {
        $ul = $sib;
        break;
      }
    }
    const items = [];
    if ($ul) $ul.children("li").each((_, li) => {
      const $li = $(li);
      const name = collapse($li.text());
      if (!name) return;
      const icon = $li.find("img").first().attr("src") || null;
      items.push(icon ? { name, icon } : { name });
    });
    sections.push({ label, items });
  });
  return sections;
}

/** Flatten the theme's Physician ld+json node. */
function extractPhysician(blocks) {
  const p = findNode(blocks, "Physician");
  if (!p) return null;
  return {
    name: trimOrNull(p.name),
    alternate_name: trimOrNull(p.alternateName),
    description: trimOrNull(p.description),
    url: trimOrNull(p.url),
    image: typeof p.image === "string" ? trimOrNull(p.image) : p.image || null,
  };
}

/**
 * The Physician node's alternateName/description are hand-authored and on some
 * doctors are a copy-paste leftover naming a *different* doctor entirely.
 * Surname presence is the cheapest reliable tell.
 */
function physicianCopyMentionsDoctor(physician, doctorName) {
  const copy = `${physician.alternate_name || ""} ${physician.description || ""}`.toLowerCase();
  if (!copy.trim()) return true; // nothing authored — not a mismatch, just empty
  const tokens = (doctorName || "")
    .replace(/\(.*?\)/g, " ")
    .replace(/^\s*dr\.?\s*/i, "")
    .split(/[^A-Za-z]+/)
    .filter((t) => t.length >= 3);
  if (!tokens.length) return true;
  return tokens.some((t) => copy.includes(t.toLowerCase()));
}

/** Flat string list for one labelled block, matched case-insensitively. */
function sectionItems(sections, label) {
  const s = sections.find((x) => x.label.toLowerCase() === label.toLowerCase());
  return s ? s.items.map((i) => i.name) : [];
}

function scrapeDoctor(html, entry, refs) {
  const { departmentIndex, departmentNames, hospitalNames, restDates, opdSchedules } = refs;
  const $ = cheerio.load(html);
  const url = entry.url;
  const data_issues = [];

  // WP stamps the post id on <body class="... postid-7525 ...">. This post type
  // ships no rel=shortlink, so the body class is the only in-page source.
  const classMatch = ($("body").attr("class") || "").match(/\bpostid-(\d+)\b/);
  const id = classMatch ? Number(classMatch[1]) : null;
  if (entry.id != null && id != null && entry.id !== id) data_issues.push("id_mismatch_with_listing");

  const banner = $("section.page-banner").first();
  const card = banner.find(".doctor-details-card").first();
  const name = collapse(card.find("h4.d-name").first().text()) || entry.name || null;
  const photo = card.find("img.img-d").first().attr("src") || entry.photo || null;
  const speciality = collapse(card.find("p.dtls-p-20").first().text()) || entry.speciality || null;
  const qualification = collapse(card.find("p.dtls-p-16").first().text()) || entry.qualification || null;
  const bannerFields = parseBannerCard($, card);

  const bookingAnchor = banner.find("a.appointmentLink").first();
  const booking_url = normalizeBookingUrl(bookingAnchor.attr("href")) || entry.booking_url || null;
  if (!booking_url) data_issues.push("no_booking_link");

  // Every hospital is listed; .notavail marks the ones the doctor does NOT
  // practise at. Names read "ILS Hospitals, Saltlake", so match the filter map
  // on the trailing unit name. The OPD consulting timings (from
  // ils_opd_schedules.json) are folded in per hospital by that matched id; a
  // hospital with no OPD data gets timings: [].
  const opdByHospital = (opdSchedules && opdSchedules.get(id ?? entry.id)) || new Map();
  const seenOpdHospitals = new Set();
  const hospital_availability = [];
  banner.find("ul.aval-list-ul li").each((_, el) => {
    const $li = $(el);
    const label = collapse($li.text());
    if (!label) return;
    const unit = label.split(",").pop().trim().toLowerCase();
    let matchedId = null;
    for (const [hid, hname] of hospitalNames) {
      if (hname.toLowerCase() === unit) matchedId = hid;
    }
    const timings = (matchedId != null && opdByHospital.get(matchedId)) || [];
    if (matchedId != null && opdByHospital.has(matchedId)) seenOpdHospitals.add(matchedId);
    hospital_availability.push({ id: matchedId, name: label, available: !$li.hasClass("notavail"), timings });
  });
  // Any OPD hospital id that never matched a listed availability row is a join
  // gap worth recording rather than silently dropping its timings.
  for (const hid of opdByHospital.keys()) {
    if (!seenOpdHospitals.has(hid)) data_issues.push("opd_hospital_not_in_availability");
  }

  const column = $("section.bg-doctor-other-dtls .col-xl-8").first();

  // .doctor-description holds the theme's <h2>Description</h2> followed by the
  // WP post body (which has its own headings), so drop only that first heading.
  const desc = column.find(".doctor-description").first().clone();
  desc.children("h2").first().remove();
  const description_html = normalizeHtmlWhitespace(desc.length ? desc.html().trim() : null) || null;
  const description_text = collapse(desc.text());
  if (!description_html) data_issues.push("empty_description");
  if (!photo) data_issues.push("missing_photo");

  const detail_sections = parseDetailSections($, column);
  // The Department block renders names + icons but no ids; the listing card's
  // data-speciality ids are the joinable source, so they win. The on-page icon
  // is kept alongside because it is sometimes newer than departments.json.
  const pageDeptIcons = new Map();
  const deptSection = detail_sections.find((s) => s.label.toLowerCase() === "department");
  for (const item of (deptSection && deptSection.items) || []) pageDeptIcons.set(item.name, item.icon || null);

  const departments = resolveDepartments(
    entry.department_ids || [],
    departmentIndex,
    departmentNames,
    data_issues
  ).map((d) => ({ ...d, icon_on_page: (d.name && pageDeptIcons.get(d.name)) || null }));

  const hospitals = resolveHospitals(entry.hospital_ids || [], hospitalNames, data_issues);

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
  seo.physician = extractPhysician(seo.json_ld);
  // Passed every block, not json_ld_by_source.post: the only ld+json here is
  // AIOSEO's, and the BreadcrumbList sits inside its @graph.
  seo.breadcrumbs = extractBreadcrumbs(seo.json_ld);
  seo.article_published_time = resolveLast(meta, "article:published_time");
  seo.article_modified_time = resolveLast(meta, "article:modified_time");

  // Doctor-specific defects, layered on top of extractSeo's own list.
  const issues = [...seo.seo_issues];
  if (!seo.physician) issues.push("no_physician_schema");
  else if (!physicianCopyMentionsDoctor(seo.physician, name)) issues.push("physician_schema_copy_paste");
  if (twitter_theme.url && !twitter_theme.url.includes("ilshospitals.com")) issues.push("twitter_url_placeholder");
  if (og_theme.image && seo.og.image && og_theme.image !== seo.og.image && /\/logo\.[a-z]+$/i.test(seo.og.image))
    issues.push("og_image_generic_logo");
  if (og_theme.title && seo.og.title && og_theme.title.trim() !== seo.og.title.trim()) issues.push("og_title_conflict");
  if (!description_html) issues.push("empty_description");
  if (!photo) issues.push("missing_photo");
  if (!booking_url) issues.push("no_booking_link");
  if (data_issues.includes("id_mismatch_with_listing")) issues.push("id_mismatch_with_listing");
  seo.seo_issues = issues;

  const rest = restDates.get(id ?? entry.id) || {};

  return {
    id: id ?? entry.id ?? null,
    name,
    slug: entry.slug,
    url,
    photo,
    breadcrumb: extractVisibleBreadcrumb($, banner),
    speciality,
    qualification,
    specialization: bannerFields.specialization,
    advance_skills: bannerFields.advance_skills,
    experience_years: bannerFields.experience_years,
    experience_text: bannerFields.experience_text,
    booking_url,
    booking_hospital_id: entry.first_hospital_id ?? null,
    booking_department_id: entry.first_department_id ?? null,
    hospitals,
    hospital_availability,
    departments,
    description_html,
    description_text,
    detail_sections,
    education: sectionItems(detail_sections, "Education"),
    advanced_skills: sectionItems(detail_sections, "Advanced Skills"),
    experience: sectionItems(detail_sections, "Experience"),
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
    out: "ils_doctors.json",
    indexOut: "doctors.json",
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

  // The filter maps only exist on the listing page, so it is always parsed even
  // when the doctor list itself comes from --from-list.
  const { doctors, departmentNames, hospitalNames } = await buildIndex();

  let list = doctors;
  if (fromList) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), fromList), "utf-8"));
    console.log(`[info] doctor list from ${fromList}: ${raw.length} entries`);
    list = raw;
  } else {
    const indexPath = path.resolve(process.cwd(), indexOut);
    fs.writeFileSync(indexPath, JSON.stringify(doctors, null, 2), "utf-8");
    console.log(`[done] Index: ${doctors.length} doctors -> ${indexPath}`);
  }

  if (indexOnly) return;

  if (slug) list = list.filter((d) => d.slug === slug);
  if (limit) list = list.slice(0, limit);
  if (!list.length) {
    console.error("[error] no doctors matched.");
    process.exit(1);
  }

  const refs = {
    departmentIndex: loadDepartmentIndex(departmentNames),
    departmentNames,
    hospitalNames,
    restDates: await loadRestDates(),
    opdSchedules: loadOpdSchedules(),
  };

  const results = [];
  let done = 0;
  for (const entry of list) {
    done += 1;
    console.log(`[info] (${done}/${list.length}) Fetching doctor: ${entry.url}`);
    const { html, fromCache: cached } = await fetchHtml(entry.url, `doctors/${entry.slug}`);
    if (!html) {
      console.error(`  [error] no HTML for ${entry.url}`);
      continue;
    }
    try {
      results.push(scrapeDoctor(html, entry, refs));
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
  const noDesc = results.filter((d) => !d.description_html).length;
  const noDept = results.filter((d) => !d.departments.length).length;
  console.log(`[done] Scraped ${results.length}/${list.length} doctors -> ${outPath}`);
  if (noDesc) console.log(`[warn] ${noDesc} doctors had no description`);
  if (noDept) console.log(`[warn] ${noDept} doctors had no department`);
  console.log("[seo]  issue tally:", tally);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
