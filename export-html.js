#!/usr/bin/env node
/**
 * Render the scraped posts back to standalone HTML files so the extracted
 * `content` can be eyeballed against the live blog post.
 *
 * Writes export/<slug>.html plus export/index.html. Each file is the post's
 * exact `content` HTML with a minimal wrapper — no site CSS, so it will not
 * look like ilshospitals.com, but the markup, text, links and images are the
 * same nodes the live page renders.
 *
 * Usage:
 *   node export-html.js                       # all posts
 *   node export-html.js --limit 20            # first 20
 *   node export-html.js --slug some-post-slug # one post
 *   node export-html.js --in ils_blogs_v2.json --out export
 */

const fs = require("fs");
const path = require("path");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { in: "ils_blogs_v2.json", out: "export", limit: null, slug: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--in") opts.in = args[++i];
    else if (args[i] === "--out") opts.out = args[++i];
    else if (args[i] === "--limit") opts.limit = parseInt(args[++i], 10);
    else if (args[i] === "--slug") opts.slug = args[++i];
  }
  return opts;
}

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const PAGE_CSS = `
  body { max-width: 46rem; margin: 2rem auto; padding: 0 1rem;
         font: 16px/1.65 Georgia, "Times New Roman", serif; color: #222; }
  header { border-bottom: 1px solid #ddd; padding-bottom: 1rem; margin-bottom: 1.5rem; }
  h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 .5rem; }
  .meta { font: 13px/1.5 system-ui, sans-serif; color: #666; }
  .meta a { color: #666; }
  img { max-width: 100%; height: auto; }
  .banner { margin-bottom: 1.5rem; }
  a { color: #06c; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e6e6e6; }
    header { border-color: #333; }
    .meta, .meta a { color: #999; }
    a { color: #6cf; }
  }
`;

// Departments (ils_departments.json) name the same things differently, so
// both shapes render through this one path.
const titleOf = (p) => p.title ?? p.name;
const srcOf = (p) => p.post_url ?? p.url;

function renderPost(p) {
  const cats = [p.category].filter((c) => c && c.name).map((c) => esc(c.name)).join(", ");
  const tags = (p.tags || []).map((t) => esc(t.name)).join(", ");
  const date = p.published_date ? String(p.published_date).slice(0, 10) : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titleOf(p))}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<header>
  <h1>${esc(titleOf(p))}</h1>
  <p class="meta">
    ${date}${cats ? " &middot; " + cats : ""}<br>
    <a href="${esc(srcOf(p))}">${esc(srcOf(p))}</a>
  </p>
</header>
${p.banner_image_url ? `<p class="banner"><img src="${esc(p.banner_image_url)}" alt=""></p>` : ""}
<article>
${p.content || p.content2 || p.content1 || "<p><em>No content extracted.</em></p>"}
</article>
${tags ? `<footer><p class="meta">Tags: ${tags}</p></footer>` : ""}
</body>
</html>`;
}

function renderIndex(posts) {
  const rows = posts
    .map(
      (p) =>
        `<li><a href="${esc(p.slug)}.html">${esc(titleOf(p))}</a> ` +
        `<span class="meta">${p.published_date ? String(p.published_date).slice(0, 10) : ""} &middot; ` +
        `${(p.content || "").length.toLocaleString()} chars</span></li>`
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ILS blog export (${posts.length} posts)</title>
<style>${PAGE_CSS}
  li { margin: .4rem 0; }
  .meta { font-size: 12px; }
</style>
</head>
<body>
<header><h1>ILS blog export</h1><p class="meta">${posts.length} posts</p></header>
<ol>
${rows}
</ol>
</body>
</html>`;
}

function main() {
  const opts = parseArgs();
  let posts = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), opts.in), "utf-8"));
  if (opts.slug) posts = posts.filter((p) => p.slug === opts.slug);
  if (opts.limit) posts = posts.slice(0, opts.limit);
  if (!posts.length) {
    console.error("[error] no posts matched.");
    process.exit(1);
  }

  const outDir = path.resolve(process.cwd(), opts.out);
  fs.mkdirSync(outDir, { recursive: true });
  for (const p of posts) {
    fs.writeFileSync(path.join(outDir, `${p.slug}.html`), renderPost(p), "utf-8");
  }
  fs.writeFileSync(path.join(outDir, "index.html"), renderIndex(posts), "utf-8");

  const empty = posts.filter((p) => !p.content).length;
  console.log(`[done] wrote ${posts.length} files -> ${outDir}`);
  if (empty) console.log(`[warn] ${empty} posts had no content`);
  console.log(`[open] ${path.join(outDir, "index.html")}`);
}

main();
