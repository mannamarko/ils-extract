/**
 * Compares the SEO surface of a live page against the same page on the local
 * frontend, and classifies every field rather than just diffing strings.
 *
 * A raw string diff is useless on this pair. The live WordPress site emits each
 * `og:*` tag twice (once from the theme, once from AIOSEO) with different
 * values, stamps IST timestamps with a `+00:00` offset, and carries fields the
 * Next.js rewrite deliberately corrected. So values are normalized by kind,
 * matched against *every* occurrence on the live side, and known divergences
 * are reported as OK rather than as failures — leaving the report's failures to
 * mean "regression worth acting on".
 */
const { graphNodes } = require("../scrape-lib");

const VERDICT = {
  MATCH: "MATCH",
  /** Differs from live's resolved value, but equals another occurrence of it. */
  MATCH_ALT: "MATCH_ALT",
  DIFFERS: "DIFFERS",
  MISSING_LOCAL: "MISSING_LOCAL",
  MISSING_LIVE: "MISSING_LIVE",
  ABSENT: "ABSENT",
  INTENTIONAL: "OK (INTENTIONAL)",
};

/** IST is +05:30; live stamps local times with a `+00:00` offset. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const LOGO_RE = /\/wp-content\/uploads\/2023\/10\/logo\.png$/i;

const HTML_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#039": "'",
  "#39": "'",
};

function decodeEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(
      /&([a-z]+|#0?39);/gi,
      (m, name) => HTML_ENTITIES[name.toLowerCase()] ?? m,
    );
}

const normText = (v) => decodeEntities(v).replace(/\s+/g, " ").trim();

/** Trailing slash, `www.` and protocol are not meaningful differences here. */
function normUrl(v) {
  const text = normText(v);
  if (!text) return "";
  try {
    const u = new URL(text);
    const path = u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
    return `${u.host.replace(/^www\./, "")}${path}${u.search}`.toLowerCase();
  } catch {
    return text.toLowerCase();
  }
}

const normDate = (v) => {
  const t = Date.parse(normText(v));
  return Number.isNaN(t) ? normText(v) : String(t);
};

/** Comma-separated keyword lists compare as sets, not as ordered strings. */
const normList = (v) =>
  normText(v)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(",");

const NORMALIZERS = {
  text: normText,
  url: normUrl,
  date: normDate,
  list: normList,
};

/**
 * The compared fields. `get` reads the resolved value out of `extractSeo()`'s
 * output; `meta` names the tag so a mismatch can be re-checked against every
 * occurrence in `meta_all`.
 *
 * WordPress-only noise — `generator`, `msvalidate.01`, `google-site-verification`
 * — and Next-only noise — `next-size-adjust` — are absent by design: they are
 * not SEO parity, and reporting them would bury the real diffs.
 */
const FIELDS = [
  { key: "title", label: "title", kind: "text", get: (s) => s.meta_title },
  {
    key: "description",
    label: "description",
    kind: "text",
    meta: "description",
    get: (s) => s.meta_description,
  },
  {
    key: "canonical",
    label: "canonical",
    kind: "url",
    get: (s) => s.canonical,
  },
  {
    key: "robots",
    label: "robots",
    kind: "text",
    meta: "robots",
    get: (s) => s.robots,
  },
  {
    key: "keywords",
    label: "keywords",
    kind: "list",
    meta: "keywords",
    get: (s) => s._keywords,
  },
  {
    key: "og_title",
    label: "og:title",
    kind: "text",
    meta: "og:title",
    get: (s) => s.og.title,
  },
  {
    key: "og_description",
    label: "og:description",
    kind: "text",
    meta: "og:description",
    get: (s) => s.og.description,
  },
  {
    key: "og_type",
    label: "og:type",
    kind: "text",
    meta: "og:type",
    get: (s) => s.og.type,
  },
  {
    key: "og_url",
    label: "og:url",
    kind: "url",
    meta: "og:url",
    get: (s) => s.og.url,
  },
  {
    key: "og_image",
    label: "og:image",
    kind: "url",
    meta: "og:image",
    get: (s) => s.og.image,
  },
  {
    key: "og_site_name",
    label: "og:site_name",
    kind: "text",
    meta: "og:site_name",
    get: (s) => s.og.site_name,
  },
  {
    key: "og_locale",
    label: "og:locale",
    kind: "text",
    meta: "og:locale",
    get: (s) => s.og.locale,
  },
  {
    key: "twitter_card",
    label: "twitter:card",
    kind: "text",
    meta: "twitter:card",
    get: (s) => s.twitter.card,
  },
  {
    key: "twitter_title",
    label: "twitter:title",
    kind: "text",
    meta: "twitter:title",
    get: (s) => s.twitter.title,
  },
  {
    key: "twitter_description",
    label: "twitter:description",
    kind: "text",
    meta: "twitter:description",
    get: (s) => s.twitter.description,
  },
  {
    key: "twitter_image",
    label: "twitter:image",
    kind: "url",
    meta: "twitter:image",
    get: (s) => s.twitter.image,
  },
  {
    key: "twitter_url",
    label: "twitter:url",
    kind: "url",
    meta: "twitter:url",
    get: (s) => s.twitter.url,
  },
  {
    key: "article_published_time",
    label: "article:published_time",
    kind: "date",
    meta: "article:published_time",
    get: (s) => s._published,
  },
  {
    key: "article_modified_time",
    label: "article:modified_time",
    kind: "date",
    meta: "article:modified_time",
    get: (s) => s._modified,
  },
];

