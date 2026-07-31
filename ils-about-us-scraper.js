#!/usr/bin/env node
/**
 * ILS Hospitals About Us Scraper (Members & Awards) (Node.js)
 * ---------------------------------------------------------------
 * Separately extracts Leadership Team / Members Data and Awards & Accreditations
 * from:
 *   - https://ilshospitals.com/about-us/
 *   - https://ilshospitals.com/accreditations-awards/ (discovered via sitemap)
 *   - https://ilshospitals.com/investor/board-of-directors/
 *   - WP REST API endpoints:
 *       /wp-json/wp/v2/leadership-team
 *       /wp-json/wp/v2/award
 *       /wp-json/wp/v2/media  (batched, for both award image sizes)
 *   - https://ilshospitals.com/sitemap/ (HTML & XML audit)
 *
 * OUTPUT FILES:
 *   - ils_members.json   (Array of leadership/board members with bio & SEO)
 *   - ils_awards.json    (Array of awards & accreditations with both image sizes & SEO)
 *   - ils_about_us.json  (Combined report with page SEO, members, awards & sitemap audit)
 *
 * Usage:
 *   node ils-about-us-scraper.js                       # scrape & write all JSON files
 *   node ils-about-us-scraper.js --from-cache          # reparse cached HTML, no network
 *   node ils-about-us-scraper.js --refresh             # re-fetch, overwrite cache
 *
 * ---------------------------------------------------------------
 * SITE QUIRKS ENCODED HERE — read before changing selectors.
 *
 * AWARDS
 *
 * 1. Each card ships TWO images, and the card markup only exposes the small one.
 *    The `/accreditations-awards/` grid is an owl-carousel of 26 anchors shaped
 *
 *        a[href=<FULL image>][data-lightbox="example-set"][data-title=<title>]
 *          > div.award-box > img[src=<THUMBNAIL webp>] + p[title]
 *
 *    The `<img>` is a small (typically ~500px) web-optimised crop; the anchor's
 *    `href` is the full-resolution scan of the certificate/trophy photo that the
 *    lightbox2 popup shows, and every anchor shares the SAME `data-lightbox`
 *    group ("example-set") — that is why the popup is a carousel across all 26.
 *    The anchor is the card's PARENT, not a descendant, so `$('.award-box')
 *    .find('a')` finds nothing; use `.closest('a')`. Both URLs are recorded
 *    (`image` = thumbnail, `full_image` = lightbox target).
 *
 * 2. The join to WP REST is BY FEATURED IMAGE, not by title. Two distinct award
 *    posts (12602, 12605) share the exact title "Leading Chain of Multi
 *    Specialty Hospitals", so a title join collapses them into one record and
 *    loses an award. Each card's `<img src>` is byte-identical to its post's
 *    `featured_media` `source_url` and all 26 are distinct, so one batched
 *    `/wp/v2/media?include=` call resolves the mapping deterministically.
 *
 * 3. REST titles are HTML-ENCODED, card titles are not ("Best GI, Laparoscopic
 *    &#038; General Surgery Hospital" vs "…&…"). Matching the two raw strings
 *    fails for the 5 titles containing `&`, `–` or `‘`, which used to leave
 *    those cards with no id/slug/detail_url AND re-emit them a second time as
 *    phantom `wp-rest` records. Everything is entity-decoded before comparison.
 *
 * 4. The full-resolution image is an ACF field, not the featured image, so REST
 *    never exposes it directly. It is resolved back to its media record by
 *    filename: a batched `?slug[]=` lookup (WP derives the attachment slug from
 *    the filename, minus the `-scaled` / `-e<timestamp>` suffixes it appends
 *    itself) plus a per-URL `?search=` fallback for the 2 whose slug was
 *    renamed on re-upload (`award-2-rotated.jpeg` -> slug `award-2-2`). Matches
 *    are always confirmed on exact `source_url`, never on the slug guess.
 *
 * 5. `/about-us/` renders the same `.award-box` markup, but only a 14-card
 *    subset of the same awards — it is recorded in `appears_on`, not as a
 *    separate source.
 *
 * 6. `/award/<slug>/` detail pages exist and 200, but reuse the CSR template and
 *    carry no body copy: a banner, a breadcrumb, a heading and the SAME small
 *    thumbnail (never the full scan). Pass 2 visits them for the SEO block and
 *    records `detail_page_has_no_body_content`. There is no theme-authored meta
 *    or ld+json block on them at all, only the site-wide AIOSEO one, so
 *    `no_post_specific_*` fires on every award and is dropped as noise —
 *    `og:image` is the generic logo everywhere instead.
 *
 * MEMBERS
 *
 * 7. Members live on TWO unrelated pages with the same `.leadership-team-sec
 *    .team-box` markup. `/about-us/` has the 3 that are also a `leadership-team`
 *    CPT (with a bio behind a bootstrap modal); `/investor/board-of-directors/`
 *    has all 10 board members (no modal, no bio, no CPT, 6 of them on a shared
 *    placeholder portrait). Only the first page used to be fetched, so 7
 *    directors were missing entirely.
 *
 * 8. Board designations are prefixed "Designation: " in the markup and the first
 *    one ships a malformed entity — "Executive Chairman &kmp;" (source
 *    `&amp;kmp;`, presumably meant to read "(KMP)"). Both are recorded verbatim
 *    in `designation_raw` and flagged, not silently corrected.
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

const ABOUT_URL = "https://ilshospitals.com/about-us/";
const AWARDS_URL = "https://ilshospitals.com/accreditations-awards/";
const BOARD_URL = "https://ilshospitals.com/investor/board-of-directors/";
const SITEMAP_URL = "https://ilshospitals.com/sitemap/";
const SITEMAP_XML = "https://ilshospitals.com/sitemap.xml";

const REST_LEADERS =
  "https://ilshospitals.com/wp-json/wp/v2/leadership-team?per_page=100&_fields=id,slug,link,date,modified,title";
const REST_AWARDS =
  "https://ilshospitals.com/wp-json/wp/v2/award?per_page=100&_fields=id,slug,link,date,modified,title,featured_media";
const REST_MEDIA = "https://ilshospitals.com/wp-json/wp/v2/media";
const MEDIA_FIELDS = "id,slug,source_url,alt_text,mime_type,media_details";

const SITE_ORIGIN = "https://ilshospitals.com";

const collapse = (s) => (s || "").replace(/\s+/g, " ").trim() || null;

/** WP REST returns titles HTML-encoded; the rendered pages do not. */
function decodeEntities(s) {
  if (!s) return null;
  return collapse(cheerio.load(`<x>${s}</x>`)("x").text());
}

