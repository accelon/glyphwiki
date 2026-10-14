// match-variant2.ts — 用「尺度無關 IoU」選變體：把變體等比放入槽位後的覆蓋率
import { readFileSync } from "node:fs";
import { decodeLibrary, findGlyphIndex } from "./lib-format.ts";
import { inkIn, inkOfRefInParent } from "./compose-fit.ts";
import type { Library, Glyph } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

const size = (b: any) => `${(b.x2 - b.x1).toFixed(0)}×${(b.y2 - b.y1).toFixed(0)}`;

/** 把 a 等比放入 b 後的 IoU（尺度無關） */
function iouFit(a: any, b: any): number {
  const aw = a.x2 - a.x1, ah = a.y2 - a.y1;
  const bw = b.x2 - b.x1, bh = b.y2 - b.y1;
  const s = Math.min(bw / Math.max(1, aw), bh / Math.max(1, ah));
  const w = aw * s, h = ah * s;
  const ox = (b.x1 + b.x2) / 2 - w / 2;
  const oy = (b.y1 + b.y2) / 2 - h / 2;
  const A = w * h;
  const B = bw * bh;
  const inter = Math.max(0, Math.min(ox + w, b.x2) - Math.max(ox, b.x1)) *
                Math.max(0, Math.min(oy + h, b.y2) - Math.max(oy, b.y1));
  return inter / (A + B - inter);
}

/** 某個部件的所有變體（含自身） */
function variantsOf(ch: string) {
  const base = "u" + ch.codePointAt(0)!.toString(16);
  const out: { name: string; idx: number }[] = [];
  lib.names.forEach((n, i) => {
    if (n === base || n.startsWith(base + "-")) out.push({ name: n, idx: i });
  });
  return out;
}

/** 找出「哪個部件」最可能是這個槽位的來源：對每個部件取它的最佳變體分數，勝者為王 */
function bestComponentFor(slot: any, cands: string[]) {
  const results: { ch: string; name: string; score: number }[] = [];
  for (const ch of cands) {
    let best = { name: "", score: -1 };
    for (const v of variantsOf(ch)) {
      const ink = inkIn(lib, v.idx);
      const s = iouFit(ink, slot);
      if (s > best.score) best = { name: v.name, score: s };
    }
    results.push({ ch, name: best.name, score: best.score });
  }
  return results.sort((a, b) => b.score - a.score);
}

console.log("=== 對 柱 / 注 的每個槽位，用 IoU 選部件與變體 ===\n");
for (const ch of ["柱", "注", "漢"]) {
  const idx = findGlyphIndex(lib, "u" + ch.codePointAt(0)!.toString(16))!;
  const g = lib.glyphs[idx]!;
  console.log(`${ch}（${lib.names[idx]}）`);
  g.strokes.forEach((s, i) => {
    if (s.kind !== 99 || s.ref === null) return;
    const slot = inkOfRefInParent(lib, idx, i);
    const actual = lib.names[s.ref!]!;
    // 候選：資料庫的常見部件（這裡先用一組代表字測試）
    const cands = ["木", "水", "氵", "主", "王", "玉", "貝", "皿", "月", "日", "缶", "支"];
    const ranked = bestComponentFor(slot, cands);
    const hit = ranked.findIndex((r) => actual === r.name || actual.startsWith(r.name.replace(/-.*$/, "")) ||
      r.name.startsWith(actual.replace(/-.*$/, "")) );
    console.log(`  槽位 ${size(slot).padStart(9)}  KAGE 實際用 ${actual.padEnd(18)}` +
      `  IoU 首選 ${ranked[0]!.name}（${ranked[0]!.score.toFixed(2)}）` +
      `  ${hit === 0 ? "✓" : hit > 0 ? "△ 第" + (hit + 1) : "✗"}`);
  });
  console.log("");
}

console.log("=== 木 的各變體對 柱 左槽位（72×174）的 IoU ===");
const zhu = findGlyphIndex(lib, "u67f1")!;
const slotZhu = inkOfRefInParent(lib, zhu, 0);
const rows = variantsOf("木").map((v) => ({ n: v.name, s: iouFit(inkIn(lib, v.idx), slotZhu) }))
  .sort((a, b) => b.s - a.s);
for (const r of rows.slice(0, 6)) console.log(`  ${r.n.padEnd(20)} ${r.s.toFixed(3)}`);
void (null as unknown as Glyph);
