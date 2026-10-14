// quantize-cost.ts — 檢驗「把座標量化到 64×64 / 48×48 / 32×32」對實際大小的影響
//
// 使用者的假設：量化後座標更「重複」，所以更好壓縮。
//
// 但要小心：目前座標是 0..200 的整數。量化到 64 格會把值變成
// {0, 3, 6, 9, 13, 16, ...}（間距 200/64≈3.125），這些數值本身並沒有變小，
// 所以 varint 不會變短，反而可能變長。
//
// 這支工具直接量：未壓縮大小、gzip 大小、以及「相異座標值個數」（熵的指標）。
import { readFileSync } from "node:fs";
import { decodeLibrary } from "./lib-format.ts";
import type { Library, Glyph } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

/** 量化一座標到 grid 格（0..200 → 最近的 200/grid 倍數） */
const quant = (v: number, grid: number) => Math.round((v / 200) * grid) * (200 / grid);

/** 依傳入的座標轉換函式，重新編碼整個庫（與 build-library 相同的格式） */
function encode(lib: Library, mapCoord: (v: number) => number, label: string) {
  const bin: number[] = [];
  const pushU = (n: number) => { let v = n >>> 0; while (v >= 0x80) { bin.push((v & 0x7f) | 0x80); v >>>= 7; } bin.push(v); };
  const pushS = (n: number) => { let v = ((n << 1) ^ (n >> 31)) >>> 0; while (v >= 0x80) { bin.push((v & 0x7f) | 0x80); v >>>= 7; } bin.push(v); };

  pushU(lib.names.length);
  pushU(lib.suffix.length);
  for (const s of lib.suffix) { pushU(s.length); for (const ch of s) pushU(ch.charCodeAt(0)); }
  for (const n of lib.names) {
    const m = /^u([0-9a-f]{4,6})(-.*)?$/i.exec(n);
    if (m) { pushU(parseInt(m[1]!, 16)); pushU(m[2] ? 1 : 0); }
    else { pushU(0); pushU(n.length); for (const ch of n) pushU(ch.charCodeAt(0)); }
  }
  for (const g of lib.glyphs) {
    pushU(g.strokes.length);
    for (const s of g.strokes) {
      pushU(s.kind);
      if (s.kind === 99) {
        const b = s.box!, st = s.stretch!;
        const isFull = b[0] === 0 && b[1] === 0 && b[2] === 200 && b[3] === 200;
        const noStretch = st[0] === 0 && st[1] === 0 && st[2] === 0 && st[3] === 0;
        pushU((isFull ? 1 : 0) | (noStretch ? 2 : 0));
        if (!isFull) for (const v of b) pushS(mapCoord(v));
      } else {
        pushS(s.width);
        pushS(s.style);
        for (let i = 0; i < 8; i++) pushS(mapCoord(s.points[i]!));
      }
    }
  }
  const buf = Buffer.from(bin);
  const gz = Bun.gzipSync(buf, { level: 9 });
  return { label, raw: buf.length, gz: gz.length };
}

/** 相異座標值個數（熵的粗略指標） */
function distinctCoords(lib: Library, mapCoord: (v: number) => number) {
  const set = new Set<number>();
  for (const g of lib.glyphs) {
    for (const s of g.strokes) {
      if (s.kind === 99) { for (const v of s.box!) set.add(mapCoord(v)); }
      else { for (let i = 0; i < 8; i++) set.add(mapCoord(s.points[i]!)); }
    }
  }
  return set.size;
}

const rows: { label: string; raw: number; gz: number; distinct: number }[] = [];
rows.push({ label: "原始（不量化）", ...encode(lib, (v) => v, ""), distinct: distinctCoords(lib, (v) => v) });
for (const grid of [96, 64, 48, 32, 24]) {
  const r = encode(lib, (v) => quant(v, grid), `${grid}×${grid}`);
  rows.push({ ...r, distinct: distinctCoords(lib, (v) => quant(v, grid)) });
}

console.log("=== 座標量化對大小的影響 ===");
console.log("  格數      未壓縮       gzip      相異座標值數");
for (const r of rows) {
  console.log(`  ${r.label.padEnd(14)} ${String(r.raw).padStart(10)}  ${String(r.gz).padStart(9)}  ${String(r.distinct).padStart(12)}`);
}
const base = rows[0]!;
console.log("");
console.log("  相對原始的變化：");
for (const r of rows.slice(1)) {
  console.log(`  ${r.label.padEnd(14)} 未壓縮 ${(100 * (r.raw - base.raw) / base.raw).toFixed(1).padStart(6)}%   ` +
    `gzip ${(100 * (r.gz - base.gz) / base.gz).toFixed(1).padStart(6)}%   ` +
    `相異值 ${(100 * (r.distinct - base.distinct) / base.distinct).toFixed(0).padStart(4)}%`);
}
console.log(`\n（負值＝變小＝改善；正值＝變大＝更差）`);
void (null as unknown as Glyph);
