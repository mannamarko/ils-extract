#!/usr/bin/env node
/**
 * ILS Hospitals OPD Schedule Scraper (Node.js)
 * ---------------------------------------------------------------
 * Extracts the per-hospital weekly OPD (out-patient department) consulting
 * timings for every doctor listed at
 *   https://ilshospitals.com/opd-schedules/
 * into JSON (default ils_opd_schedules.json + the small index opd_schedules.json).
 *
 * SINGLE PASS, LISTING ONLY. Unlike doctors/procedures/packages there is no
 * detail-page pass: `opd-schedules` IS a WordPress custom post type (229 posts
 * via WP REST, one per doctor+unit), but its front-end permalink
 * /opd-schedules/<slug>/ **302-redirects straight back to /opd-schedules/** —
 * the CPT has no public single template. So the listing page is the only source,
 * and everything is parsed from it.
 *
 * THE LISTING IS THE DOCTORS LISTING. /opd-schedules/ renders the exact same
 * 375 `li.doctorCard` markup as /doctors-list/ (same data-doctorid,
 * data-hospitals, data-speciality, same filter sidebar), so the card + filter
 * parsing here is a deliberate copy of ils-doctor-scraper.js. What it adds is an
 * inline schedule inside ~168 of the cards:
 *
 *   <div class="opd-table-tabs">
 *     <button class="tablink active" data-id="341">Saltlake</button>   (one per hospital)
 *   </div>
 *   <div class="opd-table-tabs-container">
 *     <div class="tabcontent active" data-hospital="341">
 *       <div class="opd-timing"><ul>
 *         <li><span>Monday</span><p>10AM - 12 PM</p></li>
 *         <li><span>Tuesday</span><p></p></li>          (empty <p> => not that day)
 *         ...Sunday
 *       </ul></div>
 *     </div>
 *   </div>
 *
 * All seven days are emitted per hospital, `time` null when the <p> is empty, so
 * a caller can tell "closed that day" (present, null) from "no schedule at all"
 * (hospital/doctor absent). NOTE the source day label typo "Thusday" (Thursday),
 * normalized here.
 *
 * JOIN KEY. The card's data-doctorid equals the doctor's WP post id exactly
 * (7525 -> dr-om-tantia), and the tab data-id / tabcontent data-hospital equal
 * the hospital ids used in ils_doctors.json's hospital_availability (341=Saltlake
 * ...). ils-doctor-scraper.js reads this file and folds `timings` into each
 * hospital_availability entry by that id pair.
 *
 * Requires: axios, cheerio (npm install axios cheerio)
 *
 * Usage:
 *   node ils-opd-scraper.js                       # all -> ils_opd_schedules.json
 *   node ils-opd-scraper.js --slug dr-om-tantia
 *   node ils-opd-scraper.js --limit 20
 *   node ils-opd-scraper.js --index-only          # just opd_schedules.json
 *   node ils-opd-scraper.js --from-cache          # reparse cached HTML, no network
 *   node ils-opd-scraper.js --refresh             # re-fetch, overwrite cache
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const { CACHE_DIR, cacheMode, slugFromUrl, fetchHtml } = require("./scrape-lib");

const LISTING_URL = "https://ilshospitals.com/opd-schedules/";

// Canonical Mon..Sun order, with the source's "Thusday" typo mapped in.
const DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_NORMALIZE = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  thusday: "Thursday", // source typo
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

const collapse = (s) => (s || "").replace(/\s+/g, " ").trim() || null;

/** "|341||342|" -> [341, 342] */
function parsePipeIds(value) {
  if (!value) return [];
  const ids = [];
  for (const part of value.split("|")) {
    const n = parseInt(part, 10);
    if (Number.isFinite(n) && !ids.includes(n)) ids.push(n);
  }
  return ids;
}

/**
 * The filter sidebar ships id -> name maps as checkbox inputs, tagged by
 * data-type: "doctor", "speciality" (departments), "hospitals". Same shape as
 * the doctors-list page.
 */
function parseFilterMap($, type) {
  const map = new Map();
  $(`input.filterCheckbox[data-type="${type}"]`).each((_, el) => {
    const id = parseInt($(el).attr("value"), 10);
    const title = collapse($(el).attr("data-title"));
    if (Number.isFinite(id) && title && !map.has(id)) map.set(id, title);
  });
  return map;
}

/**
 * Parse the inline OPD schedule of one card into
 * [{ hospital_id, hospital_name, timings: [{day, time}] }]. Each hospital tab
 * pairs a `button.tablink[data-id]` with a `.tabcontent[data-hospital]`; the
 * timings come from that tab's `.opd-timing ul li` (span=day, p=time). Returns
 * [] when the card has no schedule block at all.
 */
