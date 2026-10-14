#!/usr/bin/env bun
/**
 * boxexp.ts — 框調整實驗台：評估「改變部件框」對全庫字形的影響。
 *
 * 用法:
 *   bun run tools/boxexp.ts --limit 2000                 # 比較「現況」與「規範槽位」
 *   bun run tools/boxexp.ts --mode uniform --limit 2000  # 只改框大小（等比縮放內容）
 *   bun run tools/boxexp.ts --verbose u76df              # 看單字的逐部件明細
 *
 * 為什麼要這個工具:
 *   「部件不留白、每個字都能當基字」需要改框。但改框會移動該部件的所有筆劃，
 *   所以必須先量出「影響多少字、平均位移多少、有沒有造成新的筆劃重疊」，
 *   而不是憑感覺調。
 *
 * 兩種方案:
 *   current  : 維持 KAGE 給的框（只做框大小正規化，等比縮放內容 → 失敗會變形）
 *   slot     : 用 IDS 算子推導的規範槽位（⿰ 左右各半、⿱ 上下各半、⿲⿳ 各三分之一…）
 *
 * 關鍵保證（避免「兩邊都放大就重疊」）:
 *   規範槽位採**等比縮放 + 置中**，不是各自拉滿，
 *   所以在同一組槽位內不可能產生新的重疊。
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkOverlap, expandPoints, segSegDist } from "./skelcmp.ts";

const ROOT = resolve(import.meta.dir, "..");
const DB = resolve(ROOT, "db/glyphwiki.db");

type Box = { x1: number; y1: number; x2: number; y2: number };
type Pt2 = { x: number; y: number; src: string };

/** 算子 → 各槽位的正規化矩形（0..1，相對 200 空間） */
export function slotsOf(op: string): Box[] {
  switch (op) {
    case "⿰": return [ // 左右
      { x1: 0, y1: 0, x2: 100, y2: 200 },
      { x1: 100, y1: 0, x2: 200, y2: 200 },
    ];
    case "⿱": return [ // 上下
      { x1: 0, y1: 0, x2: 200, y2: 100 },
      { x1: 0, y1: 100, x2: 200, y2: 200 },
    ];
    case "⿲": return [ // 左中右
      { x1: 0, y1: 0, x2: 66.67, y2: 200 },
      { x1: 66.67, y1: 0, x2: 133.33, y2: 200 },
      { x1: 133.33, y1: 0, x2: 200, y2: 200 },
    ];
    case "⿳": return [ // 上中下
      { x1: 0, y1: 0, x2: 200, y2: 66.67 },
      { x1: 0, y1: 66.67, x2: 200, y2: 133.33 },
      { x1: 0, y1: 133.33, x2: 200, y2: 200 },
    ];
    case "⿴": return [ // 全包圍：外框佔滿，內件置中 60%
      { x1: 0, y1: 0, x2: 200, y2: 200 },
      { x1: 40, y1: 40, x2: 160, y2: 160 },
    ];
    case "⿵": return [ // 上三包
      { x1: 0, y1: 0, x2: 200, y2: 200 },
      { x1: 25, y1: 70, x2: 175, y2: 190 },
    ];
    case "⿶": return [ // 下三包
      { x1: 0, y1: 0, x2: 200, y2: 200 },
      { x1: 25, y1: 10, x2: 175, y2: 130 },
    ];
    case "⿷": return [ // 左三包
      { x1: 0, y1: 0, x2: 200, y2: 200 },
      { x1: 70, y1: 25, x2: 190, y2: 175 },
    ];
    case "⿸": return [ // 左上包
      { x1: 0, y1: 0, x2: 200, y2: 200 },
      { x1: 40, y1: 55, x2: 180, y2: 190 },
    ];
    case "⿹": return [ // 右上包
      { x1: 0, y1: 0, x2: 200, y2: 200 },
      { x1: 20, y1: 55, x2: 160, y2: 190 },
    ];
    case "⿺": return [ // 左下包
      { x1: 0, y1: 0, x2: 200, y2: 200 },
      { x1: 35, y1: 20, x2: 175, y2: 160 },
    ];
    case "⿻": return [ // 疊加
      { x1: 0, y1: 0, x2: 200, y2: 200 },
      { x1: 0, y1: 0, x2: 200, y2: 200 },
    ];
    default:
      return [];
  }
}

