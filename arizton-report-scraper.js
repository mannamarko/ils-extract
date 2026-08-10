#!/usr/bin/env node
/**
 * Arizton "Existing & Upcoming Data Center Portfolio" Report Scraper (Node.js)
 * ---------------------------------------------------------------------------
 * Extracts the 57 reports listed at
 *   https://www.arizton.com/market-reports/category/all-reports?search=Existing%20&%20Upcoming
 * into JSON (default arizton_reports.json + the small index
 * arizton_report_index.json). Unrelated site to the ils-*-scraper.js family
 * (arizton.com, not ilshospitals.com) but reuses scrape-lib.js's fetch/cache
 * plumbing, which is site-agnostic. No SEO/JSON-LD audit is done here — that
 * apparatus is ILS-specific and out of scope for this request.
 *
 * TWO-PASS PATTERN. Both the listing and the detail pages are server-rendered
 * Next.js HTML (no JS execution needed).
 *   pass 1  walk `?search=Existing%20&%20Upcoming&page=N` (N = 1..total pages,
 *           read from the page's own "(page X of Y)" header text), parsing
 *           each `div.rpt-rltd-item` card for slug/title/listing price/listing
 *           published date. Writes the small index file.
 *   pass 2  visit each `/market-reports/<slug>` detail page for the full
 *           record: the `Report` ld+json block (canonical name/offers), the
 *           four stat icons (existing/upcoming/operators + country-or-city),
 *           and the intro/coverage text from the "ABOUT THE REPORT" tab.
 *
 * THE 4TH STAT ICON IS THE RELIABLE country_count/city_count SIGNAL, not the
 * free-text coverage bullet (whose phrasing is inconsistent: "Coverage of
 * <cities>" for single-country reports, but either "Coverage of <countries>"
 * OR "Countries covered: <countries>" for multi-country ones). The icon is
 * either `datacenter-country.png` + "N countries" (multi-country reports:
 * Nordics, Europe, MENA, Africa, ...) or `number-of-cities.webp` + "N No. of
 * Cities" (single-country reports). Per that signal: single-country reports
 * get country_count=1 + city_count=N; multi-country reports get their real
 * country_count and city_count=null.
 *
 * SITE DEFECT, RECORDED NOT WORKED AROUND: MENA's stat icon says "11 No. of
 * Cities" (the single-country icon) even though its own coverage bullet reads
 * "Countries covered: Bahrain, Egypt, ... UAE" (11 *countries*) — a mislabeled
 * icon, not a parsing bug. Detected by the coverage bullet's raw text
 * containing "countr" while the stat block only carries a city icon; when that
 * happens the record trusts the text (country_count = the bullet's own count,
 * city_count = null) and is flagged `city_country_label_mismatch` rather than
 * silently inheriting the site's wrong label.
 *
 * CONTENT FIELD is the short intro only: the tagline `<h2>` + intro `<p>` +
 * coverage `<ol>` inside the first `.rpt-tab-content__section` of the "ABOUT
 * THE REPORT" tab — not the much longer market-commentary "OVERVIEW" section
 * further down the same tab, which is out of scope per the request.
 *
 * Requires: axios, cheerio (npm install axios cheerio)
 *
 * Usage:
 *   node arizton-report-scraper.js                      # all -> arizton_reports.json
 *   node arizton-report-scraper.js --slug norway-data-center-portfolio
 *   node arizton-report-scraper.js --slug a,b,c          # comma-separated
 *   node arizton-report-scraper.js --limit 5
 *   node arizton-report-scraper.js --index-only          # pass 1 only -> arizton_report_index.json
 *   node arizton-report-scraper.js --from-cache          # reparse cached HTML, no network
 *   node arizton-report-scraper.js --refresh             # re-fetch, overwrite cache
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const { REQUEST_DELAY_MS, CACHE_DIR, cacheMode, sleep, fetchHtml } = require("./scrape-lib");

const SITE_ORIGIN = "https://www.arizton.com";
const LISTING_URL = (page) =>
  `${SITE_ORIGIN}/market-reports/category/all-reports?search=Existing%20&%20Upcoming&page=${page}`;
const TITLE_SUFFIX_RE = /\s+Existing\s*&\s*Upcoming\s+Data\s+Center\s+Portfolio\s*$/i;

const collapse = (s) => (s || "").replace(/\s+/g, " ").trim() || null;

function firstInt(text) {
  const m = (text || "").match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// ---------- pass 1: the listing pages ----------

function parseListingPage(html) {
  const $ = cheerio.load(html);
  const headerText = collapse($(".listing-head-left p").first().text()) || "";
  const totalResults = firstInt(headerText.match(/^\d+/)?.[0] ?? headerText);
  const pageMatch = headerText.match(/page\s*(\d+)\s*of\s*(\d+)/i);
  const totalPages = pageMatch ? parseInt(pageMatch[2], 10) : null;

  const cards = [];
  $("div.rpt-rltd-item").each((_, el) => {
    const $c = $(el);
    const href = $c.find(".rpt-rltd-item__txt a[href]").first().attr("href");
    if (!href) return;
    let slug;
    try {
      slug = new URL(href, SITE_ORIGIN).pathname.split("/").filter(Boolean).pop();
    } catch (e) {
      return;
    }
    const title = collapse($c.find(".rpt-rltd-item__txt h3").first().text());
    const publishedRaw = collapse($c.find(".rpt-rltd-item__txt p").first().text()) || "";
    const published_date_listing = collapse(publishedRaw.replace(/^Published\s*:/i, ""));
    const priceText = collapse($c.find(".rpt-rltd-item__price span").first().text()) || "";
    const price_listing = firstInt(priceText);

    cards.push({
      slug,
      url: new URL(`/market-reports/${slug}`, SITE_ORIGIN).href,
      title,
      published_date_listing,
      price_listing,
    });
  });

  return { cards, totalResults, totalPages };
}

async function loadReportIndex() {
  const { html: firstHtml } = await fetchHtml(LISTING_URL(1), "arizton/listing/page-1");
  if (!firstHtml) throw new Error("could not load listing page 1");
  const first = parseListingPage(firstHtml);
  const totalPages = first.totalPages || 1;
  console.log(
    `[info] listing page 1: ${first.cards.length} cards, header reports ${first.totalResults} results over ${totalPages} pages`
  );

  const bySlug = new Map(first.cards.map((c) => [c.slug, c]));
  for (let page = 2; page <= totalPages; page++) {
    const { html, fromCache } = await fetchHtml(LISTING_URL(page), `arizton/listing/page-${page}`);
    if (!html) {
      console.error(`  [error] no HTML for listing page ${page}`);
      continue;
    }
    const { cards } = parseListingPage(html);
    console.log(`[info] listing page ${page}: ${cards.length} cards`);
    for (const c of cards) bySlug.set(c.slug, c);
    if (!fromCache) await sleep(REQUEST_DELAY_MS);
  }

  const list = Array.from(bySlug.values());
  if (first.totalResults != null && list.length !== first.totalResults) {
    console.log(`[warn] parsed ${list.length} report cards but listing header says ${first.totalResults}`);
  }
  console.log(`[info] report index: ${list.length} entries`);
  return list;
}

// ---------- pass 2: a /market-reports/<slug> detail page ----------

function parseLdJson($) {
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      blocks.push(JSON.parse(raw));
    } catch (e) {
      // skip unparseable blocks; this site's ld+json is well-formed in practice
    }
  });
  return blocks;
}

function extractPrice(ldBlocks) {
  const report = ldBlocks.find((b) => b["@type"] === "Report");
  const offers = report && Array.isArray(report.offers) ? report.offers : [];
  const price = { one_time: null, yearly: null, currency: null };
  for (const offer of offers) {
    const desc = (offer.description || "").toLowerCase();
    const amount = offer.price != null ? Number(offer.price) : null;
    if (desc.includes("one time")) price.one_time = amount;
    else if (desc.includes("yearly")) price.yearly = amount;
    price.currency = price.currency || offer.priceCurrency || null;
  }
  return { price, reportName: report ? collapse(report.name) : null };
}

function extractStats($) {
  const stats = { existing_count: null, upcoming_count: null, operators_count: null, country_stat: null, city_stat: null };
  $(".rpt-intro__content-datacenterBtm .rpt-intro__content-spct").each((_, el) => {
    const $s = $(el);
    const iconSrc = $s.find("img").attr("src") || "";
    const text = collapse($s.find("p").text()) || "";
    const value = firstInt(text);
    if (iconSrc.includes("existing-datacenter")) stats.existing_count = value;
    else if (iconSrc.includes("upcoming-data-center")) stats.upcoming_count = value;
    else if (iconSrc.includes("data-center-operators")) stats.operators_count = value;
    else if (iconSrc.includes("datacenter-country")) stats.country_stat = value;
    else if (iconSrc.includes("number-of-cities")) stats.city_stat = value;
  });
  return stats;
}

function extractContentAndCoverage($) {
  const section = $(".ql-editor .rpt-tab-content__section").first();
  const tagline = collapse(section.find(".font h2").first().text());
  const introP = collapse(section.find(".font p").first().text());
  const lis = section.find("ol li");
  const bullets = lis
    .map((_, li) => collapse($(li).text()))
    .get()
    .filter(Boolean);
  const content = [tagline, introP, bullets.length ? bullets.join("; ") : null].filter(Boolean).join(" ") || null;

  const coverageRaw = lis.length ? collapse(lis.last().text()) || "" : "";
  const coverageList = coverageRaw
    .replace(/^(Coverage of|Countries covered)\s*:?/i, "")
    .split(/,| and /i)
    .map((s) => s.trim())
    .filter(Boolean);

  return { content, coverageRaw, coverageList };
}

function extractInfoFields($) {
  const info = { published_date: null, last_updated: null, edition: null, format: null };
  $(".rpt-intro__content-info p").each((_, el) => {
    const t = collapse($(el).text()) || "";
    if (/^Published Date/i.test(t)) info.published_date = collapse(t.replace(/^Published Date\s*:/i, ""));
    else if (/^format/i.test(t)) info.format = collapse(t.replace(/^format\s*:/i, ""));
    else if (/^edition/i.test(t)) info.edition = collapse(t.replace(/^edition\s*:/i, ""));
  });
  const lastUpdated = $(".lastupdatedMobileP, .lastupdated-div p").first().text();
  info.last_updated = collapse((lastUpdated || "").replace(/^Last Updated\s*:/i, "")) || info.last_updated;
  return info;
}

function scrapeReport(html, entry) {
  const $ = cheerio.load(html);
  const ldBlocks = parseLdJson($);
  const { price, reportName } = extractPrice(ldBlocks);
  const stats = extractStats($);
  const { content, coverageRaw, coverageList } = extractContentAndCoverage($);
  const info = extractInfoFields($);

  const title =
    collapse($(".rpt-tab-content__rpt-name").first().text()) || reportName || entry.title || null;
  const name = title ? collapse(title.replace(TITLE_SUFFIX_RE, "")) : null;

  const issues = [];
  let country_count = null;
  let city_count = null;
  const coverageMentionsCountries = /countr/i.test(coverageRaw);

  if (stats.country_stat != null) {
    country_count = stats.country_stat;
    city_count = null;
  } else if (stats.city_stat != null) {
    if (coverageMentionsCountries) {
      country_count = coverageList.length || stats.city_stat;
      city_count = null;
      issues.push("city_country_label_mismatch");
    } else {
      country_count = 1;
      city_count = stats.city_stat;
    }
  } else {
    issues.push("missing_geo_stat");
  }

  if (stats.country_stat != null && coverageList.length && coverageList.length !== stats.country_stat) {
    issues.push("coverage_count_mismatch");
  }
  if (city_count != null && coverageList.length && coverageList.length !== city_count) {
    issues.push("coverage_count_mismatch");
  }

  const existing_count = stats.existing_count;
  const upcoming_count = stats.upcoming_count;
  const total_facilities = existing_count != null && upcoming_count != null ? existing_count + upcoming_count : null;

  if (entry.price_listing != null && price.one_time != null && entry.price_listing !== price.one_time) {
    issues.push("listing_detail_price_mismatch");
  }

  return {
    slug: entry.slug,
    url: entry.url,
    name,
    title,
    price,
    content,
    existing_count,
    upcoming_count,
    total_facilities,
    operators_count: stats.operators_count,
    region: name,
    country_count,
    city_count,
    published_date: info.published_date || entry.published_date_listing || null,
    last_updated: info.last_updated,
    edition: info.edition,
    format: info.format,
    issues,
  };
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    out: "arizton_reports.json",
    indexOut: "arizton_report_index.json",
    limit: null,
    slugs: null,
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
        opts.slugs = args[++i].split(",").map((s) => s.trim()).filter(Boolean);
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
  const { out, indexOut, limit, slugs, indexOnly, fromCache, refresh } = parseArgs();
  cacheMode.fromCache = fromCache;
  cacheMode.refresh = refresh;
  if (fromCache) console.log(`[info] --from-cache: reading HTML from ${CACHE_DIR}, no network.`);
  if (refresh) console.log("[info] --refresh: re-fetching every page, overwriting cache.");

  let list = await loadReportIndex();
  if (slugs) list = list.filter((e) => slugs.includes(e.slug));
  if (limit) list = list.slice(0, limit);
  if (!list.length) {
    console.error("[error] no reports matched.");
    process.exit(1);
  }

  const indexPath = path.resolve(process.cwd(), indexOut);
  fs.writeFileSync(indexPath, JSON.stringify(list, null, 2), "utf-8");
  console.log(`[info] pass 1: ${list.length} report entries -> ${indexPath}`);
  if (indexOnly) {
    console.log("[done] --index-only: stopping after pass 1.");
    return;
  }

  const results = [];
  for (const entry of list) {
    console.log(`[info] Fetching report: ${entry.url}`);
    const { html, fromCache: cached } = await fetchHtml(entry.url, `arizton/reports/${entry.slug}`);
    if (!html) {
      // A card exists on the listing but its own detail page 404s (e.g.
      // portugal-data-center-portfolio redirects to /404) — a real dead link
      // on the site, not a scraper bug. Keep the record from listing-pass
      // data alone rather than silently dropping it from the 57.
      console.error(`  [error] no HTML for ${entry.url} (detail page unavailable)`);
      results.push({
        slug: entry.slug,
        url: entry.url,
        name: entry.title ? collapse(entry.title.replace(TITLE_SUFFIX_RE, "")) : null,
        title: entry.title,
        price: { one_time: entry.price_listing ?? null, yearly: null, currency: entry.price_listing != null ? "USD" : null },
        content: null,
        existing_count: null,
        upcoming_count: null,
        total_facilities: null,
        operators_count: null,
        region: entry.title ? collapse(entry.title.replace(TITLE_SUFFIX_RE, "")) : null,
        country_count: null,
        city_count: null,
        published_date: entry.published_date_listing || null,
        last_updated: null,
        edition: null,
        format: null,
        issues: ["detail_page_unavailable"],
      });
      if (!cached) await sleep(REQUEST_DELAY_MS);
      continue;
    }
    try {
      results.push(scrapeReport(html, entry));
    } catch (e) {
      console.error(`  [error] failed to parse ${entry.url}: ${e.message}`);
    }
    if (!cached) await sleep(REQUEST_DELAY_MS);
  }

  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");

  const tally = {};
  for (const e of results) for (const k of e.issues || []) tally[k] = (tally[k] || 0) + 1;
  console.log(`[done] Scraped ${results.length}/${list.length} reports -> ${outPath}`);
  console.log("[issues] tally:", tally);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
