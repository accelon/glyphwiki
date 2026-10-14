#!/usr/bin/env bun
/**
 * probe-variant-recognition.ts — 驗師父第 117 輪的判例：
 *   「日式字形和大陸標準的差異不必太在意（黑＝黒 客人認得 ✓），
 *     除了少數像「酔＝醉」，現代人不一定會知道其實是同一字（酔 是唐代寫法、日本人沿用 ✓）。」
 *
 * 要回答兩件事：
 *   ① **`酔`(U+9154) 與 `醉`(U+9189) 有沒有被我們的資料合成「同一個字」** ✗——
 *      合成錯了才是問題 ✓（客人打 `醉`、我們卻建議用 `酔` 當基字就糟了 ✗）。
 *   ② `黑/黒`、`水/氵` 這類客人一定認得的，有沒有正常連上 ✓。
 *
 * 用法: bun run tools/probe-variant-recognition.ts
 */
import { resolve } from "node:path";
import * as F from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { loadSyn, RADICAL_RANGES } from "./syn-graph.ts";
import { loadVariantPairs } from "./unihan-variants.ts";
import { buildFormGroups, loadTotalStrokes, canonicalOf } from "./form-groups.ts";
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
const usage = new Map<number, Map<string, number>>();
for (let gi = 0; gi < lib.glyphs.length; gi++) {
  const g = lib.glyphs[gi]; if (!g) continue;
  const slots = refSlotsOf(lib, gi); if (slots.length < 2) continue;
  const boxes = slots.map((s: any) => s.box);
  for (const s of slots) {
    const cp = F.codePointOf(lib, s.ref); if (!cp) continue;
    const m = usage.get(cp) ?? new Map<string, number>();
    const z = slotPosOf(s.box, boxes); m.set(z, (m.get(z) ?? 0) + 1); usage.set(cp, m);
  }
}
const usageTotal = (cp: number) => { const m = usage.get(cp); if (!m) return 0; let n = 0; for (const v of m.values()) n += v; return n; };
const variantsFile = resolve(ROOT, "unihan/Unihan_Variants.txt");
const syn = loadSyn({ unicodeData: resolve(ROOT, "unihan/UnicodeData.txt"), variants: variantsFile, inLib });
/* 各種來源分開看，才知道「是誰把他們連起來的」✓ */
const kz = loadVariantPairs(variantsFile, ["kZVariant"], inLib);
const sem = loadVariantPairs(variantsFile, ["kSemanticVariant", "kSpecializedSemanticVariant"], inLib);
const simp = loadVariantPairs(variantsFile, ["kSimplifiedVariant"], inLib);
const trad = loadVariantPairs(variantsFile, ["kTraditionalVariant"], inLib);
const jold = loadVariantPairs(variantsFile, ["kJapaneseOldVariant"], inLib);

const fg = buildFormGroups({
  radicalStrokePath: resolve(ROOT, "unihan/Unihan_RadicalStrokeCounts.txt"),
  variantPairs: syn.pairs.map((p) => [p[0], p[1]] as [number, number]),
  simpTradPairs: [...simp.map((p) => [p.a, p.b] as [number, number]), ...trad.map((p) => [p.a, p.b] as [number, number])],
  strokeCount: (cp) => strokes.get(cp) ?? null,
  usageCount: usageTotal, minUsage: 5,
  simpleShape: (cp) => { const c = lib.comp?.get(cp); return !c || c.length === 0; },
  blockRank: (cp) => (inLib(cp) ? 0 : 1),
  inRange: (cp) => inLib(cp) || RADICAL_RANGES.some(([a, b]) => cp >= a && cp <= b),
});
const ch = (cp: number) => { try { return String.fromCodePoint(cp); } catch { return "?" }; };
const hex = (cp: number) => "U+" + cp.toString(16).toUpperCase();

/** 有沒有任何一層把這兩個碼位當成「同一個形式／同一個字」✓ */
function link(a: number, b: number) {
  const inSyn = syn.pairs.some((p) => (p[0] === a && p[1] === b) || (p[0] === b && p[1] === a));
  const inGroup = canonicalOf(fg, a) === canonicalOf(fg, b);
  const fields: string[] = [];
  const has = (pairs: { a: number; b: number }[], name: string) => {
    if (pairs.some((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a))) fields.push(name);
  };
  has(kz, "kZVariant"); has(sem, "kSemanticVariant"); has(simp, "kSimplifiedVariant");
  has(trad, "kTraditionalVariant"); has(jold, "kJapaneseOldVariant");
  return { inSyn, inGroup, fields };
}

const cases: [string, string, string][] = [
  ["酔", "醉", "師父的判例：**不可以**當同一個字（現代人認不出來 ✓）"],
  ["黒", "黑", "師父說不必在意：客人認得 ✓"],
  ["氵", "水", "部首變形：當然要連 ✓"],
  ["亜", "亞", "日本新字體 vs 繁體：客人多半認得 ✓"],
  ["国", "國", "簡化字 ✓"],
  ["戦", "戰", "日本用字 ✓"],
  ["豊", "豐", "日本用字（豊 是唐代寫法 ✓）"],
];
console.log("判例檢查（『同群』＝我們的資料把它們當同一個部件的形式 ✓）：\n");
for (const [a, b, why] of cases) {
  const ca = a.codePointAt(0)!, cb = b.codePointAt(0)!;
  const l = link(ca, cb);
  console.log(`${a}(${hex(ca)}, ${strokes.get(ca) ?? "?"}筆) ／ ${b}(${hex(cb)}, ${strokes.get(cb) ?? "?"}筆)`);
  console.log(`   syn（Unicode 正規等價）：${l.inSyn ? "有" : "無"}　形式群：${l.inGroup ? "**同群**" : "不同群"}` +
    `　Unihan 欄位：${l.fields.join("、") || "無"}`);
  console.log(`   ${why}\n`);
}
