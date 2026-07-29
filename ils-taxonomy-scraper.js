#!/usr/bin/env node
/**
 * ILS Hospitals Taxonomy Scraper (Node.js)
 * ---------------------------------------------------------------
 * Emits one JSON file for categories and one for tags. Each term carries:
 *   - id, name, slug, taxonomy, parent, description, url
 *   - count (WordPress' own) + post_count_scraped (derived)
 *   - archive_title, archive_pages
 *   - posts [{slug, title, published_date}] newest first
 *   - seo: the full SEO block from the term's rendered archive page
 *   - issues: what's wrong with this term / its archive page
 *
 * Term enumeration uses the WP REST API because 11 tags have zero posts and
 * are undiscoverable from the post corpus. SEO comes from the *rendered*
 * archive page, per request.
 *
 * Heads-up on what that SEO contains: every archive page on this site serves
 * identical generic homepage metadata (empty <title>, canonical = homepage,
 * og:title "Blog - ILS-Hospital", homepage JSON-LD graph). The theme renders
 * archives through a generic page template, so AIOSEO emits homepage values
 * and never page-specific ones. Meanwhile Yoast IS generating correct
 * per-term metadata, visible in the REST API's yoast_head_json but never
 * rendered. Every record is flagged `rendered_seo_is_generic` accordingly.
 *
 * Requires: axios, cheerio
 *
 * Usage:
 *   node ils-taxonomy-scraper.js                     # full run (~13 min cold)
 *   node ils-taxonomy-scraper.js --from-cache        # reparse only, no network
 *   node ils-taxonomy-scraper.js --only categories   # categories only
 *   node ils-taxonomy-scraper.js --refresh           # re-fetch, overwrite cache
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const {
  HOME,
  REQUEST_DELAY_MS,
  CACHE_DIR,
  cacheMode,
  sleep,
  slugFromUrl,
  fetchHtml,
  fetchJson,
  extractSeo,
  trimOrNull,
} = require("./scrape-lib");

const API = "https://ilshospitals.com/blog/wp-json/wp/v2";
const PER_PAGE = 100;
const GENERIC_OG_TITLE = "Blog - ILS-Hospital";

// ---------- step A: enumerate terms via the REST API ----------

/**
 * Page through /categories or /tags. X-WP-Total is unreliable on this site
 * (it reports 46 categories while every query returns 41), so paging stops on
 * the first empty page rather than trusting a header.
 */
async function fetchTerms(taxonomy) {
  const all = [];
  for (let page = 1; ; page++) {
    const url = `${API}/${taxonomy}?per_page=${PER_PAGE}&page=${page}`;
    const { data, fromCache } = await fetchJson(url, `api/${taxonomy}-p${page}`);
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    console.log(`[info] ${taxonomy}: page ${page} -> ${data.length} terms (total ${all.length})`);
    if (data.length < PER_PAGE) break;
    if (!fromCache) await sleep(REQUEST_DELAY_MS);
  }
  return all;
}

// ---------- step B: post membership from cached listing HTML ----------

/**
 * Walk the cached listing pages and build slug -> posts for both taxonomies.
 *
 * Reads EVERY .cat-links anchor, not just the first. ils-blog-scraper.js keeps
 * only the first, which silently drops a second category on 8 posts; category
 * totals here therefore match WordPress where the post JSON does not.
 */
function buildMembership() {
  const listingDir = path.join(CACHE_DIR, "listing");
  if (!fs.existsSync(listingDir)) {
    throw new Error(
      `No cached listing pages at ${listingDir}. Run ils-blog-scraper.js first to populate the cache.`
    );
  }

  const categories = new Map(); // slug -> [post]
  const tags = new Map();
  const seen = new Set(); // guard against a post appearing on two listing pages

  const add = (map, slug, post) => {
    if (!slug) return;
    if (!map.has(slug)) map.set(slug, []);
    const arr = map.get(slug);
    if (!arr.some((p) => p.slug === post.slug)) arr.push(post);
  };

  for (const file of fs.readdirSync(listingDir).filter((f) => f.endsWith(".html"))) {
    const $ = cheerio.load(fs.readFileSync(path.join(listingDir, file), "utf-8"));
    $('article[id^="post-"]').each((_, el) => {
      const $a = $(el);
      const anchor = $a.find(".entry-title a").first();
      const slug = slugFromUrl(anchor.attr("href"));
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const post = {
        slug,
        title: trimOrNull(anchor.text()),
        published_date: $a.find("time.entry-date").first().attr("datetime") || null,
      };

      $a.find(".cat-links a").each((__, e) => add(categories, slugFromUrl($(e).attr("href")), post));
      $a.find("footer .tag-links a").each((__, e) => add(tags, slugFromUrl($(e).attr("href")), post));
    });
  }

  const byDateDesc = (a, b) => String(b.published_date).localeCompare(String(a.published_date));
  for (const arr of categories.values()) arr.sort(byDateDesc);
  for (const arr of tags.values()) arr.sort(byDateDesc);

  return { categories, tags, postCount: seen.size };
}

