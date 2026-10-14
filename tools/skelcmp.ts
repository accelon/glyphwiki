#!/usr/bin/env bun
/**
 * skelcmp.ts — 以「骨架節點位移」比較兩個字形的相似度（不做光柵化）。
 *
 * 用法:
 *   bun run tools/skelcmp.ts <nameA> <nameB> [--size 24]
 *   bun run tools/skelcmp.ts <nameA> --swap 舊部件=新部件 [--only <部件名>]
 *   bun run tools/skelcmp.ts --batch <names.txt> --swap ...   # 批次：逐字替換並統計
 *
 * 為何不用光柵化:
 *   光柵化是先前量測到的唯一瓶頸（每秒百餘字），而「改字框／換部件對字形的影響」
 *   本質是**骨架節點的位移**，可以直接在幾何上算，速度是每秒十餘萬字。
 *
 * 輸出:
 *   * 位移統計（平均／中位／最大，單位：200 空間的格）
 *   * 相似度（容忍門檻內的節點比例，可調）
 *   * 骨架圖（目視節點落在哪）
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DB = resolve(ROOT, "db/glyphwiki.db");

// ---------------------------------------------------------------- 展開（與 raster.ts / Go 版同一套）

export interface Pt {
  x: number;
  y: number;
}

/** 展開成「取樣點序列」：直線取兩端、曲線細分 16 段。
 *  overrides 可覆寫部分字形資料（供 --swap 使用）。
 *  每個點都帶 srcPath（來自哪個子部件），供筆劃重疊檢查區分「同一部件內」與「跨部件」。 */
