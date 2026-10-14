#!/usr/bin/env bun
/**
 * probe-seq-candidates.ts — **任意 IDS → 建議構形序**的排序判準（師父第 125 輪的例子 ✓）。
 *
 * 師父要的體驗：
 *   客人輸入「`⿰木垚`」→ 系統按 IDC 左右各半畫得醜醜的 ✓ →
 *   然後很聰明地建議「**`桂圭垚`**」（`桂`＝木＋圭 ✓，把 `圭` 換成 `垚` ✓）→ 點一下字就漂亮了 ✓。
 *
 * 演算法（**不需要新資料** ✓，用字庫的 `comp`（直接分量 ✓））：
 *   ① 目標的葉序（例 木,垚 ✓）
 *   ② 掃字庫：長度相同、**只差一個位置**的字 ✓（＝換一次就好 ✓）
 *   ③ **排序**：本檔要驗的就是這個 ✓——我猜是「**被換掉的部件 與 目標部件 的墨量相近**」✓
 *     （`圭`(2 個土) 與 `垚`(3 個土) 幾乎一樣大 ✓；`札` 的 `乚` 太小 ✗）
 *   ④ 再用引擎真組一次 ＋「墨疊一塊」檢查 ✓
 *
 * 用法: bun run tools/probe-seq-candidates.ts [--ids "⿰木垚"] [--top 12]
 */
import { resolve } from "node:path";
import * as F from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { ensureEngine, inkIn, inkOfRefInParent } from "./compose-fit.ts";
import { drawingIdx, evalSeq, refSlotsOf } from "./free-compose.ts";
import { rasterize } from "./raster.ts";
import { normalizedMask } from "./shape-similarity.ts";
import { inkConflictOf, isInkBlob } from "./ink-conflict.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const IDS = arg("--ids", "⿰木垚")!;
const TOP = Number(arg("--top", "12"));

const ARITY: Record<string, number> = {
  "⿰": 2, "⿱": 2, "⿲": 3, "⿳": 3, "⿴": 2, "⿵": 2, "⿶": 2, "⿷": 2,
  "⿸": 2, "⿹": 2, "⿺": 2, "⿻": 2,
};
function leavesOf(s: string): number[] | null {
  const cs = Array.from(s), out: number[] = [];
  for (const c of cs) {
    if (ARITY[c]) continue;
    if (c === "&" || c === "{" || c === "[" || c === "#") return null;
    out.push(c.codePointAt(0)!);
  }
  return out;
}
const target = leavesOf(IDS);
if (!target) { console.error("解析不了 ✗"); process.exit(1); }
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();
const ch = (cp: number) => { try { return String.fromCodePoint(cp); } catch { return "?" }; };
const hex = (cp: number) => "U+" + cp.toString(16).toUpperCase();
console.log(`目標 IDS：${IDS}　葉序：${target.map(ch).join("＋")}`);

/* ① 掃「只差一個位置」的字 ✓ */
const cands: { cp: number; comps: number[]; diff: number; gi: number }[] = [];
for (const [cp, comps] of lib.comp ?? []) {
  if (comps.length !== target.length) continue;
  let diff = -1, n = 0;
  for (let i = 0; i < comps.length; i++) if (comps[i] !== target[i]) { diff = i; n++; }
  if (n !== 1) continue;
  const gi = F.indexOfCodePoint(lib, cp);
  if (gi === undefined) continue;
  cands.push({ cp, comps, diff, gi });
}
console.log(`只差一個位置的字：${cands.length.toLocaleString()} 個`);

/* ② 每個候選算「被換掉的部件 vs 目標部件」的墨量比 ✓（用**墨框面積**當便宜的代理 ✓） */
const inkArea = (gi: number): number => {
  try {
    const di = drawingIdx(lib, gi);
    const b = inkIn(lib, di);
    return Math.max(1, (b.x2 - b.x1) * (b.y2 - b.y1));
  } catch { return 1; }
};
const tgtArea = new Map<number, number>();
for (const t of target) {
  const gi = F.indexOfCodePoint(lib, t);
  tgtArea.set(t, gi === undefined ? 1 : inkArea(gi));
}
const scored = cands.map((c) => {
  const di = drawingIdx(lib, c.gi);
  const slots = refSlotsOf(lib, di);
  let slotArea = 1;
  for (const s of slots) {
    const rc = F.codePointOf(lib, s.ref);
    if (rc !== null && rc === c.comps[c.diff]) {
      let b = s.box as number[];
      try { const ink = inkOfRefInParent(lib, di, s.strokeIx); if (ink && ink.x2 > ink.x1) b = [ink.x1, ink.y1, ink.x2, ink.y2]; } catch { /* 用引用框 ✓ */ }
      slotArea = Math.max(1, (b[2]! - b[0]!) * (b[3]! - b[1]!));
      break;
    }
  }
  /* 比＝槽位墨量 ÷ 目標部件墨量 ✓；1.0 最理想 ✓（＝那個槽位本來就裝得下 ✓） */
  const ratio = slotArea / (tgtArea.get(target[c.diff]!) ?? 1);
  const bmp = c.cp >= 0x4e00 && c.cp <= 0x9fff;
  return { ...c, ratio, bmp, score: Math.abs(Math.log(ratio)) - (bmp ? 0.3 : 0) };
}).sort((a, b) => a.score - b.score);

