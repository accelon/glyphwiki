// ar-probe.ts — 精確量出決策點的數據，找出判準該怎麼設
import { readFileSync } from "node:fs";
import { decodeLibrary, findGlyphIndex } from "./lib-format.ts";
import { inkOfRefInParent } from "./compose-fit.ts";
import { findSlot } from "./compose-fit.ts";
import type { Library } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

const ar = (b: any) => (b.x2 - b.x1) / Math.max(1, b.y2 - b.y1);
const sz = (b: any) => `${(b.x2 - b.x1).toFixed(1)}×${(b.y2 - b.y1).toFixed(1)}`;

for (const [ch, from, to] of [["寶", "缶", "支"], ["漢", "氵", "木"], ["盟", "皿", "月"]] as [string, string, string][]) {
  const baseIdx = findGlyphIndex(lib, "u" + ch.codePointAt(0)!.toString(16))!;
  const fromBase = "u" + from.codePointAt(0)!.toString(16);
  const slot = findSlot(lib, baseIdx, fromBase)!;
  const oldInk = inkOfRefInParent(lib, slot.parent, slot.strokeIx);
  const oldStroke = lib.glyphs[slot.parent]!.strokes[slot.strokeIx]!;

  // 模擬「沿用原框」用泛用字形
  const toIdx = findGlyphIndex(lib, "u" + to.codePointAt(0)!.toString(16))!;
  const glyphs = lib.glyphs.slice();
  const p = glyphs[slot.parent]!;
  const st = p.strokes.slice();
  st[slot.strokeIx] = { ...oldStroke, ref: toIdx };
  glyphs[slot.parent] = { tight: p.tight, strokes: st };
  const tmp = { names: lib.names, suffix: lib.suffix, glyphs };
  const trial = inkOfRefInParent(tmp, slot.parent, slot.strokeIx);

  const arSlot = ar(oldInk), arTrial = ar(trial);
  const arDiff = Math.abs(arTrial - arSlot) / arSlot;
  const overX = Math.max(0, oldInk.x1 - trial.x1) + Math.max(0, trial.x2 - oldInk.x2);
  const overY = Math.max(0, oldInk.y1 - trial.y1) + Math.max(0, trial.y2 - oldInk.y2);

  console.log(`${ch} ${from}→${to}   （泛用字形 ${lib.names[toIdx]}）`);
  console.log(`   槽位      ${sz(oldInk).padStart(14)}  比例 ${arSlot.toFixed(3)}`);
  console.log(`   沿用後    ${sz(trial).padStart(14)}  比例 ${arTrial.toFixed(3)}`);
  console.log(`   比例差 ${(arDiff * 100).toFixed(1)}%   溢出 x ${overX.toFixed(1)} / y ${overY.toFixed(1)} 格`);
  console.log(`   槽位尺寸 ${(oldInk.x2 - oldInk.x1).toFixed(0)}×${(oldInk.y2 - oldInk.y1).toFixed(0)}`);
  console.log("");
}