export function expandPoints(
  db: any,
  rootName: string,
  overrides?: Map<string, string>,
): { pts: (Pt & { src: string })[]; strokes: number; strokeSegs: { src: string; segs: [number, number, number, number][] }[] } {
  const getData = db.query("SELECT data FROM glyphs WHERE name = ?");
  const rawData = (n: string): string | null => {
    const r = getData.get(n) as any;
    return r ? r.data : null;
  };

  const memoData = new Map<string, string | null>();
  const dataOf = (n: string): string | null => {
    if (overrides && overrides.has(n)) return overrides.get(n)!;
    if (!memoData.has(n)) memoData.set(n, rawData(n));
    return memoData.get(n)!;
  };

  const parse = (data: string) => {
    const out: { kind: number; F: number[]; name: string; sx: number; sy: number; sx2: number; sy2: number; partIx: number }[] = [];
    let pi = 0;
    for (const part of data.split("$")) {
      if (!part) continue;
      const c = part.split(":");
      const kind = parseInt(c[0]!, 10);
      if (!Number.isFinite(kind)) continue;
      const F = new Array(11).fill(0);
      for (let i = 1; i <= 10; i++) F[i] = parseInt(c[i] ?? "0", 10) || 0;
      out.push({
        kind, F,
        name: kind === 99 ? (c[7] ?? "") : "",
        sx: parseInt(c[8] ?? "0", 10) || 0,
        sy: parseInt(c[9] ?? "0", 10) || 0,
        sx2: parseInt(c[10] ?? "0", 10) || 0,
        sy2: parseInt(c[11] ?? "0", 10) || 0,
        partIx: pi,
      });
      pi++;
    }
    return out;
  };

  // 展開時為每一筆標上「來源子部件路徑」，供筆劃重疊檢查區分同一部件內／跨部件。
  // 注意：路徑是呼叫端脈絡，所以快取只快取「該字形自己的展開」（路徑為空）。
  const memoExp = new Map<string, any[]>();
  const bounds = (ss: any[]) => {
    let minX = 200, minY = 200, maxX = 0, maxY = 0;
    const upd = (x: number, y: number) => {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    };
    for (const s of ss) {
      if (s.kind === 0) continue;
      upd(s.F[3], s.F[4]); upd(s.F[5], s.F[6]);
      if (s.kind === 1 || s.kind === 99) continue;
      upd(s.F[7], s.F[8]);
      if (s.kind <= 4) continue;
      upd(s.F[9], s.F[10]);
    }
    return [minX, minY, maxX, maxY];
  };
  const stretch = (dp: number, sp: number, p: number, min: number, max: number) => {
    let p1, p2, p3, p4;
    if (p < sp + 100) { p1 = min; p3 = min; p2 = sp + 100; p4 = dp + 100; }
    else { p1 = sp + 100; p3 = dp + 100; p2 = max; p4 = max; }
    return Math.floor(((p - p1) / (p2 - p1)) * (p4 - p3) + p3);
  };

  /** 展開，回傳每一筆（不含路徑） */
  const expandRaw = (name: string, depth = 0): any[] => {
    const hit = memoExp.get(name);
    if (hit) return hit;
    if (depth > 24) return [];
    const d = dataOf(name);
    if (d == null) return [];
    const out: any[] = [];
    for (const s of parse(d)) {
      if (s.kind !== 99) { out.push(s); continue; }
      const sub = expandRaw(s.name, depth + 1);
      if (!sub.length) continue;
      const [minX, minY, maxX, maxY] = bounds(sub);
      let { sx, sy, sx2, sy2 } = s;
      if (sx !== 0 || sy !== 0) { if (sx > 100) sx -= 200; else { sx2 = 0; sy2 = 0; } }
      const [x1, y1, x2, y2] = [s.F[3], s.F[4], s.F[5], s.F[6]];
      for (const t0 of sub) {
        const t = { ...t0, F: t0.F.slice() };
        if (sx !== 0 || sy !== 0) {
          t.F[3] = stretch(sx, sx2, t.F[3], minX, maxX);
          t.F[4] = stretch(sy, sy2, t.F[4], minY, maxY);
          t.F[5] = stretch(sx, sx2, t.F[5], minX, maxX);
          t.F[6] = stretch(sy, sy2, t.F[6], minY, maxY);
          if (t.kind !== 99) {
            t.F[7] = stretch(sx, sx2, t.F[7], minX, maxX);
            t.F[8] = stretch(sy, sy2, t.F[8], minY, maxY);
            t.F[9] = stretch(sx, sx2, t.F[9], minX, maxX);
            t.F[10] = stretch(sy, sy2, t.F[10], minY, maxY);
          }
        }
        const nx = new Array(11).fill(0);
        for (const k of [3, 5, 7, 9]) nx[k] = x1 + (t.F[k] * (x2 - x1)) / 200;
        for (const k of [4, 6, 8, 10]) nx[k] = y1 + (t.F[k] * (y2 - y1)) / 200;
        for (let k = 3; k <= 10; k++) t.F[k] = Math.round(nx[k]);
        out.push(t);
      }
    }
    memoExp.set(name, out);
    return out;
  };

  /** 展開並標上路徑（不快取，因為路徑依呼叫端而異）。
   *  路徑用「該筆在原始 $ 陣列中的索引」，這樣同一層的每個引用才是不同的部件群。 */
  const expand = (name: string, depth = 0, path = ""): any[] => {
    if (depth > 24) return [];
    const d = dataOf(name);
    if (d == null) return [];
    const out: any[] = [];
    for (const s of parse(d)) {
      if (s.kind !== 99) {
        out.push({ ...s, F: s.F.slice(), src: path || "0" });
        continue;
      }
      const myPath = (path ? path + "." : "") + "c" + s.partIx;
      const sub = expand(s.name, depth + 1, myPath);
      if (!sub.length) continue;
      const [minX, minY, maxX, maxY] = bounds(sub);
      let { sx, sy, sx2, sy2 } = s;
      if (sx !== 0 || sy !== 0) { if (sx > 100) sx -= 200; else { sx2 = 0; sy2 = 0; } }
      const [x1, y1, x2, y2] = [s.F[3], s.F[4], s.F[5], s.F[6]];
      for (const t0 of sub) {
        const t = { ...t0, F: t0.F.slice() };
        if (sx !== 0 || sy !== 0) {
          t.F[3] = stretch(sx, sx2, t.F[3], minX, maxX);
          t.F[4] = stretch(sy, sy2, t.F[4], minY, maxY);
          t.F[5] = stretch(sx, sx2, t.F[5], minX, maxX);
          t.F[6] = stretch(sy, sy2, t.F[6], minY, maxY);
          if (t.kind !== 99) {
            t.F[7] = stretch(sx, sx2, t.F[7], minX, maxX);
            t.F[8] = stretch(sy, sy2, t.F[8], minY, maxY);
            t.F[9] = stretch(sx, sx2, t.F[9], minX, maxX);
            t.F[10] = stretch(sy, sy2, t.F[10], minY, maxY);
          }
        }
        const nx = new Array(11).fill(0);
        for (const k of [3, 5, 7, 9]) nx[k] = x1 + (t.F[k] * (x2 - x1)) / 200;
        for (const k of [4, 6, 8, 10]) nx[k] = y1 + (t.F[k] * (y2 - y1)) / 200;
        for (let k = 3; k <= 10; k++) t.F[k] = Math.round(nx[k]);
        out.push(t);
      }
    }
    return out;
  };

  const strokes = expand(rootName);
  const pts: (Pt & { src: string })[] = [];
  const strokeSegs: { src: string; segs: [number, number, number, number][] }[] = [];
  const quad = (p0: Pt, p1: Pt, p2: Pt, src: string) => {
    let px = p0.x, py = p0.y;
    for (let i = 1; i <= 16; i++) {
      const t = i / 16, mt = 1 - t;
      const x = mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x;
      const y = mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y;
      pts.push({ x, y, src }); px = x; py = y;
    }
  };
  const cubic = (p0: Pt, p1: Pt, p2: Pt, p3: Pt, src: string) => {
    let px = p0.x, py = p0.y;
    for (let i = 1; i <= 16; i++) {
      const t = i / 16, mt = 1 - t;
      const x = mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x;
      const y = mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y;
      pts.push({ x, y, src }); px = x; py = y;
    }
  };
  for (const s of strokes) {
    const src = s.src ?? "0";
    const segs: [number, number, number, number][] = [];
    const pushSeg = (x1: number, y1: number, x2: number, y2: number) => segs.push([x1, y1, x2, y2]);
    if (s.kind === 1) {
      pts.push({ x: s.F[3], y: s.F[4], src }, { x: s.F[5], y: s.F[6], src });
      pushSeg(s.F[3], s.F[4], s.F[5], s.F[6]);
    } else if (s.kind === 2 || s.kind === 3 || s.kind === 4) {
      const before = pts.length;
      quad({ x: s.F[3], y: s.F[4] }, { x: s.F[5], y: s.F[6] }, { x: s.F[7], y: s.F[8] }, src);
      const p0 = { x: s.F[3], y: s.F[4] };
      for (let i = before; i < pts.length; i++) {
        const p1 = pts[i]!;
        pushSeg(i === before ? p0.x : pts[i - 1]!.x, i === before ? p0.y : pts[i - 1]!.y, p1.x, p1.y);
      }
    } else if (s.kind === 6) {
      const before = pts.length;
      cubic({ x: s.F[3], y: s.F[4] }, { x: s.F[5], y: s.F[6] }, { x: s.F[7], y: s.F[8] }, { x: s.F[9], y: s.F[10] }, src);
      const p0 = { x: s.F[3], y: s.F[4] };
      for (let i = before; i < pts.length; i++) {
        const p1 = pts[i]!;
        pushSeg(i === before ? p0.x : pts[i - 1]!.x, i === before ? p0.y : pts[i - 1]!.y, p1.x, p1.y);
      }
    } else if (s.kind === 7) {
      pts.push({ x: s.F[3], y: s.F[4], src }, { x: s.F[5], y: s.F[6], src });
      pushSeg(s.F[3], s.F[4], s.F[5], s.F[6]);
      const before = pts.length;
      cubic({ x: s.F[5], y: s.F[6] }, { x: s.F[5], y: s.F[6] }, { x: s.F[7], y: s.F[8] }, { x: s.F[9], y: s.F[10] }, src);
      for (let i = before; i < pts.length; i++) {
        const p1 = pts[i]!;
        pushSeg(i === before ? s.F[5] : pts[i - 1]!.x, i === before ? s.F[6] : pts[i - 1]!.y, p1.x, p1.y);
      }
    }
    strokeSegs.push({ src, segs });
  }
  return { pts, strokes: strokes.length, strokeSegs };
}

