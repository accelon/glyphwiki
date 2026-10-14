#!/usr/bin/env bun
/**
 * check-component-boxes.ts — 驗證 `componentBoxes()`。
 *
 * 三件事要對：
 *   1. 部件的**身分與順序**（含重複次數，林＝兩個木）
 *   2. 墨跡緊框要**精確**——拿點陣當獨立第二意見（點陣是實際渲染）
 *   3. 緊框不比原始框大、且落在畫布附近
 */
import { resolve } from "node:path";
import * as F from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { ensureEngine } from "./compose-fit.ts";
import { rasterize } from "./raster.ts";
import { componentBoxes, inkBoundsOfPolys, hasComponents } from "./component-boxes.ts";
import type { Box } from "./component-boxes.ts";

const ROOT = resolve(import.meta.dir, "..");
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();
const Kage = (globalThis as any).Kage;
const Polygons = (globalThis as any).Polygons;

let bad = 0;
const ok = (s: string) => console.log("  ✓ " + s);
const fail = (s: string) => { bad++; console.log("  ✗ " + s); };

function kageFor(idxs: number[]) {
  const kage = new Kage();
  const seen = new Set<number>(); const stack = [...idxs];
  while (stack.length) {
    const j = stack.pop()!;
    if (seen.has(j)) continue;
    seen.add(j);
    const g = lib.glyphs[j]!;
    kage.kBuhin.push(F.keyOfIdx(lib, j), F.toKageData(g, lib));
    for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  return kage;
}
/** 用引擎的多邊形量墨跡——這是正式路徑，兩個頁面都用這個 */
const inkMemo = new Map<number, Box | null>();
function engineInk(gi: number): Box | null {
  const hit = inkMemo.get(gi);
  if (hit !== undefined) return hit;
  const polys = new Polygons();
  kageFor([gi]).makeGlyph(polys, F.keyOfIdx(lib, gi));
  const b = inkBoundsOfPolys(polys);
  inkMemo.set(gi, b);
  return b;
}
/** 點陣量到的墨跡 bbox（獨立第二意見） */
function rasterInk(i: number, size = 200): Box | null {
  const cov = rasterize(kageFor([i]), F.keyOfIdx(lib, i), size, 1).cov;
  let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (cov[y * size + x]! > 0.35) {
      if (x < x1) x1 = x; if (x > x2) x2 = x;
      if (y < y1) y1 = y; if (y > y2) y2 = y;
    }
  }
  return x2 < x1 ? null : [x1, y1, x2 + 1, y2 + 1];
}
const r0 = (v: number) => Math.round(v);
/* 注意：codePointOf() 對「沒有碼位」回傳的是 **0**，不是 undefined。
   用 `cp != null` 判斷會把 0 當成有效碼位，String.fromCodePoint(0) 印出 NUL（看起來像空白）。 */
const label = (i: number) => {
  const cp = F.codePointOf(lib, i);
  return cp ? String.fromCodePoint(cp) : F.displayName(lib, i);
};

console.log("=== 1. 部件身分與順序（含重複次數）===");
/* 期望值是照**實際結構**寫的，不是照 IDS 課本：
   品的 IDS 是「口 吅」，但 KAGE 是三個口引用、0 條原始筆劃——
   「吅」只是結構分組，沒有被單獨畫出來，不該進清單。
   器 同理（兩個引用、0 條原始筆劃）。 */
