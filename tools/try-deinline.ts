#!/usr/bin/env bun
/**
 * try-deinline.ts — 把「被畫成原始筆劃的部件」還原成部件引用（原型）。
 *
 * 核心想法：**不要去家族裡找「形狀接近」的異體**。
 * 上一輪實測最佳只有 IoU 70.3%——因為 KAGE 的引用框是非等比映射，
 * 硬套會壓到筆寬。改成：
 *
 *   1. 把那組原始筆劃**原封不動**做成一個新的異體字形（座標不動）
 *   2. 用**恆等框** `[0,0,200,200]` 引用它
 *   3. 渲染結果逐像素相同（因為筆劃的座標跟渲染路徑都沒變）
 *
 * 這樣部件的引用關係就回到**字形繪製資料**裡了，IDS 只是建置期用來
 * 「找出哪些筆劃屬於哪個部件」的鷹架，不必出貨。
 *
 * 分組：用 IDS 的算子（內部輔助資訊）——⿰ 按 x 分左右、⿱ 按 y 分上下。
 *
 * 用法: bun run tools/try-deinline.ts
 */
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { keyOfIdx, toKageData, codePointOf, indexOfCodePoint, displayName } from "./lib-format.ts";
import type { Library, Glyph, Stroke } from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { ensureEngine } from "./compose-fit.ts";
import { rasterize } from "./raster.ts";

const ROOT = resolve(import.meta.dir, "..");
const { lib: L } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();
const IDS_OP: Record<string, string> = {
  "⿰": "lr", "⿱": "tb", "⿲": "lr3", "⿳": "tb3", "⿴": "surround", "⿵": "surround",
  "⿶": "surround", "⿷": "surround", "⿸": "surround", "⿹": "surround", "⿺": "surround", "⿻": "over",
};
const PARENT_KEY = "p";
const VARIANT_KEY = "v";

function rawAndRefs(g: Glyph) {
  const raw: Stroke[] = [], refs: Stroke[] = [];
  for (const s of g.strokes) {
    if (s.kind === 99 && s.ref !== null) refs.push(s);
    else if (s.kind !== 0) raw.push(s);
  }
  return { raw, refs };
}

function strokeCenter(s: Stroke): [number, number] {
  let x = 0, y = 0, n = 0;
  for (let i = 0; i + 1 < s.points.length; i += 2) {
    if (!s.points[i] && !s.points[i + 1]) continue;
    x += s.points[i]!; y += s.points[i + 1]!; n++;
  }
  return n ? [x / n, y / n] : [100, 100];
}

/** 用 IDS 算子把原始筆劃分成 k 組 */
function groupByOp(strokes: Stroke[], op: string, k: number): Stroke[][] {
  if (k <= 1) return [strokes];
  const axis = op === "⿱" || op === "⿳" ? 1 : 0;
  const sorted = strokes.slice().sort((a, b) => strokeCenter(a)[axis] - strokeCenter(b)[axis]);
  const groups: Stroke[][] = Array.from({ length: k }, () => []);
  sorted.forEach((s, i) => groups[Math.min(k - 1, Math.floor(i * k / sorted.length))]!.push(s));
  return groups;
}

function kageOf(entries: [string, Glyph][]): any {
  const kage = new (globalThis as any).Kage();
  for (const [k, g] of entries) kage.kBuhin.push(k, toKageData(g, L));
  return kage;
}

/** 合成用的「借來的索引」：keyOfIdx 只要索引唯一就好，不一定要真的存在。
    借一個超出範圍的索引，就能讓 `toKageData` 把引用指向我們自己塞的異體。 */
const FAKE = L.glyphs.length;