// ---------------------------------------------------------------- 筆劃重疊檢查

/** 線段到線段的最短距離 */
export function segSegDist(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const [ax1, ay1, ax2, ay2] = a;
  const [bx1, by1, bx2, by2] = b;
  const dx1 = ax2 - ax1, dy1 = ay2 - ay1;
  const dx2 = bx2 - bx1, dy2 = by2 - by1;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) > 1e-9) {
    const t = ((bx1 - ax1) * dy2 - (by1 - ay1) * dx2) / denom;
    const u = ((bx1 - ax1) * dy1 - (by1 - ay1) * dx1) / denom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0; // 相交
  }
  const pd = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) => {
    const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  };
  return Math.min(
    pd(ax1, ay1, bx1, by1, bx2, by2), pd(ax2, ay2, bx1, by1, bx2, by2),
    pd(bx1, by1, ax1, ay1, ax2, ay2), pd(bx2, by2, ax1, ay1, ax2, ay2),
  );
}

export interface Overlap {
  /** 跨部件的筆劃對數（距離 < 門檻） */
  pairs: number;
  /** 最嚴重的重疊距離（0 = 真的相交） */
  minDist: number;
  /** 參加重疊的相異部件路徑 */
  srcs: string[];
  /** 明細（最多 10 筆） */
  detail: { a: string; b: string; d: number }[];
}

