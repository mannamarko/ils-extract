#!/usr/bin/env node
/**
 * ILS Hospitals Shareholder-Information Scraper (Node.js)
 * ---------------------------------------------------------------
 * Extracts the single investor-relations page
 *   https://ilshospitals.com/share-holder-information/
 * into a FOLDER of separate JSON files — one per section — plus the page SEO.
 *
 * Output is shaped for EASY MIGRATION: every section is parsed into clean,
 * flat domain records with named fields rather than raw table rows, e.g.
 *   earnings-call.json ->
 *     [{ quarter, earnings_presentation_link, call_invite_link,
 *        earnings_call_transcript_link, audio_link }]
 *
 * WHAT THE PAGE IS. Despite the sidebar of `a.nav-link[href="#Id"]` tabs, this
 * is NOT a tabbed UI: each tab link jumps to an inline `<h2 id="Id">` anchor.
 * All 30 sections lie flat, in document order, as direct children of
 * `section.faq-list-sec .investor`; a section is the run of nodes from one
 * `<h2 id>` to the next (`nextUntil('h2[id]')`).
 *
 * HOW SECTIONS ARE PARSED. A small per-section config (SECTIONS) declares each
 * section's shape; a handful of generic builders turn its table(s) into records:
 *   - kv        -> a single object keyed by snake-cased row labels
 *                  (ShareCapital, ListingInformation)
 *   - docs      -> [{ ...context, title, link }] one per document row
 *                  (PostalBallot, CorporatePolicies, UnpaidDividend, ...)
 *   - labeled   -> [{ <header_snake>: text, <header_snake>_link: url, ... }]
 *                  header-driven columns (EarningsCall, Dividend, Notices, ...)
 *   - grid      -> [{ financial_year, quarter, link, ... }] one per grid cell
 *                  (ShareholdingPattern, IntegratedFilings, Financials, ...)
 *   - grouped   -> the tables are split by their preceding <h3> (year /
 *                  filing_type / committee / category), grouped via a
 *                  document-order DFS because the per-group tables are nested.
 * Rich sections (Business, BoardofDirectors, Contact, ...) are modelled by hand.
 *
 * A `link` is a fully-absolutised URL; MP3/MP4 links in a cell are split out as
 * `audio_link`. Each section file also keeps a `documents` list (every link in
 * the section) and there is a master `_documents.json`.
 *
 * SEO is simple here: one og:title, one AIOSEO ld+json, a correct
 * self-referential canonical — shared `extractSeo` is used unchanged.
 * WP page id 10519 comes from `<body class="... page-id-10519 ...">`.
 *
 * Requires: axios, cheerio (npm install axios cheerio)
 *
 * Usage:
 *   node ils-shareholder-scraper.js                 # -> shareholder/ (network)
 *   node ils-shareholder-scraper.js --out invest    # write to invest/
 *   node ils-shareholder-scraper.js --from-cache    # reparse cached HTML
 *   node ils-shareholder-scraper.js --refresh       # re-fetch, overwrite cache
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const { CACHE_DIR, cacheMode, normalizeHtmlWhitespace, fetchHtml, extractSeo } = require("./scrape-lib");

const PAGE_URL = "https://ilshospitals.com/share-holder-information/";
const CACHE_KEY = "pages/share-holder-information";
const SITE_ORIGIN = "https://ilshospitals.com";
const FILE_EXTS = ["pdf", "mp3", "mp4", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "csv"];
const AUDIO_EXTS = ["mp3", "mp4", "wav", "m4a"];
const EMPTY_CELL = new Set(["", "-", "–", "—", "na", "n/a", "nil"]);

// ---------- small helpers ----------

const collapse = (s) => (s || "").replace(/\s+/g, " ").trim() || null;

/** A header/label -> snake_case field name. "Q 1" -> "q1". */
function snake(s) {
  let out = (s || "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  out = out.replace(/^q_(\d)$/, "q$1"); // "Q 1" -> "q1"
  return out;
}

/** "AnnualGeneralMeeting" -> "annual-general-meeting"; "CSR" -> "csr". */
function kebab(id) {
  return (id || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function absoluteUrl(href) {
  if (!href) return null;
  const h = href.trim();
  if (!h || h.startsWith("#")) return null;
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

/** Every <a href> inside a node -> {label, url, ext, is_file, is_audio, external}. */
function linksIn($, node) {
  const out = [];
  node.find("a[href]").each((_, a) => {
    const $a = $(a);
    const url = absoluteUrl($a.attr("href"));
    if (!url) return;
    const ext = extOf(url);
    out.push({
      label: collapse($a.text()) || collapse($a.attr("title")),
      url,
      ext,
      is_file: !!ext && FILE_EXTS.includes(ext),
      is_audio: !!ext && AUDIO_EXTS.includes(ext),
      external: /^https?:/i.test(url) && !url.startsWith(SITE_ORIGIN),
    });
  });
  return out;
}

/** First document-ish link in a set: prefer a file, then any http link. */
function primaryLink(links, { externalOk = false } = {}) {
  const file = links.find((l) => l.is_file && !l.is_audio) || links.find((l) => l.is_file);
  if (file) return file.url;
  if (externalOk) {
    const ext = links.find((l) => /^https?:/i.test(l.url));
    if (ext) return ext.url;
  }
  return null;
}

// ---------- table readers ----------

function tableHeaders($, table) {
  const h = [];
  $(table)
    .find("thead tr")
    .first()
    .find("th,td")
    .each((_, c) => h.push(collapse($(c).text())));
  return h;
}

/** Body rows as [{ text, links }] cells. */
function tableRows($, table) {
  const rows = [];
  $(table)
    .find("tbody tr")
    .each((_, tr) => {
      const cells = [];
      $(tr)
        .find("td,th")
        .each((_, td) => cells.push({ text: collapse($(td).text()), links: linksIn($, $(td)) }));
      if (cells.length) rows.push(cells);
    });
  return rows;
}

/** Document-order DFS over a sibling set collecting {kind:'h'|'t'} in order. */
function orderedNodes($, sibs) {
  const out = [];
  const walk = (el) => {
    const tag = (el.tagName || "").toLowerCase();
    if (/^h[3-6]$/.test(tag)) return void out.push({ kind: "h", text: collapse($(el).text()) });
    if (tag === "table") return void out.push({ kind: "t", el });
    $(el)
      .children()
      .each((_, c) => walk(c));
  };
  sibs.each((_, e) => walk(e));
  return out;
}

/** Group tables under their nearest preceding heading -> [{ heading, tables }]. */
function groupTables($, sibs) {
  const groups = [];
  let cur = null;
  for (const n of orderedNodes($, sibs)) {
    if (n.kind === "h") {
      cur = { heading: n.text, tables: [] };
      groups.push(cur);
    } else {
      if (!cur) {
        cur = { heading: null, tables: [] };
        groups.push(cur);
      }
      cur.tables.push(n.el);
    }
  }
  return groups;
}

// ---------- record builders ----------

/** kv: 2-column rows -> one object keyed by snake(label). */
function buildKeyValue($, table) {
  const obj = {};
  for (const cells of tableRows($, table)) {
    if (cells.length < 2) continue;
    const key = snake(cells[0].text);
    if (!key) continue;
    obj[key] = cells[1].text;
    const link = primaryLink(cells[1].links, { externalOk: true });
    if (link) obj[`${key}_link`] = link;
  }
  return obj;
}

/** docs: each row -> { ...ctx, title, link }. */
function buildDocs($, table, ctx = {}, opts = {}) {
  const records = [];
  for (const cells of tableRows($, table)) {
    if (!cells.length) continue;
    const title = cells[0].text;
    const allLinks = cells.flatMap((c) => c.links);
    const link = primaryLink(allLinks, opts);
    if (!title && !link) continue;
    records.push({ ...ctx, title, link });
  }
  return records;
}

/** labeled: header-driven columns -> record per row with <field>/<field>_link. */
function buildLabeled($, table, ctx = {}) {
  const headers = tableHeaders($, table);
  const records = [];
  for (const cells of tableRows($, table)) {
    const rec = { ...ctx };
    cells.forEach((cell, i) => {
      const field = snake(headers[i] || `col_${i + 1}`) || `col_${i + 1}`;
      const files = cell.links.filter((l) => l.is_file && !l.is_audio);
      const audio = cell.links.find((l) => l.is_audio);
      const external = cell.links.filter((l) => l.external && !l.is_file);
      if (cell.text) rec[field] = cell.text;
      if (files.length) rec[`${field}_link`] = files.length === 1 ? files[0].url : files.map((f) => f.url);
      else if (external.length) rec[`${field}_link`] = external[0].url;
      if (audio) rec.audio_link = audio.url;
    });
    if (Object.keys(rec).length > Object.keys(ctx).length) records.push(rec);
  }
  return records;
}

/** grid: FY x quarter matrix -> one record per populated cell. */
function buildGrid($, table, ctx = {}, { fyInHeader = false } = {}) {
  const headers = tableHeaders($, table);
  const records = [];
  const rows = tableRows($, table);
  const fyHeader = fyInHeader ? collapse(headers[0]) : null;
  for (const cells of rows) {
    const rowLabel = cells[0] ? cells[0].text : null;
    for (let j = 1; j < cells.length; j++) {
      const cell = cells[j];
      const link = primaryLink(cell.links);
      if (!link) {
        if (!cell.text || EMPTY_CELL.has(cell.text.toLowerCase())) continue;
      }
      const rec = { ...ctx };
      if (fyInHeader) {
        rec.financial_year = fyHeader;
        if (rowLabel) rec.statement_type = rowLabel;
      } else {
        rec.financial_year = rowLabel;
      }
      rec.quarter = snake(headers[j]);
      rec.link = link;
      if (!link && cell.text) rec.note = cell.text;
      records.push(rec);
    }
  }
  return records;
}

// ---------- rich sections ----------

/** BoardofDirectors: `.team-box` cards -> [{ name, designation, photo }]. */
function parseBoard($, sibs) {
  const members = [];
  sibs.find(".team-box").each((_, box) => {
    const $b = $(box);
    const photo = absoluteUrl($b.find("img").first().attr("src"));
    const details = $b.find(".details-box");
    let name = collapse(details.find("p").first().text());
    let designation = collapse(details.find("small").first().text());
    if (!designation) {
      const dm = (collapse(details.text()) || "").match(/Designation:\s*(.+)$/i);
      if (dm) designation = collapse(dm[1]);
    }
    if (designation) {
      designation = designation.replace(/^Designation:\s*/i, "");
      if (name && name.includes(designation)) name = collapse(name.replace(designation, ""));
    }
    name = name && collapse(name.replace(/Designation:.*$/i, ""));
    if (name || photo) members.push({ name: name || null, designation: designation || null, photo });
  });
  return members;
}

/** Text nodes after an <i class="...icon"> up to the next <br>. */
function textAfterIcons($, p, iconClass) {
  const out = [];
  p.find(`i.${iconClass}`).each((_, ic) => {
    let n = ic.next;
    let t = "";
    while (n && !(n.type === "tag" && n.name === "br")) {
      if (n.type === "text") t += n.data;
      else if (n.type === "tag" && n.name !== "i") t += $(n).text();
      n = n.next;
    }
    const v = collapse(t);
    if (v) out.push(v);
  });
  return out;
}

/** Contact: role columns (with an <h3>) -> [{ role, offices:[{label,address,phones,emails}] }]. */
function parseContacts($, sibs) {
  const contacts = [];
  sibs.find("[class*='col-']").each((_, col) => {
    const $c = $(col);
    const role = collapse($c.children("h3").first().text());
    if (!role) return;
    const offices = [];
    $c.find("p.default-font").each((_, p) => {
      const $p = $(p);
      const label = collapse($p.find("b, strong").first().text());
      const emails = [];
      $p.find("a[href^='mailto:']").each((_, a) => {
        const e = ($(a).attr("href") || "").replace(/^mailto:/i, "");
        if (e && !emails.includes(e)) emails.push(e);
      });
      const phones = textAfterIcons($, $p, "fa-phone");
      const address = collapse($p.text());
      if (label || address) offices.push({ label: label || null, address, phones, emails });
    });
    contacts.push({ role, offices });
  });
  return contacts;
}

// ---------- per-section config ----------

const SECTIONS = {
  Business: { kind: "rich" },
  AnnualGeneralMeeting: { kind: "grouped", group: "year", perGroup: "agm" },
  PostalBallot: { kind: "grouped", group: "year", perGroup: "docs" },
  ShareholdingPattern: { kind: "grid" },
  ShareCapital: { kind: "kv" },
  IntegratedFilings: { kind: "grouped", group: "filing_type", perGroup: "grid" },
  EarningsCall: { kind: "labeled" },
  Dividend: { kind: "labeled" },
  UnpaidDividend: { kind: "docs", asOnFromHeader: true },
  CorporatePresentation: { kind: "docs" },
  CorporatePolicies: { kind: "docs" },
  Compliances: { kind: "grouped", group: "category", perGroup: "docs", externalOk: true },
  Notices: { kind: "labeled" },
  DisclosureInformation: { kind: "labeled" },
  SecretarialComplianceReport: { kind: "labeled" },
  AnnualReturn: { kind: "docs" },
  Codeofconduct: { kind: "docs" },
  ReportsonCorporateGovernance: { kind: "grid" },
  CreditRating: { kind: "rich" },
  CommitteesoftheBoard: { kind: "grouped", group: "committee", perGroup: "labeled" },
  BoardofDirectors: { kind: "board" },
  Stockinformation: { kind: "rich" },
  sakshamNiveshak: { kind: "labeled" },
  ListingInformation: { kind: "kv" },
  ChangeinCompanyname: { kind: "rich" },
  OnlineDisputeResolution: { kind: "labeled" },
  Financials: { kind: "grid", fyInHeader: true },
  CSR: { kind: "labeled" },
  Downloads: { kind: "labeled" },
  Contact: { kind: "contact" },
};

/** Pull an "...as on March 31, 2026" style date out of a table's first header. */
function asOnFromHeader($, table) {
  const h = tableHeaders($, table)[0] || "";
  const m = h.match(/as on\s+(.+)$/i);
  return m ? collapse(m[1]) : null;
}

/** Apply a section's config to its sibling range -> clean records/data. */
function buildRecords($, id, sibs, cfg) {
  const tables = groupTables($, sibs);
  const flatTables = tables.flatMap((g) => g.tables);

  switch (cfg.kind) {
    case "kv": {
      let obj = {};
      for (const t of flatTables) obj = { ...obj, ...buildKeyValue($, t) };
      return { data: obj };
    }
    case "docs": {
      const records = [];
      for (const t of flatTables) {
        const ctx = cfg.asOnFromHeader ? { as_on: asOnFromHeader($, t) } : {};
        records.push(...buildDocs($, t, ctx, { externalOk: cfg.externalOk }));
      }
      return { records };
    }
    case "labeled": {
      const records = [];
      for (const t of flatTables) records.push(...buildLabeled($, t));
      return { records };
    }
    case "grid": {
      const records = [];
      for (const t of flatTables) records.push(...buildGrid($, t, {}, { fyInHeader: cfg.fyInHeader }));
      return { records };
    }
    case "grouped": {
      const records = [];
      for (const g of tables) {
        if (!g.tables.length) continue;
        const heading = g.heading;
        if (cfg.perGroup === "agm") {
          // year: details KV table + documents table
          const rec = { [cfg.group]: heading };
          if (g.tables[0]) rec.details = buildKeyValue($, g.tables[0]);
          rec.documents = [];
          for (const t of g.tables.slice(1)) rec.documents.push(...buildDocs($, t));
          records.push(rec);
        } else {
          const ctx = { [cfg.group]: heading };
          for (const t of g.tables) {
            if (cfg.perGroup === "docs") records.push(...buildDocs($, t, ctx, { externalOk: cfg.externalOk }));
            else if (cfg.perGroup === "grid") records.push(...buildGrid($, t, ctx, {}));
            else if (cfg.perGroup === "labeled") records.push(...buildLabeled($, t, ctx));
          }
        }
      }
      return { records };
    }
    default:
      return {};
  }
}

// ---------- page parse ----------

function scrapePage(html) {
  const $ = cheerio.load(html);

  const idMatch = ($("body").attr("class") || "").match(/\bpage-id-(\d+)\b/);
  const wpId = idMatch ? Number(idMatch[1]) : null;
  const seo = extractSeo($, PAGE_URL);

  const inv = $("section.faq-list-sec .investor").first();
  if (!inv.length) throw new Error("could not find the .investor content container");

  const sections = [];
  inv.children("h2[id]").each((_, h2) => {
    const $h2 = $(h2);
    const id = $h2.attr("id");
    const sibs = $h2.nextUntil("h2[id]");
    const cfg = SECTIONS[id] || { kind: "rich" };

    const section = { id, slug: kebab(id), title: collapse($h2.text()), type: cfg.kind };

    // Every link in the section, for the documents list / master index.
    const documents = linksIn($, sibs).map((l) => ({ label: l.label, url: l.url, ext: l.ext, is_file: l.is_file }));
    section.documents = documents;

    if (cfg.kind === "board") {
      section.records = parseBoard($, sibs);
    } else if (cfg.kind === "contact") {
      section.records = parseContacts($, sibs);
    } else if (cfg.kind === "rich") {
      const text = collapse(sibs.text());
      section.text = text;
      section.html = normalizeHtmlWhitespace(sibs.toArray().map((e) => $.html(e)).join(""));
    } else {
      Object.assign(section, buildRecords($, id, sibs, cfg));
    }

    sections.push(section);
  });

  return { wpId, seo, sections };
}

// ---------- output ----------

function writeJson(dir, name, data) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2), "utf-8");
}

function writeOutput(outDir, page) {
  fs.mkdirSync(outDir, { recursive: true });

  for (const s of page.sections) writeJson(outDir, `${s.slug}.json`, s);

  const allDocs = [];
  for (const s of page.sections) {
    for (const d of s.documents || []) allDocs.push({ section: s.title, section_slug: s.slug, ...d });
  }
  writeJson(outDir, "_documents.json", allDocs);
  writeJson(outDir, "_seo.json", { source_url: PAGE_URL, wp_page_id: page.wpId, ...page.seo });

  const recordCount = (s) => (Array.isArray(s.records) ? s.records.length : s.data ? 1 : 0);
  writeJson(outDir, "_index.json", {
    source_url: PAGE_URL,
    wp_page_id: page.wpId,
    meta_title: page.seo.meta_title_resolved,
    scraped_at: new Date().toISOString(),
    section_count: page.sections.length,
    document_count: allDocs.length,
    file_document_count: allDocs.filter((d) => d.is_file).length,
    sections: page.sections.map((s) => ({
      id: s.id,
      slug: s.slug,
      title: s.title,
      type: s.type,
      file: `${s.slug}.json`,
      record_count: recordCount(s),
      document_count: (s.documents || []).length,
    })),
  });

  return allDocs;
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { out: "shareholder", fromCache: false, refresh: false };
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
    console.error("[error] no HTML for the shareholder page.");
    process.exit(1);
  }

  const page = scrapePage(html);
  const outDir = path.resolve(process.cwd(), out);
  const allDocs = writeOutput(outDir, page);

  console.log(`[done] Wrote ${page.sections.length} section files -> ${outDir}/`);
  console.log(`[done] ${allDocs.length} links captured (${allDocs.filter((d) => d.is_file).length} files) -> _documents.json`);
  if (page.seo.seo_issues && page.seo.seo_issues.length) console.log("[seo]  issues:", page.seo.seo_issues.join(", "));
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
