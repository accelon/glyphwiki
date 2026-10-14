#!/usr/bin/env bun
/**
 * probe-grail-tree.ts — 直接從 DB 印出 holy grail 相關字的引用樹與框。
 *
 * 為什麼不等字庫：字庫只是 DB 的投影。先看 DB 才知道「換哪個節點、框多大」，
 * 也才判斷得出「用真字」和「借模板」差在哪裡。
 *
 * 用法: bun run tools/probe-grail-tree.ts
 */
import { Database } from "bun:sqlite";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const db = new Database(resolve(ROOT, "db/glyphwiki.db"), { readonly: true });

const getName = db.query("SELECT data, name_type, codepoint FROM glyphs WHERE name = ?");
const kids = db.query("SELECT idx, comp, kind FROM parts WHERE glyph = ? ORDER BY idx");

const cp = (c: string) => "U+" + c.codePointAt(0)!.toString(16).toUpperCase();

/** 把 `99:0:0:x1:y1:x2:y2:refname:sx:sy:sx2:sy2` 解析出來 */
function strokesOf(name: string): { kind: number; box: number[] | null; ref: string | null }[] {
  const row = getName.get(name) as any;
  if (!row) return [];
  const out: { kind: number; box: number[] | null; ref: string | null }[] = [];
  for (const part of (row.data as string).split("$")) {
    if (!part) continue;
    const c = part.split(":");
    const kind = parseInt(c[0]!, 10);
    if (!Number.isFinite(kind)) continue;
    if (kind === 99) {
      out.push({
        kind, ref: c[7] ?? null,
        box: [3, 4, 5, 6].map((i) => parseInt(c[i] ?? "0", 10) || 0),
      });
    } else out.push({ kind, box: null, ref: null });
  }
  return out;
}

/** 這個名字的最佳代表（優先 -j，其次最短） */
function variants(base: string): string[] {
  return (db.query("SELECT name FROM glyphs WHERE name = ? OR name LIKE ? ORDER BY length(name)")
    .all(base, base + "-%") as any[]).map((r) => r.name as string);
}

function printTree(name: string, depth = 0, seen = new Set<string>()): void {
  const pad = "  ".repeat(depth);
  if (seen.has(name)) { console.log(`${pad}${name} (循環)`); return; }
  seen.add(name);
  const row = getName.get(name) as any;
  if (!row) { console.log(`${pad}${name}  ✗ 不在 DB`); return; }
  const st = strokesOf(name);
  const refs = st.filter((s) => s.kind === 99);
  console.log(`${pad}${name}  節點 ${st.length}${refs.length ? `  引用 ${refs.length}` : "（純筆畫）"}`);
  if (depth >= 4) return;
  for (const s of refs) {
    console.log(`${pad}  框[${s.box!.join(",")}] ↓`);
    printTree(s.ref!, depth + 2, new Set(seen));
  }
}

const SEQ = "邏羅寶貝𩀨從䞃致招";
console.log(`=== 序列 ${SEQ}（${Array.from(SEQ).length} 字）===\n`);
for (const c of SEQ) {
  const base = "u" + c.codePointAt(0)!.toString(16);
  const vs = variants(base);
  console.log(`${c}  ${cp(c)}  ${vs.length ? vs.join(", ") : "✗ 不在 DB"}`);
}

console.log("\n=== 關鍵字的引用樹（取 -j 優先）===\n");
for (const c of ["邏", "羅", "寶", "貝", "𩀨", "從", "䞃", "致", "招", "隹", "走"]) {
  const base = "u" + c.codePointAt(0)!.toString(16);
  const vs = variants(base);
  const pick = vs.find((n) => n === base + "-j") ?? vs[0];
  console.log(`-- ${c}  ${cp(c)}  → ${pick ?? "（缺）"}`);
  if (pick) printTree(pick, 1);
  console.log("");
}

db.close();
