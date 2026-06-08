#!/usr/bin/env bun
// Generic Markdown -> DOCX converter (pure JS, no Word/LibreOffice needed).
// Usage: bun run bin/md-to-docx.ts <input.md> [output.docx]
//   Same markdown subset as md-to-pdf.ts: frontmatter strip, # title +
//   contact lines, ## section, ### sub/job header with *dates*, - bullets,
//   **bold** / *italic* inline. Produces an editable .docx.
import { Document, Packer, Paragraph, TextRun, HeadingLevel, BorderStyle, AlignmentType, TabStopType, TabStopPosition } from "docx";
import fs from "fs";

const inPath = process.argv[2];
if (!inPath) { console.error("usage: md-to-docx <input.md> [output.docx]"); process.exit(1); }
const outPath = process.argv[3] || inPath.replace(/\.md$/i, "") + ".docx";

let src = fs.readFileSync(inPath, "utf8");
src = src.replace(/^﻿/, "").replace(/^---\n[\s\S]*?\n---\n/, "");

// inline **bold** / *italic* -> TextRun[]
function runs(str: string, base: any = {}): TextRun[] {
  return str.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean).map((p) => {
    if (p.startsWith("**") && p.endsWith("**")) return new TextRun({ text: p.slice(2, -2), bold: true, ...base });
    if (p.startsWith("*") && p.endsWith("*")) return new TextRun({ text: p.slice(1, -1), italics: true, ...base });
    return new TextRun({ text: p, ...base });
  });
}

const children: Paragraph[] = [];
const lines = src.split("\n");
for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;

  if (line.startsWith("# ")) {
    children.push(new Paragraph({ children: [new TextRun({ text: line.slice(2), bold: true, size: 40 })], spacing: { after: 60 } }));
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && !lines[j].startsWith("#")) {
      children.push(new Paragraph({ children: runs(lines[j].trim().replace(/\*\*/g, ""), { size: 18, color: "555555" }), spacing: { after: 20 } }));
      j++;
    }
    i = j - 1; continue;
  }
  if (line.startsWith("## ")) {
    children.push(new Paragraph({
      children: [new TextRun({ text: line.slice(3).toUpperCase(), bold: true, size: 23, characterSpacing: 20 })],
      spacing: { before: 200, after: 60 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "BBBBBB", space: 2 } },
    }));
    continue;
  }
  if (line.startsWith("### ")) {
    const title = line.slice(4);
    const dm = (lines[i + 1] || "").trim().match(/^\*([^*]+)\*$/);
    const kids = [new TextRun({ text: title, bold: true, size: 21 })];
    if (dm) { kids.push(new TextRun({ text: "\t" + dm[1], italics: true, size: 18, color: "555555" })); i++; }
    children.push(new Paragraph({
      children: kids, spacing: { before: 120, after: 30 },
      tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
    }));
    continue;
  }
  if (/^[-*]\s+/.test(line)) {
    children.push(new Paragraph({ children: runs(line.replace(/^[-*]\s+/, ""), { size: 19 }), bullet: { level: 0 }, spacing: { after: 20 } }));
    continue;
  }
  if (/^---+$/.test(line)) continue;
  children.push(new Paragraph({ children: runs(line, { size: 19 }), spacing: { after: 40 } }));
}

const doc = new Document({
  styles: { default: { document: { run: { font: "Calibri" } } } },
  sections: [{ properties: { page: { margin: { top: 720, bottom: 720, left: 900, right: 900 } } }, children }],
});
Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(outPath, buf); console.error("wrote " + outPath); });
