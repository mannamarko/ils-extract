#!/usr/bin/env node
/**
 * ILS Hospitals Regulation-46 (LODR) Scraper (Node.js)
 * ---------------------------------------------------------------
 * Extracts the single page
 *   https://ilshospitals.com/regulation-46-of-the-lodr/
 * into a FOLDER of JSON files (like the shareholder scraper).
 *
 * WHAT THE PAGE IS. Unlike the shareholder hub, this page has no `<h2 id>`
 * section anchors and no sidebar — it is one flat `Name | Link` table inside
 * `section.faq-list-sec .investor`, listing the disclosures a company must
 * publish on its website under Regulation 46 of SEBI (LODR). Each row's link is
 * either a PDF (`/wp-content/...`) or an in-site anchor into the shareholder
 * page (e.g. `.../share-holder-information/#Business`). The page title comes
 * from the banner `<h1>` (the shared theme leaves no useful `.investor` heading).
 *
 * OUTPUT (folder, default `regulation-46/`):
 *   - disclosures.json  -> { source_url, wp_page_id, page_title,
 *                            records: [{ name, link, link_type, ext }] }
 *   - _documents.json   -> flattened link list ({ name, url, ext, is_file })
 *   - _seo.json         -> full extractSeo block
 *   - _index.json       -> manifest (counts, file list)
 *
 * SEO is simple here (one og:title, one AIOSEO ld+json, a correct
 * self-referential canonical), so shared `extractSeo` is used unchanged.
 * WP page id 10528 comes from `<body class="... page-id-10528 ...">`.
 *
 * Requires: axios, cheerio (npm install axios cheerio)
 *
 * Usage:
 *   node ils-regulation46-scraper.js                 # -> regulation-46/ (network)
 *   node ils-regulation46-scraper.js --out reg46     # custom folder
 *   node ils-regulation46-scraper.js --from-cache    # reparse cached HTML
 *   node ils-regulation46-scraper.js --refresh       # re-fetch, overwrite cache
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const { CACHE_DIR, cacheMode, fetchHtml, extractSeo } = require("./scrape-lib");

const PAGE_URL = "https://ilshospitals.com/regulation-46-of-the-lodr/";
const CACHE_KEY = "pages/regulation-46-of-the-lodr";
const SITE_ORIGIN = "https://ilshospitals.com";
const FILE_EXTS = ["pdf", "mp3", "mp4", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "csv"];

const collapse = (s) => (s || "").replace(/\s+/g, " ").trim() || null;

function absoluteUrl(href) {
  if (!href) return null;
  const h = href.trim();
  if (!h || h === "#") return null;
  if (/^(mailto:|tel:)/i.test(h)) return h;
  try {
    return new URL(h, SITE_ORIGIN).href;
  } catch (e) {
    return h;
  }
}

function extOf(url) {
  if (!url || /^(mailto:|tel:)/i.test(url)) return null;
  try {
    const m = new URL(url, SITE_ORIGIN).pathname.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : null;
  } catch (e) {
    return null;
  }
}

/** Classify a link: file / page_anchor (in-site #fragment) / external / page. */
function linkType(url) {
  if (!url) return "none";
  const ext = extOf(url);
  if (ext && FILE_EXTS.includes(ext)) return "file";
  const inSite = url.startsWith(SITE_ORIGIN);
  if (url.includes("#")) return inSite ? "page_anchor" : "external_anchor";
  return inSite ? "page" : "external";
}

function scrapePage(html) {
  const $ = cheerio.load(html);
  const idMatch = ($("body").attr("class") || "").match(/\bpage-id-(\d+)\b/);
  const wpId = idMatch ? Number(idMatch[1]) : null;
  const seo = extractSeo($, PAGE_URL);

  const pageTitle =
    collapse($("section.page-banner h1, section.page-banner h2").first().text()) ||
    seo.meta_title_resolved;

  const table = $("section.faq-list-sec .investor table").first();
  if (!table.length) throw new Error("could not find the Regulation-46 disclosures table");

  const records = [];
  table.find("tbody tr").each((_, tr) => {
    const cells = $(tr).find("td,th");
    if (!cells.length) return;
    const name = collapse($(cells[0]).text());
    // Link column: prefer an <a href>, else the cell's own text if it is a URL.
    const $linkCell = $(cells[1] || cells[0]);
    let url = absoluteUrl($linkCell.find("a[href]").first().attr("href"));
    if (!url) {
      const t = collapse($linkCell.text());
      if (t && /^https?:\/\//i.test(t)) url = t;
    }
    if (!name && !url) return;
    records.push({ name, link: url, link_type: linkType(url), ext: extOf(url) });
  });

  return { wpId, pageTitle, seo, records };
}

function writeJson(dir, name, data) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2), "utf-8");
}

function writeOutput(outDir, page) {
  fs.mkdirSync(outDir, { recursive: true });

  writeJson(outDir, "disclosures.json", {
    source_url: PAGE_URL,
    wp_page_id: page.wpId,
    page_title: page.pageTitle,
    record_count: page.records.length,
    records: page.records,
  });

  const docs = page.records
    .filter((r) => r.link)
    .map((r) => ({ name: r.name, url: r.link, ext: r.ext, is_file: r.link_type === "file" }));
  writeJson(outDir, "_documents.json", docs);
  writeJson(outDir, "_seo.json", { source_url: PAGE_URL, wp_page_id: page.wpId, ...page.seo });
  writeJson(outDir, "_index.json", {
    source_url: PAGE_URL,
    wp_page_id: page.wpId,
    page_title: page.pageTitle,
    meta_title: page.seo.meta_title_resolved,
    scraped_at: new Date().toISOString(),
    record_count: page.records.length,
    document_count: docs.length,
    file_document_count: docs.filter((d) => d.is_file).length,
    files: ["disclosures.json", "_documents.json", "_seo.json"],
  });

  return docs;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { out: "regulation-46", fromCache: false, refresh: false };
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
      default:
        break;
    }
  }
  return opts;
}

async function main() {
  const { out, fromCache, refresh } = parseArgs();
  cacheMode.fromCache = fromCache;
  cacheMode.refresh = refresh;
  if (fromCache) console.log(`[info] --from-cache: reading HTML from ${CACHE_DIR}, no network.`);
  if (refresh) console.log("[info] --refresh: re-fetching the page, overwriting cache.");

  console.log(`[info] Fetching ${PAGE_URL}`);
  const { html } = await fetchHtml(PAGE_URL, CACHE_KEY);
  if (!html) {
    console.error("[error] no HTML for the Regulation-46 page.");
    process.exit(1);
  }

  const page = scrapePage(html);
  const outDir = path.resolve(process.cwd(), out);
  const docs = writeOutput(outDir, page);

  const byType = {};
  for (const r of page.records) byType[r.link_type] = (byType[r.link_type] || 0) + 1;
  console.log(`[done] ${page.records.length} disclosures -> ${outDir}/disclosures.json`);
  console.log(`[done] ${docs.length} links (${docs.filter((d) => d.is_file).length} files) -> _documents.json`);
  console.log("[info] link types:", byType);
  if (page.seo.seo_issues && page.seo.seo_issues.length) console.log("[seo]  issues:", page.seo.seo_issues.join(", "));
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
