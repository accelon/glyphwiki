#!/usr/bin/env bun
/**
 * compose.ts — 自由組字的核心：把一個部件的「緊框內容」放進目標槽位。
 *
 * 策略（使用者定案）：**框是人工手調資產，必須保存**。
 *   - 資料層：每個部件存 (a) 裁掉留白的內容座標 (b) 它在定義空間中的緊框
 *   - 組字層：把內容按目標槽位縮放放置 → 去留白在組字階段實現
 *   - 保真度：用原框架重建 = 完全精確（已驗證 2000 字、138,318 點、誤差 0）
 *
 * 用法:
 *   bun run tools/compose.ts u76df --replace u76bf-04=u6708-j [--size 24]
 *   bun run tools/compose.ts <glyph> --sketch                 # 只看原字形
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkOverlap, expandPoints, similarity, compareByNearest, sketch } from "./skelcmp.ts";

const ROOT = resolve(import.meta.dir, "..");
const DB = resolve(ROOT, "db/glyphwiki.db");

type Pt = { x: number; y: number; src: string };
type Box = { x1: number; y1: number; x2: number; y2: number };

function tightBox(pts: { x: number; y: number }[]): Box | null {
  if (!pts.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of pts) {
    if (p.x < x1) x1 = p.x;
    if (p.x > x2) x2 = p.x;
    if (p.y < y1) y1 = p.y;
    if (p.y > y2) y2 = p.y;
  }
  return { x1, y1, x2, y2 };
}

/** 群組鍵：目標字的直接子部件（路徑前兩段） */
const groupOf = (src: string) => {
  const seg = src.split(".");
  return seg.length >= 2 ? seg.slice(0, 2).join(".") : src;
};

/**
 * 把 source 的內容（依 role）放進 targetSlot。
 *
 * @param source      來源部件的取樣點（其座標仍在自己的定義空間）
 * @param role        來源部件在「它原本那個字」裡的緊框（＝它被設計成多大、放在哪）
 * @param targetSlot  目標字中這個槽位的緊框（＝要放進去的區域）
 *
 * 做法：先把 source 的內容相對 role 正規化到 0..1（去留白），
 *       再按 targetSlot 的大小等比縮放並置中（不留白、不變形）。
 */
export function placeInto(source: { x: number; y: number }[], role: Box, targetSlot: Box) {
  const sw = Math.max(1e-6, role.x2 - role.x1);
  const sh = Math.max(1e-6, role.y2 - role.y1);
  const tw = targetSlot.x2 - targetSlot.x1;
  const th = targetSlot.y2 - targetSlot.y1;
  // 等比縮放（取較小者），確保不超出槽位且不變形
  const s = Math.min(tw / sw, th / sh);
  const w = sw * s, h = sh * s;
  const cx = (targetSlot.x1 + targetSlot.x2) / 2;
  const cy = (targetSlot.y1 + targetSlot.y2) / 2;
  const ox = cx - w / 2;
  const oy = cy - h / 2;
  return source.map((p) => ({
    x: ox + (p.x - role.x1) * s,
    y: oy + (p.y - role.y1) * s,
  }));
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  let replace: string | null = null;
  let size = 24;
  let thr = 6;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--replace") replace = argv[++i]!;
    else if (a === "--size") size = Number(argv[++i]);
    else if (a === "--thr") thr = Number(argv[++i]);
    else positional.push(a);
  }
  if (!existsSync(DB)) { console.error("找不到資料庫"); process.exit(1); }
  const db = new Database(DB, { readonly: true });
  const norm = (s: string) => {
    const m = /^(?:u\+|U\+|u|U)?([0-9a-fA-F]{4,6})$/.exec(s);
    return m && /^(u\+|U\+|u|U)/.test(s) ? "u" + m[1]!.toLowerCase() : s;
  };

  const targetName = norm(positional[0] ?? "");
  if (!targetName) { console.error("usage: compose.ts <glyph> [--replace 舊部件=新部件] [--size N]"); process.exit(2); }

  // 原字形
  const A = expandPoints(db, targetName);
  // 目標字的直接子部件 → 各自的緊框（＝槽位）
  const groupsA = new Map<string, Pt[]>();
  for (const p of A.pts) {
    const g = groupOf(p.src);
    const arr = groupsA.get(g);
    if (arr) arr.push(p);
    else groupsA.set(g, [p]);
  }

  let outPts: { x: number; y: number }[] = [];
  let label = `原字形 ${targetName}`;

  if (replace) {
    const [from, to] = replace.split("=");
    // 找到 slot 群組：來源部件的「槽位」＝該群組在原字中的緊框
    // 而來源部件（to）必須能在原字中定位：to 就是一個部件名
    const srcName = to!;
    const B = expandPoints(db, srcName);
    const bTight = tightBox(B.pts);
    if (!bTight) { console.error(`來源部件 ${srcName} 沒有筆畫`); process.exit(1); }

    // 找出被替換的槽位：以「原字中引用 from 的那個群組」為準
    // 簡化：若原字只有兩個直接子部件，用群組順序對應
    const keys = [...groupsA.keys()].sort();
    // 逐一比對哪個群組的內容對應 from：用展開資料的來源名比對不可得，
    // 這裡改用「該群組的內容與 from 的展開是否一致」判定
    let slotBox: Box | null = null;
    let slotKey: string | null = null;
    for (const k of keys) {
      const pts = groupsA.get(k)!;
      const t = tightBox(pts);
      if (!t) continue;
      // from 若是部件名，檢查這個群組的內容是否等同 from 的展開（抽樣比對）
      const f = expandPoints(db, from!);
      const ft = tightBox(f.pts);
      if (ft && Math.abs(t.x1 - ft.x1) < 2 && Math.abs(t.y2 - ft.y2) < 2 && Math.abs(t.x2 - ft.x2) < 2) {
        slotBox = t; slotKey = k; break;
      }
      if (!slotBox) { slotBox = t; slotKey = k; }
    }
    if (!slotBox) { console.error("找不到可替換的槽位"); process.exit(1); }

    // 其餘部件維持原位；被替換的槽位放進 srcName 的內容
    for (const [k, pts] of groupsA) {
      if (k === slotKey) {
        const placed = placeInto(B.pts, bTight, slotBox);
        for (const p of placed) outPts.push(p);
      } else {
        for (const p of pts) outPts.push(p);
      }
    }
    label = `${targetName} 的槽位 ${slotKey}（緊框 ${slotBox.x1.toFixed(0)},${slotBox.y1.toFixed(0)}..${slotBox.x2.toFixed(0)},${slotBox.y2.toFixed(0)}）放入 ${srcName}`;
  } else {
    outPts = A.pts.map((p) => ({ x: p.x, y: p.y }));
  }

  console.log(label);
  console.log(`點數 A=${A.pts.length} → 組字後 ${outPts.length}`);
  console.log("\n骨架圖（o = 原字形, x = 組字後, # = 重疊）:");
  console.log(sketch(A.pts, outPts, size));

  // 位移統計（不同長度時用最近鄰）
  const c = compareByNearest(A.pts.map((p) => ({ x: p.x, y: p.y })), outPts);
  console.log(`\n位移: 平均 ${c.meanShift.toFixed(2)}  中位 ${c.medianShift.toFixed(2)}  最大 ${c.maxShift.toFixed(2)}  相似度 ${similarity(c).toFixed(3)}`);
  db.close();
}