/**
 * 檢查筆劃重疊：只看**不同直接子部件之間**的筆劃（同一部件內的相接是正常的）。
 *
 * 框重疊是常態，不算問題；筆劃真的撞上（距離 < 筆寬量級）才是錯。
 *
 * 分組方式：取路徑的前兩段（例如 盟 = u76df-j 的兩個子部件 →
 * `c0.c0`（明）與 `c0.c1`（皿））。同一直接子部件內的筆劃不互相比較。
 */
export function checkOverlap(
  strokeSegs: { src: string; segs: [number, number, number, number][] }[],
  threshold = 6,
  maxDetail = 10,
): Overlap {
  // 群組 = 前兩段路徑（depth 1 的部件各自獨立）；若路徑不足兩段則用整條
  const groupOf = (src: string) => {
    const seg = src.split(".");
    return seg.length >= 2 ? seg.slice(0, 2).join(".") : src;
  };
  let pairs = 0;
  let minDist = Infinity;
  const srcs = new Set<string>();
  const detail: { a: string; b: string; d: number }[] = [];
  for (let i = 0; i < strokeSegs.length; i++) {
    const A = strokeSegs[i]!;
    for (let j = i + 1; j < strokeSegs.length; j++) {
      const B = strokeSegs[j]!;
      if (groupOf(A.src) === groupOf(B.src)) continue; // 同一部件內，跳過
      let d = Infinity;
      for (const sa of A.segs) {
        for (const sb of B.segs) {
          const dd = segSegDist(sa, sb);
          if (dd < d) d = dd;
          if (d === 0) break;
        }
        if (d === 0) break;
      }
      if (d < threshold) {
        pairs++;
        if (d < minDist) minDist = d;
        srcs.add(groupOf(A.src));
        srcs.add(groupOf(B.src));
        if (detail.length < maxDetail) detail.push({ a: A.src, b: B.src, d });
      }
    }
  }
  return {
    pairs,
    minDist: pairs > 0 ? minDist : Infinity,
    srcs: [...srcs],
    detail: detail.sort((x, y) => x.d - y.d),
  };
}

// ---------------------------------------------------------------- 比對

export interface Cmp {
  n: number;
  meanShift: number;
  medianShift: number;
  maxShift: number;
  centroidShift: number;
  within1: number;
  within2: number;
  within3: number;
  identical: number;
}

/** 以「同一序號的節點」比較位移（適合換部件／改字框這類結構不變的改動） */
export function compareByIndex(a: Pt[], b: Pt[], tol = 1): Cmp {
  const n = Math.min(a.length, b.length);
  const ds: number[] = [];
  for (let i = 0; i < n; i++) ds.push(Math.hypot(a[i]!.x - b[i]!.x, a[i]!.y - b[i]!.y));
  const sorted = [...ds].sort((x, y) => x - y);
  const mean = ds.length ? ds.reduce((s, v) => s + v, 0) / ds.length : 0;
  const cx = (p: Pt[]) => p.reduce((s, q) => s + q.x, 0) / Math.max(1, p.length);
  const cy = (p: Pt[]) => p.reduce((s, q) => s + q.y, 0) / Math.max(1, p.length);
  return {
    n,
    meanShift: mean,
    medianShift: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0,
    maxShift: sorted.length ? sorted[sorted.length - 1]! : 0,
    centroidShift: Math.hypot(cx(a) - cx(b), cy(a) - cy(b)),
    within1: ds.filter((d) => d <= tol).length,
    within2: ds.filter((d) => d <= tol * 2).length,
    within3: ds.filter((d) => d <= tol * 3).length,
    identical: ds.filter((d) => d === 0).length,
  };
}

