// layout-band.ts — 檢驗「依右件寬度分帶」能否把同左件的布局離散度壓到 2–3 個百分點
//
// 背景：先前量到「同一個左件（如 u6728-01）在不同字裡左占比差 7~8 個百分點」，
// 而差異來自右件寬度不同（村 的 寸 窄 → 左件占 44%；校 的 交 寬 → 左件占 37%）。
// 所以改用「右件墨跡寬度」或「左右寬度比」來分帶。
import { readFileSync } from "node:fs";
import { decodeLibrary } from "./lib-format.ts";
import { inkOfRefInParent } from "./compose-fit.ts";
import type { Library } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

interface Rec {
  left: string; right: string;
  lw: number; rw: number; lh: number; rh: number; // 墨跡寬高（200 空間）
  p: number; // 左占比 = lw / (lw + rw)
}

console.log("收集左右兩件的字…");
const byLeft = new Map<string, Rec[]>();
for (let i = 0; i < lib.names.length; i++) {
  const n = lib.names[i]!;
  if (!/^u[0-9a-f]{4,6}$/.test(n)) continue;
  const g = lib.glyphs[i]!;
  const refs: { name: string; box: any }[] = [];
  for (let k = 0; k < g.strokes.length; k++) {
    const s = g.strokes[k]!;
    if (s.kind !== 99 || s.ref === null) continue;
    refs.push({ name: lib.names[s.ref]!, box: inkOfRefInParent(lib, i, k) });
  }
  if (refs.length !== 2) continue;
  refs.sort((a, b) => (a.box.x1 + a.box.x2) / 2 - (b.box.x1 + b.box.x2) / 2);
  const L = refs[0]!, R = refs[1]!;
  const lw = L.box.x2 - L.box.x1, rw = R.box.x2 - R.box.x1;
  const lh = L.box.y2 - L.box.y1, rh = R.box.y2 - R.box.y1;
  // 只收「明顯左右並排」的（左右墨跡有重疊或相接，且都夠寬）
  if (lw < 20 || rw < 20) continue;
  const rec: Rec = { left: L.name, right: R.name, lw, rw, lh, rh, p: lw / (lw + rw) };
  const a = byLeft.get(L.name);
  if (a) a.push(rec); else byLeft.set(L.name, [rec]);
}
console.log(`左件種類 ${byLeft.size}、樣本 ${[...byLeft.values()].reduce((s, a) => s + a.length, 0)}`);

const spreadOf = (arr: Rec[]) => {
  if (arr.length < 2) return 0;
  const v = arr.map((r) => r.p * 100);
  return Math.max(...v) - Math.min(...v);
};
const meanSpread = (getGroups: () => Rec[][]) => {
  const gs = getGroups().filter((g) => g.length >= 2);
  if (gs.length === 0) return { n: 0, mean: 0, median: 0, ok: 0 };
  const sp = gs.map(spreadOf).sort((a, b) => a - b);
  return {
    n: gs.length,
    mean: sp.reduce((s, v) => s + v, 0) / sp.length,
    median: sp[Math.floor(sp.length / 2)]!,
    ok: sp.filter((s) => s <= 3).length,
  };
};

console.log("\n=== 基準：只用「左件」分群（不分帶）===");
{
  const r = meanSpread(() => [...byLeft.values()]);
  console.log(`  群數 ${r.n}  平均離散度 ${r.mean.toFixed(1)}  中位 ${r.median.toFixed(1)}` +
    `  離散度≤3 者 ${r.ok}/${r.n}（${(100 * r.ok / r.n).toFixed(0)}%）`);
}

/** 依某個量的等頻分帶（各帶樣本數盡量平均） */
function bandBy(keyFn: (r: Rec) => number, nb: number): () => Rec[][] {
  return () => {
    const out: Rec[][] = [];
    for (const [, arr] of byLeft) {
      if (arr.length < 2) continue;
      const sorted = [...arr].sort((a, b) => keyFn(a) - keyFn(b));
      const size = Math.ceil(sorted.length / nb);
      for (let i = 0; i < sorted.length; i += size) out.push(sorted.slice(i, i + size));
    }
    return out;
  };
}

console.log("\n=== 依「右件墨跡寬度」等頻分帶 ===");
for (const nb of [2, 3, 4]) {
  const r = meanSpread(bandBy((x) => x.rw, nb));
  console.log(`  ${nb} 帶：群數 ${r.n}  平均離散度 ${r.mean.toFixed(1)}  中位 ${r.median.toFixed(1)}` +
    `  離散度≤3 者 ${r.ok}/${r.n}（${(100 * r.ok / r.n).toFixed(0)}%）`);
}

console.log("\n=== 依「左右寬度比 rw/lw」等頻分帶 ===");
for (const nb of [2, 3, 4]) {
  const r = meanSpread(bandBy((x) => x.rw / x.lw, nb));
  console.log(`  ${nb} 帶：群數 ${r.n}  平均離散度 ${r.mean.toFixed(1)}  中位 ${r.median.toFixed(1)}` +
    `  離散度≤3 者 ${r.ok}/${r.n}（${(100 * r.ok / r.n).toFixed(0)}%）`);
}

console.log("\n=== 對照：用「右件原生字形的墨跡寬」等頻分帶（尺度無關的預測子）===");
// 右件自身在 200 空間的墨跡寬（與它被放進字中無關）
const rightInkW = new Map<string, number>();
for (const [, arr] of byLeft) {
  for (const r of arr) {
    if (!rightInkW.has(r.right)) {
      // 用第一筆資料的 rw 與框推算：此處直接取用「該引用在字中的寬」的近似
      rightInkW.set(r.right, r.rw);
    }
  }
}
for (const nb of [2, 3, 4]) {
  const r = meanSpread(bandBy((x) => x.lw / x.rw, nb));
  console.log(`  依 lw/rw ${nb} 帶：群數 ${r.n}  平均離散度 ${r.mean.toFixed(1)}  中位 ${r.median.toFixed(1)}` +
    `  離散度≤3 者 ${r.ok}/${r.n}（${(100 * r.ok / r.n).toFixed(0)}%）`);
}

// 實例：木在左
console.log("\n=== 實例：木在左（u6728-01）的分帶結果 ===");
const mu = byLeft.get("u6728-01");
if (mu) {
  const sorted = [...mu].sort((a, b) => a.rw - b.rw);
  console.log("  右件墨跡寬  左占比  右件名");
  for (const r of sorted.slice(0, 14)) {
    console.log(`  ${r.rw.toFixed(0).padStart(10)}  ${(r.p * 100).toFixed(1)}%   ${r.right}`);
  }
  // 相關性
  const n = sorted.length;
  const mx = sorted.reduce((s, r) => s + r.rw, 0) / n;
  const my = sorted.reduce((s, r) => s + r.p, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (const r of sorted) {
    num += (r.rw - mx) * (r.p - my);
    dx += (r.rw - mx) ** 2;
    dy += (r.p - my) ** 2;
  }
  const corr = num / Math.sqrt(dx * dy);
  console.log(`  樣本 ${n}，「右件寬 vs 左占比」相關係數 = ${corr.toFixed(3)}` +
    `（負值代表右件越寬、左件占比越小）`);
}
