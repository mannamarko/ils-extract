/**
 * Shared scraping helpers for the ILS Hospitals blog extractors.
 * ---------------------------------------------------------------
 * Used by ils-blog-scraper.js (posts) and ils-taxonomy-scraper.js
 * (categories + tags). Everything here is site-agnostic plumbing plus the
 * SEO/JSON-LD extraction that both scripts need to behave identically.
 *
 * NOTE on this site's SEO: every page ships an AIOSEO block that is
 * misconfigured site-wide — it emits homepage values (og:title
 * "Blog - ILS-Hospital", og:url/canonical = homepage) on posts AND on every
 * category/tag archive. Post pages additionally carry a second, correct
 * theme-authored block later in the document; archive pages do not. Because
 * the wrong block always comes first, og/twitter are resolved
 * last-non-empty-wins rather than first-match.
 */

const axios = require("axios");
const fs = require("fs");
const path = require("path");

const HOME = "https://ilshospitals.com/";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; ILSBlogScraperNode/1.0)" };
const TIMEOUT_MS = 20000;
const RETRIES = 3;
const REQUEST_DELAY_MS = 800; // politeness delay between requests
const CACHE_DIR = path.resolve(__dirname, ".cache");

// Runtime cache mode, set from CLI args by each script's main().
const cacheMode = { fromCache: false, refresh: false };

// ---------- helpers ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cachePath(key, ext = "html") {
  return path.join(CACHE_DIR, `${key}.${ext}`);
}

function readCache(key, ext) {
  try {
    return fs.readFileSync(cachePath(key, ext), "utf-8");
  } catch (e) {
    return null;
  }
}

function writeCache(key, body, ext) {
  const p = cachePath(key, ext);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, "utf-8");
}

/**
 * Collapse source newlines so the HTML survives a round-trip through JSON
 * without turning into a wall of \n escapes when pasted into a viewer.
 *
 * This is rendering-identical, not cosmetic: in HTML a newline is just
 * whitespace, and the corpus contains no <pre>, <code> or <textarea>, so no
 * element here treats whitespace as significant. Newlines sit between block
 * tags (one <p> per line); the 26 posts with a newline mid-sentence collapse
 * to the single space a browser would have rendered anyway.
 */
function normalizeHtmlWhitespace(html) {
  if (!html) return html;
  return html.replace(/\s*\n\s*/g, " ").replace(/[ \t]{2,}/g, " ").trim();
}

function slugFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  } catch (e) {
    return null;
  }
}

/**
 * Fetch a URL, backed by an on-disk HTML cache keyed by `cacheKey`
 * (e.g. "posts/my-slug" or "listing/page-3"). Returns { html, fromCache }.
 * With --from-cache, never touches the network.
 */
async function fetchHtml(url, cacheKey) {
  if (cacheKey && !cacheMode.refresh) {
    const cached = readCache(cacheKey);
    if (cached !== null) return { html: cached, fromCache: true };
  }
  if (cacheMode.fromCache) return { html: null, fromCache: true };

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT_MS, validateStatus: (s) => s < 500 });
      if (res.status === 404) return { html: null, fromCache: false };
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      if (cacheKey) writeCache(cacheKey, res.data);
      return { html: res.data, fromCache: false };
    } catch (err) {
      console.warn(`  [warn] attempt ${attempt}/${RETRIES} failed for ${url}: ${err.message}`);
      await sleep(1500 * attempt);
    }
  }
  return { html: null, fromCache: false };
}

/**
 * Same contract as fetchHtml but for JSON endpoints (the WP REST API).
 * Returns { data, fromCache }. Caches the raw response body as .json.
 */
