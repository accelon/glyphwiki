#!/usr/bin/env bun
/**
 * probe-image-match.ts — **以圖找字**的原型（`challenge.md` 的第一個目標）。
 *
 * 想法（不用機器學習 ✓，用這個專案現有的東西 ✓）：
 *   ① 查詢圖 → 正規化墨跡點陣（`out/_img2mask.py` ✓）
 *   ② 字庫每個字 → 渲染 → 同樣的正規化點陣（`normalizedMask()` ✓）
 *   ③ 比 IoU → 排名 ✓
 *
 * 用法:
 *   bun run tools/probe-image-match.ts --query out/_mask-bianbian.txt [--answer U+30EDE] [--limit 3000] [--top 12]
 *   --limit N   只掃前 N 個有碼位的字形（量速度用 ✓）；不給＝全掃（19 萬個，會跑幾分鐘 ✓）
 *   --answer    已知答案（印出它的名次 ✓）
 *   --from N    從第 N 個開始（分段掃描用 ✓）
 *
 * 產物: 螢幕排名 ＋（`--out` 給定時）`out/image-match.tsv`
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as F from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { ensureEngine } from "./compose-fit.ts";
import { drawingIdx, setBox } from "./free-compose.ts";
import { rasterize } from "./raster.ts";
import { normalizedMask } from "./shape-similarity.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const arg = (name: string, def?: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const QUERY = arg("--query");
if (!QUERY) { console.error("要給 --query out/_mask-XXX.txt"); process.exit(1); }
const SIZE = Number(arg("--size", "48"));
const LIMIT = arg("--limit") ? Number(arg("--limit")) : Infinity;
const FROM = Number(arg("--from", "0"));
const TOP = Number(arg("--top", "12"));
const ANSWER = arg("--answer");
const OUT = arg("--out");
/** `--blur K`：兩邊都模糊 K 次再比（軟 IoU ✓）。K=0＝硬 IoU ✗（本輪實測：硬 IoU 是雜訊） */
const BLUR = Number(arg("--blur", "0"));

const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();

/* ① 查詢點陣 */
const qLines = readFileSync(resolve(ROOT, QUERY), "utf8").trim().split(/\r?\n/);
const q = new Uint8Array(SIZE * SIZE);
for (let y = 0; y < SIZE; y++) {
  const line = qLines[y] ?? "";
  for (let x = 0; x < SIZE; x++) q[y * SIZE + x] = line[x] === "1" ? 1 : 0;
}
const qInk = q.reduce((a, b) => a + b, 0);
console.log(`查詢 ${QUERY}：${SIZE}×${SIZE}、墨格 ${qInk}（${(qInk / (SIZE * SIZE) * 100).toFixed(1)}%）` +
  (BLUR > 0 ? `、模糊 ${BLUR} 次（軟 IoU ✓）` : "、硬 IoU ✗"));
const qb = BLUR > 0 ? blur(q, BLUR) : null;

/** 模糊點陣（0–1 軟覆蓋率）：容忍筆寬不同與一兩格位移 ✓
 *  ——這是 chamfer 距離的便宜替代 ✓（本專案沒有機器學習框架 ✗，但這一招很有效 ✓） */
function blur(m: Uint8Array, k: number): Float32Array {
  let cur = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < m.length; i++) cur[i] = m[i]!;
  for (let it = 0; it < k; it++) {
    const next = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        let sum = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const sy = y + dy, sx = x + dx;
            if (sy < 0 || sy >= SIZE || sx < 0 || sx >= SIZE) continue;
            sum += cur[sy * SIZE + sx]!;
            n++;
          }
        }
        next[y * SIZE + x] = sum / n;
      }
    }
    cur = next;
  }
  return cur;
}

/** 軟 IoU（fuzzy）：Σmin ÷ Σmax ✓——對筆寬與位移都比較寬容 ✓ */
function softIou(a: Float32Array, b: Float32Array): number {
  let mn = 0, mx = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    mn += Math.min(x, y);
    mx += Math.max(x, y);
  }
  return mx > 0 ? mn / mx : 0;
}