/** 收集「這個字形 ＋ 它引用到的所有字形」＋額外塞進去的合成字形 */
function entriesFor(parentGlyph: Glyph, extra: Map<string, Glyph>): [string, Glyph][] {
  const out = new Map<string, Glyph>(extra);
  out.set(PARENT_KEY, parentGlyph);
  const stack: number[] = [];
  for (const s of parentGlyph.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  const seen = new Set<number>();
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const k = keyOfIdx(L, i);
    if (out.has(k)) continue;
    const g = L.glyphs[i];
    if (!g) continue;                       // 借來的索引沒有真的字形
    out.set(k, g);
    for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  return [...out.entries()];
}

function cov(entries: [string, Glyph][], key: string, size: number): Float32Array {
  return rasterize(kageOf(entries), key, size, 2).cov;
}

/* IDS 直接分量（含算子），直接查 DB 才是「權威」——這正是建置期該做的事 */
import { Database } from "bun:sqlite";
const db = new Database(resolve(ROOT, "db/glyphwiki.db"), { readonly: true });
function idsDirect(cp: number): { op: string | null; comps: number[] } {
  const rows = db.query("SELECT ch, comp_cp, kind FROM ids_comp WHERE codepoint=? ORDER BY pos").all(cp) as
    { ch: string; comp_cp: number | null; kind: string }[];
  if (!rows.length) return { op: null, comps: [] };
  const op = rows.find((r) => r.kind === "op")?.ch ?? null;
  const comps = rows.filter((r) => r.kind === "char" && r.comp_cp != null && r.comp_cp !== cp)
    .map((r) => r.comp_cp!);
  return { op, comps };
}

type Report = { ch: string; cp: number; inlined: string[]; groups: number; same: number };
const reports: Report[] = [];

function repair(cp: number): Report | null {
  const gi = indexOfCodePoint(L, cp);
  if (gi === undefined) return null;
  const g = L.glyphs[gi]!;
  const { raw, refs } = rawAndRefs(g);
  if (!raw.length) return null;
  const { op, comps } = idsDirect(cp);
  if (!comps.length) return null;

  /* 哪些 IDS 部件**沒有**被引用涵蓋（＝被畫成筆劃） */
  const covered = new Set<number>();
  for (const r of refs) {
    const c = codePointOf(L, r.ref!);
    if (c != null) covered.add(c);
  }
  const missing = [...new Set(comps)].filter((c) => !covered.has(c));
  if (!missing.length) return null;

  /* 分組：缺 k 個部件就用算子切 k 組（原型只處理「原始筆劃剛好只屬於缺的部件」的情況） */
  const k = missing.length;
  const totalInlined = comps.length;
  const coveredCount = totalInlined - k;
  void coveredCount;
  /* 只有在「引用涵蓋的部件不佔用原始筆劃」時才安全：
     也就是 (IDS 部件數) == (KAGE 引用數 + 缺的部件數)，且引用數 = 被涵蓋的部件數 */
  const groups = groupByOp(raw, op ?? "⿰", k);

  /* 造新異體：座標原封不動，框用恆等。
     引用指向「借來的索引」FAKE，再把合成字形塞在那個 key 底下。 */
  const variant: Glyph = { ...g, tight: null, strokes: groups.flat() };
  const variantKey = keyOfIdx(L, FAKE);
  const fakeRef = (): Stroke => ({
    kind: 99, width: 0, style: 0, points: [0, 0, 0, 0, 0, 0, 0, 0],
    ref: FAKE, box: [0, 0, 200, 200], stretch: 0,
  });

  const a = cov(entriesFor(g, new Map()), PARENT_KEY, 200);
  const rebuilt: Glyph = { ...g, tight: null, strokes: [...refs, fakeRef()] };
  const b = cov(entriesFor(rebuilt, new Map([[variantKey, variant]])), PARENT_KEY, 200);
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i]! > 0.5, y = b[i]! > 0.5; if (x && y) inter++; if (x || y) uni++; }
  return { ch: String.fromCodePoint(cp), cp, inlined: missing.map((c) => String.fromCodePoint(c)), groups: k, same: uni ? inter / uni : 1 };
}

