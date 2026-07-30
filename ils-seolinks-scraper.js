#!/usr/bin/env node
/**
 * ILS Hospitals "SEO Links" Scraper (Node.js)
 * ---------------------------------------------------------------
 * Extracts every URL listed in `new_links_28-07.md` into JSON (default
 * ils_seolinks.json), one record per URL, with full SEO/JSON-LD audit.
 *
 * WHAT THE LIST IS. 621 URLs. 572 of them are programmatic "<specialty> in
 * <city>" landing pages (e.g. /cardiologist-in-agartala/, /speech-therapists
 * -in-saltlake/) — a content type no other scraper in this repo touches. The
 * remaining ~49 are a grab-bag of top-level site pages (contact, sitemap,
 * career, gallery, investor pages, the homepage, a couple of already-scraped
 * hubs) included in the same audit list even though several already have
 * their own dedicated scraper. This script does not special-case those; it
 * audits every URL in the list uniformly and lets `kind` distinguish them.
 *
 * PAGE SHAPE (specialist pages). `<body class="... page-template
 * page-template-specialist-page ...">`. Banner is `section.page-banner`,
 * same base class as every other page on the site: `<span><a href="/">Home</a>
 * - <strong>Cardiologist in Agartala</strong></span>` for the visible
 * breadcrumb, `<h2>` for the visible title. The doctor list is
 * `.doctor-box ul.d-list-ul > li.doctorCard`, one `.card` per doctor:
 * `img.img-d` (photo), `h4` (display name — usually just "<specialty> in
 * <city>" again, not a person's name), `p.dtls-p` (department; up to three
 * sibling `<p class="dtls-p">` tags per card but only the first is ever
 * populated in practice), `a.btn-dtc` (link to `/doctor-list/<slug>/`) and
 * `a.appointmentLink` ("Book An Appointment", not a real URL — href is a
 * `#?utm_...` fragment). Zero-result pages render a literal
 * "No Doctor Available !" heading in place of the `<li>` list instead of an
 * empty `<ul>`.
 *
 * OTHER PAGES. No shared template — everything from the custom, header-only
 * "soft 404" (`/page-not-forund/`, which serves HTTP 200) to ordinary WP
 * pages with a `section.page-banner`. This script only pulls what is common
 * to (almost) all of them: `extractSeo`, the visible banner title, and the
 * visible breadcrumb, tagging `kind: "site_page"` and leaving doctor fields
 * null. Pages with no `<head>` at all (the soft-404) come back with every SEO
 * field null, which is itself the audit finding — flagged
 * `no_head_metadata` rather than worked around.
 *
 * SEO. Order is the OPPOSITE of blog posts / departments: on specialist
 * pages the theme's own `Physician` + `MedicalOrganization` ld+json blocks
 * (unclassed, `_source: "post"`) come FIRST in the document, and AIOSEO's
 * classed `aioseo-schema` block — carrying a real, page-specific, correctly
 * self-referential canonical/title/og — comes SECOND. `extractSeo`'s
 * last-non-empty-wins resolution is still correct here (AIOSEO wins), it's
 * just resolving in the site's favor for once instead of against it.
 *
 * RECORD DEFECTS FOUND IN THIS BATCH (not worked around, just flagged):
 *   - `physician_description_mismatched_city`: the theme's Physician
 *     ld+json `description` is templated per specialty but the trailing
 *     "...now at ILS Hospitals, <city>." clause is sometimes copy-pasted
 *     from a different page and doesn't match the URL's own city (e.g.
 *     /cardiologist-in-agartala/'s description ends "...ILS Hospitals,
 *     Howrah.").
 *   - `duplicate_specialist_landing_page`: more than one URL in the list
 *     renders the identical visible banner title (e.g.
 *     /gastroenterologist-in-agartala/ and /gastroenterologist-in-agartala-3/
 *     both render "Gastroenterologist in Agartala", with two DIFFERENT
 *     `<title>`s besides) — near-duplicate landing pages competing for the
 *     same query.
 *   - `no_doctor_available`: specialist page renders the "No Doctor
 *     Available !" empty state.
 *   - `soft_404_200`: page returns HTTP 200 with no `<head>`/meta at all
 *     (the site's custom "not found" page is not wired to a real 404).
 *
 * Requires: axios, cheerio (npm install axios cheerio)
 *
 * Usage:
 *   node ils-seolinks-scraper.js                    # -> ils_seolinks.json
 *   node ils-seolinks-scraper.js --out one.json
 *   node ils-seolinks-scraper.js --from-cache        # reparse cached HTML, no network
 *   node ils-seolinks-scraper.js --refresh           # re-fetch, overwrite cache
 *   node ils-seolinks-scraper.js --from-list other.md
 *   node ils-seolinks-scraper.js --limit 20
 *   node ils-seolinks-scraper.js --slug cardiologist-in-agartala
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const {
  CACHE_DIR,
  cacheMode,
  REQUEST_DELAY_MS,
  sleep,
  trimOrNull,
  slugFromUrl,
  fetchHtml,
  extractSeo,
} = require("./scrape-lib");

const SITE_ORIGIN = "https://ilshospitals.com";
const DEFAULT_LIST = "seoLinks.md";
const KNOWN_CITIES = ["saltlake", "salt lake", "dumdum", "howrah", "agartala", "raipur"];

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

/** Pull every https://ilshospitals.com URL out of the markdown link list, in order, deduped. */
function readUrlList(file) {
  const text = fs.readFileSync(path.resolve(process.cwd(), file), "utf-8");
  const matches = text.match(/https:\/\/ilshospitals\.com\S*/g) || [];
  const seen = new Set();
  const urls = [];
  for (let raw of matches) {
    const url = raw.trim().replace(/[)\]"'.,;]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function cacheKeyFor(url) {
  const slug = slugFromUrl(url);
  return `seolinks/${slug || "home"}`;
}

/** City token the URL itself is targeting, e.g. "agartala" from .../cardiologist-in-agartala/. */
function cityFromUrl(url) {
  const slug = slugFromUrl(url) || "";
  const m = slug.match(/-in-([a-z-]+?)(?:-\d+)?$/i);
  if (!m) return null;
  const token = m[1].replace(/-/g, " ");
  return KNOWN_CITIES.find((c) => c.replace(/ /g, "") === token.replace(/ /g, "")) || token;
}

/** The breadcrumb the page actually renders, in the banner (shared shape across templates). */
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

function extractDoctors($) {
  const doctors = [];
  $(".doctor-box ul.d-list-ul > li.doctorCard").each((_, el) => {
    const $li = $(el);
    const name = collapse($li.find(".d-content-box h4").first().text());
    const details = $li
      .find(".d-content-box p.dtls-p")
      .map((__, p) => collapse($(p).text()))
      .get()
      .filter(Boolean);
    doctors.push({
      position: doctors.length + 1,
      name,
      department: details[0] || null,
      other_details: details.slice(1),
      image: absoluteUrl($li.find("img.img-d").attr("src")),
      detail_url: absoluteUrl($li.find("a.btn-dtc").attr("href")),
      has_appointment_link: $li.find("a.appointmentLink").length > 0,
    });
  });
  return doctors;
}

function scrapePage(url, html) {
  const record = {
    url,
    slug: slugFromUrl(url) || null,
    fetched: !!html,
    kind: null,
    page_template: null,
    wp_page_id: null,
    visible_title: null,
    breadcrumb: [],
    doctor_count: null,
    no_doctor_available: null,
    doctors: null,
    seo: null,
    issues: [],
  };

  if (!html) {
    record.kind = "not_found";
    record.issues.push("fetch_failed_or_404");
    return record;
  }

  const $ = cheerio.load(html);
  const bodyClass = $("body").attr("class") || "";
  const templateMatch = bodyClass.match(/page-template-([a-z0-9-]+?)(?:-php)?\s/) || bodyClass.match(/page-template-([a-z0-9-]+?)(?:-php)?$/);
  record.page_template = templateMatch ? templateMatch[1] : null;
  const idMatch = bodyClass.match(/\bpage-id-(\d+)\b/);
  record.wp_page_id = idMatch ? Number(idMatch[1]) : null;

  const isSpecialist = /page-template-specialist-page\b/.test(bodyClass);

  const seo = extractSeo($, url);
  record.seo = seo;

  const banner = $("section.page-banner").first();
  if (banner.length) {
    record.visible_title = collapse(banner.find("h1,h2").first().text());
    record.breadcrumb = extractVisibleBreadcrumb($, banner);
  }

  // The site's custom "not found" page (e.g. /page-not-forund/) serves HTTP 200
  // with no <title>, no meta tags and no page-banner at all — a soft 404.
  const hasMetadata = !!(seo.meta_title || seo.canonical || (seo.meta_all && seo.meta_all.length));
  if (!hasMetadata && !banner.length) {
    record.kind = "soft_404";
    record.issues.push("soft_404_200", "no_head_metadata");
    return record;
  }

  if (isSpecialist) {
    record.kind = "specialist_landing";
    const doctors = extractDoctors($);
    record.doctors = doctors;
    record.doctor_count = doctors.length;
    const noDoctorText = $(".doctor-box").text();
    record.no_doctor_available = doctors.length === 0 && /no\s+doctor\s+available/i.test(noDoctorText);
    if (record.no_doctor_available) record.issues.push("no_doctor_available");
    else if (doctors.length === 0) record.issues.push("empty_doctor_list_unlabeled");

    const physician = (seo.json_ld || []).find((b) => b && b["@type"] === "Physician") || null;
    const urlCity = cityFromUrl(url);
    if (physician && physician.description && urlCity) {
      // The templated description ends "...now at ILS Hospitals, <City>." — that
      // trailing city is the one that gets copy-pasted wrong, not the specialty
      // mentions earlier in the sentence, so only the clause right after
      // "ILS Hospitals," is checked against the URL's own city.
      const m = physician.description.match(/ils hospitals,?\s*([a-z ]+?)[.\s]*$/i);
      const trailingCity = m ? m[1].trim().toLowerCase() : null;
      if (trailingCity) {
        if (trailingCity.replace(/ /g, "") !== urlCity.replace(/ /g, "")) {
          record.issues.push("physician_description_mismatched_city");
          record.physician_description_city = trailingCity;
        }
      } else {
        record.issues.push("physician_description_missing_city");
      }
    } else if (!physician) {
      record.issues.push("no_physician_schema");
    }
  } else {
    record.kind = "site_page";
  }

  return record;
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    out: "ils_seolinks.json",
    fromCache: false,
    refresh: false,
    fromList: DEFAULT_LIST,
    slug: null,
    limit: null,
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
      case "--from-list":
        opts.fromList = args[++i];
        break;
      case "--slug":
        opts.slug = args[++i];
        break;
      case "--limit":
        opts.limit = Number(args[++i]);
        break;
      default:
        break;
    }
  }
  return opts;
}

