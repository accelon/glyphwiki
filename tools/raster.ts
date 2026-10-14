#!/usr/bin/env bun
/**
 * raster.ts — 把 GlyphWiki 字形光柵化成點陣，供快速目視與量化比對。
 *
 * 用法:
 *   bun run tools/raster.ts <name|u+XXXX> [--size 24] [--ascii] [--ss 2]
 *   bun run tools/raster.ts <nameA> --diff <nameB> [--size 24]
 *   bun run tools/raster.ts --text "筆畫資料字串" [--size 24] [--ascii]
 *
 * 說明:
 *   直接使用 kage-engine（原 JS 實作）產生外框，再自行光柵化。
 *   因為改字框對字形的影響，需要「同解析度下逐格比較」才看得出來，
 *   所以這裡同時提供 ASCII 目視與 --diff 差異圖。
 *
 * 座標系: KAGE 為 200x200，原點左上、y 向下。
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ensureEngine } from "./compose-fit.ts";

/**
 * ⚠ 這一支會被**內嵌進網頁**（`embed-common.ts` 的 `MODULES`）——所以**整份檔案都不能出現
 * `import.meta`** ✗（連函式裡也不行：非 module 的 script 一律拒絕，
 * 症狀是 `import.meta is only valid inside modules`，整頁空白 ✓ 實測踩過）。
 * 需要專案路徑的地方，只在**會被切掉的 CLI 區塊**裡用 `import.meta` ✓。
 */

// ---------------------------------------------------------------- 載入 kage-engine

/* 引擎載入走**共用**的 `ensureEngine()` ✓：
   · Node 端：讀 kage-engine/*.js 逐檔 eval ✓
   · **頁面端**：`embed-common.ts` 會把 `ensureEngine()` 換成 no-op（引擎早就內嵌在頁面上方 ✓）
   ⚠ 原本這裡自己寫了一份「頂層讀檔 ＋ eval」✗——內嵌進頁面時 `readFileSync` 根本不存在，
     整頁 script 會掛掉 ✗（第 112 輪要把這一支內嵌時踩到 ✓）。 */
ensureEngine();

type AnyKage = any;

/** 建一個 Kage 實例，並把一個字（含其遞迴依賴）灌進 Buhin */
function buildKage(db: any, rootName: string): AnyKage {
  const kage: AnyKage = new (globalThis as any).Kage();
  const seen = new Set<string>();
  const stack = [rootName];
  const getData = db.query("SELECT data FROM glyphs WHERE name = ?");
  const getKids = db.query("SELECT comp FROM parts WHERE glyph = ? AND kind = 99 ORDER BY idx");
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    const row = getData.get(n) as any;
    if (!row) continue; // 懸空引用：引擎會拿到空字串，等同缺字
    kage.kBuhin.push(n, row.data);
    for (const k of getKids.all(n) as any[]) stack.push(k.comp);
  }
  return kage;
}

// ---------------------------------------------------------------- 光柵化

/** 由 polygons 取出每個多邊形的點（已含曲線細分） */
function extractPolys(polygons: any): { pts: { x: number; y: number }[]; off: boolean }[] {
  const out: { pts: { x: number; y: number }[]; off: boolean }[] = [];
  for (const poly of polygons.array) {
    const pts: { x: number; y: number }[] = [];
    let off = false;
    for (const p of poly.array) {
      pts.push({ x: p.x, y: p.y });
      if (p.off) off = true;
    }
    if (pts.length >= 3) out.push({ pts, off });
  }
  return out;
}

/**
 * 射線法（**nonzero winding**）：點是否在輪廓內。
 *
 * 踩過的坑：這裡原本用 even-odd（每穿過一個輪廓就翻一次），
 * 對**單一**字形看不出問題（輪廓不重疊），但 KAGE 的筆畫是一筆一個四邊形、
 * 轉角處彼此重疊 —— even-odd 會把每個重疊處翻成「洞」，
 * 組字出來的字形（部件大幅重疊）更是整片變成棋盤格。
 * `polygons.js` 的 `generateSVG` 產生 `<path fill="black">` 而**沒有**指定
 * `fill-rule`，SVG 的預設是 `nonzero` —— 所以正確規則是 nonzero。
 */
function windingNumber(pts: { x: number; y: number }[], x: number, y: number): number {
  let wn = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j]!;
    const b = pts[i]!;
    if (a.y <= y) {
      if (b.y > y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) > 0) wn++;
    } else {
      if (b.y <= y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) < 0) wn--;
    }
  }
  return wn;
}

function inside(pts: { x: number; y: number }[], x: number, y: number): boolean {
  return windingNumber(pts, x, y) !== 0;
}

export interface Raster {
  size: number;
  /** 每格覆蓋率 0..1（以 supersampling 求得） */
  cov: Float32Array;
}

/** 把一個多邊形加上包圍盒——掃描時用來跳過離得很遠的多邊形。
 *  這是純加速：判定結果與不加完全一樣，只是不必對每個取樣點跑完整個輪廓。 */