console.log(`\n依「槽位墨量 ÷ 目標部件墨量」（越接近 1 越好 ✓）排序，前 ${TOP} 名：`);
for (const c of scored.slice(0, TOP)) {
  console.log(`  比 ${c.ratio.toFixed(2)}　${hex(c.cp)} ${ch(c.cp)}＝${c.comps.map(ch).join("＋")}` +
    `　→ 序：${ch(c.cp)}${ch(c.comps[c.diff]!)}${ch(target[c.diff]!)}`);
}
console.log(`\n師父的例子「桂」排第：${scored.findIndex((c) => c.cp === 0x6842) + 1} 名`);

/* ②b **形狀相似度**（我猜這才是師父的判準 ✓）：被換掉的部件 vs 目標部件 ✓
   （`圭` 與 `垚` 幾乎同形 ✓ → 換上去佈局幾乎不變 ✓ → 漂亮 ✓；
    `魁` 與 `垚` 差很多 ✗ → 槽位本來是為魁設計的 ✗ → 難看 ✓） */
function maskOfCp(cp: number): Uint8Array | null {
  const gi = F.indexOfCodePoint(lib, cp);
  if (gi === undefined) return null;
  try {
    const di = drawingIdx(lib, gi);
    const kage = new (globalThis as any).Kage();
    const seen = new Set<number>(), stack = [di];
    while (stack.length) {
      const j = stack.pop()!;
      if (seen.has(j)) continue;
      seen.add(j);
      kage.kBuhin.push(F.keyOfIdx(lib, j), F.toKageData(lib.glyphs[j]!, lib));
      for (const s of lib.glyphs[j]!.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
    }
    return normalizedMask(rasterize(kage, F.keyOfIdx(lib, di), 48, 1), 48);
  } catch { return null; }
}
function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    if (x && y) inter++;
    if (x || y) uni++;
  }
  return uni ? inter / uni : 0;
}
const targetMasks = new Map<number, Uint8Array | null>();
for (const t of target) targetMasks.set(t, maskOfCp(t));
const byShape = cands.map((c) => {
  const a = maskOfCp(c.comps[c.diff]!), b = targetMasks.get(target[c.diff]!) ?? null;
  const sim = a && b ? iou(a, b) : 0;
  return { ...c, sim, bmp: c.cp >= 0x4e00 && c.cp <= 0x9fff };
}).sort((x, y) => (y.sim - x.sim) || ((y.bmp ? 1 : 0) - (x.bmp ? 1 : 0)));
console.log(`\n依「**被換掉的部件 與 目標部件 的形狀相似度**」排序，前 ${TOP} 名：`);
for (const c of byShape.slice(0, TOP)) {
  console.log(`  相似 ${c.sim.toFixed(2)}　${hex(c.cp)} ${ch(c.cp)}＝${c.comps.map(ch).join("＋")}` +
    `　→ 序：${ch(c.cp)}${ch(c.comps[c.diff]!)}${ch(target[c.diff]!)}`);
}
console.log(`「桂」排第：**${byShape.findIndex((c) => c.cp === 0x6842) + 1} 名** ✓`);

/* ②c **引擎自己的判準**：「沿用原框」✓（＝那個槽位本來就裝得下 ✓，不必重新算框 ✓）。
   師父兩條階梯的沿用原框都是 2/3、2/4 ✓——我猜這才是最貼近他「漂亮」的訊號 ✓。 */
const byKept = cands.map((c) => {
  const seq = ch(c.cp) + ch(c.comps[c.diff]!) + ch(target[c.diff]!);
  let kept = 0, ok = false, blob = false;
  try {
    const r = evalSeq(lib, seq, {});
    if (r && r.ok) {
      ok = true;
      kept = (r.log ?? []).filter((s: string) => String(s).includes("沿用原框")).length;
      const g = r.lib.glyphs[r.targetIdx]!;
      for (let i = 0; i < g.strokes.length; i++) {
        const s = g.strokes[i]!;
        if (s.kind === 99 && s.ref !== null && F.codePointOf(r.lib, s.ref) === target[c.diff]) {
          blob = isInkBlob(inkConflictOf(r.lib, r.targetIdx, i));
          break;
        }
      }
    }
  } catch { ok = false; }
  return { ...c, kept, ok, blob, bmp: c.cp >= 0x4e00 && c.cp <= 0x9fff };
}).filter((c) => c.ok && !c.blob)
  .sort((x, y) => (y.kept - x.kept) || ((y.bmp ? 1 : 0) - (x.bmp ? 1 : 0)));
