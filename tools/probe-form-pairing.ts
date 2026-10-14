/**
 * probe-form-pairing.ts — 探針：用「IDS 分量 ↔ 畫法引用」的**配對**統計形式表。
 *
 * 為什麼這是對的來源：畫法裁判（`build-library.ts` 的 judge）已經把
 * 「IDS 說這裡是 `手`」與「畫法引用的是 `扌`」配在一起了 ✓——
 * 這是**逐字、逐槽位**的證據，不是「用 IDS 版本差異推論」✗。
 * 用法: bun run tools/probe-form-pairing.ts
 *
 * 產出的數字（2026-10-14）：93,351 個字、14,420 組不同碼位的配對；
 * 其中 `金→釒` 左×904／中×627／滿×220（最強的一組）✓。
 * ⚠ 覆蓋不全：IDS 來源本身已經用形式（`打` 就寫 `扌`）時不會產生配對 ✗
 *   ——所以形式群還要靠 IDS 用法／Unihan／師父的表（見 `部件形式.md` §2.2）。
 */
import { readFileSync } from "node:fs";
import * as F from "./lib-format.ts";
import { refSlotsOf, slotPosOf, drawingIdx } from "./free-compose.ts";
import { synKeyOf } from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";

const { lib } = loadLibrary("out/lib-cjk-all.bin.gz", { withNames: true });
const L = lib as any;
const ch = (cp: number | null | undefined) => (cp ? String.fromCodePoint(cp) : "∅");

/* (部件碼位, 區位) → 畫法引用碼位 → 次數 / 框樣本 */
const table = new Map<number, Map<string, Map<number, { n: number; box: number[] }>>>();
let pairs = 0, glyphs = 0;
for (let gi0 = 0; gi0 < L.glyphs.length; gi0++) {
  const cp0 = F.codePointOf(L, gi0);
  if (!cp0) continue;
  if (F.indexOfCodePoint(L, cp0) !== gi0) continue;         /* 只看代表字形 */
  const comps = L.comp?.get(cp0);
  if (!comps || comps.length < 2) continue;
  const gi = drawingIdx(L, gi0);
  const slots = refSlotsOf(L, gi);
  if (slots.length < 2) continue;
  const boxes = slots.map((s: any) => s.box);
  /* 逐槽位配對：引用碼位如果在 comps 裡就是同一個；否則按序配一個沒被點名的分量 */
  const remaining = comps.map((c: number) => synKeyOf(L, c));
  const unclaimed: number[] = [];
  for (let k = 0; k < slots.length; k++) {
    const rc = F.codePointOf(L, slots[k]!.ref);
    const key = rc ? synKeyOf(L, rc) : null;
    const at = key !== null ? remaining.indexOf(key) : -1;
    if (at >= 0) remaining[at] = -1;
    else unclaimed.push(k);
  }
  let ui = 0;
  glyphs++;
  for (let k = 0; k < comps.length; k++) {
    const c = comps[k]!;
    if (remaining[k] === -1) continue;                       /* 已由同碼引用認領 */
    const slotIx = unclaimed[ui++];
    if (slotIx === undefined) break;
    const refCp = F.codePointOf(L, slots[slotIx]!.ref);
    if (!refCp || refCp === c) continue;
    const zone = slotPosOf(boxes[slotIx], boxes);
    let m = table.get(c);
    if (!m) { m = new Map(); table.set(c, m); }
    let z = m.get(zone);
    if (!z) { z = new Map(); m.set(zone, z); }
    const rec = z.get(refCp);
    if (rec) rec.n++; else z.set(refCp, { n: 1, box: slots[slotIx]!.box as number[] });
    pairs++;
  }
}
console.log(`掃過 ${glyphs.toLocaleString()} 個字、配到 ${pairs.toLocaleString()} 個「IDS 分量 ↔ 畫法引用」不同碼位的配對\n`);

const show = (c: string) => {
  const cp = c.codePointAt(0)!;
  const m = table.get(cp);
  if (!m) { console.log(`${c}：（沒有不同碼位的配對）\n`); return; }
  console.log(`${c} U+${cp.toString(16).toUpperCase()}：`);
  for (const [zone, z] of [...m.entries()]) {
    const top = [...z.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 3)
      .map(([rc, r]) => `${ch(rc)}×${r.n.toLocaleString()} 框[${r.box.map((v: number) => Math.round(v)).join(",")}]`);
    console.log(`   ${zone.padEnd(4)} ${top.join("　")}`);
  }
  console.log("");
};
for (const c of ["手", "水", "心", "人", "刀", "金", "言", "示", "犬", "衣", "食", "糸", "火", "邑", "阜", "肉", "玉", "竹", "网", "爪"]) show(c);
