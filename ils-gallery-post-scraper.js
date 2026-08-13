#!/usr/bin/env node
/**
 * ILS Hospitals Gallery *Post* Scraper (Node.js)
 * ---------------------------------------------------------------
 * Extracts the 85 `gallery` CPT detail pages
 *   https://ilshospitals.com/gallery/<slug>/
 * into JSON (default ils_gallery_posts.json).
 *
 * NOT ils-gallery-scraper.js. "Gallery" on this site is TWO different things
 * wearing the same name, and this repo now has one scraper for each:
 *
 *   /gallery/          a single static `page-template-gallery` page  -> ils-gallery-scraper.js
 *   /gallery/<slug>/   a WordPress CPT, 85 posts                     -> this file
 *
 * They are not unrelated, though — the static page IS the CPT's archive,
 * rendered by featured image. Verified against the live site:
 *
 *   WP REST /wp/v2/gallery  ............................ 85 posts
 *   ils_sitemap.json "Gallery" section ................. 85 URLs, 0 delta both ways
 *   ils_gallery.json card `src` set vs featured `source_url` set ... identical, 0 either way
 *   every static card row resolvable to a CPT post ..... 85 / 85
 *
 * So the join is BY FEATURED IMAGE, press/media- and awards-style (card
 * `<img src>` == the media `source_url`), never by title: the card's
 * `data-title` IS the post title verbatim, but titles duplicate — two posts
 * are both titled "Cathlab" (slugs `cathlab` / `cathlab-2`) — so a title join
 * would silently collapse them.
 *
 * ONE IMAGE IS SHARED BY TWO POSTS. `featured_media: 16536` backs both
 * `glimpse-from-the-grand-opening-of-ils-hospitals-raipur-6` and `-14`, which
 * is why the static page renders 85 card rows over only 84 distinct srcs, and
 * why a batched media call returns 84 records for 85 posts. src -> post is
 * therefore 1:N for that one pair; it is resolved by walking the static page's
 * cards in document order and consuming each src's posts in REST order, and
 * both records are flagged `featured_image_shared_with_sibling`.
 *
 * REST EXPOSES NO BODY. `content` and `excerpt` are absent from the response
 * entirely for this CPT (as with `faq-lists`) and `acf` is `[]` on all 85 —
 * there is nothing to read but title / date / featured_media. The HTML has no
 * body copy either, so `no_body_content` fires on every record; `content_html`
 * is still emitted so a future page with real copy is captured, not dropped.
 *
 * PAGE SHAPE. `<body class="wp-singular gallery-template-default single
 * single-gallery postid-NNNNN ...">` — the blog single template, reused:
 *   - `section.page-banner` — a `<span>` breadcrumb hardcoded
 *     "Home - Blogs - <title>" (a /blog/ link on a gallery post: wrong on all
 *     85, like the job pages' hardcoded breadcrumb) plus an `<h2>` title.
 *   - `section.blog-sec.csr-sec-for-page.comm-section > .col-lg-9` — the
 *     featured `<img>` (src byte-identical to the media `source_url`, no
 *     resize), `.blog-info` with "ILS Editor" + a date matching REST `date`,
 *     then `.blog-para > h3` which is the title AGAIN and nothing else.
 *   - `.col-lg-3` — a sidebar that is byte-identical on every page: a "Latest
 *     Blogs" list of the three lorem-ipsum `/blog-1..3/` placeholder stubs and
 *     a "Categories" list of `category-1` / `category-2`. Boilerplate, so it is
 *     stored ONCE at the top level as `blog_sidebar_boilerplate` and only
 *     fingerprinted per page (`sidebar_boilerplate_differs`).
 *
 * SEO. A single AIOSEO block (`script.aioseo-schema`, an `@graph` carrying the
 * BreadcrumbList), no theme block — so `no_post_specific_schema` /
 * `no_post_specific_meta` are structural here and are dropped from the tally,
 * exactly as ils-gallery-scraper.js and ils-press-media-scraper.js do. The
 * canonical is self-referential and correct. `og:image` is the generic
 * /2023/10/logo.png rather than the post's own featured image, and there is no
 * meta description, no og:description, no twitter:description and no
 * twitter:url anywhere. Every one of the 84 media records has empty alt text.
 *
 * Requires: axios, cheerio (npm install axios cheerio)
 *
 * Usage:
 *   node ils-gallery-post-scraper.js                      # all -> ils_gallery_posts.json
 *   node ils-gallery-post-scraper.js --slug caho-olympiad-winners
 *   node ils-gallery-post-scraper.js --limit 5
 *   node ils-gallery-post-scraper.js --from-list gallery_posts.json
 *   node ils-gallery-post-scraper.js --index-only         # pass 1 only -> gallery_posts.json
 *   node ils-gallery-post-scraper.js --from-cache         # reparse cached HTML, no network
 *   node ils-gallery-post-scraper.js --refresh            # re-fetch, overwrite cache
 */