async function main() {
  const { out, fromCache, refresh, fromList, slug, limit } = parseArgs();
  cacheMode.fromCache = fromCache;
  cacheMode.refresh = refresh;
  if (fromCache) console.log(`[info] --from-cache: reading HTML from ${CACHE_DIR}, no network.`);
  if (refresh) console.log("[info] --refresh: re-fetching, overwriting cache.");

  let urls = readUrlList(fromList);
  console.log(`[info] ${urls.length} unique URLs in ${fromList}`);

  if (slug) urls = urls.filter((u) => (slug === "home" ? u === `${SITE_ORIGIN}/` : (slugFromUrl(u) || "") === slug));
  if (limit) urls = urls.slice(0, limit);

  const records = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    process.stdout.write(`[${i + 1}/${urls.length}] ${url}\n`);
    const { html, fromCache: hitCache } = await fetchHtml(url, cacheKeyFor(url));
    records.push(scrapePage(url, html));
    if (!hitCache && !cacheMode.fromCache) await sleep(REQUEST_DELAY_MS);
  }

  // Cross-record defect: same visible title rendered at more than one URL.
  const byTitle = new Map();
  for (const r of records) {
    if (!r.visible_title) continue;
    const key = r.visible_title.toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(r.url);
  }
  for (const r of records) {
    if (!r.visible_title) continue;
    const group = byTitle.get(r.visible_title.toLowerCase());
    if (group.length > 1) {
      r.issues.push("duplicate_specialist_landing_page");
      r.duplicate_urls = group.filter((u) => u !== r.url);
    }
  }

  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(records, null, 2), "utf-8");

  const tally = {};
  for (const r of records) for (const issue of r.issues) tally[issue] = (tally[issue] || 0) + 1;
  const kindTally = {};
  for (const r of records) kindTally[r.kind] = (kindTally[r.kind] || 0) + 1;

  console.log(`[done] ${records.length} URLs scraped -> ${outPath}`);
  console.log("[info] kind tally:", kindTally);
  console.log("[seo]  issue tally:", tally);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
