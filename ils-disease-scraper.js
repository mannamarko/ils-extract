#!/usr/bin/env node
/**
 * ILS Hospitals Disease Scraper (Node.js)
 * ---------------------------------------------------------------
 * One pass over every https://ilshospitals.com/disease/<slug>/ page.
 *
 * There is NO hub page to crawl: https://ilshospitals.com/disease/ returns a
 * 500, and the theme renders the breadcrumb's "Disease" crumb as plain text
 * with the <a> commented out, precisely because the archive does not exist.
 * The slug list therefore comes from the WP REST collection for the `disease`
 * custom post type (rest_base is the SINGULAR "disease", confirmed against
 * /wp-json/wp/v2/types), with `diseaseList.md` kept as an optional --from-list
 * filter. REST also supplies the clean post title, the post id and the
 * published/modified dates; it does NOT expose `content` for this CPT, which
 * is why the body still has to be parsed out of the rendered HTML.
 *
 * WATCH THE COUNTS. `diseaseList.md` holds 31 URLs but the CPT reports
 * X-WP-Total: 50 — 19 posts (kyphosis, endometriosis, uterine-fibroids,
 * pre-eclampsia, ...) are simply absent from that hand-written list.
 * `reconcileListWithRest` warns in both directions rather than silently
 * emitting whichever number happens to be smaller. Remember also that the
 * .cache never expires, so a plain re-run is a replay: use --refresh when the
 * question is "what does the site say today".
 *
 * Page template — identical to key-procedure and department detail pages, and
 * verified byte-for-byte across bladder-cancer, parkinsons-disease,
 * lung-cancer-2 and retinoblastoma:
 *
 *   main.ILS-key-treatment-procedure
 *     section.page-banner                       h2 = the visible title
 *     section.bg-center-list-details
 *       div.center-details.dtls-treatment...    <- the only per-disease markup
 *       div.center-details.other-random-list    <- sidebar
 *     section.video-testimonial
 *     section.bg-faq
 *
 * The body is picked with `.center-details.dtls-treatment` and not `.first()`
 * on `.center-details` alone: the sidebar carries the same class, so the
 * looser selector is one theme tweak away from capturing the wrong column.
 *
 * Body markup is a small, closed vocabulary — <p> <h2> <ul> <li> <a> <strong>
 * <br> — so `normalizeHtmlWhitespace` is rendering-identical here. Absolute
 * https://ilshospitals.com/... hrefs inside the body are rewritten to
 * site-relative paths so the migrated frontend does not link visitors back to
 * the site it replaces; `content_live` keeps the untouched original.
 *
 * DELIBERATELY SKIPPED, do not "fix" these back in:
 *   - section.video-testimonial and the sidebar's Salesforce lead form, which
 *     are byte-identical site-wide;
 *   - the banner's "Find a Doctor" / "Book Appointment" buttons, likewise;
 *   - the bg-faq card section. Unlike key-procedure pages these cards did NOT
 *     vary across repeated fetches, but they are still site-wide furniture
 *     rather than disease data, so they are not captured. The head's FAQPage
 *     ld+json IS kept, because `extractSeo` captures every ld+json block
 *     verbatim and dropping one would misreport what the page emits.
 *   - the sidebar's .find-expert-doctor-box, which ships with `d-none` and an
 *     empty <img src="">.
 *
 * NOTE on this site's SEO: disease pages ship TWO page-specific meta blocks in
 * the same order as department and key-procedure pages — the theme's first,
 * AIOSEO's second — so shared `extractSeo`'s last-non-empty-wins resolution
 * yields the AIOSEO values. That is right for title/description/canonical but
 * wrong for og:image, where AIOSEO overwrites the real specialty artwork with
 * the generic site logo, and the theme's own twitter:url is the placeholder
 * https://metatags.io/. `seo.og_theme` / `seo.twitter_theme` therefore keep
 * the first-wins (theme) reading alongside. There are FOUR ld+json blocks: the
 * theme's MedicalCondition (promoted to seo.medical_condition), a
 * MedicalOrganization, the generic FAQPage, and the AIOSEO @graph — and the
 * BreadcrumbList lives in that @graph, not in the theme block, so breadcrumbs
 * are read from every block rather than from json_ld_by_source.post.
 *
 * KNOWN CONTENT DEFECTS this scraper reports rather than repairs:
 *   - /disease/parkinsons-disease/ ships a <title> copy-pasted from the brain
 *     tumour page ("Brain Tumor Treatment in Dumdum, ..."), flagged as
 *     meta_title_mismatches_page_subject;
 *   - lung-cancer / lung-cancer-2 and prostate-cancer / prostate-cancer-2 are
 *     near-duplicate pages, flagged as duplicate_disease_page;
 *   - some bodies open with their own <h2> repeating the banner title
 *     (parkinsons-disease, lung-cancer-2) and some do not (bladder-cancer,
 *     retinoblastoma). That is how the pages render live. Do not normalize it.
 *
 * Requires: axios, cheerio
 *   npm install axios cheerio
 *
 * Usage:
 *   node ils-disease-scraper.js                          # all 50 -> ils_diseases.json
 *   node ils-disease-scraper.js --slug bladder-cancer --out one.json
 *   node ils-disease-scraper.js --limit 5
 *   node ils-disease-scraper.js --from-list diseaseList.md   # only the 31 listed
 *   node ils-disease-scraper.js --from-cache             # reparse cached HTML, no network
 *   node ils-disease-scraper.js --refresh                # re-fetch, overwrite cache
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
  findNode,
  trimOrNull,
  extractBreadcrumbs,
  extractSeo,
} = require("./scrape-lib");

const SITE_ORIGIN = "https://ilshospitals.com";
const REST_URL =
  "https://ilshospitals.com/wp-json/wp/v2/disease?per_page=100&_fields=id,slug,link,date,modified,title";
const DEFAULT_LIST = "diseaseList.md";

const collapse = (s) => (s || "").replace(/\s+/g, " ").trim() || null;

/** WP renders titles with entities (&#8217;); the DB wants them as-is, so only
 *  the handful the theme actually emits in <title> tags are decoded. */
