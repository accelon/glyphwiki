#!/usr/bin/env bun
/**
 * probe-ladder-search.ts — **自動把 IDS 變成構字序**（師父第 116 輪說「是的」的那件事 ✓）。
 *
 * 師父示範的階梯法（`⿰木⿳金⿰水火土` → `機幾墨黒𨩛星炚日水` ✓）拆成演算法：
 *
 *   **狀態**＝一棵「字樹」（節點是字，可以再展開 ✓）
 *   **動作**＝把某個葉換成另一個字（＝引擎的「換部件」✓）
 *   **目標**＝字樹的葉集合涵蓋目標 IDS 的葉 ✓（結構近似即可 ✓——師父的結果是 ⿱ 對 ⿳，本來就是「近似」✓）
 *   **估價**＝涵蓋幾個目標葉（單調遞增 ✓）＋**一般漢字區加分**（師父：BMP 才容易打出來 ✓，
 *            沒有才往 Extension 找 ✓——「招財進寶」用 `𩀨` 就是迫於無奈 ✓）
 *   **裁判**＝真的組出來 ＋ 和圖算 IoU ＋ 數「沿用原框」幾步 ✓（沿用＝框從真字借來 ✓＝選對形式 ✓）
 *
 * 師父那條路的涵蓋數 1→2→3→4→5 ✓（單調 ✓）→ 貪婪最佳優先就找得到 ✓。
 *
 * 用法:
 *   bun run tools/probe-ladder-search.ts --ids "⿰木⿳金⿰水火土" --image out/_mask-elements.txt --png elements.png
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import * as F from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { loadIdsFile } from "./ids-source.ts";
import { ensureEngine, svgOf } from "./compose-fit.ts";
import { evalSeq } from "./free-compose.ts";
import { rasterize } from "./raster.ts";
import { normalizedMask } from "./shape-similarity.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const IDS = arg("--ids");
if (!IDS) { console.error('用法：bun run tools/probe-ladder-search.ts --ids "⿰木⿳金⿰水火土"'); process.exit(1); }
const IMAGE = arg("--image");
const PNG = arg("--png");
const DEPTH = Number(arg("--depth", "5"));
const BEAM = Number(arg("--beam", "60"));
const TOP = Number(arg("--top", "8"));
const CAND = Number(arg("--cand", "40"));
/** 安靜模式（第 120 輪的成本紀律 ✓）：只印重點 ✓——每次執行的輸出是最大的 token 浪費 ✗ */
const QUIET = argv.includes("--quiet");
/** 裁判上限：實測 9 ms/條 ✓ → 6000 條約 54 秒 ✓（師父給的預算：5 分鐘以下 ✓） */
const JUDGE_MAX = Number(arg("--judge", "6000"));
/** 每一層留多少「候選」進裁判池 ✓（不只看最後一層 ✗） */
const POOL_PER_LAYER = Number(arg("--pool", "400"));
const SIZE = 48;
const MASTER = "機幾墨黒𨩛星炚日水";          /* 師父的手工序（對照組 ✓） */

/* ---------------- IDS 解析 ---------------- */
const ARITY: Record<string, number> = {
  "⿰": 2, "⿱": 2, "⿲": 3, "⿳": 3, "⿴": 2, "⿵": 2, "⿶": 2, "⿷": 2,
  "⿸": 2, "⿹": 2, "⿺": 2, "⿻": 2,
};
type Node = { op: string; kids: Node[] } | { ch: string };
function parse(s: string): Node | null {
  const cs = Array.from(s);
  let i = 0;
  const walk = (): Node | null => {
    if (i >= cs.length) return null;
    const c = cs[i]!;
    if (c === "&" || c === "{" || c === "[" || c === "#" || c === "(") return null;
    if (ARITY[c] !== undefined) {
      i++;
      const kids: Node[] = [];
      for (let k = 0; k < ARITY[c]!; k++) { const kid = walk(); if (!kid) return null; kids.push(kid); }
      return { op: c, kids };
    }
    i++;
    return { ch: c };
  };
  const root = walk();
  return root && i === cs.length ? root : null;
}
function leaves(n: Node, out: string[] = []): string[] {
  if ("ch" in n) { out.push(n.ch); return out; }
  for (const k of n.kids) leaves(k, out);
  return out;
}
function replaceLeaf(n: Node, old: string, rep: Node): Node {
  if ("ch" in n) return n.ch === old ? rep : n;
  let done = false;
  const kids = n.kids.map((k) => {
    if (done) return k;
    if ("ch" in k && k.ch === old) { done = true; return rep; }
    const nk = replaceLeaf(k, old, rep);
    if (nk !== k) done = true;
    return nk;
  });
  return { op: n.op, kids };
}
function rootChar(t: Node): string { return "ch" in t ? t.ch : rootChar(t.kids[0]!); }

