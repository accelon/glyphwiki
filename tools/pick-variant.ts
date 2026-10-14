// pick-variant.ts — 依槽位形狀，替指定部件選出合適的變體。
import { readFileSync } from "node:fs";
import { decodeLibrary, findGlyphIndex } from "./lib-format.ts";
import { inkIn, inkOfRefInParent } from "./compose-fit.ts";
import type { Library } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(D + "/out/lib-cjk.bin.gz"))));

type Box = { x1: number; y1: number; x2: number; y2: number };
type Cand = { name: string; idx: number; iou: number; fits: boolean; w: number; h: number };

function iouFit(a: Box, b: Box): number {
  const aw = a.x2 - a.x1, ah = a.y2 - a.y1, bw = b.x2 - b.x1, bh = b.y2 - b.y1;
  const s = Math.min(bw / Math.max(1, aw), bh / Math.max(1, ah));
  const w = aw * s, h = ah * s;
  const ox = (b.x1 + b.x2) / 2 - w / 2, oy = (b.y1 + b.y2) / 2 - h / 2;
  const areaA = w * h, areaB = bw * bh;
  const ix = Math.max(0, Math.min(ox + w, b.x2) - Math.max(ox, b.x1));
  const iy = Math.max(0, Math.min(oy + h, b.y2) - Math.max(oy, b.y1));
  return (ix * iy) / (areaA + areaB - ix * iy);
}

function nameScore(n: string): number {
  return (/@/.test(n) ? 2 : 0) + (/-var/.test(n) ? 1 : 0) + n.length * 0.001;
}

/** 替 `ch` 選一個適合 `slot` 的變體：先要求放得進，再取 IoU 最大 */
function pickVariant(ch: string, slot: Box): Cand | null {
  const base = "u" + ch.codePointAt(0)!.toString(16);
  const cands: Cand[] = [];
  for (let i = 0; i < lib.names.length; i++) {
    const n = lib.names[i]!;
    if (n !== base && !n.startsWith(base + "-")) continue;
    const ink = inkIn(lib, i);
    const w = ink.x2 - ink.x1, h = ink.y2 - ink.y1;
    cands.push({
      name: n, idx: i, iou: iouFit(ink, slot),
      fits: w <= (slot.x2 - slot.x1) + 1 && h <= (slot.y2 - slot.y1) + 1,
      w, h,
    });
  }
  if (cands.length === 0) return null;
  const fitting = cands.filter((c) => c.fits);
  const pool = fitting.length > 0 ? fitting : cands;
  pool.sort((a, b) => {
    if (Math.abs(b.iou - a.iou) > 0.02) return b.iou - a.iou;
    return nameScore(a.name) - nameScore(b.name);
  });
  return pool[0]!;
}

if (import.meta.main) {
  const sz = (b: Box) => (b.x2 - b.x1).toFixed(0) + "×" + (b.y2 - b.y1).toFixed(0);
  console.log("=== 依槽位選變體 ===\n");
  const jobs: [string, string][] = [["柱", "木"], ["注", "主"], ["漢", "氵"], ["盟", "月"], ["盟", "皿"]];
  for (const job of jobs) {
    const ch = job[0]!, want = job[1]!;
    const idx = findGlyphIndex(lib, "u" + ch.codePointAt(0)!.toString(16))!;
    const g = lib.glyphs[idx]!;
    for (let i = 0; i < g.strokes.length; i++) {
      const s = g.strokes[i]!;
      if (s.kind !== 99 || s.ref === null) continue;
      const slot = inkOfRefInParent(lib, idx, i);
      const actual = lib.names[s.ref!]!;
      const wantBase = "u" + want.codePointAt(0)!.toString(16);
      const isWant = actual === wantBase || actual.startsWith(wantBase + "-");
      const pick = pickVariant(want, slot);
      if (pick === null) continue;
      console.log(ch + " 槽位 " + sz(slot) + "  指定「" + want + "」");
      console.log("   選出 " + pick.name.padEnd(20) + " IoU " + pick.iou.toFixed(2) +
        "  放得進=" + pick.fits + "  墨跡 " + pick.w.toFixed(0) + "×" + pick.h.toFixed(0));
      if (isWant) {
        const same = actual.replace(/-.*$/, "") === pick.name.replace(/-.*$/, "");
        console.log("   KAGE 實際用 " + actual + "  → " + (same ? "✓ 同族" : "✗ 不同"));
      }
      console.log("");
    }
  }
}
