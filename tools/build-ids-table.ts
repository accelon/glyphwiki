#!/usr/bin/env bun
/**
 * 第 161 輪：**頁面端建議表**（`tools/build-ids-table.ts`）✓
 *
 * ## 為什麼需要它 ✗（第 161 輪量出來的）
 *
 * 頁面的 `seqCandidatesForIds` 對六葉那題**完全給不出建議** ✗：
 *
 * | 篩子 | 存活數 |
 * | --- | ---: |
 * | 分量數 ＝ 葉數（6） | 96 |
 * | **只有一個位置不同** | **0** ✗ |
 *
 * ⚠ 死因是**結構性**的 ✗：正解的第一步 `邏`（`辶 ＋ 羅`）只有 **2 個分量** ✗，
 *   而目標有 **6 個葉** ✗ —— 頁面要求「分量數 ＝ 葉數」✗，
 *   所以那一類答案**永遠找不到** ✗。
 *
 * ## 這張表
 *
 * 枚舉「**所有 6 分量的字**」的不同**分量序列** ✓（實測 **96 種** ✓），
 * 每一種跑一次搜尋 ✓ ＋ 過徒兒的四道閘門 ✓
 * （框 ≥ 2 ✓、交錯 < 0.03 ✓、路徑 ≥ 35 ✓、加上 `searchSeqForIds` 自己的併排／超框閘門 ✓），
 * 留下最好的那條 ✓。
 *
 * 頁面端用「**分量序列**」當鍵 ✓（不用整串 IDS ✓）——
 * 這樣**同一個葉序的所有算子變體**（`⿰⿱日月皿`／`⿱⿰日月皿`…）
 * 都會命中同一筆 ✓（實測：96 種序列 ↔ 96 種不同的 IDS 用法 ✓）。
 *
 * 用法: bun run tools/build-ids-table.ts [--out out/ids-table.json]
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadLibrary } from "./lib-load.ts";
import { evalSeq } from "./free-compose.ts";
import { ensureEngine } from "./compose-fit.ts";
import { crossScore } from "./cross-compare.ts";
import { spreadOf } from "./spread-compare.ts";
import { searchSeqForIds } from "./seq-search.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = resolve(ROOT, arg("--out", "out/ids-table.json")!);
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();

/** 一個「分量序列」→ 右結合的 IDS（只是為了讓搜尋吃得下 ✓）。 */
function idsOf(comps: number[]): string {
  let out = String.fromCodePoint(comps[comps.length - 1]!);
  for (let k = comps.length - 2; k >= 0; k--) out = "\u2FF0" + String.fromCodePoint(comps[k]!) + out;
  return out;
}

/* 枚舉不同分量序列 ✓（2～6 個分量都收 ✓——頁面端的死因是「分量數 ＝ 葉數」✗，
   所以「分量少但葉多」的答案也要涵蓋 ✓）。 */
const keys = new Map<string, number[]>();   /* key（碼位逗號串）→ 分量陣列 */
for (const [, comps] of lib.comp!) {
  if (comps.length < 2 || comps.length > 6) continue;
  const key = comps.join(",");
  if (!keys.has(key)) keys.set(key, comps);
}
console.log("不同的分量序列：" + keys.size + " 種");

interface Ent { ids: string; seq: string; paths: number; cross: number; len: number; frames: number }
const table: Record<string, Ent> = {};
const t0 = Date.now();
let done = 0, withGood = 0, skipped = 0;
for (const [key, comps] of keys) {
  done++;
  const IDS = idsOf(comps);
  let r: any = null;
  try { r = searchSeqForIds(lib, IDS, { judgeMax: 400 }); } catch { r = null; }
  if (!r || !r.ok || !r.candidates.length) { skipped++; continue; }
  let best: Ent | null = null;
  for (const c of r.candidates.slice(0, 40)) {
    let q: any = null;
    try { q = evalSeq(lib, c.seq, {}); } catch { continue; }
    if (!q || !q.ok) continue;
    let sp: any = null;
    try { sp = spreadOf(q.lib, q.targetIdx); } catch { continue; }
    /* ★ 四道閘門 ✓ */
    if (!(sp.frames.length >= 2 && sp.cross < 0.03 && sp.paths >= 35)) continue;
    if (!best || sp.paths > best.paths) {
      best = { ids: IDS, seq: c.seq, paths: sp.paths, cross: sp.cross, len: sp.len, frames: sp.frames.length };
    }
  }
  if (best) { table[key] = best; withGood++; }
  if (done % 100 === 0) {
    console.log("  " + done + "/" + keys.size + "　有答案 " + withGood + "　" +
      ((Date.now() - t0) / 1000).toFixed(0) + "s");
  }
}
writeFileSync(OUT, JSON.stringify(table), "utf8");
console.log("");
console.log("完成：" + done + " 種、有答案 **" + withGood + "** 筆、跳過 " + skipped +
  "　耗時 " + ((Date.now() - t0) / 1000).toFixed(0) + "s");
console.log("表：" + OUT + "（" + (JSON.stringify(table).length / 1024).toFixed(0) + " KB）");
