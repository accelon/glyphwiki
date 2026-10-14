#!/usr/bin/env bun
/**
 * align-compare.ts — **「葉對位」**：目標的每個葉，有沒有一個序列葉落在**同一個位置**。
 *
 * ## 為什麼需要這一條（第 148 輪，徒兒失敗六次之後才對）
 *
 * 徒兒試過的所有「像不像」的量 —— 墨跡 IoU、墨跡覆蓋率、墨跡密度 ——
 * **都擋不住 `䨻`（四個雷）**。
 * 因為那些量只問「**墨夠不夠多**」，不問「**那個墨在哪裡**」。
 *
 * 第 146 輪的收縮式貪婪就是這樣被 `䨻` 接管的：
 * 它骨架 3451、覆蓋率 1.55、交錯 0.000 —— 三項全勝 —— 但它**跟目標毫無關係**。
 *
 * ✅ 「對位」問的正是「在哪裡」：目標的每一個葉（`treePositions()` ✓），
 *   有沒有一個**序列葉**落在同一個相對位置（±0.2 ✓），
 *   而且字面相同 ✓ 或 `partsCompatible()` ✓（同一個形的不同寫法 ✓）。
 *
 * 實測（`out/_align148.ts`）：
 *
 * | 候選 | 對位 | 骨架 |
 * | --- | ---: | ---: |
 * | `䨻`（四個雷） | **0/6** ✓ | 3451 |
 * | `靐` | **0/6** ✓ | 3204 |
 * | `邏`（正確的第一步） | **1/6** ✓ | 1689 |
 * | `嚣宀吅`（搜尋挑的） | 0/6 | 915 |
 *
 * → **這正是第 146 輪缺的那道閘門**。
 *
 * ## 兩個地雷（徒兒都踩過）
 *
 * ① `parseSeqTree()` 只吃 **IDS 算子**（`⿰`／`⿱`…）。
 *    構形序（`邏羅寶貝…`）**沒有算子** → 它會「解析失敗」、對位永遠 0。
 *    ✅ 正解：**基字一棵葉**，再依序把 `pairs` 的 `old` 換成 `new`
 *      （`replaceLeaf()`，見 `seqTreeOf()`）。
 * ② 不要用「整個字的骨架外框」當葉的位置（六個葉會全部落在同一點）。
 *    要用 **`treePositions()`** ——那正是 `seq-search.ts` 在用的那個。
 *
 * 用法: bun run tools/align-compare.ts [--ids "⿴辶…"]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadLibrary } from "../tools/lib-load.ts";
import { evalSeq } from "../tools/free-compose.ts";
import { ensureEngine } from "../tools/compose-fit.ts";
import {
  parseSeqTree, treePositions, treeLeaves, partsCompatible, deepLeaves, replaceLeaf,
} from "../tools/seq-search.ts";
import type { SeqNode } from "../tools/seq-search.ts";
import { idsGlyph, idsText } from "../tools/ids-glyph.ts";
import { skeletonLength, spreadOf } from "../tools/spread-compare.ts";
import { crossScore } from "../tools/cross-compare.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();

/** ★ 構形序 → 樹 ✓（基字 ＋ 逐對替換 ✓）——**不要**用 `parseSeqTree` ✗（它只吃 IDS 算子 ✓）。 */
export function seqTreeOf(seq: string): SeqNode {
  const cs = Array.from(seq);
  if (!cs.length) return { ch: "" };
  let t: SeqNode = { ch: cs[0]! };
  for (let i = 1; i + 1 < cs.length; i += 2) t = replaceLeaf(t, cs[i]!, { ch: cs[i + 1]! });
  return t;
}

/**
 * ★★ **葉對位** ✓：回傳「目標的幾個葉被對到」＋ 每個葉的細節 ✓。
 * ⚠ 這是**結構**的判準 ✓，與「墨跡像不像」互補 ✓：
 *   墨跡擋不住「骨架長但無關」的字（`䨻` ✗），對位可以 ✓。
 */
