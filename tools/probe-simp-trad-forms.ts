/**
 * probe-simp-trad-forms.ts — 驗證師父的觀察：
 * 「會有『訁』是因為有『讠』。簡化版的『言』偏旁，就得補繁體版的『訁』即便筆劃完全相同。」
 *
 * 要看的四件事：
 *   ① `言/讠/訁` 的筆劃數（`kTotalStrokes`）——確認「訁」與「言」同筆劃 ✓
 *   ② Unihan 的 `kSimplifiedVariant`／`kTraditionalVariant` 怎麼說（`讠` 是樞紐 ✓）
 *   ③ 這一類「繁簡對應而生的偏旁形」有多少（在我們字集內）
 *   ④ 我們的形式群**有沒有**把 `讠` 收進 `言` 的群（筆劃差 5 ✗ 會被筆劃閘擋掉 ✗）
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadTotalStrokes } from "./form-groups.ts";
import { loadVariantPairs } from "./unihan-variants.ts";

const ROOT = resolve(import.meta.dir, "..");
const strokes = loadTotalStrokes(resolve(ROOT, "unihan/Unihan_IRGSources.txt"));
const ch = (cp: number) => { try { return String.fromCodePoint(cp); } catch { return "?" }; };

const RANGES: [number, number][] = [
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff],
  [0x20000, 0x2a6df], [0x2a700, 0x2b73f], [0x2b740, 0x2b81f], [0x2b820, 0x2ceaf],
  [0x2ceb0, 0x2ebef], [0x2ebf0, 0x2ee5f], [0x2f800, 0x2fa1f],
  [0x30000, 0x3134f], [0x31350, 0x323af],
];
const inLib = (cp: number) => RANGES.some(([a, b]) => cp >= a && cp <= b);

console.log("① 筆劃數（kTotalStrokes）：");
for (const c of ["言", "讠", "訁", "金", "钅", "釒", "食", "饣", "飠", "糸", "纟", "糹", "見", "见", "貝", "贝"]) {
  const cp = c.codePointAt(0)!;
  console.log(`   ${c} U+${cp.toString(16).toUpperCase()}：${strokes.get(cp) ?? "（無）"}`);
}

const rows: string[] = [];
for (const [cp, arr] of [] as never[]) void cp;
const simp = loadVariantPairs(resolve(ROOT, "unihan/Unihan_Variants.txt"), ["kSimplifiedVariant"], inLib);
const trad = loadVariantPairs(resolve(ROOT, "unihan/Unihan_Variants.txt"), ["kTraditionalVariant"], inLib);
console.log(`\n② Unihan 的繁簡對應（兩端都在我們字集）：kSimplifiedVariant ${simp.length} 筆、kTraditionalVariant ${trad.length} 筆`);
const show = (c: string) => {
  const cp = c.codePointAt(0)!;
  const s = simp.filter((p) => p.a === cp).map((p) => ch(p.b));
  const t = trad.filter((p) => p.a === cp).map((p) => ch(p.b));
  console.log(`   ${c}：簡化→${s.join(" ") || "（無）"}　傳統→${t.join(" ") || "（無）"}`);
};
for (const c of ["言", "讠", "訁", "金", "钅", "釒", "食", "饣"]) show(c);

/* ③ 這一類偏旁形：簡化字，且它的傳統對應是「同筆劃的偏旁形」（像 讠→訁） */
let hub = 0, sameStroke = 0;
const pairs: string[] = [];
for (const p of simp) {
  const tradOf = trad.filter((q) => q.a === p.b).map((q) => q.b);       /* 簡化字的傳統對應 ✓ */
  for (const tc of tradOf) {
    hub++;
    const s1 = strokes.get(p.a), s2 = strokes.get(tc);
    const isRadicalish = (x: number | undefined) => x !== undefined && x <= 8;
    if (isRadicalish(s1) && isRadicalish(s2)) {
      sameStroke++;
      if (pairs.length < 20) pairs.push(`${ch(p.a)}(U+${p.a.toString(16).toUpperCase()},${s1}筆) ⇄ ${ch(tc)}(U+${tc.toString(16).toUpperCase()},${s2}筆)`);
    }
  }
}
console.log(`\n③ 簡化字→（其傳統對應）的偏旁形對：${sameStroke} 筆（總 ${hub} 筆）。例：`);
for (const s of pairs) console.log("   " + s);
console.log(`\n④ 若照師父的話：**簡化版偏旁形存在，就得有繁體版對應**——所以形式群應該收這一批 ✓`);
console.log(`   但我們的筆劃閘（差 ≤1）會擋掉 ` + `讠(2)／訁(7)` + ` 這種 ✗ → 需要**額外的來源**（繁簡對應 ✓）。`);
