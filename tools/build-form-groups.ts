#!/usr/bin/env bun
/**
 * build-form-groups.ts — 建置期把**形式群**壓成頁面要用的最小表：`out/form-groups.json`。
 *
 * 為什麼要壓成表：頁面（`pinxing.html`）要能回答「`刂` 與 `刀` 是不是同一個部件的形式」✓
 * ——那只需要 `碼位 → 本形碼位` 這一張對照 ✓（約 2,500 個碼位、20 KB 上下 ✓）。
 * 形式群的**來源與規則**請看 `tools/form-groups.ts` 的檔頭（四個來源 ✓）；
 * 這一支只負責「跑一次、存成 JSON」✓，讓建頁面不必每次重掃語料（掃一次約十幾秒 ✗）。
 *
 * 產物：`out/form-groups.json`＝`{ "5202": 5200, "624c": 624b, … }`（只收**不同**於本形的 ✓）
 * 用法: bun run tools/build-form-groups.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as F from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { loadSyn, RADICAL_RANGES } from "./syn-graph.ts";
import { buildFormGroups, loadTotalStrokes, FORM_CORE } from "./form-groups.ts";
import { loadVariantPairs } from "./unihan-variants.ts";
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

/* 語料用法（形式群的判準之一 ✓；也是排序用） */
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
const strokes = loadTotalStrokes(resolve(ROOT, "unihan/Unihan_IRGSources.txt"));
const variantsFile = resolve(ROOT, "unihan/Unihan_Variants.txt");
const syn = loadSyn({ unicodeData: resolve(ROOT, "unihan/UnicodeData.txt"), variants: variantsFile, inLib });

const fg = buildFormGroups({
  radicalStrokePath: resolve(ROOT, "unihan/Unihan_RadicalStrokeCounts.txt"),
  variantPairs: syn.pairs.map((p) => [p[0], p[1]] as [number, number]),
  /* 繁簡對應的偏旁形：`讠↔訁`、`钅↔釒`…（師父第 111 輪的指點 ✓） */
  simpTradPairs: [
    ...loadVariantPairs(variantsFile, ["kSimplifiedVariant"], inLib).map((p) => [p.a, p.b] as [number, number]),
    ...loadVariantPairs(variantsFile, ["kTraditionalVariant"], inLib).map((p) => [p.a, p.b] as [number, number]),
  ],
  strokeCount: (cp) => strokes.get(cp) ?? null,
  usageCount: usageTotal, minUsage: 5,
  simpleShape: (cp) => { const c = lib.comp?.get(cp); return !c || c.length === 0; },
  blockRank: (cp) => (inLib(cp) ? 0 : 1),
  inRange: (cp) => inLib(cp) || RADICAL_RANGES.some(([a, b]) => cp >= a && cp <= b),
});

/* 壓成 `碼位 → 本形`（只留不同於本形的 ✓）＋ `碼位 → 人話理由`（取自師父的表 ✓） */
const map: Record<string, number> = {};
const why: Record<string, string> = {};
let n = 0;
for (const [cp, canon] of fg.canonical) {
  if (cp === canon) continue;
  map[cp.toString(16)] = canon;
  n++;
}
/* 師父的表裡的理由：以「非本形的那一邊」當鍵 ✓（例 5202 → 「刀／刂：刂 是右偏旁的刀」） */
for (const [a, b, reason] of FORM_CORE) {
  const canon = fg.canonical.get(a) === a ? a : (fg.canonical.get(b) === b ? b : a);
  const form = canon === a ? b : a;
  why[form.toString(16)] = reason;
}
const out = {
  note: "部件形式群：碼位(hex) → 本形碼位 ＋ 理由。來源見 tools/form-groups.ts（Unihan ＋ 同部首＋筆劃＋用量＋單純形 ＋ 繁簡對應 ＋ FORM_CORE）",
  generated: new Date().toISOString().slice(0, 10),
  count: n,
  canon: map,
  why,
};
writeFileSync(resolve(ROOT, "out/form-groups.json"), JSON.stringify(out), "utf8");
console.log(`形式群：${n.toLocaleString()} 個碼位有「非本形」的形式（共 ${fg.members.size.toLocaleString()} 群）、` +
  `理由 ${Object.keys(why).length} 條`);
console.log(`產物：${resolve(ROOT, "out/form-groups.json")}（${(JSON.stringify(out).length / 1024).toFixed(1)} KB）`);
const ch = (cp: number) => { try { return String.fromCodePoint(cp); } catch { return "?" }; };
for (const [label, cp] of [["刀", 0x5200], ["手", 0x624b], ["言", 0x8a00], ["金", 0x91d1]] as [string, number][]) {
  const g = fg.members.get(cp);
  console.log(`  ${label} 的群：${g ? g.map((x) => ch(x) + "(U+" + x.toString(16).toUpperCase() + ")").join(" ") : "（無）"}`);
}