function parseSchedule($, $card, hospitalNames, issues) {
  const schedule = [];
  const tabs = $card.find(".opd-table-tabs button.tablink");
  if (!tabs.length) return schedule;

  tabs.each((_, btn) => {
    const $btn = $(btn);
    const hospitalId = parseInt($btn.attr("data-id"), 10);
    if (!Number.isFinite(hospitalId)) return;
    const hospitalName = hospitalNames.get(hospitalId) || collapse($btn.text());
    if (!hospitalNames.has(hospitalId) && !issues.includes("hospital_id_not_in_filtermap")) {
      issues.push("hospital_id_not_in_filtermap");
    }

    const $content = $card.find(`.opd-table-tabs-container .tabcontent[data-hospital="${hospitalId}"]`).first();
    const byDay = new Map();
    $content.find(".opd-timing ul li").each((_, li) => {
      const $li = $(li);
      const rawDay = collapse($li.find("span").first().text());
      if (!rawDay) return;
      const day = DAY_NORMALIZE[rawDay.toLowerCase()] || rawDay;
      const time = collapse($li.find("p").first().text());
      byDay.set(day, time || null);
    });

    // Emit all seven days in canonical order; unknown days (if any) appended.
    const timings = [];
    for (const day of DAY_ORDER) {
      if (byDay.has(day)) {
        timings.push({ day, time: byDay.get(day) });
        byDay.delete(day);
      }
    }
    for (const [day, time] of byDay) timings.push({ day, time });

    schedule.push({ hospital_id: hospitalId, hospital_name: hospitalName, timings });
  });

  return schedule;
}

/** One <li class="doctorCard"> -> the OPD record for that doctor. */
function parseCard($, el, hospitalNames) {
  const $card = $(el).find("div.card").first();
  const detailsUrl = $card.find("a.btn-dtc").attr("href") || null;
  const id = parseInt($card.attr("data-doctorid"), 10);
  const issues = [];

  const schedule = parseSchedule($, $card, hospitalNames, issues);
  if (!schedule.length) issues.push("no_schedule");
  else if (schedule.every((h) => h.timings.every((t) => !t.time))) issues.push("schedule_all_empty");

  return {
    doctor_id: Number.isFinite(id) ? id : null,
    name: collapse($card.find(".d-content-box h4").first().text()),
    slug: slugFromUrl(detailsUrl),
    url: detailsUrl,
    photo: $card.find("img.img-d").first().attr("src") || null,
    hospital_ids: parsePipeIds($card.attr("data-hospitals")),
    department_ids: parsePipeIds($card.attr("data-speciality")),
    schedule,
    issues,
  };
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    out: "ils_opd_schedules.json",
    indexOut: "opd_schedules.json",
    limit: null,
    slug: null,
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
  const { out, indexOut, limit, slug, indexOnly, fromCache, refresh } = parseArgs();
  cacheMode.fromCache = fromCache;
  cacheMode.refresh = refresh;
  if (fromCache) console.log(`[info] --from-cache: reading HTML from ${CACHE_DIR}, no network.`);
  if (refresh) console.log("[info] --refresh: re-fetching the listing, overwriting cache.");

  console.log(`[info] Fetching listing: ${LISTING_URL}`);
  const { html } = await fetchHtml(LISTING_URL, "opd-schedules/_listing");
  if (!html) throw new Error(`could not load ${LISTING_URL}`);

  const $ = cheerio.load(html);
  const hospitalNames = parseFilterMap($, "hospitals");

  let records = [];
  const seen = new Set();
  $("li.doctorCard").each((_, el) => {
    const rec = parseCard($, el, hospitalNames);
    if (!rec.slug || seen.has(rec.slug)) return;
    seen.add(rec.slug);
    records.push(rec);
  });
  console.log(`[info] listing: ${records.length} doctors, ${hospitalNames.size} hospitals`);

  if (slug) records = records.filter((r) => r.slug === slug);
  if (limit) records = records.slice(0, limit);
  if (!records.length) {
    console.error("[error] no doctors matched.");
    process.exit(1);
  }

  // Small index: identity only, mirroring doctors.json / courses.json.
  const index = records.map((r) => ({ doctor_id: r.doctor_id, slug: r.slug, name: r.name }));
  const indexPath = path.resolve(process.cwd(), indexOut);
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
  console.log(`[done] Index: ${index.length} doctors -> ${indexPath}`);
  if (indexOnly) return;

  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(records, null, 2), "utf-8");

  const withSchedule = records.filter((r) => r.schedule.length).length;
  const tally = {};
  for (const r of records) for (const k of r.issues || []) tally[k] = (tally[k] || 0) + 1;
  console.log(`[done] Scraped ${records.length} doctors -> ${outPath}`);
  console.log(`[info] ${withSchedule} doctors have an OPD schedule; ${records.length - withSchedule} have none`);
  console.log("[opd]  issue tally:", tally);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
