#!/usr/bin/env bun
// Generic Markdown -> PDF converter. No browser/pandoc needed (pure pdfkit).
// Usage: bun run bin/md-to-pdf.ts <input.md> [output.pdf]
//   - Strips YAML frontmatter.
//   - # H1 = document title, lines under it (before first ##) = contact/subheader.
//   - ## = section header with rule, ### = job/sub header.
//   - "### Title" followed by a line that is only *italic* -> dates shown right-aligned.
//   - "- " / "* " bullets, **bold** + *italic* inline. Blank line = paragraph break.
// pdfkit's built-in fonts are WinAnsi-encoded; chars outside Latin-1 (e.g. → ™ ✓)
// are auto-substituted to the nearest ASCII so you don't get missing glyphs.
// CJK / non-Latin scripts have NO such substitution and would be silently
// dropped, so this script refuses to mangle them: if the input contains CJK,
// set MD_PDF_CJK_FONT=/path/to/a.ttf to embed a Unicode font, otherwise it
// errors out and points you at bin/md-to-docx.ts (which handles Unicode).
import PDFDocument from "pdfkit";
import fs from "fs";

const inPath = process.argv[2];
if (!inPath) { console.error("usage: md-to-pdf <input.md> [output.pdf]"); process.exit(1); }
const outPath = process.argv[3] || inPath.replace(/\.md$/i, "") + ".pdf";

let src = fs.readFileSync(inPath, "utf8");
src = src.replace(/^﻿/, "").replace(/^---\n[\s\S]*?\n---\n/, ""); // strip frontmatter

// Best-effort transliteration for glyphs outside WinAnsi.
const SUBS: Record<string, string> = {
  "→": "-to-", "←": "<-", "↔": "<->", "⇒": "=>", "•": "•",
  "≥": ">=", "≤": "<=", "≠": "!=", "×": "x", "✓": "+", "✔": "+",
  "™": "(TM)", "®": "(R)", "…": "...", "−": "-",
};
const clean = (s: string) => s.replace(/[→←↔⇒≥≤≠×✓✔™®…−]/g, (c) => SUBS[c] ?? c);

const doc = new PDFDocument({ size: "LETTER", margins: { top: 48, bottom: 44, left: 54, right: 54 } });
doc.pipe(fs.createWriteStream(outPath));
const L = doc.page.margins.left;
const PAGE_W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
const INK = "#1a1a1a", SUB = "#555555";

// Font names used throughout. Default to pdfkit's built-in Helvetica family
// (WinAnsi, English-only). If the input has CJK/non-Latin text we either embed
// a user-supplied Unicode font (and render every weight with it — a single TTF
// has one weight, so bold/italic just reuse it rather than dropping glyphs) or
// fail loudly instead of silently mangling the output.
let FONT_REG = "Helvetica", FONT_BOLD = "Helvetica-Bold", FONT_OBL = "Helvetica-Oblique";
const NON_LATIN = /[Ā-ſ　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;
if (NON_LATIN.test(src)) {
  const cjkFont = process.env.MD_PDF_CJK_FONT;
  if (cjkFont && fs.existsSync(cjkFont)) {
    doc.registerFont("Body", cjkFont);
    FONT_REG = FONT_BOLD = FONT_OBL = "Body";
  } else {
    console.error(
      "md-to-pdf: input contains CJK/non-Latin characters that pdfkit's built-in " +
      "WinAnsi fonts cannot render (they would be silently dropped). " +
      "Set MD_PDF_CJK_FONT=/path/to/a/unicode.ttf to embed a font, " +
      "or use bin/md-to-docx.ts which handles Unicode natively.",
    );
    process.exit(1);
  }
}

// inline **bold** / *italic*
function rich(str: string, opts: any = {}) {
  const parts = clean(str).split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  parts.forEach((p, i) => {
    let font = FONT_REG, txt = p;
    if (p.startsWith("**") && p.endsWith("**")) { font = FONT_BOLD; txt = p.slice(2, -2); }
    else if (p.startsWith("*") && p.endsWith("*")) { font = FONT_OBL; txt = p.slice(1, -1); }
    doc.font(font).fillColor(opts.color || INK);
    doc.text(txt, { continued: i < parts.length - 1, ...opts });
  });
}
function sectionHeader(t: string) {
  doc.moveDown(0.4);
  doc.font(FONT_BOLD).fontSize(11.5).fillColor(INK).text(clean(t).toUpperCase(), { characterSpacing: 1 });
  const y = doc.y + 2;
  doc.moveTo(L, y).lineTo(doc.page.width - doc.page.margins.right, y).lineWidth(0.8).strokeColor("#bbbbbb").stroke();
  doc.moveDown(0.4);
}

const lines = src.split("\n");
let firstH1Done = false;
for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  const line = raw.trim();
  if (!line) { continue; }

  if (line.startsWith("# ")) {
    doc.font(FONT_BOLD).fontSize(22).fillColor(INK).text(clean(line.slice(2)));
    doc.moveDown(0.25);
    // contact/subheader lines until first ## or blank-then-##
    doc.font(FONT_REG).fontSize(9).fillColor(SUB);
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && !lines[j].startsWith("#")) {
      rich(lines[j].trim().replace(/\*\*/g, ""), { fontSize: 9, color: SUB });
      j++;
    }
    i = j - 1; firstH1Done = true; continue;
  }
  if (line.startsWith("## ")) { sectionHeader(line.slice(3)); continue; }
  if (line.startsWith("### ")) {
    const title = line.slice(4);
    const next = (lines[i + 1] || "").trim();
    const dateMatch = next.match(/^\*([^*]+)\*$/);
    const y = doc.y;
    doc.font(FONT_BOLD).fontSize(10.5).fillColor(INK).text(clean(title), L, y, { width: PAGE_W * 0.72 });
    const bottom = doc.y;
    if (dateMatch) {
      doc.font(FONT_OBL).fontSize(9).fillColor(SUB).text(clean(dateMatch[1]), L, y, { width: PAGE_W, align: "right" });
      i++; // consume date line
    }
    doc.y = Math.max(bottom, doc.y);
    doc.moveDown(0.15); continue;
  }
  if (/^[-*]\s+/.test(line)) {
    const txt = line.replace(/^[-*]\s+/, "");
    const indent = 12, startY = doc.y;
    doc.font(FONT_REG).fontSize(9.5).fillColor(INK).text("•", L, startY, { width: indent });
    doc.y = startY; doc.x = L + indent;
    rich(txt, { fontSize: 9.5, width: PAGE_W - indent, lineGap: 1 });
    doc.x = L; doc.moveDown(0.12); continue;
  }
  if (/^---+$/.test(line)) { doc.moveDown(0.3); continue; }
  // paragraph
  doc.x = L; rich(line, { fontSize: 9.5, width: PAGE_W, lineGap: 1 });
  doc.moveDown(0.12);
}

doc.end();
doc.on?.("end", () => {});
process.on("exit", () => {});
console.error("wrote " + outPath);
