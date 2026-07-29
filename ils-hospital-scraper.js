#!/usr/bin/env node
/**
 * ILS Hospitals — Hospital Page Scraper
 * -------------------------------------
 * The hospital pages are server-rendered WordPress, so a plain
 * axios + cheerio fetch (same approach as the blog scraper) sees the
 * full markup. Every section is scoped by its stable section id
 * (#priOverview, #priSF, #priRC, #priLocation, #bioMedical, ...)
 * rather than by walking siblings of the heading — the headings live
 * inside their own Bootstrap columns and have no content siblings.
 */

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

const HOSPITAL_URLS = [
  "https://ilshospitals.com/hospital/saltlake/",
  "https://ilshospitals.com/hospital/dumdum/",
  "https://ilshospitals.com/hospital/howrah/",
  "https://ilshospitals.com/hospital/agartala/",
  "https://ilshospitals.com/hospital/raipur/",
];

// ---------- SAME SEO EXTRACTOR AS BLOG SCRAPER ----------
function extractSEO($) {
  const seo = {};
  seo.meta_title = $('meta[name="title"]').attr("content") || $("title").text().trim();
  seo.meta_description = $('meta[name="description"]').attr("content") || "";
  seo.canonical = $('link[rel="canonical"]').attr("href") || "";
  seo.robots = $('meta[name="robots"]').attr("content") || "";

  seo.og = {};
  $('meta[property^="og:"]').each((_, el) => {
    const prop = $(el).attr("property").replace("og:", "");
    seo.og[prop] = $(el).attr("content");
  });

  seo.twitter = {};
  $('meta[name^="twitter:"]').each((_, el) => {
    const name = $(el).attr("name").replace("twitter:", "");
    seo.twitter[name] = $(el).attr("content");
  });

  seo.json_ld = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      seo.json_ld.push(JSON.parse($(el).html()));
    } catch (e) {}
  });

  return seo;
}

function absUrl(base, src) {
  if (!src) return "";
  try {
    return new URL(src, base).href;
  } catch {
    return src;
  }
}

// The theme's templating leaves long runs of spaces/newlines inside
// buttons, <p> and <li>, so every text value goes through this.
function clean(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

async function fetchWithAxios(url) {
  const { data: html } = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ILSHospitalScraper/1.0)" },
    timeout: 20000,
  });
  return html;
}

