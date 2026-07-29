#!/usr/bin/env node
/**
 * ILS Hospitals About Us Scraper (Members & Awards) (Node.js)
 * ---------------------------------------------------------------
 * Separately extracts Leadership Team / Members Data and Awards & Accreditations
 * from:
 *   - https://ilshospitals.com/about-us/
 *   - https://ilshospitals.com/accreditations-awards/ (discovered via sitemap)
 *   - https://ilshospitals.com/investor/board-of-directors/
 *   - WP REST API endpoints:
 *       /wp-json/wp/v2/leadership-team
 *       /wp-json/wp/v2/award
 *   - https://ilshospitals.com/sitemap/ (HTML & XML audit)
 *
 * OUTPUT FILES:
 *   - ils_members.json   (Array of leadership/board members with bio & SEO)
 *   - ils_awards.json    (Array of awards & accreditations with image & SEO)
 *   - ils_about_us.json  (Combined report with page SEO, members, awards & sitemap audit)
 *
 * Usage:
 *   node ils-about-us-scraper.js                       # scrape & write all JSON files
 *   node ils-about-us-scraper.js --from-cache          # reparse cached HTML, no network
 *   node ils-about-us-scraper.js --refresh             # re-fetch, overwrite cache
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

const ABOUT_URL = "https://ilshospitals.com/about-us/";
const AWARDS_URL = "https://ilshospitals.com/accreditations-awards/";
const BOARD_URL = "https://ilshospitals.com/investor/board-of-directors/";
const SITEMAP_URL = "https://ilshospitals.com/sitemap/";
const SITEMAP_XML = "https://ilshospitals.com/sitemap.xml";

const REST_LEADERS =
  "https://ilshospitals.com/wp-json/wp/v2/leadership-team?per_page=100&_fields=id,slug,link,date,modified,title";
const REST_AWARDS =
  "https://ilshospitals.com/wp-json/wp/v2/award?per_page=100&_fields=id,slug,link,date,modified,title";

const SITE_ORIGIN = "https://ilshospitals.com";

const collapse = (s) => (s || "").replace(/\s+/g, " ").trim() || null;

function absoluteUrl(href) {
  if (!href) return null;
  const h = href.trim();
  if (!h || h === "#" || h.startsWith("javascript:")) return null;
  if (/^(mailto:|tel:)/i.test(h)) return h;
  try {
    return new URL(h, SITE_ORIGIN).href;
  } catch (e) {
    return h;
  }
}

// ---------------- Members Extraction ----------------

async function scrapeMembers() {
  console.log("[info] Scraping Members Data...");
  const { html: aboutHtml } = await fetchHtml(ABOUT_URL, "about-us/index");
  const { data: restLeaders } = await fetchJson(REST_LEADERS, "api/leadership-team");

  const members = [];
  const seenNames = new Set();

  if (aboutHtml) {
    const $ = cheerio.load(aboutHtml);
    $(".leadership-team-sec .team-box").each((_, el) => {
      const $c = $(el);
      const name = collapse($c.find(".details-box p").first().text());
      const designation = collapse($c.find(".details-box small").first().text());
      const image = absoluteUrl($c.find(".image-box img").attr("src"));
      const modalId = $c.find("a[data-bs-target]").attr("data-bs-target");

      let bio = null;
      let bioHtml = null;
      if (modalId) {
        const $m = $(modalId);
        const modalPs = $m.find(".modal-body p");
        if (modalPs.length > 1) {
          // Skip header p if it repeats name/designation
          bioHtml = normalizeHtmlWhitespace(modalPs.slice(1).map((_, p) => $.html(p)).get().join(""));
          bio = collapse(modalPs.slice(1).text());
        } else {
          bioHtml = normalizeHtmlWhitespace($m.find(".modal-body").html());
          bio = collapse($m.find(".modal-body").text());
        }
      }

      const slug = slugFromUrl(name);
      let restMatch = null;
      if (Array.isArray(restLeaders)) {
        restMatch = restLeaders.find(
          (r) => r.slug === slug || (name && r.title?.rendered?.includes(name))
        );
      }

      if (name && !seenNames.has(name)) {
        seenNames.add(name);
        members.push({
          id: restMatch ? restMatch.id : null,
          name,
          designation,
          image,
          bio_html: bioHtml,
          bio_text: bio,
          slug: slug || (restMatch ? restMatch.slug : null),
          detail_url: restMatch ? restMatch.link : slug ? `${SITE_ORIGIN}/leadership-team/${slug}/` : null,
          published_date: restMatch ? restMatch.date : null,
          modified_date: restMatch ? restMatch.modified : null,
          source: "about-us",
        });
      }
    });
  }

  // Also include any REST leadership items not found on /about-us/
  if (Array.isArray(restLeaders)) {
    for (const r of restLeaders) {
      const rName = collapse(r.title?.rendered);
      if (rName && !seenNames.has(rName)) {
        seenNames.add(rName);
        members.push({
          id: r.id,
          name: rName,
          designation: null,
          image: null,
          bio_html: null,
          bio_text: null,
          slug: r.slug,
          detail_url: r.link || `${SITE_ORIGIN}/leadership-team/${r.slug}/`,
          published_date: r.date || null,
          modified_date: r.modified || null,
          source: "wp-rest",
        });
      }
    }
  }

  // Visit detail pages for SEO and extra bio
  for (const m of members) {
    if (m.detail_url) {
      console.log(`[info] Fetching member detail: ${m.detail_url}`);
      const { html, fromCache: cached } = await fetchHtml(m.detail_url, `leadership-team/${m.slug}`);
      if (html) {
        const $d = cheerio.load(html);
        const seo = extractSeo($d, m.detail_url);
        m.seo = seo;
        m.seo_issues = seo.seo_issues;
      } else {
        m.seo = null;
        m.seo_issues = ["fetch_failed"];
      }
      if (!cached) await sleep(REQUEST_DELAY_MS);
    } else {
      m.seo = null;
      m.seo_issues = ["no_detail_url"];
    }
  }

  console.log(`[info] Total members scraped: ${members.length}`);
  return members;
}

// ---------------- Awards Extraction ----------------

async function scrapeAwards() {
  console.log("[info] Scraping Awards Data...");
  const { html: awardsHtml } = await fetchHtml(AWARDS_URL, "accreditations-awards/index");
  const { html: aboutHtml } = await fetchHtml(ABOUT_URL, "about-us/index");
  const { data: restAwards } = await fetchJson(REST_AWARDS, "api/award");

  const awards = [];
  const seenTitles = new Set();

  function parseAwardsFromHtml(html, sourceName) {
    if (!html) return;
    const $ = cheerio.load(html);
    $(".award-box").each((_, el) => {
      const $c = $(el);
      const title = collapse($c.find("h3, p, div, small, strong").first().text());
      const image = absoluteUrl($c.find("img").attr("src"));
      const href = absoluteUrl($c.find("a").attr("href"));
      const slug = slugFromUrl(href) || slugFromUrl(title);

      let restMatch = null;
      if (Array.isArray(restAwards)) {
        restMatch = restAwards.find(
          (r) => r.slug === slug || (title && r.title?.rendered?.includes(title))
        );
      }

      if (title && !seenTitles.has(title)) {
        seenTitles.add(title);
        awards.push({
          id: restMatch ? restMatch.id : null,
          title,
          image,
          slug: slug || (restMatch ? restMatch.slug : null),
          detail_url: restMatch ? restMatch.link : href || (slug ? `${SITE_ORIGIN}/award/${slug}/` : null),
          published_date: restMatch ? restMatch.date : null,
          modified_date: restMatch ? restMatch.modified : null,
          source: sourceName,
        });
      }
    });
  }

  // Parse from /accreditations-awards/ first (complete 26 awards) then /about-us/
  parseAwardsFromHtml(awardsHtml, "accreditations-awards");
  parseAwardsFromHtml(aboutHtml, "about-us");

  // Also include any REST awards not captured in HTML
  if (Array.isArray(restAwards)) {
    for (const r of restAwards) {
      const rTitle = collapse(r.title?.rendered);
      if (rTitle && !seenTitles.has(rTitle)) {
        seenTitles.add(rTitle);
        awards.push({
          id: r.id,
          title: rTitle,
          image: null,
          slug: r.slug,
          detail_url: r.link || `${SITE_ORIGIN}/award/${r.slug}/`,
          published_date: r.date || null,
          modified_date: r.modified || null,
          source: "wp-rest",
        });
      }
    }
  }

  // Visit detail page for SEO audit for awards that have detail pages
  for (const a of awards) {
    if (a.detail_url && a.detail_url.includes("/award/")) {
      const { html, fromCache: cached } = await fetchHtml(a.detail_url, `award/${a.slug}`);
      if (html) {
        const $d = cheerio.load(html);
        const seo = extractSeo($d, a.detail_url);
        a.seo = seo;
        a.seo_issues = seo.seo_issues;
        if (!a.image) {
          a.image = absoluteUrl($d(".entry-content img, main img").first().attr("src"));
        }
      } else {
        a.seo = null;
        a.seo_issues = ["fetch_failed"];
      }
      if (!cached) await sleep(REQUEST_DELAY_MS);
    } else {
      a.seo = null;
      a.seo_issues = ["no_detail_url"];
    }
  }

  console.log(`[info] Total awards scraped: ${awards.length}`);
  return awards;
}

// ---------------- Sitemap Audit ----------------

async function auditSitemap() {
  console.log("[info] Auditing Sitemap...");
  const { html: smHtml } = await fetchHtml(SITEMAP_URL, "sitemap/index");
  const { html: smXml } = await fetchHtml(SITEMAP_XML, "sitemap/sitemap_xml");

  const htmlLinks = [];
  if (smHtml) {
    const $ = cheerio.load(smHtml);
    $("a[href]").each((_, el) => {
      const text = collapse($(el).text());
      const href = absoluteUrl($(el).attr("href"));
      if (href && (href.includes("about") || href.includes("award") || href.includes("leadership") || href.includes("board"))) {
        htmlLinks.push({ text, href });
      }
    });
  }

  const xmlUrls = [];
  if (smXml) {
    const $ = cheerio.load(smXml, { xmlMode: true });
    $("loc").each((_, el) => {
      const u = $(el).text().trim();
      if (u.includes("about") || u.includes("award") || u.includes("leadership") || u.includes("board") || u.includes("accreditations")) {
        xmlUrls.push(u);
      }
    });
  }

  return {
    sitemap_html_url: SITEMAP_URL,
    sitemap_xml_url: SITEMAP_XML,
    relevant_html_links: htmlLinks,
    relevant_xml_urls: xmlUrls,
  };
}

// ---------------- CLI & Main ----------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    outMembers: "ils_members.json",
    outAwards: "ils_awards.json",
    outAbout: "ils_about_us.json",
    fromCache: false,
    refresh: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--out-members":
        opts.outMembers = args[++i];
        break;
      case "--out-awards":
        opts.outAwards = args[++i];
        break;
      case "--out-about":
        opts.outAbout = args[++i];
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
  const { outMembers, outAwards, outAbout, fromCache, refresh } = parseArgs();
  cacheMode.fromCache = fromCache;
  cacheMode.refresh = refresh;
  if (fromCache) console.log(`[info] --from-cache: reading HTML from ${CACHE_DIR}`);
  if (refresh) console.log("[info] --refresh: re-fetching every page");

  // Page level SEO for /about-us/
  const { html: aboutHtml } = await fetchHtml(ABOUT_URL, "about-us/index");
  const aboutSeo = aboutHtml ? extractSeo(cheerio.load(aboutHtml), ABOUT_URL) : null;

  // Page level SEO for /accreditations-awards/
  const { html: awardsHtml } = await fetchHtml(AWARDS_URL, "accreditations-awards/index");
  const awardsPageSeo = awardsHtml ? extractSeo(cheerio.load(awardsHtml), AWARDS_URL) : null;

  const members = await scrapeMembers();
  const awards = await scrapeAwards();
  const sitemapAudit = await auditSitemap();

  // Write separate members JSON
  const membersPath = path.resolve(process.cwd(), outMembers);
  fs.writeFileSync(membersPath, JSON.stringify(members, null, 2), "utf-8");
  console.log(`[done] Written ${members.length} members -> ${membersPath}`);

  // Write separate awards JSON
  const awardsPath = path.resolve(process.cwd(), outAwards);
  fs.writeFileSync(awardsPath, JSON.stringify(awards, null, 2), "utf-8");
  console.log(`[done] Written ${awards.length} awards -> ${awardsPath}`);

  // Combined report JSON
  const aboutReport = {
    page_url: ABOUT_URL,
    page_seo: aboutSeo,
    accreditations_page_url: AWARDS_URL,
    accreditations_page_seo: awardsPageSeo,
    members_count: members.length,
    members,
    awards_count: awards.length,
    awards,
    sitemap_audit: sitemapAudit,
  };

  const aboutPath = path.resolve(process.cwd(), outAbout);
  fs.writeFileSync(aboutPath, JSON.stringify(aboutReport, null, 2), "utf-8");
  console.log(`[done] Written complete About Us audit -> ${aboutPath}`);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
