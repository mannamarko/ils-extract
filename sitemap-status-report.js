#!/usr/bin/env node
/**
 * Sitemap link status report — live vs staging.
 * ------------------------------------------------
 * Sweeps every URL on the site's own sitemap (extract/ils_sitemap.json,
 * written by ils-sitemap-scraper.js) against both https://ilshospitals.com
 * and https://ils.democloud.in, and writes a CSV recording each side's
 * status code, whether it redirected, and where it ended up.
 *
 * Unlike ils-live-vs-local-audit.js (live vs a local `next dev` server, plus
 * a full meta/JSON-LD diff), this is reachability-only and targets staging,
 * so it gets its own small CSV shape rather than repurposing "local_*"
 * columns and 20+ SEO-diff fields that don't apply here. It reuses the same
 * tested HTTP layer (lib/probe.js's `probe`/`mapLimit`) so redirect-following,
 * retry/backoff and on-disk caching behave identically to that script.
 *
 *   node sitemap-status-report.js                    # full sweep, live + staging
 *   node sitemap-status-report.js --limit 20          # quick spot-check
 *   node sitemap-status-report.js --refresh           # ignore cache, refetch
 */
const fs = require("fs");
const path = require("path");
const { probe, mapLimit } = require("./lib/probe");

const DEFAULTS = {
  sitemap: path.resolve(__dirname, "ils_sitemap.json"),
  live: "https://ilshospitals.com",
  staging: "https://ils.democloud.in",
  out: null,
  limit: 0,
  concurrencyLive: 4,
  concurrencyStaging: 4,
  refresh: false,
  fromCache: false,
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const next = (i) => argv[i + 1];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--sitemap":
        opts.sitemap = path.resolve(next(i++));
        break;
      case "--live":
        opts.live = next(i++).replace(/\/+$/, "");
        break;
      case "--staging":
        opts.staging = next(i++).replace(/\/+$/, "");
        break;
      case "--out":
        opts.out = path.resolve(next(i++));
        break;
      case "--limit":
        opts.limit = Number(next(i++)) || 0;
        break;
      case "--concurrency-live":
        opts.concurrencyLive = Number(next(i++)) || 4;
        break;
      case "--concurrency-staging":
        opts.concurrencyStaging = Number(next(i++)) || 4;
        break;
      case "--refresh":
        opts.refresh = true;
        break;
      case "--from-cache":
        opts.fromCache = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`unknown flag: ${arg}`);
    }
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

/**
 * The sitemap's entries_flat carries live URLs (it was scraped from
 * ilshospitals.com/sitemap/). The staging URL is the same path against the
 * staging origin — the two sites are supposed to be path-for-path mirrors.
 */
function loadRows(opts) {
  const data = JSON.parse(fs.readFileSync(opts.sitemap, "utf-8"));
  const entries = data.entries_flat || [];
  let rows = entries.map((e) => ({
    category: e.category,
    name: e.name,
    path: pathOf(e.url),
    liveUrl: e.url,
    stagingUrl: `${opts.staging}${pathOf(e.url)}`,
  }));
  if (opts.limit > 0) rows = rows.slice(0, opts.limit);
  return rows;
}

/**
 * OK is the only verdict meaning "this page is fine on staging too".
 * LIVE_BROKEN pages are already dead upstream, so a staging 404 there is not
 * a staging regression.
 */
function verdictOf(live, staging) {
  const liveOk = live.status && live.status < 400;
  const stagingOk = staging.status && staging.status < 400;

  if (!liveOk && !stagingOk) return "BOTH_BROKEN";
  if (!liveOk) return "LIVE_BROKEN";
  if (staging.status === 404) return "STAGING_404";
  if (!stagingOk) return "STAGING_ERROR";
  if (live.redirected !== staging.redirected) return "REDIRECT_DIFFERS";
  if (
    live.redirected &&
    pathOf(live.finalUrl).replace(/\/+$/, "") !==
      pathOf(staging.finalUrl).replace(/\/+$/, "")
  ) {
    return "REDIRECT_DIFFERS";
  }
  return "OK";
}

// ---------- CSV ----------

/** RFC 4180: quote everything, double interior quotes. Excel-safe by default. */
function csvCell(value) {
  if (value === null || value === undefined) return '""';
  return `"${String(value).replace(/\r?\n/g, " ").replace(/"/g, '""')}"`;
}
const csvRow = (cells) => cells.map(csvCell).join(",");

const HEADER = [
  "category",
  "name",
  "path",
  "live_url",
  "live_status",
  "live_redirected",
  "live_final_url",
  "live_hops",
  "live_error",
  "staging_url",
  "staging_status",
  "staging_redirected",
  "staging_final_url",
  "staging_hops",
  "staging_error",
  "status",
];