// ---------- Section parsers ----------
async function scrapeHospital(url) {
  const html = await fetchWithAxios(url);
  const $ = cheerio.load(html);

  const slug = url.replace(/\/$/, "").split("/").pop();
  const banner = $("section.page-banner").first();

  // The only <h1> on the page is the search modal, and the banner also
  // holds a "Good Evening!" greeting <h2> — so scope to .logo-align.
  const name =
    clean(banner.find(".logo-align h2").first().text()) ||
    clean(banner.find("h2").first().text());

  // Banner image is a CSS background on the section, not an <img>.
  const bgMatch = (banner.attr("style") || "").match(/url\(['"]?([^'")]+)/);
  const bannerImg = absUrl(url, bgMatch ? bgMatch[1] : "");

  const logo_for_hospital = banner
    .find(".logo-for-hospital img")
    .map((_, el) => $(el).attr("src"))
    .get()
    .filter(Boolean)
    .map((src) => absUrl(url, src));

  const reviewText = clean(banner.find(".google-rev-cont p").last().text());
  const google_review = /^\d+(\.\d+)?$/.test(reviewText) ? Number(reviewText) : null;

  // ---- Overview ----
  const ovSection = $("#priOverview");
  const overview = ovSection
    .find(".overview-pad-box")
    .children()
    .not("h2")
    .map((_, el) => $.html(el))
    .get()
    .join("\n");
  const overview_img = absUrl(url, ovSection.find("img").first().attr("src"));

  // Counter reads like "85+"; fall back to a regex over the overview copy.
  const counterText = clean(ovSection.find(".page-banner-info p.counter").first().text());
  const counterNum = parseInt(counterText, 10);
  const bedsMatch = ovSection.text().match(/(\d+)\s*beds?/i);
  const number_of_beds = Number.isFinite(counterNum)
    ? counterNum
    : bedsMatch
    ? Number(bedsMatch[1])
    : null;

  // ---- Location & Contacts ----
  const locSection = $("#priLocation");
  const location_contact = {
    address: clean(locSection.find(".address-p").first().text()),
    phone: locSection
      .find(".contact-p a")
      .map((_, el) => clean($(el).text()))
      .get()
      .filter(Boolean),
    email: clean(locSection.find(".email-p a").first().text()),
    map_embeded_link: locSection.find("iframe").first().attr("src") || "",
  };

  // ---- Services & Facilities ----
  // Three accordion panes. Titles vary slightly between hospitals
  // (howrah's reads "Diagnostic Services:"), so match by regex with a
  // positional fallback.
  const svcItems = $("#priSF .accordion-item");
  function svcPane(re, fallbackIndex) {
    const matched = svcItems.filter((_, el) => re.test($(el).find(".accordion-button").text()));
    return matched.length ? matched.first() : svcItems.eq(fallbackIndex);
  }

  function parseItemBoxes(pane, withSpeciality) {
    return pane
      .find(".item-box")
      .map((_, el) => {
        const $el = $(el);
        const entry = { name: clean($el.find("p").first().text()) };
        if (withSpeciality) entry.speciality = clean($el.find("span").first().text());
        entry.img = absUrl(url, $el.find("img").first().attr("src"));
        return entry;
      })
      .get();
  }

  const services_facilities = {
    diagnostic: parseItemBoxes(svcPane(/diagnostic/i, 0), true),
    special: parseItemBoxes(svcPane(/special/i, 1), true),
    ils_sparsh: parseItemBoxes(svcPane(/sparsh/i, 2), false),
  };

  // ---- Room and Charges ----
  // Raipur renders a hospital-specific block plus the shared carousel,
  // so de-duplicate the image list.
  const rcSection = $("#priRC");
  const room_charges = {
    images: [
      ...new Set(
        rcSection
          .find("img")
          .map((_, el) => absUrl(url, $(el).attr("src")))
          .get()
          .filter(Boolean)
      ),
    ],
    rooms: rcSection
      .find("ul.room-price-list-ul li")
      .map((_, el) => ({
        name: clean($(el).find("h6.type-h4").first().text()),
        type: clean($(el).find("h4.category-h6").first().text()),
      }))
      .get(),
  };

  // Raipur links an .xlsx here, several hospitals link nothing at all.
  const bio_medical = absUrl(url, $("#bioMedical a[href]").first().attr("href"));

  // ---- FAQs ----
  // Scoped to section.bg-faq — #priSF uses the same accordion markup.
  const faqSection = $("section.bg-faq");
  const faq_img = absUrl(url, faqSection.find("#services-add-carousel img").first().attr("src"));
  const faq = faqSection
    .find(".accordion-item")
    .map((_, el) => ({
      question: clean($(el).find(".accordion-button").first().text()),
      ans: clean($(el).find(".accordion-body").first().text()),
    }))
    .get();

  const seo = extractSEO($);

  return {
    name,
    slug,
    bannerImg,
    location_contact,
    overview,
    overview_img,
    number_of_beds,
    services_facilities,
    room_charges,
    bio_medical,
    faq_img,
    faq,
    logo_for_hospital,
    google_review,
    seo,
  };
}

(async () => {
  const results = [];
  for (const url of HOSPITAL_URLS) {
    console.log("Scraping:", url);
    try {
      const data = await scrapeHospital(url);
      results.push(data);
    } catch (err) {
      console.error("Failed:", url, err.message);
    }
  }
  fs.writeFileSync("ils_hospitals.json", JSON.stringify(results, null, 2));
  console.log("Saved ils_hospitals.json with", results.length, "hospitals");
})();
