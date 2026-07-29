#!/usr/bin/env node
/**
 * ILS Hospitals Publications & Conference Scraper (Node.js)
 * ---------------------------------------------------------------
 * Extracts the Publication and Conference data listed at
 *   https://ilshospitals.com/academia/publications-conference/
 * into JSON (default ils_publications.json + index publications.json).
 *
 * TWO-PASS PATTERN:
 *   pass 1: Walks the /academia/publications-conference/ hub page and WP REST
 *           /wp-json/wp/v2/academia-list to gather publication items cards.
 *           Writes the small index publications.json.
 *   pass 2: Visits each /academia-list/<slug>/ detail page for full content,
 *           banner heading, gallery images, outbound links, and full SEO extraction.
 *
 * Usage:
 *   node ils-publication-scraper.js                       # all -> ils_publications.json
 *   node ils-publication-scraper.js --slug <slug>
 *   node ils-publication-scraper.js --limit 1
 *   node ils-publication-scraper.js --from-list publications.json
 *   node ils-publication-scraper.js --index-only          # pass 1 only -> publications.json
 *   node ils-publication-scraper.js --from-cache          # reparse cached HTML, no network
 *   node ils-publication-scraper.js --refresh             # re-fetch, overwrite cache
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

const HUB_URL = "https://ilshospitals.com/academia/publications-conference/";
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

// Pass 1: load hub card enrichment
async function loadCardEnrichment() {
  const cards = [];
  const { html } = await fetchHtml(HUB_URL, "academia/publications-conference");
  if (!html) return cards;
  const $ = cheerio.load(html);

  $(".csr-sec-item").each((_, el) => {
    const $c = $(el);
    const href = $c.find('a[href*="/academia-list/"]').first().attr("href");
    const rawUrl = absoluteUrl(href);
    const slug = slugFromUrl(rawUrl);
    const title = collapse($c.find("h3").text());
    const thumbnail = absoluteUrl($c.find("img").first().attr("src"));
    const excerpt = collapse($c.find("p").text());

    if (slug || title) {
      cards.push({
        title,
        slug: slug || "unknown",
        url: rawUrl || (slug ? `${SITE_ORIGIN}/academia-list/${slug}/` : null),
        thumbnail,
        excerpt,
      });
    }
  });
  console.log(`[info] hub publications cards: ${cards.length}`);
  return cards;
}

// Pass 1: resolve list of publications to visit
async function loadPublicationList(fromList) {
  if (fromList) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), fromList), "utf-8"));
    console.log(`[info] Publication list from ${fromList}: ${raw.length} entries`);
    return raw;
  }

  const cards = await loadCardEnrichment();
  const { data: restItems } = await fetchJson(REST_URL, "api/academia-list");
  
  const pubKeywords = ["conference", "book-launch", "publication", "cbd-360", "emergencies-in-medical-practice", "test"];
  
  const list = [];
  const seenSlugs = new Set();

  for (const card of cards) {
    if (card.slug && !seenSlugs.has(card.slug)) {
      seenSlugs.add(card.slug);
      let restMatch = null;
      if (Array.isArray(restItems)) {
        restMatch = restItems.find((r) => r.slug === card.slug);
      }
      list.push({
        id: restMatch ? restMatch.id : null,
        slug: card.slug,
        url: card.url,
        title: card.title || (restMatch ? collapse(restMatch.title?.rendered) : null),
        thumbnail: card.thumbnail || null,
        excerpt: card.excerpt || null,
        published_date: restMatch ? restMatch.date : null,
        modified_date: restMatch ? restMatch.modified : null,
      });
    }
  }

  // Also include any rest item matching pubKeywords not already in hub cards
  if (Array.isArray(restItems)) {
    for (const r of restItems) {
      const isPub = pubKeywords.some((kw) => r.slug.includes(kw));
      if (isPub && !seenSlugs.has(r.slug)) {
        seenSlugs.add(r.slug);
        list.push({
          id: r.id,
          slug: r.slug,
          url: r.link || `${SITE_ORIGIN}/academia-list/${r.slug}/`,
          title: collapse(r.title?.rendered) || null,
          thumbnail: null,
          excerpt: null,
          published_date: r.date || null,
          modified_date: r.modified || null,
        });
      }
    }
  }

  console.log(`[info] Resolved ${list.length} publication entries`);
  return list;
}

// Pass 2: scrape detail page
function scrapePublicationDetail(html, entry) {
  const $ = cheerio.load(html);
  const url = entry.url;

  const bodyClass = $("body").attr("class") || "";
  const classMatch = bodyClass.match(/\bpostid-(\d+)\b/);
  const shortlink = $('link[rel="shortlink"]').attr("href") || "";
  const shortMatch = shortlink.match(/[?&]p=(\d+)/);
  const pageId = classMatch ? Number(classMatch[1]) : shortMatch ? Number(shortMatch[1]) : entry.id;

  const banner = $("section.page-banner").first();
  const title = collapse(banner.find("h2").first().text()) || entry.title || null;

  const body = $("section.csr-sec-for-page, article, main, .entry-content").first();
  const heading = collapse(body.find("h2, h1").first().text());

  const body_text_html = normalizeHtmlWhitespace(
    body
      .find("p")
      .map((_, p) => $.html(p))
      .get()
      .join("") || null
  );
  const content_text = collapse(body.find("p").text());

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
  if (!content_text) issues.push("no_body_text");
  if (!images.length) issues.push("no_images");
  seo.seo_issues = issues;

  return {
    id: pageId ?? null,
    title,
    slug: entry.slug,
    url,
    thumbnail: entry.thumbnail || null,
    excerpt: entry.excerpt || null,
    heading,
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
    out: "ils_publications.json",
    indexOut: "publications.json",
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

  let list = await loadPublicationList(fromList);
  if (slug) list = list.filter((e) => e.slug === slug);
  if (limit) list = list.slice(0, limit);
  if (!list.length) {
    console.error("[error] no publication entries matched.");
    process.exit(1);
  }

  if (!fromList) {
    const indexPath = path.resolve(process.cwd(), indexOut);
    fs.writeFileSync(indexPath, JSON.stringify(list, null, 2), "utf-8");
    console.log(`[info] pass 1: ${list.length} publication entries -> ${indexPath}`);
  }
  if (indexOnly) {
    console.log("[done] --index-only: stopping after pass 1.");
    return;
  }

  // Also scrape the hub page SEO
  const { html: hubHtml } = await fetchHtml(HUB_URL, "academia/publications-conference");
  const hubSeo = hubHtml ? extractSeo(cheerio.load(hubHtml), HUB_URL) : null;

  const items = [];
  for (const entry of list) {
    console.log(`[info] Fetching Publication detail: ${entry.url}`);
    const { html, fromCache: cached } = await fetchHtml(entry.url, `academia-list/${entry.slug}`);
    if (!html) {
      console.error(`  [error] no HTML for ${entry.url}`);
      items.push({ ...entry, seo: null, seo_issues: ["fetch_failed"] });
      continue;
    }
    try {
      items.push(scrapePublicationDetail(html, entry));
    } catch (e) {
      console.error(`  [error] failed to parse ${entry.url}: ${e.message}`);
    }
    if (!cached) await sleep(REQUEST_DELAY_MS);
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
  console.log(`[done] Scraped ${items.length} publications -> ${outPath}`);
  console.log("[seo]  issue tally:", tally);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
