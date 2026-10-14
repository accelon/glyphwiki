// verify-compose.ts — 驗證 compose 真的改寫了引用，且組字結果與原字不同
import { readFileSync } from "node:fs";
import { decodeLibrary, findGlyphIndex, compose, isVariantOf, toKageData } from "./lib-format.ts";

const lib = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync("D:/2023/glyphwiki/out/lib-cjk.bin.gz"))));

/** 收集一個字的引用樹中所有引用到的字形名 */
function refsOf(L: any, idx: number): string[] {
  const out: string[] = [];
  const seen = new Set<number>();
  const stack = [idx];
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    for (const s of L.glyphs[i].strokes) {
      if (s.kind === 99 && s.ref !== null) {
        out.push(L.names[s.ref]);
        stack.push(s.ref);
      }
    }
  }
  return out;
}

const cases: [string, [string, string][]][] = [
  ["寶", []],
  ["寶", [["缶", "支"]]],
  ["盟", [["皿", "月"]]],
  ["漢", [["氵", "木"]]],
  ["盟", [["明", "月"]]],
];

for (const [base, pairs] of cases) {
  const label = base + pairs.map(([a, b]) => a + b).join("");
  const baseIdx = findGlyphIndex(lib, "u" + base.codePointAt(0)!.toString(16))!;
  const before = refsOf(lib, baseIdx);

  if (pairs.length === 0) {
    console.log(`\n${label}: 引用 ${before.length} 個節點`);
    continue;
  }
  const r = compose(lib, base, pairs);
  if ("error" in r) { console.log(`\n${label}: ✗ ${r.error}`); continue; }
  const after = refsOf(r.lib, r.targetIdx);

  // 檢查：改寫後的引用應該「不再有舊部件」，且「出現了新部件」
  const oldBase = "u" + pairs[0]![0].codePointAt(0)!.toString(16);
  const newBase = "u" + pairs[0]![1].codePointAt(0)!.toString(16);
  const stillOld = after.filter((n) => n === oldBase || n.startsWith(oldBase + "-"));
  const gotNew = after.filter((n) => n === newBase || n.startsWith(newBase + "-"));

  console.log(`\n${label}: ${r.log.join("、")}`);
  console.log(`  改寫前引用: ${before.join(" ")}`);
  console.log(`  改寫後引用: ${after.join(" ")}`);
  console.log(`  仍含舊部件「${pairs[0]![0]}」: ${stillOld.length ? "✗ " + stillOld.join(",") : "✓ 無"}`);
  console.log(`  已含新部件「${pairs[0]![1]}」: ${gotNew.length ? "✓ " + gotNew.join(",") : "✗ 無"}`);
  void isVariantOf;
  void toKageData;
}
