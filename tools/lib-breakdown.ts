// lib-breakdown.ts — 精確拆解 lib-cjk.bin 2,494,265 bytes 花在哪裡
import { readFileSync } from "node:fs";
import { decodeLibrary } from "./lib-format.ts";
import type { Library } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const bin = readFileSync(`${D}/out/lib-cjk.bin`);
const lib: Library = decodeLibrary(new Uint8Array(bin));
console.log(`總大小 ${bin.length.toLocaleString()} bytes\n`);

/** zigzag varint 的位元組數 */
const zigLen = (n: number) => {
  let v = ((n << 1) ^ (n >> 31)) >>> 0, c = 1;
  while (v >= 0x80) { v >>>= 7; c++; }
  return c;
};
const uLen = (n: number) => {
  let v = n >>> 0, c = 1;
  while (v >= 0x80) { v >>>= 7; c++; }
  return c;
};

// 1) 名字表
let nameBytes = uLen(lib.names.length) + uLen(lib.suffix.length);
for (const s of lib.suffix) { nameBytes += uLen(s.length); for (const ch of s) nameBytes += uLen(ch.charCodeAt(0)); }
let uForm = 0, otherForm = 0;
for (const n of lib.names) {
  const m = /^u([0-9a-f]{4,6})(-.*)?$/i.exec(n);
  if (m) { uForm++; nameBytes += uLen(parseInt(m[1]!, 16)) + uLen(m[2] ? 1 : 0); }
  else { otherForm++; nameBytes += uLen(0) + uLen(n.length); for (const ch of n) nameBytes += uLen(ch.charCodeAt(0)); }
}
console.log(`名字表            ${nameBytes.toLocaleString().padStart(9)} bytes  (${(100 * nameBytes / bin.length).toFixed(1)}%)`);

// 2) 逐字形拆解
let nStrBytes = 0, kindBytes = 0;
let refBytes = 0, refIndexBytes = 0, refFlagBytes = 0, refBoxBytes = 0, refStretchBytes = 0;
let strokeBytes = 0, strokeWidStyBytes = 0, strokeCoordBytes = 0;
let nRefs = 0, nStrokes = 0, nFullBox = 0, nNoStretch = 0;

for (const g of lib.glyphs) {
  // 緊框已不再是檔案的一部分（由內容衍生）→ 不計入
  nStrBytes += uLen(g.strokes.length);
  for (const s of g.strokes) {
    kindBytes += uLen(s.kind);
    if (s.kind === 99) {
      nRefs++;
      const b = s.box!, st = s.stretch!;
      const isFull = b[0] === 0 && b[1] === 0 && b[2] === 200 && b[3] === 200;
      const noStretch = st[0] === 0 && st[1] === 0 && st[2] === 0 && st[3] === 0;
      if (isFull) nFullBox++;
      if (noStretch) nNoStretch++;
      refIndexBytes += 2;                       // ref 索引（多為 2 bytes）
      refFlagBytes += uLen(isFull ? 1 : 0);
      if (!isFull) for (const v of b) refBoxBytes += zigLen(v);
      refFlagBytes += uLen(noStretch ? 1 : 0);
      if (!noStretch) for (const v of st) refStretchBytes += zigLen(v);
      refBytes = refIndexBytes + refFlagBytes + refBoxBytes + refStretchBytes;
    } else {
      nStrokes++;
      strokeWidStyBytes += zigLen(s.width) + zigLen(s.style);
      for (const v of s.points) strokeCoordBytes += zigLen(v);
      strokeBytes = strokeWidStyBytes + strokeCoordBytes;
    }
  }
}

const rows: [string, number][] = [
  ["筆數欄位", nStrBytes],
  ["kind 欄位", kindBytes],
  ["引用：ref 索引", refIndexBytes],
  ["引用：框", refBoxBytes],
  ["引用：伸縮", refStretchBytes],
  ["引用：旗標", refFlagBytes],
  ["筆畫：width+style", strokeWidStyBytes],
  ["筆畫：座標", strokeCoordBytes],
];
const sum = rows.reduce((s, [, v]) => s + v, 0) + nameBytes;
for (const [k, v] of rows.sort((a, b) => b[1] - a[1])) {
  console.log(`${k.padEnd(20)} ${v.toLocaleString().padStart(9)} bytes  (${(100 * v / bin.length).toFixed(1)}%)`);
}
console.log(`${"名字表".padEnd(20)} ${nameBytes.toLocaleString().padStart(9)} bytes  (${(100 * nameBytes / bin.length).toFixed(1)}%)`);
console.log(`${"合計".padEnd(20)} ${sum.toLocaleString().padStart(9)} bytes  (${(100 * sum / bin.length).toFixed(1)}%)`);

console.log(`\n引用 ${nRefs.toLocaleString()} 筆（滿格框 ${nFullBox.toLocaleString()}、無伸縮 ${nNoStretch.toLocaleString()}）`);
console.log(`一般筆畫 ${nStrokes.toLocaleString()} 筆（每筆 8 個座標 = ${(nStrokes * 8).toLocaleString()} 個座標值）`);
console.log(`\n座標值佔全庫 ${(100 * (strokeCoordBytes + refBoxBytes) / bin.length).toFixed(1)}%`);
console.log(`名字表 + 索引 + 旗標 + kind 佔 ${(100 * (nameBytes + refIndexBytes + refFlagBytes + kindBytes + nStrBytes + strokeWidStyBytes) / bin.length).toFixed(1)}%`);
