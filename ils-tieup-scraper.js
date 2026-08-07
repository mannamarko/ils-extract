#!/usr/bin/env node
/**
 * ILS Hospitals Corporate & Insurance Tie-Up Scraper (Node.js)
 * ---------------------------------------------------------------
 * Extracts the cashless tie-ups listed at
 *   https://ilshospitals.com/tie-up/
 * into JSON (default ils_tie_ups.json + the small index tie_ups.json).
 *
 * TWO SECTIONS, TWO SOURCES. `/tie-up/` (page id 941, template `tie-ups.php`)
 * renders two sibling blocks inside `div.row.sub-ups`, and despite sharing the
 * `ul.com-logo-ul-f-start > li > img + p` card markup they do NOT come from the
 * same place:
 *
 *   #corporateTieUps   5 pill tabs (`ul.nav-pills.ul-corporate` -> panes
 *                      `div#corpTab1..5.tab-pane`), one per hospital unit.
 *                      27 cards / 25 distinct names. NONE of them resolve to the
 *                      `tie-up-list` CPT (0/27 by featured image), so corporate
 *                      records carry no post id, slug, date or detail page —
 *                      the hub HTML is the only source there is.
 *   #insuranceTieUps   ONE flat list, 38 cards, no tab and no per-hospital
 *                      markup of any kind. All 38 DO resolve to the CPT.
 *
 * HOSPITAL IDS COME FROM THE LEAD FORM. The tie-up page carries no
 * `#hospital_dropdown` (careers), no `#hospitalFilter` (packages) and no
 * `input.filterCheckbox[data-type="hospitals"]` (doctors/OPD). The only id
 * source on the page is the Salesforce lead form's
 * `select.form-hospital-item`, whose options carry `data-id`:
 * Saltlake 341, Dumdum 342, Howrah 340, Agartala 343, Raipur 5637 — the same
 * post ids the rest of the corpus uses. The pill labels ("Saltlake", "Dumdum",
 * ...) are byte-identical to those option texts, which is what makes the tab ->
 * hospital id join possible without hardcoding a map. Raipur's option ships
 * `data-id="5637" value=""` (the Salesforce picklist value was never filled in)
 * — recorded as `hospital_option_value_empty`, not corrected.
 *
 * HOWRAH IS EMPTY. `div#corpTab3` — the Howrah pane — is a literally empty div
 * on the live site: clicking the Howrah pill shows nothing. That is upstream
 * data, not a parse failure, so it is recorded (`corporate_tab_empty` on the hub,
 * `hospital_has_no_corporate_tieups` on hospital 340) and Howrah is emitted with
 * an empty corporate list rather than being silently omitted.
 *
 * INSURANCE IS NOT HOSPITAL-SCOPED. There is no per-hospital insurer list
 * anywhere on ilshospitals.com. `/hospital/<slug>/` does render its own
 * "Insurance Tie Ups" strip (`section#priCITP` -> `ul#slide_tie_up
 * li.slid-item > img`, logos only, no names) — but all five units render the
 * SAME 13 logos in the SAME order, a teaser subset of the 38. Pass 2b fetches
 * all five and records that comparison once, as evidence, instead of five
 * duplicate lists. Insurance records are therefore emitted with all five
 * hospitals and `hospital_scope: "site_wide"` plus
 * `insurance_not_hospital_scoped` / `hospital_scope_inferred_all_units`, so the
 * data is queryable per hospital while never claiming a per-hospital source.
 *
 * JOIN IS BY FEATURED IMAGE. The `tie-up-list` CPT (62 posts, one REST page) has
 * NO taxonomies and `acf: []` — hospital assignment is postmeta and is never
 * REST-exposed, exactly like `show_in_hospitals` on jobs. Cards carry no slug
 * and no href, so the join key is card `<img src>` == media `source_url`, the
 * same route `ils-press-media-scraper.js` and the awards half of
 * `ils-about-us-scraper.js` take. Title joins are useless here: the page writes
 * "NTPC(National Thermal Power Corporation)" where the CPT writes
 * "NTPC – National Thermal Power Corporation".
 *
 * 24 CPT POSTS RENDER NOWHERE. Only 38 of the 62 `tie-up-list` posts appear on
 * the page (the insurance loop's inter-`<li>` whitespace shows it iterating past
 * the rest). They are a superseded corporate list — "RBI – Reserve Bank of
 * India", "SAIL – Steel Authority of India", … replaced by the hand-built
 * corporate tabs — plus 8 schemes never shown at all: Ayushman Bharat, CGHS,
 * ECHS, CRPF, GAIL, MMTC, NFR, THASP. They are kept in `cpt_orphans` flagged
 * `cpt_orphan` rather than dropped: they are real published posts, and several
 * are tie-ups a patient would care about.
 *
 * INSURER VS TPA IS INFERRED. The site never labels which of the 38 are insurers
 * and which are third-party administrators — it is one unbroken `<ul>`. Two
 * independent signals agree exactly: the list is two alphabetical runs (ACKO ->
 * Universal Sompo, then a restart at East West Assist -> Vidal), and precisely
 * those last 15 carry "TPA" in the name while none of the first 23 do. The run
 * break sets `category`, the name test cross-checks it, and every insurance
 * record is tagged `tpa_classification_inferred` so the split is never mistaken
 * for site data. If the two signals ever stop agreeing the run break is
 * abandoned for the name test and `tpa_classification_disagrees` is raised.
 *
 * DETAIL PAGES REUSE THE BLOG TEMPLATE. `/tie-up-list/<slug>/` resolves 200 but
 * renders `section.blog-sec.csr-sec-for-page` with the logo, a date, an empty
 * author line and a `.blog-para` containing nothing but an `<h3>` of the name —
 * no body copy at all, like `/award/<slug>/`. Its breadcrumb reads
 * "Home - Blogs - <name>", linking a tie-up to /blog/. Pass 2 visits them for
 * the SEO block only, recording `detail_page_has_no_body_content` and
 * `breadcrumb_points_to_blog`.
 *
 * SEO. Like csr/events/gallery/press, these pages ship a SINGLE meta + ld+json
 * block (AIOSEO) rather than the theme+AIOSEO pair posts/departments carry, so
 * `no_post_specific_schema` / `no_post_specific_meta` are structural here and
 * dropped from the tally.
 *
 * Requires: axios, cheerio (npm install axios cheerio)
 *
 * Usage:
 *   node ils-tieup-scraper.js                        # all -> ils_tie_ups.json
 *   node ils-tieup-scraper.js --slug acko-general-insurance
 *   node ils-tieup-scraper.js --limit 5
 *   node ils-tieup-scraper.js --from-list tie_ups.json
 *   node ils-tieup-scraper.js --index-only           # pass 1 only -> tie_ups.json
 *   node ils-tieup-scraper.js --no-hospital-check    # skip the 5 /hospital/ pages
 *   node ils-tieup-scraper.js --from-cache           # reparse cached HTML, no network
 *   node ils-tieup-scraper.js --refresh              # re-fetch, overwrite cache
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const {
  REQUEST_DELAY_MS,
  CACHE_DIR,
  cacheMode,
  sleep,
  fetchHtml,
  fetchJson,
  trimOrNull,
  extractBreadcrumbs,
  extractSeo,
} = require("./scrape-lib");

const HUB_URL = "https://ilshospitals.com/tie-up/";
const REST_URL =
  "https://ilshospitals.com/wp-json/wp/v2/tie-up-list?per_page=100&orderby=date&order=desc" +
  "&_fields=id,slug,link,date,modified,title,featured_media,status";
const MEDIA_URL = "https://ilshospitals.com/wp-json/wp/v2/media";
const SITE_ORIGIN = "https://ilshospitals.com";

const collapse = (s) => (s || "").replace(/\s+/g, " ").trim() || null;

/** REST hands back entity-encoded titles; the cards render decoded text. */
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

