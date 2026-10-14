// tight-verify.ts — 緊框可衍生性驗證
// 目的：證明原本存在庫裡的「緊框」可以從內容算回來，而且會比原來的更正確。
//
// 原本 build-library.ts 的 tightOf() 讀的是原始 pts[i]（8 個欄位），
// 沒有依 kind 只取有效點數，所以對 kind 0/9 或部分型別會把無效欄位也算進去。
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { decodeLibrary, ptCountOf, computeTight } from "./lib-format.ts";
import type { Library, Glyph, Stroke } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";

/** 依 kind 只取「實際使用的點數」來算緊框（修正版） */
function tightFrom(g: Glyph, lib: Library, seen = new Set<number>()): [number, number, number, number] {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const upd = (a: number, b: number) => {
    if (a < x1) x1 = a; if (a > x2) x2 = a;
    if (b < y1) y1 = b; if (b > y2) y2 = b;
  };
  for (const s of g.strokes) {
    if (s.kind === 99) continue;
    const n = ptCountOf(s.kind);
    if (n === 0) continue; // kind 0/9 不描繪，不計入
    for (let i = 0; i < n; i++) upd(s.points[i * 2]!, s.points[i * 2 + 1]!);
  }
  return [x1, y1, x2, y2];
}

console.log("載入庫…");
const lib = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

// 從資料庫取「原始 KAGE 資料」來獨立算緊框，作為第三方對照
const db = new Database(`${D}/db/glyphwiki.db`, { readonly: true });
const getData = db.query("SELECT data FROM glyphs WHERE name = ?");
const cache = new Map<string, string | null>();
const dataOf = (n: string): string | null => {
  if (!cache.has(n)) {
    let r = getData.get(n) as any;
    if (!r) {
      const s = n.replace(/@[0-9]+$/, "");
      if (s !== n) r = getData.get(s) as any;
    }
    cache.set(n, r ? (r.data as string) : null);
  }
  return cache.get(n)!;
};

/** 從原始 KAGE 字串算緊框（完全獨立於庫的二進位） */
function tightFromKage(name: string, depth = 0, seen = new Set<string>()): [number, number, number, number] | null {
  if (depth > 24) return null;
  const d = dataOf(name);
  if (d === null) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const upd = (a: number, b: number) => {
    if (a < x1) x1 = a; if (a > x2) x2 = a;
    if (b < y1) y1 = b; if (b > y2) y2 = b;
  };
  for (const part of d.split("$")) {
    if (!part) continue;
    const c = part.split(":");
    const kind = parseInt(c[0]!, 10);
    if (kind === 99) {
      const child = c[7]!;
      if (seen.has(child)) continue;
      seen.add(child);
      const cb = tightFromKage(child, depth + 1, seen);
      if (cb) {
        // 子緊框經框映射到父空間（與 kage 的 getBox + 映射一致）
        const bx1 = parseInt(c[3]!, 10), by1 = parseInt(c[4]!, 10);
        const bx2 = parseInt(c[5]!, 10), by2 = parseInt(c[6]!, 10);
        for (const [cx, cy] of [[cb[0], cb[1]], [cb[2], cb[3]]] as [number, number][]) {
          upd(bx1 + (cx * (bx2 - bx1)) / 200, by1 + (cy * (by2 - by1)) / 200);
        }
      }
      continue;
    }
    const n = ptCountOf(kind);
    if (n === 0) continue;
    const pts: number[] = [];
    for (let i = 3; i <= 10; i++) pts.push(parseInt(c[i] ?? "0", 10) || 0);
    for (let i = 0; i < n; i++) upd(pts[i * 2]!, pts[i * 2 + 1]!);
  }
  return Number.isFinite(x1) ? [x1, y1, x2, y2] : null;
}

// 抽樣比對
const targets = ["u4e00", "u571f", "u76df", "u660e", "u5bf6", "u6f22", "u67f1", "u9f8d", "u6ce8"];
console.log("\n=== 抽樣：庫存的緊框 vs 從內容算出的緊框 ===");
console.log("  字       庫存緊框                從內容算              完全相同");
for (const t of targets) {
  const idx = lib.names.indexOf(t);
  if (idx < 0) { console.log(`  ${t}: 不在庫中`); continue; }
  const g = lib.glyphs[idx]!;
  const stored = g.tight.map((v) => Math.round(v));
  const computed = computeTight(lib, idx).map((v) => Math.round(v));
  const same = stored.every((v, i) => v === computed[i]);
  console.log(`  ${t.padEnd(8)} [${stored.join(",").padEnd(20)}] [${computed.join(",").padEnd(20)}] ${same ? "✓" : "✗"}`);
}

// 全庫統計：有多少字的庫存緊框與計算值不同
console.log("\n=== 全庫統計 ===");
let same = 0, diff = 0, storedEmpty = 0;
let maxDelta = 0;
for (let i = 0; i < lib.glyphs.length; i++) {
  const g = lib.glyphs[i]!;
  const st = g.tight;
  const co = computeTight(lib, i);
  if (st[0] === 0 && st[1] === 0 && st[2] === 0 && st[3] === 0) storedEmpty++;
  let d = 0;
  for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(Math.round(st[k]!) - Math.round(co[k]!)));
  if (d === 0) same++; else diff++;
  if (d > maxDelta) maxDelta = d;
}
console.log(`  字形總數 ${lib.glyphs.length.toLocaleString()}`);
console.log(`  庫存緊框 = 計算值：${same.toLocaleString()}`);
console.log(`  不同：${diff.toLocaleString()}（最大差 ${maxDelta} 格）`);
console.log(`  庫存緊框為 [0,0,0,0]（空）：${storedEmpty.toLocaleString()}`);

// 用資料庫獨立驗證幾個（證明「計算值」才是對的）
console.log("\n=== 第三方對照（從資料庫原始 KAGE 獨立計算）===");
for (const t of ["u4e00", "u571f", "u76df"]) {
  const kb = tightFromKage(t);
  const idx = lib.names.indexOf(t);
  const g = idx >= 0 ? lib.glyphs[idx]! : null;
  console.log(`  ${t}: 原始KAGE算出 [${kb ? kb.map((v) => v.toFixed(0)).join(",") : "-"}]` +
    `  庫存 [${g ? g.tight.map((v) => v.toFixed(0)).join(",") : "-"}]` +
    `  內容算出 [${g && idx >= 0 ? computeTight(lib, idx).map((v) => v.toFixed(0)).join(",") : "-"}]`);
}
void (null as unknown as Stroke);
db.close();