function tightBox(pts: Pt2[]): Box | null {
  if (pts.length === 0) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of pts) {
    if (p.x < x1) x1 = p.x;
    if (p.x > x2) x2 = p.x;
    if (p.y < y1) y1 = p.y;
    if (p.y > y2) y2 = p.y;
  }
  return { x1, y1, x2, y2 };
}

/** 對一組點做「從 oldBox 映射到 newBox」的仿射變換 */
function remapPt(p: Pt2, oldBox: Box, newBox: Box): Pt2 {
  const sx = (newBox.x2 - newBox.x1) / Math.max(1e-6, oldBox.x2 - oldBox.x1);
  const sy = (newBox.y2 - newBox.y1) / Math.max(1e-6, oldBox.y2 - oldBox.y1);
  return {
    x: newBox.x1 + (p.x - oldBox.x1) * sx,
    y: newBox.y1 + (p.y - oldBox.y1) * sy,
    src: p.src,
  };
}

/** 等比縮放並置中：把 tight 內容放進 slot（不變形，但可能留白） */
function fitUniform(tight: Box, slot: Box): Box {
  const tw = Math.max(1e-6, tight.x2 - tight.x1);
  const th = Math.max(1e-6, tight.y2 - tight.y1);
  const sw = slot.x2 - slot.x1;
  const sh = slot.y2 - slot.y1;
  const s = Math.min(sw / tw, sh / th);
  const w = tw * s, h = th * s;
  const cx = (slot.x1 + slot.x2) / 2;
  const cy = (slot.y1 + slot.y2) / 2;
  return { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 };
}

/** 拉伸填滿 slot：完全消除留白，但會改變部件比例（變形） */
export function fitStretch(_tight: Box, slot: Box): Box {
  return { ...slot };
}

export interface BoxPlan {
  name: string;
  /** 每個直接子部件的「舊框 → 新框」，鍵是展開路徑前兩段 */
  moves: { group: string; oldBox: Box; newBox: Box }[];
}

/** 依 IDS 算子建立框調整計畫；回傳 null 表示該字不適用 */
export function planFor(
  db: any,
  cp: number,
  exp: ReturnType<typeof expandPoints>,
  mode: "uniform" | "stretch" | "slot" | "slot-tight",
): BoxPlan | null {
  const ids = db.query("SELECT outer_op, seq FROM ids WHERE codepoint = ?").get(cp) as any;
  if (!ids || !ids.outer_op) return null;
  const slots = slotsOf(ids.outer_op);
  if (slots.length === 0) return null;

  // 直接子部件群組：取路徑前兩段（與 checkOverlap 的分組一致）
  const groups = new Map<string, Pt2[]>();
  for (const p of exp.pts) {
    const seg = p.src.split(".");
    const g = seg.length >= 2 ? seg.slice(0, 2).join(".") : p.src;
    const arr = groups.get(g);
    if (arr) arr.push(p);
    else groups.set(g, [p]);
  }
  // 用「路徑第二段索引」排序，對應 IDS 分量的順序（路徑不足兩段者排最後）
  const keyIx = (k: string) => {
    const seg = k.split(".");
    if (seg.length < 2) return Number.MAX_SAFE_INTEGER;
    const m = /^c(\d+)$/.exec(seg[1]!);
    return m ? parseInt(m[1]!, 10) : Number.MAX_SAFE_INTEGER;
  };
  const keys = [...groups.keys()].sort((a, b) => keyIx(a) - keyIx(b));
  if (keys.length < 2) return null;

  const moves: BoxPlan["moves"] = [];
  for (let i = 0; i < Math.min(keys.length, slots.length); i++) {
    const g = keys[i]!;
    const pts = groups.get(g)!;
    const tight = tightBox(pts);
    if (!tight) continue;
    const slot = slots[i]!;
    if (mode === "uniform" || mode === "stretch") {
      moves.push({ group: g, oldBox: tight, newBox: mode === "stretch" ? fitStretch(tight, slot) : fitUniform(tight, slot) });
    } else if (mode === "slot") {
      // 用 IDS 分量在原字中的框（來自 KAGE）當舊框，否則退回收緊框
      const kage = db
        .query(
          `SELECT p1x,p1y,p2x,p2y FROM parts WHERE glyph = ? AND kind = 99 ORDER BY idx`,
        )
        .all(`u${cp.toString(16)}`) as any[];
      const box = kage[i];
      const oldBox =
        box && (box.p2x - box.p1x) > 0 && (box.p2y - box.p1y) > 0
          ? { x1: box.p1x, y1: box.p1y, x2: box.p2x, y2: box.p2y }
          : tight;
      moves.push({ group: g, oldBox, newBox: slot });
    } else {
      // slot-tight：把緊框等比放進槽位（與 uniform 相同，但語意清楚）
      moves.push({ group: g, oldBox: tight, newBox: fitUniform(tight, slot) });
    }
  }
  return moves.length >= 2 ? { name: `u${cp.toString(16)}`, moves } : null;
}