/**
 * Grouping/comparison key. Lowercased and whitespace-collapsed only — NOT
 * punctuation-stripped, because "Balmer Lawrie & Co. Ltd." (the page) and
 * "Balmer Lawrie & Co." (the CPT) are deliberately allowed to stay distinct;
 * the CPT join is by image, never by name.
 */
const nameKey = (s) => (collapse(s) || "").toLowerCase();

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

// ---------- pass 1: the hub ----------

/**
 * id -> name for the five units, from the Salesforce lead form's
 * <select class="form-hospital-item"><option data-id="341" value="...">Saltlake</option>.
 * The only place on this page any hospital id appears. Options with a data-id
 * but an empty value are reported (Raipur ships one).
 */
function parseHospitalMap($) {
  const hospitals = [];
  const issues = [];
  $("select.form-hospital-item option[data-id]").each((_, el) => {
    const id = parseInt($(el).attr("data-id"), 10);
    const name = collapse($(el).text());
    if (!Number.isFinite(id) || !name) return;
    if (hospitals.some((h) => h.id === id)) return;
    if (!trimOrNull($(el).attr("value"))) issues.push({ id, name, code: "hospital_option_value_empty" });
    hospitals.push({ id, name });
  });
  return { hospitals, issues };
}

/** One `<li>` of either section: the logo and the name under it. */
function parseCard($, li, position) {
  const $li = $(li);
  const $img = $li.find("img").first();
  const src = absoluteUrl($img.attr("src"));
  // Read the name BEFORE collapsing: JS \s matches U+00A0, so collapse() would
  // erase the very nbsp defect two of these names carry.
  const raw = $li.find("p").first().text();
  const name = collapse(raw);
  if (!src && !name) return null;
  return {
    position,
    name,
    name_raw: raw === "" ? null : raw,
    name_has_nbsp: /\u00a0/.test(raw || ""),
    logo_src: src,
    logo_alt: trimOrNull($img.attr("alt")),
  };
}