function absoluteUrl(href) {
  if (!href) return null;
  const h = href.trim();
  if (!h || h === "#" || h.startsWith("javascript:")) return null;
  if (/^(mailto:|tel:)/i.test(h)) return h;
  try {
    return new URL(h, SITE_ORIGIN).href;
  } catch (e) {
    return h;
  }
}

/** The theme's visible breadcrumb: a banner <span> of <a>s ending in a <strong>. */
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
 * Shared post-processing for every SEO block on these pages: pull the
 * BreadcrumbList out of the AIOSEO @graph (extractSeo only looks in the
 * theme block, which none of these pages ship) and drop the two
 * `no_post_specific_*` codes, which fire on 100% of them and so carry no
 * signal, in favour of the defects that are actually specific.
 */
function refineSeo(seo) {
  if (!seo) return seo;
  if (!seo.breadcrumbs.length) seo.breadcrumbs = extractBreadcrumbs(seo.json_ld);
  const issues = seo.seo_issues.filter(
    (c) => c !== "no_post_specific_schema" && c !== "no_post_specific_meta"
  );
  if (!seo.json_ld.length) issues.push("no_json_ld_at_all");
  if (seo.og.image && /\/logo\.[a-z]+$/i.test(seo.og.image)) issues.push("og_image_generic_logo");
  if (seo.twitter.card && !seo.twitter.url) issues.push("twitter_url_missing");
  if (!seo.meta_description) issues.push("meta_description_missing");
  seo.seo_issues = issues;
  return seo;
}

// ---------------- Media resolution ----------------

/** Split into chunks of `size` (WP REST caps per_page at 100). */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normalizeMedia(m) {
  if (!m) return null;
  const d = m.media_details || {};
  return {
    id: m.id,
    slug: m.slug || null,
    url: m.source_url || null,
    alt_text: trimOrNull(m.alt_text),
    mime_type: m.mime_type || null,
    width: d.width ?? null,
    height: d.height ?? null,
    filesize: d.filesize ?? null,
  };
}

