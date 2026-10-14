#!/usr/bin/env bun
/**
 * probe-form-groups.ts — 建**形式群**（位置形）並產出給師父刪修的草稿。
 *
 * 用法: bun run tools/probe-form-groups.ts
 * 產物: out/form-groups.tsv
 *   本形, 本形碼位, 成員（碼位）, 成員（字）, 來源, 語料用法（區位×次數）
 *
 * 為什麼要有這一支：這是 `部件形式.md` 的「關係層」草稿——
 * ① Unihan 異體 ✓ ② 同 kRSUnicode 部首 ＋ 筆劃相近 ＋ **字形相似** ✓ ③ 師父的表（`FORM_CORE`）✓
 * ⚠ 同部首**不等於**同部件（`江`／`河` 同 85 部首 ✗）→ 所以筆劃相近與字形相似是必要的把關 ✓。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as F from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { loadSyn, RADICAL_RANGES } from "./syn-graph.ts";
import { loadVariantPairs, OPTION_FIELDS } from "./unihan-variants.ts";
import { buildFormGroups, canonicalOf, FORM_CORE, loadRadicalStroke, loadTotalStrokes } from "./form-groups.ts";
import { ensureEngine } from "./compose-fit.ts";
import { rasterize, iou } from "./raster.ts";
import { normalizedIou, inkAspect } from "./shape-similarity.ts";
import { refSlotsOf, slotPosOf } from "./free-compose.ts";

const ROOT = resolve(import.meta.dir, "..");
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();
const Kage = (globalThis as any).Kage;
const totalStrokes = loadTotalStrokes(resolve(ROOT, "unihan/Unihan_IRGSources.txt"));

const RANGES: [number, number][] = [
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff],
  [0x20000, 0x2a6df], [0x2a700, 0x2b73f], [0x2b740, 0x2b81f], [0x2b820, 0x2ceaf],
  [0x2ceb0, 0x2ebef], [0x2ebf0, 0x2ee5f], [0x2f800, 0x2fa1f],
  [0x30000, 0x3134f], [0x31350, 0x323af],
];
const inLib = (cp: number) => RANGES.some(([a, b]) => cp >= a && cp <= b);

/* ---- ① 渲染相似度（只在同部首的候選對上呼叫，量不大） ---- */
const memo = new Map<number, any>();
function rasterOf(cp: number) {
  if (memo.has(cp)) return memo.get(cp);
  let r = null;
  const gi = F.indexOfCodePoint(lib, cp);
  if (gi !== undefined) {
    const kage = new Kage();
    const seen = new Set<number>(), stack = [gi];
    while (stack.length) {
      const j = stack.pop()!;
      if (seen.has(j)) continue;
      seen.add(j);
      kage.kBuhin.push(F.keyOfIdx(lib, j), F.toKageData(lib.glyphs[j]!, lib));
      for (const s of lib.glyphs[j]!.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
    }
    try { r = rasterize(kage, F.keyOfIdx(lib, gi), 64, 2); } catch { r = null; }
  }
  memo.set(cp, r);
  return r;
}
const similarity = (a: number, b: number): number | null => {
  const ra = rasterOf(a), rb = rasterOf(b);
  /* ⚠ 要用**正規化**的 IoU（裁到墨跡框再比）——原始 IoU 會把 `刀/刂` 判成 0.06 ✗（見 shape-similarity.ts） */
  return ra && rb ? normalizedIou(ra, rb) : null;
};
const strokeCount = (cp: number): number | null => {
  const t = totalStrokes.get(cp);
  if (t !== undefined) return t;
  const gi = F.indexOfCodePoint(lib, cp);
  if (gi === undefined) return null;
  const g = lib.glyphs[gi]!;
  return g.strokes.filter((s) => s.kind !== 0).length;
};

/* ---- Unihan 異體對：只用 `syn`（Unicode 正規等價 ✓）。
   ⚠ **不從 `kSemanticVariant` 建形式群** ✗——那是「語意／字符變體」（`崎/埼`、`你/您`、`菌/蕈`），
   屬於 A5 的**查字選項層**，不是「同一個部件的位置形式」✓（實測它會把無關的字串成一大群 ✗）。
   位置形靠 ①`FORM_CORE`（構字常識）②同部首＋筆劃相近＋**用量**＋**單純形** ✓。 */
const syn = loadSyn({ unicodeData: resolve(ROOT, "unihan/UnicodeData.txt"), variants: resolve(ROOT, "unihan/Unihan_Variants.txt"), inLib });
const variantPairs: [number, number][] = syn.pairs.map((p) => [p[0], p[1]] as [number, number]);
/* **繁簡對應的偏旁形**（`讠↔訁`、`钅↔釒`…）——師父第 111 輪的指點 ✓
   ⚠ Unihan 的鍵是「簡化偏旁 ↔ 繁體偏旁」，**本字（言、金、食）沒有連到它們** ✗
   → 所以形式群要靠這一組把 `讠` 接進 `{言, 訁}` ✓（否則 `讠` 永遠是孤島 ✗）。 */
const simpTradPairs: [number, number][] = [
  ...loadVariantPairs(resolve(ROOT, "unihan/Unihan_Variants.txt"), ["kSimplifiedVariant"], inLib).map((p) => [p.a, p.b] as [number, number]),
  ...loadVariantPairs(resolve(ROOT, "unihan/Unihan_Variants.txt"), ["kTraditionalVariant"], inLib).map((p) => [p.a, p.b] as [number, number]),
];

/* ---- 語料用法：每個成員在哪個區位被引用幾次（**同時是形式判準的一部分**） ---- */
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
    const zone = slotPosOf(s.box, boxes);
    const m = usage.get(cp) ?? new Map<string, number>();
    m.set(zone, (m.get(zone) ?? 0) + 1);
    usage.set(cp, m);
  }
}
const usageTotal = (cp: number) => {
  const m = usage.get(cp);
  if (!m) return 0;
  let n = 0;
  for (const v of m.values()) n += v;
  return n;
};

