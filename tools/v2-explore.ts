// v2-explore.ts — V2 最小實驗：把提案的例子餵進 composeFit，判定語意與美觀。
//
// 背景：`format.md` 的「進階任務 2」給了本專案的構形序列定義：
//   峰夆電雨水 ＝ 峰 中的「夆」替換為「電雨水」，而「電雨水」＝ 電 上方的「雨」改為「水」
// 也就是**遞歸**：第 2 個字是「舊部件」的名字，第 3 個字起是「新內容」，
// 而「新內容」本身又可以是一個構形序列（或一串原始部件）。
//
// 用法: bun run tools/v2-explore.ts
import { readFileSync } from "node:fs";
import { decodeLibrary, findGlyphIndex } from "./lib-format.ts";
import type { Library, Glyph, Stroke } from "./lib-format.ts";
import { composeFit, inkIn, findSlot, svgOf, normalizeSvg } from "./compose-fit.ts";
import { minCrossDistOf } from "./stroke-overlap.ts";

const D = "D:/2023/glyphwiki";
const lib: Library = decodeLibrary(
  new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))),
);
const ch = (c: string) => "u" + c.codePointAt(0)!.toString(16);
const nm = (i: number | undefined) => (i === undefined ? "(無)" : lib.names[i]!);

// ---------------------------------------------------------------- 完整引用樹

function tree(idx: number, depth = 0, seen: Set<number> = new Set()): void {
  const g = lib.glyphs[idx]!;
  const refs = g.strokes.filter((s) => s.kind === 99 && s.ref !== null);
  const mark = seen.has(idx) ? "（循環）" : "";
  console.log("  ".repeat(depth) + `${lib.names[idx]}  緊框[${g.tight!.join(",")}]  引用${refs.length}${mark}`);
  if (seen.has(idx)) return;
  const next = new Set(seen);
  next.add(idx);
  for (const s of refs) {
    console.log("  ".repeat(depth + 1) + `框[${s.box!.join(",")}] ↓`);
    tree(s.ref!, depth + 2, next);
  }
}

console.log("=== 1. 引用樹（確認「街 含 行 含 彳」與「街 含 圭」）===");
for (const c of ["街", "峰"]) {
  console.log(`-- ${c} (${nm(findGlyphIndex(lib, ch(c)))})`);
  tree(findGlyphIndex(lib, ch(c))!);
}

// ---------------------------------------------------------------- 構形序列求值

/** 把新內容（可能是序列）解析成「可直接代入單一槽位的字形索引」 */
function resolveNew(L: Library, expr: string, depth = 0): { idx: number; lib: Library; log: string[] } | { error: string } {
  const chars = Array.from(expr);
  if (chars.length === 0) return { error: "新內容為空" };
  if (chars.length === 1) {
    const i = findGlyphIndex(L, ch(chars[0]!));
    if (i === undefined) return { error: `部件「${chars[0]}」不在字形庫中` };
    return { idx: i, lib: L, log: [] };
  }
  // 多字：先試「基字 舊 新…」遞歸，不成再當「一串原始部件」
  const r = evalSeq(L, expr, depth + 1);
  if ("error" in r) {
    // 多個原始部件（如 彳舞亍）→ 橫向並排的字形
    return buildRow(L, chars);
  }
  return { idx: r.targetIdx, lib: r.lib, log: r.log };
}

/** 「串接部件」：把 n 個原始部件橫向等分排進 200×200（各佔 1/n 寬、滿高） */
function buildRow(L: Library, chars: string[]): { idx: number; lib: Library; log: string[] } | { error: string } {
  const names = L.names.slice();
  const glyphs: Glyph[] = L.glyphs.map((g) => ({ tight: g.tight, strokes: g.strokes }));
  const cur: Library = { names, suffix: L.suffix, glyphs };
  const idxs: number[] = [];
  for (const c of chars) {
    const i = findGlyphIndex(cur, ch(c));
    if (i === undefined) return { error: `部件「${c}」不在字形庫中` };
    idxs.push(i);
  }
  const w = 200 / idxs.length;
  const strokes: Stroke[] = idxs.map((i, k) => ({
    kind: 99, width: 0, style: 0, points: [0, 0, 0, 0],
    ref: i,
    box: [Math.round(k * w), 0, Math.round((k + 1) * w), 200],
    stretch: [0, 0, 0, 0],
  }));
  // 新增一個字形，插在庫尾
  const newIdx = names.length;
  names.push("__row" + newIdx);
  glyphs.push({ tight: [0, 0, 200, 200], strokes });
  cur.names = names;
  return { idx: newIdx, lib: cur, log: [`串接 ${chars.join("")}（橫向 ${idxs.length} 等分）`] };
}

