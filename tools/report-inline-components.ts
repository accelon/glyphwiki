#!/usr/bin/env bun
/**
 * report-inline-components.ts — 列出「部件被拆成原始筆劃」的字，並統計哪些部件最常被拆。
 *
 * 定義（要分清楚，不然會把「歸併節點」也算進來）：
 *   IDS 直接部件   -- `ids_comp` 說的（權威的結構資料）
 *   KAGE 可達      -- 從這個字的字形沿著 KAGE 引用樹走得到的碼位（**不限直接**）
 *   真內嵌 = IDS 直接部件 − KAGE 可達
 *
 * 用「KAGE 可達」而不是「KAGE 直接」是因為：如果 A 引用 D、而 D = B+C，
 * 那 B 不是 A 的直接 ref 但仍然是引用得到的，那是「歸併」不是「拆散」。
 * 只有**整條路都走不到**的部件，才是真的被畫成筆劃。
 *
 * 用法: bun run tools/report-inline-components.ts [--lib out/lib-cjk-all.bin.gz] [--top 40]
 */
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { indexOfCodePoint, codePointOf, isPlainIdeograph, displayName } from "./lib-format.ts";
import type { Library } from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = Bun.argv.slice(2);
const ti = argv.indexOf("--top");
const TOP = ti >= 0 ? Number(argv[ti + 1]) : 40;

const { lib: L } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
const NAMES = L.gwiki;
const db = new Database(resolve(ROOT, "db/glyphwiki.db"), { readonly: true });

/* ---- IDS 直接部件（跳過自我引用；跟字庫 v3 的部件區段同一套規則） ---- */
const idsDirect = new Map<number, number[]>();
for (const r of db.query(
  "SELECT codepoint AS cp, comp_cp AS c FROM ids_comp " +
  "WHERE kind='char' AND comp_cp IS NOT NULL AND comp_cp <> codepoint AND comp_cp >= 0x2E80 ORDER BY codepoint, pos",
).all() as { cp: number; c: number }[]) {
  const a = idsDirect.get(r.cp);
  if (a) a.push(r.c); else idsDirect.set(r.cp, [r.c]);
}

/* ---- KAGE 可達（只用引用樹） ---- */
const kageReach = new Map<number, Set<number>>();
const perGlyph = new Map<number, Set<number>>();     // 碼位 → 那個碼位所有字形的可達聯集
{
  const memo = new Map<number, Set<number>>();
  function reach(i: number): Set<number> {
    const hit = memo.get(i);
    if (hit) return hit;
    const out = new Set<number>();
    memo.set(i, out);                                 // 先放進去，斷環
    for (const s of L.glyphs[i]!.strokes) {
      if (s.kind !== 99 || s.ref === null) continue;
      const c = codePointOf(L, s.ref);
      if (c != null) out.add(c);
      for (const x of reach(s.ref)) out.add(x);
    }
    return out;
  }
  for (let i = 0; i < L.glyphs.length; i++) {
    if (!isPlainIdeograph(L, i)) continue;
    const cp = codePointOf(L, i);
    if (cp == null) continue;
    const r = reach(i);
    perGlyph.set(i, r);
    const u = kageReach.get(cp);
    if (u) for (const x of r) u.add(x); else kageReach.set(cp, new Set(r));
  }
}

/* ---- 部首形 ↔ 本字的等價表 ----
   困擾點：IDS 說組件是「竹」(U+7AF9)，GlyphWiki 卻引用 `u25ad7-03`
   ——U+25AD7「𥫗」在 `ids` 表裡的 seq 就是「竹」（atomic=1、seq ≠ 自己），
   也就是「部首形」。這種是**有引用**，只是換了碼位，不是被拆成筆劃。
   所以兩邊都先正規化到本字再比。 */
const canon = new Map<number, number>();
for (const r of db.query("SELECT codepoint, ch, seq, n_op, n_comp FROM ids WHERE n_op=0 AND n_comp=1").all() as
  { codepoint: number; ch: string; seq: string; n_op: number; n_comp: number }[]) {
  const pts = Array.from(r.seq);
  if (pts.length !== 1) continue;                     // 只有單一字的才算等價
  const c = pts[0]!.codePointAt(0);
  if (c === undefined || c === r.codepoint) continue; // 自己等於自己不算
  canon.set(r.codepoint, c);
}
const canonOf = (cp: number) => canon.get(cp) ?? cp;
console.log(`部首形等價：${canon.size.toLocaleString()} 個碼位`);

