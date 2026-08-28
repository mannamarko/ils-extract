#!/usr/bin/env node
/**
 * Live-vs-local SEO audit.
 * ------------------------
 * Sweeps a list of page URLs against both https://ilshospitals.com and the
 * local Next.js frontend, and writes a CSV where every row carries the page's
 * category, both sides' reachability (status, redirect chain, final URL) and a
 * per-field verdict on whether its meta tags and JSON-LD match live.
 *
 * This replaces two hand-run sweeps that only survived as prose in
 * ils-frontend/docs/sitemap-audit.md — the sitemap 404 check is folded in here
 * rather than kept as a separate tool, since it is the same fetch.
 *
 *   node ils-live-vs-local-audit.js                       # 1,158 URLs from the xlsx
 *   node ils-live-vs-local-audit.js --source both         # union with the sitemap
 *   node ils-live-vs-local-audit.js --only "Doctor Lists" --limit 25
 *   node ils-live-vs-local-audit.js --skip-seo            # status-only 404 sweep
 *   node ils-live-vs-local-audit.js --from-cache          # re-report, no network
 *
 * Concurrency defaults are deliberately modest: a previous 12-way sweep crashed
 * `next dev`'s on-demand compiler partway through, so the local side runs at 3.
 */
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const { extractSeo, extractJsonLdSchemas } = require("./scrape-lib");
const { readColumn } = require("./lib/xlsx-read");
const { probe, mapLimit } = require("./lib/probe");
const {
  FIELDS,
  compareMeta,
  compareSchema,
  typesOf,
} = require("./lib/seo-compare");

const DEFAULTS = {
  source: "xlsx",
  xlsx: path.resolve(__dirname, "..", "ILS Hospitals Sitemap URLS.xlsx"),
  sitemap: path.resolve(__dirname, "ils_sitemap.json"),
  live: "https://ilshospitals.com",
  local: "http://localhost:3000",
  out: null,
  only: null,
  limit: 0,
  concurrencyLive: 4,
  concurrencyLocal: 3,
  refresh: false,
  fromCache: false,
  skipSeo: false,
  printPlan: false,
  failOnRegression: false,
  urls: [],
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const next = (i) => argv[i + 1];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--source":
        opts.source = next(i++);
        break;
      // Repeatable, and bypasses the list sources — for spot-checking one page.
      case "--url":
        opts.urls.push(next(i++));
        break;
      case "--xlsx":
        opts.xlsx = path.resolve(next(i++));
        break;
      case "--sitemap":
        opts.sitemap = path.resolve(next(i++));
        break;
      case "--live":
        opts.live = next(i++).replace(/\/+$/, "");
        break;
      case "--local":
        opts.local = next(i++).replace(/\/+$/, "");
        break;
      case "--out":
        opts.out = path.resolve(next(i++));
        break;
      case "--only":
        opts.only = next(i++)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--limit":
        opts.limit = Number(next(i++)) || 0;
        break;
      case "--concurrency-live":
        opts.concurrencyLive = Number(next(i++)) || 4;
        break;
      case "--concurrency-local":
        opts.concurrencyLocal = Number(next(i++)) || 3;
        break;
      case "--refresh":
        opts.refresh = true;
        break;
      case "--from-cache":
        opts.fromCache = true;
        break;
      case "--skip-seo":
        opts.skipSeo = true;
        break;
      case "--print-plan":
        opts.printPlan = true;
        break;
      case "--fail-on-regression":
        opts.failOnRegression = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`unknown flag: ${arg}`);
    }
  }

  if (!["xlsx", "sitemap", "both"].includes(opts.source)) {
    throw new Error(
      `--source must be xlsx, sitemap or both (got "${opts.source}")`,
    );
  }
  return opts;
}

const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

const canonicalKey = (url) => {
  const p = pathOf(url);
  return p.endsWith("/") ? p : `${p}/`;
};

/**
 * Categories come from the scraped sitemap so the report groups pages the same
 * way ils-frontend/docs/sitemap-page-status.md does. The xlsx carries 54 URLs
 * the sitemap never listed (/disease/*, /blog/*, a stray doctor); those fall
 * back to their first path segment so nothing lands in an unlabelled bucket.
 */
function buildCategoryIndex(sitemapFile) {
  const index = new Map();
  let order = [];

  try {
    const data = JSON.parse(fs.readFileSync(sitemapFile, "utf-8"));
    for (const entry of data.entries_flat || []) {
      index.set(canonicalKey(entry.url), entry.category);
    }
    order = [...new Set((data.entries_flat || []).map((e) => e.category))];
  } catch (e) {
    console.warn(
      `! could not read ${sitemapFile} (${e.message}); falling back to path segments`,
    );
  }

  const categorize = (url) => {
    const known = index.get(canonicalKey(url));
    if (known) return known;
    const segment = canonicalKey(url).split("/").filter(Boolean)[0];
    return segment ? `Uncategorized (${segment})` : "Uncategorized (home)";
  };

  return { categorize, order, has: (url) => index.has(canonicalKey(url)) };
}

