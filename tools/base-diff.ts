// base-diff.ts — 找出「重編碼 1,678,050」與「實際 1,952,546」的 274,496 bytes 落差
import { readFileSync } from "node:fs";
import { decodeLibrary } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const actual = readFileSync(`${D}/out/lib-cjk.bin`);
const lib = decodeLibrary(new Uint8Array(actual));

const SUFFIXES = [...new Set(lib.names.map((n) => {
  const m = /^u[0-9a-f]{4,6}(-.*)?$/i.exec(n);
  return m && m[1] ? m[1] : null;
}).filter((x): x is string => x !== null))];
console.log(`names ${lib.names.length}  SUFFIXES ${SUFFIXES.length}`);

// 逐段量出「實際檔案」與「重編碼」的位元組，找出差異段
const uLen = (n: number) => { let v = n >>> 0, c = 1; while (v >= 0x80) { v >>>= 7; c++; } return c; };
const zigLen = (n: number) => uLen(((n << 1) ^ (n >> 31)) >>> 0);

// --- 實際檔案的段落 ---
let p = 0;
const rvRaw = () => { let v = 0, s = 0; for (;;) { const b = actual[p++]!; v |= (b & 0x7f) << s; if ((b & 0x80) === 0) return v >>> 0; s += 7; } };
const unzig = (u: number) => (u >>> 1) ^ -(u & 1);
const rv = () => unzig(rvRaw());

const n = rvRaw(), ns = rvRaw();
const afterHeader = p;
const suffix: string[] = [];
for (let i = 0; i < ns; i++) { const len = rvRaw(); let s = ""; for (let j = 0; j < len; j++) s += String.fromCharCode(rvRaw()); suffix.push(s); }
const afterSuffix = p;
const names: string[] = [];
for (let i = 0; i < n; i++) {
  const cp = rvRaw();
  if (cp !== 0) { const six = rvRaw(); names[i] = "u" + cp.toString(16).toLowerCase() + (six ? suffix[six - 1]! : ""); }
  else { const len = rvRaw(); let s = ""; for (let j = 0; j < len; j++) s += String.fromCharCode(rvRaw()); names[i] = s; }
}
const afterNames = p;

console.log(`\n=== 實際檔案的段落邊界 ===`);
console.log(`  檔頭（2 個計數）    ${afterHeader} bytes`);
console.log(`  後綴表             ${afterSuffix - afterHeader} bytes`);
console.log(`  名字表             ${afterNames - afterSuffix} bytes`);
console.log(`  字形資料           ${actual.length - afterNames} bytes`);
console.log(`  合計               ${actual.length} bytes`);

// --- 重編碼的段落估算 ---
let hdr = uLen(lib.names.length) + uLen(SUFFIXES.length);
let suf = 0;
for (const s of SUFFIXES) { suf += uLen(s.length); for (const ch of s) suf += uLen(ch.charCodeAt(0)); }
let nm = 0;
for (const x of lib.names) {
  const m = /^u([0-9a-f]{4,6})(-.*)?$/i.exec(x);
  if (m) nm += uLen(parseInt(m[1]!, 16)) + uLen(m[2] ? 1 : 0);
  else { nm += uLen(0) + uLen(x.length); for (const ch of x) nm += uLen(ch.charCodeAt(0)); }
}
let gl = 0;
for (const g of lib.glyphs) {
  gl += uLen(g.strokes.length);
  for (const s of g.strokes) {
    gl += uLen(s.kind);
    if (s.kind === 99) {
      const b = s.box!, st = s.stretch!;
      const isFull = b[0] === 0 && b[1] === 0 && b[2] === 200 && b[3] === 200;
      const noStretch = st[0] === 0 && st[1] === 0 && st[2] === 0 && st[3] === 0;
      gl += uLen((isFull ? 1 : 0) | (noStretch ? 2 : 0));
      if (!isFull) for (const v of b) gl += zigLen(v);
      // 注意：重編碼器漏了這一段！伸縮值
      if (!noStretch) for (const v of st) gl += zigLen(v);
    } else {
      gl += zigLen(s.width) + zigLen(s.style);
      for (let i = 0; i < 8; i++) gl += zigLen(s.points[i]!);
    }
  }
}
console.log(`\n=== 重編碼的段落（含 ref 索引！）===`);
console.log(`  檔頭 ${hdr}  後綴表 ${suf}  名字表 ${nm}  字形資料 ${gl}（未含 ref 索引）`);
console.log(`  目前重編碼器「漏掉」每筆引用的 ref 索引：${uLen(117120 / 2)} bytes × ?`);

// ref 索引的實際成本
let refIdxBytes = 0, nRefs = 0;
for (const g of lib.glyphs) for (const s of g.strokes) {
  if (s.kind === 99 && s.ref !== null) { nRefs++; refIdxBytes += uLen(s.ref); }
}
console.log(`  引用筆數 ${nRefs.toLocaleString()}，ref 索引實佔 ${refIdxBytes.toLocaleString()} bytes`);
console.log(`\n  重編碼完整值 = ${hdr + suf + nm + gl + refIdxBytes}`);
console.log(`  與實際 ${actual.length} 的差 = ${hdr + suf + nm + gl + refIdxBytes - actual.length}`);
