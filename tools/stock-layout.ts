// stock-layout.ts — 檢驗「庫存框」構想：純幾何、不分部件名
//
// 使用者的構想：把左右形的框歸成 32 種「庫存框」，
// 然後字就可以寫成「部件序列 + 庫存框編號」。
//
// 關鍵差異（相對先前的失敗實驗）：**不分部件名**。
// 先前按 (左件名, 右件寬度帶) 分群得到 1,239 個模板，太多；
// 純幾何分群才有機會壓到 32 個。
import { readFileSync } from "node:fs";
import { decodeLibrary } from "./lib-format.ts";
import type { Library, Glyph } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

/** 一個字形的「結構簽章」：遞迴的框相對比例（不含部件名、不含位置絕對值） */
function layoutSig(g: Glyph, depth = 0, seen = new Set<number>()): string {
  const refs = g.strokes.filter((s) => s.kind === 99);
  if (refs.length === 0) return "T";
  const parts: string[] = [];
  for (const s of refs) {
    const b = s.box!;
    // 用「相對 200 的比例，量化到 grid」表示，這樣同比例不同絕對位置會歸為同一類
    const q = (v: number, grid: number) => Math.round((v / 200) * grid);
    const key = `${q(b[0]!, 12)},${q(b[1]!, 12)},${q(b[2]!, 12)},${q(b[3]!, 12)}`;
    let child = "";
    if (depth < 2 && s.ref !== null && !seen.has(s.ref)) {
      const s2 = new Set(seen); s2.add(s.ref!);
      const ck = layoutSig(lib.glyphs[s.ref]!, depth + 1, s2);
      if (ck !== "T") child = "[" + ck + "]";
    }
    parts.push(key + child);
  }
  return parts.join("|");
}

// 收集所有有引用的字形
const sigs: { gi: number; sig: string; nRefs: number }[] = [];
for (let i = 0; i < lib.glyphs.length; i++) {
  const g = lib.glyphs[i]!;
  const nRefs = g.strokes.filter((s) => s.kind === 99).length;
  if (nRefs === 0) continue;
  sigs.push({ gi: i, sig: layoutSig(g), nRefs });
}
console.log(`有引用的字形 ${sigs.length.toLocaleString()}`);

// 量化精度掃描：相異簽章數
console.log("\n=== 框簽章量化精度 vs 相異簽章數 ===");
for (const grid of [200, 100, 50, 25, 16, 12, 8, 6, 4]) {
  const fn = (g: Glyph) => {
    const walk = (gg: Glyph, depth: number, seen: Set<number>): string => {
      const refs = gg.strokes.filter((s) => s.kind === 99);
      if (refs.length === 0) return "T";
      return refs.map((s) => {
        const b = s.box!;
        const q = (v: number) => Math.round((v / 200) * grid);
        let ch = "";
        if (depth < 2 && s.ref !== null && !seen.has(s.ref)) {
          const s2 = new Set(seen); s2.add(s.ref!);
          const c = walk(lib.glyphs[s.ref]!, depth + 1, s2);
          if (c !== "T") ch = "[" + c + "]";
        }
        return `${q(b[0]!)},${q(b[1]!)},${q(b[2]!)},${q(b[3]!)}${ch}`;
      }).join("|");
    };
    return walk(g, 0, new Set());
  };
  const set = new Set<string>();
  for (const s of sigs) set.add(fn(lib.glyphs[s.gi]!));
  console.log(`  量化到 ${String(grid).padStart(3)} 格：相異簽章 ${set.size.toLocaleString()}` +
    `（平均每簽章 ${(sigs.length / set.size).toFixed(1)} 字）`);
}

// 只看「左右兩件」的簡單結構（使用者的主要場景）
console.log("\n=== 只看「恰好兩個直接引用」的字形 ===");
const two = sigs.filter((s) => s.nRefs === 2);
console.log(`  共 ${two.length.toLocaleString()} 個`);
for (const grid of [50, 25, 16, 12, 8]) {
  const set = new Set<string>();
  for (const s of two) {
    const g = lib.glyphs[s.gi]!;
    const refs = g.strokes.filter((x) => x.kind === 99);
    // 只看這一層（不管子結構），用左右兩框的比例
    const q = (v: number) => Math.round((v / 200) * grid);
    const key = refs.map((x) => `${q(x.box![0]!)},${q(x.box![2]!)}`).join("|");
    set.add(key);
  }
  console.log(`  量化到 ${String(grid).padStart(3)} 格：相異「左右框比例」 ${set.size.toLocaleString()}`);
}

// 若硬性只留 32 種庫存框：覆蓋率與位移
console.log("\n=== 若只留 K 種庫存框（左右兩件的水平框比例）===");
const keysOf: { gi: number; key: string; boxes: number[][] }[] = [];
for (const s of two) {
  const g = lib.glyphs[s.gi]!;
  const refs = g.strokes.filter((x) => x.kind === 99);
  // 只按「左件 x 範圍」聚類（這是左右形布局的核心）
  const left = refs[0]!.box!;
  const q = Math.round((left[0]! / 200) * 16) + "," + Math.round((left[2]! / 200) * 16);
  keysOf.push({ gi: s.gi, key: q, boxes: refs.map((x) => x.box!.slice()) });
}
const counts = new Map<string, number>();
for (const k of keysOf) counts.set(k.key, (counts.get(k.key) ?? 0) + 1);
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
console.log(`  相異「左件水平範圍」樣式：${sorted.length}`);
for (const K of [8, 16, 32, 64]) {
  const covered = sorted.slice(0, K).reduce((s, [, v]) => s + v, 0);
  console.log(`  取前 ${String(K).padStart(2)} 種：覆蓋 ${(100 * covered / two.length).toFixed(1)}% 的左右形字`);
}
console.log("\n  前 12 種（左件 x1,x2 量化到 16 格 → 出現次數）：");
for (const [k, v] of sorted.slice(0, 12)) console.log(`    ${k.padEnd(10)} ${v.toLocaleString()}`);