const cheerio = require("cheerio");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  REQUEST_DELAY_MS,
  CACHE_DIR,
  cacheMode,
  sleep,
  normalizeHtmlWhitespace,
  fetchHtml,
  fetchJson,
  trimOrNull,
  extractBreadcrumbs,
  extractSeo,
} = require("./scrape-lib");

const SITE_ORIGIN = "https://ilshospitals.com";
const REST_URL =
  "https://ilshospitals.com/wp-json/wp/v2/gallery?per_page=100&orderby=date&order=desc" +
  "&_fields=id,slug,link,date,modified,status,title,featured_media";
const MEDIA_URL = "https://ilshospitals.com/wp-json/wp/v2/media";
const SITEMAP_FILE = "ils_sitemap.json";
const GALLERY_PAGE_FILE = "ils_gallery.json";
const SITEMAP_SECTION = "Gallery";

const collapse = (s) => (s || "").replace(/\s+/g, " ").trim() || null;

/**
 * REST hands back entity-encoded titles ("Together, we heal &#8211; ...") while
 * the page renders the decoded text, so both halves of a record are kept in the
 * same alphabet.
 */
const decodeHtml = (s) => collapse(s ? cheerio.load(`<x>${s}</x>`)("x").text() : null);

function absoluteUrl(href) {
  if (!href) return null;
  const h = (href || "").trim();
  if (!h || h === "#") return null;
  try {
    return new URL(h, SITE_ORIGIN).href;
  } catch (e) {
    return h;
  }
}

/** The breadcrumb the page actually renders, in the banner. */
function extractVisibleBreadcrumb($, banner) {
  const span = banner
    .find("span")
    .filter((_, el) => $(el).find("a").length > 0)
    .first();
  if (!span.length) return [];
  const crumbs = [];
  span.children("a").each((_, el) => {
    crumbs.push({ name: collapse($(el).text()), url: absoluteUrl($(el).attr("href")) });
  });
  const current = collapse(span.children("strong").first().text());
  if (current) crumbs.push({ name: current, url: null });
  return crumbs;
}

const fingerprint = (s) =>
  s ? crypto.createHash("sha1").update(s).digest("hex").slice(0, 16) : null;

/** Fold a WP media record into the compact image block kept on each entry. */
function buildImage(media, srcFallback) {
  if (!media) {
    return srcFallback
      ? {
          media_id: null,
          src: srcFallback,
          alt: null,
          media_title: null,
          mime_type: null,
          width: null,
          height: null,
          filename: null,
          uploaded_date: null,
          shared_with: [],
        }
      : null;
  }
  const d = media.media_details || {};
  return {
    media_id: media.id,
    src: media.source_url || srcFallback || null,
    alt: trimOrNull(media.alt_text),
    media_title: collapse(media.title && media.title.rendered),
    mime_type: media.mime_type || null,
    width: d.width ?? null,
    height: d.height ?? null,
    filename: d.file ? d.file.split("/").pop() : null,
    uploaded_date: media.date || null,
    shared_with: [],
  };
}