/**
 * The 5 pill tabs -> their panes. Pills are zipped to panes through the pill's
 * own href ("#corpTab3"), never by index, and the pill label is resolved to a
 * hospital id through the lead-form map.
 */
function parseCorporate($, hospitals) {
  const byName = new Map(hospitals.map((h) => [nameKey(h.name), h]));
  const tabs = [];
  $("#corporateTieUps ul.ul-corporate li.nav-item > a").each((_, el) => {
    const $a = $(el);
    const href = ($a.attr("href") || "").trim();
    const tabId = href.startsWith("#") ? href.slice(1) : null;
    const label = collapse($a.text());
    if (!tabId || !label) return;
    const hospital = byName.get(nameKey(label)) || null;
    const cards = [];
    $(`#corporateTieUps #${tabId} ul.com-logo-ul-f-start > li`).each((_, li) => {
      const card = parseCard($, li, cards.length + 1);
      if (card) cards.push(card);
    });
    tabs.push({ tab_id: tabId, label, hospital, cards });
  });
  return tabs;
}

/** The flat 38-card list; document order is the only ordering it has. */
function parseInsurance($) {
  const cards = [];
  $("#insuranceTieUps ul.com-logo-ul-f-start > li").each((_, li) => {
    const card = parseCard($, li, cards.length + 1);
    if (card) cards.push(card);
  });
  return cards;
}

/**
 * Split the flat insurance list into insurers and TPAs. The site marks neither,
 * so this reads the alphabetical restart that separates the two runs and
 * cross-checks it against the "TPA" name test. Returns
 * { categories: [...], boundary, issues } — on any disagreement the run break is
 * dropped in favour of the name test and the mismatch is reported.
 */
function classifyInsurance(cards) {
  const issues = [];
  const restarts = [];
  for (let i = 1; i < cards.length; i++) {
    if (nameKey(cards[i].name) < nameKey(cards[i - 1].name)) restarts.push(i);
  }
  const byName = cards.map((c) => (/\bTPA\b/i.test(c.name || "") ? "tpa" : "insurer"));
  if (restarts.length !== 1) {
    issues.push("tpa_classification_no_single_run_break");
    return { categories: byName, boundary: null, issues };
  }
  const boundary = restarts[0];
  const byRun = cards.map((_, i) => (i >= boundary ? "tpa" : "insurer"));
  if (byRun.some((c, i) => c !== byName[i])) {
    issues.push("tpa_classification_disagrees");
    return { categories: byName, boundary, issues };
  }
  return { categories: byRun, boundary, issues };
}