/** 貪婪最近鄰配對（結構不同時用；O(n·m)） */
export function compareByNearest(a: Pt[], b: Pt[]): Cmp {
  const used = new Uint8Array(b.length);
  const ds: number[] = [];
  for (const p of a) {
    let best = -1, bestD = Infinity;
    for (let j = 0; j < b.length; j++) {
      if (used[j]) continue;
      const d = Math.hypot(p.x - b[j]!.x, p.y - b[j]!.y);
      if (d < bestD) { bestD = d; best = j; }
    }
    if (best >= 0) { used[best] = 1; ds.push(bestD); }
  }
  const sorted = [...ds].sort((x, y) => x - y);
  const mean = ds.length ? ds.reduce((s, v) => s + v, 0) / ds.length : 0;
  const cx = (p: Pt[]) => p.reduce((s, q) => s + q.x, 0) / Math.max(1, p.length);
  const cy = (p: Pt[]) => p.reduce((s, q) => s + q.y, 0) / Math.max(1, p.length);
  return {
    n: ds.length,
    meanShift: mean,
    medianShift: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0,
    maxShift: sorted.length ? sorted[sorted.length - 1]! : 0,
    centroidShift: Math.hypot(cx(a) - cx(b), cy(a) - cy(b)),
    within1: ds.filter((d) => d <= 1).length,
    within2: ds.filter((d) => d <= 2).length,
    within3: ds.filter((d) => d <= 3).length,
    identical: ds.filter((d) => d === 0).length,
  };
}

/** 相似度分數 0..1：位移越小越高（以 200 空間的格為單位，s=10 時位移 10 格約扣一半） */
export function similarity(c: Cmp, scale = 10): number {
  return 1 / (1 + c.meanShift / scale);
}

/** 骨架圖：把點畫在 size×size 的格子裡（A 用 o、B 用 x、重疊用 #） */
export function sketch(a: Pt[], b: Pt[], size = 24): string {
  const g: string[][] = Array.from({ length: size }, () => new Array(size).fill(" "));
  const put = (p: Pt[], ch: string) => {
    for (const q of p) {
      const x = Math.round((q.x / 200) * (size - 1));
      const y = Math.round((q.y / 200) * (size - 1));
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const cur = g[y]![x]!;
      if (cur === " " || cur === ch) g[y]![x] = ch;
      else g[y]![x] = "#";
    }
  };
  put(a, "o");
  put(b, "x");
  return g.map((r) => r.join("")).join("\n");
}

