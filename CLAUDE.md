# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A set of standalone Node.js scrapers that extract every content type from ilshospitals.com (a WordPress site) into JSON — blog posts, taxonomies, departments, doctors, key procedures, health packages, hospitals, events, OPD schedules, FAQs, testimonials, job postings, CSR initiatives, the photo gallery — together with a full SEO/JSON-LD audit of each page. There is no build, no test suite, and no framework: each `ils-*-scraper.js` is a CLI entry point run directly with `node`.

## Commands

```bash
npm install                       # axios, cheerio, puppeteer

# Content-type scrapers (each writes its own JSON to CWD)
node ils-blog-scraper.js --out ils_blogs_v2.json     # 465 posts (47 listing pages)
node ils-taxonomy-scraper.js                          # ils_categories.json + ils_tags.json
node ils-department-scraper.js                        # 60  -> ils_departments.json
node ils-doctor-scraper.js                            # 375 -> ils_doctors.json
node ils-key-procedure-scraper.js                     # 115 -> ils_key_procedures.json
node ils-health-package-scraper.js                    # 35  -> ils_health_packages.json
node ils-hospital-scraper.js                          # 5   -> ils_hospitals.json (npm start)
node ils-event-scraper.js                             # 34  -> ils_events.json
node ils-opd-scraper.js                               # 374 -> ils_opd_schedules.json (166 with timings)
node ils-faq-scraper.js                               # 9 categories / 14 Q&A + 21 standalone -> ils_faqs.json
node ils-testimonial-scraper.js                       # 68 -> ils_testimonials.json
node ils-career-scraper.js                            # 29 -> ils_careers.json
node ils-csr-scraper.js                               # 13 -> ils_csr.json
node ils-gallery-scraper.js                           # 85 images, single page -> ils_gallery.json
node ils-press-media-scraper.js                       # 97 -> ils_press_and_media.json
node ils-publication-scraper.js                       # 3 -> ils_publications.json
node ils-times-scraper.js                             # 7 -> ils_times.json
node ils-about-us-scraper.js                          # 10 members + 26 awards -> ils_members.json, ils_awards.json, ils_about_us.json

# Render scraped posts/departments back to HTML for eyeballing
node export-html.js --in ils_blogs_v2.json --out export
node export-html.js --slug some-post-slug
```

Common flags on every scraper except the hospital one:

- `--from-cache` — reparse the on-disk HTML in `.cache/`, zero network. **Use this while iterating on parsing logic**; a cold full run of the larger scrapers takes 10+ minutes because of the 800 ms politeness delay.
- `--refresh` — re-fetch everything and overwrite the cache.
- `--slug <slug>` / `--limit N` — narrow the run to one or a few pages (the closest thing to a single test).
- `--from-list <file>` — drive the detail pass from a previously written index file.
- `--index-only` — doctors/procedures/packages/events/opd/faq/testimonials/career/csr/press: run pass 1 and stop, writing just the small index file (`doctors.json`, `key_procedures.json`, `health_packages.json`, `events.json`, `opd_schedules.json`, `faqs.json`, `testimonials.json`, `careers.json`, `csr.json`, `press_and_media.json`).
- `--no-standalone` — faq only: skip the `faq-question-answer` posts, keeping just the 9 `/faq-lists/` categories.

`ils-gallery-scraper.js` is the other odd one out alongside the hospital scraper: the gallery is a single static page with no CPT, index, or detail pass, so it only takes `--out`/`--from-cache`/`--refresh` — no `--slug`, `--limit`, `--from-list` or `--index-only`.

## Architecture

### `scrape-lib.js` — shared plumbing

Everything site-agnostic plus the SEO extractor lives here: `fetchHtml` / `fetchJson` (retry + backoff + on-disk cache), `extractSeo`, `extractJsonLdSchemas`, `normalizeHtmlWhitespace`, `slugFromUrl`. `cacheMode` is a mutable singleton that each script's `main()` sets from its CLI args before any fetch — that is how `--from-cache` / `--refresh` reach the fetch layer.

