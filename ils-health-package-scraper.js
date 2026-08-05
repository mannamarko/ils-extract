#!/usr/bin/env node
/**
 * ILS Hospitals Health Package Scraper (Node.js)
 * ---------------------------------------------------------------
 * Two passes:
 *   1. https://ilshospitals.com/health-packages/ — one server-rendered page
 *      holding all 35 package cards. THIS IS THE ONLY SOURCE OF HOSPITAL
 *      AVAILABILITY: each card's wrapper div carries `hospital-<id>` CSS
 *      classes that the page's own #hospitalFilter <select> maps to names.
 *      Detail pages carry no hospital-* class anywhere, and their booking form
 *      offers the generic site-wide list of all five units, so a detail-only
 *      crawl cannot tell you where a package is sold. The listing is also the
 *      only place the "N Parameter" count and the price pair live in a
 *      machine-readable form.
 *   2. every https://ilshospitals.com/health-package/<slug>/ page, for the
 *      description, the full test-inclusion list, the package icon and the
 *      complete SEO block.
 *
 * Package NAMES are duplicated across hospital variants — there is a Kolkata
 * "Complete Cardiac Care" at Rs. 5500 and a Raipur one at Rs. 3700 — so `slug`
 * is the key throughout and `name` is never used for identity or joining.
 *
 * THE "N PARAMETER" COUNT ONLY EXISTS FOR 15 OF THE 35. The other 20 — all 15
 * `-raipur` variants plus cancer-screening-male/female, renal-screening,
 * care-of-senior-citizen and gold-health-checkup — have no count anywhere on
 * the public site: their listing card jumps straight from <h3> to <ul> with no
 * <p> in between, WP REST returns `acf: []` for the CPT so the field is not
 * exposed, the detail page's own body never carries one, and the MonsterInsights
 * `dataLayer_content` "short-description" blob (which does hold it for the other
 * 15) is absent for these. It is a content gap in the CMS, not a parse failure,
 * so `parameter_count` stays null, `parameter_count_source` is null alongside it
 * and `missing_parameter_count` fires. Do not estimate it from the test list:
 * "34 Parameter" counts individual lab parameters while `tests_count` counts the
 * test GROUPS the detail page lists (34 vs 12 on complete-cardiac-care), so the
 * two are only ever ordered, never equal — hence `parameter_count_below_test_count`
 * rather than an equality check. What the listing card CAN be held to is its own
 * teaser: 3 shown + "+N More" must equal the detail page's test count, and
 * `teaser_count_mismatch` catches the 5 packages where it does not.
 *
 * CAPTURED BUT BOILERPLATE: the "Other Health Packages" strip at the foot of
 * every detail page is the same four cards on all 35 pages, in the same order
 * (complete-cardiac-care, decoding-diabetes, care-of-senior-citizen-male,
 * well-woman-health-check-up), to the point that each of those four lists
 * ITSELF among its "others". It is recorded verbatim anyway — its slugs are the
 * links the site actually renders — and flagged with
 * `other_packages_strip_is_boilerplate` / `other_packages_includes_self`. Since
 * it is a hand-authored copy of the listing card it can drift from it, so each
 * strip card's parameter count and price pair are compared back to the listing
 * and any disagreement raises `other_packages_stale`. Note its "N Parameter"
 * strings are its own four packages', never the host page's — which is why the
 * count is taken from the listing card and never from the detail page, and why
 * `tests` stays scoped to `.package-details-box`.
 *
 * The relations worth linking are computed instead, in `linkRelatedPackages`:
 * `related_packages.variants` groups on the NORMALIZED NAME, not the slug,
 * because cancer-screening-male/female are Raipur packages whose slugs carry no
 * `-raipur` suffix — suffix-stripping would group them wrongly, while name
 * normalization yields 15 clean cross-unit pairs and 5 singletons.
 * `related_packages.same_hospital` is slug-only to keep the file small; the
 * Raipur group alone has 17 members. Like `duplicate_meta_title`, both that
 * join and `other_packages_strip_is_boilerplate` are properties of the whole
 * set, so a narrowed run (`--slug`, `--limit`) resolves them over only the
 * packages it visited.
 *
 * The lead-capture form is still skipped, for the boilerplate reason the strip
 * used to be.
 *
 * NOTE on this site's SEO: health packages are markedly thinner than the other
 * content types. There is only ONE ld+json block (AIOSEO's) and NO theme meta
 * block at all — a single og:title, no meta description, no keywords, no
 * twitter:url. `extractSeo`'s `no_post_specific_schema` /
 * `no_post_specific_meta` therefore fire on every package, correctly.
 * og:image is the generic site logo on all 35 because there is no theme block
 * to supply a package image; the banner .grd-box img is the only one. And
 * because <title> is templated "<Name> - ILS-hospitals" over duplicated names,
 * the Kolkata and Raipur variants ship identical titles — flagged as
 * `duplicate_meta_title` in a final pass, since that is a property of the set
 * rather than of any one page.
 *
 * Requires: axios, cheerio
 *   npm install axios cheerio
 *
 * Usage:
 *   node ils-health-package-scraper.js                   # all 35 -> ils_health_packages.json
 *   node ils-health-package-scraper.js --index-only      # just health_packages.json
 *   node ils-health-package-scraper.js --slug complete-cardiac-care --out one.json
 *   node ils-health-package-scraper.js --limit 10
 *   node ils-health-package-scraper.js --from-list health_packages.json
 *   node ils-health-package-scraper.js --from-cache      # reparse cached HTML, no network
 *   node ils-health-package-scraper.js --refresh         # re-fetch, overwrite cache
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
  extractBreadcrumbs,
  extractSeo,
} = require("./scrape-lib");

const LISTING_URL = "https://ilshospitals.com/health-packages/";
const REST_URL =
  "https://ilshospitals.com/wp-json/wp/v2/health-package?per_page=100&_fields=id,slug,link,date,modified,title";

const collapse = (s) => (s || "").replace(/\s+/g, " ").trim() || null;

/** The theme emits <img src=""> where an image is missing. */
const imgSrc = (el) => {
  const src = (el.attr("src") || "").trim();
  return src || null;
};

