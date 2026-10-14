// probe-chaicoi.ts — 為「招財進寶」的 holy grail 做前置量測。
//
// 要回答的問題：
//   1. 序列裡每個字在不在庫中？「𩀨」「䞃」這兩個罕字是關鍵。
//   2. 𩀨 自己的構形序列是什麼？（能不能用庫裡有的部件遞歸組出來）
//   3. 「隹」在左邊的字有哪些？（師父要的「按部件位置搜尋」先做一次人工版）
//
// 用法: bun run tools/probe-chaicoi.ts
import { readFileSync } from "node:fs";
import { decodeLibrary, findGlyphIndex, toKageData } from "./lib-format.ts";
import type { Library } from "./lib-format.ts";
import { ensureEngine, inkIn, composeFit, svgOf } from "./compose-fit.ts";
import { evalSeq, listReplaceables } from "./free-compose.ts";
import { minCrossDistOf } from "./stroke-overlap.ts";

const D = "D:/2023/glyphwiki";
ensureEngine();
const lib: Library = decodeLibrary(
  new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))),
);
const cp = (c: string) => "U+" + c.codePointAt(0)!.toString(16).toUpperCase();
const idxOf = (c: string) => findGlyphIndex(lib, "u" + c.codePointAt(0)!.toString(16));
const nameOf = (i: number | undefined) => (i === undefined ? "（不在庫）" : lib.names[i]!);

// ---------------------------------------------------------------- 1. 逐字檢查

const GRAIL = "招財進寶";
const SEQ = "邏羅寶貝𩀨從䞃致招";

console.log("=== 1. 「招財進寶」相關序列的逐字檢查 ===");
for (const [label, s] of [["目標詞", GRAIL], ["構形序列", SEQ]] as [string, string][]) {
  console.log(`\n-- ${label}：${s}（${Array.from(s).length} 字）`);
  for (const c of Array.from(s)) {
    const i = idxOf(c);
    const tight = i === undefined ? "" : ` 緊框[${lib.glyphs[i]!.tight!.join(",")}] 引用數 ${lib.glyphs[i]!.strokes.filter((s2) => s2.kind === 99).length}`;
    console.log(`   ${c}  ${cp(c)}  ${nameOf(i)}${tight}`);
  }
}

// ---------------------------------------------------------------- 2. 引用樹

/** 完整引用樹（每個節點標名字、緊框、引用框） */
function tree(idx: number, depth = 0, seen: Set<number> = new Set()): void {
  const g = lib.glyphs[idx]!;
  const refs = g.strokes.filter((s) => s.kind === 99 && s.ref !== null);
  console.log("  ".repeat(depth) +
    `${lib.names[idx]}  緊框[${g.tight!.join(",")}]  ${refs.length ? "引用 " + refs.length : "筆畫 " + g.strokes.length}`);
  if (seen.has(idx) || depth > 6) return;
  const next = new Set(seen);
  next.add(idx);
  for (const s of refs) {
    console.log("  ".repeat(depth + 1) + `框[${s.box!.join(",")}] ↓`);
    tree(s.ref!, depth + 2, next);
  }
}

console.log("\n=== 2. 引用樹 ===");
for (const c of ["邏", "羅", "寶", "貝", "從", "䞃", "致", "招", "隹"]) {
  const i = idxOf(c);
  console.log(`\n-- ${c} ${cp(c)} ${nameOf(i)}`);
  if (i !== undefined) tree(i);
}

// ---------------------------------------------------------------- 3. 𩀨 的候選構形

console.log("\n=== 3. 𩀨（U+29028）的候選構形 ===");
console.log("  𩀨 ＝ ⿰隹集？ ⿰隹焦？ ⿱隹木？ 先看 Unicode 名稱與 IDS 線索");