// ---------------------------------------------------------------- CLI

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  let size = 24;
  let swap: string | null = null;
  let only: string | null = null;
  // 預設改用最近鄰配對：不同字的筆劃順序常不同（例：干 的豎筆排在最後），
  // 同序號配對會把「配錯筆」算成巨大位移，失真。
  let mode: "index" | "nearest" = "nearest";
  let overlapThr = 6;
  let showSketch = true;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--size") size = Number(argv[++i]);
    else if (a === "--swap") swap = argv[++i]!;
    else if (a === "--only") only = argv[++i]!;
    else if (a === "--nearest") mode = "nearest";
    else if (a === "--index") mode = "index";
    else if (a === "--overlap") overlapThr = Number(argv[++i]);
    else if (a === "--no-sketch") showSketch = false;
    else positional.push(a);
  }
  if (!existsSync(DB)) { console.error("找不到資料庫"); process.exit(1); }
  const db = new Database(DB, { readonly: true });

  const norm = (s: string) => {
    const m = /^(?:u\+|U\+|u|U)?([0-9a-fA-F]{4,6})$/.exec(s);
    return m && /^(u\+|U\+|u|U)/.test(s) ? "u" + m[1]!.toLowerCase() : s;
  };

  const fmt = (c: any) =>
    `節點 ${c.n}  平均位移 ${c.meanShift.toFixed(2)}  中位 ${c.medianShift.toFixed(2)}  最大 ${c.maxShift.toFixed(2)}` +
    `  重心位移 ${c.centroidShift.toFixed(2)}  完全重合 ${c.identical}` +
    `  (<=1: ${((c.within1 / Math.max(1, c.n)) * 100).toFixed(0)}%  <=2: ${((c.within2 / Math.max(1, c.n)) * 100).toFixed(0)}%)` +
    `  相似度 ${similarity(c).toFixed(3)}`;

  const nameA = norm(positional[0] ?? "");
  if (!nameA) { console.error("usage: skelcmp.ts <nameA> [<nameB> | --swap 舊=新] [--only 部件名] [--size N]"); process.exit(2); }

  const A = expandPoints(db, nameA);
  let nameB = positional[1] ? norm(positional[1]) : nameA;
  let B: ReturnType<typeof expandPoints> = A;
  let label = `A = B = ${nameA}`;

  if (swap) {
    // 在整棵子樹裡找含有 `from` 的那一筆，就地替換（支援子字形）
    const [from, to] = swap.split("=");
    const getData = db.query("SELECT data FROM glyphs WHERE name = ?");
    const memo = new Map<string, string | null>();
    const dataOf = (n: string): string | null => {
      if (!memo.has(n)) {
        const r = getData.get(n) as any;
        memo.set(n, r ? (r.data as string) : null);
      }
      return memo.get(n)!;
    };
    const overrides = new Map<string, string>();
    let changedAt: string | null = null;
    const rewrite = (n: string, seen: Set<string>): string | null => {
      if (overrides.has(n)) return overrides.get(n)!;
      const d = dataOf(n);
      if (d == null || seen.has(n)) return d;
      if (d.includes(from!)) {
        const nd = d.replaceAll(from!, to!);
        overrides.set(n, nd);
        changedAt = n;
        return nd;
      }
      const s2 = new Set(seen); s2.add(n);
      for (const part of d.split("$")) {
        const c = part.split(":");
        if (parseInt(c[0]!, 10) !== 99 || !c[7]) continue;
        const child = c[7]!;
        if (rewrite(child, s2) != null && changedAt) {
          // 子樹有改動 → 這一層不必改，但保留下探結果
          return d;
        }
      }
      return d;
    };
    rewrite(nameA, new Set());
    if (!changedAt) {
      console.error(`在 ${nameA} 的子樹中找不到 ${from}`);
      process.exit(1);
    }
    B = expandPointsWithOverride(db, nameA, overrides);
    label = `A = ${nameA}     B = ${nameA} 但 ${from} → ${to}（改動於 ${changedAt}）`;
  } else if (positional[1]) {
    B = expandPoints(db, nameB);
    label = `A = ${nameA}     B = ${nameB}`;
  }

  const cmp = mode === "nearest" ? compareByNearest(A.pts, B.pts) : compareByIndex(A.pts, B.pts);
  console.log(label);
  console.log(`筆數 A=${A.strokes} B=${B.strokes}   取樣點 A=${A.pts.length} B=${B.pts.length}   配對方式=${mode}`);
  console.log(fmt(cmp));

  // 筆劃重疊：A 與 B 各檢查一次（框重疊是常態，筆劃撞上才是錯）
  const ovA = checkOverlap(A.strokeSegs, overlapThr);
  const ovB = checkOverlap(B.strokeSegs, overlapThr);
  const ovLine = (tag: string, o: Overlap) =>
    o.pairs === 0
      ? `  ${tag}: 無跨部件筆劃重疊`
      : `  ${tag}: ${o.pairs} 對筆劃過近，最近 ${o.minDist.toFixed(2)}（門檻 ${overlapThr}），涉及部件 ${o.srcs.length} 個`;
  console.log("\n筆劃重疊檢查（只算跨部件）:");
  console.log(ovLine("A", ovA));
  console.log(ovLine("B", ovB));
  for (const d of ovB.detail.slice(0, 6)) {
    console.log(`     B: ${d.a} ↔ ${d.b}   距離 ${d.d.toFixed(2)}`);
  }

  if (showSketch) {
    console.log("\n骨架圖（o = A, x = B, # = 重疊）:");
    console.log(sketch(A.pts, B.pts, size));
  }
  db.close();
}

/** 同 expandPoints，但可覆寫部分字形的資料（供 --swap 使用） */
export function expandPointsWithOverride(
  db: any,
  rootName: string,
  overrides: Map<string, string>,
): ReturnType<typeof expandPoints> {
  const getData = db.query("SELECT data FROM glyphs WHERE name = ?");
  const memoData = new Map<string, string | null>();
  const dataOf = (n: string): string | null => {
    if (overrides.has(n)) return overrides.get(n)!;
    if (!memoData.has(n)) {
      const r = getData.get(n) as any;
      memoData.set(n, r ? r.data : null);
    }
    return memoData.get(n)!;
  };
  // 借用 expandPoints 的內部邏輯：以 Proxy db 物件攔截查詢
  const fakeDb = {
    query: (sql: string) => ({
      get: (n: string) => {
        const d = dataOf(n);
        return d == null ? undefined : { data: d };
      },
    }),
  };
  return expandPoints(fakeDb, rootName);
}