/** 套用計畫：回傳新的一組點 */
export function applyPlan(exp: ReturnType<typeof expandPoints>, plan: BoxPlan): Pt2[] {
  const map = new Map(plan.moves.map((m) => [m.group, m] as const));
  return exp.pts.map((p) => {
    const seg = p.src.split(".");
    const g = seg.length >= 2 ? seg.slice(0, 2).join(".") : p.src;
    const mv = map.get(g);
    if (!mv) return p;
    return remapPt(p, mv.oldBox, mv.newBox);
  });
}

/** 位移統計（舊點 vs 新點） */
export function shiftStats(oldPts: Pt2[], newPts: Pt2[]) {
  const n = Math.min(oldPts.length, newPts.length);
  let sum = 0, mx = 0, same = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(oldPts[i]!.x - newPts[i]!.x, oldPts[i]!.y - newPts[i]!.y);
    sum += d;
    if (d > mx) mx = d;
    if (d === 0) same++;
  }
  const cx = (p: Pt2[]) => p.reduce((s, q) => s + q.x, 0) / Math.max(1, p.length);
  const cy = (p: Pt2[]) => p.reduce((s, q) => s + q.y, 0) / Math.max(1, p.length);
  return {
    n,
    mean: n ? sum / n : 0,
    max: mx,
    same,
    centroid: Math.hypot(cx(oldPts) - cx(newPts), cy(oldPts) - cy(newPts)),
  };
}