/* ---- 筆劃數（非 99 的線段算 1，kind 0 不算；跟瀏覽器同一套） ---- */
const strokeMemo = new Map<number, number>();
function strokes(i: number): number {
  const hit = strokeMemo.get(i);
  if (hit !== undefined) return hit;
  let n = 0;
  for (const s of L.glyphs[i]!.strokes) {
    if (s.kind === 99 && s.ref !== null) n += strokes(s.ref);
    else if (s.kind !== 0) n += 1;
  }
  strokeMemo.set(i, n);
  return n;
}

/* ---- 掃描 ---- */
type Info = {
  cp: number; ch: string; name: string;
  inlined: number[];
  kageRefs: number;          // KAGE 直接 ref 數
  rawStrokes: number;        // 這個字自己畫了幾筆
  fullInline: boolean;       // KAGE 完全沒有 ref
};
const rows: Info[] = [];
let droppedCanon = 0, droppedStrokes = 0;
for (let i = 0; i < L.glyphs.length; i++) {
  if (!isPlainIdeograph(L, i)) continue;
  const cp = codePointOf(L, i);
  if (cp == null) continue;
  const ids = idsDirect.get(cp);
  if (!ids || !ids.length) continue;
  const k = new Set<number>();
  for (const c of kageReach.get(cp) ?? []) k.add(canonOf(c));
  const miss: number[] = [];
  for (const c of new Set(ids)) {
    if (k.has(canonOf(c))) { droppedCanon++; continue; }
    miss.push(c);
  }
  if (!miss.length) continue;
  /* 筆劃數的常識檢查：自己畫的筆數要**至少涵蓋所有被內嵌部件的總和**，
     否則那些部件不可能真的被拆成筆劃。（用總和不是逐一比，比較嚴。） */
  const need = miss.reduce((a, c) => {
    const ci = indexOfCodePoint(L, c);
    return a + (ci !== undefined ? strokes(ci) : 1);
  }, 0);
  let nref = 0, mine = 0;
  for (const s of L.glyphs[i]!.strokes) { if (s.kind === 99 && s.ref !== null) nref++; else if (s.kind !== 0) mine++; }
  if (mine < need) { droppedStrokes++; continue; }
  rows.push({ cp, ch: String.fromCodePoint(cp), name: NAMES ? (NAMES[i] ?? "?") : "?", inlined: miss, kageRefs: nref, rawStrokes: mine, fullInline: nref === 0 });
}
console.log(`過濾掉：部首形等價 ${droppedCanon.toLocaleString()}、筆劃數不可能 ${droppedStrokes.toLocaleString()}`);

/* 同一個碼位可能有多個字形，去重 */
const byCp = new Map<number, Info>();
for (const r of rows) if (!byCp.has(r.cp)) byCp.set(r.cp, r);
const uniq = [...byCp.values()];

/* ---- 統計（按部件的筆劃數分級：一筆畫的其實就是筆劃，不是「被拆的部件」） ---- */
type Comp = { cp: number; ch: string; strokes: number; n: number; ex: Info[] };
const perComp = new Map<number, Comp>();
for (const r of uniq) {
  for (const c of r.inlined) {
    const ci = indexOfCodePoint(L, c);
    const ns = ci !== undefined ? strokes(ci) : 0;
    const e = perComp.get(c);
    if (e) { e.n++; if (e.ex.length < 60) e.ex.push(r); }
    else perComp.set(c, { cp: c, ch: String.fromCodePoint(c), strokes: ns, n: 1, ex: [r] });
  }
}

const full = uniq.filter((r) => r.fullInline);
const partial = uniq.filter((r) => !r.fullInline);
const totalEdges = [...perComp.values()].reduce((a, e) => a + e.n, 0);
const rank = [...perComp.values()].sort((a, b) => b.strokes - a.strokes || b.n - a.n);

console.log("\n=== 概況 ===");
console.log(`  有 IDS 分解又有碼位的字：${idsDirect.size.toLocaleString()}`);
console.log(`  部件被真內嵌的字：${uniq.length.toLocaleString()}`);
console.log(`     KAGE 完全沒有 ref（整顆都拆，像林）：${full.length.toLocaleString()}`);
console.log(`     還有別的 ref，但某些部件被拆（像杏）：${partial.length.toLocaleString()}`);
console.log(`  被內嵌的部件種類：${perComp.size.toLocaleString()}　內嵌邊數：${totalEdges.toLocaleString()}`);

