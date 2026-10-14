#!/usr/bin/env bun
/**
 * report-syn-similarity.ts — **視覺判準**：把異體表的每一對都畫出來，量「像不像」。
 *
 * 為什麼要做這一支（第 110 輪）：
 *   師父裁定「UCV 推論／無來源註記一律不歸併」✓，但那批裡**混著**真的偏旁形
 *   （`金/釒`、`示/礻`、`戶/户`…）。要分辨「同一偏旁的兩種寫法」與「被推論硬湊的」
 *   （`口/土`、`一/八`、`日/冃`），**唯一站得住的判準是視覺** ✓——這也正是師父的
 *   「以視覺為基礎」（§6.19）。用引用次數或代價都分不出來 ✗（`口/土` 兩端都上萬次引用）。
 *
 * 做法：
 *   1. 把一對的兩邊各自畫成點陣（64×64，與 `check-component-boxes` 同一套引擎與 `raster.ts`），
 *      取覆蓋率 > 0.5 的格當「墨」，算 **IoU**（聯集／交集）。
 *   2. **對照組**：已保留的 483 對（相容字符＋部首形）本來就是「同一個字」，
 *      它們的 IoU 分佈就是「像」的基準線 ✓；被裁定不歸併的 597 對分佈放旁邊比。
 *   3. 門檻**先看分佈再定**（⚠ 不先射箭再畫靶），並且把分佈印出來。
 *
 * 用法: bun run tools/report-syn-similarity.ts [--size 64] [--thr 0.6]
 * 產物: out/syn-similarity.tsv（裁定｜IoU｜類別｜A｜B｜代價…；依 IoU 遞減＝最像的排前面）
 *       ——第一欄給師父填 1＝例外保留／0 或留空＝維持不歸併。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as F from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { ensureEngine } from "./compose-fit.ts";
import { rasterize, iou } from "./raster.ts";
import { loadSyn } from "./syn-graph.ts";
import { loadCompatPairs, loadVariantPairs, OPTION_FIELDS } from "./unihan-variants.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const numArg = (k: string, d: number) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d; };
const SIZE = numArg("--size", 64);
const THR = numArg("--thr", NaN);   /* 沒給就看分佈由程式自己報，不擅自決定 */

const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();
const Kage = (globalThis as any).Kage;

const RANGES: [number, number][] = [
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff],
  [0x20000, 0x2a6df], [0x2a700, 0x2b73f], [0x2b740, 0x2b81f], [0x2b820, 0x2ceaf],
  [0x2ceb0, 0x2ebef], [0x2ebf0, 0x2ee5f], [0x2f800, 0x2fa1f],
  [0x30000, 0x3134f], [0x31350, 0x323af],
];
const inLib = (cp: number) => RANGES.some(([a, b]) => cp >= a && cp <= b);

