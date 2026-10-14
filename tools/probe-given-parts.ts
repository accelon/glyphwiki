#!/usr/bin/env bun
/**
 * probe-given-parts.ts — **部件已知時，反查最佳基字**（師父第 114 輪的問題 ✓）。
 *
 * 師父問：「如果我告訴你，『金木水火土』構成了 `elements.png`。
 *          你有辦法擬合出最佳的基字和構形序嗎？」
 *
 * 這一問把問題從「**辨識**」（難 ✗）變成「**擬合**」（可行 ✓）：
 *   部件已知 → 拿部件組合去查字庫的 97,079 筆 IDS 分解 ✓ → 候選字 ✓
 *   → 把候選字**畫出來**和圖比（同一套正規化 ＋ IoU ✓）→ 最佳基字 ✓
 *   → 再從基字的部件序列推出**構形序**（基字 ＋ 舊→新 ✓）
 *
 * 用法:
 *   bun run tools/probe-given-parts.ts 金木水火土 [--image out/_mask-elements.txt] [--top 10]
 *   bun run tools/probe-given-parts.ts 好學孔孟   [--image out/_mask-xue.txt]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as F from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { loadSyn, RADICAL_RANGES } from "./syn-graph.ts";
import { buildFormGroups, canonicalOf, loadTotalStrokes } from "./form-groups.ts";
import { loadVariantPairs } from "./unihan-variants.ts";
import { ensureEngine } from "./compose-fit.ts";
import { drawingIdx, evalSeq, refSlotsOf, slotPosOf } from "./free-compose.ts";
import { rasterize } from "./raster.ts";
import { normalizedMask } from "./shape-similarity.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const GIVEN = (argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--image" &&
  argv[argv.indexOf(a) - 1] !== "--top" && argv[argv.indexOf(a) - 1] !== "--size") ?? "").replace(/\s/g, "");
if (!GIVEN) { console.error("用法：bun run tools/probe-given-parts.ts 金木水火土 [--image out/_mask-elements.txt]"); process.exit(1); }
const IMAGE = arg("--image");
const TOP = Number(arg("--top", "10"));
const SIZE = 48;

const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();

/* ---- 形式群（把 氵→水、釒→金 這種正規化 ✓，兩邊才比得起來 ✓） ---- */
const RANGES: [number, number][] = [
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff],
  [0x20000, 0x2a6df], [0x2a700, 0x2b73f], [0x2b740, 0x2b81f], [0x2b820, 0x2ceaf],
  [0x2ceb0, 0x2ebef], [0x2ebf0, 0x2ee5f], [0x2f800, 0x2fa1f],
  [0x30000, 0x3134f], [0x31350, 0x323af],
];
const inLib = (cp: number) => RANGES.some(([a, b]) => cp >= a && cp <= b);
const usage = new Map<number, Map<string, number>>();
for (let gi = 0; gi < lib.glyphs.length; gi++) {
  const g = lib.glyphs[gi];
  if (!g) continue;
  const slots = refSlotsOf(lib, gi);
  if (slots.length < 2) continue;
  const boxes = slots.map((s: any) => s.box);
  for (const s of slots) {
    const cp = F.codePointOf(lib, s.ref);
    if (!cp) continue;
    const m = usage.get(cp) ?? new Map<string, number>();
    const z = slotPosOf(s.box, boxes);
    m.set(z, (m.get(z) ?? 0) + 1);
    usage.set(cp, m);
  }
}
const usageTotal = (cp: number) => { const m = usage.get(cp); if (!m) return 0; let n = 0; for (const v of m.values()) n += v; return n; };
const variantsFile = resolve(ROOT, "unihan/Unihan_Variants.txt");
const syn = loadSyn({ unicodeData: resolve(ROOT, "unihan/UnicodeData.txt"), variants: variantsFile, inLib });
const fg = buildFormGroups({
  radicalStrokePath: resolve(ROOT, "unihan/Unihan_RadicalStrokeCounts.txt"),
  variantPairs: syn.pairs.map((p) => [p[0], p[1]] as [number, number]),
  simpTradPairs: [
    ...loadVariantPairs(variantsFile, ["kSimplifiedVariant"], inLib).map((p) => [p.a, p.b] as [number, number]),
    ...loadVariantPairs(variantsFile, ["kTraditionalVariant"], inLib).map((p) => [p.a, p.b] as [number, number]),
  ],
  strokeCount: (cp) => loadTotalStrokes(resolve(ROOT, "unihan/Unihan_IRGSources.txt")).get(cp) ?? null,
  usageCount: usageTotal, minUsage: 5,
  simpleShape: (cp) => { const c = lib.comp?.get(cp); return !c || c.length === 0; },
  blockRank: (cp) => (inLib(cp) ? 0 : 1),
  inRange: (cp) => inLib(cp) || RADICAL_RANGES.some(([a, b]) => cp >= a && cp <= b),
});
const canon = (cp: number) => canonicalOf(fg, cp);
const ch = (cp: number) => { try { return String.fromCodePoint(cp); } catch { return "?" }; };
const hex = (cp: number) => "U+" + cp.toString(16).toUpperCase();

