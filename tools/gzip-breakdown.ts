// gzip-breakdown.ts — 從「壓縮後」的視角拆解：各欄位對 gzip 的實際貢獻
//
// 方法：把每個欄位分別抽掉，看 gzip 少多少 → 邊際貢獻。
// 這比看未壓縮佔比更準（gzip 會互相補償）。
import { readFileSync } from "node:fs";
import { decodeLibrary } from "./lib-format.ts";
import type { Library } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

const SUFFIXES = [...new Set(lib.names.map((n) => {
  const m = /^u[0-9a-f]{4,6}(-.*)?$/i.exec(n);
  return m && m[1] ? m[1] : null;
}).filter((x): x is string => x !== null))];
const suffixIx = new Map(SUFFIXES.map((s, i) => [s, i] as const));

/** 可選地省略某些欄位，然後編碼 + gzip */
function encode(opts: {
  omitNames?: boolean;
  omitRefIndex?: boolean;
  omitBoxes?: boolean;
  omitStrokes?: boolean;
  omitKinds?: boolean;
  boxDict?: Map<number, number>; // 引用框索引 → 代表框索引（外部字典另計）
}) {
  const bin: number[] = [];
  const pushU = (n: number) => { let v = n >>> 0; while (v >= 0x80) { bin.push((v & 0x7f) | 0x80); v >>>= 7; } bin.push(v); };
  const pushS = (n: number) => { let v = ((n << 1) ^ (n >> 31)) >>> 0; while (v >= 0x80) { bin.push((v & 0x7f) | 0x80); v >>>= 7; } bin.push(v); };

  if (!opts.omitNames) {
    pushU(lib.names.length);
    pushU(SUFFIXES.length);
    for (const s of SUFFIXES) { pushU(s.length); for (const ch of s) pushU(ch.charCodeAt(0)); }
    for (const n of lib.names) {
      const m = /^u([0-9a-f]{4,6})(-.*)?$/i.exec(n);
      if (m) { pushU(parseInt(m[1]!, 16)); pushU(m[2] ? suffixIx.get(m[2])! + 1 : 0); }
      else { pushU(0); pushU(n.length); for (const ch of n) pushU(ch.charCodeAt(0)); }
    }
  }
  let boxIx = 0;
  for (const g of lib.glyphs) {
    pushU(g.strokes.length);
    for (const s of g.strokes) {
      if (!opts.omitKinds) pushU(s.kind);
      if (s.kind === 99) {
        const b = s.box!, st = s.stretch!;
        const isFull = b[0] === 0 && b[1] === 0 && b[2] === 200 && b[3] === 200;
        const noStretch = st[0] === 0 && st[1] === 0 && st[2] === 0 && st[3] === 0;
        if (!opts.omitRefIndex) pushU(s.ref!);
        pushU((isFull ? 1 : 0) | (noStretch ? 2 : 0));
        if (!opts.omitBoxes) {
          if (opts.boxDict) {
            pushU(opts.boxDict.get(boxIx) ?? 0);
          } else if (!isFull) {
            for (const v of b) pushS(v);
          }
        }
        boxIx++;
        if (!noStretch) for (const v of st) pushS(v);
      } else {
        if (!opts.omitStrokes) {
          pushS(s.width); pushS(s.style);
          for (let i = 0; i < 8; i++) pushS(s.points[i]!);
        }
      }
    }
  }
  const buf = Buffer.from(bin);
  return { raw: buf.length, gz: Bun.gzipSync(buf, { level: 9 }).length };
}

/** 建框字典（門檻 2） */
function buildBoxDict(t: number) {
  const reps: number[][] = [];
  const map = new Map<number, number>();
  let i = 0;
  for (const g of lib.glyphs) {
    for (const s of g.strokes) {
      if (s.kind !== 99) continue;
      const b = s.box!;
      let bestI = -1, bestD = Infinity;
      for (let k = 0; k < reps.length; k++) {
        const r = reps[k]!;
        const d = Math.max(Math.abs(b[0]! - r[0]!), Math.abs(b[1]! - r[1]!), Math.abs(b[2]! - r[2]!), Math.abs(b[3]! - r[3]!));
        if (d < bestD) { bestD = d; bestI = k; }
        if (bestD === 0) break;
      }
      if (bestI >= 0 && bestD <= t) map.set(i, bestI);
      else { map.set(i, reps.length); reps.push([b[0]!, b[1]!, b[2]!, b[3]!]); }
      i++;
    }
  }
  return { map, reps };
}

const full = encode({});
console.log(`完整庫（重編碼 + gzip）= ${full.gz.toLocaleString()} bytes（${(full.gz / 1024).toFixed(0)} KB）`);
console.log(`實際檔案 gzip = ${readFileSync(`${D}/out/lib-cjk.bin.gz`).length.toLocaleString()} bytes\n`);

console.log("=== 邊際貢獻（抽掉某欄位後 gzip 少多少）===");
const cases: [string, Parameters<typeof encode>[0]][] = [
  ["名字表", { omitNames: true }],
  ["引用索引（ref）", { omitRefIndex: true }],
  ["引用框（全刪）", { omitBoxes: true }],
  ["筆畫座標+寬+型", { omitStrokes: true }],
  ["kind 欄位", { omitKinds: true }],
];
const results: [string, number][] = [];
for (const [name, o] of cases) {
  const r = encode(o);
  const delta = full.gz - r.gz;
  results.push([name, delta]);
}
results.sort((a, b) => b[1] - a[1]);
for (const [name, delta] of results) {
  console.log(`  ${name.padEnd(18)} gzip 減少 ${String(delta).padStart(7)} bytes  (${(100 * delta / full.gz).toFixed(1)}%)`);
}

console.log("\n=== 框字典化（門檻 2）對整體 gzip 的影響 ===");
const { map, reps } = buildBoxDict(2);
const dictOnly = encode({ omitBoxes: true });
// 字典本身要算進去
const dictBuf: number[] = [];
{
  const pushU = (n: number) => { let v = n >>> 0; while (v >= 0x80) { dictBuf.push((v & 0x7f) | 0x80); v >>>= 7; } dictBuf.push(v); };
  const pushS = (n: number) => { let v = ((n << 1) ^ (n >> 31)) >>> 0; while (v >= 0x80) { dictBuf.push((v & 0x7f) | 0x80); v >>>= 7; } dictBuf.push(v); };
  pushU(reps.length);
  for (const r of reps) { pushS(r[0]!); pushS(r[1]!); pushS(r[2]!); pushS(r[3]!); }
}
const dictGz = Bun.gzipSync(Buffer.from(dictBuf), { level: 9 }).length;
const withDict = encode({ boxDict: map });
console.log(`  移除框欄位後的 gzip        ${dictOnly.gz.toLocaleString()} bytes`);
console.log(`  + 框字典（${reps.length} 個代表框）gzip ${dictGz.toLocaleString()} bytes`);
console.log(`  合計                      ${(dictOnly.gz + dictGz).toLocaleString()} bytes`);
console.log(`  對比完整 gzip             ${full.gz.toLocaleString()} bytes`);
console.log(`  → 淨省 ${(full.gz - dictOnly.gz - dictGz).toLocaleString()} bytes` +
  `（${(100 * (full.gz - dictOnly.gz - dictGz) / full.gz).toFixed(1)}%）`);
