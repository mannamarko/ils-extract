#!/usr/bin/env node
/**
 * ILS Hospitals FAQ Scraper (Node.js)
 * ---------------------------------------------------------------
 * Extracts every FAQ on the site into JSON (default ils_faqs.json + the small
 * index faqs.json), starting from
 *   https://ilshospitals.com/frequently-asked-questions/
 *
 * THE SITE HAS TWO SEPARATE FAQ STORES, and this scraper captures both:
 *
 *   1. `faq-lists` (9 posts) — the categories the hub page links to,
 *      /faq-lists/<slug>/. Each page is a Bootstrap accordion of question ->
 *      answer pairs (12 pairs in total; only admission-billing has 2, every
 *      other category has exactly 1). These carry the real content: the answers
 *      are rich HTML — numbered `.process-card` step grids, phone lists, mailto
 *      and portal links — not plain paragraphs.
 *   2. `faq-question-answer` (21 posts) — standalone Q&As with no listing page
 *      of their own; they surface as the randomized FAQ card triples on
 *      department pages (which ils-department-scraper.js deliberately skips).
 *      Question is the post title, answer is the post content, and BOTH come
 *      straight from WP REST, so no page fetches are needed. Emitted under
 *      `standalone_questions`; pass --no-standalone to drop them.
 *
 * TWO-PASS PATTERN (as with events/doctors/procedures/packages):
 *   pass 1  WP REST /wp-json/wp/v2/faq-lists is the authoritative list (id,
 *           slug, url, dates, title); the hub page is walked once to enrich each
 *           entry with its card icon, card title, `data-filter-keyword` and hub
 *           ordering, matched by slug. Writes the small index faqs.json.
 *   pass 2  visit each /faq-lists/<slug>/ page for the accordion, the answer
 *           links/images and the full SEO block.
 *
 * PAGE SHAPE. Banner in `section.page-banner.faq-page-banner` (breadcrumb
 * `span` + `h2`). Body is `section.faq-list-sec .faq-accordian-box`, holding
 * sibling pairs of `div.faq-question[data-bs-target="#collapseN"]` and
 * `div.faq-answer#collapseN`. The question `div` ends with a chevron `<span>`
 * that is stripped from the text. Pairing follows data-bs-target first and
 * falls back to the next `.faq-answer` sibling.
 *
 * SECTION SKIPPED ON PURPOSE. The "Other FAQs" strip at the foot of every
 * detail page is RANDOMIZED — two fetches of /faq-lists/book-an-appointment/
 * returned different 4-slug subsets — so capturing it would make every rerun
 * diff for no reason. Same call as the "Other Health Packages" strip. Do not
 * "restore" it.
 *
 * SEO. Like events/courses, FAQ pages ship a SINGLE meta + ld+json block
 * (AIOSEO), page-specific and correct for title with a self-referential
 * canonical, so shared `extractSeo` is used unchanged. There being no theme
 * block is structural rather than a per-page defect, so `no_post_specific_meta`
 * / `no_post_specific_schema` are dropped from the tally. What IS recorded:
 *   - `no_faqpage_schema` — the headline finding. The AIOSEO @graph carries
 *     BreadcrumbList / WebPage / Organization / WebSite only. There is no
 *     FAQPage/Question/Answer schema anywhere, on pages whose entire purpose is
 *     question-and-answer content: the site forfeits FAQ rich results.
 *   - `missing_meta_description` — the category pages ship no description at
 *     all (no meta description, no og:description, no twitter:description). The
 *     hub page does have one.
 *   - `og_image_generic_logo`, `twitter_url_placeholder` — as elsewhere.
 *   - `no_questions` / `empty_answer` / `count_mismatch` (hub cards vs REST).
 *
 * Requires: axios, cheerio (npm install axios cheerio)
 *
 * Usage:
 *   node ils-faq-scraper.js                       # all -> ils_faqs.json
 *   node ils-faq-scraper.js --slug <slug>
 *   node ils-faq-scraper.js --limit 1
 *   node ils-faq-scraper.js --from-list faqs.json
 *   node ils-faq-scraper.js --index-only          # pass 1 only -> faqs.json
 *   node ils-faq-scraper.js --no-standalone       # skip the faq-question-answer posts
 *   node ils-faq-scraper.js --from-cache          # reparse cached HTML, no network
 *   node ils-faq-scraper.js --refresh             # re-fetch, overwrite cache
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
  trimOrNull,
  graphNodes,
  extractBreadcrumbs,
  extractSeo,
} = require("./scrape-lib");

const HUB_URL = "https://ilshospitals.com/frequently-asked-questions/";
const LIST_REST_URL =
  "https://ilshospitals.com/wp-json/wp/v2/faq-lists?per_page=100&_fields=id,slug,link,date,modified,title";
const QA_REST_URL =
  "https://ilshospitals.com/wp-json/wp/v2/faq-question-answer?per_page=100&_fields=id,slug,link,date,modified,title,content";
const SITE_ORIGIN = "https://ilshospitals.com";
const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "svg", "avif"];

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

function isImageUrl(url) {
  if (!url) return false;
  try {
    const m = new URL(url, SITE_ORIGIN).pathname.match(/\.([a-z0-9]{2,5})$/i);
    return !!m && IMAGE_EXTS.includes(m[1].toLowerCase());
  } catch (e) {
    return false;
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

/** Images inside an answer; `full` is the lightbox target when there is one. */
function extractImages($, scope) {
  const images = [];
  scope.find("img[src]").each((_, el) => {
    const $img = $(el);
    const src = absoluteUrl($img.attr("src"));
    if (!src) return;
    const parentHref = absoluteUrl($img.parent("a").attr("href"));
    images.push({
      src,
      full: parentHref && isImageUrl(parentHref) && parentHref !== src ? parentHref : null,
      alt: trimOrNull($img.attr("alt")),
    });
  });
  return images;
}

