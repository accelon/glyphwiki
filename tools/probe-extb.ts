#!/usr/bin/env bun
/**
 * probe-extb.ts — 為「把 Ext B 包進字庫」做前置量測。
 *
 * 要回答的問題：
 *   1. db/glyphwiki.db 裡到底有多少個字是 Ext B（U+20000..U+2A6DF）？
 *   2. BMP + Ext A + Ext B 的可達閉包有多大（＝新字庫的大小量級）？
 *   3. holy grail 那 9 個字（特別是 U+29028 𩀨）在 DB 裡有沒有？
 *   4. 䞃（U+4783）的 IDS 是什麼？——決定序列最後一段怎麼讀。
 *
 * 用法: bun run tools/probe-extb.ts
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const db = new Database(resolve(ROOT, "db/glyphwiki.db"), { readonly: true });

// ---------------------------------------------------------------- 1. 碼位分佈

const RANGES: [string, number, number][] = [
  ["URO（基本區）", 0x4e00, 0x9fff],
  ["Ext A", 0x3400, 0x4dbf],
  ["相容區", 0xf900, 0xfaff],
  ["Ext B", 0x20000, 0x2a6df],
  ["Ext C", 0x2a700, 0x2b73f],
  ["Ext D", 0x2b740, 0x2b81f],
  ["Ext E", 0x2b820, 0x2ceaf],
  ["Ext F", 0x2ceb0, 0x2ebef],
  ["Ext G", 0x30000, 0x3134f],
];

console.log("=== 1. DB 裡的碼位字分佈 ===");
const cnt = db.query(
  "SELECT COUNT(*) AS c FROM glyphs WHERE name_type='codepoint' AND codepoint BETWEEN ? AND ?",
);
const maxCp = db.query(
  "SELECT MAX(codepoint) AS m FROM glyphs WHERE name_type='codepoint'",
).get() as any;
console.log(`  DB 最大碼位：U+${(maxCp.m as number).toString(16).toUpperCase()}`);
for (const [label, a, b] of RANGES) {
  const c = (cnt.get(a, b) as any).c as number;
  console.log(`  ${label.padEnd(14, " ")} U+${a.toString(16).toUpperCase()}..U+${b.toString(16).toUpperCase()}  ${String(c).padStart(7)} 字`);
}

// ---------------------------------------------------------------- 2. 閉包大小

console.log("\n=== 2. 可達閉包大小（BMP+ExtA+ExtB）===");
const lookupStmt = db.query("SELECT data FROM glyphs WHERE name = ?");
const getKids = db.query("SELECT comp FROM parts WHERE glyph = ? AND kind = 99");

function closureSize(minCp: number, maxCp: number): { root: number; total: number; dangling: number } {
  const roots = (db
    .query(
      "SELECT name FROM glyphs WHERE name_type='codepoint' AND codepoint BETWEEN ? AND ? ORDER BY codepoint",
    )
    .all(minCp, maxCp) as any[]).map((r) => r.name as string);
  const seen = new Set<string>();
  const stack = [...roots];
  let dangling = 0;
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    let r = lookupStmt.get(n) as any;
    if (!r) {
      const s = n.replace(/@[0-9]+$/, "");
      if (s !== n) r = lookupStmt.get(s) as any;
      if (!r) { dangling++; seen.add(n); continue; }
    }
    seen.add(n);
    for (const k of getKids.all(n) as any[]) stack.push(k.comp);
  }
  return { root: roots.length, total: seen.size - dangling, dangling };
}

for (const [label, a, b] of [
  ["現況 BMP（0x3400..0xFAFF）", 0x3400, 0xfaff],
  ["BMP + Ext B", 0x3400, 0xfaff],
] as [string, number, number][]) {
  if (label.startsWith("BMP + Ext B")) continue;
  const t0 = Date.now();
  const r = closureSize(a, b);
  console.log(`  ${label}：根 ${r.root.toLocaleString()}，閉包 ${r.total.toLocaleString()}，懸空 ${r.dangling.toLocaleString()}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
}

const t1 = Date.now();
// 根 = BMP 全部 + Ext B
const rootsAll = (db
  .query(
    "SELECT COUNT(*) AS c FROM glyphs WHERE name_type='codepoint' AND (codepoint BETWEEN 0x3400 AND 0xFAFF OR codepoint BETWEEN 0x20000 AND 0x2A6DF)",
  ).get() as any).c as number;
const seenAll = new Set<string>();
const stackAll: string[] = (db
  .query(
    "SELECT name FROM glyphs WHERE name_type='codepoint' AND (codepoint BETWEEN 0x3400 AND 0xFAFF OR codepoint BETWEEN 0x20000 AND 0x2A6DF) ORDER BY codepoint",
  )
  .all() as any[]).map((r) => r.name as string);
let danglingAll = 0;
while (stackAll.length) {
  const n = stackAll.pop()!;
  if (seenAll.has(n)) continue;
  let r = lookupStmt.get(n) as any;
  if (!r) {
    const s = n.replace(/@[0-9]+$/, "");
    if (s !== n) r = lookupStmt.get(s) as any;
    if (!r) { danglingAll++; seenAll.add(n); continue; }
  }
  seenAll.add(n);
  for (const k of getKids.all(n) as any[]) stackAll.push(k.comp);
}
console.log(`  BMP + Ext B：根 ${rootsAll.toLocaleString()}，閉包 ${(seenAll.size - danglingAll).toLocaleString()}，懸空 ${danglingAll.toLocaleString()}（${((Date.now() - t1) / 1000).toFixed(1)}s）`);

// ---------------------------------------------------------------- 3. holy grail 九字

console.log("\n=== 3. holy grail 九字在 DB 的情形 ===");
const GRAIL = "邏羅寶貝𩀨從䞃致招";
for (const ch of GRAIL) {
  const cp = ch.codePointAt(0)!;
  const name = "u" + cp.toString(16);
  const row = db.query(
    "SELECT name, name_type, codepoint FROM glyphs WHERE name = ? OR name LIKE ? ORDER BY length(name) LIMIT 3",
  ).all(name, name + "-%") as any[];
  console.log(
    `  ${ch}  U+${cp.toString(16).toUpperCase().padStart(5, "0")}  ` +
    (row.length ? row.map((r) => r.name).join(", ") : "✗ 不在 DB"),
  );
}

// ---------------------------------------------------------------- 4. IDS

console.log("\n=== 4. IDS（unicode-cjk-ids/All.txt）===");
const idsText = readFileSync(resolve(ROOT, "unicode-cjk-ids/All.txt"), "utf8");
const idsMap = new Map<number, string>();
for (const line of idsText.split("\n")) {
  const m = /^U\+([0-9A-Fa-f]+)\t/.exec(line);
  if (!m) continue;
  const parts = line.split("\t");
  idsMap.set(parseInt(m[1]!, 16), parts[2] ?? "");
}
for (const ch of GRAIL) {
  const cp = ch.codePointAt(0)!;
  console.log(`  ${ch}  U+${cp.toString(16).toUpperCase().padStart(5, "0")}  ${idsMap.get(cp) ?? "（無 IDS）"}`);
}

db.close();