// ---------- pass 1: WP REST, plus the two cross-checks ----------

/**
 * One batched /wp/v2/media call per 100 featured-media ids -> Map(id -> media).
 * 84 distinct ids fit in a single call today, but the CPT grows.
 */
async function loadMedia(ids) {
  const byId = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const url =
      `${MEDIA_URL}?include=${chunk.join(",")}&per_page=100` +
      "&_fields=id,source_url,alt_text,title,mime_type,date,media_details";
    const { data } = await fetchJson(url, `api/gallery-media-${i / 100 + 1}`);
    if (!Array.isArray(data)) continue;
    for (const m of data) byId.set(m.id, m);
  }
  console.log(`[info] media: ${byId.size}/${unique.length} distinct featured images resolved`);
  return byId;
}

/** Read a sibling dataset, degrading to a warning so this scraper stands alone. */
function readDataset(file, what) {
  const p = path.resolve(process.cwd(), file);
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    console.log(`[warn] ${file} not readable (${e.code || e.message}) — skipping the ${what}.`);
    return null;
  }
}

/** Diff the REST post list against ils_sitemap.json's "Gallery" section. */
function auditSitemap(list) {
  const data = readDataset(SITEMAP_FILE, "sitemap cross-check");
  if (!data) return { present: false, reason: "dataset_missing" };
  const section = (data.sections || []).find((s) => s.category === SITEMAP_SECTION);
  if (!section) {
    console.log(`[warn] ${SITEMAP_FILE} has no "${SITEMAP_SECTION}" section — skipping.`);
    return { present: false, reason: "section_missing" };
  }

  const entries = section.entries || [];
  const bySlug = new Map();
  for (const e of entries) if (e.slug && !bySlug.has(e.slug)) bySlug.set(e.slug, e);
  for (const item of list) {
    const e = bySlug.get(item.slug);
    item.sitemap_position = e ? e.position ?? null : null;
    item.sitemap_global_position = e ? e.global_position ?? null : null;
    item.in_sitemap = Boolean(e);
  }

  const restUrls = new Set(list.map((i) => i.url));
  const smUrls = new Set(entries.map((e) => e.url));
  const inRestNotSitemap = [...restUrls].filter((u) => !smUrls.has(u));
  const inSitemapNotRest = [...smUrls].filter((u) => !restUrls.has(u));
  const agrees = !inRestNotSitemap.length && !inSitemapNotRest.length;
  console.log(
    `[info] sitemap: ${entries.length} URLs vs ${list.length} REST posts — ` +
      (agrees ? "exact match" : `${inRestNotSitemap.length}/${inSitemapNotRest.length} delta`)
  );
  return {
    present: true,
    agrees,
    sitemap_count: entries.length,
    rest_count: list.length,
    in_rest_not_in_sitemap: inRestNotSitemap,
    in_sitemap_not_in_rest: inSitemapNotRest,
  };
}

/**
 * Attach each post's row on the static /gallery/ page, matching by featured
 * image. Cards are walked in document order and each src's posts consumed in
 * REST order, so the one src backing two posts (media 16536) resolves
 * deterministically instead of both posts claiming the first card.
 */
