/**
 * probe-form-positions.ts — 探針：**部件位置形**（同一個部件在不同位置用的字形）。
 *
 * 用途：`部件形式.md`（功能構思）的證據來源。回答兩件事：
 *   ① Unihan 的異體關係覆蓋到哪些「左右形」（`金/釒`、`言/訁`…）；
 *   ② 對每個部件，統計它的**每一個字形**在各區位被引用的次數與實測框。
 * 用法: bun run tools/probe-form-positions.ts
 *
 * 產出的數字（2026-10-14）：`釒` 左×904、`訁` 滿×767／中×319、`礻` 左×22、`扌` 左×1,523、
 * `刂` 滿×542（＝它自己畫在右半，用「滿框」）✓ ——位置偏好是**量得出來的** ✓。
 */
import { readFileSync } from "node:fs";
import * as F from "./lib-format.ts";
import { refSlotsOf, slotPosOf } from "./free-compose.ts";
import { loadLibrary } from "./lib-load.ts";

const { lib } = loadLibrary("out/lib-cjk-all.bin.gz", { withNames: true });
const L = lib as any;

/* ---- ① Unihan 的關係 ---- */
const want = ["刀", "刂", "手", "扌", "水", "氵", "心", "忄", "人", "亻", "金", "釒", "钅", "言", "訁", "讠", "示", "礻", "食", "飠", "饣", "衣", "衤", "犬", "犭", "糸", "糹", "纟", "火", "灬", "爪", "爫", "网", "罒", "竹", "𥫗", "肉", "⺼", "月", "阜", "阝", "邑", "玉", "王", "艸", "艹"];
const syn = L.syn as Map<number, number[]>;
const rel = (cp: number) => (syn.get(cp) ?? []).map((x: number) => String.fromCodePoint(x));
console.log("① Unihan 的異體關係（`syn` 圖；只在 syn 裡的就是 Unicode 認定的同一個字）：");
for (const ch of want) {
  const cp = ch.codePointAt(0)!;
  const r = rel(cp);
  if (r.length) console.log(`   ${ch} → ${r.join(" ")}`);
}

/* ---- ② 語料統計：部件 × 形式 × 區位 ---- */
type Key = string;
const stat = new Map<number, Map<string, Map<string, { n: number; box: number[] }>>>();
let scanned = 0;
for (let gi = 0; gi < L.glyphs.length; gi++) {
  const g = L.glyphs[gi];
  if (!g) continue;
  const slots = refSlotsOf(L, gi);
  if (slots.length < 2) continue;                     /* 只有多部件的字才看得出位置 */
  scanned++;
  const boxes = slots.map((s: any) => s.box);
  for (const s of slots) {
    const cp = F.codePointOf(L, s.ref);
    if (!cp) continue;
    const zone = slotPosOf(s.box, boxes);
    const member = F.displayName(L, s.ref);
    let m = stat.get(cp);
    if (!m) { m = new Map(); stat.set(cp, m); }
    let z = m.get(member);
    if (!z) { z = new Map(); m.set(member, z); }
    const rec = z.get(zone);
    if (rec) { rec.n++; } else z.set(zone, { n: 1, box: s.box as number[] });
  }
}
console.log(`\n② 掃過 ${scanned.toLocaleString()} 個多部件字形`);
const show = (ch: string) => {
  const cp = ch.codePointAt(0)!;
  const m = stat.get(cp);
  console.log(`\n${ch} U+${cp.toString(16).toUpperCase()}：`);
  if (!m) { console.log("   （語料裡沒有被當部件引用）"); return; }
  for (const [member, z] of [...m.entries()].sort((a, b) => [...b[1].values()].reduce((s, r) => s + r.n, 0) - [...a[1].values()].reduce((s, r) => s + r.n, 0))) {
    const total = [...z.values()].reduce((s, r) => s + r.n, 0);
    const parts = [...z.entries()].sort((a, b) => b[1].n - a[1].n)
      .map(([zone, r]) => `${zone}×${r.n.toLocaleString()} 框[${r.box.map((v: number) => Math.round(v)).join(",")}]`);
    console.log(`   ${member.padEnd(12)} 共 ${total.toLocaleString()}　${parts.join("　")}`);
  }
};
for (const ch of ["刀", "刂", "手", "扌", "水", "氵", "心", "忄", "人", "亻", "金", "釒", "禾", "示", "礻"]) show(ch);