/** One batched /wp/v2/media?include= per 100 ids -> Map(id -> normalized media). */
async function loadMediaByIds(ids, cacheKey) {
  const byId = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return byId;
  const batches = chunk(unique, 100);
  for (let i = 0; i < batches.length; i++) {
    const url = `${REST_MEDIA}?per_page=100&_fields=${MEDIA_FIELDS}&include=${batches[i].join(",")}`;
    const { data, fromCache } = await fetchJson(url, `${cacheKey}-${i}`);
    if (Array.isArray(data)) for (const m of data) byId.set(m.id, normalizeMedia(m));
    if (!fromCache) await sleep(REQUEST_DELAY_MS);
  }
  return byId;
}

const pixels = (m) => (m && m.width && m.height ? m.width * m.height : null);

/**
 * A WebP-conversion plugin rewrote the served file but not the attachment
 * metadata, so 17 of these media records declare image/png or image/jpeg for a
 * URL that ends in `.webp`. Recorded, not corrected.
 */
function mediaMimeMismatch(m) {
  if (!m || !m.url || !m.mime_type) return false;
  const ext = (m.url.split(".").pop() || "").toLowerCase().replace("jpeg", "jpg");
  const declared = m.mime_type.split("/")[1].toLowerCase().replace("jpeg", "jpg");
  return ext !== declared;
}

/**
 * The attachment slug WP would have minted for an upload, derived from the
 * URL's filename: lowercased, extension dropped, and stripped of the two
 * suffixes WP adds itself (`-scaled` on >2560px uploads, `-e<timestamp>` on
 * images edited in the media library). A guess — every hit is re-checked
 * against the exact source_url before it is used.
 */
function mediaSlugGuess(url) {
  if (!url) return null;
  let f;
  try {
    f = decodeURIComponent(new URL(url).pathname.split("/").pop());
  } catch (e) {
    return null;
  }
  return f
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/-scaled$/i, "")
    .replace(/-e\d{10,}$/i, "")
    .toLowerCase();
}

/**
 * Resolve full-size image URLs (the lightbox targets, an ACF field REST never
 * exposes) back to their media records -> Map(url -> normalized media).
 * Batched `?slug[]=` first, then a `?search=` fallback per unresolved URL.
 */
async function loadMediaByUrl(urls, cacheKey) {
  const byUrl = new Map();
  const unique = [...new Set(urls.filter(Boolean))];
  if (!unique.length) return byUrl;

  const slugs = [...new Set(unique.map(mediaSlugGuess).filter(Boolean))];
  const batches = chunk(slugs, 100);
  for (let i = 0; i < batches.length; i++) {
    const q = batches[i].map((s) => `slug[]=${encodeURIComponent(s)}`).join("&");
    const url = `${REST_MEDIA}?per_page=100&_fields=${MEDIA_FIELDS}&${q}`;
    const { data, fromCache } = await fetchJson(url, `${cacheKey}-slugs-${i}`);
    if (Array.isArray(data)) for (const m of data) if (m.source_url) byUrl.set(m.source_url, normalizeMedia(m));
    if (!fromCache) await sleep(REQUEST_DELAY_MS);
  }

  for (const u of unique) {
    if (byUrl.has(u)) continue;
    const term = mediaSlugGuess(u);
    if (!term) continue;
    const url = `${REST_MEDIA}?per_page=20&_fields=${MEDIA_FIELDS}&search=${encodeURIComponent(term)}`;
    const { data, fromCache } = await fetchJson(url, `${cacheKey}-search-${term}`);
    if (Array.isArray(data)) {
      const hit = data.find((m) => m.source_url === u);
      if (hit) byUrl.set(u, normalizeMedia(hit));
    }
    if (!fromCache) await sleep(REQUEST_DELAY_MS);
  }

  console.log(`[info] full images resolved to media: ${byUrl.size}/${unique.length}`);
  return byUrl;
}

// ---------------- Members Extraction ----------------

/**
 * Parse `.leadership-team-sec .team-box` cards. `/about-us/` wraps each in a
 * modal trigger holding the bio; `/investor/board-of-directors/` has neither
 * modal nor bio and prefixes the designation with "Designation: ".
 */