/** "Rs. 7500/-" / "Now at Just Rs. 5500/-" -> 7500 / 5500. */
function parsePrice(text) {
  if (!text) return null;
  const m = String(text).replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/** "+9 More" -> 9. */
function parseMoreCount(text) {
  if (!text) return null;
  const m = String(text).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

// ---------- listing page ----------

/** id -> name for the five units, from the listing's own filter dropdown. */
function parseHospitalFilter($) {
  const map = new Map();
  $("select#hospitalFilter option").each((_, el) => {
    const id = parseInt($(el).attr("value"), 10);
    const name = collapse($(el).text());
    if (Number.isFinite(id) && name) map.set(id, name);
  });
  return map;
}

/** One package card from the listing grid. */
function parseCard($, el) {
  const $card = $(el);
  const url = $card.find("a.details-btn").attr("href") || null;

  // Availability lives in the wrapper's class list: "... package hospital-341 hospital-342".
  const hospital_ids = [];
  for (const cls of ($card.attr("class") || "").split(/\s+/)) {
    const m = cls.match(/^hospital-(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (!hospital_ids.includes(id)) hospital_ids.push(id);
    }
  }

  // The "N Parameter" line is a bare <p> and is absent on 20 of the 35 cards.
  let parameter_count = null;
  $card.find(".card > p, .card p").each((_, p) => {
    if (parameter_count != null) return;
    const t = collapse($(p).text()) || "";
    const m = t.match(/^(\d+)\s*Parameter/i);
    if (m) parameter_count = Number(m[1]);
  });

  const original_price_text = collapse($card.find(".original-price").first().text());
  const offer_price_text = collapse($card.find(".offer-price").first().text());
  const more_tests = collapse($card.find("p.more-tests").first().text());

  return {
    name: collapse($card.find("h3").first().text()),
    slug: slugFromUrl(url),
    url,
    book_url: $card.find("a.book-btn").attr("href") || null,
    parameter_count,
    tests_preview: $card
      .find("ul li")
      .map((_, li) => collapse($(li).text()))
      .get()
      .filter(Boolean),
    more_tests,
    more_tests_count: parseMoreCount(more_tests),
    original_price: parsePrice(original_price_text),
    offer_price: parsePrice(offer_price_text),
    original_price_text,
    offer_price_text,
    currency: "INR",
    hospital_ids,
  };
}

// ---------- "Other Health Packages" strip (detail pages) ----------

/**
 * The strip at the foot of every detail page. Its cards reuse the listing
 * card's inner markup but drop the outer `package hospital-<id>` classes, so
 * they carry no availability — only a name, a slug and the price pair.
 *
 * On a detail page `section.package-section` matches this strip and nothing
 * else, but the listing uses the same class for its own grid, so the section
 * is picked by its `h2.header-title` text rather than by class alone.
 */
function parseOtherPackages($) {
  const section = $("section.package-section")
    .filter((_, el) => /other health packages/i.test(collapse($(el).find("h2.header-title").first().text()) || ""))
    .first();
  if (!section.length) return { cards: [], view_more_url: null };

  const cards = section
    .find("div.card")
    .map((position, el) => {
      const $card = $(el);
      const url = $card.find("a.details-btn").attr("href") || null;

      let parameter_count = null;
      $card.find("p").each((_, p) => {
        if (parameter_count != null) return;
        const m = (collapse($(p).text()) || "").match(/^(\d+)\s*Parameter/i);
        if (m) parameter_count = Number(m[1]);
      });

      const original_price_text = collapse($card.find(".original-price").first().text());
      const offer_price_text = collapse($card.find(".offer-price").first().text());
      const more_tests = collapse($card.find("p.more-tests").first().text());

      return {
        position,
        name: collapse($card.find("h3").first().text()),
        slug: slugFromUrl(url),
        url,
        // Unlike the listing, this strip's Book Now href carries no #booknow.
        book_url: $card.find("a.book-btn").attr("href") || null,
        parameter_count,
        tests_preview: $card
          .find("ul li")
          .map((_, li) => collapse($(li).text()))
          .get()
          .filter(Boolean),
        more_tests,
        more_tests_count: parseMoreCount(more_tests),
        original_price: parsePrice(original_price_text),
        offer_price: parsePrice(offer_price_text),
        original_price_text,
        offer_price_text,
      };
    })
    .get();

  return { cards, view_more_url: section.find("a.view-more-btn").attr("href") || null };
}

/** Returns { packages, hospitalNames }. */
async function buildIndex() {
  console.log(`[info] Fetching listing: ${LISTING_URL}`);
  const { html } = await fetchHtml(LISTING_URL, "health-packages/_listing");
  if (!html) throw new Error(`could not load ${LISTING_URL}`);

  const $ = cheerio.load(html);
  const packages = [];
  const seen = new Set();
  $("section.package-section div.package").each((_, el) => {
    const entry = parseCard($, el);
    if (!entry.slug || seen.has(entry.slug)) return;
    seen.add(entry.slug);
    packages.push(entry);
  });

  const hospitalNames = parseHospitalFilter($);
  const unassigned = packages.filter((p) => !p.hospital_ids.length).length;
  console.log(
    `[info] listing: ${packages.length} packages, ${hospitalNames.size} hospitals, ${unassigned} with no hospital assigned`
  );
  return { packages, hospitalNames };
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
 * The banner h2 reads:
 *   "Name <br> Package Price - <span>7500</span> 5500 /- INR."
 * The <span> holds the struck-through original; the offer price is the bare
 * number that follows it. Both are read from the "Package Price -" tail so a
 * digit inside the package name cannot be mistaken for a price.
 */
function parseBannerPrices($, banner) {
  const h2 = banner.find("h2").first();
  if (!h2.length) return { original: null, offer: null };
  const original = parsePrice(collapse(h2.find("span").first().text()));
  const full = collapse(h2.text()) || "";
  const tail = full.split(/Package Price\s*-\s*/i)[1] || "";
  const numbers = tail.replace(/,/g, "").match(/\d+(?:\.\d+)?/g) || [];
  // After the original, the next number is the offer price.
  let offer = null;
  if (numbers.length) {
    const idx = original != null ? numbers.findIndex((n) => Number(n) === original) : -1;
    const rest = idx >= 0 ? numbers.slice(idx + 1) : numbers;
    offer = rest.length ? Number(rest[0]) : Number(numbers[numbers.length - 1]);
  }
  return { original, offer };
}

/** id -> {published_date, modified_date} from the WP REST collection. */
async function loadRestDates() {
  const dates = new Map();
  for (let page = 1; page <= 20; page++) {
    const { data } = await fetchJson(`${REST_URL}&page=${page}`, `api/health-package-p${page}`);
    if (!Array.isArray(data) || !data.length) break;
    for (const d of data) dates.set(d.id, { published_date: d.date || null, modified_date: d.modified || null });
    if (data.length < 100) break;
  }
  if (dates.size) console.log(`[info] REST dates for ${dates.size} packages`);
  else console.warn("[warn] REST dates unavailable, falling back to article:* meta.");
  return dates;
}

function scrapePackage(html, entry, refs) {
  const { hospitalNames, restDates, listingBySlug } = refs;
  const $ = cheerio.load(html);
  const url = entry.url;
  const data_issues = [];

  // WP stamps the post id on <body class="... postid-933 ...">.
  const classMatch = ($("body").attr("class") || "").match(/\bpostid-(\d+)\b/);
  const id = classMatch ? Number(classMatch[1]) : null;

  const banner = $("section.page-banner").first();
  const icon = imgSrc(banner.find(".grd-box img").first());
  if (!icon) data_issues.push("missing_icon");

  // The banner h2 mixes the name and the price pair; the listing card is the
  // cleaner source for the name, so it wins.
  const name = entry.name || collapse(banner.find("h2").first().text());
  const bannerPrices = parseBannerPrices($, banner);

  const body = $(".center-details.dtls-treatment").first();
  const description = normalizeHtmlWhitespace(body.length ? body.html().trim() : null) || null;
  const description_text = collapse(body.text());
  if (!description) data_issues.push("empty_description");

  // Full test list. Scoped to .package-details-box so the "Other Health
  // Packages" strip's own <ul>s cannot leak in.
  const detailsBox = $(".package-details-box").first();
  const tests_label = collapse(detailsBox.find("span").first().text());
  const tests = detailsBox
    .find("ul li")
    .map((_, li) => collapse($(li).text()))
    .get()
    .filter(Boolean);
  if (!tests.length) data_issues.push("no_tests_listed");

  // ---- hospitals: from the listing card, the only place they exist ----
  const hospitals = entry.hospital_ids.map((hid) => ({ id: hid, name: hospitalNames.get(hid) || null }));
  if (!hospitals.length) data_issues.push("no_hospital_assigned");
  if (hospitals.some((h) => !h.name)) data_issues.push("unknown_hospital_id");

  // ---- the "Other Health Packages" strip ----
  const { cards: other_health_packages, view_more_url } = parseOtherPackages($);
  const other_health_packages_slugs = other_health_packages.map((c) => c.slug).filter(Boolean);
  if (other_health_packages_slugs.includes(entry.slug)) data_issues.push("other_packages_includes_self");
  // The strip is a hand-maintained copy of the listing card, so it can drift
  // away from it. Compared, never reconciled.
  for (const card of other_health_packages) {
    const src = listingBySlug ? listingBySlug.get(card.slug) : null;
    if (!src) continue;
    if (
      card.parameter_count !== src.parameter_count ||
      card.original_price !== src.original_price ||
      card.offer_price !== src.offer_price
    ) {
      data_issues.push("other_packages_stale");
      break;
    }
  }

  // `parameter_count` counts individual lab parameters; `tests.length` counts
  // the test GROUPS the detail page lists (34 vs 12 on complete-cardiac-care),
  // so the two are never expected to be equal — only ordered.
  if (entry.parameter_count == null) data_issues.push("missing_parameter_count");
  else if (tests.length && entry.parameter_count < tests.length) data_issues.push("parameter_count_below_test_count");

  // The listing card promises "3 shown + N more"; the detail page must deliver
  // exactly that many.
  const teaser_total =
    entry.more_tests_count != null ? (entry.tests_preview || []).length + entry.more_tests_count : null;
  if (teaser_total != null && tests.length && teaser_total !== tests.length) data_issues.push("teaser_count_mismatch");

  const discount_amount =
    entry.original_price != null && entry.offer_price != null ? entry.original_price - entry.offer_price : null;
  const discount_percent =
    discount_amount != null && entry.original_price ? Math.round((discount_amount / entry.original_price) * 1000) / 10 : null;

  if (
    (bannerPrices.original != null && entry.original_price != null && bannerPrices.original !== entry.original_price) ||
    (bannerPrices.offer != null && entry.offer_price != null && bannerPrices.offer !== entry.offer_price)
  ) {
    data_issues.push("banner_price_mismatch");
  }

  // ---- SEO ----
  const seo = extractSeo($, url);
  const meta = seo.meta_all;

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
  seo.breadcrumbs = extractBreadcrumbs(seo.json_ld);
  seo.article_published_time = resolveLast(meta, "article:published_time");
  seo.article_modified_time = resolveLast(meta, "article:modified_time");

  // Package-specific defects, layered on top of extractSeo's own list.
  // `duplicate_meta_title` is appended later, in the cross-record pass.
  const issues = [...seo.seo_issues];
  if (!seo.meta_description) issues.push("missing_meta_description");
  if (!seo.keywords) issues.push("missing_keywords");
  // These pages ship a single meta block; a second og:title would mean a theme
  // block is present, as on department/doctor/procedure pages.
  if (meta.filter((m) => m.key.toLowerCase() === "og:title").length < 2) issues.push("no_theme_meta_block");
  if (seo.og.image && /\/logo\.[a-z]+$/i.test(seo.og.image)) issues.push("og_image_generic_logo");
  for (const k of [
    "no_hospital_assigned",
    "missing_icon",
    "empty_description",
    "no_tests_listed",
    "missing_parameter_count",
    "parameter_count_below_test_count",
    "teaser_count_mismatch",
    "other_packages_includes_self",
    "other_packages_stale",
    "banner_price_mismatch",
  ]) {
    if (data_issues.includes(k)) issues.push(k);
  }
  seo.seo_issues = issues;

  const rest = restDates.get(id) || {};

  return {
    id,
    name,
    slug: entry.slug,
    url,
    book_url: entry.book_url || null,
    icon,
    breadcrumb: extractVisibleBreadcrumb($, banner),
    hospitals,
    hospital_ids: entry.hospital_ids,
    original_price: entry.original_price,
    offer_price: entry.offer_price,
    original_price_text: entry.original_price_text,
    offer_price_text: entry.offer_price_text,
    discount_amount,
    discount_percent,
    currency: entry.currency || "INR",
    banner_price_original: bannerPrices.original,
    banner_price_offer: bannerPrices.offer,
    parameter_count: entry.parameter_count,
    // Explicit provenance: null means the site publishes no count for this
    // package anywhere, not that the parse failed. See the header comment.
    parameter_count_source: entry.parameter_count != null ? "listing_card" : null,
    tests_preview: entry.tests_preview || [],
    more_tests: entry.more_tests || null,
    more_tests_count: entry.more_tests_count != null ? entry.more_tests_count : null,
    tests,
    tests_count: tests.length,
    tests_label,
    other_health_packages,
    other_health_packages_slugs,
    other_health_packages_view_more_url: view_more_url,
    related_packages: null, // filled by linkRelatedPackages once the set is complete
    description,
    description_text,
    published_date: rest.published_date || seo.article_published_time || null,
    modified_date: rest.modified_date || seo.article_modified_time || null,
    seo,
    seo_issues: issues,
    data_issues,
  };
}

/**
 * Duplicate titles are a property of the whole set, not of any one page, so
 * they can only be flagged once every package has been parsed.
 */
function flagDuplicateTitles(results) {
  const counts = new Map();
  for (const p of results) {
    const t = p.seo && p.seo.meta_title;
    if (t) counts.set(t, (counts.get(t) || 0) + 1);
  }
  for (const p of results) {
    const t = p.seo && p.seo.meta_title;
    if (t && counts.get(t) > 1) {
      p.seo_issues.push("duplicate_meta_title");
      p.seo.seo_issues = p.seo_issues;
    }
  }
}

/**
 * The site's own "Other Health Packages" strip is the same four cards on every
 * page, so it links nothing useful. These are the relations that do exist,
 * resolved from the finished set:
 *
 *   variants      — the same package sold at another unit, at another price.
 *   same_hospital — everything else sold at a unit this package is sold at.
 *
 * Keyed on the NORMALIZED NAME, not the slug: `cancer-screening-male` and
 * `cancer-screening-female` are Raipur packages whose slugs carry no `-raipur`
 * suffix, so stripping the suffix would group them wrongly. Normalizing the
 * name yields 15 clean cross-unit pairs and 5 singletons over the 35.
 */
const nameKey = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

function linkRelatedPackages(results) {
  const byName = new Map();
  for (const p of results) {
    const k = nameKey(p.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(p);
  }

  for (const p of results) {
    const k = nameKey(p.name);
    const variants = (byName.get(k) || [])
      .filter((o) => o.slug !== p.slug)
      .map((o) => ({
        slug: o.slug,
        name: o.name,
        url: o.url,
        hospitals: o.hospitals,
        hospital_ids: o.hospital_ids,
        original_price: o.original_price,
        offer_price: o.offer_price,
        parameter_count: o.parameter_count,
      }));

    const variantSlugs = new Set(variants.map((v) => v.slug));
    const own = new Set(p.hospital_ids || []);
    // Slugs only: the 17-package Raipur group would otherwise bloat the file.
    const same_hospital = own.size
      ? results
          .filter(
            (o) =>
              o.slug !== p.slug && !variantSlugs.has(o.slug) && (o.hospital_ids || []).some((id) => own.has(id))
          )
          .map((o) => o.slug)
      : [];

    p.related_packages = { name_key: k, variants, same_hospital };
  }
}

/**
 * The strip being identical everywhere is a property of the set, so it can only
 * be asserted once every page has been parsed.
 */
function flagBoilerplateStrip(results) {
  const withStrip = results.filter((p) => p.other_health_packages_slugs.length);
  if (withStrip.length < 2) return;
  const first = withStrip[0].other_health_packages_slugs.join("|");
  if (!withStrip.every((p) => p.other_health_packages_slugs.join("|") === first)) return;
  for (const p of withStrip) {
    p.seo_issues.push("other_packages_strip_is_boilerplate");
    p.data_issues.push("other_packages_strip_is_boilerplate");
    p.seo.seo_issues = p.seo_issues;
  }
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    out: "ils_health_packages.json",
    indexOut: "health_packages.json",
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

  // The hospital filter map only exists on the listing page, so it is always
  // parsed even when the package list itself comes from --from-list.
  const { packages, hospitalNames } = await buildIndex();

  let list = packages;
  if (fromList) {
    list = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), fromList), "utf-8"));
    console.log(`[info] package list from ${fromList}: ${list.length} entries`);
  } else {
    const indexPath = path.resolve(process.cwd(), indexOut);
    fs.writeFileSync(indexPath, JSON.stringify(packages, null, 2), "utf-8");
    console.log(`[done] Index: ${packages.length} packages -> ${indexPath}`);
  }

  if (indexOnly) return;

  if (slug) list = list.filter((p) => p.slug === slug);
  if (limit) list = list.slice(0, limit);
  if (!list.length) {
    console.error("[error] no packages matched.");
    process.exit(1);
  }

  // The listing cards, keyed by slug, so the "Other Health Packages" strip on
  // each detail page can be compared against the source it was copied from.
  const listingBySlug = new Map(packages.map((p) => [p.slug, p]));
  const refs = { hospitalNames, restDates: await loadRestDates(), listingBySlug };

  const results = [];
  let done = 0;
  for (const entry of list) {
    done += 1;
    console.log(`[info] (${done}/${list.length}) Fetching package: ${entry.url}`);
    const { html, fromCache: cached } = await fetchHtml(entry.url, `health-packages/${entry.slug}`);
    if (!html) {
      console.error(`  [error] no HTML for ${entry.url}`);
      continue;
    }
    try {
      results.push(scrapePackage(html, entry, refs));
    } catch (e) {
      console.error(`  [error] failed to parse ${entry.url}: ${e.message}`);
    }
    if (!cached) await sleep(REQUEST_DELAY_MS);
  }

  flagDuplicateTitles(results);
  flagBoilerplateStrip(results);
  linkRelatedPackages(results);

  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");

  // Summary of the SEO defects this run observed, so problems stay visible.
  const tally = {};
  for (const p of results) for (const k of p.seo_issues || []) tally[k] = (tally[k] || 0) + 1;
  const noHospital = results.filter((p) => !p.hospitals.length).length;
  const noDesc = results.filter((p) => !p.description).length;
  console.log(`[done] Scraped ${results.length}/${list.length} packages -> ${outPath}`);
  if (noHospital) console.log(`[warn] ${noHospital} packages had no hospital assigned`);
  if (noDesc) console.log(`[warn] ${noDesc} packages had no description`);
  console.log("[seo]  issue tally:", tally);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