function buildRow(row, live, staging, status) {
  return [
    row.category,
    row.name,
    row.path,
    row.liveUrl,
    live.status ?? "",
    live.redirected,
    live.finalUrl,
    live.hops,
    live.error || "",
    row.stagingUrl,
    staging.status ?? "",
    staging.redirected,
    staging.finalUrl,
    staging.hops,
    staging.error || "",
    status,
  ];
}

function buildSummary(results) {
  const groups = new Map();
  for (const r of results) {
    const g = groups.get(r.category) || {
      category: r.category,
      urls: 0,
      ok: 0,
      live_broken: 0,
      staging_404: 0,
      staging_error: 0,
      redirect_differs: 0,
      both_broken: 0,
    };
    g.urls++;
    if (r.status === "OK") g.ok++;
    if (r.status === "LIVE_BROKEN") g.live_broken++;
    if (r.status === "STAGING_404") g.staging_404++;
    if (r.status === "STAGING_ERROR") g.staging_error++;
    if (r.status === "REDIRECT_DIFFERS") g.redirect_differs++;
    if (r.status === "BOTH_BROKEN") g.both_broken++;
    groups.set(r.category, g);
  }
  return [...groups.values()];
}

const HELP = `
Sitemap link status report — reachability on live vs staging.

  --sitemap <file>              default ./ils_sitemap.json
  --live <origin>                default https://ilshospitals.com
  --staging <origin>             default https://ils.democloud.in
  --out <file.csv>               default reports/sitemap-status-<date>.csv
  --limit N                      first N URLs (for a quick spot-check)
  --concurrency-live N           default 4
  --concurrency-staging N        default 4
  --refresh                      ignore cache and refetch both sides
  --from-cache                   never hit the network
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const rows = loadRows(opts);
  if (!rows.length) {
    console.error("No URLs loaded. Check --sitemap.");
    return 1;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const out =
    opts.out ||
    path.resolve(__dirname, "reports", `sitemap-status-${stamp}.csv`);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  console.log(`Checking ${rows.length} sitemap URLs`);
  console.log(`  live     ${opts.live}  (concurrency ${opts.concurrencyLive})`);
  console.log(
    `  staging  ${opts.staging}  (concurrency ${opts.concurrencyStaging})`,
  );

  const sweep = async (side, urlOf, concurrency) => {
    let done = 0;
    const results = await mapLimit(rows, concurrency, async (row) => {
      const res = await probe(urlOf(row), {
        side,
        fromCache: opts.fromCache,
        refresh: opts.refresh,
      });
      done++;
      if (done % 50 === 0 || done === rows.length) {
        process.stdout.write(`\r  ${side.padEnd(8)} ${done}/${rows.length}   `);
      }
      return res;
    });
    process.stdout.write("\n");
    return results;
  };

  // Two passes so each side keeps its own concurrency limit.
  const liveResults = await sweep(
    "live",
    (r) => r.liveUrl,
    opts.concurrencyLive,
  );
  const stagingResults = await sweep(
    "staging",
    (r) => r.stagingUrl,
    opts.concurrencyStaging,
  );

  const results = rows.map((row, i) => {
    const live = liveResults[i];
    const staging = stagingResults[i];
    return { ...row, status: verdictOf(live, staging), live, staging };
  });

  const csv = [
    csvRow(HEADER),
    ...results.map((r) => csvRow(buildRow(r, r.live, r.staging, r.status))),
  ].join("\n");
  fs.writeFileSync(out, `﻿${csv}\n`, "utf-8");

  const summary = buildSummary(results);
  const summaryOut = out.replace(/\.csv$/, "-summary.csv");
  const summaryHead = Object.keys(
    summary[0] || { category: "" },
  );
  fs.writeFileSync(
    summaryOut,
    `﻿${[
      csvRow(summaryHead),
      ...summary.map((g) => csvRow(summaryHead.map((k) => g[k]))),
    ].join("\n")}\n`,
    "utf-8",
  );

  const tally = (v) => results.filter((r) => r.status === v).length;
  console.log(`\n  ${out}`);
  console.log(`  ${summaryOut}\n`);
  console.log(`  OK               ${tally("OK")}`);
  console.log(`  REDIRECT_DIFFERS ${tally("REDIRECT_DIFFERS")}`);
  console.log(`  STAGING_404      ${tally("STAGING_404")}`);
  console.log(`  STAGING_ERROR    ${tally("STAGING_ERROR")}`);
  console.log(`  LIVE_BROKEN      ${tally("LIVE_BROKEN")}`);
  console.log(`  BOTH_BROKEN      ${tally("BOTH_BROKEN")}`);

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
