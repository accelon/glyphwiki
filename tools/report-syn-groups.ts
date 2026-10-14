#!/usr/bin/env bun
/**
 * report-syn-groups.ts — 異體（syn）的**稽核報告**：來源組成、連通分量、選項層規模。
 *
 * 第 110 輪之後 syn 的來源是 **Unihan（權威）** ✓（見 `tools/unihan-variants.ts`），
 * 所以這一支要回答的問題也變了：
 *   ① 進字庫的 syn 由哪幾類組成？各幾對？（相容字符／kZVariant／部首形／白名單）
 *   ② 連通分量有沒有異常大的一群？（>150 拒收、>20 警告——建庫也有同一道閘門）
 *   ③ **選項層**（「同時找異體部件」）有多少對、各欄位幾個？（偏旁形、簡繁、日新舊字體）
 *
 * 用法: bun run tools/report-syn-groups.ts [--min-size 3] [--out out/]
 * 產物:
 *   out/syn-sources.tsv   來源組成（**這一張是給師父看的**）
 *   out/syn-groups.tsv    每個連通分量（≥min-size）的成員與邊
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadSyn, synGroups } from "./syn-graph.ts";
import { OPTION_FIELDS, SYN_FIELDS } from "./unihan-variants.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const num = (k: string, d: number) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d; };
const MIN = num("--min-size", 3);
const OUT = (() => { const i = argv.indexOf("--out"); return i >= 0 && argv[i + 1] ? resolve(ROOT, argv[i + 1]!) : resolve(ROOT, "out"); })();

/* 與 build-library 同一組字集區段（刻意的重複：報告工具不該為了拿區段跑一次建庫） */
const RANGES: [number, number][] = [
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff],
  [0x20000, 0x2a6df], [0x2a700, 0x2b73f], [0x2b740, 0x2b81f], [0x2b820, 0x2ceaf],
  [0x2ceb0, 0x2ebef], [0x2ebf0, 0x2ee5f], [0x2f800, 0x2fa1f],
  [0x30000, 0x3134f], [0x31350, 0x323af],
];
const inLib = (cp: number) => RANGES.some(([a, b]) => cp >= a && cp <= b);

const syn = loadSyn({
  unicodeData: resolve(ROOT, "unihan/UnicodeData.txt"),
  variants: resolve(ROOT, "unihan/Unihan_Variants.txt"),
  inLib,
});
const ch = (cp: number) => { try { return String.fromCodePoint(cp); } catch { return "?"; } };
const hex = (cp: number) => "U+" + cp.toString(16).toUpperCase();

const { groups, nodeCount } = synGroups(syn.pairs);
const big = groups.filter((g) => g.length >= MIN);

/* ---- 一、來源組成（給師父看的那張） ---- */
const src = ["類別\t對數\t說明"];
const NOTE: Record<string, string> = {
  "相容字符（UnicodeData 正規分解）": "同一個字的另一個碼位（用戶打不出來；`滑`＝`滑`）——永遠合併 ✓",
  kZVariant: "Unicode 的 z-variant（字形差異：`戶/户`、`曶/㫚`）——同一個字 ✓",
};
for (const [k, v] of [...syn.bySource.entries()].sort((x, y) => y[1] - x[1])) {
  src.push([k, v, NOTE[k] ?? "本專案列出（部首形／白名單）"].join("\t"));
}
src.push("");
src.push(`合計\t${syn.pairs.length} 對\t參與碼位 ${nodeCount}；最大連通分量 ${groups[0]?.length ?? 0}`);
src.push(`選項層\t${syn.optionPairs.length} 對\t**不進 syn** ✗——「同時找異體部件」用（資料保留精確資訊 ✓）`);
for (const [k, v] of [...syn.optionByField.entries()].sort((x, y) => y[1] - x[1])) src.push(`　${k}\t${v}\t（選項層）`);
src.push(`　（syn 欄位：${SYN_FIELDS.join("、")}；選項欄位：${OPTION_FIELDS.join("、")}；永不使用：kSpoofingVariant）`);
src.push(`Unihan 有、但端點不在我們字集：${syn.outsideLib} 筆（略過）`);
writeFileSync(resolve(OUT, "syn-sources.tsv"), src.join("\n") + "\n", "utf8");

/* ---- 二、連通分量 ---- */
const out = ["群\t群大小\t#\t邊\t備註"];
big.forEach((g, i) => {
  const set = new Set(g);
  const es = syn.pairs.filter(([a, b]) => set.has(a) && set.has(b));
  out.push([i + 1, g.length, 0, g.map((c) => `${ch(c)}(${hex(c)})`).join(" "), "（成員）"].join("\t"));
  es.forEach((e, k) => out.push([i + 1, g.length, k + 1, `${ch(e[0])}(${hex(e[0])})—${ch(e[1])}(${hex(e[1])})`, ""].join("\t")));
});
writeFileSync(resolve(OUT, "syn-groups.tsv"), out.join("\n") + "\n", "utf8");

const maxG = groups[0]?.length ?? 0;
console.log(`syn（Unihan 來源）：${syn.pairs.length} 對、參與碼位 ${nodeCount}、最大連通分量 ${maxG}` +
  (maxG > 150 ? "　✗ 超過硬上限 150！" : maxG > 20 ? "　⚠ 超過警告門檻 20" : "　✓ 在門檻內"));
for (const [k, v] of [...syn.bySource.entries()].sort((x, y) => y[1] - x[1])) console.log(`  ${k}：${v} 對`);
console.log(`選項層（「同時找異體部件」，不進 syn）：${syn.optionPairs.length.toLocaleString()} 對　` +
  [...syn.optionByField.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join("、"));
console.log(`可疑群（≥${MIN}）：${big.length} 個` + (big.length ? `，前三個：` + big.slice(0, 3).map((g) => g.map(ch).join("")).join("　") : ""));
console.log(`\n產物：${resolve(OUT, "syn-sources.tsv")}\n      ${resolve(OUT, "syn-groups.tsv")}`);