function auditGalleryPage(list) {
  const data = readDataset(GALLERY_PAGE_FILE, "gallery-page cross-check");
  if (!data || !Array.isArray(data.images)) {
    if (data) console.log(`[warn] ${GALLERY_PAGE_FILE} has no images[] — skipping.`);
    return { present: false, reason: "dataset_missing" };
  }

  const bySrc = new Map();
  for (const item of list) {
    const src = item.featured_image && item.featured_image.src;
    if (!src) continue;
    if (!bySrc.has(src)) bySrc.set(src, []);
    bySrc.get(src).push(item);
  }
  // Posts sharing one image: record the sibling slugs on both records.
  for (const posts of bySrc.values()) {
    if (posts.length < 2) continue;
    for (const p of posts) {
      p.featured_image.shared_with = posts.filter((o) => o !== p).map((o) => o.slug);
    }
  }

  const queues = new Map([...bySrc].map(([src, posts]) => [src, posts.slice()]));
  const unmatchedCards = [];
  for (const img of data.images) {
    const queue = queues.get(img.src);
    const post = queue && queue.length ? queue.shift() : null;
    if (!post) {
      unmatchedCards.push({ position: img.position ?? null, src: img.src, title: img.title ?? null });
      continue;
    }
    post.gallery_page_position = img.position ?? null;
    post.gallery_page_title = img.title ?? null;
  }

  const matched = list.filter((i) => i.gallery_page_position != null).length;
  const unmatchedPosts = list.filter((i) => i.gallery_page_position == null).map((i) => i.slug);
  console.log(
    `[info] gallery page: ${matched}/${list.length} posts matched a card ` +
      `(${data.images.length} cards, ${unmatchedCards.length} unmatched)`
  );
  return {
    present: true,
    agrees: !unmatchedCards.length && !unmatchedPosts.length,
    card_count: data.images.length,
    post_count: list.length,
    matched_count: matched,
    cards_without_post: unmatchedCards,
    posts_without_card: unmatchedPosts,
    shared_featured_images: [...bySrc]
      .filter(([, posts]) => posts.length > 1)
      .map(([src, posts]) => ({
        src,
        media_id: posts[0].featured_image.media_id,
        slugs: posts.map((p) => p.slug),
      })),
  };
}

/**
 * Resolve the list of gallery posts to visit. WP REST is authoritative for
 * which posts exist (it is also the only source of id / date / featured_media,
 * none of which the sitemap carries); --from-list replays a prior index.
 */
async function loadGalleryList(fromList) {
  if (fromList) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), fromList), "utf-8"));
    console.log(`[info] gallery list from ${fromList}: ${raw.length} entries`);
    return { list: raw, sitemapAudit: null, galleryPageAudit: null };
  }

  const { data } = await fetchJson(REST_URL, "api/gallery-posts");
  if (!Array.isArray(data) || !data.length) {
    throw new Error(`could not load the gallery post list from ${REST_URL}`);
  }

  const media = await loadMedia(data.map((d) => d.featured_media));
  const list = data.map((d) => ({
    id: d.id ?? null,
    slug: d.slug,
    url: d.link || `${SITE_ORIGIN}/gallery/${d.slug}/`,
    title: decodeHtml(d.title && d.title.rendered),
    status: d.status || null,
    published_date: d.date || null,
    modified_date: d.modified || null,
    featured_media_id: d.featured_media || null,
    featured_image: buildImage(media.get(d.featured_media) || null, null),
    gallery_page_position: null,
    gallery_page_title: null,
    sitemap_position: null,
    sitemap_global_position: null,
    in_sitemap: null,
  }));

  const sitemapAudit = auditSitemap(list);
  const galleryPageAudit = auditGalleryPage(list);
  console.log(`[info] gallery list from REST: ${list.length} entries`);
  return { list, sitemapAudit, galleryPageAudit };
}

// ---------- pass 2: a /gallery/<slug>/ page ----------