function withBBox(p: { pts: { x: number; y: number }[]; off: boolean }) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const q of p.pts) {
    if (q.x < x1) x1 = q.x;
    if (q.x > x2) x2 = q.x;
    if (q.y < y1) y1 = q.y;
    if (q.y > y2) y2 = q.y;
  }
  return { ...p, x1, y1, x2, y2 };
}

/** 把 200x200 空間的字形光柵化成 size x size 的覆蓋率 */
export function rasterize(kage: AnyKage, glyphName: string, size: number, ss = 2): Raster {
  const polygons: any = new (globalThis as any).Polygons();
  kage.makeGlyph(polygons, glyphName);
  const polys = extractPolys(polygons).map(withBBox);
  const cov = new Float32Array(size * size);
  const step = 1 / ss;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hit = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = ((px + (sx + 0.5) * step) / size) * 200;
          const y = ((py + (sy + 0.5) * step) / size) * 200;
          // 全部輪廓的 winding 數相加（＝nonzero），不是逐輪廓翻面（even-odd）
          let wn = 0;
          for (const p of polys) {
            if (x < p.x1 || x > p.x2 || y < p.y1 || y > p.y2) continue;
            wn += windingNumber(p.pts, x, y);
          }
          if (wn !== 0) hit++;
        }
      }
      cov[py * size + px] = hit / (ss * ss);
    }
  }
  return { size, cov };
}

const RAMP = " .:-=+*#%@";
export function toAscii(r: Raster): string {
  const lines: string[] = [];
  for (let y = 0; y < r.size; y++) {
    let s = "";
    for (let x = 0; x < r.size; x++) {
      const v = r.cov[y * r.size + x]!;
      s += RAMP[Math.min(RAMP.length - 1, Math.round(v * (RAMP.length - 1)))]!;
    }
    lines.push(s);
  }
  return lines.join("\n");
}

/** 兩張點陣的差異圖：A 有 B 無 = '+'（多了），B 有 A 無 = '-'（少了） */
export function diffAscii(a: Raster, b: Raster, thr = 0.5): string {
  const lines: string[] = [];
  for (let y = 0; y < a.size; y++) {
    let s = "";
    for (let x = 0; x < a.size; x++) {
      const va = a.cov[y * a.size + x]! >= thr;
      const vb = b.cov[y * b.size + x]! >= thr;
      s += va && vb ? "#" : va ? "+" : vb ? "-" : ".";
    }
    lines.push(s);
  }
  return lines.join("\n");
}

/** IoU：交集 / 聯集（原始覆蓋率，非二值） */
export function iou(a: Raster, b: Raster): number {
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < a.cov.length; i++) {
    const x = a.cov[i]!;
    const y = b.cov[i]!;
    inter += Math.min(x, y);
    uni += Math.max(x, y);
  }
  return uni > 0 ? inter / uni : 1;
}

// ---------------------------------------------------------------- CLI

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  let size = 24;
  let ascii = false;
  let ss = 2;
  let diffWith: string | null = null;
  let textData: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--size") size = Number(argv[++i]);
    else if (a === "--ss") ss = Number(argv[++i]);
    else if (a === "--ascii") ascii = true;
    else if (a === "--diff") diffWith = argv[++i]!;
    else if (a === "--text") textData = argv[++i]!;
    else positional.push(a);
  }

  const DB = resolve(import.meta.dir, "..", "db/glyphwiki.db");
  if (!existsSync(DB)) {
    console.error("找不到資料庫，請先執行 tools/build-db.ts");
    process.exit(1);
  }
  const db = new Database(DB, { readonly: true });

  const norm = (s: string) => {
    const m = /^(?:u\+|U\+|u|U)?([0-9a-fA-F]{4,6})$/.exec(s);
    return m && /^(u\+|U\+|u|U)/.test(s) ? "u" + m[1]!.toLowerCase() : s;
  };

  if (textData) {
    const kage: AnyKage = new (globalThis as any).Kage();
    kage.kBuhin.push("__t", textData);
    const r = rasterize(kage, "__t", size, ss);
    console.log(`大小 ${size}x${size}  覆蓋率總和 ${[...r.cov].reduce((a, b) => a + b, 0).toFixed(1)}`);
    console.log(toAscii(r));
    db.close();
    process.exit(0);
  }

  const nameA = norm(positional[0] ?? "");
  if (!nameA) {
    console.error("usage: raster.ts <name> [--size N] [--ascii] [--diff <name>]");
    process.exit(2);
  }
  const kageA = buildKage(db, nameA);
  const rA = rasterize(kageA, nameA, size, ss);

  if (diffWith) {
    const nameB = norm(diffWith);
    const kageB = buildKage(db, nameB);
    const rB = rasterize(kageB, nameB, size, ss);
    console.log(`A = ${nameA}   B = ${nameB}   size=${size}   IoU = ${iou(rA, rB).toFixed(4)}`);
    console.log(diffAscii(rA, rB));
  } else {
    console.log(`${nameA}  size=${size}  覆蓋率總和 ${[...rA.cov].reduce((a, b) => a + b, 0).toFixed(1)}`);
    console.log(toAscii(rA));
  }
  db.close();
}
