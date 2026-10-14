#!/usr/bin/env bun
/**
 * probe-glyph-forms.ts — **字形層的位置形**（＝師父說的「異形部件」）。
 *
 * 師父第 111 輪的指點：
 * > 「Unicode 有『釒』『金』（還有『钅』），但『木』作偏旁雖沒有獨立的碼位
 * >  （Unicode 委員們覺得捺筆轉點，不足以差成『字符』級的差異，Unicode 的原則是
 * >  只為抽象的 Char 編碼，而不對具象的 Glyph 編碼……虛虛實實，不容易分得清的。）」
 *
 * 所以「位置形」有**兩層**：
 *   · **碼位層（Char）**：`釒`／`刂`／`扌`／`氵`… 有自己的碼位 → `form-groups.ts` 的形式群 ✓
 *   · **字形層（Glyph）**：`木` 的左偏旁形（捺轉點）**沒有**碼位，是 GlyphWiki 的**同碼 var** ✓
 * 這一支量第二層：同一個碼位的**家族成員**各自被用在哪些區位、多少次。
 *
 * 用法: bun run tools/probe-glyph-forms.ts [字…]（預設量常見部件）
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as F from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { refSlotsOf, slotPosOf } from "./free-compose.ts";

const ROOT = resolve(import.meta.dir, "..");
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });

/* ---- 用法統計：**用字形索引當鍵**（同碼 var 共用碼位，用碼位當鍵會混在一起 ✗） ---- */
const usage = new Map<number, Map<string, number>>();     /* ref 索引 → 區位 → 次數 */
for (let gi = 0; gi < lib.glyphs.length; gi++) {
  const g = lib.glyphs[gi];
  if (!g) continue;
  const slots = refSlotsOf(lib, gi);
  if (slots.length < 2) continue;
  const boxes = slots.map((s: any) => s.box);
  for (const s of slots) {
    const zone = slotPosOf(s.box, boxes);
    const m = usage.get(s.ref) ?? new Map<string, number>();
    m.set(zone, (m.get(zone) ?? 0) + 1);
    usage.set(s.ref, m);
  }
}
const total = (ix: number) => { const m = usage.get(ix); if (!m) return 0; let n = 0; for (const v of m.values()) n += v; return n; };
const zones = (ix: number) => {
  const m = usage.get(ix);
  if (!m) return "（未被引用）";
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([z, n]) => `${z}×${n.toLocaleString()}`).join("　");
};

const args = process.argv.slice(2);
const chars = args.length ? args : ["木", "禾", "火", "水", "王", "月", "日", "人", "手", "心", "口", "山", "石", "田", "白", "立", "示", "衣", "犬", "糸", "金", "言", "食", "辵", "刀"];

for (const ch of chars) {
  const cp = ch.codePointAt(0)!;
  const gi0 = F.indexOfCodePoint(lib, cp);
  if (gi0 === undefined) { console.log(`${ch}：（不在庫中）`); continue; }
  const fam = F.familyMembers(lib, cp);
  console.log(`\n${ch} U+${cp.toString(16).toUpperCase()}　家族 ${fam.length} 個字形：`);
  const rows = fam.map((ix) => ({ ix, name: F.displayName(lib, ix), n: total(ix) })).sort((a, b) => b.n - a.n);
  for (const r of rows) {
    const rep = ix2cp(r.ix);
    console.log(`   ${r.name.padEnd(16)} 用量 ${String(r.n).padStart(6)}　${zones(r.ix)}`);
  }

  function ix2cp(ix: number) {
    const c = F.codePointOf(lib, ix);
    return c ? String.fromCodePoint(c) : "（無碼位）";
  }
}