function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&#8217;/g, "’")
    .replace(/&#8216;/g, "‘")
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&#215;/g, "×")
    .replace(/&amp;/g, "&");
}

// ---------- source list ----------

/** Pull every https://ilshospitals.com URL out of a markdown list, in order,
 *  deduped. Regex-based, so both bare URLs and [text](url) links work. */
function readUrlList(file) {
  const text = fs.readFileSync(path.resolve(process.cwd(), file), "utf-8");
  const matches = text.match(/https:\/\/ilshospitals\.com\S*/g) || [];
  const seen = new Set();
  const urls = [];
  for (const raw of matches) {
    const url = raw.trim().replace(/[)\]"'.,;]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

async function loadDiseaseList() {
  const { data } = await fetchJson(REST_URL, "api/disease");
  if (!Array.isArray(data) || !data.length) {
    throw new Error(
      "WP REST returned no disease posts; re-run with --refresh, or pass --from-list diseaseList.md"
    );
  }
  console.log(`[info] disease list from WP REST: ${data.length} entries`);
  return data.map((d) => ({
    id: d.id,
    slug: d.slug,
    url: d.link,
    title: decodeEntities(collapse(d.title && d.title.rendered)),
    published_date: d.date || null,
    modified_date: d.modified || null,
  }));
}

/**
 * The hand-written list and the CPT drift apart silently — the list is 31 URLs
 * and the CPT is 50 posts. Report both directions; never pick a winner.
 */
function reconcileListWithRest(listFile, restBySlug) {
  const issues = [];
  let listSlugs;
  try {
    listSlugs = new Set(readUrlList(listFile).map((u) => slugFromUrl(u)).filter(Boolean));
  } catch (e) {
    console.warn(`[warn] could not read ${listFile}: ${e.message}`);
    return issues;
  }

  const missingFromList = [...restBySlug.keys()].filter((s) => !listSlugs.has(s));
  const missingFromRest = [...listSlugs].filter((s) => !restBySlug.has(s));

  if (missingFromList.length) {
    issues.push(`rest_missing_from_list (${missingFromList.length})`);
    console.warn(
      `[warn] ${missingFromList.length} CPT posts absent from ${listFile}: ${missingFromList.join(", ")}`
    );
  }
  if (missingFromRest.length) {
    issues.push(`list_missing_from_rest (${missingFromRest.length})`);
    console.warn(
      `[warn] ${missingFromRest.length} ${listFile} URLs with no CPT post: ${missingFromRest.join(", ")}`
    );
  }
  if (!issues.length) {
    console.log(`[info] ${listFile} and REST agree on all ${restBySlug.size} diseases.`);
  }
  return issues;
}

// ---------- detail page parsing ----------

/** First-non-empty-wins over the meta tags — i.e. the theme's earlier block. */
function resolveFirst(metaAll, key) {
  for (const m of metaAll) {
    if (m.key.toLowerCase() === key && m.content && m.content.trim()) return m.content;
  }
  return null;
}

/** Last-non-empty-wins, matching `extractSeo`'s own resolution. */
function resolveLast(metaAll, key) {
  let val = null;
  for (const m of metaAll) {
    if (m.key.toLowerCase() === key && m.content && m.content.trim()) val = m.content;
  }
  return val;
}

/** Flatten the theme's MedicalCondition ld+json node. */
function extractMedicalCondition(blocks) {
  const mc = findNode(blocks, "MedicalCondition");
  if (!mc) return null;
  return {
    name: trimOrNull(mc.name),
    alternate_name: trimOrNull(mc.alternateName),
    description: trimOrNull(mc.description),
    url: trimOrNull(mc.url),
  };
}

/** The breadcrumb the page actually renders, in the banner. On disease pages
 *  the middle "Disease" crumb is bare text — the theme comments its <a> out —
 *  so it is recovered from the <span>'s own text rather than from a child <a>. */
function extractVisibleBreadcrumb($, banner) {
  const span = banner
    .find("span")
    .filter((_, el) => $(el).find("a").length > 0)
    .first();
  if (!span.length) return [];
  const crumbs = [];
  span.children("a").each((_, el) => {
    crumbs.push({ name: collapse($(el).text()), url: $(el).attr("href") || null });
  });
  const middle = collapse(
    span
      .text()
      .replace(collapse(span.children("a").first().text()) || "", "")
      .replace(collapse(span.children("strong").first().text()) || "", "")
      .replace(/[-–\s]+/g, " ")
  );
  if (middle) crumbs.push({ name: middle, url: null });
  const current = collapse(span.children("strong").first().text());
  if (current) crumbs.push({ name: current, url: null });
  return crumbs;
}

/**
 * Rewrite absolute on-site hrefs to site-relative paths, so the migrated
 * frontend keeps visitors on itself. Left alone deliberately: /wp-content/
 * asset URLs are already handled by the frontend's own rewrite, and off-site
 * links must stay absolute.
 */
function relativizeSiteLinks(html) {
  if (!html) return html;
  return html.replace(
    /(\s(?:href|src)=")https:\/\/ilshospitals\.com(\/[^"]*)?"/g,
    (_m, attr, rest) => `${attr}${rest || "/"}"`
  );
}

function scrapeDisease(html, entry) {
  const $ = cheerio.load(html);
  const url = entry.url;
  const issues = [];

  // WP stamps the post id on <body class="... postid-17617 ...">; rel=shortlink
  // carries the same id and backs it up when a theme change drops the class.
  const bodyClass = $("body").attr("class") || "";
  const classMatch = bodyClass.match(/\bpostid-(\d+)\b/);
  const shortlink = $('link[rel="shortlink"]').attr("href") || "";
  const shortMatch = shortlink.match(/[?&]p=(\d+)/);
  const id = classMatch ? Number(classMatch[1]) : shortMatch ? Number(shortMatch[1]) : null;

  // The banner also carries four <h3> hospital names, so scope to the first h2.
  const banner = $("section.page-banner").first();
  const bannerTitle = collapse(banner.find("h2").first().text());

  // Two .center-details divs exist (body + sidebar), so .dtls-treatment is
  // required to pick the body — .first() alone would be fragile.
  const body = $(".center-details.dtls-treatment").first();
  const contentLive = normalizeHtmlWhitespace(body.length ? body.html().trim() : null) || null;
  const content = relativizeSiteLinks(contentLive);
  const content_text = collapse(body.text());

  const seo = extractSeo($, url);
  const meta = seo.meta_all;

  // Theme block reading. On these pages the theme's meta tags precede AIOSEO's,
  // so first-wins recovers what AIOSEO later overwrites (notably og:image).
  const og_theme = {
    title: resolveFirst(meta, "og:title"),
    description: resolveFirst(meta, "og:description"),
    type: resolveFirst(meta, "og:type"),
    url: resolveFirst(meta, "og:url"),
    image: resolveFirst(meta, "og:image"),
    site_name: resolveFirst(meta, "og:site_name"),
    locale: resolveFirst(meta, "og:locale"),
  };
  const twitter_theme = {
    card: resolveFirst(meta, "twitter:card"),
    title: resolveFirst(meta, "twitter:title"),
    description: resolveFirst(meta, "twitter:description"),
    image: resolveFirst(meta, "twitter:image"),
    url: resolveFirst(meta, "twitter:url"),
  };

  seo.keywords = resolveLast(meta, "keywords");
  seo.og_theme = og_theme;
  seo.twitter_theme = twitter_theme;
  seo.medical_condition = extractMedicalCondition(seo.json_ld);
  // Passed every block, not json_ld_by_source.post: on disease pages the
  // BreadcrumbList sits inside the AIOSEO @graph.
  seo.breadcrumbs = extractBreadcrumbs(seo.json_ld);
  seo.article_published_time = resolveLast(meta, "article:published_time");
  seo.article_modified_time = resolveLast(meta, "article:modified_time");

  // Disease-specific defects, layered on top of extractSeo's own list.
  issues.push(...seo.seo_issues);
  if (!content) issues.push("empty_content");
  if (!seo.medical_condition) issues.push("no_medical_condition_schema");
  if (seo.twitter.url && seo.twitter.url.replace(/\/$/, "") !== (url || "").replace(/\/$/, ""))
    issues.push("twitter_url_placeholder");
  if (
    og_theme.image &&
    seo.og.image &&
    og_theme.image !== seo.og.image &&
    /\/logo\.[a-z]+$/i.test(seo.og.image)
  )
    issues.push("og_image_generic_logo");
  if (og_theme.title && seo.og.title && og_theme.title.trim() !== seo.og.title.trim())
    issues.push("og_title_conflict");
  if (entry.id != null && id != null && entry.id !== id) issues.push("id_mismatch_with_rest");

  // Unbalanced <p> would be WordPress' autop misfiring, and React throws on it
  // once the markup reaches dangerouslySetInnerHTML — so flag it at capture.
  if (content) {
    const opens = (content.match(/<p[\s>]/g) || []).length;
    const closes = (content.match(/<\/p>/g) || []).length;
    if (opens !== closes) issues.push("unbalanced_p_tags");
  }

  // The title is meant to name this disease; when none of the slug's words
  // appear in it, the page is wearing another page's meta (see header note).
  const metaTitle = seo.meta_title_resolved || "";
  const slugWords = (entry.slug || "").split("-").filter((w) => w.length > 3);
  if (metaTitle && slugWords.length && !slugWords.some((w) => metaTitle.toLowerCase().includes(w)))
    issues.push("meta_title_mismatches_page_subject");

  const seo_issues = [...new Set(issues)];
  seo.seo_issues = seo_issues;

  return {
    id: id ?? entry.id ?? null,
    title: entry.title || bannerTitle || null,
    banner_title: bannerTitle,
    slug: entry.slug,
    url,
    breadcrumb: extractVisibleBreadcrumb($, banner),
    content,
    content_live: contentLive,
    content_text,
    published_date: entry.published_date || seo.article_published_time || null,
    modified_date: entry.modified_date || seo.article_modified_time || null,
    seo,
    seo_issues,
  };
}

/** lung-cancer / lung-cancer-2 and friends: same subject, two live posts. */
function flagDuplicates(results) {
  const byBase = new Map();
  for (const r of results) {
    const base = (r.slug || "").replace(/-\d+$/, "");
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(r);
  }
  let pairs = 0;
  for (const [base, group] of byBase) {
    if (group.length < 2) continue;
    pairs += 1;
    console.warn(`[warn] duplicate disease pages for "${base}": ${group.map((g) => g.slug).join(", ")}`);
    for (const r of group) {
      if (!r.seo_issues.includes("duplicate_disease_page")) {
        r.seo_issues.push("duplicate_disease_page");
        r.seo.seo_issues = r.seo_issues;
      }
    }
  }
  return pairs;
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    out: "ils_diseases.json",
    limit: null,
    slug: null,
    fromList: null,
    fromCache: false,
    refresh: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--out":        opts.out = args[++i]; break;
      case "--limit":      opts.limit = parseInt(args[++i], 10); break;
      case "--slug":       opts.slug = args[++i]; break;
      case "--from-list":  opts.fromList = args[++i]; break;
      case "--from-cache": opts.fromCache = true; break;
      case "--refresh":    opts.refresh = true; break;
      default: break;
    }
  }
  return opts;
}

