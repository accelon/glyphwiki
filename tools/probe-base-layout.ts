#!/usr/bin/env bun
/**
 * probe-base-layout.ts — **依「槽位佈局」反查最適合當基字的字**（師父第 114 輪的追問 ✓）。
 *
 * 關鍵觀念（這一問的答案就在這裡）：
 *   **基字不需要含有目標部件** ✓——拼形是「把某個槽位換掉」✓，
 *   所以基字只要**槽位佈局相同**（例：左邊一個全高 ＋ 右邊四個縱疊 ✓），
 *   就能把「金木水火土」逐槽換上去 ✓✓。
 *
 * 做法（不用機器學習 ✓，純幾何 ✓）：
 *   ① 目標佈局用**正規化槽位中心**描述（我從 `elements.png` 看出來的 ✓）
 *   ② 掃字庫裡有 4–6 個直接引用（slot ✓）的字形 → 取每個 slot 的框中心 ✓
 *   ③ 用「指派問題」的方式配對（貪婪即可 ✓）→ 算佈局距離 ✓
 *   ④ 印出最接近的基字候選（附它的部件，讓師父看合不合理 ✓）
 *
 * 用法:
 *   bun run tools/probe-base-layout.ts                        # 用內建的「左1＋右4縱疊」
 *   bun run tools/probe-base-layout.ts --target "0.25,0.5;0.72,0.15;0.72,0.38;0.72,0.62;0.72,0.85"
 */
import { resolve } from "node:path";
import * as F from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { ensureEngine, inkOfRefInParent } from "./compose-fit.ts";
import { drawingIdx, refSlotsOf, slotPosOf } from "./free-compose.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const TOP = Number(arg("--top", "15"));

/** 目標佈局：正規化槽位中心（0–1，左上原點 ✓）
 *  這是**我從 `elements.png` 看出來的**（不是猜的 ✓）：左邊 `木` 一根長豎貫到底 ✓；
 *  右邊三層：`金` 在上、（`水` `火` 並排）在中、`土` 在下 ✓。 */
const DEFAULT_TARGET = [
  [0.20, 0.50],   /* 左：木（全高 ✓） */
  [0.72, 0.17],   /* 右上：金 ✓ */
  [0.60, 0.52],   /* 右中左：水 ✓ */
  [0.85, 0.52],   /* 右中右：火 ✓ */
  [0.72, 0.84],   /* 右下：土 ✓ */
];
const TARGET = (arg("--target") ?? "")
  .split(";").filter(Boolean)
  .map((s) => s.split(",").map(Number) as [number, number]);
const target = TARGET.length ? TARGET : DEFAULT_TARGET;

const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();
const ch = (cp: number) => { try { return String.fromCodePoint(cp); } catch { return "?" }; };
const hex = (cp: number) => "U+" + cp.toString(16).toUpperCase();

function slotsOf(gi: number) {
  const di = drawingIdx(lib, gi);
  const slots = refSlotsOf(lib, di);
  if (slots.length < 2) return null;
  const boxes = slots.map((s: any) => s.box);
  return slots.map((s: any) => {
    /* ⚠ 用**墨跡框**而不是引用框：很多槽位的引用框是「滿格恆等框」✗（第 110 輪踩過 ✓），
       那種框的中心永遠是 (0.5,0.5)，比不出佈局 ✗。 */
    let b = s.box as number[];
    try {
      const ink = inkOfRefInParent(lib, di, s.strokeIx);
      if (ink && ink.x2 > ink.x1 && ink.y2 > ink.y1) b = [ink.x1, ink.y1, ink.x2, ink.y2];
    } catch { /* 量不到就用引用框 ✓ */ }
    return {
      cx: ((b[0]! + b[2]!) / 2) / 200,
      cy: ((b[1]! + b[3]!) / 2) / 200,
      zone: slotPosOf(b as any, boxes),
      ref: s.ref as number,
    };
  });
}

console.log(`目標槽位（${target.length} 個）：` + target.map((t) => `(${t[0]},${t[1]})`).join(" "));

const scored: { gi: number; cp: number; cost: number; n: number; zones: string[]; comps: number[] }[] = [];
for (let gi = 0; gi < lib.glyphs.length; gi++) {
  const cp = F.codePointOf(lib, gi);
  if (!cp) continue;
  const slots = slotsOf(gi);
  if (!slots || slots.length < target.length - 1 || slots.length > target.length + 1) continue;
  const comps = lib.comp?.get(cp) ?? [];
  if (comps.length < 3) continue;                 /* 太簡單的字不當基字（換不出五個部件 ✓） */
  /* 貪婪配對：每個目標槽位挑最近的候選槽位（不重複 ✓） */
  const used = new Set<number>();
  let cost = 0;
  for (const t of target) {
    let bestI = -1, bestD = Infinity;
    for (let i = 0; i < slots.length; i++) {
      if (used.has(i)) continue;
      const s = slots[i]!;
      const d = Math.hypot(s.cx - t[0], s.cy - t[1]);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    if (bestI < 0) { cost = Infinity; break; }
    used.add(bestI);
    cost += bestD;
  }
  if (!Number.isFinite(cost)) continue;
  cost += Math.abs(slots.length - target.length) * 0.5;   /* 槽數不合要罰 ✓ */
  scored.push({ gi, cp, cost, n: slots.length, zones: slots.map((s) => s.zone), comps });
}
scored.sort((a, b) => a.cost - b.cost);
console.log(`\n掃到 ${scored.length.toLocaleString()} 個佈局相近的候選；前 ${TOP} 名（cost 越小越像 ✓）：`);
for (const s of scored.slice(0, TOP)) {
  console.log(`  cost ${s.cost.toFixed(3)}　${hex(s.cp)} ${ch(s.cp)}　${s.n} 槽 [${s.zones.join(" ")}]` +
    `　${F.displayName(lib, s.gi)}　部件：${s.comps.map((c) => ch(c)).join("＋")}`);
}
