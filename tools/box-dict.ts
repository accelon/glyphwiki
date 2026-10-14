// box-dict.ts — 框字典化：把差異很小的框歸成一類，選代表共用
//
// 使用者提議：框是人手隨意微調的，200×200 下差幾格不是問題。
// 所以把所有引用框聚類，每類選一個代表，其他引用只存「代表索引」。
//
// 量三件事：(a) 需要幾個代表框 (b) 位移代價 (c) 位元組節省（未壓縮與 gzip）
import { readFileSync } from "node:fs";
import { decodeLibrary } from "./lib-format.ts";
import type { Library } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

interface B { x1: number; y1: number; x2: number; y2: number }
const boxes: B[] = [];
// 記錄每個引用框屬於哪個字形/第幾筆（重建用）
const where: { gi: number; si: number }[] = [];
for (let gi = 0; gi < lib.glyphs.length; gi++) {
  const g = lib.glyphs[gi]!;
  for (let si = 0; si < g.strokes.length; si++) {
    const s = g.strokes[si]!;
    if (s.kind !== 99) continue;
    boxes.push({ x1: s.box![0]!, y1: s.box![1]!, x2: s.box![2]!, y2: s.box![3]! });
    where.push({ gi, si });
  }
}
console.log(`引用框總數 ${boxes.length.toLocaleString()}`);

/** 兩個框的最大座標差（L∞） */
function dist(a: B, b: B): number {
  return Math.max(
    Math.abs(a.x1 - b.x1), Math.abs(a.y1 - b.y1),
    Math.abs(a.x2 - b.x2), Math.abs(a.y2 - b.y2),
  );
}

/** 貪婪聚類：門檻 t 內歸入既有類，否則開新類 */
function cluster(t: number) {
  const reps: B[] = [];
  let sumErr = 0, maxErr = 0, worst = 0;
  for (const b of boxes) {
    let bestI = -1, bestD = Infinity;
    for (let i = 0; i < reps.length; i++) {
      const d = dist(b, reps[i]!);
      if (d < bestD) { bestD = d; bestI = i; }
      if (bestD === 0) break;
    }
    if (bestI >= 0 && bestD <= t) {
      sumErr += bestD;
      if (bestD > maxErr) { maxErr = bestD; worst = bestI; }
    } else {
      reps.push(b);
    }
  }
  return { reps: reps.length, sumErr, maxErr, n: boxes.length };
}

console.log("\n=== 框字典化：門檻 vs 代表框數 vs 位移代價 ===");
console.log("  門檻(格)  代表框數   平均位移   最大位移");
const rows: { t: number; reps: number; mean: number; max: number }[] = [];
for (const t of [0, 1, 2, 3, 4, 6, 8, 12]) {
  const r = cluster(t);
  const mean = r.n > 0 ? r.sumErr / r.n : 0;
  rows.push({ t, reps: r.reps, mean, max: r.maxErr });
  console.log(`  ${String(t).padStart(6)}  ${String(r.reps).padStart(9)}  ${mean.toFixed(2).padStart(8)}  ${r.maxErr.toFixed(2).padStart(8)}`);
}

// ---- 位元組節省 ----
const uLen = (n: number) => { let v = n >>> 0, c = 1; while (v >= 0x80) { v >>>= 7; c++; } return c; };
const zigLen = (n: number) => uLen(((n << 1) ^ (n >> 31)) >>> 0);

console.log("\n=== 位元組節省（用各門檻的代表框重新編碼）===");
console.log("  門檻   框的位元組(現行)   框的位元組(字典)   節省       gzip節省");

/** 用指定的代表框集合重新編碼整個庫的「框」部分，量 gzip */
function encodeWithDict(t: number) {
  // 建字典
  const reps: B[] = [];
  const assign = new Int32Array(boxes.length);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!;
    let bestI = -1, bestD = Infinity;
    for (let k = 0; k < reps.length; k++) {
      const d = dist(b, reps[k]!);
      if (d < bestD) { bestD = d; bestI = k; }
      if (bestD === 0) break;
    }
    if (bestI >= 0 && bestD <= t) assign[i] = bestI;
    else { assign[i] = reps.length; reps.push(b); }
  }
  // 編碼：字典（每筆 4 個 zigzag）+ 每筆引用一個索引
  const bin: number[] = [];
  const pushU = (n: number) => { let v = n >>> 0; while (v >= 0x80) { bin.push((v & 0x7f) | 0x80); v >>>= 7; } bin.push(v); };
  const pushS = (n: number) => { let v = ((n << 1) ^ (n >> 31)) >>> 0; while (v >= 0x80) { bin.push((v & 0x7f) | 0x80); v >>>= 7; } bin.push(v); };
  pushU(reps.length);
  for (const r of reps) { pushS(r.x1); pushS(r.y1); pushS(r.x2); pushS(r.y2); }
  for (let i = 0; i < boxes.length; i++) pushU(assign[i]!);
  const buf = Buffer.from(bin);
  return { dictBytes: buf.length, gz: Bun.gzipSync(buf, { level: 9 }).length };
}

/** 現行的框編碼：滿格只寫旗標，否則 4 個 zigzag */
function encodeCurrent() {
  const bin: number[] = [];
  const pushU = (n: number) => { let v = n >>> 0; while (v >= 0x80) { bin.push((v & 0x7f) | 0x80); v >>>= 7; } bin.push(v); };
  const pushS = (n: number) => { let v = ((n << 1) ^ (n >> 31)) >>> 0; while (v >= 0x80) { bin.push((v & 0x7f) | 0x80); v >>>= 7; } bin.push(v); };
  for (const b of boxes) {
    const isFull = b.x1 === 0 && b.y1 === 0 && b.x2 === 200 && b.y2 === 200;
    pushU(isFull ? 1 : 0);
    if (!isFull) { pushS(b.x1); pushS(b.y1); pushS(b.x2); pushS(b.y2); }
  }
  const buf = Buffer.from(bin);
  return { bytes: buf.length, gz: Bun.gzipSync(buf, { level: 9 }).length };
}

const cur = encodeCurrent();
console.log(`  現行             ${String(cur.bytes).padStart(14)}   ${String(cur.gz).padStart(14)}`);
for (const t of [0, 2, 3, 4, 6]) {
  const d = encodeWithDict(t);
  const save = (100 * (cur.bytes - d.dictBytes)) / cur.bytes;
  const gsave = (100 * (cur.gz - d.gz)) / cur.gz;
  console.log(`  ${String(t).padStart(4)}     ${String(d.dictBytes).padStart(14)}   ` +
    `${(save.toFixed(1) + "%").padStart(14)}   ${(gsave.toFixed(1) + "%").padStart(8)}`);
}
void zigLen;
