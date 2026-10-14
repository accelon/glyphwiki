// layout-cluster.ts — 量測「版面模板」是否可行：
// 把字依「引用的結構簽章」分群，看同群內的框是否夠一致（一致才可用同一個模板）。
import { readFileSync } from "node:fs";
import { decodeLibrary, findGlyphIndex } from "./lib-format.ts";
import type { Library, Glyph } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

/** 遞迴取得一個字形的「結構簽章」：只記樹狀形狀與每個節點的框（不含部件名） */
function signature(g: Glyph, depth = 0, seen = new Set<number>()): string {
  const refs = g.strokes.filter((s) => s.kind === 99);
  if (refs.length === 0) return "S"; // 終端（有筆畫）
  const parts: string[] = [];
  for (const s of refs) {
    const b = s.box!;
    const fw = ((b[2]! - b[0]!) / 200).toFixed(2);
    const fh = ((b[3]! - b[1]!) / 200).toFixed(2);
    const px = (b[0]! / 200).toFixed(2);
    const py = (b[1]! / 200).toFixed(2);
    const child = depth < 1 && s.ref !== null && !seen.has(s.ref)
      ? (() => { const s2 = new Set(seen); s2.add(s.ref!); return signature(lib.glyphs[s.ref!]!, depth + 1, s2); })()
      : "-";
    parts.push(`${px},${py},${fw},${fh}${child === "S" ? "" : "[" + child + "]"}`);
  }
  return parts.join("|");
}

// 收集所有「碼位字」的結構
const rows: { name: string; sig: string; nRefs: number }[] = [];
for (let i = 0; i < lib.names.length; i++) {
  const n = lib.names[i]!;
  if (!/^u[0-9a-f]{4,6}$/.test(n)) continue;
  const g = lib.glyphs[i]!;
  const nRefs = g.strokes.filter((s) => s.kind === 99).length;
  if (nRefs < 2) continue;
  rows.push({ name: n, sig: signature(g), nRefs });
}

console.log(`有 2 個以上直接引用的碼位字：${rows.length.toLocaleString()}`);

// 正規化簽章（把座標量化到 0.1）以觀察「結構相同」的族群
const quant = (sig: string) =>
  sig.replace(/\d+\.\d+/g, (x) => (Math.round(parseFloat(x) * 10) / 10).toFixed(1));

const byShape = new Map<string, string[]>();
for (const r of rows) {
  // 形狀簽章：只留結構骨架與引用個數
  const shape = r.sig.replace(/-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+/g, "B")
    .replace(/\[.*?\]/g, "[…]");
  const k = shape + "#" + r.nRefs;
  const a = byShape.get(k);
  if (a) a.push(r.sig);
  else byShape.set(k, [r.sig]);
}
console.log(`\n結構骨架種類：${byShape.size}`);
const top = [...byShape.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 6);
for (const [shape, sigs] of top) {
  const uniq = new Set(sigs.map(quant));
  console.log(`  ${shape.slice(0, 60).padEnd(62)} 字數 ${String(sigs.length).padStart(6)}  相異版面 ${String(uniq.size).padStart(6)}` +
    `  平均每版面 ${(sigs.length / uniq.size).toFixed(1)} 字`);
}

// 整體：若每個「相異版面」只需存一份模板，框資料可省多少？
const allSigs: string[] = [];
for (const [, sigs] of byShape) for (const s of sigs) allSigs.push(quant(s));
const uniqAll = new Set(allSigs);
console.log(`\n全部：${allSigs.length.toLocaleString()} 個字，相異版面 ${uniqAll.size.toLocaleString()} 個` +
  ` → 平均每版面 ${(allSigs.length / uniqAll.size).toFixed(2)} 字`);
console.log(`框資料壓縮潛力：${(100 * (1 - uniqAll.size / allSigs.length)).toFixed(1)}%`);

// 參考：柱 與 桶 的簽章是否相同（使用者舉的例子）
for (const ch of ["桶", "校", "柱", "枷", "明", "盟"]) {
  const cp = ch.codePointAt(0)!;
  const idx = findGlyphIndex(lib, "u" + cp.toString(16));
  if (idx === undefined) { console.log(`  ${ch}: 不在庫中`); continue; }
  const g = lib.glyphs[idx]!;
  console.log(`  ${ch} 簽章: ${signature(g).slice(0, 90)}`);
}