// 檢索：庫中哪些字的結構是「隹 + 某件」（隹在左）——這是師父要的搜尋的人工版
console.log("\n=== 4. 「隹」在左邊的字（人工掃描，先看規模） ===");
const zhui = idxOf("隹");
console.log(`  隹 = ${nameOf(zhui)}`);
const leftOf: { ch: string; name: string; other: string; dist: number }[] = [];
for (let i = 0; i < lib.names.length; i++) {
  const nm = lib.names[i]!;
  if (!/^u[0-9a-f]+(-j)?$/.test(nm)) continue;          // 只看碼位字
  const g = lib.glyphs[i]!;
  const refs = g.strokes.filter((s) => s.kind === 99 && s.ref !== null);
  if (refs.length !== 2) continue;
  const [a, b] = refs as [typeof refs[0], typeof refs[0]];
  const ca = a.box!, cb = b.box!;
  const wA = ca[2] - ca[0], wB = cb[2] - cb[0];
  // 左邊那個是不是 隹 的變體？（含 u96b9 系列）
  const isZhui = (ref: number) => /^u96b9/.test(lib.names[ref]!);
  const leftIsZhui = isZhui(a.ref!) && wA <= wB;
  const rightIsZhui = isZhui(b.ref!) && wB <= wA;
  if (!leftIsZhui && !rightIsZhui) continue;
  const m = /^u([0-9a-f]+)/.exec(nm)!;
  const ch2 = String.fromCodePoint(parseInt(m[1]!, 16));
  const other = leftIsZhui ? lib.names[b.ref!]! : lib.names[a.ref!]!;
  let dist = Infinity;
  try { dist = minCrossDistOf(lib, i); } catch { /* 略 */ }
  leftOf.push({ ch: ch2, name: nm, other, dist });
}
console.log(`  找到 ${leftOf.length} 個「隹」在左邊的字（只列前 40）：`);
const fmtD = (v: number) => (!Number.isFinite(v) ? "無" : v.toFixed(1));
for (const r of leftOf.slice(0, 40)) {
  console.log(`    ${r.ch} ${r.name.padEnd(12)} 右件 ${r.other.padEnd(14)} 跨部件距離 ${fmtD(r.dist)}`);
}

// 其中有沒有「隹 + 集」？
console.log("\n=== 5. 關鍵檢查：庫中有沒有「隹」在左、「集」在右的字？ ===");
const ji = /^u96c6/.test("") ? "" : "集";
const jiI = idxOf("集");
console.log(`  集 = ${nameOf(jiI)}`);
const cand = leftOf.filter((r) => /^u96c6/.test(r.other));
if (cand.length) for (const r of cand) console.log(`    ✓ ${r.ch} ${r.name} 右件 ${r.other}`);
else console.log("    ✗ 沒有「隹＋集」的現成字");

// 那「隹」在左、「焦」在右呢？（𩀨 可能就是 ⿰隹焦）
const jiaoI = idxOf("焦");
console.log(`  焦 = ${nameOf(jiaoI)}`);
const cand2 = leftOf.filter((r) => /^u7126/.test(r.other));
if (cand2.length) for (const r of cand2) console.log(`    ✓ ${r.ch} ${r.name} 右件 ${r.other}`);
else console.log("    ✗ 沒有「隹＋焦」的現成字");

console.log("\n=== 6. 𩀨 能不能用庫裡有的部件直接組出來？（遞歸嘗試）===");
// 假設 𩀨 = ⿰隹集 或 ⿰隹焦 —— 需要一個「臨時基字」才有槽位可換。
// composeFit 需要有 base 的引用樹；所以先找一個結構相近的基字當模板。
console.log("  ⚠ 這裡就是缺口：composeFit 只能「替換既有槽位」，不能「新建槽位」。");
console.log("     所以要生出 𩀨，必須先有一個含 隹 的基字，再把它其中一件換掉。");

console.log("\n=== 7. 測試：用「邏」當模板換出序列裡的其他字 ===");
for (const [base, pairs] of [
  ["邏", [["羅", "寶"]]],
  ["邏", [["羅", "貝"]]],
  ["寶", [["缶", "支"]]],
] as [string, [string, string][]][]) {
  const r = composeFit(lib, base, pairs as [string, string][]);
  const label = base + pairs.map(([a, b]) => a + b).join("");
  if ("error" in r) { console.log(`  ✗ ${label}: ${r.error}`); continue; }
  const d = Number.isFinite(minCrossDistOf(r.lib, r.targetIdx))
    ? minCrossDistOf(r.lib, r.targetIdx).toFixed(1) : "無";
  console.log(`  ✓ ${label}：${r.log.join("；")}`);
  console.log(`      跨部件距離 ${d}`);
}