const MIN_USAGE = Number(process.argv[2] ?? 5);
const fg = buildFormGroups({
  radicalStrokePath: resolve(ROOT, "unihan/Unihan_RadicalStrokeCounts.txt"),
  variantPairs, simpTradPairs, strokeCount,
  usageCount: usageTotal, minUsage: MIN_USAGE,
  /* 位置形都是**單純的形**（自己沒有部件分解）：`氵`、`扌`、`刂` ✓；`光`、`江`、`打` 不是 ✗ */
  simpleShape: (cp) => { const c = lib.comp?.get(cp); return !c || c.length === 0; },
  /* 本形要先分區：一般漢字區勝過部首補充區（否則 `手` 群會挑到 `⺘` ✗） */
  blockRank: (cp) => (inLib(cp) ? 0 : 1),
  inRange: (cp) => inLib(cp) || RADICAL_RANGES.some(([a, b]) => cp >= a && cp <= b),
});
const ch = (cp: number) => { try { return String.fromCodePoint(cp); } catch { return "?" }; };
const hex = (cp: number) => "U+" + cp.toString(16).toUpperCase();

/* ---- 用法文字（給產物用；用法統計已在上面算好） ---- */
const usageText = (cp: number) => {
  const m = usage.get(cp);
  if (!m) return "";
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([z, n]) => `${z}×${n}`).join(" ");
};