async function fetchJson(url, cacheKey) {
  if (cacheKey && !cacheMode.refresh) {
    const cached = readCache(cacheKey, "json");
    if (cached !== null) {
      try {
        return { data: JSON.parse(cached), fromCache: true };
      } catch (e) {
        /* fall through and re-fetch */
      }
    }
  }
  if (cacheMode.fromCache) return { data: null, fromCache: true };

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await axios.get(url, {
        headers: HEADERS,
        timeout: TIMEOUT_MS,
        validateStatus: (s) => s < 500,
        // Keep the body as text so the cached file is the exact response.
        transformResponse: (d) => d,
      });
      if (res.status === 404) return { data: null, fromCache: false };
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      const data = JSON.parse(res.data);
      if (cacheKey) writeCache(cacheKey, res.data, "json");
      return { data, fromCache: false };
    } catch (err) {
      console.warn(`  [warn] attempt ${attempt}/${RETRIES} failed for ${url}: ${err.message}`);
      await sleep(1500 * attempt);
    }
  }
  return { data: null, fromCache: false };
}

// ---------- JSON-LD ----------

/**
 * The theme's hand-written ld+json block embeds raw literal newlines *inside*
 * string literals (e.g. "headline": "Some Title\n"), which JSON.parse rejects
 * as control characters. Escape control chars only while inside a string —
 * structural whitespace between tokens must be left untouched.
 */
function sanitizeJsonControlChars(str) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of str) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (inString && ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString && ch < " ") {
      if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else out += "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Parse every <script type="application/ld+json"> on a page into an array
 * of JSON objects. Handles multiple script blocks; if one block itself
 * contains an "@graph" array, each graph node is kept inside that object
 * (not flattened) so structure is preserved 1:1 with the source.
 *
 * Each block is tagged with `_source`: "aioseo" for the All-in-One-SEO plugin
 * block (which on this site emits generic homepage data on every post) and
 * "post" for the theme's post-specific block. Blocks that only parse after
 * control-char repair are tagged `_repaired: true`; blocks that never parse
 * keep their FULL raw text so nothing is lost.
 */
function extractJsonLdSchemas($) {
  const schemas = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    const source = ($(el).attr("class") || "").includes("aioseo-schema") ? "aioseo" : "post";

    let parsed = null;
    let repaired = false;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      try {
        parsed = JSON.parse(sanitizeJsonControlChars(raw));
        repaired = true;
      } catch (e2) {
        schemas.push({ _parse_error: e2.message, _raw: raw, _source: source });
        return;
      }
    }
    parsed._source = source;
    if (repaired) parsed._repaired = true;
    schemas.push(parsed);
  });
  return schemas;
}

/** Collect every graph node across a set of ld+json blocks. */
function graphNodes(blocks) {
  const nodes = [];
  for (const b of blocks) {
    if (!b || b._parse_error) continue;
    if (Array.isArray(b["@graph"])) nodes.push(...b["@graph"]);
    else nodes.push(b);
  }
  return nodes;
}

function findNode(blocks, type) {
  return graphNodes(blocks).find((n) => n && n["@type"] === type) || null;
}

const trimOrNull = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Flatten the post-specific BlogPosting node into convenience fields. */
function extractBlogPosting(postBlocks) {
  const bp = findNode(postBlocks, "BlogPosting");
  if (!bp) return null;
  return {
    headline: trimOrNull(bp.headline),
    description: trimOrNull(bp.description),
    author: bp.author ? trimOrNull(bp.author.name) : null,
    author_url: bp.author ? trimOrNull(bp.author.url) : null,
    publisher: bp.publisher ? trimOrNull(bp.publisher.name) : null,
    publisher_logo: bp.publisher && bp.publisher.logo ? trimOrNull(bp.publisher.logo.url) : null,
    main_entity_id: bp.mainEntityOfPage ? trimOrNull(bp.mainEntityOfPage["@id"]) : null,
  };
}

/** Map the post-specific BreadcrumbList into a flat ordered array. */
function extractBreadcrumbs(postBlocks) {
  const bl = findNode(postBlocks, "BreadcrumbList");
  if (!bl || !Array.isArray(bl.itemListElement)) return [];
  return bl.itemListElement.map((it) => ({
    position: it.position ?? null,
    name: trimOrNull(it.name),
    item: trimOrNull(it.item),
  }));
}