const CASES: [string, number, string[]][] = [
  ["邏", 0x908f, ["辶", "羅"]],
  ["杏", 0x674f, ["口", "木"]],
  ["林", 0x6797, ["木", "木"]],
  ["品", 0x54c1, ["口", "口", "口"]],
  /* 想（2026-10-14 改）：`想` 的畫法是「引用 目 ＋ 引用 心 ＋ 手畫 4 筆（＝木）」，
     IDS 卻是 `⿱相心` —— 依 `componentBoxes()` 的規則（**配到了引用就不新增一格**，
     把既有那一格換上 IDS 分量的身分：一格、一個名字、一個框），正確結果是 `相 心` ✓。
     舊期望 `目 心 相` 是**異體表被 `∅`(U+2205) 污染**時的產物（`synKeyOf(相)` 與別的字碰撞，
     那個分量於是被當成「沒有引用可配」而多長出第三格）。見 `組字結構.md` §6.22。 */
  ["想", 0x60f3, ["相", "心"]],
  ["器", 0x5668, ["u2ff1-u5405-u5927-03", "吅"]],
];
for (const [ch, cp, want] of CASES) {
  const gi = F.indexOfCodePoint(lib, cp);
  if (gi === undefined) { fail(`${ch} 不在庫中`); continue; }
  const boxes = componentBoxes(lib, gi, engineInk);
  const got = boxes.map((b) => label(b.ref));
  const same = got.length === want.length && got.every((x, i) => x === want[i]);
  const marks = boxes.map((b) => (b.idsOnly ? "IDS" : "KAGE")).join(",");
  same ? ok(`${ch}：${got.join(" ")}　（來源 ${marks}，原始筆劃 ${lib.glyphs[gi]!.strokes.filter((s) => s.kind !== 99 && s.kind !== 0).length} 條）`)
       : fail(`${ch}：得到 ${got.join(" ")}，預期 ${want.join(" ")}`);
}

console.log("\n=== 2. 墨跡緊框：引擎多邊形 vs 點陣（兩個獨立算法）===");
for (const cp of [0x53e3, 0x6728, 0x5fc3, 0x76ee, 0x674f, 0x60f3, 0x5668, 0x908f, 0x6797]) {
  const gi = F.indexOfCodePoint(lib, cp);
  if (gi === undefined) continue;
  const a = engineInk(gi), b = rasterInk(gi);
  const ch = String.fromCodePoint(cp).padEnd(2);
  if (!a || !b) { fail(`${ch} 量不到墨跡`); continue; }
  /* 兩者都來自實際描繪，差別只剩點陣的格點化（每邊 <2 格）*/
  const d = Math.max(...[0, 1, 2, 3].map((i) => Math.abs(a[i]! - b[i]!)));
  d <= 2
    ? ok(`${ch} 多邊形 [${a.map(r0).join(",")}]　點陣 [${b.map(r0).join(",")}]　最大差 ${r0(d)}`)
    : fail(`${ch} 兩者差 ${r0(d)} 格：多邊形 [${a.map(r0).join(",")}] vs 點陣 [${b.map(r0).join(",")}]`);
}

console.log("\n=== 3. 框落在畫布附近，且緊框不比原始框大 ===");
for (const [ch, cp] of [["邏", 0x908f], ["杏", 0x674f], ["器", 0x5668], ["想", 0x60f3]] as [string, number][]) {
  const gi = F.indexOfCodePoint(lib, cp)!;
  const area = (b: Box) => Math.abs(b[2] - b[0]) * Math.abs(b[3] - b[1]);
  for (const bx of componentBoxes(lib, gi, engineInk)) {
    if (bx.idsOnly) { console.log(`  · ${ch} 的 ${label(bx.ref)}：IDS-only，不畫框（raw/tight 皆 null）`); continue; }
    const raw = bx.raw!, tight = bx.tight!;
    const shrunk = area(tight) <= area(raw) + 1;
    const sane = tight.every((v) => v >= -30 && v <= 230);
    shrunk && sane
      ? ok(`${ch} 的 ${label(bx.ref)}：原始 ${r0(area(raw) / 400)}% → 緊框 ${r0(area(tight) / 400)}%`)
      : fail(`${ch} 的 ${label(bx.ref)}：緊框不合理 ${r0(area(raw) / 400)}% → ${r0(area(tight) / 400)}%　` +
             `[${tight.map(r0).join(",")}]`);
  }
}

console.log("\n=== 4. 能不能當基字（hasComponents）===");
for (const [ch, cp, want] of [["一", 0x4e00, false], ["木", 0x6728, false], ["杏", 0x674f, true], ["想", 0x60f3, true], ["品", 0x54c1, true]] as [string, number, boolean][]) {
  const gi = F.indexOfCodePoint(lib, cp)!;
  const got = hasComponents(lib, gi);
  got === want ? ok(`${ch}：${got ? "可當基字" : "獨體字"}`) : fail(`${ch}：得到 ${got}，預期 ${want}`);
}

console.log(bad ? `\n✗ 有 ${bad} 項不通過` : "\n✓ 全部通過");
process.exit(bad ? 1 : 0);
