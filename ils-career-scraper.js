#!/usr/bin/env node
/**
 * ILS Hospitals Career Scraper (Node.js)
 * ---------------------------------------------------------------
 * Extracts every open job listed at
 *   https://ilshospitals.com/career/
 * into JSON (default ils_careers.json + the small index careers.json).
 *
 * WHAT THIS CONTENT TYPE IS. Jobs are their own WordPress custom post type
 * (`job`, 29 items via WP REST, `job-departments` taxonomy). The /career/ page
 * is NOT a plain archive: it is one page that inlines all 29 job cards
 * server-side (filterable client-side by hospital/department via JS, no
 * pagination), each linking through `/?post_type=job&p=<id>` — which
 * 301-redirects to the real detail page `/job/<slug>/` — rather than a
 * plain href to the slug. So the id is read out of that query string, not a
 * clean anchor. Same page also embeds an "open application" upload form,
 * skipped here (a wpcf7 form, not data).
 *
 * TWO-PASS PATTERN (as with events/csr/doctors/procedures/packages):
 *   pass 1  WP REST /wp-json/wp/v2/job is the authoritative list (id, slug,
 *           link, dates, title) and /wp-json/wp/v2/job-departments the
 *           id -> name map for the `job-departments` taxonomy. The /career/
 *           page is walked once for the ONE thing REST cannot provide:
 *           hospital availability, which — exactly like the doctor/package
 *           scrapers' `hospital-<id>` / `data-hospitals` classes — only
 *           exists as `hospital_<id>` CSS classes on each `.job_card` div
 *           (postmeta `show_in_hospitals`, not REST-exposed). The hospital
 *           id -> name map itself comes from the page's own
 *           `#hospital_dropdown` <select>. Writes the small index
 *           careers.json.
 *   pass 2  visit each /job/<slug>/ detail page for the structured
 *           Education/Specialty/Experience/Job Description sections and the
 *           full SEO block.
 *
 * CLASSES ARE THE JOIN KEY, NOT THE FOOTER TEXT. A `.job_card` can carry
 * several `hospital_<id>` classes (one open req spans all 5 hospitals) and its
 * footer's "ILS Hospitals:" line does list all of them too (comma-separated) —
 * but the footer is free text with no guaranteed 1:1 correspondence to the
 * classes, so it is kept only as a best-effort `hospital_names_footer` on the
 * index entry, never treated as authoritative; `hospital_ids`/`hospital_names`
 * (resolved from the classes + the `#hospital_dropdown` map) are the real
 * fields. `dept_<id>` classes are likewise the join key for department; a card
 * can have none at all (department left unset for that posting).
 *
 * DETAIL PAGE SHAPE. Banner in `section.page-banner.faq-page-banner` (same
 * banner partial as FAQ/course pages). Body is
 * `section.job-sec-details > div`, each holding an `h2` label followed by a
 * `p`/`p.sm-detail` value — NOT always in a fixed order or even present: 27/29
 * postings have "Qualification", 22/29 have "Description", only a couple ever
 * fill in "Specialty". So sections are read by pairing each `h2` with its next
 * sibling rather than assuming Education/Specialty/Experience/Description
 * always all appear. Values embed doubly-nested `<p><p>...</p></p>` markup (a
 * template bug — the field is wrapped in a `<p>` and its WYSIWYG content is
 * ALSO a `<p>`); cheerio/htmlparser2 auto-closes the outer tag on seeing the
 * inner one, same as a browser would, so `.text()` and `.html()` both come out
 * clean regardless.
 *
 * BROKEN BREADCRUMB — RECORDED, NOT FIXED. Every single job detail page ships
 * the IDENTICAL, wrong visible breadcrumb "Get in Touch - Investor - <job
 * title>" (hardcoded in the template, unrelated to Career/the real hierarchy).
 * Flagged `broken_breadcrumb_hardcoded` on every record rather than silently
 * dropped or "corrected".
 *
 * SEO. Like events/csr/faq-lists, job pages ship a SINGLE meta + ld+json block
 * (AIOSEO), page-specific and correct for title with a self-referential
 * canonical but NO meta description, so shared `extractSeo` is used with the
 * same structural no_post_specific_* codes dropped from the tally. The AIOSEO
 * @graph carries BreadcrumbList / Organization / WebPage / WebSite /
 * ImageObject only — there is no JobPosting schema anywhere on pages whose
 * entire purpose is a job ad, forfeiting Google's job-search rich results
 * (`no_jobposting_schema`). og:image is the generic site logo
 * (`og_image_generic_logo`).
 *
 * Requires: axios, cheerio (npm install axios cheerio)
 *
 * Usage:
 *   node ils-career-scraper.js                       # all -> ils_careers.json
 *   node ils-career-scraper.js --slug <slug>
 *   node ils-career-scraper.js --limit 1
 *   node ils-career-scraper.js --from-list careers.json
 *   node ils-career-scraper.js --index-only          # pass 1 only -> careers.json
 *   node ils-career-scraper.js --from-cache          # reparse cached HTML, no network
 *   node ils-career-scraper.js --refresh             # re-fetch, overwrite cache
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
  extractBreadcrumbs,
  extractSeo,
} = require("./scrape-lib");

const CAREER_URL = "https://ilshospitals.com/career/";
const JOB_REST_URL =
  "https://ilshospitals.com/wp-json/wp/v2/job?per_page=100&_fields=id,slug,link,date,modified,title";
const DEPT_REST_URL =
  "https://ilshospitals.com/wp-json/wp/v2/job-departments?per_page=100&_fields=id,slug,name";
const SITE_ORIGIN = "https://ilshospitals.com";

const collapse = (s) => (s || "").replace(/\s+/g, " ").trim() || null;

function absoluteUrl(href) {
  if (!href) return null;
  const h = href.trim();
  if (!h || h === "#") return null;
  try {
    return new URL(h, SITE_ORIGIN).href;
  } catch (e) {
    return h;
  }
}

/** "job_card hospital_341 dept_201 " -> { hospitalIds: [341], deptIds: [201] } */
function parseCardClasses(classAttr) {
  const classes = (classAttr || "").split(/\s+/).filter(Boolean);
  const hospitalIds = [];
  const deptIds = [];
  for (const c of classes) {
    let m = c.match(/^hospital_(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (!hospitalIds.includes(id)) hospitalIds.push(id);
      continue;
    }
    m = c.match(/^dept_(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (!deptIds.includes(id)) deptIds.push(id);
    }
  }
  return { hospitalIds, deptIds };
}

/** The id WP would assign, pulled out of the "Apply Now" link's ?p= query param. */
function idFromApplyHref(href) {
  if (!href) return null;
  try {
    const id = new URL(href, SITE_ORIGIN).searchParams.get("p");
    const n = parseInt(id, 10);
    return Number.isFinite(n) ? n : null;
  } catch (e) {
    return null;
  }
}

// ---------- pass 1: the /career/ listing ----------

/** id -> name, from <select id="hospital_dropdown"><option value="341">Saltlake</option>...</select>. */
function parseHospitalMap($) {
  const map = new Map();
  $("select#hospital_dropdown option").each((_, el) => {
    const id = parseInt($(el).attr("value"), 10);
    const name = collapse($(el).text());
    if (Number.isFinite(id) && name) map.set(id, name);
  });
  return map;
}

/**
 * One .job_card div -> { id, hospitalIds, deptIds, hospitalNameFooter,
 * deptNameFooter, postDateRaw }. `id` comes from the Apply Now link, which is
 * how listing cards are matched back to the REST list.
 */
function parseCard($, el) {
  const $card = $(el);
  const { hospitalIds, deptIds } = parseCardClasses($card.attr("class"));

  const applyHref = $card.find("a.read-btn").first().attr("href");
  const id = idFromApplyHref(applyHref);

  const postDateRaw = collapse($card.find(".panel-heading .text-end").first().text());
  const dateMatch = (postDateRaw || "").match(/Post Date:\s*([\d-]+)/);

  const footerCols = $card.find(".panel-footer .row > div");
  const stripLabel = (i) => {
    const $col = footerCols.eq(i);
    if (!$col.length) return null;
    const $clone = $col.clone();
    $clone.find("strong").remove();
    return collapse($clone.text());
  };

  return {
    id,
    hospitalIds,
    deptIds,
    hospitalNameFooter: stripLabel(0),
    deptNameFooter: stripLabel(1),
    postDateRaw: dateMatch ? dateMatch[1] : null,
  };
}

/**
 * Resolve the jobs to visit, as [{ id, slug, url, title, hospital_ids,
 * hospital_names, department_ids, department_names, hospital_names_footer,
 * department_name_footer, listed_post_date, published_date, modified_date }].
 * WP REST is authoritative for which posts exist; --from-list replays a prior
 * index.
 */
async function loadJobList(fromList) {
  if (fromList) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), fromList), "utf-8"));
    console.log(`[info] job list from ${fromList}: ${raw.length} entries`);
    return raw;
  }

  const [{ data: jobs }, { data: depts }] = await Promise.all([
    fetchJson(JOB_REST_URL, "api/job"),
    fetchJson(DEPT_REST_URL, "api/job-departments"),
  ]);
  if (!Array.isArray(jobs) || !jobs.length) {
    throw new Error(`could not load the job list from ${JOB_REST_URL}`);
  }
  const deptMap = new Map();
  for (const d of Array.isArray(depts) ? depts : []) deptMap.set(d.id, collapse(d.name));

  const { html } = await fetchHtml(CAREER_URL, "career/_listing");
  if (!html) throw new Error(`could not load the career listing page ${CAREER_URL}`);
  const $ = cheerio.load(html);

  const hospitalMap = parseHospitalMap($);
  console.log(`[info] hospital map: ${hospitalMap.size} hospitals, department map: ${deptMap.size} departments`);

  const cardsById = new Map();
  $(".job_card").each((_, el) => {
    const card = parseCard($, el);
    if (card.id != null) cardsById.set(card.id, card);
  });
  console.log(`[info] listing: ${cardsById.size} job cards`);
  if (cardsById.size !== jobs.length) {
    console.log(`[warn] listing cards (${cardsById.size}) != REST job (${jobs.length})`);
  }

  const list = jobs.map((d) => {
    const url = d.link || `${SITE_ORIGIN}/job/${d.slug}/`;
    const card = cardsById.get(d.id) || {
      hospitalIds: [],
      deptIds: [],
      hospitalNameFooter: null,
      deptNameFooter: null,
      postDateRaw: null,
    };
    return {
      id: d.id ?? null,
      slug: d.slug,
      url,
      title: collapse(d.title && d.title.rendered) || null,
      hospital_ids: card.hospitalIds,
      hospital_names: card.hospitalIds.map((id) => hospitalMap.get(id) || null),
      department_ids: card.deptIds,
      department_names: card.deptIds.map((id) => deptMap.get(id) || null),
      hospital_names_footer: card.hospitalNameFooter,
      department_name_footer: card.deptNameFooter,
      listed_post_date: card.postDateRaw,
      on_listing: cardsById.has(d.id),
      published_date: d.date || null,
      modified_date: d.modified || null,
    };
  });
  console.log(`[info] job list from REST: ${list.length} entries`);
  return list;
}

