// inspect-variants.ts — 比較「柱」與「注氵木」，並列出 木 的變體
import { readFileSync } from "node:fs";
import { decodeLibrary, findGlyphIndex, toKageData } from "./lib-format.ts";
import { inkIn } from "./compose-fit.ts";
import type { Library } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

const f = (b: any) => [b.x1, b.y1, b.x2, b.y2].map((v: number) => v.toFixed(0)).join(",");
const size = (b: any) => `${(b.x2 - b.x1).toFixed(0)}×${(b.y2 - b.y1).toFixed(0)}`;

/** 列出一個字的所有變體（同名基底的字形） */
function variantsOf(ch: string) {
  const base = "u" + ch.codePointAt(0)!.toString(16);
  const hits: { name: string; idx: number }[] = [];
  lib.names.forEach((n, i) => {
    if (n === base || n.startsWith(base + "-")) hits.push({ name: n, idx: i });
  });
  return hits;
}

for (const ch of ["木", "水", "氵"]) {
  console.log(`\n===== 「${ch}」的變體 =====`);
  for (const v of variantsOf(ch)) {
    const ink = inkIn(lib, v.idx);
    const g = lib.glyphs[v.idx]!;
    const refs = g.strokes.filter((s) => s.kind === 99).length;
    console.log(`  ${v.name.padEnd(18)} 墨跡 ${size(ink).padStart(9)}  框=[${f(ink)}]  筆數=${g.strokes.length} 引用=${refs}`);
  }
}

console.log("\n===== 柱 的結構 =====");
const zhu = findGlyphIndex(lib, "u67f1")!;
console.log(`  名=${lib.names[zhu]} 墨跡 ${size(inkIn(lib, zhu))}`);
function tree(idx: number, depth: number, seen = new Set<number>()) {
  if (depth > 3) return;
  const n = lib.names[idx]!;
  const g = lib.glyphs[idx]!;
  const ink = inkIn(lib, idx);
  console.log(`${"  ".repeat(depth + 1)}${n}  墨跡 ${size(ink)}  筆數 ${g.strokes.length}`);
  if (seen.has(idx)) return;
  seen.add(idx);
  for (const s of g.strokes) {
    if (s.kind === 99 && s.ref !== null) {
      console.log(`${"  ".repeat(depth + 2)}↳ 框=[${s.box!.join(",")}] 伸縮=[${s.stretch!.join(",")}] 引用 ${lib.names[s.ref]}`);
      tree(s.ref, depth + 1, seen);
    }
  }
}
tree(zhu, 0);

console.log("\n===== 注 的結構（對照）=====");
const zhu4 = findGlyphIndex(lib, "u6ce8")!;
console.log(`  名=${lib.names[zhu4]} 墨跡 ${size(inkIn(lib, zhu4))}`);
tree(zhu4, 0);

console.log("\n===== 漢 的結構（使用者要組的目標）=====");
const han = findGlyphIndex(lib, "u6f22")!;
console.log(`  名=${lib.names[han]} 墨跡 ${size(inkIn(lib, han))}`);
tree(han, 0);
void toKageData;