/** 把一個碼位畫出來（含它引用的整棵閉包）；沒有字形就回 null */
function rasterOf(cp: number) {
  const gi = F.indexOfCodePoint(lib, cp);
  if (gi === undefined) return null;
  const kage = new Kage();
  const seen = new Set<number>(), stack = [gi];
  while (stack.length) {
    const j = stack.pop()!;
    if (seen.has(j)) continue;
    seen.add(j);
    kage.kBuhin.push(F.keyOfIdx(lib, j), F.toKageData(lib.glyphs[j]!, lib));
    for (const s of lib.glyphs[j]!.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  try { return rasterize(kage, F.keyOfIdx(lib, gi), SIZE, 2); } catch { return null; }
}

/* 第 110 輪之後：syn 來自 **Unihan（權威）** ✓，所以這一支的用途變成**驗證**：
   「進 syn 的每一對，畫出來本來就該很像」——分佈若掉下來，就是來源或欄位選錯了 ✗。
   同時把**選項層**（「同時找異體部件」）的分布一起量，讓師父看那些欄位放選項合不合理。 */
const syn = loadSyn({
  unicodeData: resolve(ROOT, "unihan/UnicodeData.txt"),
  variants: resolve(ROOT, "unihan/Unihan_Variants.txt"),
  inLib,
});
const cached = new Map<number, ReturnType<typeof rasterOf>>();
const R = (cp: number) => { if (!cached.has(cp)) cached.set(cp, rasterOf(cp)); return cached.get(cp) ?? null; };

interface Row { a: number; b: number; kind: string; iou: number | null; layer: "syn" | "選項" }
const all: Row[] = [];
const add = (a: number, b: number, kind: string, layer: "syn" | "選項") => {
  const ra = R(a), rb = R(b);
  all.push({ a, b, kind, iou: ra && rb ? iou(ra, rb) : null, layer });
};
const srcOfPair = new Map<string, string>();
/* syn 的每一對屬於哪個來源：逐一比對（來源清單不大） */
const compatKeys = new Set(loadCompatPairs(resolve(ROOT, "unihan/UnicodeData.txt"), inLib).map((p) => p.a + "-" + p.b));
for (const [a, b] of syn.pairs) {
  const isCompat = compatKeys.has(a + "-" + b) || compatKeys.has(b + "-" + a);
  srcOfPair.set(a + "-" + b, isCompat ? "相容字符" : "kZVariant／部首形");
  add(a, b, srcOfPair.get(a + "-" + b)!, "syn");
}
/* 選項層：逐一比對欄位（同一對可能有多個欄位，取第一個） */
for (const p of loadVariantPairs(resolve(ROOT, "unihan/Unihan_Variants.txt"), OPTION_FIELDS, inLib)) {
  const k = p.a + "-" + p.b;
  if (srcOfPair.has(k) || srcOfPair.has(p.b + "-" + p.a)) continue;
  if (all.some((r) => r.a === p.a && r.b === p.b && r.layer === "選項")) continue;
  srcOfPair.set(k, p.field);
  add(p.a, p.b, p.field, "選項");
}

/* ---- 分佈（先看分佈，再談門檻） ---- */
const q = (arr: number[], p: number) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]! : NaN;
const stat = (name: string, vals: number[]) => {
  const s = [...vals].sort((x, y) => x - y);
  const f = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");
  console.log(`  ${name.padEnd(28)} n=${String(s.length).padStart(5)}　` +
    `最小 ${f(s[0])}　25% ${f(q(s, 0.25))}　中位 ${f(q(s, 0.5))}　75% ${f(q(s, 0.75))}　最大 ${f(s[s.length - 1])}`);
  return s;
};
console.log(`畫完 ${cached.size.toLocaleString()} 個字（點陣 ${SIZE}×${SIZE}）`);
console.log("IoU 分佈（syn 本來就該接近 1.00；選項層各欄位供參考）：");
const synVals = all.filter((r) => r.layer === "syn" && r.iou !== null).map((r) => r.iou!);
stat("syn（永遠合併）", synVals);
for (const k of OPTION_FIELDS) {
  const v = all.filter((r) => r.layer === "選項" && r.kind === k && r.iou !== null).map((r) => r.iou!);
  if (v.length) stat("　選項：" + k, v);
}
const noGlyph = all.filter((r) => r.iou === null).length;
console.log(`  量不到的（有一端沒有字形）${noGlyph} 對`);
if (Number.isFinite(THR)) {
  const bad = synVals.filter((v) => v < THR).length;
  console.log(`  門檻 ${THR}：syn 裡「不像」的有 ${bad} 對（⚠ 應該接近 0；不是 0 就要看是哪一類）`);
}

/* ---- 產物：依 IoU 遞增（最不像的排前面＝最該檢查的） ---- */
const ch = (cp: number) => { try { return String.fromCodePoint(cp); } catch { return "?"; } };
const hex = (cp: number) => "U+" + cp.toString(16).toUpperCase();
const out: string[] = [
  "# 異體表「像不像」清單（第 110 輪，2026-10-14）",
  "# syn（永遠合併）來自 **Unihan 權威資料** ✓：相容字符（UnicodeData 正規分解）＋ kZVariant。",
  "# 這一張是**驗證用**：syn 的每一對畫出來本來就該很像；最不像的排在最前面（⚠ 那幾對最該檢查）。",
  "# 下面接著是**選項層**（「同時找異體部件」：偏旁形／簡繁／日新舊字體）——它**不進 syn** ✗，",
  "# 只是讓師父看那些欄位放選項合不合理（偏旁形應該像、簡繁不一定像）。",
  "#",
  ["層", "IoU", "類別", "部件A", "碼位A", "部件B", "碼位B"].join("\t"),
];
for (const r of all.sort((x, y) => (x.iou ?? 2) - (y.iou ?? 2))) {
  out.push([r.layer, r.iou === null ? "（無字形）" : r.iou.toFixed(3), r.kind,
    ch(r.a), hex(r.a), ch(r.b), hex(r.b)].join("\t"));
}
writeFileSync(resolve(ROOT, "out/syn-similarity.tsv"), out.join("\n") + "\n", "utf8");
console.log(`\n產物：${resolve(ROOT, "out/syn-similarity.tsv")}（${all.length} 列，依 IoU 遞增＝最不像的排前面）`);