// ---------- step C: the term's rendered archive page ----------

/** Highest page number in the pagination widget; 1 when there's no pagination. */
function archivePageCount($) {
  let max = 1;
  $(".page-numbers").each((_, el) => {
    const n = parseInt($(el).text().replace(/[^0-9]/g, ""), 10);
    if (Number.isFinite(n) && n > max) max = n;
  });
  return max;
}

async function fetchArchive(term, taxonomy) {
  const cacheKey = `${taxonomy === "categories" ? "category" : "tag"}/${term.slug}`;
  const { html, fromCache } = await fetchHtml(term.link, cacheKey);
  if (!html) return { seo: null, archive_title: null, archive_pages: null, fromCache };

  const $ = cheerio.load(html);
  const seo = extractSeo($, term.link);
  // Category archives render <h1 class="archive-title">Category Archives: X</h1>.
  // Tag archives render no heading at all.
  const archive_title = trimOrNull($(".archive-title").first().text());

  // A taxonomy page's identity is its heading, or failing that the term name.
  // Never the raw <title>: on this site 163 archives render a NON-empty
  // <title> that is verbatim the title of one of their own listed posts —
  // the theme injects a post's SEO block while looping, and it leaks into the
  // archive head. extractSeo's own fallback chain ends at `.entry-title`,
  // which on an archive is likewise the first post's heading. Both are wrong
  // here, so resolve from the term itself.
  seo.meta_title_resolved = archive_title || term.name || null;

  return { seo, archive_title, archive_pages: archivePageCount($), fromCache };
}

// ---------- step D: assemble ----------

async function buildTaxonomy(taxonomy, membership) {
  const label = taxonomy === "categories" ? "category" : "tag";
  const terms = await fetchTerms(taxonomy);
  console.log(`[info] ${taxonomy}: ${terms.length} terms enumerated, fetching archive pages...`);

  const out = [];
  let done = 0;
  for (const term of terms) {
    const posts = membership.get(term.slug) || [];
    const { seo, archive_title, archive_pages, fromCache } = await fetchArchive(term, taxonomy);

    const issues = [];
    if (term.count === 0) issues.push("orphan_no_posts");
    if (term.count !== posts.length) issues.push("count_mismatch");
    if (!archive_title) issues.push("no_archive_heading");
    if (!seo) issues.push("archive_page_unavailable");
    else {
      if (seo.canonical === HOME || seo.og.title === GENERIC_OG_TITLE) {
        issues.push("rendered_seo_is_generic");
      }
      // A non-empty <title> on an archive is never the archive's own title
      // here — it is a listed post's title leaking out of the theme loop.
      if (seo.meta_title) issues.push("title_leaks_post_title");
    }

    out.push({
      id: term.id,
      name: term.name,
      slug: term.slug,
      taxonomy: label,
      parent: term.parent ?? 0,
      description: term.description || "",
      url: term.link,
      count: term.count,
      post_count_scraped: posts.length,
      archive_title,
      archive_pages,
      posts,
      seo,
      issues,
    });

    if (!fromCache) await sleep(REQUEST_DELAY_MS);
    if (++done % 50 === 0) console.log(`  [info] ${taxonomy}: ${done}/${terms.length}`);
  }
  return out;
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    outCategories: "ils_categories.json",
    outTags: "ils_tags.json",
    only: null,
    fromCache: false,
    refresh: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--out-categories":
        opts.outCategories = args[++i];
        break;
      case "--out-tags":
        opts.outTags = args[++i];
        break;
      case "--only":
        opts.only = args[++i];
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

function report(name, rows, outPath) {
  const tally = {};
  for (const r of rows) for (const k of r.issues) tally[k] = (tally[k] || 0) + 1;
  const posts = rows.reduce((s, r) => s + r.post_count_scraped, 0);
  console.log(`[done] ${rows.length} ${name} (${posts} memberships) -> ${outPath}`);
  console.log(`[${name}] issue tally:`, tally);
}

async function main() {
  const opts = parseArgs();
  cacheMode.fromCache = opts.fromCache;
  cacheMode.refresh = opts.refresh;
  if (opts.fromCache) console.log(`[info] --from-cache: reading from ${CACHE_DIR}, no network.`);
  if (opts.refresh) console.log("[info] --refresh: re-fetching everything, overwriting cache.");

  const membership = buildMembership();
  console.log(
    `[info] membership from cached listings: ${membership.postCount} posts, ` +
      `${membership.categories.size} categories, ${membership.tags.size} tags`
  );

  if (opts.only !== "tags") {
    const rows = await buildTaxonomy("categories", membership.categories);
    const p = path.resolve(process.cwd(), opts.outCategories);
    fs.writeFileSync(p, JSON.stringify(rows, null, 2), "utf-8");
    report("categories", rows, p);
  }
  if (opts.only !== "categories") {
    const rows = await buildTaxonomy("tags", membership.tags);
    const p = path.resolve(process.cwd(), opts.outTags);
    fs.writeFileSync(p, JSON.stringify(rows, null, 2), "utf-8");
    report("tags", rows, p);
  }
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
