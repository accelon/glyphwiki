#!/usr/bin/env bun
/**
 * probe-suggest-base.ts — 驗證「**建議更好的基字**」（第 111 輪的目標）。
 *
 * 用法: bun run tools/probe-suggest-base.ts [基字 舊部件 新部件]…
 *   預設測師父的例子：`初衤禾` → 應該推薦 `利刂刀` ✓
 *
 * 為什麼要「更好的基字」：兩條路徑的**結果部件序列一樣**（`禾＋刀`），
 * 但起點不同 → 用到的**位置形**不同（`初` 的左槽為 `衤` 而設；`利` 的左半本來就是左形的 `禾`、
 * 右槽為 `刂`＝刀的右形而設）→ 從 `利` 出發好看得多 ✓。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as F from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { loadSyn, RADICAL_RANGES } from "./syn-graph.ts";
import { buildFormGroups } from "./form-groups.ts";
import { loadTotalStrokes } from "./form-groups.ts";
import { loadVariantPairs } from "./unihan-variants.ts";
import { buildSeqIndex, suggestBases } from "./suggest-base.ts";
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

/* ---- 語料用法（區位統計；同時是形式群與排序的依據） ---- */
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
  /* 繁簡對應的偏旁形（`讠↔訁`、`钅↔釒`…）✓ */
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
const index = buildSeqIndex(lib, fg);
const ch = (cp: number) => { try { return String.fromCodePoint(cp); } catch { return "?" }; };

const args = process.argv.slice(2);
const cases: [string, string, string][] = args.length >= 3
  ? [[args[0]!, args[1]!, args[2]!]]
  : [
    ["初", "衤", "禾"],     /* ← 師父的例子：應該推薦 利刂刀 ✓ */
    ["利", "刂", "禾"],     /* 反過來（把利的刂換成禾 → 禾禾？）應該沒有好建議 */
    ["秧", "央", "角"],     /* 第 110 輪修的框問題，看有沒有更好的基字 */
    ["打", "丁", "白"],     /* 打 的 丁 → 白（扌 的左形：該建議 拍？） */
    ["江", "工", "鳥"],     /* 江 的 工 → 鳥（氵 的左形） */
  ];

for (const [base, oldCh, newCh] of cases) {
  const baseCp = F.indexOfChar(lib, base);
  if (baseCp === undefined) { console.log(`✗ 基字 ${base} 不在庫中`); continue; }
  const baseGlyph = baseCp;
  const bcp = F.codePointOf(lib, baseGlyph)!;
  const oldCp = oldCh.codePointAt(0)!, newCp = newCh.codePointAt(0)!;
  const comps = lib.comp?.get(bcp);
  console.log(`\n輸入「${base}${oldCh}${newCh}」　${base} 的部件序列：${(comps ?? []).map((c) => ch(c)).join("＋")}` +
    `（${(comps ?? []).map((c) => "U+" + c.toString(16).toUpperCase()).join(",")}）`);
  const sug = suggestBases(lib, fg, index, { baseCp: bcp, oldCp, newCp, usageOf: (cp) => usage.get(cp), limit: 6 });
  if (!sug.length) { console.log("  （沒有更好的基字建議）"); continue; }
  console.log(`  建議 ${sug.length} 個：`);
  for (const s of sug) {
    console.log(`    ${s.base}${ch(s.fromCp)}${ch(s.toCp)}　分數 ${s.score.toFixed(0)}：${s.reason}`);
  }
}