const targetTree = parse(IDS);
if (!targetTree) { console.error("解析不了 ✗：" + IDS); process.exit(1); }
const targetLeaves = leaves(targetTree);
const targetSet = new Map<string, number>();
for (const l of targetLeaves) targetSet.set(l, (targetSet.get(l) ?? 0) + 1);
console.log(`目標 IDS：${IDS}`);
console.log(`  目標葉：${targetLeaves.join(" ")}（${targetLeaves.length} 個）`);

const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();
const hexOf = (c: string) => "U+" + c.codePointAt(0)!.toString(16).toUpperCase();
const drawable = (c: string) => F.indexOfCodePoint(lib, c.codePointAt(0)!) !== undefined;
const isBmp = (c: string) => { const cp = c.codePointAt(0)!; return cp >= 0x4e00 && cp <= 0x9fff; };

/* ---------------- 索引：目標葉 → 含它的字 ✓ ---------------- */
/* ★ 第 120 輪：師父要的是「**運算時間 ＋ token**」兩種成本 ✓，不是人類工作天 ✗
   → 所以這一支要**自己報時間** ✓（索引／搜尋／裁判三段分開量 ✓）。 */
const tIndex0 = Date.now();
const tab = loadIdsFile(resolve(ROOT, "ids/ids_lv1.txt"));
interface Entry { ch: string; tree: Node; leaves: string[]; n: number; extra: number }
const byLeaf = new Map<string, Entry[]>();
let nEntries = 0;
for (const [cp, e] of tab) {
  if (!e.primary.length) continue;
  const t = parse(e.primary[0]!);
  if (!t || "ch" in t) continue;
  const c = String.fromCodePoint(cp);
  if (!drawable(c)) continue;
  const ls = leaves(t);
  if (ls.length < 2 || ls.length > 6) continue;
  const extra = ls.filter((l) => !targetSet.has(l)).length;
  const ent: Entry = { ch: c, tree: t, leaves: ls, n: ls.length, extra };
  nEntries++;
  const seen = new Set<string>();
  for (const l of ls) {
    if (seen.has(l) || !targetSet.has(l)) continue;
    seen.add(l);
    const arr = byLeaf.get(l) ?? [];
    arr.push(ent);
    byLeaf.set(l, arr);
  }
}
console.log(`  索引：${nEntries.toLocaleString()} 個可當階梯的字；` +
  `目標葉候選數 ${targetLeaves.map((l) => `${l}:${(byLeaf.get(l) ?? []).length}`).join(" ")} ✓`);
console.log(`  ⏱ 索引建置 ${((Date.now() - tIndex0) / 1000).toFixed(1)} 秒 ✓`);

/* ---------------- 幾何位置：把樹映射到單位方格 ✓ ----------------
 * ⚠ 第 116 輪第一次做錯的地方：估價只算「葉子涵蓋」✗ → 一層就找到「葉子剛好含全部目標葉」
 *   的怪字（`𨰨`）就停了 ✗，完全沒看位置 ✓。
 *   師父的方法每一步都讓部件**落在對的位置** ✓（`墨` 把 `土` 放到底部 ✓）——
 *   所以估價必須是「**同一個字、在同一個相對位置**」才算分 ✓。 */