function parseMemberCards($, sourceName) {
  const cards = [];
  $(".leadership-team-sec .team-box").each((position, el) => {
    const $c = $(el);
    const name = collapse($c.find(".details-box p").first().text());
    const designationRaw = collapse($c.find(".details-box small").first().text());
    const designation = designationRaw ? designationRaw.replace(/^Designation:\s*/i, "").trim() : null;
    const image = absoluteUrl($c.find(".image-box img").attr("src"));
    const imageAlt = trimOrNull($c.find(".image-box img").attr("alt"));
    const modalId = $c.find("a[data-bs-target]").attr("data-bs-target");

    let bio = null;
    let bioHtml = null;
    if (modalId) {
      const $m = $(modalId);
      const modalPs = $m.find(".modal-body p");
      if (modalPs.length > 1) {
        // Skip header p if it repeats name/designation
        bioHtml = normalizeHtmlWhitespace(modalPs.slice(1).map((_, p) => $.html(p)).get().join(""));
        bio = collapse(modalPs.slice(1).text());
      } else {
        bioHtml = normalizeHtmlWhitespace($m.find(".modal-body").html());
        bio = collapse($m.find(".modal-body").text());
      }
    }

    cards.push({
      position,
      name,
      designation,
      designation_raw: designationRaw,
      image,
      image_alt: imageAlt,
      bio_html: bioHtml,
      bio_text: bio,
      source: sourceName,
    });
  });
  return cards;
}

async function scrapeMembers() {
  console.log("[info] Scraping Members Data...");
  const { html: aboutHtml } = await fetchHtml(ABOUT_URL, "about-us/index");
  const { html: boardHtml } = await fetchHtml(BOARD_URL, "investor/board-of-directors");
  const { data: restLeaders } = await fetchJson(REST_LEADERS, "api/leadership-team");

  const cards = [
    ...(aboutHtml ? parseMemberCards(cheerio.load(aboutHtml), "about-us") : []),
    ...(boardHtml ? parseMemberCards(cheerio.load(boardHtml), "board-of-directors") : []),
  ];
  console.log(
    `[info] member cards: ${cards.filter((c) => c.source === "about-us").length} on /about-us/, ` +
      `${cards.filter((c) => c.source === "board-of-directors").length} on /investor/board-of-directors/`
  );

  const members = [];
  const byName = new Map();

  for (const c of cards) {
    if (!c.name) continue;
    const existing = byName.get(c.name);
    if (existing) {
      // Same person on both pages: keep the richer record, note the other page.
      existing.appears_on.push(c.source);
      if (!existing.bio_text && c.bio_text) {
        existing.bio_text = c.bio_text;
        existing.bio_html = c.bio_html;
      }
      if (!existing.image) existing.image = c.image;
      if (c.designation && existing.designation && c.designation !== existing.designation) {
        existing.issues.push("designation_differs_between_pages");
        existing.designation_alt = c.designation;
      }
      continue;
    }

    const issues = [];
    if (!c.image) issues.push("image_missing");
    if (c.image && /profile-palceholder/i.test(c.image)) issues.push("placeholder_portrait");
    if (!c.bio_text) issues.push("no_bio");
    if (c.designation_raw && /&[a-z]+;/i.test(c.designation_raw)) issues.push("malformed_entity_in_designation");
    if (c.designation_raw && /^Designation:/i.test(c.designation_raw)) issues.push("designation_label_in_value");

    const m = {
      id: null,
      name: c.name,
      designation: c.designation,
      designation_raw: c.designation_raw,
      image: c.image,
      image_alt: c.image_alt,
      bio_html: c.bio_html,
      bio_text: c.bio_text,
      slug: null,
      detail_url: null,
      published_date: null,
      modified_date: null,
      source: c.source,
      appears_on: [c.source],
      issues,
    };
    byName.set(c.name, m);
    members.push(m);
  }

  // Join to the leadership-team CPT by entity-decoded title, then slug.
  const restSeen = new Set();
  if (Array.isArray(restLeaders)) {
    for (const m of members) {
      const match = restLeaders.find((r) => decodeEntities(r.title?.rendered) === m.name);
      if (!match) {
        m.issues.push("no_leadership_team_post");
        continue;
      }
      restSeen.add(match.id);
      m.id = match.id;
      m.slug = match.slug;
      m.detail_url = match.link || `${SITE_ORIGIN}/leadership-team/${match.slug}/`;
      m.published_date = match.date || null;
      m.modified_date = match.modified || null;
    }

    // Any CPT entry that never showed up on either page.
    for (const r of restLeaders) {
      if (restSeen.has(r.id)) continue;
      const rName = decodeEntities(r.title?.rendered);
      if (!rName || byName.has(rName)) continue;
      const m = {
        id: r.id,
        name: rName,
        designation: null,
        designation_raw: null,
        image: null,
        image_alt: null,
        bio_html: null,
        bio_text: null,
        slug: r.slug,
        detail_url: r.link || `${SITE_ORIGIN}/leadership-team/${r.slug}/`,
        published_date: r.date || null,
        modified_date: r.modified || null,
        source: "wp-rest",
        appears_on: [],
        issues: ["not_rendered_on_any_page"],
      };
      byName.set(rName, m);
      members.push(m);
    }
  }

  // Visit detail pages for SEO
  for (const m of members) {
    if (m.detail_url) {
      console.log(`[info] Fetching member detail: ${m.detail_url}`);
      const { html, fromCache: cached } = await fetchHtml(m.detail_url, `leadership-team/${m.slug}`);
      if (html) {
        const seo = refineSeo(extractSeo(cheerio.load(html), m.detail_url));
        m.seo = seo;
        m.seo_issues = seo.seo_issues;
      } else {
        m.seo = null;
        m.seo_issues = ["fetch_failed"];
      }
      if (!cached) await sleep(REQUEST_DELAY_MS);
    } else {
      m.seo = null;
      m.seo_issues = ["no_detail_url"];
    }
  }

  console.log(`[info] Total members scraped: ${members.length}`);
  return members;
}

