#!/usr/bin/env node
/**
 * ILS Hospitals ILS Times Scraper (Node.js)
 * ---------------------------------------------------------------
 * Extracts the ILS Times newsletter data listed at
 *   https://ilshospitals.com/academia/ils-times/
 * into JSON (default ils_times.json + index ils_times_index.json).
 *
 * TWO-PASS PATTERN:
 *   pass 1: Walks the /academia/ils-times/ hub page and WP REST
 *           /wp-json/wp/v2/academia-list to gather newsletter edition cards.
 *           Extracts direct PDF URLs and detail URLs.
 *           Writes index file ils_times_index.json.
 *   pass 2: Visits detail pages /academia-list/<slug>/ (where available) to extract
 *           body content, embedded press clips / images, PDF attachment links, and
 *           full SEO audit using extractSeo(). Also captures hub page SEO.
 *
 * Usage:
 *   node ils-times-scraper.js                       # all -> ils_times.json
 *   node ils-times-scraper.js --slug <slug>
 *   node ils-times-scraper.js --limit 1
 *   node ils-times-scraper.js --from-list ils_times_index.json
 *   node ils-times-scraper.js --index-only          # pass 1 only -> ils_times_index.json
 *   node ils-times-scraper.js --from-cache          # reparse cached HTML, no network
 *   node ils-times-scraper.js --refresh             # re-fetch, overwrite cache
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

const HUB_URL = "https://ilshospitals.com/academia/ils-times/";
const REST_URL =
  "https://ilshospitals.com/wp-json/wp/v2/academia-list?per_page=100&_fields=id,slug,link,date,modified,title";
const SITE_ORIGIN = "https://ilshospitals.com";
const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "svg", "avif"];

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

function isImageUrl(url) {
  if (!url) return false;
  try {
    const m = new URL(url, SITE_ORIGIN).pathname.match(/\.([a-z0-9]{2,5})$/i);
    return !!m && IMAGE_EXTS.includes(m[1].toLowerCase());
  } catch (e) {
    return false;
  }
}

function cleanSlug(url) {
  if (!url) return null;
  const s = slugFromUrl(url);
  if (!s) return null;
  // Handle double-nested slugs like /slug/slug/
  return s;
}

// Pass 1: load card details from hub page
async function loadCardEnrichment() {
  const cards = [];
  const { html } = await fetchHtml(HUB_URL, "academia/ils-times");
  if (!html) return cards;
  const $ = cheerio.load(html);

  $(".csr-sec-item").each((_, el) => {
    const $c = $(el);
    const title = collapse($c.find("h3").text());
    const thumbnail = absoluteUrl($c.find("img").first().attr("src"));
    const a = $c.find("a").first();
    const href = absoluteUrl(a.attr("href"));
    const linkText = collapse(a.text());
    const isDirectPdf = href && href.toLowerCase().includes(".pdf");
    
    // Extract base slug if it links to /academia-list/
    let slug = null;
    if (href && href.includes("/academia-list/")) {
      const parts = href.split("/academia-list/")[1].split("/").filter(Boolean);
      if (parts.length) slug = parts[0];
    }

    cards.push({
      title,
      thumbnail,
      link_text: linkText,
      link_url: href,
      pdf_url: isDirectPdf ? href : null,
      slug,
    });
  });
  console.log(`[info] hub ILS Times cards: ${cards.length}`);
  return cards;
}

// Pass 1: resolve full ILS Times list
async function loadTimesList(fromList) {
  if (fromList) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), fromList), "utf-8"));
    console.log(`[info] ILS Times list from ${fromList}: ${raw.length} entries`);
    return raw;
  }

  const cards = await loadCardEnrichment();
  const { data: restItems } = await fetchJson(REST_URL, "api/academia-list");

  const list = [];
  const seenTitles = new Set();

  for (const card of cards) {
    const key = card.slug || card.title;
    if (!key || seenTitles.has(key)) continue;
    seenTitles.add(key);

    let restMatch = null;
    if (Array.isArray(restItems)) {
      restMatch = restItems.find((r) => r.slug === card.slug || (card.title && r.title?.rendered?.includes(card.title)));
    }

    const detailUrl = card.slug
      ? `${SITE_ORIGIN}/academia-list/${card.slug}/`
      : card.link_url && !card.pdf_url
      ? card.link_url
      : null;

    list.push({
      id: restMatch ? restMatch.id : null,
      title: card.title || (restMatch ? collapse(restMatch.title?.rendered) : null),
      slug: card.slug || (restMatch ? restMatch.slug : slugFromUrl(card.title)),
      thumbnail: card.thumbnail || null,
      pdf_url: card.pdf_url || null,
      detail_url: detailUrl,
      hub_link_url: card.link_url || null,
      published_date: restMatch ? restMatch.date : null,
      modified_date: restMatch ? restMatch.modified : null,
    });
  }

  // Add any REST items with "ils-times" or "newsletter" in slug not present on hub
  if (Array.isArray(restItems)) {
    for (const r of restItems) {
      if ((r.slug.includes("ils-times") || r.slug.includes("newsletter")) && !list.some((l) => l.slug === r.slug)) {
        list.push({
          id: r.id,
          title: collapse(r.title?.rendered),
          slug: r.slug,
          thumbnail: null,
          pdf_url: null,
          detail_url: r.link || `${SITE_ORIGIN}/academia-list/${r.slug}/`,
          hub_link_url: r.link || null,
          published_date: r.date || null,
          modified_date: r.modified || null,
        });
      }
    }
  }

  console.log(`[info] Resolved ${list.length} ILS Times entries`);
  return list;
}

// Pass 2: scrape detail page
function scrapeTimesDetail(html, entry) {
  if (!html) {
    return {
      id: entry.id ?? null,
      title: entry.title,
      slug: entry.slug,
      thumbnail: entry.thumbnail,
      pdf_url: entry.pdf_url,
      detail_url: entry.detail_url,
      published_date: entry.published_date,
      modified_date: entry.modified_date,
      body_text: null,
      images: [],
      pdf_links: entry.pdf_url ? [entry.pdf_url] : [],
      seo: null,
      seo_issues: entry.detail_url ? ["fetch_failed"] : ["no_detail_page"],
    };
  }

  const $ = cheerio.load(html);
  const url = entry.detail_url || entry.hub_link_url;

  const bodyClass = $("body").attr("class") || "";
  const classMatch = bodyClass.match(/\bpostid-(\d+)\b/);
  const shortlink = $('link[rel="shortlink"]').attr("href") || "";
  const shortMatch = shortlink.match(/[?&]p=(\d+)/);
  const pageId = classMatch ? Number(classMatch[1]) : shortMatch ? Number(shortMatch[1]) : entry.id;

  const banner = $("section.page-banner").first();
  const title = collapse(banner.find("h2").first().text()) || entry.title || null;

  const body = $("section.csr-sec-for-page, article, main, .entry-content").first();

  const body_text_html = normalizeHtmlWhitespace(
    body
      .find("p")
      .map((_, p) => $.html(p))
      .get()
      .join("") || null
  );
  const content_text = collapse(body.find("p").text());

  const pdf_links = [];
  if (entry.pdf_url) pdf_links.push(entry.pdf_url);
  body.find('a[href*=".pdf"]').each((_, el) => {
    const href = absoluteUrl($(el).attr("href"));
    if (href && !pdf_links.includes(href)) pdf_links.push(href);
  });

  const images = [];
  body.find("img[src]").each((_, el) => {
    const src = absoluteUrl($(el).attr("src"));
    if (src) {
      images.push({
        src,
        alt: trimOrNull($(el).attr("alt")),
      });
    }
  });

  const links = [];
  const seenLinks = new Set();
  body.find("a[href]").each((_, el) => {
    const href = absoluteUrl($(el).attr("href"));
    if (href && !isImageUrl(href) && !seenLinks.has(href)) {
      seenLinks.add(href);
      links.push({ text: collapse($(el).text()), url: href });
    }
  });

  const seo = extractSeo($, url);
  if (seo.json_ld_by_source && seo.json_ld_by_source.post) {
    seo.breadcrumbs = extractBreadcrumbs(seo.json_ld_by_source.post);
  }

  const issues = seo.seo_issues.filter(
    (c) => c !== "no_post_specific_schema" && c !== "no_post_specific_meta"
  );
  if (seo.og.image && /\/logo\.[a-z]+$/i.test(seo.og.image)) issues.push("og_image_generic_logo");
  if (!pdf_links.length) issues.push("no_pdf_link");
  seo.seo_issues = issues;

  return {
    id: pageId ?? null,
    title,
    slug: entry.slug,
    thumbnail: entry.thumbnail || null,
    pdf_url: pdf_links[0] || entry.pdf_url || null,
    pdf_links,
    detail_url: entry.detail_url,
    body_html: body_text_html,
    body_text: content_text,
    image_count: images.length,
    images,
    links,
    published_date: entry.published_date || null,
    modified_date: entry.modified_date || null,
    seo,
    seo_issues: issues,
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    out: "ils_times.json",
    indexOut: "ils_times_index.json",
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
  if (fromCache) console.log(`[info] --from-cache: reading HTML from ${CACHE_DIR}`);
  if (refresh) console.log("[info] --refresh: re-fetching every page");

  let list = await loadTimesList(fromList);
  if (slug) list = list.filter((e) => e.slug === slug);
  if (limit) list = list.slice(0, limit);
  if (!list.length) {
    console.error("[error] no ILS Times entries matched.");
    process.exit(1);
  }

  if (!fromList) {
    const indexPath = path.resolve(process.cwd(), indexOut);
    fs.writeFileSync(indexPath, JSON.stringify(list, null, 2), "utf-8");
    console.log(`[info] pass 1: ${list.length} ILS Times entries -> ${indexPath}`);
  }
  if (indexOnly) {
    console.log("[done] --index-only: stopping after pass 1.");
    return;
  }

  // Also extract hub page SEO
  const { html: hubHtml } = await fetchHtml(HUB_URL, "academia/ils-times");
  const hubSeo = hubHtml ? extractSeo(cheerio.load(hubHtml), HUB_URL) : null;

  const items = [];
  for (const entry of list) {
    if (entry.detail_url) {
      console.log(`[info] Fetching ILS Times detail: ${entry.detail_url}`);
      const cacheKey = `academia-list/${entry.slug}`;
      const { html, fromCache: cached } = await fetchHtml(entry.detail_url, cacheKey);
      try {
        items.push(scrapeTimesDetail(html, entry));
      } catch (e) {
        console.error(`  [error] failed to parse ${entry.detail_url}: ${e.message}`);
        items.push(scrapeTimesDetail(null, entry));
      }
      if (!cached) await sleep(REQUEST_DELAY_MS);
    } else {
      console.log(`[info] Direct PDF entry (no detail page): ${entry.title}`);
      items.push(scrapeTimesDetail(null, entry));
    }
  }

  const result = {
    hub_url: HUB_URL,
    hub_seo: hubSeo,
    item_count: items.length,
    items,
  };

  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");

  const tally = {};
  for (const e of items) for (const k of e.seo_issues || []) tally[k] = (tally[k] || 0) + 1;
  console.log(`[done] Scraped ${items.length} ILS Times editions -> ${outPath}`);
  console.log("[seo]  issue tally:", tally);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