/** Fetch /tie-up/ once: both sections, the hospital map, and the hub SEO record. */
async function loadHub() {
  const { html } = await fetchHtml(HUB_URL, "tie-up/_hub");
  if (!html) throw new Error(`could not load ${HUB_URL}`);
  const $ = cheerio.load(html);

  const { hospitals, issues: hospitalIssues } = parseHospitalMap($);
  const tabs = parseCorporate($, hospitals);
  const insuranceCards = parseInsurance($);
  const { categories, boundary, issues: classIssues } = classifyInsurance(insuranceCards);

  const banner = $("section.page-banner").first();
  const seo = extractSeo($, HUB_URL);
  seo.breadcrumbs = extractBreadcrumbs(seo.json_ld); // BreadcrumbList lives in the AIOSEO @graph

  const issues = seo.seo_issues.filter(
    (c) => c !== "no_post_specific_schema" && c !== "no_post_specific_meta"
  );
  if (seo.og.image && /\/logo\.[a-z]+$/i.test(seo.og.image)) issues.push("og_image_generic_logo");
  if (tabs.some((t) => !t.cards.length)) issues.push("corporate_tab_empty");
  if (tabs.some((t) => !t.hospital)) issues.push("corporate_tab_unresolved_hospital");
  if (hospitalIssues.length) issues.push("hospital_option_value_empty");
  for (const c of classIssues) issues.push(c);
  seo.seo_issues = issues;

  const hub = {
    url: HUB_URL,
    title: collapse(banner.find("h2").first().text()),
    breadcrumb: extractVisibleBreadcrumb($, banner),
    hospital_count: hospitals.length,
    corporate_card_count: tabs.reduce((n, t) => n + t.cards.length, 0),
    insurance_card_count: insuranceCards.length,
    empty_corporate_tabs: tabs.filter((t) => !t.cards.length).map((t) => t.tab_id),
    insurance_tpa_boundary: boundary,
    seo,
    seo_issues: issues,
  };

  console.log(
    `[info] hub: ${hub.corporate_card_count} corporate cards across ${tabs.length} tabs, ` +
      `${insuranceCards.length} insurance cards, ${hospitals.length} hospitals`
  );
  for (const t of tabs) {
    console.log(
      `[info]   ${t.tab_id} ${t.label} (${t.hospital ? t.hospital.id : "unresolved"}): ${t.cards.length} cards`
    );
  }
  return { hub, hospitals, hospitalIssues, tabs, insuranceCards, categories };
}

/** One batched /wp/v2/media call per 100 featured-media ids -> Map(id -> media). */
async function loadMedia(ids) {
  const byId = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const url =
      `${MEDIA_URL}?include=${chunk.join(",")}&per_page=100` +
      "&_fields=id,source_url,alt_text,caption,title,mime_type,date,media_details";
    const { data } = await fetchJson(url, `api/tie-up-list-media-${i / 100 + 1}`);
    if (!Array.isArray(data)) continue;
    for (const m of data) byId.set(m.id, m);
  }
  console.log(`[info] media: ${byId.size}/${unique.length} featured images resolved`);
  return byId;
}

/** Fold a WP media record into the compact logo block kept on each record. */
function buildLogo(media, card) {
  if (!media) {
    return {
      media_id: null,
      src: card ? card.logo_src : null,
      alt: card ? card.logo_alt : null,
      caption: null,
      media_title: null,
      mime_type: null,
      width: null,
      height: null,
      filename: card && card.logo_src ? card.logo_src.split("/").pop() : null,
      uploaded_date: null,
    };
  }
  const d = media.media_details || {};
  return {
    media_id: media.id,
    src: media.source_url || (card && card.logo_src) || null,
    alt: trimOrNull(media.alt_text) || (card ? card.logo_alt : null),
    caption: collapse(cheerio.load(media.caption ? media.caption.rendered || "" : "").text()),
    media_title: collapse(media.title && media.title.rendered),
    mime_type: media.mime_type || null,
    width: d.width ?? null,
    height: d.height ?? null,
    filename: d.file ? d.file.split("/").pop() : null,
    uploaded_date: media.date || null,
  };
}

/**
 * Build the flat record list. Corporate cards are grouped by name across tabs
 * (Balmer Lawrie and RBI each sit in two units, so 27 cards -> 25 records);
 * insurance records get all five hospitals with `hospital_scope: "site_wide"`.
 * Both are looked up in the CPT by featured image so the 0/27 corporate miss
 * rate is measured every run rather than assumed.
 */