/** IoU（含小位移容忍：印出來的字與 KAGE 畫法常差一兩格 ✓） */
function score(a: Uint8Array, b: Uint8Array, shift = 1): number {
  let best = 0;
  for (let dy = -shift; dy <= shift; dy++) {
    for (let dx = -shift; dx <= shift; dx++) {
      let inter = 0, uni = 0;
      for (let y = 0; y < SIZE; y++) {
        const sy = y + dy;
        if (sy < 0 || sy >= SIZE) continue;
        for (let x = 0; x < SIZE; x++) {
          const sx = x + dx;
          if (sx < 0 || sx >= SIZE) continue;
          const A = a[sy * SIZE + sx]!, B = b[y * SIZE + x]!;
          if (A && B) inter++;
          if (A || B) uni++;
        }
      }
      const v = uni ? inter / uni : 0;
      if (v > best) best = v;
    }
  }
  return best;
}

/* ② 掃字庫（只掃「有碼位的字」，每個碼位取它的代表字形 ✓） */
const t0 = Date.now();
const top: { cp: number; ix: number; v: number }[] = [];
let scanned = 0;
for (let gi = 0; gi < lib.glyphs.length; gi++) {
  const cp = F.codePointOf(lib, gi);
  if (!cp) continue;
  if (scanned < FROM) { scanned++; continue; }
  if (scanned - FROM >= LIMIT) break;
  scanned++;
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
  const v = qb ? softIou(qb, blur(m, BLUR)) : score(q, m);
  if (top.length < TOP || v > top[top.length - 1]!.v) {
    top.push({ cp, ix: gi, v });
    top.sort((a, b) => b.v - a.v);
    if (top.length > TOP) top.length = TOP;
  }
}
const ms = Date.now() - t0;
const rate = scanned / Math.max(1, ms / 1000);
const ch = (cp: number) => { try { return String.fromCodePoint(cp); } catch { return "?" }; };
const hex = (cp: number) => "U+" + cp.toString(16).toUpperCase();

console.log(`\n掃了 ${scanned.toLocaleString()} 個碼位、${ms.toLocaleString()} ms（${rate.toFixed(0)} 個/秒）`);
console.log(`全部掃完（19 萬個）估計要 ${(191727 / rate / 60).toFixed(1)} 分鐘\n`);
console.log(`前 ${top.length} 名：`);
for (const t of top) {
  const comps = lib.comp?.get(t.cp) ?? [];
  console.log(`  ${t.v.toFixed(3)}　${hex(t.cp)}　${ch(t.cp)}　${F.displayName(lib, t.ix)}` +
    (comps.length ? `　${comps.map((c: number) => ch(c)).join("＋")}` : ""));
}
if (ANSWER) {
  const cpA = Number(ANSWER.replace(/^U\+/i, "")) === 0 ? NaN : parseInt(ANSWER.replace(/^U\+/i, ""), 16);
  const rank = top.findIndex((t) => t.cp === cpA);
  console.log(`\n答案 ${ANSWER}（${ch(cpA)}）：` + (rank >= 0
    ? `**前 ${TOP} 名內、第 ${rank + 1} 名** ✓（IoU ${top[rank]!.v.toFixed(3)}）`
    : `**不在前 ${TOP} 名** ✗（要全掃才知真正名次）`));
}
if (OUT) {
  const rows = ["IoU\t碼位\t字\t字形名"];
  for (const t of top) rows.push([t.v.toFixed(4), hex(t.cp), ch(t.cp), F.displayName(lib, t.ix)].join("\t"));
  writeFileSync(resolve(ROOT, OUT), rows.join("\n") + "\n", "utf8");
  console.log(`產物：${resolve(ROOT, OUT)}`);
}
void setBox;