// ---------------- Awards Extraction ----------------

/**
 * Parse the owl-carousel of award cards on a page.
 *
 * Shape (see quirk 1 in the header): the LINK IS THE PARENT of `.award-box`,
 * and it is the only place the full-resolution image lives.
 */
function parseAwardCards($, sourceName) {
  const cards = [];
  $(".award-box").each((position, el) => {
    const $c = $(el);
    const $a = $c.closest("a[data-lightbox], a[href]");
    const $img = $c.find("img").first();
    cards.push({
      position,
      source: sourceName,
      card_title: collapse($c.find("p").first().text()),
      lightbox_title: collapse($a.attr("data-title")),
      lightbox_group: trimOrNull($a.attr("data-lightbox")),
      image: absoluteUrl($img.attr("src")),
      image_alt: trimOrNull($img.attr("alt")),
      full_image: absoluteUrl($a.attr("href")),
    });
  });
  return cards;
}

async function scrapeAwards() {
  console.log("[info] Scraping Awards Data...");
  const { html: awardsHtml } = await fetchHtml(AWARDS_URL, "accreditations-awards/index");
  const { html: aboutHtml } = await fetchHtml(ABOUT_URL, "about-us/index");
  const { data: restAwards } = await fetchJson(REST_AWARDS, "api/award-full");

  const hubCards = awardsHtml ? parseAwardCards(cheerio.load(awardsHtml), "accreditations-awards") : [];
  const aboutCards = aboutHtml ? parseAwardCards(cheerio.load(aboutHtml), "about-us") : [];
  console.log(
    `[info] award cards: ${hubCards.length} on /accreditations-awards/, ${aboutCards.length} on /about-us/ (subset)`
  );

  // Featured images (the small webp on each card) -> the REST post they belong to.
  const featuredIds = Array.isArray(restAwards) ? restAwards.map((r) => r.featured_media) : [];
  const featuredById = await loadMediaByIds(featuredIds, "api/media-award-featured");
  const restByFeaturedUrl = new Map();
  if (Array.isArray(restAwards)) {
    for (const r of restAwards) {
      const media = featuredById.get(r.featured_media);
      if (media && media.url) {
        if (restByFeaturedUrl.has(media.url)) console.warn(`  [warn] two awards share featured image ${media.url}`);
        restByFeaturedUrl.set(media.url, { rest: r, media });
      }
    }
  }

  // The full-resolution lightbox targets are an ACF field; resolve by filename.
  const fullById = await loadMediaByUrl(
    hubCards.map((c) => c.full_image),
    "api/media-award-full"
  );

  // /about-us/ carries a subset of the same awards, keyed by full image URL.
  const alsoOnAbout = new Set(aboutCards.map((c) => c.full_image || c.image).filter(Boolean));

  // Distinct titles, so identically-titled awards can be flagged rather than merged.
  const titleCounts = new Map();
  for (const c of hubCards) {
    const t = c.card_title;
    if (t) titleCounts.set(t, (titleCounts.get(t) || 0) + 1);
  }

  const awards = [];
  const matchedRestIds = new Set();

  for (const c of hubCards) {
    const joined = c.image ? restByFeaturedUrl.get(c.image) : null;
    const rest = joined ? joined.rest : null;
    if (rest) matchedRestIds.add(rest.id);

    const restTitle = rest ? decodeEntities(rest.title?.rendered) : null;
    const fullMedia = c.full_image ? fullById.get(c.full_image) || null : null;

    const issues = [];
    if (!c.full_image) issues.push("full_image_missing");
    else if (c.full_image === c.image) issues.push("full_image_same_as_thumbnail");
    else if (!fullMedia) issues.push("full_image_media_unresolved");
    if (fullMedia && fullMedia.width && fullMedia.height && fullMedia.width * fullMedia.height > 4_000_000) {
      issues.push("full_image_very_large");
    }
    if (fullMedia && !fullMedia.alt_text) issues.push("full_image_missing_alt");
    if (mediaMimeMismatch(joined && joined.media) || mediaMimeMismatch(fullMedia)) {
      issues.push("media_mime_type_contradicts_extension");
    }
    if (joined && fullMedia && pixels(fullMedia) && pixels(fullMedia) <= pixels(joined.media)) {
      issues.push("full_image_not_larger_than_thumbnail");
    }
    if (!c.image) issues.push("thumbnail_missing");
    if (c.image_alt && /^ils-award$/i.test(c.image_alt)) issues.push("thumbnail_alt_generic");
    if (!c.image_alt) issues.push("thumbnail_alt_missing");
    if (!rest) issues.push("no_rest_match");
    if (restTitle && c.card_title && restTitle !== c.card_title) issues.push("card_title_mismatches_post_title");
    if (c.card_title && (titleCounts.get(c.card_title) || 0) > 1) issues.push("duplicate_award_title");
    if (c.lightbox_title && c.card_title && c.lightbox_title !== c.card_title) {
      issues.push("lightbox_title_mismatches_card_title");
    }

    awards.push({
      id: rest ? rest.id : null,
      title: c.card_title || restTitle,
      title_rest: restTitle,
      // Small web-optimised crop shown in the grid (unchanged field name).
      image: c.image,
      image_alt: c.image_alt,
      image_media: joined ? joined.media : null,
      // Full-resolution scan behind the lightbox carousel — the popup image.
      full_image: c.full_image,
      full_image_title: c.lightbox_title,
      full_image_media: fullMedia,
      lightbox_group: c.lightbox_group,
      carousel_position: c.position,
      slug: rest ? rest.slug : null,
      detail_url: rest ? rest.link || `${SITE_ORIGIN}/award/${rest.slug}/` : null,
      published_date: rest ? rest.date : null,
      modified_date: rest ? rest.modified : null,
      source: c.source,
      appears_on: [
        "accreditations-awards",
        ...(alsoOnAbout.has(c.full_image) || alsoOnAbout.has(c.image) ? ["about-us"] : []),
      ],
      detail: null,
      issues,
    });
  }

  // Any award post that never rendered a card.
  if (Array.isArray(restAwards)) {
    for (const r of restAwards) {
      if (matchedRestIds.has(r.id)) continue;
      awards.push({
        id: r.id,
        title: decodeEntities(r.title?.rendered),
        title_rest: decodeEntities(r.title?.rendered),
        image: (featuredById.get(r.featured_media) || {}).url || null,
        image_alt: null,
        image_media: featuredById.get(r.featured_media) || null,
        full_image: null,
        full_image_title: null,
        full_image_media: null,
        lightbox_group: null,
        carousel_position: null,
        slug: r.slug,
        detail_url: r.link || `${SITE_ORIGIN}/award/${r.slug}/`,
        published_date: r.date || null,
        modified_date: r.modified || null,
        source: "wp-rest",
        appears_on: [],
        detail: null,
        issues: ["not_rendered_on_any_page", "full_image_missing"],
      });
    }
  }

  // Pass 2: the /award/<slug>/ detail pages, for SEO plus what little they render.
  for (const a of awards) {
    if (!a.detail_url) {
      a.seo = null;
      a.seo_issues = ["no_detail_url"];
      continue;
    }
    console.log(`[info] Fetching award detail: ${a.detail_url}`);
    const { html, fromCache: cached } = await fetchHtml(a.detail_url, `award/${a.slug}`);
    if (!html) {
      a.seo = null;
      a.seo_issues = ["fetch_failed"];
      if (!cached) await sleep(REQUEST_DELAY_MS);
      continue;
    }

    const $d = cheerio.load(html);
    const banner = $d("section.page-banner").first();
    const body = $d("section.csr-sec-for-page").first();
    const bodyText = collapse(body.find("p, li").text());
    const detailImage = absoluteUrl(body.find("img").first().attr("src"));

    a.detail = {
      banner_title: collapse(banner.find("h2").first().text()),
      breadcrumb: extractVisibleBreadcrumb($d, banner),
      heading: collapse(body.find("h2").first().text()),
      image: detailImage,
      body_text: bodyText,
      body_html: bodyText ? normalizeHtmlWhitespace(body.find(".col-md-6").last().html()) : null,
    };

    if (!bodyText) a.issues.push("detail_page_has_no_body_content");
    if (detailImage && a.full_image && detailImage !== a.full_image) {
      a.issues.push("detail_page_shows_thumbnail_not_full_image");
    }
    if (!a.detail.breadcrumb.length) a.issues.push("detail_page_breadcrumb_missing");

    const seo = refineSeo(extractSeo($d, a.detail_url));
    a.seo = seo;
    a.seo_issues = seo.seo_issues;
    if (!a.image) a.image = absoluteUrl($d(".entry-content img, main img").first().attr("src"));
    if (!cached) await sleep(REQUEST_DELAY_MS);
  }

  console.log(`[info] Total awards scraped: ${awards.length}`);
  return { awards, hubCards, aboutCards };
}