/**
 * Non-image anchor targets inside an answer — the patient portal, mailto and
 * tel links, downloadable forms. De-duplicated, in document order.
 */
function extractLinks($, scope) {
  const seen = new Set();
  const links = [];
  scope.find("a[href]").each((_, el) => {
    const url = absoluteUrl($(el).attr("href"));
    if (!url || isImageUrl(url) || seen.has(url)) return;
    seen.add(url);
    links.push({ text: collapse($(el).text()), url });
  });
  return links;
}

/** True when no node in any ld+json block is a FAQ schema type. */
function hasFaqSchema(json_ld) {
  return graphNodes(json_ld).some((n) => {
    if (!n) return false;
    const t = n["@type"];
    const types = Array.isArray(t) ? t : [t];
    return types.some((x) => x === "FAQPage" || x === "Question" || x === "Answer");
  });
}

/** SEO defects shared by the hub and the category pages. */
function faqSeoIssues(seo, url) {
  // The two no_post_specific_* codes are structural for this post type (there
  // is no theme meta/schema block at all), so they are dropped here to keep the
  // tally meaningful.
  const issues = seo.seo_issues.filter(
    (c) => c !== "no_post_specific_schema" && c !== "no_post_specific_meta"
  );
  if (!seo.meta_description && !seo.og.description && !seo.twitter.description)
    issues.push("missing_meta_description");
  if (!hasFaqSchema(seo.json_ld)) issues.push("no_faqpage_schema");
  if (seo.og.image && /\/logo\.[a-z]+$/i.test(seo.og.image)) issues.push("og_image_generic_logo");
  if (seo.twitter.url && seo.twitter.url.replace(/\/$/, "") !== (url || "").replace(/\/$/, ""))
    issues.push("twitter_url_placeholder");
  return issues;
}

// ---------- pass 1: the FAQ hub ----------

/**
 * Parse the hub page: its own banner/SEO plus the category cards, as
 * slug -> { icon, card_title, filter_keyword, order }. The cards are the only
 * source for the icon and the search keyword; REST knows nothing about them.
 */
function parseHub(html) {
  const $ = cheerio.load(html);
  const banner = $("section.page-banner").first();

  const cards = new Map();
  $("section.faq-list-sec li.opd-card-li").each((_, el) => {
    const $c = $(el);
    const href = $c.find('a[href*="/faq-lists/"]').first().attr("href");
    if (!href) return;
    const slug = slugFromUrl(absoluteUrl(href));
    if (!slug || slug === "faq-lists" || cards.has(slug)) return;
    cards.set(slug, {
      icon: absoluteUrl($c.find("img").first().attr("src")) || null,
      card_title: collapse($c.find("p.title-treatment").first().text()),
      filter_keyword: collapse($c.attr("data-filter-keyword")),
      order: cards.size + 1,
    });
  });

  const seo = extractSeo($, HUB_URL);
  seo.breadcrumbs = extractBreadcrumbs(seo.json_ld);
  const seo_issues = faqSeoIssues(seo, HUB_URL);

  const hub = {
    url: HUB_URL,
    title: collapse(banner.find("h2").first().text()),
    breadcrumb: extractVisibleBreadcrumb($, banner),
    category_count: cards.size,
    seo,
    seo_issues,
  };
  return { hub, cards };
}

