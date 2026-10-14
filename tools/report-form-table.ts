#!/usr/bin/env bun
/**
 * report-form-table.ts — 產出**形式表**並做關鍵檢查（第 111 輪）。
 *
 * 用法: bun run tools/report-form-table.ts
 * 產物: out/form-table.tsv
 *   部件, 部件碼位, 區位, 形式字形名, 形式碼位, 層（char／glyph）, 用量, 實測框
 *
 * 為什麼要這一張：它是 **A6（選對形式）** 與 **A7（建議更好的基字）** 共用的資料 ✓。
 * 「形式」有兩層（師父第 111 輪的指點）：
 *   · **char 層**：`釒`／`刂`／`扌` 有自己的碼位 ✓
 *   · **glyph 層**：`木` 的左偏旁形（捺轉點）**沒有**碼位，是 GlyphWiki 的同碼 var ✓
 * 兩層的「該用在哪個區位、框多大」都由**語料**回答 ✓（不猜 ✗）。
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as F from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { loadSyn, RADICAL_RANGES } from "./syn-graph.ts";
import { buildFormGroups, loadTotalStrokes } from "./form-groups.ts";
import { loadVariantPairs } from "./unihan-variants.ts";
import { buildFormTable, bestFormFor } from "./form-table.ts";
import { refSlotsOf, slotPosOf } from "./free-compose.ts";

const ROOT = resolve(import.meta.dir, "..");
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });

const RANGES: [number, number][] = [
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff],
  [0x20000, 0x2a6df], [0x2a700, 0x2b73f], [0x2b740, 0x2b81f], [0x2b820, 0x2ceaf],
  [0x2ceb0, 0x2ebef], [0x2ebf0, 0x2ee5f], [0x2f800, 0x2fa1f],
  [0x30000, 0x3134f], [0x31350, 0x323af],
];
const inLib = (cp: number) => RANGES.some(([a, b]) => cp >= a && cp <= b);
const strokes = loadTotalStrokes(resolve(ROOT, "unihan/Unihan_IRGSources.txt"));

/* 形式群（碼位層）用的用量統計 */
const usage = new Map<number, Map<string, number>>();
for (let gi = 0; gi < lib.glyphs.length; gi++) {
  const g = lib.glyphs[gi];
  if (!g) continue;
  const slots = refSlotsOf(lib, gi);
  if (slots.length < 2) continue;
  const boxes = slots.map((s: any) => s.box);
  for (const s of slots) {
    const cp = F.codePointOf(lib, s.ref);
    if (!cp) continue;
    const m = usage.get(cp) ?? new Map<string, number>();
    const z = slotPosOf(s.box, boxes);
    m.set(z, (m.get(z) ?? 0) + 1);
    usage.set(cp, m);
  }
}
const usageTotal = (cp: number) => { const m = usage.get(cp); if (!m) return 0; let n = 0; for (const v of m.values()) n += v; return n; };

const syn = loadSyn({ unicodeData: resolve(ROOT, "unihan/UnicodeData.txt"), variants: resolve(ROOT, "unihan/Unihan_Variants.txt"), inLib });
const fg = buildFormGroups({
  radicalStrokePath: resolve(ROOT, "unihan/Unihan_RadicalStrokeCounts.txt"),
  variantPairs: syn.pairs.map((p) => [p[0], p[1]] as [number, number]),
  /* **繁簡對應的偏旁形**（`讠↔訁`、`钅↔釒`…）✓：Unihan 的鍵是「簡化偏旁 ↔ 繁體偏旁」，
     本字（言、金、食）沒有連到它們 ✗——少了這一組，`讠` 會是孤島 ✗ */
  simpTradPairs: [
    ...loadVariantPairs(resolve(ROOT, "unihan/Unihan_Variants.txt"), ["kSimplifiedVariant"], inLib).map((p) => [p.a, p.b] as [number, number]),
    ...loadVariantPairs(resolve(ROOT, "unihan/Unihan_Variants.txt"), ["kTraditionalVariant"], inLib).map((p) => [p.a, p.b] as [number, number]),
  ],
  strokeCount: (cp) => strokes.get(cp) ?? null,
  usageCount: usageTotal, minUsage: 5,
  simpleShape: (cp) => { const c = lib.comp?.get(cp); return !c || c.length === 0; },
  blockRank: (cp) => (inLib(cp) ? 0 : 1),
  inRange: (cp) => inLib(cp) || RADICAL_RANGES.some(([a, b]) => cp >= a && cp <= b),
});

const table = buildFormTable(lib, fg, { minCount: 2 });
const ch = (cp: number | null) => (cp ? (() => { try { return String.fromCodePoint(cp); } catch { return "?" }; })() : "—");

let entries = 0, charLayer = 0, glyphLayer = 0;
const rows = ["部件\t部件碼位\t區位\t形式(字形名)\t形式碼位\t層\t用量\t實測框"];
for (const [cp, byZone] of [...table.entries()].sort((a, b) => a[0] - b[0])) {
  for (const [zone, list] of [...byZone.entries()]) {
    for (const e of list) {
      rows.push([ch(cp), "U+" + cp.toString(16).toUpperCase(), zone, e.name, ch(e.cp), e.layer, e.n, e.box.join(",")].join("\t"));
      entries++;
      if (e.layer === "char") charLayer++; else glyphLayer++;
    }
  }
}
writeFileSync(resolve(ROOT, "out/form-table.tsv"), rows.join("\n") + "\n", "utf8");

console.log(`形式表：${table.size.toLocaleString()} 個部件、${entries.toLocaleString()} 筆（char 層 ${charLayer.toLocaleString()}、glyph 層 ${glyphLayer.toLocaleString()}）`);
console.log("關鍵部件的「各區位最該用的形式」（就是這張表的用處）：");
for (const [label, cp] of [["木", 0x6728], ["月", 0x6708], ["火", 0x706b], ["刀", 0x5200], ["手", 0x624b], ["水", 0x6c34], ["金", 0x91d1], ["言", 0x8a00], ["心", 0x5fc3]] as [string, number][]) {
  const byZone = table.get(cp);
  if (!byZone) { console.log(`  ${label}：（沒有資料）`); continue; }
  const parts = [...byZone.entries()].sort((a, b) => (b[1][0]?.n ?? 0) - (a[1][0]?.n ?? 0)).slice(0, 4)
    .map(([zone, list]) => `${zone}→${list[0]!.name}${list[0]!.cp && list[0]!.cp !== cp ? `(${ch(list[0]!.cp)})` : ""}×${list[0]!.n.toLocaleString()}`);
  console.log(`  ${label} U+${cp.toString(16).toUpperCase()}：${parts.join("　")}`);
}
console.log(`\n產物：${resolve(ROOT, "out/form-table.tsv")}`);