type Pos = { ch: string; x: number; y: number };
function positions(n: Node, x0 = 0, y0 = 0, w = 1, h = 1, out: Pos[] = []): Pos[] {
  if ("ch" in n) { out.push({ ch: n.ch, x: x0 + w / 2, y: y0 + h / 2 }); return out; }
  const k = n.kids.length;
  for (let i = 0; i < k; i++) {
    switch (n.op) {
      case "⿰": positions(n.kids[i]!, x0 + (w * i) / 2, y0, w / 2, h, out); break;
      case "⿱": positions(n.kids[i]!, x0, y0 + (h * i) / 2, w, h / 2, out); break;
      case "⿲": positions(n.kids[i]!, x0 + (w * i) / 3, y0, w / 3, h, out); break;
      case "⿳": positions(n.kids[i]!, x0, y0 + (h * i) / 3, w, h / 3, out); break;
      case "⿴": positions(n.kids[i]!, x0 + w * 0.12, y0 + h * 0.12, w * 0.76, h * 0.76, out); break;
      case "⿵": positions(n.kids[i]!, x0 + (i === 0 ? 0 : w * 0.2), y0 + (i === 0 ? h * 0.3 : 0), w * (i === 0 ? 1 : 0.8), h * (i === 0 ? 0.7 : 1), out); break;
      case "⿶": positions(n.kids[i]!, x0 + (i === 0 ? w * 0.2 : 0), y0 + (i === 0 ? 0 : h * 0.3), w * (i === 0 ? 0.8 : 1), h * (i === 0 ? 1 : 0.7), out); break;
      case "⿷": positions(n.kids[i]!, x0 + (i === 0 ? 0 : w * 0.2), y0 + (i === 0 ? h * 0.2 : 0), w * (i === 0 ? 0.8 : 1), h * (i === 0 ? 0.8 : 1), out); break;
      case "⿸": positions(n.kids[i]!, x0, y0, w, h, out); break;
      case "⿹": positions(n.kids[i]!, x0, y0, w, h, out); break;
      case "⿺": positions(n.kids[i]!, x0, y0, w, h, out); break;
      case "⿻": positions(n.kids[i]!, x0, y0, w, h, out); break;
      default: positions(n.kids[i]!, x0, y0, w, h, out); break;
    }
  }
  return out;
}
/** 位置分數：目標的每個葉，在同一個相對位置找到同一個字就得 1 分（距離越遠扣越多 ✓） */
function posScore(state: Node, target: Node): number {
  const tp = positions(target), sp = positions(state);
  const used = new Set<number>();
  let score = 0;
  for (const t of tp) {
    let bestI = -1, bestD = Infinity;
    for (let i = 0; i < sp.length; i++) {
      if (used.has(i)) continue;
      const s = sp[i]!;
      if (s.ch !== t.ch) continue;
      const d = Math.hypot(s.x - t.x, s.y - t.y);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    if (bestI < 0) continue;
    used.add(bestI);
    score += Math.max(0, 1 - bestD * 1.5);          /* 同位置 1 分、偏一格就少一點 ✓ */
  }
  return score;
}

/* ---------------- 搜尋（貪婪最佳優先 ✓） ---------------- */
interface State { tree: Node; seq: [string, string][]; base: string; cov: number }
/** ⚠ 估價用**位置分數**（不是葉子涵蓋數 ✗）——見上面 `posScore` 的說明 ✓ */
const targetPos = positions(targetTree);
function scoreOf(tree: Node): number { return posScore(tree, targetTree); }
/** 全部目標葉都在對的位置（分數滿分）＝完成 ✓
 *  ⚠ 但師父的結果本身是**近似** ✓（他的 ⿱ 對目標的 ⿳ ✓，本來就不會滿分 ✗）——
 *    所以「夠近」就算完成 ✓（差 0.6 分以內 ✓＝大約一個葉偏了一點 ✓）。 */
const FULL = targetPos.length;
const NEAR = FULL - 0.6;
const isDone = (tree: Node) => scoreOf(tree) >= NEAR;

let frontier: State[] = [];
const tSearch0 = Date.now();
const rootOp = "op" in targetTree ? targetTree.op : null;
for (const l of targetLeaves) {
  for (const ent of byLeaf.get(l) ?? []) {
    /* **根算子要和目標相同** ✓（外層結構不能亂——這一步砍掉九成以上 ✗→✓） */
    if (rootOp && ("op" in ent.tree ? ent.tree.op : null) !== rootOp) continue;
    const sc = scoreOf(ent.tree);
    if (sc <= 0) continue;
    frontier.push({ tree: ent.tree, seq: [], base: ent.ch, cov: sc });
  }
}
/* 起始去重（同一個基字只留一次 ✓） */
{
  const m = new Map<string, State>();
  for (const s of frontier) { const k = s.base; const old = m.get(k); if (!old || old.cov < s.cov) m.set(k, s); }
  frontier = [...m.values()];
}
console.log(`\n起始候選（含至少一個目標葉的字）：${frontier.length.toLocaleString()} 個 ✓`);

const done: State[] = [];
/** ★ 修正①：**每一層**留一批候選進裁判池 ✓ */
const poolAll: State[] = [];
const seenSeq = new Set<string>();
for (let d = 0; d < DEPTH; d++) {
  const next: State[] = [];
  for (const st of frontier) {
    if (isDone(st.tree)) { done.push(st); continue; }
    /* 還沒對上的目標葉（位置分數低的那些 ✓）→ 找含它的字當階梯子 ✓ */
    const sp = positions(st.tree);
    const missing: string[] = [];
    for (const t of targetPos) {
      let hit = false;
      for (const s of sp) if (s.ch === t.ch && Math.hypot(s.x - t.x, s.y - t.y) < 0.2) { hit = true; break; }
      if (!hit) missing.push(t.ch);
    }
    for (const old of new Set(leaves(st.tree))) {
      const cands = new Map<string, Entry>();
      for (const m of missing) for (const ent of byLeaf.get(m) ?? []) {
        if (ent.ch === old) continue;
        if (ent.leaves.includes(old)) continue;
        const cur = cands.get(ent.ch);
        if (!cur || cur.extra > ent.extra) cands.set(ent.ch, ent);
      }
      const scored = [...cands.values()].map((ent) => {
        const tree2 = replaceLeaf(st.tree, old, ent.tree);
        const sc2 = scoreOf(tree2);
        return { ent, tree2, sc2, gain: sc2 - st.cov };
      }).filter((x) => x.gain > 1e-9)
        .sort((a, b) => (b.gain - a.gain) || (a.ent.extra - b.ent.extra) ||
          ((isBmp(b.ent.ch) ? 1 : 0) - (isBmp(a.ent.ch) ? 1 : 0)))
        .slice(0, CAND);
      for (const s of scored) {
        next.push({ tree: s.tree2, seq: [...st.seq, [old, s.ent.ch]], base: st.base, cov: s.sc2 });
      }
      /* ★★ 第 121 輪找到的**關鍵缺口**（複查師父兩條階梯才發現 ✓）：
         他的最後一步常常是「把暫用部件換成**單一目標部件**」✓（`日→水` ✓、`牜→女` ✓）——
         而上面的候選集只收「有 2–6 個葉的字」✗，所以我的搜尋**永遠收不了尾** ✗
         （一直停在 4.69/5.00 ✓ 就是這個原因 ✓）。這裡補上「換成單一目標葉」這個動作 ✓。 */
      for (const m of missing) {
        if (m === old) continue;
        const tree2 = replaceLeaf(st.tree, old, { ch: m });
        const sc2 = scoreOf(tree2);
        if (sc2 - st.cov <= 1e-9) continue;
        next.push({ tree: tree2, seq: [...st.seq, [old, m]], base: st.base, cov: sc2 });
      }
    }
  }
  const m = new Map<string, State>();
  for (const s of next) {
    const k = s.base + s.seq.map(([o, n]) => o + n).join("");
    if (!m.has(k)) m.set(k, s);
  }
  const uniq = [...m.values()];
  /* ★ 修正①：候選池從**這一層的全部狀態**取前 N 名（按位置分數 ✓），不是只看 frontier（60 ✓）✗——
     因為幾何分數只是篩子 ✓，真正的裁判是渲染出來的 IoU ✓；
     實測第一次改完只裁判了 180 條 ✗（池子被 frontier 卡住 ✓）。 */
  const byScore = [...uniq].sort((a, b) => (b.cov - a.cov) || (a.seq.length - b.seq.length));
  for (const st of byScore.slice(0, QUIET ? Math.min(POOL_PER_LAYER, 400) : POOL_PER_LAYER)) poolAll.push(st);
  frontier = byScore.slice(0, BEAM);
  for (const st of frontier) if (isDone(st.tree)) done.push(st);
  if (!QUIET) console.log(`  第 ${d + 1} 層：${next.length.toLocaleString()} 個狀態 → 留 ${frontier.length}` +
    `（最佳位置分數 ${(frontier[0]?.cov ?? 0).toFixed(2)}/${FULL.toFixed(2)}）`);
  if (!frontier.length) break;
}
console.log(`\n位置分數夠近（≥ ${NEAR.toFixed(2)}/${FULL}）的階梯：${done.length} 條 ✓`);
/* ⚠ 一條都沒有的時候，**把最後一層最好的幾個也拿去裁判** ✓——
   不然就完全看不到「差多少」✗（第一次跑就是這樣白白空手 ✓）。 */
if (!done.length) {
  for (const st of frontier.slice(0, 20)) done.push(st);
  console.log(`（沒有夠近的 → 拿最後一層最好的 ${done.length} 個去裁判 ✓）`);
}

/* ---------------- 裁判：真的組出來 ＋ IoU ＋ 沿用原框 ✓ ---------------- */
function maskOf(L: any, idx: number): Uint8Array | null {
  const kage = new (globalThis as any).Kage();
  const seen = new Set<number>(), stack = [idx];
  while (stack.length) {
    const j = stack.pop()!;
    if (seen.has(j)) continue;
    seen.add(j);
    kage.kBuhin.push(F.keyOfIdx(L, j), F.toKageData(L.glyphs[j]!, L));
    for (const s of L.glyphs[j]!.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  try { return normalizedMask(rasterize(kage, F.keyOfIdx(L, idx), SIZE, 1), SIZE); } catch { return null; }
}
function iou(a: Uint8Array, b: Uint8Array, shift = 1): number {
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
}
let img: Uint8Array | null = null;
if (IMAGE) {
  const lines = readFileSync(resolve(ROOT, IMAGE), "utf8").trim().split(/\r?\n/);
  img = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) img[y * SIZE + x] = (lines[y] ?? "")[x] === "1" ? 1 : 0;
}
interface Judged { seq: string; v: number; kept: number; steps: number; bmp: number; svg: string }
const judged: Judged[] = [];
function judge(seq: string): Judged {
  let v = 0, kept = 0, svg = "";
  let r: any = null;
  try { r = evalSeq(lib, seq, {}); } catch { r = null; }
  if (r && r.ok) {
    svg = svgOf(r.lib, r.targetIdx);
    kept = (r.log ?? []).filter((s: string) => String(s).includes("沿用原框")).length;
    if (img) { const m = maskOf(r.lib, r.targetIdx); if (m) v = iou(img, m); }
  }
  const cs = Array.from(seq);
  const bmp = cs.filter((c) => isBmp(c)).length;
  return { seq, v, kept, steps: (cs.length - 1) / 2, bmp, svg };
}
const seen = new Set<string>();
const tJudge0 = Date.now();
/* ★★ 第 121 輪的第二個關鍵修正：**「目標部件真的都在」是硬性條件** ✓——
   實測（xue 那題）：只用 IoU 排名的話，一步的 `𡧾宀𦥯` 會以 0.324 贏過師父的 0.301 ✗，
   但那只是**墨跡碰巧像** ✗、根本沒有重現目標結構（葉子不全 ✗）。
   → 所以：**葉集合必須涵蓋目標**（硬性 ✓），IoU 只在**這個前提之下**排名 ✓。 */
function hasAllLeaves(tree: Node): boolean {
  const have = new Map<string, number>();
  for (const l of leaves(tree)) have.set(l, (have.get(l) ?? 0) + 1);
  for (const [l, k] of targetSet) if ((have.get(l) ?? 0) < k) return false;
  return true;
}
/** ★ 修正①：**把裁判搬進漏斗** ✓——以前只裁判 `done` 那幾條（幾何分數選的 ✗），
   現在**每一層留著的好狀態**都進池、**全部真渲染** ✓（幾何分數只是篩子 ✓，真正的裁判是 IoU ✓）。
   成本：3–9 ms/條 ✓ → JUDGE_MAX 條的上限就是時間上限 ✓（4000 條約 30 秒 ✓）。 */
const pool = [...done, ...poolAll, ...frontier];
const poolSeen = new Set<string>();
let skippedNoLeaves = 0;
for (const st of pool) {
  if (!hasAllLeaves(st.tree)) { skippedNoLeaves++; continue; }
  const seq = st.base + st.seq.map(([o, n]) => o + n).join("");
  if (seen.has(seq) || poolSeen.has(seq)) continue;
  poolSeen.add(seq);
  if (judged.length >= JUDGE_MAX) break;
  seen.add(seq);
  judged.push(judge(seq));
}
/* ★ 修正②③：排序＝IoU 為主 ✓（**「沿用原框」給很輕的加分** ✓——同級 IoU 才會翻盤 ✓），
   再來才是 **BMP 字數** ✓（師父的原則：BMP 才容易打出來 ✓）。 */
const rank = (j: { v: number; kept: number; bmp: number; steps: number }) =>
  j.v + 0.002 * j.kept + 0.0002 * j.bmp - 0.0001 * j.steps;
judged.sort((a, b) => rank(b) - rank(a));
/* ★ 成本報告（師父要的兩種幣值之一 ✓）：搜尋與裁判各花多久 ✓ */
{
  const tJudge = (Date.now() - tJudge0) / 1000;
  const tSearch = (tJudge0 - tSearch0) / 1000;
  console.log(`\n⏱ 成本：索引 ${((tSearch0 - tIndex0) / 1000).toFixed(1)} 秒` +
    `｜搜尋 ${tSearch.toFixed(1)} 秒｜裁判 ${judged.length.toLocaleString()} 條花 ${tJudge.toFixed(1)} 秒` +
    `（${(tJudge / Math.max(1, judged.length) * 1000).toFixed(0)} ms/條 ✓）` +
    `｜合計 ${((Date.now() - tIndex0) / 1000).toFixed(1)} 秒 ✓`);
}
console.log(`\n裁判（真的組出來 ＋ 和原圖算 IoU ✓）：`);
for (const j of judged.slice(0, TOP)) {
  console.log(`  IoU ${j.v.toFixed(3)}　沿用原框 ${j.kept}/${j.steps}　BMP 字 ${j.bmp}/${j.steps * 2 + 1}　${j.seq}`);
}
const MASTER_SEQ = arg("--master");            /* 要對照手工序時才給（不同目標的序不能混用 ✗） */
const mv = MASTER_SEQ ? judge(MASTER_SEQ) : null;
if (mv) console.log(`\n對照的手工序：${MASTER_SEQ}　IoU ${mv.v.toFixed(3)}　沿用原框 ${mv.kept}/${mv.steps}`);
const best = judged[0];
/* ★ 師父的架構（第 119 輪）：**BMP 與 extension 都給、不取捨** ✓——
   所以除了「最佳」（IoU 最高 ✓），也報一條「**最佳 BMP 解**」✓（每個字都在一般漢字區 ✓）。 */
const bestBmp = judged.find((j) => j.bmp === j.steps * 2 + 1);
if (best) {
  if (!QUIET) {
    console.log(`\n裁判（真的組出來 ＋ 和原圖算 IoU ✓）：`);
    for (const j of judged.slice(0, TOP)) {
      console.log(`  IoU ${j.v.toFixed(3)}　沿用原框 ${j.kept}/${j.steps}　BMP 字 ${j.bmp}/${j.steps * 2 + 1}　${j.seq}`);
    }
  }
  if (mv) console.log(`\n對照的手工序：${MASTER_SEQ}　IoU ${mv.v.toFixed(3)}　沿用原框 ${mv.kept}/${mv.steps}`);
  console.log(`★ 最佳：${best.seq}　IoU ${best.v.toFixed(3)}　沿用原框 ${best.kept}/${best.steps}　BMP ${best.bmp}/${best.steps * 2 + 1}` +
    `　（裁判 ${judged.length} 條 ✓；葉子不全而淘汰 ${skippedNoLeaves.toLocaleString()} 條 ✓）` +
    (mv ? (best.v > mv.v + 0.002 ? "　→ 贏手工 ✓" : best.v >= mv.v - 0.002 ? "　→ 打平 ✓" : "　→ 還差一點 ✗") : ""));
  if (bestBmp && bestBmp !== best) {
    console.log(`★ 最佳 BMP 解：${bestBmp.seq}　IoU ${bestBmp.v.toFixed(3)}　沿用原框 ${bestBmp.kept}/${bestBmp.steps}　（全 BMP ✓）`);
  } else if (bestBmp === best) {
    console.log(`（最佳解本身就是全 BMP ✓）`);
  }
  if (PNG) {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body{margin:0;background:#0b0c0e;color:#e8ecf4;font:13px system-ui,"Microsoft JhengHei",sans-serif}
      .row{display:flex;gap:10px;padding:10px;flex-wrap:wrap}.c{background:#15171b;border:1px solid #2a2e35;border-radius:10px;padding:6px;text-align:center;max-width:250px}
      .g{width:220px;height:220px}.g svg{width:100%;height:100%;display:block}small{color:#8b93a0;font-size:11px}
      img{width:220px;height:220px;filter:invert(1)}
    </style></head><body><div class="row">
      <div class="c"><img src="file:///${resolve(ROOT, PNG).replace(/\\/g, "/")}"><div>原圖 ${PNG}</div></div>
      <div class="c"><div class="g">${best.svg}</div><div>自動最佳：${best.seq}<br><small>IoU ${best.v.toFixed(3)}　沿用原框 ${best.kept}/${best.steps}　BMP ${best.bmp}/${best.steps * 2 + 1}</small></div></div>
      ${judged.slice(1, 3).map((j) => `<div class="c"><div class="g">${j.svg}</div><div>${j.seq}<br><small>IoU ${j.v.toFixed(3)}　沿用原框 ${j.kept}/${j.steps}</small></div></div>`).join("")}
    </div></body></html>`;
    const page = resolve(ROOT, "out/_ladder-probe.html");
    writeFileSync(page, html, "utf8");
    const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    const shot = resolve(ROOT, "out/ladder-fit.png");
    if (existsSync(EDGE)) {
      if (existsSync(shot)) unlinkSync(shot);
      Bun.spawnSync([EDGE, "--headless", "--disable-gpu", `--screenshot=${shot}`, "--window-size=1080,300",
        "--hide-scrollbars", `file:///${page.replace(/\\/g, "/")}`], { stdout: "ignore", stderr: "ignore" });
      console.log(`並排圖：${shot}`);
    }
  }
}
void hexOf;