/**
 * Resolve the categories to visit, as [{ id, slug, url, title, icon,
 * card_title, filter_keyword, order, published_date, modified_date }].
 * WP REST is authoritative for which posts exist; --from-list replays a prior
 * index (and then the hub is not fetched at all).
 */
async function loadFaqList(fromList) {
  if (fromList) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), fromList), "utf-8"));
    console.log(`[info] category list from ${fromList}: ${raw.length} entries`);
    return { hub: null, list: raw };
  }

  const { data } = await fetchJson(LIST_REST_URL, "api/faq-lists");
  if (!Array.isArray(data) || !data.length) {
    throw new Error(`could not load the faq-lists index from ${LIST_REST_URL}`);
  }

  const { html } = await fetchHtml(HUB_URL, "faqs/_hub");
  if (!html) throw new Error(`could not load the FAQ hub page ${HUB_URL}`);
  const { hub, cards } = parseHub(html);
  console.log(`[info] hub: ${cards.size} category cards`);

  if (cards.size !== data.length) {
    hub.seo_issues.push("count_mismatch");
    console.log(`[warn] hub cards (${cards.size}) != REST faq-lists (${data.length})`);
  }

  const list = data
    .map((d) => {
      const url = d.link || `${SITE_ORIGIN}/faq-lists/${d.slug}/`;
      const card = cards.get(d.slug) || {};
      return {
        id: d.id ?? null,
        slug: d.slug,
        url,
        title: collapse(d.title && d.title.rendered) || null,
        icon: card.icon || null,
        card_title: card.card_title || null,
        filter_keyword: card.filter_keyword || null,
        order: card.order ?? null,
        on_hub: cards.has(d.slug),
        published_date: d.date || null,
        modified_date: d.modified || null,
      };
    })
    // Hub order first (that is the order a visitor sees), REST order after it
    // for anything not linked from the hub.
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

  console.log(`[info] category list from REST: ${list.length} entries`);
  return { hub, list };
}

// ---------- pass 2: a /faq-lists/<slug>/ page ----------

/**
 * The accordion. Questions and answers are siblings rather than nested, so each
 * question is paired with the element its data-bs-target points at, falling
 * back to the next `.faq-answer` sibling if the attribute is missing.
 */
