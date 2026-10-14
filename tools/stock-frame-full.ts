// stock-frame-full.ts — 完整量測「庫存框」：左右兩件的四個框維度
//
// 使用者構想：32 種庫存框，字 = 部件序列 + 庫存框編號。
// 先前只量了水平方向（左件的 x1,x2），得到 126 種樣式、前 32 覆蓋 98.5%。
// 現在把垂直方向與高度也納入，看完整需要幾種。
import { readFileSync } from "node:fs";
import { decodeLibrary } from "./lib-format.ts";
import type { Library } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

/** 收集「恰兩個直接引用」的字，記錄兩件的完整框 */
const rows: { gi: number; L: number[]; R: number[] }[] = [];
for (let i = 0; i < lib.glyphs.length; i++) {
  const g = lib.glyphs[i]!;
  const refs = g.strokes.filter((s) => s.kind === 99);
  if (refs.length !== 2) continue;
  const a = refs[0]!.box!, b = refs[1]!.box!;
  // 依中心 x 排序（左、右）
  const first = (a[0]! + a[2]!) / 2 <= (b[0]! + b[2]!) / 2 ? a : b;
  const second = first === a ? b : a;
  rows.push({ gi: i, L: first.slice(), R: second.slice() });
}
console.log(`左右兩件的字：${rows.length.toLocaleString()}\n`);

const q = (v: number, grid: number) => Math.round((v / 200) * grid);

/** 依給定的編碼方式產生 key */
function keyOf(r: typeof rows[0], grid: number, dims: "x" | "xy" | "xywh"): string {
  const enc = (b: number[]) => {
    if (dims === "x") return `${q(b[0]!, grid)},${q(b[2]!, grid)}`;
    if (dims === "xy") return `${q(b[0]!, grid)},${q(b[1]!, grid)},${q(b[2]!, grid)},${q(b[3]!, grid)}`;
    return `${q(b[0]!, grid)},${q(b[1]!, grid)},${q(b[2]!, grid)},${q(b[3]!, grid)}` +
      `,${q(b[2]! - b[0]!, grid)},${q(b[3]! - b[1]!, grid)}`;
  };
  return enc(r.L) + "|" + enc(r.R);
}

console.log("=== 各編碼方式下的「庫存框」種類數與前 K 覆蓋率 ===");
for (const dims of ["x", "xy", "xywh"] as const) {
  for (const grid of [8, 12, 16]) {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const k = keyOf(r, grid, dims);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const sorted = [...counts.values()].sort((a, b) => b - a);
    const cov = (K: number) => (100 * sorted.slice(0, K).reduce((s, v) => s + v, 0)) / rows.length;
    console.log(`  ${dims.padEnd(5)} @${String(grid).padStart(2)}格：相異 ${String(sorted.length).padStart(5)}` +
      `  前16 ${cov(16).toFixed(1)}%  前32 ${cov(32).toFixed(1)}%  前64 ${cov(64).toFixed(1)}%`);
  }
}

// ---- 32 種庫存框的位移代價 ----
console.log("\n=== 取前 32 種當庫存框：位移代價 ===");
for (const grid of [8, 12, 16]) {
  const counts = new Map<string, { n: number; rep: number[][] }>();
  for (const r of rows) {
    const k = keyOf(r, grid, "xywh");
    const e = counts.get(k);
    if (e) e.n++;
    else counts.set(k, { n: 1, rep: [r.L.slice(), r.R.slice()] });
  }
  const top = [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 32);
  const reps = top.map(([, v]) => v.rep);
  // 每個字找最近的庫存框
  let sumD = 0, maxD = 0, n = 0;
  for (const r of rows) {
    let best = Infinity;
    for (const rp of reps) {
      const d = Math.max(
        Math.abs(r.L[0]! - rp[0]![0]!), Math.abs(r.L[1]! - rp[0]![1]!),
        Math.abs(r.L[2]! - rp[0]![2]!), Math.abs(r.L[3]! - rp[0]![3]!),
      );
      if (d < best) best = d;
    }
    sumD += best; n++;
    if (best > maxD) maxD = best;
  }
  // 位元組：原本每筆引用框 4 個 zigzag（約 6 bytes）× 2；庫存框只需 1 個索引（1 byte）
  const before = rows.length * 12;
  const after = 32 * 6 + rows.length * 1;
  console.log(`  @${String(grid).padStart(2)}格：平均位移 ${(sumD / n).toFixed(1)} 格、最大 ${maxD.toFixed(0)} 格；` +
    `框位元組 ${before.toLocaleString()} → ${after.toLocaleString()}（省 ${(100 * (1 - after / before)).toFixed(0)}%）`);
}

// ---- 64 / 128 種的對照 ----
console.log("\n=== 對照：K 種庫存框 vs 位移與節省（@12 格）===");
{
  const counts = new Map<string, { n: number; rep: number[][] }>();
  for (const r of rows) {
    const k = keyOf(r, 12, "xywh");
    const e = counts.get(k);
    if (e) e.n++;
    else counts.set(k, { n: 1, rep: [r.L.slice(), r.R.slice()] });
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const K of [8, 16, 32, 64, 128, 256]) {
    const reps = ordered.slice(0, K).map(([, v]) => v.rep);
    let sumD = 0, maxD = 0;
    for (const r of rows) {
      let best = Infinity;
      for (const rp of reps) {
        const d = Math.max(
          Math.abs(r.L[0]! - rp[0]![0]!), Math.abs(r.L[1]! - rp[0]![1]!),
          Math.abs(r.L[2]! - rp[0]![2]!), Math.abs(r.L[3]! - rp[0]![3]!),
        );
        if (d < best) best = d;
      }
      sumD += best;
      if (best > maxD) maxD = best;
    }
    const before = rows.length * 12;
    const after = K * 6 + rows.length * 1;
    console.log(`  K=${String(K).padStart(3)}：平均位移 ${(sumD / rows.length).toFixed(1).padStart(5)} 格、` +
      `最大 ${maxD.toFixed(0).padStart(3)} 格；框位元組省 ${(100 * (1 - after / before)).toFixed(0).padStart(2)}%`);
  }
}
