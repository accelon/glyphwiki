// layout-band-savings.ts — 量「(左件, 寬度比帶) 模板」策略的實際節省
//
// 做法：把所有「幾乎是左右兩件」的字，用 (左件, 寬度比帶) 分群，
// 每群取其「代表性框」（群內中位數），群內其他字就用這個框。
// 量：(a) 模板數 (b) 改用代表性框的位移代價 (c) 位元組節省。
import { readFileSync } from "node:fs";
import { decodeLibrary } from "./lib-format.ts";
import { inkOfRefInParent, inkIn } from "./compose-fit.ts";
import type { Library } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

interface Rec {
  gi: number;            // 字形索引
  left: string; right: string;
  rw: number; lw: number;
  boxes: number[][];     // 所有直接引用的框（原樣，用於重建）
  refIdx: number[];      // 對應的字形索引
  ratio: number;         // rw/lw
}

console.log("收集…");
const recs: Rec[] = [];
for (let i = 0; i < lib.names.length; i++) {
  const n = lib.names[i]!;
  if (!/^u[0-9a-f]{4,6}$/.test(n)) continue;
  const g = lib.glyphs[i]!;
  const refs: { name: string; box: any; ref: number; k: number }[] = [];
  for (let k = 0; k < g.strokes.length; k++) {
    const s = g.strokes[k]!;
    if (s.kind !== 99 || s.ref === null) continue;
    refs.push({ name: lib.names[s.ref]!, box: inkOfRefInParent(lib, i, k), ref: s.ref, k });
  }
  if (refs.length !== 2) continue;
  refs.sort((a, b) => (a.box.x1 + a.box.x2) / 2 - (b.box.x1 + b.box.x2) / 2);
  const L = refs[0]!, R = refs[1]!;
  const lw = L.box.x2 - L.box.x1, rw = R.box.x2 - R.box.x1;
  if (lw < 20 || rw < 20) continue;
  recs.push({
    gi: i, left: L.name, right: R.name, rw, lw,
    boxes: g.strokes.filter((s) => s.kind === 99).map((s) => s.box!.slice()),
    refIdx: g.strokes.filter((s) => s.kind === 99).map((s) => s.ref!),
    ratio: rw / lw,
  });
}
console.log(`左右兩件的字：${recs.length}`);

/** 依 (左件, 寬度比帶) 分群；帶數可調 */
function buildTemplates(nb: number) {
  const byLeft = new Map<string, Rec[]>();
  for (const r of recs) {
    const a = byLeft.get(r.left);
    if (a) a.push(r); else byLeft.set(r.left, [r]);
  }
  const templates = new Map<string, { box: number[]; n: number }>(); // key = left + "#" + band
  const assign = new Map<number, number>(); // recIndex → band
  // 等頻分帶
  const allRatios = recs.map((r) => r.ratio).sort((a, b) => a - b);
  const cut = (q: number) => allRatios[Math.min(allRatios.length - 1, Math.floor(allRatios.length * q))]!;
  const edges = [0.25, 0.5, 0.75].slice(0, nb - 1).map(cut);
  const bandOf = (v: number) => {
    let b = 0;
    for (const e of edges) if (v > e) b++;
    return b;
  };
  recs.forEach((r, i) => assign.set(i, bandOf(r.ratio)));
  for (const [left, arr] of byLeft) {
    for (let b = 0; b < nb; b++) {
      const group = arr.filter((r) => assign.get(recs.indexOf(r)) === b);
      if (group.length === 0) continue;
      // 代表性框：群內「左件墨跡框」的中位數
      const leftBoxes = group.map((r) => r.boxes[0]!);
      const med = (idx: number) => {
        const v = leftBoxes.map((b) => b[idx]!).sort((a, b) => a - b);
        return v[Math.floor(v.length / 2)]!;
      };
      templates.set(`${left}#${b}`, { box: [med(0), med(1), med(2), med(3)], n: group.length });
    }
  }
  return { templates, assign, bandOf, byLeft };
}

/** 評估某個帶數：模板數、位移代價、位元組節省 */
function evaluate(nb: number) {
  const { templates, assign, bandOf } = buildTemplates(nb);
  const byLeft = new Map<string, Rec[]>();
  for (const r of recs) {
    const a = byLeft.get(r.left);
    if (a) a.push(r); else byLeft.set(r.left, [r]);
  }
  let sumShift = 0, nShift = 0, maxShift = 0;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]!;
    const t = templates.get(`${r.left}#${assign.get(i)}`);
    if (!t) continue;
    // 位移：把原框的四個座標與模板框比較（量左件的挪動）
    const b = r.boxes[0]!;
    const d = Math.max(
      Math.abs(b[0]! - t.box[0]!), Math.abs(b[1]! - t.box[1]!),
      Math.abs(b[2]! - t.box[2]!), Math.abs(b[3]! - t.box[3]!),
    );
    sumShift += d; nShift++;
    if (d > maxShift) maxShift = d;
  }
  // 位元組估算：
  //   現行：每個字存 2 個框（每個框 4 個 zigzag varint，約 1.5 bytes each）= 12 bytes
  //   模板化：每個字存 1 個模板索引（2 bytes）；模板表每筆約 12 bytes
  const now = recs.length * 12;
  const after = templates.size * 12 + recs.length * 2;
  return {
    nb, templates: templates.size,
    meanShift: sumShift / Math.max(1, nShift), maxShift,
    now, after, save: 1 - after / now,
  };
}

console.log("\n=== 帶數 vs 模板數 / 位移 / 節省 ===");
console.log("  帶數  模板數   平均位移(格)  最大位移  節省(這部分的框資料)");
for (const nb of [1, 2, 3, 4, 6, 8]) {
  const r = evaluate(nb);
  console.log(`  ${String(nb).padStart(3)}  ${String(r.templates).padStart(6)}   ${r.meanShift.toFixed(1).padStart(11)}  ${r.maxShift.toFixed(1).padStart(8)}  ${(r.save * 100).toFixed(0).padStart(6)}%`);
}

// 對整體庫的影響：目前 lib-cjk.bin 2,494,265 bytes
console.log("\n=== 對整體精簡庫（2,494,265 bytes）的影響 ===");
for (const nb of [3, 4, 6]) {
  const r = evaluate(nb);
  const delta = (r.now - r.after);
  console.log(`  ${nb} 帶：這部分框資料省 ${(delta / 1024).toFixed(0)} KB，` +
    `約占全庫 ${(100 * delta / 2494265).toFixed(1)}%`);
}
void inkIn;