/** 求值一個構形序列：base + 舊 + 新…（遞歸） */
function evalSeq(L: Library, expr: string, depth = 0): { lib: Library; targetIdx: number; log: string[] } | { error: string } {
  if (depth > 6) return { error: "遞歸過深" };
  const chars = Array.from(expr);
  if (chars.length === 1) {
    const i = findGlyphIndex(L, ch(chars[0]!));
    if (i === undefined) return { error: `字「${chars[0]}」不在字形庫中` };
    return { lib: L, targetIdx: i, log: [] };
  }
  const base = chars[0]!;
  const old = chars[1]!;
  const newExpr = chars.slice(2).join("");
  const ni = resolveNew(L, newExpr, depth);
  if ("error" in ni) return { error: `${newExpr}：${ni.error}` };
  // composeFit 吃的是「舊部件字元、新部件字元」；新內容若是自訂字形（串接或巢狀結果）
  // 就沒有字元可用，所以這裡直接取用舊槽位的框與伸縮，把 ref 指到新內容的索引。
  const bi = findGlyphIndex(ni.lib, ch(base));
  if (bi === undefined) return { error: `基字「${base}」不在字形庫中` };
  const slot = findSlot(ni.lib, bi, ch(old));
  if (!slot) return { error: `基字「${base}」的結構中找不到部件「${old}」` };
  const strokes = ni.lib.glyphs[slot.parent]!.strokes.slice();
  const oldStroke = strokes[slot.strokeIx]!;
  strokes[slot.strokeIx] = { ...oldStroke, ref: ni.idx };
  const glyphs = ni.lib.glyphs.slice();
  glyphs[slot.parent] = { tight: ni.lib.glyphs[slot.parent]!.tight, strokes };
  const out: Library = { names: ni.lib.names, suffix: ni.lib.suffix, glyphs };
  return {
    lib: out, targetIdx: bi,
    log: [...ni.log, `${base} 的 ${old} → ${newExpr}`],
  };
}

// ---------------------------------------------------------------- 逐例輸出

interface Row { label: string; note: string; svg: string | null; dist: number | null | undefined; }
const rows: Row[] = [];
const fmtD = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : !Number.isFinite(v) ? "無" : v.toFixed(1);

function run(label: string, expr: string, note: string): void {
  const r = evalSeq(lib, expr);
  if ("error" in r) {
    console.log(`✗ ${label}（${expr}）: ${r.error}`);
    rows.push({ label, note: note + " ✗" + r.error, svg: null, dist: null });
    return;
  }
  const bi = findGlyphIndex(lib, ch(Array.from(expr)[0]!));
  const before = bi !== undefined ? inkIn(lib, bi) : null;
  const after = inkIn(r.lib, r.targetIdx);
  const d = minCrossDistOf(r.lib, r.targetIdx);
  const base0 = bi !== undefined ? minCrossDistOf(lib, bi) : Infinity;
  const f = (b: { x1: number; y1: number; x2: number; y2: number }) => [b.x1, b.y1, b.x2, b.y2].map(Math.round).join(",");
  console.log(`✓ ${label}（${expr}）`);
  console.log(`    ${r.log.join("；")}`);
  console.log(`    原字[${before ? f(before) : "?"}] → 結果[${f(after)}]  跨部件最短距離 ${fmtD(d)}（原字 ${fmtD(base0)}）`);
  rows.push({ label, note, svg: svgOf(r.lib, r.targetIdx), dist: d });
}

console.log("\n=== 2. 候選語意（遞歸讀法）===");
run("街圭舞", "街圭舞", "街 的 圭 → 舞");
run("街行彳", "街行彳", "街 的 行 → 彳");
run("街行舞", "街行舞", "街 的 行 → 舞");
run("街行彳舞亍", "街行彳舞亍", "行 → 串接(彳舞亍)");
run("彳舞亍", "彳舞亍", "直接三件 → 串接");
run("寶缶支", "寶缶支", "對照組（已知良好）");
run("峰夆電雨水", "峰夆電雨水", "巢狀：夆 →（電 的 雨 → 水）");
run("峰夆水", "峰夆水", "單層對照");
run("邏羅寶貝", "邏羅寶貝", "邏 的 羅 → 貝（對照 4 字例）");

// ---------------------------------------------------------------- 出圖

const S = 240, TOP = 20;
let x = 0;
const cells: string[] = [];
for (const r of rows) {
  const cx = x + S / 2;
  if (r.svg) {
    const inner = r.svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "");
    cells.push(`<g transform="translate(${x + 20},${TOP}) scale(1)">${inner}</g>`);
  } else {
    cells.push(`<text x="${cx}" y="${TOP + S / 2}" text-anchor="middle" font-size="44" fill="#c00">✗</text>`);
  }
  cells.push(`<text x="${cx}" y="${TOP + S + 26}" text-anchor="middle" font-size="17" fill="#111" font-family="sans-serif">${r.label}</text>`);
  cells.push(`<text x="${cx}" y="${TOP + S + 48}" text-anchor="middle" font-size="13" fill="#666" font-family="sans-serif">${r.note}</text>`);
  cells.push(`<text x="${cx}" y="${TOP + S + 68}" text-anchor="middle" font-size="13" fill="${r.d !== null && r.d < 2 ? "#c00" : "#060"}" font-family="sans-serif">跨部件距離 ${fmtD(r.d)}</text>`);
  // 每格 240 寬，字形本身 200 → 置中
  x += S;
}
const W = x, H = TOP + S + 84;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#fff"/><g fill="#111">${cells.join("")}</g></svg>`;
Bun.write(`${D}/out/v2-explore.svg`, svg);
console.log(`\n已寫出 out/v2-explore.svg（${W}×${H}）`);
