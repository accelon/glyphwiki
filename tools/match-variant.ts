// match-variant.ts — 驗證「用變體的墨跡尺寸比對槽位」能否選出正確的變體
import { readFileSync } from "node:fs";
import { decodeLibrary, findGlyphIndex } from "./lib-format.ts";
import { inkIn, inkOfRefInParent, findSlot } from "./compose-fit.ts";
import type { Library } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

const size = (b: any) => `${(b.x2 - b.x1).toFixed(0)}×${(b.y2 - b.y1).toFixed(0)}`;
const ratio = (b: any) => (b.x2 - b.x1) / Math.max(1, b.y2 - b.y1);

function variantsOf(ch: string) {
  const base = "u" + ch.codePointAt(0)!.toString(16);
  const out: { name: string; idx: number }[] = [];
  lib.names.forEach((n, i) => {
    if (n === base || n.startsWith(base + "-")) out.push({ name: n, idx: i });
  });
  return out;
}

/** 基準真值：柱 中 木 的槽位，以及它實際用的是哪個變體 */
console.log("=== 真值：柱 / 注 的槽位與實際使用的變體 ===\n");
for (const [ch, want] of [["柱", "木"], ["注", "主"]] as [string, string][]) {
  const idx = findGlyphIndex(lib, "u" + ch.codePointAt(0)!.toString(16))!;
  const g = lib.glyphs[idx]!;
  const refs = g.strokes.map((s, i) => ({ s, i })).filter((x) => x.s.kind === 99);
  console.log(`${ch}（${lib.names[idx]}）`);
  for (const { s, i } of refs) {
    const ink = inkOfRefInParent(lib, idx, i);
    console.log(`  引用 ${lib.names[s.ref!]!.padEnd(20)} 槽位 ${size(ink).padStart(9)}` +
      `  比例 ${ratio(ink).toFixed(2)}  框=[${s.box!.join(",")}]`);
  }
  void want;
  console.log("");
}

/** 找出各槽位對應的變體：用「比例最接近」來選 */
console.log("=== 用「比例＋尺寸」比對，看會選出哪個變體 ===\n");
for (const [ch, wantChar] of [["柱", "木"], ["注", "主"]] as [string, string][]) {
  const idx = findGlyphIndex(lib, "u" + ch.codePointAt(0)!.toString(16))!;
  const g = lib.glyphs[idx]!;
  g.strokes.forEach((s, i) => {
    if (s.kind !== 99 || s.ref === null) return;
    const slot = inkOfRefInParent(lib, idx, i);
    const want = variantsOf(wantChar);
    // 真值：柱 用了 木 的哪個變體？
    const actual = lib.names[s.ref!]!;
    // 用比例選
    const scored = want.map((v) => {
      const ink = inkIn(lib, v.idx);
      return { name: v.name, d: Math.abs(ratio(ink) - ratio(slot)) };
    }).sort((a, b) => a.d - b.d);
    console.log(`${ch} 的槽位 ${size(slot)}（比例 ${ratio(slot).toFixed(2)}）`);
    console.log(`    KAGE 實際用：${actual}`);
    console.log(`    比例最接近前 3：${scored.slice(0, 3).map((x) => `${x.name}(差${x.d.toFixed(2)})`).join("  ")}`);
    console.log(`    是否命中：${scored[0]!.name === actual ? "✓" : "✗"}`);
    console.log("");
  });
}
void findSlot;
