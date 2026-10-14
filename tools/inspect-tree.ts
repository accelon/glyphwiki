// inspect-tree.ts — 印出一個字的引用樹，確認組字時要換的節點
import { readFileSync } from "node:fs";
import { decodeLibrary, findGlyphIndex, toKageData } from "./lib-format.ts";
import type { Library } from "./lib-format.ts";

const lib = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync("D:/2023/glyphwiki/out/lib-cjk.bin.gz"))));

/** 印出引用樹；mark 標記含目標名字的節點 */
function tree(lib: Library, idx: number, depth = 0, seen = new Set<number>()): void {
  const pad = "  ".repeat(depth);
  const name = lib.names[idx]!;
  if (seen.has(idx)) { console.log(`${pad}${name} (循環)`); return; }
  seen.add(idx);
  const g = lib.glyphs[idx]!;
  const kinds = g.strokes.map((s) => s.kind);
  const refs = g.strokes.filter((s) => s.kind === 99);
  console.log(`${pad}${name}  緊框=[${g.tight}]  筆數=${g.strokes.length}` +
    (refs.length ? `  引用=${refs.map((s) => lib.names[s.ref!]).join(",")}` : `  型別=[${kinds.slice(0, 6)}]`));
  if (depth >= 4) return;
  for (const s of refs) tree(lib, s.ref!, depth + 1, new Set(seen));
}

for (const ch of ["寶", "缶", "支", "缶支"]) {
  const cp = ch.codePointAt(0)!;
  const idx = findGlyphIndex(lib, "u" + cp.toString(16));
  console.log(`\n===== ${ch} U+${cp.toString(16).toUpperCase()} =====`);
  if (idx === undefined) { console.log("  不在庫中"); continue; }
  console.log(`  索引=${idx} 名=${lib.names[idx]}`);
  if (ch.length === 1) tree(lib, idx);
}

// 檢查庫中是否有含「缶」的名字
console.log("\n===== 庫中含 '缶' 相關的部件名 =====");
const hits = lib.names.map((n, i) => [n, i] as const).filter(([n]) => /^u7f36/.test(n));
console.log(`  u7f36* 共 ${hits.length} 個: ${hits.slice(0, 8).map(([n, i]) => `${n}(${i})`).join(" ")}`);

console.log("\n===== 庫中含 '支' 相關的部件名 =====");
const hits2 = lib.names.map((n, i) => [n, i] as const).filter(([n]) => /^u652f/.test(n));
console.log(`  u652f* 共 ${hits2.length} 個: ${hits2.slice(0, 8).map(([n, i]) => `${n}(${i})`).join(" ")}`);

// 確認缶、支的碼位
for (const ch of ["缶", "支"]) {
  console.log(`  ${ch} = U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`);
}