function buildRecords({ hospitals, tabs, insuranceCards, categories }, postBySrc) {
  const records = [];
  const matchedSrc = new Set();

  const attach = (base, card) => {
    const post = (card.logo_src && postBySrc.get(card.logo_src)) || null;
    if (post) matchedSrc.add(card.logo_src);
    return Object.assign(base, {
      slug: post ? post.slug : null,
      post_id: post ? post.id : null,
      post_link: post ? post.link || `${SITE_ORIGIN}/tie-up-list/${post.slug}/` : null,
      post_title: post ? decodeHtml(post.title && post.title.rendered) : null,
      post_date: post ? post.date || null : null,
      post_modified: post ? post.modified || null : null,
      post_status: post ? post.status || null : null,
      logo: buildLogo(post ? post._media : null, card),
    });
  };

  // ---- corporate: grouped by name across the five tabs ----
  const byKey = new Map();
  for (const tab of tabs) {
    for (const card of tab.cards) {
      const key = nameKey(card.name) || card.logo_src;
      let rec = byKey.get(key);
      if (!rec) {
        rec = attach(
          {
            kind: "corporate",
            category: "corporate",
            name: card.name,
            name_raw: card.name_raw,
            hospitals: [],
            hospital_scope: "per_hospital",
            listing: { section: "corporateTieUps", tab_ids: [], positions: [] },
            _nbsp: card.name_has_nbsp,
          },
          card
        );
        byKey.set(key, rec);
        records.push(rec);
      }
      if (tab.hospital && !rec.hospitals.some((h) => h.id === tab.hospital.id)) {
        rec.hospitals.push({ id: tab.hospital.id, name: tab.hospital.name });
      }
      if (!rec.listing.tab_ids.includes(tab.tab_id)) rec.listing.tab_ids.push(tab.tab_id);
      rec.listing.positions.push({
        tab_id: tab.tab_id,
        hospital_id: tab.hospital ? tab.hospital.id : null,
        position: card.position,
      });
      rec._nbsp = rec._nbsp || card.name_has_nbsp;
    }
  }

  // ---- insurance: one flat list, every unit ----
  insuranceCards.forEach((card, i) => {
    const rec = attach(
      {
        kind: "insurance",
        category: categories[i],
        name: card.name,
        name_raw: card.name_raw,
        hospitals: hospitals.map((h) => ({ id: h.id, name: h.name })),
        hospital_scope: "site_wide",
        listing: {
          section: "insuranceTieUps",
          tab_ids: [],
          positions: [{ tab_id: null, hospital_id: null, position: card.position }],
        },
        _nbsp: card.name_has_nbsp,
      },
      card
    );
    records.push(rec);
  });

  // ---- per-record issues that only need pass-1 data ----
  for (const rec of records) {
    const issues = [];
    if (!rec.post_id) issues.push("no_cpt_match");
    if (rec._nbsp) issues.push("name_has_nbsp");
    if (!rec.logo || !rec.logo.src) issues.push("no_logo");
    if (rec.logo && !rec.logo.alt) issues.push("logo_missing_alt");
    if (rec.kind === "corporate" && rec.listing.positions.length > 1) {
      issues.push("duplicate_name_across_tabs");
    }
    if (rec.kind === "corporate" && !rec.hospitals.length) issues.push("no_hospital_assigned");
    if (rec.kind === "insurance") {
      issues.push("insurance_not_hospital_scoped");
      issues.push("hospital_scope_inferred_all_units");
      issues.push("tpa_classification_inferred");
    }
    if (
      rec.post_title &&
      rec.name &&
      nameKey(rec.post_title) !== nameKey(rec.name)
    ) {
      issues.push("card_name_differs_from_post_title");
    }
    delete rec._nbsp;
    rec.issues = issues;
    rec.seo = null;
    rec.seo_issues = [];
  }

  return { records, matchedSrc };
}

// ---------- pass 2: a /tie-up-list/<slug>/ page ----------

