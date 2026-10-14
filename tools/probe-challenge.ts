/**
 * probe-challenge.ts — 量「以圖找字／以圖拼形」的起點（challenge.md）。
 *
 * 要回答的三件事：
 *   ① `bianbian.png` 的目標字（𰻞 U+30EDE）在不在字庫裡？它的部件序列是什麼？
 *   ② `xue.png`／`elements.png` 這種**造字**在不在字庫裡（應該不在 ✗——所以要「拼」）
 *   ③ 字庫能提供什麼線索（IDS 分解、筆劃數、家族）
 */
import { resolve } from "node:path";
import * as F from "./lib-format.ts";

const ROOT = resolve(import.meta.dir, "..");
const { lib } = await import("./lib-load.ts").then((m) => m.loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true }));

const ch = (cp: number) => { try { return String.fromCodePoint(cp); } catch { return "?" }; };
const hex = (cp: number) => "U+" + cp.toString(16).toUpperCase();
const show = (cp: number, label: string) => {
  const gi = F.indexOfCodePoint(lib, cp);
  if (gi === undefined) { console.log(`${label} ${hex(cp)}：**不在字庫** ✗`); return; }
  const di = F.drawingIdx ? F.drawingIdx(lib, gi) : gi;
  const g = lib.glyphs[di]!;
  const comps = lib.comp?.get(cp) ?? [];
  console.log(`${label} ${hex(cp)} ${ch(cp)}：字形 ${F.keyOfIdx(lib, di)}、` +
    `筆劃 ${g.strokes.filter((s: any) => s.kind !== 0).length}、` +
    `引用 ${g.strokes.filter((s: any) => s.kind === 99).length}、` +
    `部件序列 ${comps.length ? comps.map((c: number) => ch(c) + hex(c)).join("＋") : "（無 IDS）"}`);
  const fam = F.familyMembers(lib, cp);
  console.log(`   家族 ${fam.length} 個字形`);
};

console.log("① bianbian.png 的目標：");
show(0x30ede, "𰻞");
show(0x30edf, "𰻝");   /* 常見的另一個 biáng 字 */
show(0x2a6a5, "𪚥");
console.log("\n② xue.png 的線索字（好學孔孟）與 elements.png 的（金木水火土）：");
for (const c of ["好", "學", "孔", "孟", "金", "木", "水", "火", "土"]) show(c.codePointAt(0)!, c);
console.log("\n③ 字庫規模：");
console.log(`   字形 ${lib.glyphs.length.toLocaleString()}、有 IDS 的 ${lib.comp!.size.toLocaleString()}`);
let withRef = 0;
for (let i = 0; i < lib.glyphs.length; i++) if (lib.glyphs[i]!.strokes.some((s: any) => s.kind === 99)) withRef++;
console.log(`   含引用的字形 ${withRef.toLocaleString()}`);
