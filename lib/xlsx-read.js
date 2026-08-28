/**
 * Minimal .xlsx reader — enough to pull a column of strings out of a
 * single-sheet workbook, with no dependencies.
 *
 * An .xlsx is a zip of XML parts. Node ships the two pieces needed to open one
 * (`zlib` for the DEFLATE entries, and enough string handling for the XML), so
 * this avoids adding `xlsx`/`exceljs` to a package whose only job is scraping.
 *
 * Deliberately narrow: it reads the *first* worksheet, resolves shared strings
 * and inline strings, and ignores styles, formulas, dates and multi-sheet
 * workbooks. `ILS Hospitals Sitemap URLS.xlsx` is a one-column URL list, which
 * is all this needs to handle. Anything richer should pull in a real library.
 */
const fs = require("fs");
const zlib = require("zlib");

const SIG_EOCD = 0x06054b50; // end of central directory
const SIG_CEN = 0x02014b50; // central directory file header

/**
 * Reads the zip central directory rather than scanning for local file headers:
 * local headers may carry a zeroed compressed size (with the real one in a
 * trailing data descriptor), while the central directory is always accurate.
 */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0)
    throw new Error("not a zip file: no end-of-central-directory record");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== SIG_CEN)
      throw new Error(`corrupt central directory at ${p}`);

    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf-8", p + 46, p + 46 + nameLen);

    // The local header's own name/extra lengths decide where the data starts —
    // its extra field is often a different length from the central one.
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + compressedSize);

    if (method === 0) entries.set(name, raw);
    else if (method === 8) entries.set(name, zlib.inflateRawSync(raw));
    else
      throw new Error(`unsupported compression method ${method} for ${name}`);

    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

const XML_ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeXml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]);
}

/** Concatenates every <t> in a fragment — a shared string can be split across runs. */
function textRuns(fragment) {
  const out = [];
  for (const m of fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g))
    out.push(decodeXml(m[1]));
  return out.join("");
}

function sharedStrings(entries) {
  const xml = entries.get("xl/sharedStrings.xml");
  if (!xml) return [];
  return [...xml.toString("utf-8").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    textRuns(m[1]),
  );
}

/** `xl/worksheets/sheet1.xml` unless the workbook names something else first. */
function firstSheet(entries) {
  for (const name of ["xl/worksheets/sheet1.xml", ...entries.keys()]) {
    if (
      name.startsWith("xl/worksheets/") &&
      name.endsWith(".xml") &&
      entries.has(name)
    ) {
      return entries.get(name).toString("utf-8");
    }
  }
  throw new Error("no worksheet found in workbook");
}

/**
 * Every non-empty value in one column, in row order, header row included.
 * `column` is the spreadsheet letter ("A"), matched against each cell's `r`
 * reference so blank rows cannot shift the alignment.
 */
function readColumn(file, column = "A") {
  const entries = unzip(fs.readFileSync(file));
  const shared = sharedStrings(entries);
  const sheet = firstSheet(entries);
  const values = [];

  // The attribute match must be lazy: a greedy `[^>]*` swallows the `/` of a
  // self-closing `<c r="Y1" s="2"/>`, which then makes the `</c>` branch run on
  // and eat the next row's real cell — silently dropping one value per blank run.
  for (const cell of sheet.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = cell[1];
    const body = cell[2] || "";

    const ref = /\br="([A-Z]+)\d+"/.exec(attrs);
    if (!ref || ref[1] !== column) continue;

    const type = /\bt="([^"]+)"/.exec(attrs);
    const v = /<v>([\s\S]*?)<\/v>/.exec(body);

    let value;
    if (type && type[1] === "s") value = v ? shared[Number(v[1])] : "";
    else if (type && type[1] === "inlineStr") value = textRuns(body);
    else value = v ? decodeXml(v[1]) : "";

    value = (value || "").trim();
    if (value) values.push(value);
  }

  return values;
}

module.exports = { readColumn, unzip };