console.log(`\n依「**沿用原框**」（引擎不必重算框 ✓）＋ 不疊墨 ✓ 排序，前 ${TOP} 名：`);
for (const c of byKept.slice(0, TOP)) {
  console.log(`  沿用原框 ${c.kept}　${hex(c.cp)} ${ch(c.cp)}＝${c.comps.map(ch).join("＋")}` +
    `　→ 序：${ch(c.cp)}${ch(c.comps[c.diff]!)}${ch(target[c.diff]!)}`);
}
const guiRank = byKept.findIndex((c) => c.cp === 0x6842) + 1;
console.log(`「桂」排第：**${guiRank} 名** ✓（總候選 ${byKept.length.toLocaleString()} 個 ✓）`);

/* ②d **遞迴葉子重疊** ✓（我最後的猜測，也是我覺得最對的 ✓）：
   `垚` ＝ `圭` **多一個土** ✓——兩者**遞迴**展開的葉子都是「土」✓
   （垚 ＝ 土＋𪢴 ＝ 土＋(土＋土) ✓；圭 ＝ 土＋土 ✓）→ 重疊 2/3 ✓。
   而 `千/亏/山/止` 這些 ✗ 一個土都沒有 ✓ → 0 ✓。 */
function leafSet(cp: number, depth = 0): Map<number, number> {
  const out = new Map<number, number>();
  const comps = lib.comp?.get(cp) ?? [];
  if (!comps.length || depth > 4) { out.set(cp, 1); return out; }
  for (const c of comps) {
    for (const [k, v] of leafSet(c, depth + 1)) out.set(k, (out.get(k) ?? 0) + v);
  }
  return out;
}
const byLeaves = cands.map((c) => {
  const lo = leafSet(c.comps[c.diff]!), ln = leafSet(target[c.diff]!);
  let inter = 0, tot = 0;
  for (const [k, v] of ln) { tot += v; inter += Math.min(v, lo.get(k) ?? 0); }
  const share = tot ? inter / tot : 0;
  return { ...c, share, bmp: c.cp >= 0x4e00 && c.cp <= 0x9fff };
}).sort((x, y) => (y.share - x.share) || ((y.bmp ? 1 : 0) - (x.bmp ? 1 : 0)) || (x.cp - y.cp));
console.log(`\n依「**遞迴葉子重疊**」（目標部件的葉子有多少在舊部件裡 ✓）排序，前 ${TOP} 名：`);
for (const c of byLeaves.slice(0, TOP)) {
  console.log(`  重疊 ${(c.share * 100).toFixed(0)}%　${hex(c.cp)} ${ch(c.cp)}＝${c.comps.map(ch).join("＋")}` +
    `　→ 序：${ch(c.cp)}${ch(c.comps[c.diff]!)}${ch(target[c.diff]!)}`);
}
console.log(`「桂」排第：**${byLeaves.findIndex((c) => c.cp === 0x6842) + 1} 名** ✓`);




/* ③ 前 5 名真的組一次 ✓（引擎 ＋ 墨疊檢查 ✓） */
console.log(`\n前 5 名真的組出來（引擎 ✓ ＋ 墨疊檢查 ✓）：`);
for (const c of scored.slice(0, 5)) {
  const seq = ch(c.cp) + ch(c.comps[c.diff]!) + ch(target[c.diff]!);
  let v = 0, kept = 0, blob = "?";
  try {
    const r = evalSeq(lib, seq, {});
    if (r && r.ok) {
      kept = (r.log ?? []).filter((s: string) => String(s).includes("沿用原框")).length;
      const si = (() => {
        const g = r.lib.glyphs[r.targetIdx]!;
        for (let i = 0; i < g.strokes.length; i++) {
          const s = g.strokes[i]!;
          if (s.kind === 99 && s.ref !== null && F.codePointOf(r.lib, s.ref) === target[c.diff]) return i;
        }
        return -1;
      })();
      if (si >= 0) {
        const ic = inkConflictOf(r.lib, r.targetIdx, si);
        blob = isInkBlob(ic) ? `疊墨 ${(ic.coverRatio * 100).toFixed(0)}% ✗` : "不疊墨 ✓";
        const kage = new (globalThis as any).Kage();
        const seen = new Set<number>(), stack = [r.targetIdx];
        while (stack.length) {
          const j = stack.pop()!;
          if (seen.has(j)) continue;
          seen.add(j);
          kage.kBuhin.push(F.keyOfIdx(r.lib, j), F.toKageData(r.lib.glyphs[j]!, r.lib));
          for (const s of r.lib.glyphs[j]!.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
        }
        try {
          const m = normalizedMask(rasterize(kage, F.keyOfIdx(r.lib, r.targetIdx), 48, 1), 48);
          if (m) v = m.reduce((a, b) => a + b, 0);
        } catch { /* ignore */ }
      }
    } else blob = "組不出來 ✗";
  } catch { blob = "例外 ✗"; }
  console.log(`  ${seq}　沿用原框 ${kept}　${blob}　墨格 ${v}`);
}