/**
 * Divergences that are correct-by-design, checked only once a field has already
 * failed a straight comparison. Each returns a reason string (reported in the
 * CSV's `notes`) or null to let the DIFFERS verdict stand.
 *
 * Keep this list short and evidenced — every entry here is a real difference
 * being waved through, so anything speculative belongs in the report instead.
 */
const INTENTIONAL = {
  og_site_name: (live, local) =>
    live && local && live.startsWith(local)
      ? "live crams the site tagline into og:site_name; local uses the clean SITE_NAME"
      : null,

  // The pre-launch block emits `noindex, nofollow` *before* the per-page
  // `index, follow`, so the resolved last-wins value hides it — check every
  // occurrence instead.
  robots: (live, local, ctx) =>
    ctx.localAll.some((v) => /noindex/i.test(v))
      ? "local is noindex/nofollow pre-launch (app/layout.jsx + robots.js)"
      : null,

  twitter_url: (live, local) =>
    /metatags\.io/i.test(live || "") && !local
      ? "live twitter:url is a leftover metatags.io placeholder; local omits it"
      : null,

  og_image: (live, local) =>
    LOGO_RE.test(live || "") && local && !LOGO_RE.test(local)
      ? "live falls back to the site logo; local serves the entity's own image"
      : null,

  twitter_image: (live, local) =>
    LOGO_RE.test(live || "") && local && !LOGO_RE.test(local)
      ? "live falls back to the site logo; local serves the entity's own image"
      : null,

  article_published_time: offsetSkew,
  article_modified_time: offsetSkew,
};

/** Same wall-clock instant, mislabelled: live writes IST times as `+00:00`. */
function offsetSkew(live, local) {
  const a = Date.parse(live);
  const b = Date.parse(local);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.abs(a - b) === IST_OFFSET_MS
    ? "same instant; live stamps an IST time with a +00:00 offset"
    : null;
}

/** Every value the page carries for a tag, in document order. */
function occurrences(seo, metaKey) {
  if (!metaKey || !Array.isArray(seo.meta_all)) return [];
  return seo.meta_all
    .filter((m) => m.key && m.key.toLowerCase() === metaKey && m.content)
    .map((m) => m.content);
}

/** `extractSeo` does not surface these three; resolve them the same way it does. */
function withExtras(seo) {
  const resolve = (key) => {
    const all = occurrences(seo, key);
    return all.length ? all[all.length - 1] : null;
  };
  return {
    ...seo,
    _keywords: resolve("keywords"),
    _published: resolve("article:published_time"),
    _modified: resolve("article:modified_time"),
  };
}

function compareField(field, liveSeo, localSeo) {
  const norm = NORMALIZERS[field.kind];
  const liveRaw = field.get(liveSeo) || "";
  const localRaw = field.get(localSeo) || "";

  const row = {
    key: field.key,
    label: field.label,
    live: liveRaw,
    local: localRaw,
    note: "",
  };

  if (!liveRaw && !localRaw) return { ...row, verdict: VERDICT.ABSENT };

  const alternates = occurrences(liveSeo, field.meta);

  // Checked before the missing-value cases, not just on a value mismatch:
  // deliberately *dropping* a tag (local emits no twitter:url because live's is
  // a placeholder) is as intentional as changing one.
  const reason = INTENTIONAL[field.key]?.(liveRaw, localRaw, {
    liveAll: alternates,
    localAll: occurrences(localSeo, field.meta),
  });
  if (reason) return { ...row, verdict: VERDICT.INTENTIONAL, note: reason };

  if (!localRaw) return { ...row, verdict: VERDICT.MISSING_LOCAL };
  if (!liveRaw) return { ...row, verdict: VERDICT.MISSING_LIVE };

  if (norm(liveRaw) === norm(localRaw))
    return { ...row, verdict: VERDICT.MATCH };

  // Live emits several `og:*` tags twice with different values; matching any of
  // them is parity, not a regression.
  if (alternates.some((alt) => norm(alt) === norm(localRaw))) {
    return {
      ...row,
      verdict: VERDICT.MATCH_ALT,
      note: "matches a second occurrence on live",
    };
  }

  return { ...row, verdict: VERDICT.DIFFERS };
}

