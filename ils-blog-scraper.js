#!/usr/bin/env node
/**
 * ILS Hospitals Blog Scraper (Node.js)
 * ---------------------------------------------------------------
 * Crawls https://ilshospitals.com/blog/page/{N}/ listing pages,
 * then visits EVERY individual blog post page to pull:
 *   - title, slug, category {name, slug}, published_date,
 *     banner_image_url, content1 (listing excerpt),
 *     content2 (full article body, only if "Continue reading" existed),
 *     tags [{name, slug}]
 *   - FULL SEO block from the post's own <head>:
 *       meta_title, meta_description, canonical, robots,
 *       og:* tags, twitter:* tags, all <script type="application/ld+json">
 *       schemas (parsed as JSON, kept as an array since a page can have
 *       multiple ld+json blocks e.g. Organization/WebSite + BlogPosting)
 *
 * NOTE on this site's SEO: every post page ships TWO competing sets of meta
 * tags and ld+json. The AIOSEO plugin block comes first but is misconfigured
 * site-wide — it emits homepage values (og:title "Blog - ILS-Hospital",
 * og:url/canonical = homepage) on every post. The theme's own block comes
 * later and holds the correct post-specific og: and twitter: tags plus a
 * BlogPosting/MedicalOrganization/BreadcrumbList graph. og/twitter are
 * therefore resolved last-non-empty-wins, and `json_ld_by_source` keeps the
 * two apart. The site's <title> is empty and its canonical points at the
 * homepage; both are recorded as-is and mirrored into *_resolved fields,
 * with `seo_issues` flagging what was wrong.
 *
 * Requires: axios, cheerio
 *   npm install axios cheerio
 *
 * Usage:
 *   node ils-blog-scraper.js --start 47 --end 1 --out ils_blogs_v2.json
 *   node ils-blog-scraper.js --from-cache          # reparse cached HTML, no network
 *   node ils-blog-scraper.js --refresh             # re-fetch, overwrite cache
 *   node ils-blog-scraper.js --start 1 --end 5 --out sample.json --no-full-content
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
  extractSeo,
} = require("./scrape-lib");

const BASE = "https://ilshospitals.com/blog";

/**
 * Visit a single blog post page and extract full content + SEO/schema block.
 */
async function fetchPostDetails(postUrl, slug) {
  const { html, fromCache } = await fetchHtml(postUrl, `posts/${slug || slugFromUrl(postUrl)}`);
  if (!html) return { content: null, content2: null, seo: null, fromCache };

  const $ = cheerio.load(html);

  // Full article body (used as content2 when listing page was truncated)
  const contentDiv = $("article .entry-content").first();
  contentDiv.find("a.more-link").remove();
  const fullContent = contentDiv.length ? contentDiv.html().trim() : null;

  const seo = extractSeo($, postUrl);
  const normalized = normalizeHtmlWhitespace(fullContent);

  return { content: normalized, content2: normalized, seo, fromCache };
}

/**
 * Parse a single <article> block from a listing page.
 */
