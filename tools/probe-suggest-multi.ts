/**
 * probe-suggest-multi.ts — 找「**多個推薦**」的實例（給 UI 測試用），並量這個功能的涵蓋面。
 *
 * 為什麼要：師父第 112 輪說「如果有多個推薦，可以利用下方的庫存區」——
 * UI 要有實例可測 ✓；順便回答「這種情形多不多」✓。
 *
 * 用法: bun run tools/probe-suggest-multi.ts [--top 12]
 * 做法：對每個有 IDS 分解的字（當基字），把每個分量換成**同形式群的其他形式**，
 *       統計「同一個目標序列有幾個可建議的基字」✓。
 */
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import * as F from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { loadSyn, RADICAL_RANGES } from "./syn-graph.ts";
import { buildFormGroups, loadTotalStrokes } from "./form-groups.ts";
import { loadVariantPairs } from "./unihan-variants.ts";
import { refSlotsOf, slotPosOf, canReplaceCp, drawingIdx } from "./free-compose.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const TOP = (() => { const i = argv.indexOf("--top"); return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : 12; })();
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });

const RANGES: [number, number][] = [
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff],
  [0x20000, 0x2a6df], [0x2a700, 0x2b73f], [0x2b740, 0x2b81f], [0x2b820, 0x2ceaf],
  [0x2ceb0, 0x2ebef], [0x2ebf0, 0x2ee5f], [0x2f800, 0x2fa1f],
  [0x30000, 0x3134f], [0x31350, 0x323af],
];
const inLib = (cp: number) => RANGES.some(([a, b]) => cp >= a && cp <= b);
const strokes = loadTotalStrokes(resolve(ROOT, "unihan/Unihan_IRGSources.txt"));
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
  strokeCount: (cp) => strokes.get(cp) ?? null,
  usageCount: usageTotal, minUsage: 5,
  simpleShape: (cp) => { const c = lib.comp?.get(cp); return !c || c.length === 0; },
  blockRank: (cp) => (inLib(cp) ? 0 : 1),
  inRange: (cp) => inLib(cp) || RADICAL_RANGES.some(([a, b]) => cp >= a && cp <= b),
});
const canonOf = (cp: number) => fg.canonical.get(cp) ?? cp;
const ch = (cp: number) => { try { return String.fromCodePoint(cp); } catch { return "?" }; };

/* 索引：正規化序列 → 字 */
const bySeq = new Map<string, number[]>();
for (const [cp, comps] of lib.comp ?? []) {
  if (!comps.length || comps.length > 8) continue;
  const k = comps.map(canonOf).join(",");
  const l = bySeq.get(k);
  if (l) l.push(cp); else bySeq.set(k, [cp]);
}

/* 枚舉：基字 × 分量 × 形式（誰都可以換給誰：同群的不同形式） */
const multi: { base: number; oldCp: number; newCp: number; n: number; list: string[]; u: number }[] = [];
let one = 0, zero = 0;
for (const [baseCp, comps] of lib.comp ?? []) {
  if (!comps.length || comps.length > 4) continue;
  if (!(baseCp >= 0x4e00 && baseCp <= 0x9fff)) continue;      /* 只看一般漢字（用戶真的會打的） */
  for (let ix = 0; ix < comps.length; ix++) {
    const oldCp = comps[ix]!;
    const group = fg.members.get(canonOf(oldCp));
    if (!group || group.length < 2) continue;
    for (const newCp of group) {
      if (newCp === oldCp) continue;
      /* ⚠ **新部件本身也要在字庫裡**（畫得出來）——`⺣`、`⺾` 這種部首補充區的碼位
         不在我們字集的 12 個區段裡 ✗，引擎畫不出來，那種組合客人根本用不到 ✓。 */
      if (F.indexOfCodePoint(lib, newCp) === undefined) continue;
      const target = comps.slice();
      target[ix] = newCp;
      const tkey = target.map(canonOf).join(",");
      const cands = (bySeq.get(tkey) ?? []).filter((cp) => cp !== baseCp);
      /* 只算「頁面會建議的」：差一個位置、同形式群、引擎換得動 ✓ */
      const okList: string[] = [];
      for (const cp of cands) {
        const seq = lib.comp!.get(cp)!;
        if (seq.length !== target.length) continue;
        let diff = -1, n = 0;
        for (let j = 0; j < seq.length; j++) if (seq[j] !== target[j]) { diff = j; n++; }
        if (n !== 1) continue;
        if (canonOf(seq[diff]!) !== canonOf(target[diff]!)) continue;
        const gi0 = F.indexOfCodePoint(lib, cp);
        if (gi0 === undefined) continue;
        const gi = drawingIdx(lib, gi0);
        const fromCp = seq[diff]!;
        if (!canReplaceCp(lib, gi, fromCp)) continue;
        okList.push(ch(cp) + ch(fromCp) + ch(target[diff]!));
      }
      if (okList.length >= 2) multi.push({ base: baseCp, oldCp, newCp, n: okList.length, list: okList, u: usageTotal(baseCp) });
      else if (okList.length === 1) one++;
      else zero++;
    }
  }
}
console.log(`枚舉「把某個分量換成同群的其他形式」：有 1 個建議 ${one.toLocaleString()} 組、` +
  `**2 個以上** ${multi.length.toLocaleString()} 組、沒有建議 ${zero.toLocaleString()} 組`);
multi.sort((a, b) => b.n - a.n);
console.log(`\n推薦最多的 ${Math.min(TOP, multi.length)} 組：`);
for (const m of multi.slice(0, TOP)) {
  console.log(`  ${ch(m.base)}＋${ch(m.oldCp)}→${ch(m.newCp)}　→ ${m.n} 個建議：${m.list.join("、")}`);
}
/* **常見基字**的多推薦（UI 測試要用客人真的會打的字 ✓）：用量大的排前面 */
const common = multi.filter((m) => m.u >= 20).sort((a, b) => b.u - a.u || b.n - a.n);
console.log(`\n常見基字（在語料裡被當部件用 ≥20 次）的多推薦 ${common.length} 組，前 10：`);
for (const m of common.slice(0, 10)) {
  console.log(`  ${ch(m.base)}${ch(m.oldCp)}${ch(m.newCp)}　（基字用量 ${m.u}、${m.n} 個建議）：${m.list.slice(0, 6).join("、")}`);
}
if (common.length) console.log(`\n測試字串建議用：${ch(common[0]!.base)}${ch(common[0]!.oldCp)}${ch(common[0]!.newCp)}`);