/**
 * Extract the full SEO metadata block from a page.
 *
 * og/twitter are resolved last-non-empty-wins because the misconfigured AIOSEO
 * block always comes first; an empty string counts as absent (AIOSEO emits
 * twitter:description=""). Works unchanged on post pages and on category/tag
 * archives — archives simply have no post-specific block, so the
 * `no_post_specific_*` issues fire and `blogposting` comes back null.
 */
function extractSeo($, pageUrl) {
  // Every meta tag, in document order — nothing silently dropped.
  const meta_all = [];
  $("meta").each((index, el) => {
    const a = el.attribs || {};
    const kind = a.property !== undefined ? "property" : a.name !== undefined ? "name" : null;
    if (!kind) return;
    meta_all.push({ kind, key: a.property ?? a.name, content: a.content ?? null, index });
  });

  // Last non-empty value for `key`, matched on either name= or property=.
  const resolve = (key) => {
    let val = null;
    for (const m of meta_all) {
      if (m.key.toLowerCase() === key && m.content && m.content.trim()) val = m.content;
    }
    return val;
  };

  const json_ld = extractJsonLdSchemas($);
  const bySource = {
    aioseo: json_ld.filter((b) => b._source === "aioseo"),
    post: json_ld.filter((b) => b._source === "post"),
  };
  const blogposting = extractBlogPosting(bySource.post);

  const rawTitle = $("title").first().text().trim() || null;
  const canonical = $('link[rel="canonical"]').attr("href") || null;

  // Fallback chain for the title, since the site ships an empty <title>.
  const meta_title_resolved =
    rawTitle ||
    (blogposting && blogposting.headline) ||
    trimOrNull($("article .entry-title").first().text()) ||
    trimOrNull($(".entry-title").first().text()) ||
    resolve("og:title") ||
    null;

  // The AIOSEO block always emits one og:title; a second occurrence means the
  // theme's post-specific meta block is present. Schema and meta are tracked
  // separately because they don't always ship together — at least one post has
  // post-specific meta tags but only the generic AIOSEO ld+json.
  const hasPostMeta = meta_all.filter((m) => m.key.toLowerCase() === "og:title").length > 1;

  const seo_issues = [];
  if (!rawTitle) seo_issues.push("empty_title_tag");
  if (canonical === HOME && pageUrl !== HOME) seo_issues.push("canonical_points_to_homepage");
  if (json_ld.some((b) => b._repaired)) seo_issues.push("json_ld_repaired");
  if (json_ld.some((b) => b._parse_error)) seo_issues.push("json_ld_unparseable");
  if (!bySource.post.length) seo_issues.push("no_post_specific_schema");
  if (!hasPostMeta) seo_issues.push("no_post_specific_meta");

  return {
    meta_title: rawTitle,
    meta_title_resolved,
    meta_description: resolve("description"),
    robots: resolve("robots"),
    canonical,
    canonical_resolved: pageUrl || null,
    og: {
      title: resolve("og:title"),
      description: resolve("og:description"),
      type: resolve("og:type"),
      url: resolve("og:url"),
      image: resolve("og:image"),
      image_secure_url: resolve("og:image:secure_url"),
      site_name: resolve("og:site_name"),
      locale: resolve("og:locale"),
    },
    twitter: {
      card: resolve("twitter:card"),
      title: resolve("twitter:title"),
      description: resolve("twitter:description"),
      image: resolve("twitter:image"),
      url: resolve("twitter:url"),
    },
    json_ld,
    json_ld_by_source: bySource,
    blogposting,
    breadcrumbs: extractBreadcrumbs(bySource.post),
    meta_all,
    seo_issues,
    source_url: pageUrl,
  };
}

module.exports = {
  HOME,
  HEADERS,
  TIMEOUT_MS,
  RETRIES,
  REQUEST_DELAY_MS,
  CACHE_DIR,
  cacheMode,
  sleep,
  cachePath,
  readCache,
  writeCache,
  slugFromUrl,
  normalizeHtmlWhitespace,
  fetchHtml,
  fetchJson,
  sanitizeJsonControlChars,
  extractJsonLdSchemas,
  graphNodes,
  findNode,
  trimOrNull,
  extractBlogPosting,
  extractBreadcrumbs,
  extractSeo,
};