async function parseArticle($, articleEl, fetchFull) {
  const $article = $(articleEl);

  const titleAnchor = $article.find(".entry-title a").first();
  const title = titleAnchor.text().trim() || null;
  const postUrl = titleAnchor.attr("href") || null;
  const slug = slugFromUrl(postUrl);

  const catAnchor = $article.find(".cat-links a").first();
  const category = {
    name: catAnchor.text().trim() || null,
    slug: slugFromUrl(catAnchor.attr("href")),
  };

  const timeTag = $article.find("time.entry-date").first();
  const published_date = timeTag.attr("datetime") || timeTag.text().trim() || null;

  const imgTag = $article.find(".post-thumbnail img").first();
  const banner_image_url = imgTag.attr("src") || imgTag.attr("data-src") || null;

  const contentDiv = $article.find(".entry-content").first();
  const moreLink = contentDiv.find("a.more-link").first();
  const moreHref = moreLink.attr("href") || null;
  moreLink.remove();
  const content1 = normalizeHtmlWhitespace(contentDiv.length ? contentDiv.html().trim() : null);

  const tags = [];
  $article.find("footer .tag-links a").each((_, el) => {
    const $t = $(el);
    tags.push({ name: $t.text().trim(), slug: slugFromUrl($t.attr("href")) });
  });

  const post = {
    title,
    slug,
    category,
    published_date,
    banner_image_url,
    // All three are newline-normalized so they paste into an HTML viewer
    // cleanly. `content` is the one to render — the post page's own body,
    // always full. content1 is the listing excerpt (truncated on 13 posts);
    // content2 mirrors `content` but only when the listing was truncated.
    content: null,
    content1,
    content2: null,
    tags,
    seo: null,
    post_url: postUrl,
  };

  // Always visit the inner page (needed for full SEO + json_ld + canonical).
  if (postUrl && fetchFull) {
    const { content, content2, seo, fromCache } = await fetchPostDetails(postUrl, slug);
    if (!fromCache) await sleep(REQUEST_DELAY_MS);
    post.seo = seo;
    post.content = content;
    // Only use fetched content2 if listing page indicated truncation ("Continue reading")
    post.content2 = moreHref ? content2 : null;
  }

  return post;
}

async function scrapeListingPage(pageNum, fetchFull) {
  const url = pageNum > 1 ? `${BASE}/page/${pageNum}/` : `${BASE}/`;
  console.log(`[info] Fetching listing page ${pageNum}: ${url}`);
  const { html } = await fetchHtml(url, `listing/page-${pageNum}`);
  if (!html) {
    console.log(`[info] Page ${pageNum} not found / empty, skipping.`);
    return [];
  }

  const $ = cheerio.load(html);
  const articles = $('article[id^="post-"]').toArray();
  if (!articles.length) {
    console.log(`[info] No articles found on page ${pageNum}.`);
    return [];
  }

  const results = [];
  for (const el of articles) {
    try {
      const post = await parseArticle($, el, fetchFull);
      results.push(post);
    } catch (e) {
      console.error(`  [error] failed to parse an article on page ${pageNum}: ${e.message}`);
    }
  }
  return results;
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { start: 1, end: 47, out: "ils_blogs_v2.json", fetchFull: true, fromCache: false, refresh: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--start":
        opts.start = parseInt(args[++i], 10);
        break;
      case "--end":
        opts.end = parseInt(args[++i], 10);
        break;
      case "--out":
        opts.out = args[++i];
        break;
      case "--no-full-content":
        opts.fetchFull = false;
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
  const { start, end, out, fetchFull, fromCache, refresh } = parseArgs();
  cacheMode.fromCache = fromCache;
  cacheMode.refresh = refresh;
  if (fromCache) console.log(`[info] --from-cache: reading HTML from ${CACHE_DIR}, no network.`);
  if (refresh) console.log("[info] --refresh: re-fetching every page, overwriting cache.");

  const allPosts = [];

  const pages = [];
  if (start <= end) {
    for (let p = start; p <= end; p++) pages.push(p);
  } else {
    for (let p = start; p >= end; p--) pages.push(p);
  }

  for (const pageNum of pages) {
    const posts = await scrapeListingPage(pageNum, fetchFull);
    allPosts.push(...posts);
    if (!fromCache) await sleep(REQUEST_DELAY_MS);
  }

  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(allPosts, null, 2), "utf-8");

  // Summary of the SEO defects this run observed, so problems stay visible.
  const tally = {};
  for (const p of allPosts) for (const k of (p.seo && p.seo.seo_issues) || []) tally[k] = (tally[k] || 0) + 1;
  console.log(`[done] Scraped ${allPosts.length} posts -> ${outPath}`);
  console.log("[seo]  issue tally:", tally);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