console.log("=== 還原原型：把筆劃做成新異體 ＋ 恆等框引用 ===");
for (const cp of [0x674F, 0x6797, 0x572D, 0x591A, 0x708E, 0x53E4, 0x5404, 0x540D, 0x51AC, 0x4EAC]) {
  const r = repair(cp);
  if (!r) { console.log(`  ${String.fromCodePoint(cp)}　（沒有可還原的部件，或沒 IDS）`); continue; }
  reports.push(r);
  console.log(`  ${r.ch} U+${r.cp.toString(16).toUpperCase()}　內嵌 ${r.inlined.join("")}　分成 ${r.groups} 組　` +
    `還原後與原版 IoU = ${(r.same * 100).toFixed(1)}%`);
}

/* ---- 出圖：原版 / 還原版的「引用結構」對照 ---- */
{
  const S = 150, GAP = 10;
  const cells: { name: string; entries: [string, Glyph][] }[] = [];
  for (const cp of [0x674F, 0x6797]) {
    const gi = indexOfCodePoint(L, cp)!;
    const g = L.glyphs[gi]!;
    const { raw, refs } = rawAndRefs(g);
    const { op, comps } = idsDirect(cp);
    const covered = new Set<number>();
    for (const r of refs) { const c = codePointOf(L, r.ref!); if (c != null) covered.add(c); }
    const missing = [...new Set(comps)].filter((c) => !covered.has(c));
    const groups = groupByOp(raw, op ?? "⿰", missing.length);
    cells.push({ name: String.fromCodePoint(cp) + " 原版", entries: entriesFor(g, new Map()) });
    const vKey = keyOfIdx(L, FAKE);
    const rb: Glyph = { ...g, tight: null, strokes: [...refs, { kind: 99, width: 0, style: 0, points: [0,0,0,0,0,0,0,0], ref: FAKE, box: [0,0,200,200], stretch: 0 }] };
    cells.push({ name: String.fromCodePoint(cp) + " 還原", entries: entriesFor(rb, new Map([[vKey, { ...g, tight: null, strokes: groups.flat() }]])) });
  }
  const W = GAP + cells.length * (S + GAP), H = GAP + S + GAP;
  const buf = new Uint8Array(W * H).fill(255);
  cells.forEach((c, i) => {
    const cv = cov(c.entries, PARENT_KEY, S);
    const x0 = GAP + i * (S + GAP);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) buf[(y + GAP) * W + x0 + x] = Math.round(255 * (1 - Math.min(1, cv[y * S + x]!)));
    for (let y = 0; y < S; y++) { buf[(y + GAP) * W + x0] = 190; buf[(y + GAP) * W + x0 + S - 1] = 190; }
    for (let x = 0; x < S; x++) { buf[GAP * W + x0 + x] = 190; buf[(GAP + S - 1) * W + x0 + x] = 190; }
  });
  const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]!) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (ty: string, d: Uint8Array) => {
    const o = new Uint8Array(12 + d.length), v = new DataView(o.buffer);
    v.setUint32(0, d.length);
    for (let i = 0; i < 4; i++) o[4 + i] = ty.charCodeAt(i);
    o.set(d, 8); v.setUint32(8 + d.length, crc32(o.subarray(4, 8 + d.length)));
    return o;
  };
  const raw2 = new Uint8Array((W + 1) * H);
  for (let y = 0; y < H; y++) { raw2[y * (W + 1)] = 0; raw2.set(buf.subarray(y * W, (y + 1) * W), y * (W + 1) + 1); }
  const ih = new Uint8Array(13);
  { const v = new DataView(ih.buffer); v.setUint32(0, W); v.setUint32(4, H); ih[8] = 8; }
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih),
    chunk("IDAT", new Uint8Array(deflateSync(raw2, { level: 9 }))), chunk("IEND", new Uint8Array(0))];
  const outb = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let p = 0; for (const q of parts) { outb.set(q, p); p += q.length; }
  writeFileSync(resolve(ROOT, "out/deinline.png"), outb);
  console.log(`\n出圖 out/deinline.png（左：原版／右：還原版，${cells.map((c) => c.name).join("、")}）`);
}
void keyOfIdx; void displayName;