/* ---- ① 反查：哪個字的部件（正規化後）包含全部給定部件？ ---- */
const want = Array.from(GIVEN).map((c) => canon(c.codePointAt(0)!));
const wantSet = new Map<number, number>();
for (const c of want) wantSet.set(c, (wantSet.get(c) ?? 0) + 1);
console.log(`給定部件：${Array.from(GIVEN).join("")}（正規化後 ${want.map((c) => ch(c)).join("")}）`);

interface Cand { cp: number; comps: number[]; extra: number; missing: number }
const cands: Cand[] = [];
for (const [cp, compsRaw] of lib.comp ?? []) {
  const comps = compsRaw.map((c) => canon(c));
  const have = new Map<number, number>();
  for (const c of comps) have.set(c, (have.get(c) ?? 0) + 1);
  let missing = 0, extra = 0;
  for (const [c, n] of wantSet) missing += Math.max(0, n - (have.get(c) ?? 0));
  for (const [c, n] of have) extra += Math.max(0, n - (wantSet.get(c) ?? 0));
  if (missing > 0) continue;                    /* 一定要包含全部給定部件 ✓ */
  cands.push({ cp, comps, extra, missing });
}
cands.sort((a, b) => a.extra - b.extra || a.comps.length - b.comps.length);
console.log(`\n① 部件的組合**包含**「${Array.from(GIVEN).join("")}」的字：${cands.length.toLocaleString()} 個`);
console.log(`   最貼近的 ${Math.min(TOP, cands.length)} 個（extra＝多出來的部件數 ✓，0＝完全吻合 ✓）：`);
for (const c of cands.slice(0, TOP)) {
  console.log(`   extra=${c.extra}　${hex(c.cp)} ${ch(c.cp)}　${c.comps.map((x) => ch(x)).join("＋")}` +
    `　（庫中字形 ${F.displayName(lib, F.indexOfCodePoint(lib, c.cp) ?? 0)}）`);
}

/* ---- ② 有圖的話：把候選字畫出來比對 ✓ ---- */
if (IMAGE) {
  const lines = readFileSync(resolve(ROOT, IMAGE), "utf8").trim().split(/\r?\n/);
  const q = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) q[y * SIZE + x] = (lines[y] ?? "")[x] === "1" ? 1 : 0;
  const iou = (a: Uint8Array, b: Uint8Array, shift = 1): number => {
    let best = 0;
    for (let dy = -shift; dy <= shift; dy++) for (let dx = -shift; dx <= shift; dx++) {
      let inter = 0, uni = 0;
      for (let y = 0; y < SIZE; y++) {
        const sy = y + dy; if (sy < 0 || sy >= SIZE) continue;
        for (let x = 0; x < SIZE; x++) {
          const sx = x + dx; if (sx < 0 || sx >= SIZE) continue;
          const A = a[sy * SIZE + sx]!, B = b[y * SIZE + x]!;
          if (A && B) inter++;
          if (A || B) uni++;
        }
      }
      const v = uni ? inter / uni : 0;
      if (v > best) best = v;
    }
    return best;
  };
  console.log(`\n② 與 ${IMAGE} 的比對（掃前 ${Math.min(200, cands.length)} 個候選 ✓）：`);
  const scored: { cp: number; v: number; extra: number }[] = [];
  for (const c of cands.slice(0, 200)) {
    const gi = F.indexOfCodePoint(lib, c.cp);
    if (gi === undefined) continue;
    let r = null;
    try {
      const di = drawingIdx(lib, gi);
      const kage = new Kage();
      const seen = new Set<number>(), stack = [di];
      while (stack.length) {
        const j = stack.pop()!;
        if (seen.has(j)) continue;
        seen.add(j);
        kage.kBuhin.push(F.keyOfIdx(lib, j), F.toKageData(lib.glyphs[j]!, lib));
        for (const s of lib.glyphs[j]!.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
      }
      r = rasterize(kage, F.keyOfIdx(lib, di), SIZE, 1);
    } catch { r = null; }
    if (!r) continue;
    const m = normalizedMask(r, SIZE);
    if (!m) continue;
    scored.push({ cp: c.cp, v: iou(q, m), extra: c.extra });
  }
  scored.sort((a, b) => b.v - a.v);
  for (const s of scored.slice(0, TOP)) {
    console.log(`   IoU ${s.v.toFixed(3)}　extra=${s.extra}　${hex(s.cp)} ${ch(s.cp)}`);
  }
}

/* ---- ③ 給定部件「自己拼」的可能性：有沒有現成的基字可以直接依序換上去？ ---- */
console.log(`\n③ 各部件本身的資訊（能不能當「新部件」用 ✓）：`);
for (const c of Array.from(GIVEN)) {
  const cp = c.codePointAt(0)!;
  const gi = F.indexOfCodePoint(lib, cp);
  const comps = lib.comp?.get(cp) ?? [];
  console.log(`   ${c} ${hex(cp)}：${gi === undefined ? "不在庫 ✗" : F.displayName(lib, drawingIdx(lib, gi))}` +
    `、部件 ${comps.length ? comps.map((x) => ch(x)).join("＋") : "（無 IDS，是基礎部件 ✓）"}` +
    `、被當部件用 ${usageTotal(cp).toLocaleString()} 次`);
}
void evalSeq;