function scrapeTieUpDetail(html, rec) {
  const $ = cheerio.load(html);
  const url = rec.post_link;

  const bodyClass = $("body").attr("class") || "";
  const classMatch = bodyClass.match(/\bpostid-(\d+)\b/);
  const shortlink = $('link[rel="shortlink"]').attr("href") || "";
  const shortMatch = shortlink.match(/[?&]p=(\d+)/);
  const pageId = classMatch ? Number(classMatch[1]) : shortMatch ? Number(shortMatch[1]) : null;

  const banner = $("section.page-banner").first();
  const heading = collapse(banner.find("h2").first().text());
  const breadcrumb = extractVisibleBreadcrumb($, banner);

  // The blog template's body: a `.blog-para` that holds an <h3> of the name and
  // nothing else. Measured, not assumed — see the header.
  const $para = $("section.blog-sec .blog-para").first();
  const bodyText = collapse($para.clone().find("h3").remove().end().text());
  const detailHeading = collapse($para.find("h3").first().text());
  const detailImage = absoluteUrl($("section.blog-sec .position-relative > img").first().attr("src"));
  const detailDate = collapse($("section.blog-sec .blog-info .fa-calendar").parent().text());
  const detailAuthor = collapse($("section.blog-sec .blog-info .fa-user").parent().text());

  const seo = extractSeo($, url);
  seo.breadcrumbs = extractBreadcrumbs(seo.json_ld);

  const issues = seo.seo_issues.filter(
    (c) => c !== "no_post_specific_schema" && c !== "no_post_specific_meta"
  );
  if (seo.og.image && /\/logo\.[a-z]+$/i.test(seo.og.image)) issues.push("og_image_generic_logo");
  if (seo.og.image && rec.logo && rec.logo.src && seo.og.image !== rec.logo.src) {
    issues.push("og_image_ignores_featured_image");
  }
  if (!seo.twitter.url) issues.push("missing_twitter_url");
  if (!seo.meta_description) issues.push("missing_meta_description");
  if (!bodyText) issues.push("detail_page_has_no_body_content");
  if (breadcrumb.some((c) => c.url && /\/blog\/?$/.test(c.url))) issues.push("breadcrumb_points_to_blog");
  if (!detailAuthor) issues.push("detail_page_author_empty");
  if (rec.post_id != null && pageId != null && rec.post_id !== pageId) issues.push("id_mismatch_with_rest");
  seo.seo_issues = issues;

  return {
    page_id: pageId,
    heading,
    breadcrumb,
    detail_heading: detailHeading,
    detail_image: detailImage,
    detail_date: detailDate,
    detail_author: detailAuthor,
    body_text: bodyText,
    seo,
    seo_issues: issues,
  };
}

// ---------- pass 2b: the per-hospital carousel ----------

/**
 * Fetch each /hospital/<slug>/ and read its `section#priCITP` insurance strip.
 * The point is the comparison, not the data: if all five render the same logos
 * (they do today), insurance provably has no per-hospital dimension.
 */
async function loadHospitalCarousels(hospitals, postBySrc) {
  const units = [];
  for (const h of hospitals) {
    const slug = (h.name || "").toLowerCase().replace(/\s+/g, "-");
    const url = `${SITE_ORIGIN}/hospital/${slug}/`;
    const { html, fromCache: cached } = await fetchHtml(url, `tie-up/hospital-${slug}`);
    if (!cached) await sleep(REQUEST_DELAY_MS);
    if (!html) {
      console.log(`[warn] carousel: could not load ${url}`);
      units.push({ hospital_id: h.id, hospital_name: h.name, url, logos: null, names: null });
      continue;
    }
    const $ = cheerio.load(html);
    const logos = [];
    $("section#priCITP ul#slide_tie_up li.slid-item img").each((_, el) => {
      const src = absoluteUrl($(el).attr("src"));
      if (src) logos.push(src);
    });
    const names = logos.map((src) => {
      const p = postBySrc.get(src);
      return p ? decodeHtml(p.title && p.title.rendered) : null;
    });
    units.push({ hospital_id: h.id, hospital_name: h.name, url, logos, names });
  }

  const signatures = units.map((u) => (u.logos ? u.logos.join("|") : null));
  const first = signatures[0];
  const identical = signatures.length > 0 && signatures.every((s) => s !== null && s === first);
  const issues = [];
  if (identical) issues.push("insurance_carousel_identical_across_hospitals");
  if (units.some((u) => !u.logos || !u.logos.length)) issues.push("insurance_carousel_missing");

  console.log(
    `[info] hospital carousels: ${units.length} units, ${identical ? "IDENTICAL" : "DIFFERENT"}` +
      ` (${units[0] && units[0].logos ? units[0].logos.length : 0} logos each)`
  );

  return {
    identical,
    logo_count: units[0] && units[0].logos ? units[0].logos.length : 0,
    names: units[0] ? units[0].names : null,
    unresolved_logos: units[0] && units[0].names ? units[0].names.filter((n) => !n).length : null,
    checked: units.map((u) => ({
      hospital_id: u.hospital_id,
      hospital_name: u.hospital_name,
      url: u.url,
      logo_count: u.logos ? u.logos.length : null,
    })),
    logos: units[0] ? units[0].logos : null,
    issues,
  };
}