function loadUrls(opts, categories) {
  const rows = new Map();

  const add = (url, key) => {
    const clean = String(url || "").trim();
    if (!/^https?:\/\//i.test(clean)) return;
    const id = canonicalKey(clean);
    const row = rows.get(id) || {
      url: clean,
      path: id,
      inXlsx: false,
      inSitemap: false,
    };
    row[key] = true;
    rows.set(id, row);
  };

  // An explicit --url list replaces the file sources entirely.
  if (opts.urls.length) {
    for (const value of opts.urls) {
      add(
        /^https?:\/\//i.test(value)
          ? value
          : `${opts.live}${value.startsWith("/") ? "" : "/"}${value}`,
        "inXlsx",
      );
    }
  }

  if (!opts.urls.length && (opts.source === "xlsx" || opts.source === "both")) {
    for (const value of readColumn(opts.xlsx, "A")) add(value, "inXlsx");
  }

  if (
    !opts.urls.length &&
    (opts.source === "sitemap" || opts.source === "both")
  ) {
    const data = JSON.parse(fs.readFileSync(opts.sitemap, "utf-8"));
    for (const entry of data.entries_flat || []) add(entry.url, "inSitemap");
  }

  // Mark sitemap membership even when only the xlsx was loaded, so the CSV can
  // show which URLs the site's own sitemap does not list.
  for (const row of rows.values())
    if (categories.has(row.url)) row.inSitemap = true;

  let list = [...rows.values()].map((row) => ({
    ...row,
    category: categories.categorize(row.url),
  }));

  if (opts.only) list = list.filter((row) => opts.only.includes(row.category));

  const rank = new Map(categories.order.map((name, i) => [name, i]));
  list.sort((a, b) => {
    const byCategory =
      (rank.get(a.category) ?? 999) - (rank.get(b.category) ?? 999);
    return byCategory || a.path.localeCompare(b.path);
  });

  return opts.limit > 0 ? list.slice(0, opts.limit) : list;
}

/**
 * OK is the only verdict meaning "this page is fine on our side". LIVE_BROKEN
 * pages are already dead upstream, so a local 404 there is not our regression.
 */
function reachabilityVerdict(live, local) {
  const liveOk = live.status && live.status < 400;
  const localOk = local.status && local.status < 400;

  if (!liveOk && !localOk) return "BOTH_BROKEN";
  if (!liveOk) return "LIVE_BROKEN";
  if (local.status === 404) return "LOCAL_404";
  if (!localOk) return "LOCAL_ERROR";
  if (live.redirected !== local.redirected) return "LOCAL_REDIRECT_DIFFERS";
  if (
    live.redirected &&
    canonicalKey(live.finalUrl) !== canonicalKey(local.finalUrl)
  ) {
    return "LOCAL_REDIRECT_DIFFERS";
  }
  return "OK";
}

function analyse(row, live, local, opts) {
  const result = {
    ...row,
    live_status: live.status ?? "",
    live_final_url: live.finalUrl,
    live_redirected: live.redirected,
    live_hops: live.hops,
    live_error: live.error || "",
    local_status: local.status ?? "",
    local_final_url: local.finalUrl,
    local_redirected: local.redirected,
    local_hops: local.hops,
    local_error: local.error || "",
    reachability_verdict: reachabilityVerdict(live, local),
    meta: null,
    schema: null,
    notes: [],
  };

  // Only compare pages both sides actually served. Diffing a 404 or 500 error
  // page's <head> against a real one produces pure noise — the reachability
  // verdict already says everything useful about those rows.
  const bothServed =
    live.status >= 200 &&
    live.status < 300 &&
    local.status >= 200 &&
    local.status < 300;
  const comparable = bothServed && live.html && local.html;
  if (opts.skipSeo || !comparable) {
    result.overall_verdict =
      result.reachability_verdict === "OK"
        ? opts.skipSeo
          ? "OK"
          : "NOT_COMPARED"
        : result.reachability_verdict;
    return result;
  }

  const liveSeo = extractSeo(cheerio.load(live.html), live.finalUrl);
  const localSeo = extractSeo(cheerio.load(local.html), local.finalUrl);

  result.meta = compareMeta(liveSeo, localSeo);
  result.schema = compareSchema(
    typesOf(live.html, extractJsonLdSchemas, cheerio.load),
    typesOf(local.html, extractJsonLdSchemas, cheerio.load),
  );
  result.notes = result.meta.notes;

  const clean =
    result.reachability_verdict === "OK" &&
    result.meta.verdict === "CLEAN" &&
    result.schema.verdict === "MATCH";

  result.overall_verdict = clean
    ? "OK"
    : result.reachability_verdict !== "OK"
      ? result.reachability_verdict
      : result.schema.verdict === "MISSING"
        ? "SCHEMA_MISSING"
        : result.meta.verdict === "MISMATCH"
          ? "META_MISMATCH"
          : "SCHEMA_FIELDS_DIFFER";

  return result;
}

// ---------- CSV ----------

/** RFC 4180: quote everything, double interior quotes. Excel-safe by default. */
function csvCell(value) {
  if (value === null || value === undefined) return '""';
  const text = Array.isArray(value) ? value.join(" | ") : String(value);
  return `"${text.replace(/\r?\n/g, " ").replace(/"/g, '""')}"`;
}

const csvRow = (cells) => cells.map(csvCell).join(",");

function buildHeader() {
  const head = [
    "url",
    "path",
    "category",
    "in_xlsx",
    "in_sitemap",
    "live_status",
    "live_final_url",
    "live_redirected",
    "live_hops",
    "live_error",
    "local_status",
    "local_final_url",
    "local_redirected",
    "local_hops",
    "local_error",
    "reachability_verdict",
  ];
  for (const f of FIELDS)
    head.push(`${f.key}_live`, `${f.key}_local`, `${f.key}_verdict`);
  return head.concat([
    "meta_matched",
    "meta_total",
    "meta_verdict",
    "schema_blocks_live",
    "schema_blocks_local",
    "schema_local_parse_ok",
    "schema_types_live",
    "schema_types_local",
    "schema_types_missing",
    "schema_types_extra",
    "schema_fields_mismatched",
    "schema_verdict",
    "overall_verdict",
    "notes",
  ]);
}

function buildRow(r) {
  const cells = [
    r.url,
    r.path,
    r.category,
    r.inXlsx,
    r.inSitemap,
    r.live_status,
    r.live_final_url,
    r.live_redirected,
    r.live_hops,
    r.live_error,
    r.local_status,
    r.local_final_url,
    r.local_redirected,
    r.local_hops,
    r.local_error,
    r.reachability_verdict,
  ];

  const byKey = new Map((r.meta?.fields || []).map((f) => [f.key, f]));
  for (const f of FIELDS) {
    const field = byKey.get(f.key);
    cells.push(field?.live ?? "", field?.local ?? "", field?.verdict ?? "");
  }

  cells.push(
    r.meta?.matched ?? "",
    r.meta?.total ?? "",
    r.meta?.verdict ?? "",
    r.schema?.blocksLive ?? "",
    r.schema?.blocksLocal ?? "",
    r.schema?.parseOk ?? "",
    r.schema?.liveTypes ?? "",
    r.schema?.localTypes ?? "",
    r.schema?.missing ?? "",
    r.schema?.extra ?? "",
    r.schema?.mismatched ?? "",
    r.schema?.verdict ?? "",
    r.overall_verdict,
    r.notes,
  );
  return cells;
}

function buildSummary(results) {
  const groups = new Map();
  for (const r of results) {
    const g = groups.get(r.category) || {
      category: r.category,
      urls: 0,
      live_broken: 0,
      local_404: 0,
      local_error: 0,
      redirect_differs: 0,
      meta_clean: 0,
      schema_clean: 0,
      ok: 0,
    };
    g.urls++;
    if (
      r.reachability_verdict === "LIVE_BROKEN" ||
      r.reachability_verdict === "BOTH_BROKEN"
    )
      g.live_broken++;
    if (r.reachability_verdict === "LOCAL_404") g.local_404++;
    if (r.reachability_verdict === "LOCAL_ERROR") g.local_error++;
    if (r.reachability_verdict === "LOCAL_REDIRECT_DIFFERS")
      g.redirect_differs++;
    if (r.meta?.verdict === "CLEAN") g.meta_clean++;
    if (r.schema?.verdict === "MATCH") g.schema_clean++;
    if (r.overall_verdict === "OK") g.ok++;
    groups.set(r.category, g);
  }
  return [...groups.values()];
}

// ---------- main ----------

const HELP = `
Live-vs-local SEO audit — meta tags, JSON-LD and sitemap reachability.

  --source xlsx|sitemap|both   URL list (default xlsx)
  --url <url|/path>            spot-check one page; repeatable, replaces --source
  --xlsx <file>                default ../ILS Hospitals Sitemap URLS.xlsx
  --sitemap <file>             default ./ils_sitemap.json
  --live <origin>              default https://ilshospitals.com
  --local <origin>             default http://localhost:3000
  --out <file.csv>             default reports/seo-audit-<date>.csv
  --only "Cat A,Cat B"         restrict to categories
  --limit N                    first N URLs after sorting
  --concurrency-live N         default 4
  --concurrency-local N        default 3  (12 crashed next dev previously)
  --refresh                    ignore cache and refetch
  --from-cache                 never hit the network
  --skip-seo                   reachability only (fast 404 sweep)
  --print-plan                 show the URL/category breakdown and exit
  --fail-on-regression         exit 1 if any LOCAL_404 / LOCAL_ERROR / SCHEMA_MISSING
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const categories = buildCategoryIndex(opts.sitemap);
  const rows = loadUrls(opts, categories);

  if (opts.printPlan) {
    const counts = new Map();
    for (const r of rows)
      counts.set(r.category, (counts.get(r.category) || 0) + 1);
    console.log(`${rows.length} URLs from --source ${opts.source}\n`);
    for (const [name, n] of counts)
      console.log(`  ${String(n).padStart(5)}  ${name}`);
    const uncategorized = rows.filter((r) =>
      r.category.startsWith("Uncategorized"),
    ).length;
    console.log(`\n  categorised from sitemap: ${rows.length - uncategorized}`);
    console.log(`  needing path fallback:    ${uncategorized}`);
    return 0;
  }

  if (!rows.length) {
    console.error("No URLs matched. Check --source / --only.");
    return 1;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const out =
    opts.out || path.resolve(__dirname, "reports", `seo-audit-${stamp}.csv`);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  console.log(`Auditing ${rows.length} URLs`);
  console.log(`  live  ${opts.live}  (concurrency ${opts.concurrencyLive})`);
  console.log(`  local ${opts.local}  (concurrency ${opts.concurrencyLocal})`);

  const fetchOpts = { fromCache: opts.fromCache, refresh: opts.refresh };

  /** Both passes report progress; the live one is the long pole on a cold cache. */
  const sweep = async (side, origin, concurrency) => {
    let done = 0;
    const results = await mapLimit(rows, concurrency, async (row) => {
      const res = await probe(`${origin}${row.path}`, { side, ...fetchOpts });
      done++;
      if (done % 25 === 0 || done === rows.length) {
        process.stdout.write(`\r  ${side.padEnd(5)} ${done}/${rows.length}   `);
      }
      return res;
    });
    process.stdout.write("\n");
    return results;
  };

  // Swept as two passes so each side keeps its own concurrency limit; running
  // them interleaved would hold both to the lower one.
  const liveResults = await sweep("live", opts.live, opts.concurrencyLive);
  const localResults = await sweep("local", opts.local, opts.concurrencyLocal);

  const results = rows.map((row, i) =>
    analyse(row, liveResults[i], localResults[i], opts),
  );

  const csv = [
    csvRow(buildHeader()),
    ...results.map((r) => csvRow(buildRow(r))),
  ].join("\n");
  fs.writeFileSync(out, `﻿${csv}\n`, "utf-8");

  const summary = buildSummary(results);
  const summaryOut = out.replace(/\.csv$/, "-summary.csv");
  const summaryHead = Object.keys(summary[0] || { category: "" });
  fs.writeFileSync(
    summaryOut,
    `﻿${[csvRow(summaryHead), ...summary.map((g) => csvRow(summaryHead.map((k) => g[k])))].join("\n")}\n`,
    "utf-8",
  );

  // Full values for anything the CSV truncates or flattens.
  const jsonOut = out.replace(/\.csv$/, ".json");
  fs.writeFileSync(
    jsonOut,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), opts, results },
      null,
      1,
    ),
    "utf-8",
  );

  const tally = (v) => results.filter((r) => r.overall_verdict === v).length;
  console.log(`\n  ${out}`);
  console.log(`  ${summaryOut}`);
  console.log(`  ${jsonOut}\n`);
  console.log(`  OK               ${tally("OK")}`);
  console.log(`  META_MISMATCH    ${tally("META_MISMATCH")}`);
  console.log(`  SCHEMA_MISSING   ${tally("SCHEMA_MISSING")}`);
  console.log(`  SCHEMA_FIELDS    ${tally("SCHEMA_FIELDS_DIFFER")}`);
  console.log(`  LOCAL_404        ${tally("LOCAL_404")}`);
  console.log(`  LOCAL_ERROR      ${tally("LOCAL_ERROR")}`);
  console.log(`  REDIRECT_DIFFERS ${tally("LOCAL_REDIRECT_DIFFERS")}`);
  console.log(
    `  LIVE_BROKEN      ${tally("LIVE_BROKEN") + tally("BOTH_BROKEN")}`,
  );

  const regressions = results.filter((r) =>
    ["LOCAL_404", "LOCAL_ERROR", "SCHEMA_MISSING"].includes(r.overall_verdict),
  );
  return opts.failOnRegression && regressions.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