// ---------- pass 2: a /job/<slug>/ detail page ----------

/** The breadcrumb the page actually renders, in the banner (see header note: hardcoded/wrong). */
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

/**
 * The job-sec-details block: each direct child <div> holds an <h2> label and
 * a value. Read generically by label text rather than assuming a fixed
 * set/order — see header note on missing fields.
 *
 * The value markup is doubly broken: the template wraps the field in
 * `<p class="sm-detail">` (or a bare `<p>`) and then pastes the WYSIWYG
 * content straight inside it — which is itself a `<p>` (or a `<ul>`).
 * `<p>` cannot contain block content, so the parser closes the wrapper the
 * instant it sees the inner tag, leaving THREE siblings after the `<h2>`: an
 * empty `<p>` (the wrapper's now-childless open tag), the real content
 * element(s), and a second empty `<p>` (the wrapper's orphaned close tag).
 * Filtering to children with actual text sidesteps this without assuming the
 * real content is always a single `<p>` (Job Description is sometimes a
 * `<ul>` of bullet points instead).
 */
function extractJobFields($, section) {
  const fields = {};
  // section > div.max-container > div.<field> — the field divs are
  // grandchildren of the section, not direct children.
  const container = section.children("div").first();
  container.children("div").each((_, div) => {
    const $div = $(div);
    const label = collapse($div.find("h2").first().text());
    if (!label) return;
    const $value = $div
      .children()
      .not("h2")
      .filter((_, el) => collapse($(el).text()) !== null);
    if (!$value.length) return;
    fields[label] = {
      html: normalizeHtmlWhitespace(
        $value
          .map((_, el) => $.html(el))
          .get()
          .join("")
      ),
      text: collapse($value.text()),
    };
  });
  return fields;
}

