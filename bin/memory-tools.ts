#!/usr/bin/env bun
// memory-tools.ts — dedup hash + hotness tracking for persona memory files.
//
// Subcommands:
//   hash <file>          print content_hash for a single file (sha1[:8] of normalized body)
//   check <file>         exit 1 + print path if another memory has same content_hash
//   backfill             add content_hash + last_referenced to every memory file missing them
//   touch <file>         set last_referenced to today (no-op if already today)
//   archive-stale [--dry-run]
//                        move project/reference memories with last_referenced > 90 days old
//                        into memory/archive/, remove their lines from MEMORY.md
//
// Why: dedup prevents writing the same fact twice across conversations; hotness
// lets us age out stale project/reference notes so MEMORY.md doesn't grow forever.
// `user` / `feedback` never archive — behavior rules can't drift.

import { readFileSync, writeFileSync, readdirSync, renameSync, mkdirSync, existsSync, statSync } from "fs";
import { createHash } from "crypto";
import { join, basename } from "path";

const VAULT = process.env.VAULT_PATH;
if (!VAULT) { console.error("VAULT_PATH not set — add it to .env"); process.exit(1); }
const MEMORY_DIR = join(VAULT!, "persona", "memory");
const ARCHIVE_DIR = join(MEMORY_DIR, "archive");
const INDEX = join(VAULT!, "persona", "MEMORY.md");
const TODAY = new Date().toISOString().slice(0, 10);

type Frontmatter = Record<string, string>;

function parseFrontmatter(content: string): { fm: Frontmatter; body: string; order: string[] } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: content, order: [] };
  const fm: Frontmatter = {};
  const order: string[] = [];
  for (const line of m[1].split("\n")) {
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    const k = line.slice(0, sep).trim();
    fm[k] = line.slice(sep + 1).trim();
    order.push(k);
  }
  return { fm, body: m[2], order };
}

function serializeFile(fm: Frontmatter, order: string[], body: string): string {
  // Preserve original key order, append any new keys at the end.
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const k of order) {
    if (k in fm) { lines.push(`${k}: ${fm[k]}`); seen.add(k); }
  }
  for (const k of Object.keys(fm)) {
    if (!seen.has(k)) lines.push(`${k}: ${fm[k]}`);
  }
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

function normalize(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

function hashBody(body: string): string {
  return createHash("sha1").update(normalize(body)).digest("hex").slice(0, 8);
}

function listMemoryFiles(): string[] {
  if (!existsSync(MEMORY_DIR)) return [];
  return readdirSync(MEMORY_DIR)
    .filter(f => f.endsWith(".md") && !f.startsWith("."))
    .map(f => join(MEMORY_DIR, f))
    .filter(p => statSync(p).isFile());
}

function daysAgo(iso: string): number {
  const then = new Date(iso + "T00:00:00Z").getTime();
  const now = new Date(TODAY + "T00:00:00Z").getTime();
  return Math.floor((now - then) / 86400000);
}

// ─── Commands ──────────────────────────────────────────────────────────────

function cmdHash(filePath: string) {
  const content = readFileSync(filePath, "utf-8");
  const { body } = parseFrontmatter(content);
  console.log(hashBody(body));
}

function cmdCheck(filePath: string) {
  const content = readFileSync(filePath, "utf-8");
  const { body } = parseFrontmatter(content);
  const target = hashBody(body);
  const absTarget = filePath.startsWith("/") ? filePath : join(process.cwd(), filePath);

  for (const other of listMemoryFiles()) {
    if (other === absTarget) continue;
    const oc = readFileSync(other, "utf-8");
    const { fm: ofm, body: obody } = parseFrontmatter(oc);
    const oh = ofm.content_hash || hashBody(obody);
    if (oh === target) {
      console.log(`DUP: ${other}`);
      process.exit(1);
    }
  }
  console.log("OK");
}

function cmdBackfill() {
  let updated = 0;
  for (const file of listMemoryFiles()) {
    const content = readFileSync(file, "utf-8");
    const { fm, body, order } = parseFrontmatter(content);
    let changed = false;
    if (!fm.content_hash) { fm.content_hash = hashBody(body); changed = true; }
    if (!fm.last_referenced) { fm.last_referenced = TODAY; changed = true; }
    if (changed) {
      writeFileSync(file, serializeFile(fm, order, body));
      updated++;
      console.log(`updated: ${basename(file)}`);
    }
  }
  console.log(`\n${updated} files updated`);
}

function cmdTouch(filePath: string) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf-8");
  const { fm, body, order } = parseFrontmatter(content);
  if (fm.last_referenced === TODAY) return;
  fm.last_referenced = TODAY;
  writeFileSync(filePath, serializeFile(fm, order, body));
}

function cmdArchiveStale(dryRun: boolean) {
  if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });

  const candidates: { file: string; lastRef: string; age: number }[] = [];
  for (const file of listMemoryFiles()) {
    const content = readFileSync(file, "utf-8");
    const { fm } = parseFrontmatter(content);
    if (!fm.last_referenced || !fm.type) continue;
    if (fm.type === "user" || fm.type === "feedback") continue;
    const age = daysAgo(fm.last_referenced);
    if (age > 90) candidates.push({ file, lastRef: fm.last_referenced, age });
  }

  if (candidates.length === 0) {
    console.log("nothing to archive");
    return;
  }

  let indexContent = readFileSync(INDEX, "utf-8");
  for (const { file, lastRef, age } of candidates) {
    const name = basename(file);
    if (dryRun) {
      console.log(`[dry] ${name}  last_ref=${lastRef}  age=${age}d`);
    } else {
      renameSync(file, join(ARCHIVE_DIR, name));
      // Remove any line in MEMORY.md that references this filename
      indexContent = indexContent
        .split("\n")
        .filter(line => !line.includes(`memory/${name}`))
        .join("\n");
      console.log(`archived: ${name} (last_ref=${lastRef}, age=${age}d)`);
    }
  }

  if (!dryRun) {
    writeFileSync(INDEX, indexContent);
    console.log(`MEMORY.md updated (-${candidates.length} entries)`);
  }
  console.log(`${candidates.length} ${dryRun ? "would-archive" : "archived"}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────

const cmd = process.argv[2];
const arg = process.argv[3];
const dryRun = process.argv.includes("--dry-run");

switch (cmd) {
  case "hash":
    if (!arg) die("usage: memory-tools.ts hash <file>");
    cmdHash(arg); break;
  case "check":
    if (!arg) die("usage: memory-tools.ts check <file>");
    cmdCheck(arg); break;
  case "backfill":
    cmdBackfill(); break;
  case "touch":
    if (!arg) die("usage: memory-tools.ts touch <file>");
    cmdTouch(arg); break;
  case "archive-stale":
    cmdArchiveStale(dryRun); break;
  default:
    die("commands: hash | check | backfill | touch | archive-stale [--dry-run]");
}

function die(msg: string): never { console.error(msg); process.exit(1); }