async function main() {
  const { out, limit, slug, fromList, fromCache, refresh } = parseArgs();
  cacheMode.fromCache = fromCache;
  cacheMode.refresh = refresh;
  if (fromCache) console.log(`[info] --from-cache: reading HTML from ${CACHE_DIR}, no network.`);
  if (refresh) console.log("[info] --refresh: re-fetching every page, overwriting cache.");

  const rest = await loadDiseaseList();
  const restBySlug = new Map(rest.map((d) => [d.slug, d]));

  // Only meaningful over a full run; a --slug or --limit run is not a census.
  const coverageIssues =
    slug || limit ? [] : reconcileListWithRest(fromList || DEFAULT_LIST, restBySlug);

  let list = rest;
  if (fromList) {
    // The list narrows the REST set; it never adds unknown slugs, since a URL
    // with no CPT post has no title or dates to carry.
    const wanted = readUrlList(fromList).map((u) => slugFromUrl(u)).filter(Boolean);
    list = wanted.map((s) => restBySlug.get(s)).filter(Boolean);
    console.log(`[info] --from-list ${fromList}: ${list.length}/${wanted.length} slugs resolved against REST`);
  }
  if (slug) list = list.filter((d) => d.slug === slug);
  if (limit) list = list.slice(0, limit);
  if (!list.length) {
    console.error("[error] no diseases matched.");
    process.exit(1);
  }

  const results = [];
  let done = 0;
  for (const entry of list) {
    done += 1;
    console.log(`[info] (${done}/${list.length}) Fetching disease: ${entry.url}`);
    const { html, fromCache: cached } = await fetchHtml(entry.url, `disease/${entry.slug}`);
    if (!html) {
      console.error(`  [error] no HTML for ${entry.url}`);
      continue;
    }
    try {
      results.push(scrapeDisease(html, entry));
    } catch (e) {
      console.error(`  [error] failed to parse ${entry.url}: ${e.message}`);
    }
    if (!cached && !cacheMode.fromCache) await sleep(REQUEST_DELAY_MS);
  }

  const duplicatePairs = flagDuplicates(results);

  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");

  // Summary of the SEO defects this run observed, so problems stay visible.
  const tally = {};
  for (const d of results) for (const k of d.seo_issues || []) tally[k] = (tally[k] || 0) + 1;
  const empty = results.filter((d) => !d.content).length;
  console.log(`[done] Scraped ${results.length}/${list.length} diseases -> ${outPath}`);
  if (empty) console.log(`[warn] ${empty} diseases had no content`);
  if (duplicatePairs) console.log(`[warn] ${duplicatePairs} duplicate disease slug groups`);
  if (coverageIssues.length) console.log("[warn] coverage:", coverageIssues.join(", "));
  console.log("[seo]  issue tally:", tally);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