/**
 * A field counts as clean unless it actively failed. MISSING_LIVE is clean by
 * design: it means local publishes a tag live does not (job pages have no
 * description upstream), which is an improvement and can never be a regression.
 * MISSING_LOCAL — the reverse — stays a failure.
 */
const CLEAN = new Set([
  VERDICT.MATCH,
  VERDICT.MATCH_ALT,
  VERDICT.INTENTIONAL,
  VERDICT.ABSENT,
  VERDICT.MISSING_LIVE,
]);

function compareMeta(liveSeo, localSeo) {
  const live = withExtras(liveSeo);
  const local = withExtras(localSeo);
  const fields = FIELDS.map((f) => compareField(f, live, local));

  const compared = fields.filter((f) => f.verdict !== VERDICT.ABSENT);
  const clean = compared.filter((f) => CLEAN.has(f.verdict));

  return {
    fields,
    matched: clean.length,
    total: compared.length,
    verdict: clean.length === compared.length ? "CLEAN" : "MISMATCH",
    notes: fields.filter((f) => f.note).map((f) => `${f.label}: ${f.note}`),
  };
}

/**
 * The Next.js rewrite narrows several schema.org types to more specific
 * subtypes. Those are upgrades, not losses, so a live type is satisfied by any
 * of its accepted local equivalents.
 */
const TYPE_EQUIVALENTS = {
  Organization: ["Organization", "MedicalOrganization"],
  WebPage: [
    "WebPage",
    "MedicalWebPage",
    "CollectionPage",
    "FAQPage",
    "ProfilePage",
    "ItemPage",
  ],
  MedicalOrganization: ["MedicalOrganization", "Organization"],
};

const typeOf = (node) =>
  Array.isArray(node["@type"]) ? node["@type"][0] : node["@type"];

function typesOf(html, extractJsonLd, load) {
  const $ = load(html);
  const blocks = extractJsonLd($);
  const nodes = graphNodes(blocks);
  return { blocks, nodes, types: nodes.map(typeOf).filter(Boolean) };
}

/**
 * Compares the `@type` *set*, then the headline fields of shared nodes.
 *
 * Set, not multiset, because live double-publishes entities: the SEO landing
 * pages carry both an AIOSEO `Organization` and a theme `MedicalOrganization`
 * for the same hospital group, which the rewrite consolidates into one node.
 * Counting the duplicate as a loss reported healthy pages as SCHEMA_MISSING.
 * A type genuinely absent locally — `Physician` on those same pages — is still
 * caught, since nothing satisfies it at all.
 */
function compareSchema(liveSide, localSide) {
  const localTypes = new Set(localSide.types);
  const satisfied = (wanted) =>
    (TYPE_EQUIVALENTS[wanted] || [wanted]).some((t) => localTypes.has(t));

  const missing = [...new Set(liveSide.types)].filter(
    (wanted) => !satisfied(wanted),
  );

  const liveTypes = new Set(liveSide.types);
  const extra = [...localTypes].filter(
    (t) =>
      ![...liveTypes].some((w) => (TYPE_EQUIVALENTS[w] || [w]).includes(t)),
  );

  const mismatched = [];
  for (const liveNode of liveSide.nodes) {
    const accepted = TYPE_EQUIVALENTS[typeOf(liveNode)] || [typeOf(liveNode)];
    const localNode = localSide.nodes.find((n) => accepted.includes(typeOf(n)));
    if (!localNode) continue;

    for (const prop of ["name", "headline", "description", "url"]) {
      const a = liveNode[prop];
      const b = localNode[prop];
      if (typeof a !== "string" || typeof b !== "string") continue;
      const norm = prop === "url" ? normUrl : normText;
      if (norm(a) !== norm(b)) mismatched.push(`${typeOf(liveNode)}.${prop}`);
    }
  }

  const parseOk =
    localSide.blocks.length > 0 &&
    !localSide.blocks.some((b) => b._parse_error);

  return {
    liveTypes: liveSide.types,
    localTypes: localSide.types,
    missing,
    extra,
    mismatched,
    blocksLive: liveSide.blocks.length,
    blocksLocal: localSide.blocks.length,
    parseOk,
    verdict:
      missing.length === 0 && parseOk
        ? mismatched.length
          ? "FIELDS_DIFFER"
          : "MATCH"
        : "MISSING",
  };
}

module.exports = {
  VERDICT,
  FIELDS,
  INTENTIONAL,
  compareMeta,
  compareSchema,
  typesOf,
  normText,
  normUrl,
};