function scrapeJob(html, entry) {
  const $ = cheerio.load(html);
  const url = entry.url;

  // WP stamps the post id on <body class="... postid-18328 ...">; rel=shortlink
  // carries the same id and backs it up if the class is ever dropped.
  const bodyClass = $("body").attr("class") || "";
  const classMatch = bodyClass.match(/\bpostid-(\d+)\b/);
  const shortlink = $('link[rel="shortlink"]').attr("href") || "";
  const shortMatch = shortlink.match(/[?&]p=(\d+)/);
  const pageId = classMatch ? Number(classMatch[1]) : shortMatch ? Number(shortMatch[1]) : null;

  const banner = $("section.page-banner").first();
  const title = collapse(banner.find("h2").first().text()) || entry.title || null;

  const section = $("section.job-sec-details").first();
  const fields = extractJobFields($, section);
  const education = fields["Education Qualification/Certification"] || null;
  const specialty = fields["Specialty"] || null;
  const experience = fields["Experience"] || null;
  const jobDescription = fields["Job Description"] || null;

  const seo = extractSeo($, url);
  seo.breadcrumbs = extractBreadcrumbs(seo.json_ld); // BreadcrumbList lives in the AIOSEO @graph

  // Job-specific defects, layered on extractSeo's own list. The two
  // no_post_specific_* codes are structural for this post type (there is no
  // theme block at all), so they are dropped here to keep the tally meaningful.
  const issues = seo.seo_issues.filter(
    (c) => c !== "no_post_specific_schema" && c !== "no_post_specific_meta"
  );
  if (!seo.meta_description && !seo.og.description && !seo.twitter.description)
    issues.push("missing_meta_description");
  if (seo.og.image && /\/logo\.[a-z]+$/i.test(seo.og.image)) issues.push("og_image_generic_logo");
  if (seo.twitter.url && seo.twitter.url.replace(/\/$/, "") !== (url || "").replace(/\/$/, ""))
    issues.push("twitter_url_placeholder");
  issues.push("broken_breadcrumb_hardcoded"); // see header note: identical wrong crumb on every job page
  issues.push("no_jobposting_schema"); // structural: no JobPosting node anywhere on this template
  if (entry.id != null && pageId != null && entry.id !== pageId) issues.push("id_mismatch_with_rest");
  if (!jobDescription || !jobDescription.text) issues.push("empty_job_description");
  seo.seo_issues = [...new Set(issues)];

  return {
    id: pageId ?? entry.id ?? null,
    title,
    slug: entry.slug,
    url,
    hospital_ids: entry.hospital_ids,
    hospital_names: entry.hospital_names,
    department_ids: entry.department_ids,
    department_names: entry.department_names,
    breadcrumb: extractVisibleBreadcrumb($, banner),
    education_qualification: education,
    specialty,
    experience,
    job_description: jobDescription,
    published_date: entry.published_date || null,
    modified_date: entry.modified_date || null,
    seo,
    seo_issues: seo.seo_issues,
  };
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    out: "ils_careers.json",
    indexOut: "careers.json",
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

  let list = await loadJobList(fromList);
  if (slug) list = list.filter((e) => e.slug === slug);
  if (limit) list = list.slice(0, limit);
  if (!list.length) {
    console.error("[error] no jobs matched.");
    process.exit(1);
  }

  // Write the small pass-1 index (unless we're replaying one).
  if (!fromList) {
    const indexPath = path.resolve(process.cwd(), indexOut);
    fs.writeFileSync(indexPath, JSON.stringify(list, null, 2), "utf-8");
    console.log(`[info] pass 1: ${list.length} jobs -> ${indexPath}`);
  }
  if (indexOnly) {
    console.log("[done] --index-only: stopping after pass 1.");
    return;
  }

  const results = [];
  for (const entry of list) {
    console.log(`[info] Fetching job: ${entry.url}`);
    const { html, fromCache: cached } = await fetchHtml(entry.url, `job/${entry.slug}`);
    if (!html) {
      console.error(`  [error] no HTML for ${entry.url}`);
      continue;
    }
    try {
      results.push(scrapeJob(html, entry));
    } catch (e) {
      console.error(`  [error] failed to parse ${entry.url}: ${e.message}`);
    }
    if (!cached) await sleep(REQUEST_DELAY_MS);
  }

  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");

  const tally = {};
  for (const j of results) for (const k of j.seo_issues || []) tally[k] = (tally[k] || 0) + 1;
  const empty = results.filter((j) => !j.job_description || !j.job_description.text).length;
  console.log(`[done] Scraped ${results.length}/${list.length} jobs -> ${outPath}`);
  if (empty) console.log(`[warn] ${empty} jobs had no job description`);
  console.log("[seo]  issue tally:", tally);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