// ---------------- Sitemap Audit ----------------

async function auditSitemap() {
  console.log("[info] Auditing Sitemap...");
  const { html: smHtml } = await fetchHtml(SITEMAP_URL, "sitemap/index");
  const { html: smXml } = await fetchHtml(SITEMAP_XML, "sitemap/sitemap_xml");

  const htmlLinks = [];
  if (smHtml) {
    const $ = cheerio.load(smHtml);
    $("a[href]").each((_, el) => {
      const text = collapse($(el).text());
      const href = absoluteUrl($(el).attr("href"));
      if (href && (href.includes("about") || href.includes("award") || href.includes("leadership") || href.includes("board"))) {
        htmlLinks.push({ text, href });
      }
    });
  }

  const xmlUrls = [];
  if (smXml) {
    const $ = cheerio.load(smXml, { xmlMode: true });
    $("loc").each((_, el) => {
      const u = $(el).text().trim();
      if (u.includes("about") || u.includes("award") || u.includes("leadership") || u.includes("board") || u.includes("accreditations")) {
        xmlUrls.push(u);
      }
    });
  }

  return {
    sitemap_html_url: SITEMAP_URL,
    sitemap_xml_url: SITEMAP_XML,
    relevant_html_links: htmlLinks,
    relevant_xml_urls: xmlUrls,
  };
}