`ils-hospital-scraper.js` predates the library and has its own inline `extractSEO`/fetch. It is the odd one out; the other six all go through `scrape-lib`.

### The cache is the substrate

`.cache/<kind>/<key>.html|json` (gitignored) holds the raw response body for every page ever fetched: `posts/`, `listing/`, `departments/`, `doctors/`, `key-procedures/`, `health-packages/`, `events/`, `event/`, `opd-schedules/`, `faqs/`, `faq-lists/`, `testimonials/`, `testimonial/`, `category/`, `tag/`, `career/`, `job/`, `csr/`, `gallery/`, `press-and-media/`, `api/`. Parsers are pure functions of these files, so re-running with `--from-cache` after a parser change is cheap and deterministic.

`ils-taxonomy-scraper.js` **hard-depends** on `.cache/listing/` existing — it derives post↔term membership by re-walking the cached blog listing pages, and throws if the blog scraper has not run.

### Two-pass pattern

Doctors, procedures and packages all follow the same shape: pass 1 parses a single server-rendered listing page (which is the *only* source for some fields — hospital availability via `hospital-<id>` CSS classes on packages, department/hospital ids via `data-speciality` on doctor cards, parameter counts and prices on package cards) and emits a small index file; pass 2 visits each detail page for body content, cross-references and SEO. WP REST (`/wp-json/wp/v2/...`) supplies post ids and dates.

`ils-career-scraper.js` follows the same shape for the same reason: hospital availability for a job posting (postmeta `show_in_hospitals`) is never REST-exposed, so it only exists as `hospital_<id>` CSS classes on each `.job_card` div on the single `/career/` listing page (department is `dept_<id>` classes there too, though that one *is* also available from the `job-departments` REST taxonomy). The id -> hospital name map comes from that same page's `#hospital_dropdown` `<select>`.

### Dataset join order

The datasets reference each other by WordPress post id, so scrape in this order:

`departments → opd → doctors → key procedures`