/* ---- 驗證：關鍵形式有沒有連對、假碰撞有沒有擋掉 ---- */
const pairsToCheck: [string, string, boolean][] = [
  ["刀", "刂", true], ["手", "扌", true], ["水", "氵", true], ["心", "忄", true],
  ["示", "礻", true], ["衣", "衤", true], ["食", "飠", true], ["金", "釒", true],
  ["言", "訁", true], ["犬", "犭", true], ["爪", "爫", true], ["网", "罒", true],
  ["阜", "⻖", true], ["邑", "⻏", true], ["肉", "⺼", true], ["艹", "⺾", true], ["艸", "艹", true],
  /* **簡化／傳統偏旁形**（師父第 111 輪的指點）：兩邊都要接進同一個群 ✓ */
  ["言", "讠", true], ["金", "钅", true], ["食", "饣", true], ["糸", "纟", true],
  ["糸", "糹", true], ["見", "见", true], ["貝", "贝", true], ["馬", "马", true],
  ["鳥", "鸟", true], ["魚", "鱼", true], ["車", "车", true], ["門", "门", true],
  ["頁", "页", true], ["風", "风", true], ["長", "长", true], ["韋", "韦", true],
  ["齒", "齿", true], ["龍", "龙", true], ["麥", "麦", true], ["黃", "黄", true],
  ["言", "言", true],
  /* ⚠ 師父特別提醒：**邑／阜** 的字形**完全一樣**（阝），連人常常都搞錯 ✗。
     它們是**不同的部件**（阜＝左耳，邑＝右耳），所以**絕對不可以**同群 ✓。
     靠的是 `kRSUnicode` 的部首不同（阜 170／邑 163 ✓）——這一條要一直有測試守著 ✓。 */
  ["阜", "邑", false], ["⻖", "⻏", false], ["阜", "⻖", true], ["邑", "⻏", true],
  ["水", "江", false], ["水", "河", false], ["手", "打", false], ["刀", "切", false],
  ["示", "社", false], ["心", "想", false],
];
let bad = 0;
console.log(`關鍵檢查（同群＝應為 true、不該同群＝應為 false）：`);
for (const [a, b, want] of pairsToCheck) {
  const ca = a.codePointAt(0)!, cb = b.codePointAt(0)!;
  const got = canonicalOf(fg, ca) === canonicalOf(fg, cb);
  const mark = got === want ? "✓" : "✗";
  if (got !== want) bad++;
  console.log(`  ${mark} ${a}/${b} 同群=${got}（期望 ${want}）` +
    `　筆劃 ${strokeCount(ca)}/${strokeCount(cb)}　用量 ${usageTotal(ca)}/${usageTotal(cb)}` +
    (got && want ? `　本形＝${ch(canonicalOf(fg, ca))}` : "") +
    (got !== want ? `　（來源：${fg.pairSource.get(ca + "-" + cb) ?? fg.pairSource.get(cb + "-" + ca) ?? "—"}）` : ""));
}

/* ---- 產物：群表 ---- */
const rows = ["本形\t本形碼位\t成員\t成員碼位\t來源\t語料用法（區位×次數，前 3）"];
const groups = [...fg.members.entries()].filter(([, g]) => g.length > 1).sort((a, b) => b[1].length - a[1].length);
for (const [canon, g] of groups) {
  const src = g.slice(1).map((cp) => fg.pairSource.get(canon + "-" + cp) ?? fg.pairSource.get(cp + "-" + canon) ?? "—").join("；");
  rows.push([
    ch(canon), hex(canon),
    g.map(ch).join(" "), g.map(hex).join(" "),
    src,
    g.map((cp) => `${ch(cp)}:${usageText(cp) || "（未被引用）"}`).join("｜"),
  ].join("\t"));
}
writeFileSync(resolve(ROOT, "out/form-groups.tsv"), rows.join("\n") + "\n", "utf8");

console.log(`\n形式群：${groups.length} 群、涵蓋 ${[...fg.canonical.keys()].length} 個碼位 ` +
  `（來源：Unihan 正規等價 ＋ 同部首（筆劃相近＋用量≥${MIN_USAGE}＋單純形）＋ 師父的表 ${FORM_CORE.length} 條）`);
console.log(`群大小分佈：` + [2, 3, 4, 5, 6].map((n) => `${n}:${groups.filter(([, g]) => g.length === n).length}`).join("　") +
  `　7+:${groups.filter(([, g]) => g.length >= 7).length}`);
console.log("最大的 12 群（人工抽查用）：");
for (const [canon, g] of groups.slice(0, 12)) {
  console.log(`  ${g.length}　本形 ${ch(canon)}：${g.map(ch).join(" ")}`);
}
console.log(`\n${bad === 0 ? "✓" : "✗"} 關鍵檢查：${bad === 0 ? "全部符合" : bad + " 項不符"}`);
console.log(`產物：${resolve(ROOT, "out/form-groups.tsv")}`);
