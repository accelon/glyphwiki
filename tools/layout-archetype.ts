// layout-archetype.ts — 量測「策劃式版面模板」：
//   1. 用「只記結構形狀」分群（左右、上下、三分…），看能有幾群
//   2. 每群選一個代表版面（該群最常見的框）
//   3. 量「改用代表版面」的位移代價，以及模板數 vs 節省
import { readFileSync } from "node:fs";
import { decodeLibrary } from "./lib-format.ts";
import type { Library, Glyph } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

const q2 = (v: number) => Math.round(v / 5) * 5; // 量化到 5 單位（2.5% 字身）

/** 結構形狀：只記每個節點的框（相對比例），不記子樹內容 */
function shapeKey(g: Glyph, depth = 0, seen = new Set<number>()): string {
  const refs = g.strokes.filter((s) => s.kind === 99);
  if (refs.length === 0) return "T";
  const parts: string[] = [];
  for (const s of refs) {
    const b = s.box!;
    const key = `${q2(b[0]!)},${q2(b[1]!)},${q2(b[2]!)},${q2(b[3]!)}`;
    let child = "";
    if (depth < 1 && s.ref !== null && !seen.has(s.ref)) {
      const s2 = new Set(seen);
      s2.add(s.ref!);
      const ck = shapeKey(lib.glyphs[s.ref]!, depth + 1, s2);
      if (ck !== "T") child = "[" + ck + "]";
    }
    parts.push(key + child);
  }
  return parts.join("|");
}

/** 純結構骨架（完全不記框）：只用來分「版面家族」 */
function skeleton(g: Glyph): string {
  const refs = g.strokes.filter((s) => s.kind === 99);
  if (refs.length === 0) return "T";
  return refs.map((s) => "B").join("|") + "#" + refs.length;
}

const groups = new Map<string, { name: string; key: string }[]>();
for (let i = 0; i < lib.names.length; i++) {
  const n = lib.names[i]!;
  const g = lib.glyphs[i]!;
  if (g.strokes.filter((s) => s.kind === 99).length === 0) continue;
  const sk = skeleton(g);
  const k = shapeKey(g);
  const a = groups.get(sk);
  if (a) a.push({ name: n, key: k });
  else groups.set(sk, [{ name: n, key: k }]);
}

let total = 0, totalDistinct = 0;
console.log("=== 各結構家族：字數、相異版面、代表版面覆蓋率 ===\n");
const rowsOut: { fam: string; n: number; distinct: number; topShare: number }[] = [];
for (const [fam, items] of groups) {
  total += items.length;
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.key, (counts.get(it.key) ?? 0) + 1);
  totalDistinct += counts.size;
  const top = Math.max(...counts.values());
  rowsOut.push({ fam, n: items.length, distinct: counts.size, topShare: top / items.length });
}
rowsOut.sort((a, b) => b.n - a.n);
console.log("家族".padEnd(26) + "字數".padStart(8) + "相異版面".padStart(10) + "最常見版面佔比".padStart(14));
for (const r of rowsOut.slice(0, 10)) {
  console.log(r.fam.padEnd(26) + String(r.n).padStart(8) + String(r.distinct).padStart(10) +
    (r.topShare * 100).toFixed(0).padStart(13) + "%");
}
console.log(`\n合計 ${total.toLocaleString()} 字、相異版面 ${totalDistinct.toLocaleString()} 個`);

// 若每個家族只保留「前 K 個常見版面」當模板，覆蓋率多少？
console.log("\n=== 每個家族保留前 K 個常見版面時的覆蓋率 ===");
for (const K of [1, 2, 4, 8]) {
  let covered = 0;
  for (const [, items] of groups) {
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.key, (counts.get(it.key) ?? 0) + 1);
    const top = [...counts.values()].sort((a, b) => b - a).slice(0, K);
    covered += top.reduce((s, v) => s + v, 0);
  }
  console.log(`  K=${K}: 模板數 ${(groups.size * K).toLocaleString()}  覆蓋 ${(100 * covered / total).toFixed(0)}% 的字（其餘需自帶框）`);
}