function scrapeGalleryPost(html, entry) {
  const $ = cheerio.load(html);
  const url = entry.url;

  // WP stamps the post id on <body class="... postid-17112 ...">; rel=shortlink
  // carries the same id and backs it up if the class is ever dropped.
  const bodyClass = $("body").attr("class") || "";
  const classMatch = bodyClass.match(/\bpostid-(\d+)\b/);
  const shortMatch = ($('link[rel="shortlink"]').attr("href") || "").match(/[?&]p=(\d+)/);
  const pageId = classMatch ? Number(classMatch[1]) : shortMatch ? Number(shortMatch[1]) : null;

  const banner = $("section.page-banner").first();
  const heading = collapse(banner.find("h2").first().text());

  const body = $("section.blog-sec").first();
  const main = body.find(".col-lg-9").first();
  const detailImageSrc = absoluteUrl(main.find("img").first().attr("src"));
  const info = main
    .find(".blog-info p")
    .map((_, el) => collapse($(el).text()))
    .get();
  const [author, displayDate] = [info[0] || null, info[1] || null];

  // .blog-para is the post body: an <h3> repeat of the title and, on every page
  // observed, nothing after it. The h3 is stripped so `content_html` is the
  // actual copy — empty today, populated if the site ever writes any.
  const para = main.find(".blog-para").first();
  const bodyHeading = collapse(para.find("h3").first().text());
  const paraClone = para.clone();
  paraClone.find("h3").first().remove();
  const contentHtml = normalizeHtmlWhitespace(paraClone.html() || "") || null;
  const contentText = collapse(paraClone.text());

  const sidebarHtml = normalizeHtmlWhitespace(body.find(".col-lg-3").first().html() || "") || null;

  const seo = extractSeo($, url);
  seo.breadcrumbs = extractBreadcrumbs(seo.json_ld); // BreadcrumbList lives in the AIOSEO @graph
  const breadcrumb = extractVisibleBreadcrumb($, banner);

  // Gallery-specific defects, layered on extractSeo's own list. The two
  // no_post_specific_* codes are structural for this post type (there is no
  // theme block at all), so they are dropped here to keep the tally meaningful.
  const issues = seo.seo_issues.filter(
    (c) => c !== "no_post_specific_schema" && c !== "no_post_specific_meta"
  );
  const featuredSrc = entry.featured_image && entry.featured_image.src;
  if (seo.og.image && /\/logo\.[a-z]+$/i.test(seo.og.image)) issues.push("og_image_generic_logo");
  if (seo.og.image && featuredSrc && seo.og.image !== featuredSrc)
    issues.push("og_image_ignores_featured_image");
  if (!seo.meta_description) issues.push("missing_meta_description");
  if (!seo.og.description) issues.push("missing_og_description");
  if (!seo.twitter.description) issues.push("missing_twitter_description");
  if (!seo.twitter.url) issues.push("missing_twitter_url");
  if (breadcrumb.some((c) => c.url && /\/blog\/?$/.test(c.url)))
    issues.push("breadcrumb_points_to_blog");
  if (!contentText) issues.push("no_body_content");
  if (bodyHeading && entry.title && bodyHeading === entry.title)
    issues.push("title_duplicated_in_heading");
  if (!entry.title) issues.push("missing_title");
  if (!featuredSrc) issues.push("no_featured_image");
  if (entry.featured_image && !entry.featured_image.alt) issues.push("featured_image_missing_alt");
  if (entry.featured_image && (entry.featured_image.shared_with || []).length)
    issues.push("featured_image_shared_with_sibling");
  if (featuredSrc && detailImageSrc && featuredSrc !== detailImageSrc)
    issues.push("detail_image_differs_from_featured_media");
  if (entry.id != null && pageId != null && entry.id !== pageId) issues.push("id_mismatch_with_rest");
  if (entry.in_sitemap === false) issues.push("not_in_sitemap");
  if (entry.gallery_page_position == null) issues.push("not_on_gallery_page");
  seo.seo_issues = issues;

  return {
    id: pageId ?? entry.id ?? null,
    slug: entry.slug,
    title: entry.title,
    url,
    heading,
    body_heading: bodyHeading,
    status: entry.status,
    published_date: entry.published_date,
    modified_date: entry.modified_date,
    display_date: displayDate,
    author,
    breadcrumb,
    featured_image: entry.featured_image,
    detail_image_src: detailImageSrc,
    content_html: contentHtml,
    content_text: contentText,
    gallery_page_position: entry.gallery_page_position ?? null,
    gallery_page_title: entry.gallery_page_title ?? null,
    sitemap_position: entry.sitemap_position ?? null,
    sitemap_global_position: entry.sitemap_global_position ?? null,
    sidebar_html: sidebarHtml,
    seo,
    seo_issues: issues,
  };
}

