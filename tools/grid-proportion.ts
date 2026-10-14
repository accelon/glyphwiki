// grid-proportion.ts — 檢驗使用者的假設：
//   把字降到 24×24 / 48×48 後，同「部件＋位置」的字，兩部分的占比是否相同？
//   若相同，就只需為每個部件位置存一個布局模板（如「村寸」），其餘字借用。
//
// 量測方式：
//   1. 取每個直接引用在父座標系的墨跡框（＝它在字中實際占的區域）
//   2. 量化到 24 / 48 格，看左件的寬度占比是否一致
//   3. 同時報出原生 200 空間的占比，作為對照
import { readFileSync } from "node:fs";
import { decodeLibrary, findGlyphIndex } from "./lib-format.ts";
import { inkOfRefInParent } from "./compose-fit.ts";
import type { Library } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

/** 把區間 [a,b] 量化到 n 格 */
const qz = (a: number, b: number, n: number) => ({
  lo: Math.round((a / 200) * n),
  hi: Math.round((b / 200) * n),
});

interface Meas {
  字: string;
  左名: string;
  右名: string;
  左占200: number;
  右占200: number;
  左占24: number;
  左占48: number;
}

/** 取出一個「左右兩部件」字的兩件墨跡框（依 x 排序） */
function measure(ch: string): Meas | null {
  const cp = ch.codePointAt(0)!;
  const idx = findGlyphIndex(lib, "u" + cp.toString(16));
  if (idx === undefined) return null;
  const g = lib.glyphs[idx]!;
  const refs: { name: string; box: any }[] = [];
  for (let i = 0; i < g.strokes.length; i++) {
    const s = g.strokes[i]!;
    if (s.kind !== 99 || s.ref === null) continue;
    refs.push({ name: lib.names[s.ref]!, box: inkOfRefInParent(lib, idx, i) });
  }
  if (refs.length !== 2) return null;
  // 依中心 x 排序：左、右
  refs.sort((a, b) => (a.box.x1 + a.box.x2) / 2 - (b.box.x1 + b.box.x2) / 2);
  const [L, R] = refs as [typeof refs[0], typeof refs[0]];
  const leftW = L.box.x2 - L.box.x1;
  const rightW = R.box.x2 - R.box.x1;
  const total200 = leftW + rightW;

  // 24 / 48 格下的左件寬度占比（量化後再算）
  const p24 = (() => {
    const a = qz(L.box.x1, L.box.x2, 24), b = qz(R.box.x1, R.box.x2, 24);
    const lw = a.hi - a.lo, rw = b.hi - b.lo;
    return lw / Math.max(1, lw + rw);
  })();
  const p48 = (() => {
    const a = qz(L.box.x1, L.box.x2, 48), b = qz(R.box.x1, R.box.x2, 48);
    const lw = a.hi - a.lo, rw = b.hi - b.lo;
    return lw / Math.max(1, lw + rw);
  })();

  return {
    字: ch, 左名: L.name, 右名: R.name,
    左占200: leftW / total200, 右占200: rightW / total200,
    左占24: p24, 左占48: p48,
  };
}

/** 同左件的字群 */
function group(leftName: string, chars: string[]) {
  const rows: Meas[] = [];
  for (const c of chars) {
    const m = measure(c);
    if (m && m.左名 === leftName) rows.push(m);
  }
  if (rows.length === 0) return;
  console.log(`\n=== 左件 ${leftName}（${rows.map((r) => r.字).join(" ")}）===`);
  console.log("  字    左件名        右件名        左占比@200  左占比@48  左占比@24");
  for (const r of rows) {
    console.log(`  ${r.字}    ${r.左名.padEnd(12)} ${r.右名.padEnd(12)} ` +
      `${(r.左占200 * 100).toFixed(1).padStart(9)}% ${(r.左占48 * 100).toFixed(1).padStart(9)}% ` +
      `${(r.左占24 * 100).toFixed(1).padStart(9)}%`);
  }
  const spread = (key: keyof Meas) => {
    const v = rows.map((r) => r[key] as number);
    return (Math.max(...v) - Math.min(...v)) * 100;
  };
  console.log(`  離散度（最大−最小）：@200 ${spread("左占200").toFixed(1)} 個百分點` +
    `、@48 ${spread("左占48").toFixed(1)}、@24 ${spread("左占24").toFixed(1)}`);
}

group("u6728-01", ["村", "根", "校", "格", "柱", "柤"]);
group("u6c35-01", ["溝", "傋", "購", "搆", "注", "漢"]);

// 全庫統計：所有「左右兩件」的字，左占比的離散度分佈
console.log("\n=== 全庫：左右兩件字的左占比離散度 ===");
const byLeft = new Map<string, number[]>();
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
  const [L, R] = refs as [typeof refs[0], typeof refs[0]];
  const lw = L.box.x2 - L.box.x1, rw = R.box.x2 - R.box.x1;
  const p = lw / Math.max(1, lw + rw);
  const arr = byLeft.get(L.name);
  if (arr) arr.push(p);
  else byLeft.set(L.name, [p]);
}
const spreads: number[] = [];
for (const [, arr] of byLeft) {
  if (arr.length < 3) continue;
  spreads.push((Math.max(...arr) - Math.min(...arr)) * 100);
}
spreads.sort((a, b) => a - b);
const pct = (q: number) => spreads[Math.floor(spreads.length * q)] ?? 0;
console.log(`  納入統計的左件種類：${spreads.length}`);
console.log(`  左占比離散度（百分點）：中位 ${pct(0.5).toFixed(1)}、` +
  `75% 分位 ${pct(0.75).toFixed(1)}、90% 分位 ${pct(0.9).toFixed(1)}、最大 ${spreads[spreads.length - 1]?.toFixed(1)}`);
const tight = spreads.filter((s) => s <= 5).length;
console.log(`  離散度 ≤5 個百分點者：${tight} / ${spreads.length}（${(100 * tight / spreads.length).toFixed(0)}%）` +
  `  ← 這些可共用一個布局模板`);