// ---------- pass 1 assembly ----------

async function loadTieUpList(fromList) {
  if (fromList) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), fromList), "utf-8"));
    console.log(`[info] tie-up list from ${fromList}: ${raw.length} records`);
    // Rebuild the hospital roster from the records themselves so --from-list
    // still emits it; hub/orphans/carousel need pages this run never fetches.
    const seen = new Map();
    for (const r of raw) for (const h of r.hospitals || []) if (!seen.has(h.id)) seen.set(h.id, h);
    return {
      records: raw,
      hub: null,
      hospitals: [...seen.values()],
      hospitalIssues: [],
      cptOrphans: [],
      postBySrc: new Map(),
    };
  }

  const parsed = await loadHub();

  const { data } = await fetchJson(REST_URL, "api/tie-up-list");
  if (!Array.isArray(data) || !data.length) {
    throw new Error(`could not load the tie-up-list CPT from ${REST_URL}`);
  }
  console.log(`[info] REST: ${data.length} tie-up-list posts`);

  const media = await loadMedia(data.map((d) => d.featured_media));
  const postBySrc = new Map();
  for (const d of data) {
    const m = media.get(d.featured_media) || null;
    d._media = m;
    if (m && m.source_url && !postBySrc.has(m.source_url)) postBySrc.set(m.source_url, d);
  }

  const { records, matchedSrc } = buildRecords(parsed, postBySrc);

  const cptOrphans = data
    .filter((d) => !d._media || !matchedSrc.has(d._media.source_url))
    .map((d) => ({
      post_id: d.id,
      slug: d.slug,
      name: decodeHtml(d.title && d.title.rendered),
      url: d.link || `${SITE_ORIGIN}/tie-up-list/${d.slug}/`,
      post_date: d.date || null,
      post_modified: d.modified || null,
      post_status: d.status || null,
      logo: buildLogo(d._media, null),
      issues: ["cpt_orphan"].concat(d._media ? [] : ["no_featured_image"]),
    }));

  const unmatchedCards = records.filter((r) => !r.post_id).length;
  if (unmatchedCards) {
    console.log(`[warn] ${unmatchedCards}/${records.length} cards matched no CPT post (by featured image)`);
  }
  if (cptOrphans.length) {
    console.log(`[warn] ${cptOrphans.length}/${data.length} CPT posts render nowhere on /tie-up/`);
  }

  return {
    records,
    hub: parsed.hub,
    hospitals: parsed.hospitals,
    hospitalIssues: parsed.hospitalIssues,
    cptOrphans,
    postBySrc,
  };
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    out: "ils_tie_ups.json",
    indexOut: "tie_ups.json",
    limit: null,
    slug: null,
    fromList: null,
    indexOnly: false,
    hospitalCheck: true,
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
      case "--no-hospital-check":
        opts.hospitalCheck = false;
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
  const { out, indexOut, limit, slug, fromList, indexOnly, hospitalCheck, fromCache, refresh } =
    parseArgs();
  cacheMode.fromCache = fromCache;
  cacheMode.refresh = refresh;
  if (fromCache) console.log(`[info] --from-cache: reading HTML from ${CACHE_DIR}, no network.`);
  if (refresh) console.log("[info] --refresh: re-fetching every page, overwriting cache.");

  const { records, hub, hospitals, hospitalIssues, cptOrphans, postBySrc } =
    await loadTieUpList(fromList);
  if (!records.length) {
    console.error("[error] no tie-up records found.");
    process.exit(1);
  }

  if (!fromList) {
    const indexPath = path.resolve(process.cwd(), indexOut);
    fs.writeFileSync(indexPath, JSON.stringify(records, null, 2), "utf-8");
    console.log(`[info] pass 1: ${records.length} tie-up records -> ${indexPath}`);
  }
  if (indexOnly) {
    console.log("[done] --index-only: stopping after pass 1.");
    return;
  }

  // Pass 2: only records that resolved to a CPT post have a detail page.
  let detailList = records.filter((r) => r.post_id && r.post_link);
  if (slug) detailList = detailList.filter((r) => r.slug === slug);
  if (limit) detailList = detailList.slice(0, limit);

  for (const rec of detailList) {
    console.log(`[info] Fetching tie-up detail: ${rec.post_link}`);
    const { html, fromCache: cached } = await fetchHtml(rec.post_link, `tie-up-list/${rec.slug}`);
    if (!html) {
      console.error(`  [error] no HTML for ${rec.post_link}`);
      rec.issues.push("detail_page_unreachable");
      continue;
    }
    try {
      const detail = scrapeTieUpDetail(html, rec);
      rec.detail = {
        page_id: detail.page_id,
        heading: detail.heading,
        breadcrumb: detail.breadcrumb,
        detail_heading: detail.detail_heading,
        detail_image: detail.detail_image,
        detail_date: detail.detail_date,
        detail_author: detail.detail_author,
        body_text: detail.body_text,
      };
      rec.seo = detail.seo;
      rec.seo_issues = detail.seo_issues;
    } catch (e) {
      console.error(`  [error] failed to parse ${rec.post_link}: ${e.message}`);
    }
    if (!cached) await sleep(REQUEST_DELAY_MS);
  }

  const carousel =
    hospitalCheck && hospitals.length && !fromList
      ? await loadHospitalCarousels(hospitals, postBySrc)
      : null;

  const corporate = records.filter((r) => r.kind === "corporate");
  const insurance = records.filter((r) => r.kind === "insurance");

  const hospitalSummary = hospitals.map((h) => {
    const mine = corporate.filter((r) => r.hospitals.some((x) => x.id === h.id));
    const issues = [];
    if (!mine.length) issues.push("hospital_has_no_corporate_tieups");
    if (hospitalIssues.some((i) => i.id === h.id)) issues.push("hospital_option_value_empty");
    return {
      id: h.id,
      name: h.name,
      slug: (h.name || "").toLowerCase().replace(/\s+/g, "-"),
      corporate_count: mine.length,
      corporate_names: mine.map((r) => r.name),
      insurance_count: insurance.length,
      insurance_scope: "site_wide",
      issues,
    };
  });

  const result = {
    hub,
    hospitals: hospitalSummary,
    corporate,
    insurance,
    cpt_orphans: cptOrphans,
    hospital_insurance_carousel: carousel,
    issue_tallies: {},
  };

  const tally = {};
  const bump = (k) => (tally[k] = (tally[k] || 0) + 1);
  for (const r of records) {
    for (const k of r.issues || []) bump(k);
    for (const k of r.seo_issues || []) bump(k);
  }
  for (const o of cptOrphans) for (const k of o.issues || []) bump(k);
  for (const h of hospitalSummary) for (const k of h.issues || []) bump(k);
  if (hub) for (const k of hub.seo_issues || []) bump(k);
  if (carousel) for (const k of carousel.issues || []) bump(k);
  result.issue_tallies = tally;

  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");

  const kinds = {
    corporate: corporate.length,
    insurer: insurance.filter((r) => r.category === "insurer").length,
    tpa: insurance.filter((r) => r.category === "tpa").length,
    cpt_orphans: cptOrphans.length,
  };
  console.log(
    `[done] Scraped ${records.length} tie-ups (${detailList.length} detail pages) -> ${outPath}`
  );
  console.log("[info] kinds:", kinds);
  console.log(
    "[info] corporate per hospital:",
    Object.fromEntries(hospitalSummary.map((h) => [`${h.name}(${h.id})`, h.corporate_count]))
  );
  console.log("[seo]  issue tally:", tally);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