// ---------------- CLI & Main ----------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    outMembers: "ils_members.json",
    outAwards: "ils_awards.json",
    outAbout: "ils_about_us.json",
    fromCache: false,
    refresh: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--out-members":
        opts.outMembers = args[++i];
        break;
      case "--out-awards":
        opts.outAwards = args[++i];
        break;
      case "--out-about":
        opts.outAbout = args[++i];
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

function tally(records, key) {
  const counts = {};
  for (const r of records) for (const c of r[key] || []) counts[c] = (counts[c] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

function printTally(label, counts) {
  const entries = Object.entries(counts);
  if (!entries.length) return;
  console.log(`\n[tally] ${label}`);
  for (const [code, n] of entries) console.log(`  ${String(n).padStart(4)}  ${code}`);
}

async function main() {
  const { outMembers, outAwards, outAbout, fromCache, refresh } = parseArgs();
  cacheMode.fromCache = fromCache;
  cacheMode.refresh = refresh;
  if (fromCache) console.log(`[info] --from-cache: reading HTML from ${CACHE_DIR}`);
  if (refresh) console.log("[info] --refresh: re-fetching every page");

  // Page level SEO for /about-us/
  const { html: aboutHtml } = await fetchHtml(ABOUT_URL, "about-us/index");
  const aboutSeo = aboutHtml ? refineSeo(extractSeo(cheerio.load(aboutHtml), ABOUT_URL)) : null;

  // Page level SEO for /accreditations-awards/
  const { html: awardsHtml } = await fetchHtml(AWARDS_URL, "accreditations-awards/index");
  const $awards = awardsHtml ? cheerio.load(awardsHtml) : null;
  const awardsPageSeo = $awards ? refineSeo(extractSeo($awards, AWARDS_URL)) : null;

  // Page level SEO for /investor/board-of-directors/
  const { html: boardHtml } = await fetchHtml(BOARD_URL, "investor/board-of-directors");
  const boardSeo = boardHtml ? refineSeo(extractSeo(cheerio.load(boardHtml), BOARD_URL)) : null;

  const members = await scrapeMembers();
  const { awards, hubCards, aboutCards } = await scrapeAwards();
  const sitemapAudit = await auditSitemap();

  if (awardsPageSeo) {
    if (hubCards.length && hubCards.every((c) => /^ils-award$/i.test(c.image_alt || ""))) {
      awardsPageSeo.seo_issues.push("all_award_images_share_generic_alt");
    }
    if (hubCards.some((c) => !c.full_image)) awardsPageSeo.seo_issues.push("cards_without_full_image");
  }

  // Write separate members JSON
  const membersPath = path.resolve(process.cwd(), outMembers);
  fs.writeFileSync(membersPath, JSON.stringify(members, null, 2), "utf-8");
  console.log(`[done] Written ${members.length} members -> ${membersPath}`);

  // Write separate awards JSON
  const awardsPath = path.resolve(process.cwd(), outAwards);
  fs.writeFileSync(awardsPath, JSON.stringify(awards, null, 2), "utf-8");
  console.log(`[done] Written ${awards.length} awards -> ${awardsPath}`);

  // Combined report JSON
  const aboutReport = {
    page_url: ABOUT_URL,
    page_seo: aboutSeo,
    accreditations_page_url: AWARDS_URL,
    accreditations_page_seo: awardsPageSeo,
    board_page_url: BOARD_URL,
    board_page_seo: boardSeo,
    // The lightbox popup on /accreditations-awards/: every card shares one
    // data-lightbox group, so it opens as a carousel over all the full images.
    awards_carousel: {
      page_url: AWARDS_URL,
      lightbox_group: hubCards.length ? hubCards[0].lightbox_group : null,
      card_count: hubCards.length,
      full_image_count: hubCards.filter((c) => c.full_image).length,
      full_images_resolved_to_media: awards.filter((a) => a.full_image_media).length,
      also_rendered_on_about_us: aboutCards.length,
    },
    members_count: members.length,
    members,
    awards_count: awards.length,
    awards,
    sitemap_audit: sitemapAudit,
    issue_tallies: {
      members: tally(members, "issues"),
      members_seo: tally(members, "seo_issues"),
      awards: tally(awards, "issues"),
      awards_seo: tally(awards, "seo_issues"),
    },
  };

  const aboutPath = path.resolve(process.cwd(), outAbout);
  fs.writeFileSync(aboutPath, JSON.stringify(aboutReport, null, 2), "utf-8");
  console.log(`[done] Written complete About Us audit -> ${aboutPath}`);

  printTally("award issues", aboutReport.issue_tallies.awards);
  printTally("award SEO issues", aboutReport.issue_tallies.awards_seo);
  printTally("member issues", aboutReport.issue_tallies.members);
  printTally("member SEO issues", aboutReport.issue_tallies.members_seo);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