`ils-doctor-scraper.js` reads `ils_departments.json` and, when present, `ils_opd_schedules.json` (folding each unit's `timings` into the matching `hospital_availability` entry by doctor id + hospital id); `ils-key-procedure-scraper.js` reads both `ils_departments.json` and `ils_doctors.json`. All degrade to a warning (unresolved ids / empty `timings`) if the file is missing, so any scraper still runs standalone.

`ils-event-scraper.js`, `ils-opd-scraper.js`, `ils-faq-scraper.js`, `ils-testimonial-scraper.js` and `ils-csr-scraper.js` stand alone. OPD schedules are NOT on their own detail pages — `/opd-schedules/<slug>/` 302-redirects to the listing, which reuses the `/doctors-list/` `li.doctorCard` markup and embeds the schedule inline (`.opd-table-tabs` / `.opd-timing`). Events mirror the academia `course` pages (`.csr-sec-item` cards → `/event/<slug>/` detail with `section.csr-sec-for-page`) — CSR is in fact the post type those theme classes are *named* for; events and CSR just share templates. Unlike `/events/`, the `/csr/` hub does not paginate (all 13 cards render on one page; `/csr/page/2/` 500s), so `ils-csr-scraper.js` fetches it once rather than walking `/csr/page/N/`. FAQs live in **two** unrelated post types: `faq-lists` (the 9 categories the `/frequently-asked-questions/` hub links to, each a `.faq-accordian-box` accordion of sibling `.faq-question`/`.faq-answer` pairs — 14 pairs in all, and REST exposes no content for them so the HTML is the only source) and `faq-question-answer` (21 standalone Q&As with question = title, answer = content, both straight from REST; these are the randomized FAQ cards the department scraper skips). Testimonials (`testimonial` CPT, 68 items, no pagination) are the odd one out for linking: the `/testimonial/` listing cards have **no href at all**, so WP REST is the *only* route to a detail URL — there is nothing to join by slug. Detail pages embed either a YouTube (47) or Facebook (21) video behind the same broken-markup pattern (see below).

`ils-press-media-scraper.js` also stands alone, and is the one CPT whose cards do **not** link to a detail page: the `/press-and-media/` hub renders the same `.csr-sec-item` markup as CSR/events, but each card's anchor is either an `a[data-lightbox]` pointing at the featured image itself (80 "clipping" scans of newspaper coverage — the card *is* the content) or an `a[target="_blank"]` pointing off-site at the publication (17 "external_article"s, whose href is the post `content` pasted verbatim, trailing `\n\n&nbsp;` and all). So the card carries no slug, no id and no back-link, and the join to WP REST is **by featured image**: card `<img src>` == the media `source_url` (all 97 are distinct; one batched `/wp/v2/media?include=` call resolves them). `/press-and-media/<slug>/` does resolve 200, but it only swaps the `<title>`, banner `<h2>` and breadcrumb leaf and then re-renders the entire 97-card listing as its body — pass 2 visits it for the SEO block and records `detail_page_renders_full_listing` rather than re-parsing those cards.

`ils-gallery-scraper.js` doesn't stand alone so much as have nothing to join: "Gallery" is a single static `page-template-gallery` page, not a WordPress post type, so there is no WP REST call, no listing/detail split, and no index file — one fetch of `/gallery/`, parse the flat grid of `div.gallery-card > a[data-lightbox] > img`, done.

`ils-about-us-scraper.js` covers three pages and two unrelated datasets. Awards: the 26 `.award-box` cards on `/accreditations-awards/` are anchors in a single owl-carousel, and **each card carries two image URLs** — the `<img src>` is a small web-optimised crop, while the *parent* `a[data-lightbox="example-set"]`'s `href` is the full-resolution scan the lightbox popup shows (one shared `data-lightbox` group is why the popup is a carousel over all 26). The anchor wraps the card, so `$('.award-box').find('a')` finds nothing — use `.closest('a')`. Like press/media, the join to WP REST is **by featured image** (card `<img src>` == the post's `featured_media` `source_url`, all 26 distinct) rather than by title, because two distinct posts (12602/12605) share the title "Leading Chain of Multi Specialty Hospitals" and a title join silently loses one. The full-resolution image is an ACF field REST never exposes, so it is resolved back to its media record by filename — batched `?slug[]=` (stripping the `-scaled` / `-e<timestamp>` suffixes WP appends) plus a `?search=` fallback for the 2 whose attachment slug was renamed on re-upload, always confirmed on exact `source_url`. `/about-us/` renders a 14-card subset of the same awards; that is `appears_on`, not a second source. `/award/<slug>/` pages 200 but reuse the CSR template with no body copy and re-show the *small* thumbnail, so pass 2 takes their SEO block and records `detail_page_has_no_body_content`. Members: they live on **two** pages with identical `.leadership-team-sec .team-box` markup — `/about-us/` has the 3 that are also a `leadership-team` CPT (bio behind a bootstrap modal), `/investor/board-of-directors/` has all 10 board members (no modal, no bio, no CPT, 6 on a shared placeholder portrait, designations prefixed `Designation: ` and one carrying a malformed `&kmp;` entity).

### Record defects, never work around them

