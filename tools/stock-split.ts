// stock-split.ts — 把「恰兩個引用」分成「真左右並排」與「其他」，再量庫存框
//
// 先前把 28,260 個「恰兩個引用」全當成左右形來量，最大位移 241 格——
// 因為其中有些是上下結構或嵌套，用左右框去套當然離譜。
import { readFileSync } from "node:fs";
import { decodeLibrary } from "./lib-format.ts";
import type { Library } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

interface Rec { gi: number; L: number[]; R: number[]; overlapX: number; overlapY: number; name: string }
const all: Rec[] = [];
for (let i = 0; i < lib.glyphs.length; i++) {
  const g = lib.glyphs[i]!;
  const refs = g.strokes.filter((s) => s.kind === 99);
  if (refs.length !== 2) continue;
  const a = refs[0]!.box!, b = refs[1]!.box!;
  const [L, R] = (a[0]! + a[2]!) / 2 <= (b[0]! + b[2]!) / 2 ? [a, b] : [b, a];
  const ox = Math.min(L[2]!, R[2]!) - Math.max(L[0]!, R[0]!);
  const oy = Math.min(L[3]!, R[3]!) - Math.max(L[1]!, R[1]!);
  all.push({ gi: i, L: L.slice(), R: R.slice(), overlapX: ox, overlapY: oy, name: lib.names[i]! });
}

// 分類
const sideBySide = all.filter((r) => r.overlapY > 0 && (r.L[2]! - r.L[0]!) <= 200 && (r.R[2]! - r.R[0]!) <= 200 && r.overlapX < Math.min(r.L[2]! - r.L[0]!, r.R[2]! - r.R[0]!) * 0.9);
console.log(`「恰兩個引用」共 ${all.length.toLocaleString()}`);
console.log(`  真左右並排（y 有重疊、x 不完全重疊）：${sideBySide.length.toLocaleString()}`);
console.log(`  其他（上下、嵌套、完全重疊）：${(all.length - sideBySide.length).toLocaleString()}`);

const q = (v: number, grid: number) => Math.round((v / 200) * grid);

console.log("\n=== 只對「真左右並排」量庫存框 ===");
console.log("  編碼方式  格數   相異數   前16    前32    前64");
for (const dims of ["x", "xy", "xywh"] as const) {
  for (const grid of [8, 12, 16]) {
    const counts = new Map<string, number>();
    for (const r of sideBySide) {
      const enc = (b: number[]) => {
        if (dims === "x") return `${q(b[0]!, grid)},${q(b[2]!, grid)}`;
        if (dims === "xy") return `${q(b[0]!, grid)},${q(b[1]!, grid)},${q(b[2]!, grid)},${q(b[3]!, grid)}`;
        return `${q(b[0]!, grid)},${q(b[1]!, grid)},${q(b[2]!, grid)},${q(b[3]!, grid)},${q(b[2]! - b[0]!, grid)},${q(b[3]! - b[1]!, grid)}`;
      };
      const k = enc(r.L) + "|" + enc(r.R);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const sorted = [...counts.values()].sort((a, b) => b - a);
    const cov = (K: number) => (100 * sorted.slice(0, K).reduce((s, v) => s + v, 0)) / sideBySide.length;
    console.log(`  ${dims.padEnd(6)} @${String(grid).padStart(2)}   ${String(sorted.length).padStart(6)}   ` +
      `${cov(16).toFixed(1).padStart(5)}%  ${cov(32).toFixed(1).padStart(5)}%  ${cov(64).toFixed(1).padStart(5)}%`);
  }
}

console.log("\n=== 庫存框數 K vs 位移（只對真左右並排，@8 格 xywh）===");
{
  const counts = new Map<string, { n: number; rep: number[][] }>();
  for (const r of sideBySide) {
    const enc = (b: number[]) => `${q(b[0]!, 8)},${q(b[1]!, 8)},${q(b[2]!, 8)},${q(b[3]!, 8)},${q(b[2]! - b[0]!, 8)},${q(b[3]! - b[1]!, 8)}`;
    const k = enc(r.L) + "|" + enc(r.R);
    const e = counts.get(k);
    if (e) e.n++;
    else counts.set(k, { n: 1, rep: [r.L.slice(), r.R.slice()] });
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const K of [16, 32, 64, 128, 256, 512]) {
    const reps = ordered.slice(0, K).map(([, v]) => v.rep);
    let sumD = 0, maxD = 0;
    for (const r of sideBySide) {
      let best = Infinity;
      for (const rp of reps) {
        const L = rp[0]!, R = rp[1]!;
        // 只比對水平（左件的 x 範圍）；垂直留給上下結構處理
        const d = Math.max(
          Math.abs(r.L[0]! - L[0]!), Math.abs(r.L[2]! - L[2]!),
          Math.abs(r.R[0]! - R[0]!), Math.abs(r.R[2]! - R[2]!),
        );
        if (d < best) best = d;
      }
      sumD += best;
      if (best > maxD) maxD = best;
    }
    const before = sideBySide.length * 12;
    const after = K * 6 + sideBySide.length * 1;
    console.log(`  K=${String(K).padStart(3)}：平均位移 ${(sumD / sideBySide.length).toFixed(1).padStart(5)} 格、` +
      `最大 ${maxD.toFixed(0).padStart(3)} 格；框位元組省 ${(100 * (1 - after / before)).toFixed(0)}%`);
  }
}