export function alignOf(seq: string, tgtPos: ReturnType<typeof treePositions>, tol = 0.2):
  { n: number; total: number; detail: string } {
  const sp = treePositions(seqTreeOf(seq));
  const used = new Set<number>();
  let n = 0;
  const bits: string[] = [];
  for (const p of tgtPos) {
    let bestJ = -1, bestD = tol;
    for (let j = 0; j < sp.length; j++) {
      if (used.has(j)) continue;
      const s = sp[j]!;
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d >= bestD) continue;
      if (s.ch === p.ch || partsCompatible(lib, s.ch, p.ch) || deepLeaves(lib, s.ch).includes(p.ch)) { bestD = d; bestJ = j; }
    }
    if (bestJ >= 0) { used.add(bestJ); n++; bits.push(p.ch + "✓"); } else bits.push(p.ch + "✗");
  }
  return { n, total: tgtPos.length, detail: bits.join(" ") };
}

/* ───────────────────────── CLI ───────────────────────── */
if (import.meta.main) {
  const opSet = "\u2FF0\u2FF1\u2FF2\u2FF3\u2FF4\u2FF5\u2FF6\u2FF7\u2FF8\u2FF9\u2FFA\u2FFB";
  const re = /[\u2FF0-\u2FFB][\u2FF0-\u2FFB\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2FFFF}]+/u;
  let IDS = arg("--ids") ?? "";
  if (!IDS) for (const line of readFileSync(resolve(ROOT, "glyph-by-ids.md"), "utf8").split(/\r?\n/)) {
    const m = re.exec(line);
    if (m && Array.from(m[0]).filter((c) => !opSet.includes(c)).length >= 6) { IDS = m[0]; break; }
  }
  const target = parseSeqTree(IDS);
  if (!target || "ch" in target) throw new Error("不是合法 IDS：" + IDS);
  const tgtPos = treePositions(target);
  console.log("目標 " + IDS);
  console.log("  葉 " + treeLeaves(target).join(" ") + "（" + tgtPos.length + " 個）");
  console.log("  位置 " + tgtPos.map((p) => p.ch + "@" + p.x.toFixed(2) + "," + p.y.toFixed(2)).join("  "));

  /* 對照：古法 / 搜尋的 / 文檔正解 / 幾個「無關的複雜字」（當反例 ✓） */
  let GOOD = "";
  {
    const page = readFileSync(resolve(ROOT, "tools/pinxing-page.js"), "utf8");
    for (const mm of page.matchAll(/"([\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2FFFF}]{8,})"/gu)) {
      if (evalSeq(lib, mm[1]!, {}).ok) { GOOD = mm[1]!; break; }
    }
  }
  const { searchSeqForIds } = await import("../tools/seq-search.ts");
  const r = searchSeqForIds(lib, IDS, { judgeMax: 400 });
  const B = r.ok && r.candidates.length ? r.candidates[0]!.seq : "";
  const probes: [string, string][] = [
    ["A 古法（IDS 本身）", IDS],
    ["B 搜尋挑的", B],
    ["C 文檔正解（人工 4 步）", GOOD],
    ["反例：䨻（四個雷）", "䨻"],
    ["反例：靐（三個雷）", "靐"],
    ["反例：邏（正解的第一步）", "邏"],
  ];
  console.log("");
  console.log("候選".padEnd(28) + "對位".padEnd(10) + "骨架".padEnd(9) + "路徑".padEnd(7) + "交錯".padEnd(8) + "引擎");
  for (const [t, seq] of probes) {
    if (!seq) continue;
    const al = alignOf(seq, tgtPos);
    const q = evalSeq(lib, seq, {});
    const sp = q.ok ? spreadOf(q.lib, q.targetIdx) : null;
    console.log(t.padEnd(28) + (al.n + "/" + al.total).padEnd(10) +
      (sp ? sp.len.toFixed(0) : "—").padEnd(9) + (sp ? String(sp.paths) : "—").padEnd(7) +
      (sp ? sp.cross.toFixed(3) : "—").padEnd(8) + (q.ok ? "ok" : "✗"));
  }
  console.log("");
  console.log("★ 判讀：**對位 0 的候選，不管骨架多長都不該被選** ✓");
  console.log("   （第 146 輪的貪婪就是選了對位 0 的 `䨻` ✗）。");
}