// ---------------------------------------------------------------- CLI

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  let limit = 2000;
  let mode: "uniform" | "stretch" | "slot" | "slot-tight" = "slot-tight";
  let verbose: string | null = null;
  let thr = 6;
  let minCp = 0x4e00, maxCp = 0x9fff;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--limit") limit = Number(argv[++i]);
    else if (a === "--mode") mode = argv[++i] as any;
    else if (a === "--verbose") verbose = argv[++i]!;
    else if (a === "--thr") thr = Number(argv[++i]);
    else if (a === "--range") { minCp = Number(argv[++i]); maxCp = Number(argv[++i]); }
  }
  if (!existsSync(DB)) { console.error("找不到資料庫"); process.exit(1); }
  const db = new Database(DB, { readonly: true });

  const norm = (s: string) => {
    const m = /^(?:u\+|U\+|u|U)?([0-9a-fA-F]{4,6})$/.exec(s);
    return m && /^(u\+|U\+|u|U)/.test(s) ? parseInt(m[1]!, 16) : parseInt(s, 16);
  };

  if (verbose) {
    const cp = norm(verbose);
    const exp = expandPoints(db, `u${cp.toString(16)}`);
    const plan = planFor(db, cp, exp, mode);
    console.log(`字 U+${cp.toString(16).toUpperCase()}  模式 ${mode}`);
    if (!plan) { console.log("  無 IDS 算子或無多個直接子部件 → 不適用"); process.exit(0); }
    for (const m of plan.moves) {
      const oldT = tightBox(exp.pts.filter((p) => {
        const s = p.src.split("."); return (s.length >= 2 ? s.slice(0, 2).join(".") : p.src) === m.group;
      }));
      console.log(`  ${m.group}  舊框 ${m.oldBox.x1.toFixed(0)},${m.oldBox.y1.toFixed(0)}..${m.oldBox.x2.toFixed(0)},${m.oldBox.y2.toFixed(0)}` +
        `  →  新框 ${m.newBox.x1.toFixed(0)},${m.newBox.y1.toFixed(0)}..${m.newBox.x2.toFixed(0)},${m.newBox.y2.toFixed(0)}` +
        `   內容緊框 ${oldT ? `${oldT.x1.toFixed(0)},${oldT.y1.toFixed(0)}..${oldT.x2.toFixed(0)},${oldT.y2.toFixed(0)}` : "-"}`);
    }
    const newPts = applyPlan(exp, plan);
    const st = shiftStats(exp.pts, newPts);
    console.log(`  位移: 平均 ${st.mean.toFixed(2)}  最大 ${st.max.toFixed(2)}  未動 ${st.same}/${st.n}  重心 ${st.centroid.toFixed(2)}`);
    const o1 = checkOverlap(exp.strokeSegs, thr);
    console.log(`  重疊(原): ${o1.pairs} 對，最小距離 ${o1.minDist === Infinity ? "-" : o1.minDist.toFixed(2)}`);
    process.exit(0);
  }

  const rows = db
    .query(
      `SELECT codepoint FROM ids WHERE outer_op IS NOT NULL AND codepoint BETWEEN ? AND ? ORDER BY codepoint LIMIT ?`,
    )
    .all(minCp, maxCp, limit) as any[];

  console.log(`模式 ${mode}，評估 ${rows.length} 字（有 IDS 算子）…`);
  const t0 = performance.now();
  let applicable = 0;
  let sumMean = 0, sumCentroid = 0, sumMax = 0;
  const hist = new Map<string, number>();
  let worse = 0, better = 0, sameOv = 0;
  const worst: { cp: number; mean: number; centroid: number }[] = [];

  for (const r of rows) {
    const cp = r.codepoint;
    const exp = expandPoints(db, `u${cp.toString(16)}`);
    const plan = planFor(db, cp, exp, mode);
    if (!plan) continue;
    applicable++;
    const newPts = applyPlan(exp, plan);
    const st = shiftStats(exp.pts, newPts);
    sumMean += st.mean;
    sumCentroid += st.centroid;
    sumMax += st.max;
    const b = Math.floor(st.mean / 5) * 5;
    hist.set(`${b}-${b + 5}`, (hist.get(`${b}-${b + 5}`) ?? 0) + 1);
    worst.push({ cp, mean: st.mean, centroid: st.centroid });
    // 重疊變化（用變換後的筆劃段重新檢查較貴，這裡先看緊框是否互相侵入）
    const o1 = checkOverlap(exp.strokeSegs, thr).pairs;
    if (o1 > 0) sameOv++;
  }
  const dt = (performance.now() - t0) / 1000;
  console.log(`適用 ${applicable} 字   耗時 ${dt.toFixed(1)}s (${(rows.length / dt).toFixed(0)} 字/秒)`);
  console.log(`平均位移 ${(sumMean / Math.max(1, applicable)).toFixed(2)}   平均重心位移 ${(sumCentroid / Math.max(1, applicable)).toFixed(2)}   平均最大位移 ${(sumMax / Math.max(1, applicable)).toFixed(2)}`);
  console.log(`原本就有筆劃重疊的字（基線）: ${sameOv}`);
  console.log("\n平均位移分佈（每 5 格一組）:");
  for (const [k, v] of [...hist.entries()].sort((a, b) => parseInt(a[0]) - parseInt(b[0])).slice(0, 12)) {
    console.log(`  ${k.padStart(7)} 格: ${v} 字`);
  }
  worst.sort((a, b) => b.mean - a.mean);
  console.log("\n位移最大的 8 個字:");
  for (const w of worst.slice(0, 8)) {
    const ch = db.query("SELECT ch FROM ids WHERE codepoint = ?").get(w.cp) as any;
    console.log(`  u${w.cp.toString(16)} ${ch?.ch ?? "?"}  平均 ${w.mean.toFixed(1)}  重心 ${w.centroid.toFixed(1)}`);
  }
  db.close();
}