function extractQuestions($, box) {
  const questions = [];
  box.find(".faq-question").each((i, el) => {
    const $q = $(el);

    // The question div ends with a chevron <span>; drop it from the text.
    const $qt = $q.clone();
    $qt.find("span").remove();
    const question = collapse($qt.text());

    const target = $q.attr("data-bs-target") || $q.attr("data-target") || "";
    let $a = target.startsWith("#") ? box.find(target).first() : $();
    if (!$a.length) $a = $q.nextAll(".faq-answer").first();

    const answer_html = $a.length ? normalizeHtmlWhitespace($a.html().trim()) : null;
    questions.push({
      position: i + 1,
      question,
      answer_html,
      answer_text: $a.length ? collapse($a.text()) : null,
      links: $a.length ? extractLinks($, $a) : [],
      images: $a.length ? extractImages($, $a) : [],
      target_id: target ? target.replace(/^#/, "") : null,
    });
  });
  return questions;
}

function scrapeFaqList(html, entry) {
  const $ = cheerio.load(html);
  const url = entry.url;

  // WP stamps the post id on <body class="... postid-717 ...">; rel=shortlink
  // carries the same id and backs it up if the class is ever dropped.
  const bodyClass = $("body").attr("class") || "";
  const classMatch = bodyClass.match(/\bpostid-(\d+)\b/);
  const shortlink = $('link[rel="shortlink"]').attr("href") || "";
  const shortMatch = shortlink.match(/[?&]p=(\d+)/);
  const pageId = classMatch ? Number(classMatch[1]) : shortMatch ? Number(shortMatch[1]) : null;

  const banner = $("section.page-banner").first();
  const title = collapse(banner.find("h2").first().text()) || entry.title || null;

  const box = $(".faq-accordian-box").first();
  const questions = extractQuestions($, box);

  const seo = extractSeo($, url);
  seo.breadcrumbs = extractBreadcrumbs(seo.json_ld);

  const issues = faqSeoIssues(seo, url);
  if (entry.id != null && pageId != null && entry.id !== pageId) issues.push("id_mismatch_with_rest");
  if (!questions.length) issues.push("no_questions");
  if (questions.some((q) => !q.answer_html)) issues.push("empty_answer");
  seo.seo_issues = issues;

  return {
    id: pageId ?? entry.id ?? null,
    title,
    slug: entry.slug,
    url,
    icon: entry.icon || null,
    card_title: entry.card_title || null,
    filter_keyword: entry.filter_keyword || null,
    order: entry.order ?? null,
    breadcrumb: extractVisibleBreadcrumb($, banner),
    question_count: questions.length,
    questions,
    published_date: entry.published_date || null,
    modified_date: entry.modified_date || null,
    seo,
    seo_issues: issues,
  };
}

// ---------- the standalone faq-question-answer posts ----------

/**
 * The 21 standalone Q&As. Everything needed is in REST — title is the question,
 * content is the answer — so there is nothing to fetch per post. Their detail
 * pages exist but only re-render the same two fields inside the theme shell.
 */
async function loadQuestionAnswers() {
  const { data } = await fetchJson(QA_REST_URL, "api/faq-question-answer");
  if (!Array.isArray(data)) {
    console.error("[warn] could not load faq-question-answer posts");
    return [];
  }
  return data.map((d) => {
    const rendered = (d.content && d.content.rendered) || "";
    const $ = cheerio.load(`<div id="qa-root">${rendered}</div>`);
    const root = $("#qa-root");
    return {
      id: d.id ?? null,
      slug: d.slug,
      url: d.link || `${SITE_ORIGIN}/faq-question-answer/${d.slug}/`,
      question: collapse(cheerio.load(`<div>${(d.title && d.title.rendered) || ""}</div>`)("div").text()),
      answer_html: normalizeHtmlWhitespace(rendered.trim()) || null,
      answer_text: collapse(root.text()),
      links: extractLinks($, root),
      images: extractImages($, root),
      published_date: d.date || null,
      modified_date: d.modified || null,
    };
  });
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    out: "ils_faqs.json",
    indexOut: "faqs.json",
    limit: null,
    slug: null,
    fromList: null,
    indexOnly: false,
    noStandalone: false,
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
      case "--no-standalone":
        opts.noStandalone = true;
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
  const { out, indexOut, limit, slug, fromList, indexOnly, noStandalone, fromCache, refresh } =
    parseArgs();
  cacheMode.fromCache = fromCache;
  cacheMode.refresh = refresh;
  if (fromCache) console.log(`[info] --from-cache: reading HTML from ${CACHE_DIR}, no network.`);
  if (refresh) console.log("[info] --refresh: re-fetching every page, overwriting cache.");

  const { hub, list: allCategories } = await loadFaqList(fromList);
  let list = allCategories;
  if (slug) list = list.filter((e) => e.slug === slug);
  if (limit) list = list.slice(0, limit);
  if (!list.length) {
    console.error("[error] no FAQ categories matched.");
    process.exit(1);
  }

  // Write the small pass-1 index (unless we're replaying one).
  if (!fromList) {
    const indexPath = path.resolve(process.cwd(), indexOut);
    fs.writeFileSync(indexPath, JSON.stringify(allCategories, null, 2), "utf-8");
    console.log(`[info] pass 1: ${allCategories.length} FAQ categories -> ${indexPath}`);
  }
  if (indexOnly) {
    console.log("[done] --index-only: stopping after pass 1.");
    return;
  }

  const categories = [];
  for (const entry of list) {
    console.log(`[info] Fetching FAQ category: ${entry.url}`);
    const { html, fromCache: cached } = await fetchHtml(entry.url, `faq-lists/${entry.slug}`);
    if (!html) {
      console.error(`  [error] no HTML for ${entry.url}`);
      continue;
    }
    try {
      categories.push(scrapeFaqList(html, entry));
    } catch (e) {
      console.error(`  [error] failed to parse ${entry.url}: ${e.message}`);
    }
    if (!cached) await sleep(REQUEST_DELAY_MS);
  }

  const standalone_questions = noStandalone ? [] : await loadQuestionAnswers();
  if (!noStandalone) {
    console.log(`[info] standalone faq-question-answer posts: ${standalone_questions.length}`);
  }

  const payload = { hub, categories, standalone_questions };
  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");

  const tally = {};
  for (const c of categories) for (const k of c.seo_issues || []) tally[k] = (tally[k] || 0) + 1;
  if (hub) for (const k of hub.seo_issues || []) tally[k] = (tally[k] || 0) + 1;
  const questionCount = categories.reduce((n, c) => n + c.question_count, 0);
  const emptyCats = categories.filter((c) => !c.question_count).length;

  console.log(
    `[done] Scraped ${categories.length}/${list.length} FAQ categories ` +
      `(${questionCount} questions) + ${standalone_questions.length} standalone -> ${outPath}`
  );
  if (emptyCats) console.log(`[warn] ${emptyCats} categories had no questions`);
  console.log("[seo]  issue tally:", tally);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
