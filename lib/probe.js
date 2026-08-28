/**
 * HTTP probe that keeps what a live-vs-local audit actually needs: the status
 * code, the redirect chain and the final URL.
 *
 * `scrape-lib.js`'s `fetchHtml` cannot be reused here — it lets axios follow
 * redirects silently and returns only `{ html }`, so a 301 is indistinguishable
 * from a 200 and the destination is lost. That distinction is the whole point
 * of the audit (`/job/staff-nurse/` 301s to `…-nicu/` on live and 404s
 * locally), so this follows hops by hand with `maxRedirects: 0`.
 *
 * Everything else — the retry/backoff shape, headers, timeout and cache root —
 * is taken from `scrape-lib.js` so both tools behave the same way on the wire.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const {
  HEADERS,
  TIMEOUT_MS,
  RETRIES,
  CACHE_DIR,
  sleep,
} = require("../scrape-lib");

const MAX_HOPS = 5;
const AUDIT_CACHE = path.join(CACHE_DIR, "audit");

/** Cache key is the side plus the URL, so live and local never collide. */
function cacheFile(side, url) {
  const hash = crypto.createHash("sha1").update(url).digest("hex");
  return path.join(AUDIT_CACHE, side, `${hash}.json`);
}

function readCached(side, url) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(side, url), "utf-8"));
  } catch {
    return null;
  }
}

function writeCached(side, url, result) {
  const file = cacheFile(side, url);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result), "utf-8");
}

/** `/a/b` on a 302 Location header has to resolve against the URL it came from. */
function resolveLocation(location, base) {
  try {
    return new URL(location, base).toString();
  } catch {
    return location;
  }
}

async function requestOnce(url) {
  return axios.get(url, {
    headers: HEADERS,
    timeout: TIMEOUT_MS,
    maxRedirects: 0,
    // Every status is a result to record, not an exception — a 404 or 500 is
    // exactly what the report is looking for.
    validateStatus: () => true,
    responseType: "text",
    transformResponse: [(body) => body],
  });
}

/**
 * Follows up to MAX_HOPS redirects and returns the whole story:
 *
 *   { status, finalUrl, redirected, hops, chain, error, html, ms }
 *
 * `status` is the *final* status. `chain` lists each hop as
 * `"<status> <url>"` so the CSV can show where a redirect actually went.
 * A transport failure (DNS, timeout, connection reset) sets `error` and
 * leaves `status` null — distinct from an HTTP error status.
 */
async function probe(
  url,
  { side = "live", fromCache = false, refresh = false } = {},
) {
  if (!refresh) {
    const cached = readCached(side, url);
    if (cached) return { ...cached, cached: true };
  }
  if (fromCache) {
    return {
      status: null,
      finalUrl: url,
      redirected: false,
      hops: 0,
      chain: [],
      error: "not in cache",
      html: null,
      ms: 0,
      cached: false,
    };
  }

  const started = Date.now();
  const chain = [];
  let current = url;
  let result = null;
  let error = null;

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let res = null;

    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        res = await requestOnce(current);
        error = null;
        break;
      } catch (e) {
        error = e.code || e.message;
        if (attempt < RETRIES) await sleep(1500 * attempt);
      }
    }

    if (!res) break;

    const location = res.headers?.location;
    if (res.status >= 300 && res.status < 400 && location && hop < MAX_HOPS) {
      chain.push(`${res.status} ${current}`);
      current = resolveLocation(location, current);
      continue;
    }

    result = {
      status: res.status,
      html: typeof res.data === "string" ? res.data : null,
    };
    break;
  }

  const out = {
    status: result ? result.status : null,
    finalUrl: current,
    redirected: chain.length > 0,
    hops: chain.length,
    chain,
    error: result ? null : error || "no response",
    html: result ? result.html : null,
    ms: Date.now() - started,
    cached: false,
  };

  // Only cache a real answer; a transport failure should be retried next run.
  if (out.status !== null) writeCached(side, url, out);
  return out;
}

/**
 * Runs `worker` over `items` with at most `limit` in flight.
 *
 * The previous hand-rolled sweep used 12-way concurrency and crashed
 * `next dev`'s on-demand compiler partway through, so callers pass a lower
 * limit for the local side than for live.
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    },
  );

  await Promise.all(runners);
  return results;
}

module.exports = { probe, mapLimit, MAX_HOPS, AUDIT_CACHE };