Every scraper emits a per-record `seo_issues` / `issues` array and prints an aggregate tally at the end of the run (see `status.txt` for a past run's tallies). Codes like `og_image_generic_logo`, `twitter_url_placeholder`, `canonical_points_to_homepage`, `randomized_faq_schema`, `count_mismatch` are the deliverable, not noise — the point of the exercise is auditing the site's SEO. Unparseable JSON-LD is kept verbatim under `_parse_error`/`_raw`; blocks that only parse after control-char repair are tagged `_repaired`.

## Site-specific gotchas encoded in the code

Each scraper's header comment documents the quirks of its content type in detail — **read it before changing selectors**. The load-bearing ones:

- **Meta tag ordering differs by content type.** Blog posts ship the misconfigured AIOSEO block first (homepage values) and the correct theme block second; department/doctor/procedure pages ship the theme block first and AIOSEO second. `extractSeo` resolves og/twitter *last-non-empty-wins*, which is right for posts and right for title/description/canonical elsewhere — but wrong for `og:image`, which AIOSEO overwrites with the generic logo. Those scrapers therefore keep a first-wins reading alongside as `seo.og_theme` / `seo.twitter_theme`, via a locally duplicated `resolveFirst`.
- **`<title>` is unreliable.** Posts ship an empty one; taxonomy archives ship a *listed post's* title leaking out of the theme loop. Hence `meta_title` (raw) plus `meta_title_resolved` (a fallback chain), and `title_leaks_post_title` on archives.
- **`slug` is the identity key**, never `name` — health package names are duplicated across hospital variants at different prices.
- **Sections skipped on purpose** and listed in the file headers (randomized FAQ card triples, byte-identical testimonial carousels and lead forms, the boilerplate "Other Health Packages" strip, the randomized "Other FAQs" strip on `/faq-lists/` pages, the randomized "Other testimonials" strip on `/testimonial/<slug>/` pages). Do not "restore" them; the randomized ones make every rerun diff for no reason.
- **Testimonial video embeds ship broken markup.** `.video-box a.play-video`'s `href` attribute isn't a URL — it's the raw, unescaped `<p><iframe src="...">` markup pasted in verbatim. This breaks cheerio's own re-parse of the anchor (for the 21 Facebook-hosted ones the reconstructed DOM loses the `src` entirely, splitting it across bogus attributes), so `ils-testimonial-scraper.js` regexes the *raw* HTML string for the iframe `src` instead of anything cheerio has parsed — read `extractVideo()` before touching this selector.
- **Extracted HTML is whitespace-normalized** (`normalizeHtmlWhitespace`) so it round-trips through JSON readably. This is rendering-identical only because the corpus contains no `<pre>`/`<code>`/`<textarea>`.
- **Job detail fields ship doubly-nested markup.** Each field in `section.job-sec-details` (Education Qualification, Specialty, Experience, Job Description) is a `<p>` wrapper with WYSIWYG content — itself a `<p>` or `<ul>` — pasted straight inside it. Since `<p>` can't contain block content, the parser auto-closes the wrapper on the inner tag, leaving an empty `<p>`, the real content, and a second orphaned empty `<p>` as three siblings. `ils-career-scraper.js`'s `extractJobFields()` filters to non-empty siblings rather than assuming the value is always the first `<p>` child (see its header comment).
- **Every job detail page ships an identical, wrong breadcrumb** — "Get in Touch - Investor - `<job title>`" — hardcoded in the template regardless of the actual job. Recorded verbatim plus a `broken_breadcrumb_hardcoded` issue on every record, not corrected.

## Output files

`ils_*.json` are the full scraped datasets; the bare `departments.json`, `doctors.json`, `key_procedures.json`, `health_packages.json`, `events.json`, `opd_schedules.json`, `faqs.json`, `testimonials.json`, `careers.json`, `csr.json`, `press_and_media.json` are the small pass-1 / index files. `ils_events.json` is the full event dataset; `ils_opd_schedules.json` is the per-doctor OPD schedule (source of the `timings` merged into `ils_doctors.json`). `ils_faqs.json`, `ils_testimonials.json` and `ils_press_and_media.json` are the array-backed datasets that are objects rather than arrays — `{ hub, categories, standalone_questions }`, `{ listing, testimonials }` and `{ hub, items }` respectively (the `hub`/`listing` key is null when the run replays a `--from-list` index, since that page is then never fetched). `ils_gallery.json` is also a single object rather than an array (`{ url, title, breadcrumb, image_count, images, seo, seo_issues }`), but for the opposite reason — there is exactly one page, not a hub over many. `ils_about_us.json` is likewise an object, not an array — the three page-level SEO blocks (`/about-us/`, `/accreditations-awards/`, `/investor/board-of-directors/`), an `awards_carousel` summary of the lightbox popup, the `members` and `awards` arrays also written standalone to `ils_members.json` / `ils_awards.json`, the sitemap audit, and `issue_tallies`. `ils_blogs_v2.json` is the current blog dataset (it has the `content` field); `ils_blogs.json` and `ils_blogs_2.json` are earlier runs without it. `saltlake.html` is a saved sample page kept for selector work.