/**
 * The .col-lg-3 sidebar is the same boilerplate on every page, so it is lifted
 * out of the records into a single top-level copy; any page that disagrees
 * keeps its own and is flagged.
 */
function foldSidebar(posts) {
  const counts = new Map();
  for (const p of posts) {
    if (!p.sidebar_html) continue;
    const fp = fingerprint(p.sidebar_html);
    counts.set(fp, (counts.get(fp) || 0) + 1);
  }
  let common = null;
  let best = 0;
  for (const [fp, n] of counts) if (n > best) [common, best] = [fp, n];

  let boilerplate = null;
  for (const p of posts) {
    const fp = fingerprint(p.sidebar_html);
    if (fp === common) {
      if (!boilerplate) boilerplate = { fingerprint: fp, page_count: best, html: p.sidebar_html };
      delete p.sidebar_html;
    } else {
      p.sidebar_fingerprint = fp;
      p.seo_issues.push("sidebar_boilerplate_differs");
      if (p.seo) p.seo.seo_issues = p.seo_issues;
    }
  }
  return boilerplate;
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    out: "ils_gallery_posts.json",
    indexOut: "gallery_posts.json",
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
  if (fromCache) console.log(`[info] --from-cache: reading HTML from ${CACHE_DIR}, no network.`);
  if (refresh) console.log("[info] --refresh: re-fetching every page, overwriting cache.");

  const { list: all, sitemapAudit, galleryPageAudit } = await loadGalleryList(fromList);
  let list = all;
  if (slug) list = list.filter((e) => e.slug === slug);
  if (limit) list = list.slice(0, limit);
  if (!list.length) {
    console.error("[error] no gallery posts matched.");
    process.exit(1);
  }

  // Write the small pass-1 index (unless we're replaying one).
  if (!fromList) {
    const indexPath = path.resolve(process.cwd(), indexOut);
    fs.writeFileSync(indexPath, JSON.stringify(all, null, 2), "utf-8");
    console.log(`[info] pass 1: ${all.length} gallery posts -> ${indexPath}`);
  }
  if (indexOnly) {
    console.log("[done] --index-only: stopping after pass 1.");
    return;
  }

  const posts = [];
  for (const entry of list) {
    console.log(`[info] Fetching gallery post: ${entry.url}`);
    // The static page caches as gallery/_page, so slug keys never collide.
    const { html, fromCache: cached } = await fetchHtml(entry.url, `gallery/${entry.slug}`);
    if (!html) {
      console.error(`  [error] no HTML for ${entry.url}`);
      continue;
    }
    try {
      posts.push(scrapeGalleryPost(html, entry));
    } catch (e) {
      console.error(`  [error] failed to parse ${entry.url}: ${e.message}`);
    }
    if (!cached) await sleep(REQUEST_DELAY_MS);
  }

  const blog_sidebar_boilerplate = foldSidebar(posts);

  const issue_tallies = {};
  for (const p of posts) for (const k of p.seo_issues || []) issue_tallies[k] = (issue_tallies[k] || 0) + 1;

  const result = {
    url_source: "wp_rest",
    rest_url: REST_URL,
    post_count: posts.length,
    posts,
    blog_sidebar_boilerplate,
    sitemap_audit: sitemapAudit,
    gallery_page_audit: galleryPageAudit,
    issue_tallies,
  };
  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");

  console.log(`[done] Scraped ${posts.length}/${list.length} gallery posts -> ${outPath}`);
  console.log("[seo]  issue tally:", issue_tallies);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
