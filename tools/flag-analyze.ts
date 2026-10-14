// flag-analyze.ts — 量出「引用旗標」的實際編碼成本，作為合併前後對照
import { readFileSync } from "node:fs";
import { decodeLibrary } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const bin = readFileSync(`${D}/out/lib-cjk.bin`);
const lib = decodeLibrary(new Uint8Array(bin));

const uLen = (n: number) => {
  let v = n >>> 0, c = 1;
  while (v >= 0x80) { v >>>= 7; c++; }
  return c;
};

let nRefs = 0, nFull = 0, nNoStretch = 0;
let bytesNow = 0;
// 舊編碼：isFull 用 pushU(isFull?1:0)、noStretch 用 pushU(noStretch?1:0)
// 兩者的值域都是 0/1，所以各 1 byte。
for (const g of lib.glyphs) {
  for (const s of g.strokes) {
    if (s.kind !== 99) continue;
    nRefs++;
    const b = s.box!, st = s.stretch!;
    const isFull = b[0] === 0 && b[1] === 0 && b[2] === 200 && b[3] === 200;
    const noStretch = st[0] === 0 && st[1] === 0 && st[2] === 0 && st[3] === 0;
    if (isFull) nFull++;
    if (noStretch) nNoStretch++;
    bytesNow += uLen(isFull ? 1 : 0) + uLen(noStretch ? 1 : 0);
  }
}

const bytesMerged = nRefs * 1; // 合併後每筆固定 1 byte

console.log(`引用筆數            ${nRefs.toLocaleString()}`);
console.log(`  滿格框（isFull）  ${nFull.toLocaleString()}（${(100 * nFull / nRefs).toFixed(1)}%）`);
console.log(`  無伸縮（noStretch）${nNoStretch.toLocaleString()}（${(100 * nNoStretch / nRefs).toFixed(1)}%）`);
console.log("");
console.log(`旗標位元組（現行）  ${bytesNow.toLocaleString()}  (${(100 * bytesNow / bin.length).toFixed(1)}% of ${bin.length.toLocaleString()})`);
console.log(`旗標位元組（合併後）${bytesMerged.toLocaleString()}  (${(100 * bytesMerged / bin.length).toFixed(1)}%)`);
console.log(`可省                ${(bytesNow - bytesMerged).toLocaleString()} bytes` +
  ` = ${((bytesNow - bytesMerged) / 1024).toFixed(1)} KB`);
console.log("");
// 四種旗標組合的分佈（確認 bit field 夠用）
const combo = new Map<string, number>();
for (const g of lib.glyphs) {
  for (const s of g.strokes) {
    if (s.kind !== 99) continue;
    const b = s.box!, st = s.stretch!;
    const isFull = b[0] === 0 && b[1] === 0 && b[2] === 200 && b[3] === 200;
    const noStretch = st[0] === 0 && st[1] === 0 && st[2] === 0 && st[3] === 0;
    const k = `isFull=${isFull ? 1 : 0} noStretch=${noStretch ? 1 : 0}`;
    combo.set(k, (combo.get(k) ?? 0) + 1);
  }
}
console.log("四種組合分佈：");
for (const [k, v] of [...combo.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}  ${v.toLocaleString().padStart(7)}  (${(100 * v / nRefs).toFixed(1)}%)`);
}
console.log(`\n四種組合 → 只需 2 bits，1 byte 的 bit field 充裕（剩 6 bits 可擴充）`);