function table(title: string, list: Comp[], lim: number) {
  console.log(`\n=== ${title} ===`);
  if (!list.length) { console.log("  （無）"); return; }
  console.log("  部件  筆畫   次數   例子");
  for (const e of list.slice(0, lim)) {
    console.log(`  ${e.ch.padEnd(4)} ${String(e.strokes).padStart(4)} ${String(e.n).padStart(6)}   ` +
      e.ex.slice(0, 12).map((r) => r.ch).join(" "));
  }
  if (list.length > lim) console.log(`  …還有 ${(list.length - lim).toLocaleString()} 種部件`);
}
const multi = rank.filter((e) => e.strokes >= 3);
const few = rank.filter((e) => e.strokes === 2);
const one = rank.filter((e) => e.strokes <= 1);
console.log("\n  其中 ≥3 畫的部件：" + multi.length.toLocaleString() + " 種、" +
  multi.reduce((a, e) => a + e.n, 0).toLocaleString() + " 條邊（" +
  new Set(multi.flatMap((e) => e.ex.map((r) => r.ch))).size.toLocaleString() + " 個字）");
table("多筆畫部件（≥3 畫）被拆成筆劃——這就是「杏的木」那一類", multi, TOP);
table("兩畫部件被拆", few, Math.min(TOP, 25));
table("單筆畫「部件」（其實就是筆劃本身，僅供參考）", one, Math.min(TOP, 15));

console.log("\n=== 整顆被拆的字（KAGE 0 個 ref，前 40）===");
console.log("  " + full.slice(0, 40).map((r) => r.ch).join(" "));
console.log(`  …共 ${full.length.toLocaleString()} 個`);

/* ---- 輸出 ---- */
const tsv: string[] = ["character\tcodepoint\tglyphwiki_name\tkage_refs/raw_strokes\tinlined_components\tinlined_codepoints"];
for (const r of uniq.slice().sort((a, b) => a.cp - b.cp)) {
  tsv.push([r.ch, "U+" + r.cp.toString(16).toUpperCase(), r.name, r.kageRefs + "/" + r.rawStrokes,
    r.inlined.map((c) => String.fromCodePoint(c)).join(""),
    r.inlined.map((c) => "U+" + c.toString(16).toUpperCase()).join(" ")].join("\t"));
}
const tsvPath = resolve(ROOT, "out/inline-components.tsv");
writeFileSync(tsvPath, tsv.join("\n"), "utf8");

const md: string[] = ["# 被拆成原始筆劃的部件（清單）", "",
  "> 產生方式：`bun run tools/report-inline-components.ts`", "",
  "判準：IDS 直接部件 − KAGE 引用可達，再過濾兩種假陽性：", "",
  "1. **部首形等價**：IDS 說「竹」而 GlyphWiki 引用 `u25ad7-03`（𥫗，它在 `ids` 表裡的 seq 就是「竹」）",
  "   ——那是有引用、只是換了碼位，不是被拆。兩邊都先正規化到本字再比。",
  "2. **筆劃數不可能**：自己畫的筆數比部件還少，就不可能把部件拆成筆劃。", "",
  `內嵌邊數 ${totalEdges.toLocaleString()}、涉及 ${uniq.length.toLocaleString()} 個字、` +
  `${perComp.size.toLocaleString()} 種部件（KAGE 完全沒有 ref 的整顆拆：${full.length.toLocaleString()} 個）。`, ""];
for (const [title, list] of [["多筆畫部件（≥3 畫）", multi], ["兩畫部件", few], ["單筆畫（其實就是筆劃）", one]] as [string, Comp[]][]) {
  md.push(`## ${title}`, "", "| 部件 | 筆畫 | 次數 | 例子 |", "| --- | ---: | ---: | --- |");
  for (const e of list) {
    const ex = e.ex.length <= 30 ? e.ex.map((r) => r.ch).join(" ")
      : e.ex.slice(0, 30).map((r) => r.ch).join(" ") + ` …等 ${e.n} 個`;
    md.push(`| ${e.ch} | ${e.strokes} | ${e.n} | ${ex} |`);
  }
  md.push("");
}
const mdPath = resolve(ROOT, "out/inline-components.md");
writeFileSync(mdPath, md.join("\n"), "utf8");
console.log(`\n已寫出 ${tsvPath}（${uniq.length.toLocaleString()} 列）`);
console.log(`已寫出 ${mdPath}（依部件分組，含全部例子）`);
void displayName;
