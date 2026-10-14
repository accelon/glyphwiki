#!/usr/bin/env bun
/**
 * seq-search.ts — **把 IDS 變成構形序**（＝`glyph-by-ids.md` 的〈優化從 IDS 找到構形序〉✓）。
 *
 * 一句話：**古法**（IDS）是前綴式的描述 ✓、**今法**（構形序）是「一個真字 ＋ 幾步替換」✓。
 * 這支負責把前者翻成後者 ✓——而且**每一步都真的用引擎組一次** ✓，
 * 讓引擎當唯一裁判 ✓（徒兒前五輪都在「猜」哪個配法對 ✗，猜錯四次 ✗）。
 *
 * ## 介面
 *
 * ```
 * searchSeqForIds(lib, "⿰木垚", { judgeMax: 1500 })
 *   → { ok, candidates: [{ seq, steps, sat, satDeep, exact, svg, … }], … }
 * ```
 *
 * `candidates` 已排好序 ✓（排序的每一項都是**被一個具體錯誤逼出來的** ✓，見 `rank()` ✓）。
 *
 * ## 四條產生候選的路（互補 ✓，缺一條就會有題目生不出來 ✗）
 *
 *  1. **一步解**：`comp` 與目標葉序只差一格 ✓（`桂`＝木,圭 ✓，目標 木,垚 ✓）→ `桂圭垚` ✓
 *  2. **合成解**：拿真字當結構 ✓、直接分量逐格配到目標的葉 ✓（配不上再往下一層 ✓）
 *  3. **搜尋**：貪婪最佳優先 ＋ beam ✓（每一步都**真的組一次**當裁判 ✓）
 *  4. **區塊配對**：把目標的**一整塊**換成真字的一個分量 ✓（`盟` 的 `皿 → 明` ✓）
 *
 * ## 兩個「先量再改」的教訓（都寫在這裡，免得再犯 ✓）
 *
 *  * **第 137 輪（效能）**：舊版對**每一條**候選都 `svgOf()` ✗（每次 70 ms ✗）、
 *    排序的比較器每次都**重算**所有量 ✗。改成「先排名 → 只有前 `SVG_TOP` 條畫 SVG」✓、
 *    「每個狀態的量只算一次、存 `__ord`」✓——`⿰⿱日月皿` 從 122 秒降到 **1.3 秒** ✓。
 *  * **第 139 輪（正確性）**：`⿰⿱日月皿` → `盟皿明` 卡了**五輪** ✗。
 *    根因有兩層 ✗：① 覆蓋閘門用**字面的葉**比 ✗（`明` 是一個葉 ✗，它自己又是 `日,月` ✓）
 *    → 改成**元素多重集** ✓；② 徒兒一直想「哪個分量屬於哪一塊」✗，
 *    但引擎只在意「**一個舊字換成新值**吃不吃得下」✓ → 改成**直接提出、讓引擎裁判** ✓。
 *
 * ⚠ 第 139 輪的檔案曾經被徒兒的編輯弄壞（`poolOf`／`searchSeqForIds` 整個被吃掉 ✗），
 *   只能整支重寫 ✓。**教訓：整段取代要用精確的起訖行號，而且取代完要立刻跑語法檢查** ✓。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as F from "./lib-format.ts";
import type { Library as Lib } from "./lib-format.ts";
import { evalSeq, drawingIdx } from "./free-compose.ts";
import { svgOf, ensureEngine } from "./compose-fit.ts";
import { rasterize } from "./raster.ts";
import { normalizedMask } from "./shape-similarity.ts";
import { loadLibrary } from "./lib-load.ts";

/* ============================ 樹（序列運算式） ============================ */

/** 構形序的樹 ✓——`{ ch }` 是一個字 ✓、`{ op, kids }` 是一個算子 ＋ 分量 ✓。 */
export type SeqNode = { ch: string } | { op: string; kids: SeqNode[] };

const IDS_OPS = "⿰⿱⿲⿳⿴⿵⿶⿷⿸⿹⿺⿻";
const ARITY: Record<string, number> = {
  "⿰": 2, "⿱": 2, "⿲": 3, "⿳": 3,
  "⿴": 2, "⿵": 2, "⿶": 2, "⿷": 2, "⿸": 2, "⿹": 2, "⿺": 2, "⿻": 2,
};
const isOp = (c: string): boolean => IDS_OPS.includes(c);

/** 解析前綴式的 IDS ✓——壞掉就回 `null` ✓（**不要猜** ✓，見 `glyph-by-ids.md` ✓）。 */
export function parseSeqTree(ids: string): SeqNode | null {
  const cs = Array.from(String(ids).replace(/\s+/g, ""));
  if (!cs.length) return null;
  let i = 0;
  const pop = (): SeqNode | null => {
    if (i >= cs.length) return null;
    const c = cs[i++]!;
    if (!isOp(c)) return { ch: c };
    const n = ARITY[c] ?? 2;
    const kids: SeqNode[] = [];
    for (let k = 0; k < n; k++) {
      const kid = pop();
      if (!kid) return null;
      kids.push(kid);
    }
    return { op: c, kids: kids };
  };
  const t = pop();
  return t && i === cs.length ? t : null;
}

/** 樹的葉（依序 ✓，**保留重複** ✓——`林` 是兩個 `木` ✓）。 */
export function treeLeaves(n: SeqNode): string[] {
  return "ch" in n ? [n.ch] : n.kids.flatMap(treeLeaves);
}

/** 葉的**多重集** ✓（字面 ✓，不展開 ✓——展開要用 `deepMultisetOf()` ✓）。 */
export function leafMultisetOf(n: SeqNode): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of treeLeaves(n)) m.set(c, (m.get(c) ?? 0) + 1);
  return m;
}

/** 樹的每個葉 ＋ 它自己的相對位置 ✓（0..1 的方框座標 ✓）。 */
export interface SeqPos { ch: string; x: number; y: number; node: SeqNode }

export function treePositions(n: SeqNode): SeqPos[] {
  const out: SeqPos[] = [];
  const walk = (k: SeqNode, x0: number, y0: number, w: number, h: number): void => {
    if ("ch" in k) { out.push({ ch: k.ch, x: x0 + w / 2, y: y0 + h / 2, node: k }); return; }
    const kids = k.kids;
    const kk = kids.length;
    for (let i = 0; i < kk; i++) {
      const kid = kids[i]!;
      if (k.op === "⿰") walk(kid, x0 + (w * i) / 2, y0, w / 2, h);
      else if (k.op === "⿱") walk(kid, x0, y0 + (h * i) / 2, w, h / 2);
      else if (k.op === "⿲") walk(kid, x0 + (w * i) / 3, y0, w / 3, h);
      else if (k.op === "⿳") walk(kid, x0, y0 + (h * i) / 3, w, h / 3);
      else if (k.op === "⿴") walk(kid, x0 + w * 0.12, y0 + h * 0.12, w * 0.76, h * 0.76);
      else if (k.op === "⿵") walk(kid, x0 + (i === 0 ? 0 : w * 0.2), y0 + (i === 0 ? h * 0.3 : 0), w * (i === 0 ? 1 : 0.8), h * (i === 0 ? 0.7 : 1));
      else if (k.op === "⿶") walk(kid, x0 + (i === 0 ? w * 0.2 : 0), y0 + (i === 0 ? 0 : h * 0.3), w * (i === 0 ? 0.8 : 1), h * (i === 0 ? 1 : 0.7));
      else walk(kid, x0, y0, w, h);
    }
  };
  walk(n, 0, 0, 1, 1);
  return out;
}

/** 把樹裡的葉 `old` 換成 `sub` ✓（**第一個**命中就換 ✓）。 */
export function replaceLeaf(n: SeqNode, old: string, sub: SeqNode): SeqNode {
  if ("ch" in n) return n.ch === old ? sub : n;
  return { op: n.op, kids: n.kids.map((k) => replaceLeaf(k, old, sub)) };
}

/* ============================ 元素的展開（都**要快取** ✗） ============================
 * ⚠ 第 137 輪的效能教訓：這幾支會被方法 ④／搜尋迴圈**掃 97k 個字**的過程反覆呼叫 ✗。
 *   沒有快取時 `⿰⿱日月皿` 光搜尋階段就要 **131 秒** ✗（而且 CPU 看起來很低 ✗，
 *   因為時間都花在**配置陣列與字串**上 ✗，不是真的在算 ✗）。
 */

const deepLeavesCache = new WeakMap<Lib, Map<string, string[]>>();
/** **最深一層的葉多重集的多重集** ✓（＝這個字「真正由哪些基本部件組成」✓）。
 *
 *  ⚠ **一定要展到不動點** ✗（`glyph-by-ids.md` §2.5 的教訓 ✓）：
 *    `垚` 的 `comp` 是 `土,𪢴` ✓，而 `𪢴` 自己又是 `土,土` ✓——
 *    只展固定深度會停在 `𪢴` ✗，於是 `垚`＝{土,𪢴} ✗、`圭`＝{土:2} ✓ 被判成不同部件 ✗
 *    → `桂`（木＋圭）就永遠不算「垚 到位」✗ → 答案 `桂圭垚` **整個生不出來** ✗。 */
export function deepLeaves(L: Lib, ch: string): string[] {
  let per = deepLeavesCache.get(L);
  if (!per) { per = new Map(); deepLeavesCache.set(L, per); }
  const hit = per.get(ch);
  if (hit) return hit;
  let cur = [ch];
  for (let round = 0; round < 8; round++) {
    let grew = false;
    const next: string[] = [];
    for (const c of cur) {
      const subs = L.comp?.get(c.codePointAt(0)!);
      if (subs && subs.length >= 2 && subs.length <= 4) {
        for (const s of subs) next.push(String.fromCodePoint(s));
        grew = true;
      } else next.push(c);
    }
    if (!grew) break;
    cur = next;
    if (cur.length > 8) break;
  }
  const out = cur.slice(0, 8);
  if (per.size > 60000) per.clear();
  per.set(ch, out);
  return out;
}

const deepKeyCache = new WeakMap<Lib, Map<string, string>>();
/** 最深葉的**正規化鍵** ✓（排序後接起來 ✓）——比「兩個 Map 逐項比」便宜 ✓。 */
export function deepKeyOf(L: Lib, ch: string): string {
  let per = deepKeyCache.get(L);
  if (!per) { per = new Map(); deepKeyCache.set(L, per); }
  const hit = per.get(ch);
  if (hit !== undefined) return hit;
  const k = deepLeaves(L, ch).slice().sort().join("");
  if (per.size > 60000) per.clear();
  per.set(ch, k);
  return k;
}

const deepCache = new WeakMap<Lib, Map<string, Map<string, number>>>();
export function deepMultisetOf(L: Lib, ch: string): Map<string, number> {
  let per = deepCache.get(L);
  if (!per) { per = new Map(); deepCache.set(L, per); }
  let m = per.get(ch);
  if (!m) {
    m = new Map();
    for (const c of deepLeaves(L, ch)) m.set(c, (m.get(c) ?? 0) + 1);
    if (per.size > 40000) per.clear();
    per.set(ch, m);
  }
  return m;
}

/** 兩個字「**畫出來是不是同一批基本部件**」✓（**互相包含**才算 ✓）。
 *  ⚠ 只寫「交集非空」太鬆 ✗：`刂`（攤平＝刀 ✓）與 `垚`（攤平＝土,𪢴 ✓）不相干 ✓，
 *    但 `刂` 與 `刀` 同組 ✗——實測就是這樣讓「刀部字 ＋ 垚」大量擠進 frontier ✗。
 *  ⚠ 這是**近似** ✓（`圭`＝土,土 與 `垚`＝土,土,土 數量不同 ✓）——只當**篩子**用 ✓。 */
export function sameParts(L: Lib, a: string, b: string): boolean {
  if (a === b) return true;
  const A = deepMultisetOf(L, a), B = deepMultisetOf(L, b);
  if (A.size !== B.size) return false;
  for (const [k, v] of A) if (B.get(k) !== v) return false;
  return true;
}

/** 「這兩個字可以互換嗎」✓——同一個形 ✓，或其中一個是另一個的**部件** ✓。 */
export function partsCompatible(L: Lib, a: string, b: string): boolean {
  if (a === b) return true;
  if (sameParts(L, a, b)) return true;
  return deepLeaves(L, a).includes(b) || deepLeaves(L, b).includes(a);
}

const flatCache = new WeakMap<Lib, Map<string, Set<string>>>();
/** 這個字（遞迴）用到的**所有**碼位 ✓（每一層都收 ✓）。 */
export function flatSetOf(L: Lib, ch: string): Set<string> {
  let per = flatCache.get(L);
  if (!per) { per = new Map(); flatCache.set(L, per); }
  let s = per.get(ch);
  if (!s) {
    s = new Set<string>([ch]);
    let cur = [ch];
    for (let r = 0; r < 6; r++) {
      const nxt: string[] = [];
      for (const x of cur) {
        const cs = L.comp?.get(x.codePointAt(0)!);
        if (cs && cs.length >= 2 && cs.length <= 4) {
          for (const k of cs) { const kc = String.fromCodePoint(k); if (!s.has(kc)) { s.add(kc); nxt.push(kc); } }
        }
      }
      if (!nxt.length || s.size > 60) break;
      cur = nxt;
    }
    if (per.size > 40000) per.clear();
    per.set(ch, s);
  }
  return s;
}

const levelSetCache = new WeakMap<Lib, Map<string, Set<string>>>();
/** **各層**部件集合 ✓（`寶` 的直接分量 宀,珤 要在裡面 ✓、`珤` 自己的 王,缶 也要 ✓）。
 *  ★ 回傳快取住的 `Set` ✓（呼叫端**不要改它** ✗）。 */
export function levelSetOf(L: Lib, ch: string): Set<string> {
  let per = levelSetCache.get(L);
  if (!per) { per = new Map(); levelSetCache.set(L, per); }
  const hit = per.get(ch);
  if (hit) return hit;
  const set = new Set<string>([ch]);
  let cur = [ch];
  for (let r = 0; r < 6; r++) {
    const nxt: string[] = [];
    for (const x of cur) {
      const cs = L.comp?.get(x.codePointAt(0)!);
      if (cs && cs.length >= 2 && cs.length <= 4) {
        for (const k of cs) { const kc = String.fromCodePoint(k); if (!set.has(kc)) { set.add(kc); nxt.push(kc); } }
      }
    }
    if (!nxt.length || set.size > 40) break;
    cur = nxt;
  }
  if (per.size > 60000) per.clear();
  per.set(ch, set);
  return set;
}

/** **由下往上的索引** ✓：碼位 → 「有哪些字的 `comp` 含它」✓（`isCompOf` 要用 ✓）。 */
const parentCache = new WeakMap<Lib, Map<string, string[]>>();
export function buildParentIndex(L: Lib): Map<string, string[]> {
  const hit = parentCache.get(L);
  if (hit) return hit;
  const m = new Map<string, string[]>();
  if (L.comp) {
    for (const [cp, comps] of L.comp) {
      const up = String.fromCodePoint(cp);
      for (const c of comps) {
        const k = String.fromCodePoint(c);
        const arr = m.get(k);
        if (arr) { if (!arr.includes(up) && arr.length < 400) arr.push(up); }
        else m.set(k, [up]);
      }
    }
  }
  parentCache.set(L, m);
  return m;
}

/* ============================ 位置分數 ============================ */

/** 位置分數：目標的每個葉，在同一個相對位置找到**同一個字**（或同一批部件 ✓）就得 1 分 ✓。
 *
 *  ★ 第 137 輪：目標的位置**算一次**就存起來 ✓（舊版每次呼叫都重建 ✗，
 *    而搜尋每生成一個狀態就呼叫一次 ✗＝幾十萬次 ✗）。 */
export function posScore(state: SeqNode, target: SeqNode, L?: Lib): number {
  const tp = (target as { __tp?: SeqPos[] }).__tp ?? ((target as { __tp?: SeqPos[] }).__tp = treePositions(target));
  const sp = treePositions(state);
  const used = new Set<number>();
  let n = 0;
  for (const p of tp) {
    let bestJ = -1, bestD = 0.2;
    for (let j = 0; j < sp.length; j++) {
      if (used.has(j)) continue;
      const s = sp[j]!;
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d >= bestD) continue;
      if (s.ch !== p.ch && !(L && partsCompatible(L, s.ch, p.ch))) continue;
      bestD = d; bestJ = j;
    }
    if (bestJ >= 0) { used.add(bestJ); n++; }
  }
  return n;
}

/* ============================ 索引 ============================ */

export interface SeqEntry {
  ch: string;
  tree: SeqNode;
  leaves: string[];
  /** 這個字的葉，**有幾個不在目標的葉裡面** ✓——**免費的篩子** ✓（索引階段就算好 ✓）。 */
  extra: number;
}
export interface SeqIndex { byLeaf: Map<string, SeqEntry[]>; nEntries: number; ms: number }

/** 建立「葉 → 有哪些字」的索引 ✓（只收**真的畫得出來**的字 ✓）。
 *  ⚠ 排序要在**這裡**做完 ✓（見 `poolOf()` 那段說明 ✓）。 */
export function buildSeqIndex(L: Lib, targetSet: Map<string, number>): SeqIndex {
  const t0 = Date.now();
  const byLeaf = new Map<string, SeqEntry[]>();
  let n = 0;
  const tgtKeys = new Set(targetSet.keys());
  for (const [cp] of L.comp) {
    const gi = F.indexOfCodePoint(L, cp);
    if (gi === undefined) continue;
    const ch = String.fromCodePoint(cp);
    const leaves = deepLeaves(L, ch);
    if (!leaves.length) continue;
    let extra = 0;
    for (const l of leaves) if (!tgtKeys.has(l)) extra++;
    const tree: SeqNode = { ch: ch };
    const ent: SeqEntry = { ch: ch, tree: tree, leaves: leaves, extra: extra };
    for (const l of new Set(leaves)) {
      const arr = byLeaf.get(l);
      if (arr) arr.push(ent); else byLeaf.set(l, [ent]);
    }
    n++;
  }
  return { byLeaf: byLeaf, nEntries: n, ms: Date.now() - t0 };
}

/* ============================ 遮罩（給 `--image` 的 IoU 裁判 ✓） ============================ */

function maskOf(L: Lib, gi: number, size: number): Uint8Array | null {
  const kage = new (globalThis as any).Kage();
  const seen = new Set<number>(), stack = [gi];
  while (stack.length) {
    const j = stack.pop()!;
    if (seen.has(j)) continue;
    seen.add(j);
    kage.kBuhin.push(F.keyOfIdx(L, j), F.toKageData(L.glyphs[j]!, L));
    for (const s of L.glyphs[j]!.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  try { return normalizedMask(rasterize(kage, F.keyOfIdx(L, gi), size, 1), size); } catch { return null; }
}
function iou(a: Uint8Array, b: Uint8Array, size: number, shift = 1): number {
  let best = 0;
  for (let dy = -shift; dy <= shift; dy++) for (let dx = -shift; dx <= shift; dx++) {
    let inter = 0, uni = 0;
    for (let y = 0; y < size; y++) {
      const sy = y + dy; if (sy < 0 || sy >= size) continue;
      for (let x = 0; x < size; x++) {
        const sx = x + dx; if (sx < 0 || sx >= size) continue;
        const A = a[sy * size + sx]!, B = b[y * size + x]!;
        if (A && B) inter++;
        if (A || B) uni++;
      }
    }
    const v = uni ? inter / uni : 0;
    if (v > best) best = v;
  }
  return best;
}

/* ============================ 回傳型別 ============================ */

export interface SeqCandidate {
  seq: string;
  value: number;
  iou: number;
  kept: number;
  steps: number;
  bmp: number;
  cov: number;
  selfForm: number;
  partSame: number;
  sat: number;
  satDeep: number;
  satSame: number;
  comp: number;
  exact: number;
  svg: string;
  log: string[];
}
export interface SeqSearchResult {
  ok: boolean;
  target: string;
  targetLeaves: string[];
  full: number;
  candidates: SeqCandidate[];
  judged: number;
  skippedNoLeaves: number;
  indexEntries: number;
  msIndex: number;
  msSearch: number;
  msJudge: number;
}
export interface SeqSearchOpts {
  size?: number;
  depth?: number;
  beam?: number;
  cand?: number;
  poolPerLayer?: number;
  judgeMax?: number;
  img?: Uint8Array | null;
  svgTop?: number;
  onLayer?: (d: number, next: number, kept: number, best: number, full: number) => void;
}

/* ============================ 主搜尋 ============================ */

/** 核心：**IDS → 構形序** ✓（真的組一次當裁判 ✓、葉集合必須涵蓋目標 ✓）。 */
export function searchSeqForIds(lib: Lib, ids: string, opts: SeqSearchOpts = {}): SeqSearchResult {
  const target = parseSeqTree(ids);
  const empty: SeqSearchResult = {
    ok: false, target: ids, targetLeaves: [], full: 0, candidates: [], judged: 0,
    skippedNoLeaves: 0, indexEntries: 0, msIndex: 0, msSearch: 0, msJudge: 0,
  };
  if (!target || "ch" in target) return empty;
  const SIZE = opts.size ?? 48;
  const DEPTH = opts.depth ?? 5, BEAM = opts.beam ?? 60;
  const CAND = opts.cand ?? 40, POOL = opts.poolPerLayer ?? 400;
  const JUDGE_MAX = opts.judgeMax ?? 3000;
  const targetLeaves = treeLeaves(target);
  const targetSet = leafMultisetOf(target);
  /** 目標的**元素多重集** ✓（把每個葉展開成最深元素 ✓）——與 `hasAllLeaves()` 配對 ✓，見那裡 ✓。
   *  ★★ 第 139 輪的關鍵 ✗：舊版用**字面的葉**比 ✗，而候選狀態的葉**可以是複合字** ✗
   *  （`盟皿明` 的狀態樹是 `⿰ 明 明` ✓，`明` 是一個葉 ✗，它自己又是 `日,月` ✓）
   *  → 目標要 `{日,月,皿}` ✓、狀態只報 `{明,明}` ✗ → **永遠篩掉** ✗（實測 ✓）。 */
  const targetElemSet = (() => {
    const m = new Map<string, number>();
    for (const l of targetLeaves) for (const e of deepLeaves(lib, l)) m.set(e, (m.get(e) ?? 0) + 1);
    return m;
  })();
  const idx = buildSeqIndex(lib, targetSet);
  const t1 = Date.now();

  /* ---------------- 目標的幾何（每個葉一個相對位置 ✓） ---------------- */
  interface TPos { ch: string; x: number; y: number; node: SeqNode }
  const targetPos: TPos[] = (() => {
    const out: TPos[] = [];
    const walk = (n: SeqNode, x0: number, y0: number, w: number, h: number): void => {
      if ("ch" in n) { out.push({ ch: n.ch, x: x0 + w / 2, y: y0 + h / 2, node: n }); return; }
      const k = n.kids.length;
      for (let i = 0; i < k; i++) {
        const kid = n.kids[i]!;
        if (n.op === "⿰") walk(kid, x0 + (w * i) / 2, y0, w / 2, h);
        else if (n.op === "⿱") walk(kid, x0, y0 + (h * i) / 2, w, h / 2);
        else if (n.op === "⿲") walk(kid, x0 + (w * i) / 3, y0, w / 3, h);
        else if (n.op === "⿳") walk(kid, x0, y0 + (h * i) / 3, w, h / 3);
        else if (n.op === "⿴") walk(kid, x0 + w * 0.12, y0 + h * 0.12, w * 0.76, h * 0.76);
        else if (n.op === "⿵") walk(kid, x0 + (i === 0 ? 0 : w * 0.2), y0 + (i === 0 ? h * 0.3 : 0), w * (i === 0 ? 1 : 0.8), h * (i === 0 ? 0.7 : 1));
        else if (n.op === "⿶") walk(kid, x0 + (i === 0 ? w * 0.2 : 0), y0 + (i === 0 ? 0 : h * 0.3), w * (i === 0 ? 0.8 : 1), h * (i === 0 ? 1 : 0.7));
        else walk(kid, x0, y0, w, h);
      }
    };
    walk(target, 0, 0, 1, 1);
    return out;
  })();
  const targetPos2 = targetPos;
  const FULL = targetPos.length;
  /** 位置分數 ✓（用共用的 `posScore()` ✓）。 */
  const scoreOf = (t: SeqNode) => posScore(t, target, lib);
  const parentIdx = buildParentIndex(lib);

  /** `a` 是不是 `b` 的**部件**（或同部件的寫法 ✓）——例 `圭` 是 `垚` 的部件 ✓、`千` 不是 ✗。 */
  const isCompOf = (() => {
    const cache = new Map<string, boolean>();
    return (a: string, b: string): boolean => {
      if (a === b) return false;
      const key = a + "\u0000" + b;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      let ok = false;
      for (const up of parentIdx.get(a) ?? []) if (up === b || sameParts(lib, up, b)) { ok = true; break; }
      if (!ok) {
        outer: for (const f of flatSetOf(lib, a)) {
          for (const up of parentIdx.get(f) ?? []) {
            if (up === b || sameParts(lib, up, b)) { ok = true; break outer; }
          }
        }
      }
      if (cache.size > 40000) cache.clear();
      cache.set(key, ok);
      return ok;
    };
  })();

  /** 這一葉有沒有落在這個目標位置 ✓（字面相同 ✓，或**同位同部件的另一種寫法** ✓）。 */
  const matchesPos = (ch: string, pos: TPos, x: number, y: number): boolean =>
    Math.hypot(x - pos.x, y - pos.y) < 0.2 && (ch === pos.ch || partsCompatible(lib, ch, pos.ch));
  const posOk = (t: SeqNode, pos: TPos): boolean => {
    for (const s of treePositions(t)) if (matchesPos(s.ch, pos, s.x, s.y)) return true;
    return false;
  };
  /** **完成** ✓＝每個目標位置都有葉**字面相同** ✓（「到位」不算 ✓——`圭` 到位但還沒完成 ✓）。 */
  const isDone = (t: SeqNode): boolean => {
    for (const p of targetPos) {
      let hit = false;
      for (const s of treePositions(t)) {
        if (s.ch === p.ch && Math.hypot(s.x - p.x, s.y - p.y) < 0.2) { hit = true; break; }
      }
      if (!hit) return false;
    }
    return true;
  };
  const unsatOf = (t: SeqNode): number => {
    let n = 0;
    for (const p of targetPos) if (!posOk(t, p)) n++;
    return n;
  };

  /** ★★ **葉集合的覆蓋閘門** ✓（第 139 輪的關鍵修正 ✗）：
   *  把每個葉**展開成元素**再比 ✓——`明` 是一個葉 ✗，但它的元素是 `日,月` ✓。
   *  ⚠ 條件是「**至少涵蓋**」✓（不是「剛好等於」✗）：`盟皿明` 的元素是 `{日×2,月}` ✓
   *    確實 ⊇ 目標的 `{日,月,皿}` ✓——就是這一條讓 `盟皿明` 進得了裁判 ✓。 */
  const hasAllLeaves = (t: SeqNode): boolean => {
    const have = new Map<string, number>();
    for (const l of treeLeaves(t)) for (const e of deepLeaves(lib, l)) have.set(e, (have.get(e) ?? 0) + 1);
    for (const [l, k] of targetElemSet) if ((have.get(l) ?? 0) < k) return false;
    return true;
  };
  /** 狀態的最大葉數 ✓（防爆 ✓）。 */
  const maxLeaves = Math.max(4, targetLeaves.length + 2);

  /* ---------------- 候選池（**每個葉一份，過濾 ＋ 排序後** ✓） ----------------
     ★★ 第 137 輪的效能修正：舊版對**每一個狀態**都重新掃該葉的**全部**候選 ✗
     （`日`／`月` 這種大葉動輒幾萬條 ✗ × 幾千個狀態 ✗＝幾億次迭代 ✗）。
     但「哪些候選可用」**只跟那一葉有關** ✓、跟狀態無關 ✓ → 先建一份共用清單 ✓。
     判準（**免費的** ✓，全在索引階段算好 ✓）：
       ① `extra === 0`（葉子**全在目標裡** ✓——有雜葉的字換上去只會污染 ✗）
       ② 葉數別超過目標＋1 ✓（多餘葉子要罰 ✓）
       ③ 排序：BMP 優先 ✓、葉數少的優先 ✓
     ⚠ 這裡**不做**評分 ✗（評分要組樹 ✗）——評分留給每個狀態自己算 ✓（它跟狀態有關 ✓）。 */
  const poolMemo = new Map<string, SeqEntry[]>();
  const poolOf = (ch: string): SeqEntry[] => {
    let out = poolMemo.get(ch);
    if (out) return out;
    const arr = (idx.byLeaf.get(ch) ?? []).filter((ent) => ent.extra === 0 &&
      ent.leaves.length <= targetLeaves.length + 1);
    arr.sort((a, b) => ((isBmp(b.ch) ? 1 : 0) - (isBmp(a.ch) ? 1 : 0)) ||
      (a.leaves.length - b.leaves.length) || (a.ch < b.ch ? -1 : 1));
    out = arr.slice(0, 400);          /* 每個葉最多留 400 條 ✓（夠了 ✓，再多的排不進前 40 ✓） */
    poolMemo.set(ch, out);
    return out;
  };
  /** 一個搜尋狀態 ✓（`tree`＝目前的形 ✓、`pairs`＝走到這裡的替換序列 ✓）。 */
  interface St { tree: SeqNode; pairs: [string, string][]; base: string; cov: number; exact?: boolean; __ord?: number[] }
  const poolAll: St[] = [];
  /** **一步解**（分量數相同、只差一格 ✓）與**合成解** ✓——離答案最近、**一定要進裁判** ✓ */
  const oneStep: St[] = [];
  const done: St[] = [];
  /** 目前的搜尋前緣 ✓（起始候選 → 每一層留 beam 個 ✓） */
  let frontier: St[] = [];

  /* ---------------- 目標葉的「同位同部件」寫法（收尾步的來源 ✓） ---------------- */
  const nearestOverlap = new Map<string, string[]>();
  for (const p of targetPos) {
    const list: string[] = [];
    const seeds = new Set<string>([p.ch, ...flatSetOf(lib, p.ch)]);
    for (const seed of seeds) {
      for (const up of parentIdx.get(seed) ?? []) {
        if (up === p.ch || list.includes(up)) continue;
        if (sameParts(lib, up, p.ch)) list.push(up);
        if (list.length >= 12) break;
      }
      if (list.length >= 12) break;
    }
    nearestOverlap.set(p.ch, list);
  }

  /* ---------------- 排序用的量（**這一組是量出來的** ✓，改了答案就會變 ✗） ---------------- */
  /** 同位、而且**同一批部件**的葉數 ✓（`圭` vs `垚` ✓；`土` vs `垚` ✗，因為 `土` 只是它的一個部件 ✓） */
  const sameSat = (t: SeqNode): number => {
    let n = 0;
    for (const leaf of new Set(treeLeaves(t))) {
      for (const s of treePositions(t)) {
        if (s.ch !== leaf) continue;
        for (const p of targetPos) {
          if (Math.hypot(s.x - p.x, s.y - p.y) >= 0.2) continue;
          if (leaf === p.ch || sameParts(lib, leaf, p.ch)) { n++; break; }
        }
      }
    }
    return n;
  };
  /** 幾個葉「真的是目標那個位置的部件」✓（走**葉**，不要用展開的位置 ✗——`杉` 自己含 `木` ✗） */
  const compHits = (t: SeqNode): number => {
    let n = 0;
    for (const leaf of new Set(treeLeaves(t))) {
      for (const s of treePositions(t)) {
        if (s.ch !== leaf) continue;
        for (const p of targetPos) {
          if (Math.hypot(s.x - p.x, s.y - p.y) >= 0.2) continue;
          if (leaf !== p.ch && isCompOf(leaf, p.ch)) n++;
          break;
        }
      }
    }
    return n;
  };
  const leafGap = (t: SeqNode): number => Math.abs(treeLeaves(t).length - targetLeaves.length);
  /** **每個葉都有用**嗎 ✓（都是目標葉 ✓ 或目標葉的部件 ✓，且落在對的位置 ✓） */
  const usefulLeaves = (t: SeqNode): number => {
    let n = 0;
    for (const leaf of new Set(treeLeaves(t))) {
      let ok = false;
      for (const s of treePositions(t)) {
        if (s.ch !== leaf) continue;
        for (const p of targetPos) {
          if (Math.hypot(s.x - p.x, s.y - p.y) >= 0.2) continue;
          if (leaf === p.ch || isCompOf(leaf, p.ch)) { ok = true; break; }
        }
        if (ok) break;
      }
      if (ok) n++;
    }
    return n;
  };
  const exactOf = (t: SeqNode): number => {
    let n = 0;
    for (const p of targetPos) {
      for (const s of treePositions(t)) {
        if (s.ch === p.ch && Math.hypot(s.x - p.x, s.y - p.y) < 0.2) { n++; break; }
      }
    }
    return n;
  };
  /** frontier／候選池**共用**的排序 ✓（兩邊一定要一樣 ✗，只改一邊就會「排對了又被排回去」✗）。
   *
   *  ★★ 第 137 輪的**效能修正**（這一條讓 `⿰⿱日月皿` 從 122 秒降到 1.3 秒 ✓）：
   *    舊版比較器每次呼叫都**重算** `sameSat`／`compHits`／`leafGap`／`exactOf`／`usefulLeaves` ✗，
   *    而 `Array.prototype.sort` 對 20 萬個狀態會呼叫比較器**上百萬次** ✗
   *    → 每個狀態的「量」被算了幾十次 ✗，那些量每個都要掃葉、掃位置、查快取 ✗。
   *    改成：**每個狀態先算一次、存在 `__ord`** ✓，比較器只讀數字 ✓。 */
  const ordOf = (st: { tree: SeqNode; cov: number; pairs: [string, string][]; __ord?: number[] }): number[] => {
    if (!st.__ord) {
      st.__ord = [
        sameSat(st.tree), compHits(st.tree), leafGap(st.tree),
        exactOf(st.tree), usefulLeaves(st.tree), st.cov, -st.pairs.length,
      ];
    }
    return st.__ord;
  };
  const cmpState = (a: { tree: SeqNode; cov: number; pairs: [string, string][]; __ord?: number[] },
                    b: { tree: SeqNode; cov: number; pairs: [string, string][]; __ord?: number[] }): number => {
    /* 每一項都是「大者優先」✓（`leafGap` 是**小者優先**，所以取負 ✓） */
    const A = ordOf(a), B = ordOf(b);
    return (B[0]! - A[0]!) || (B[1]! - A[1]!) || (A[2]! - B[2]!) ||
      (B[3]! - A[3]!) || (B[4]! - A[4]!) || (B[5]! - A[5]!) || (B[6]! - A[6]!);
  };
  /* ---------------- 一步解與合成解（確定性 ✓，不靠排序運氣 ✓） ---------------- */
  if (lib.comp) {
    const tgt = treeLeaves(target);
    /* ① 一步解：`comp` 和目標葉序只差一格 ✓（`桂` ＝ 木,圭 ✓，目標 木,垚 ✓） */
    for (const [cp, comps] of lib.comp) {
      if (!comps || comps.length !== tgt.length) continue;
      let diff = -1, n = 0;
      for (let i = 0; i < comps.length; i++) {
        if (String.fromCodePoint(comps[i]!) !== tgt[i]) { diff = i; n++; if (n > 1) break; }
      }
      if (n !== 1 || diff < 0) continue;
      if (F.indexOfCodePoint(lib, cp) === undefined) continue;
      const ch = String.fromCodePoint(cp);
      const oldCh = String.fromCodePoint(comps[diff]!), newCh = tgt[diff]!;
      const tree2 = replaceLeaf(target, newCh, { ch: oldCh });
      oneStep.push({ tree: tree2, pairs: [[oldCh, newCh]], base: ch, cov: scoreOf(tree2) });
    }
    /* ③ **區塊合成**（第 131 輪 ✓，`glyph-by-ids.md` 測試例的關鍵一環 ✓）：
       基字的一個分量常常要對到目標的**一整塊子樹** ✗（不是一個葉 ✗）——
       例 `邏`＝`辶＋羅` ✓，而 `羅` 那一格要換成「寶貝𩨨從䞃致招」那一大串 ✓。
       做法（兩段 ✓）：
         ① 目標的每個位置 → 挑一個**真字**當它的內容 ✓（那個字的部件要**全都在那一塊裡** ✓）；
         ② 那個字自己若有部件 ✓ 就**逐個**把它們換成「那一塊該有的東西」✓（遞迴 ✓）。
       ⚠ 位置代號：`A`..`Z` 對應目標的葉次序 ✓（`LIB.comp` 的鍵是碼位，所以記號要換成碼位 ✓）。 */
    const nParts = (c: string): number => deepLeaves(lib, c).length;
    /** 這一塊的部件（最深 ✓）多重集 */
    const blockDeep = (b: SeqNode): Map<string, number> => {
      const m = new Map<string, number>();
      for (const l of treeLeaves(b)) for (const x of deepLeaves(lib, l)) m.set(x, (m.get(x) ?? 0) + 1);
      return m;
    };
    const subOf = (whole: Map<string, number>, part: Map<string, number>): boolean => {
      for (const [k, v] of part) if ((whole.get(k) ?? 0) < v) return false;
      return true;
    };
    /** 找一個「部件全在這一塊裡」的真字當內容 ✓（越簡單越好 ✓：先比分量數 ✓） */
    const chooserForBlock = (b: SeqNode): number | undefined => {
      const want = blockDeep(b);
      let best: number | undefined;
      let bestN = 1e9;
      for (const [cp] of lib.comp) {
        if (F.indexOfCodePoint(lib, cp) === undefined) continue;
        const ch = String.fromCodePoint(cp);
        if (sameParts(lib, ch, treeLeaves(b)[0] ?? "")) { /* 同一個字 ✓ */ }
        const deep = new Map<string, number>();
        for (const x of deepLeaves(lib, ch)) deep.set(x, (deep.get(x) ?? 0) + 1);
        if (!subOf(want, deep)) continue;
        const n = deepLeaves(lib, ch).length;
        if (n < bestN) { bestN = n; best = cp; }
      }
      return best;
    };
    /** 把「這一塊」配成一串替換 ✓：回傳 [換掉的字, 換上的形] 的序列 ✓ */
    const blockSeq = (mine: string, b: SeqNode, depth: number): [string, string][] | null => {
      const wantLeaves = treeLeaves(b);
      /* 這一塊只有一個字 → 直接換成它 ✓（`圭 → 垚` ✓、`羅 → 招` ✓） */
      if (wantLeaves.length === 1) return mine === wantLeaves[0] ? [] : [[mine, wantLeaves[0]!]];
      /* 這一塊有多個字 → 挑一個真字當內容 ✓，再把它自己的部件逐個換成 sub-block ✓ */
      const cp = chooserForBlock(b);
      if (cp === undefined) return null;
      const inner = String.fromCodePoint(cp);
      const cs = lib.comp?.get(cp);
      if (!cs || cs.length < 2 || cs.length > 4) return null;
      /* 這一塊要切給這個字的每個分量 ✓：依「哪個分量還缺什麼」貪心切 ✓ */
      const remaining = wantLeaves.slice();
      const subBlocks: string[][] = cs.map(() => []);
      for (const l of remaining) {
        /* 找一個分量，它的最深部件還包含 `l` 的部件 → 丟給它 ✓ */
        let placed = false;
        for (let k = 0; k < cs.length; k++) {
          const partCh = String.fromCodePoint(cs[k]!);
          const deep = deepLeaves(lib, partCh);
          const need = deepLeaves(lib, l);
          if (need.every((x) => deep.includes(x)) || deep.includes(l) || l === partCh) {
            subBlocks[k]!.push(l);
            placed = true;
            break;
          }
        }
        if (!placed) return null;
      }
      const pairs: [string, string][] = [];
      for (let k = 0; k < cs.length; k++) {
        const partCh = String.fromCodePoint(cs[k]!);
        const sub = subBlocks[k]!;
        if (!sub.length) return null;
        const subTree: SeqNode = sub.length === 1 ? { ch: sub[0]! } : { op: "⿰", kids: sub.slice(1).reduce((acc, x) => ({ op: "⿰", kids: [acc, { ch: x }] }) as SeqNode, { ch: sub[0]! } as SeqNode) };
        const got = depth > 0 ? blockSeq(partCh, subTree, depth - 1) : null;
        if (got === null) {
          if (partCh === sub.join("")) { /* 同一個字 ✓ */ } else return null;
        } else pairs.push(...got);
      }
      pairs.unshift([mine, inner]);
      return pairs;
    };
    /* ⚠ **暫時關掉**（第 131 輪的實驗 ✗）：`chooserForBlock` 只要求「部件的**最深葉集**涵蓋
       這一塊」✓，太鬆 ✗ → 挑到一堆無關的字（實測 11 步、分數 0 ✗）。
       要打開請設 `SEQ_BLOCK=1` ✓；在「這個挑選本身有品質判準」之前**不要預設開** ✗。 */
    if (!process.env.SEQ_BLOCK) {
      /* 直接跳過這一段 ✓ */
    } else
    for (const [cp] of lib.comp) {
      const ch = String.fromCodePoint(cp);
      const cs = lib.comp.get(cp)!;
      if (cs.length !== targetPos.length) continue;
      const pairs: [string, string][] = [];
      let ok = true;
      for (let i = 0; i < cs.length; i++) {
        const mine = String.fromCodePoint(cs[i]!);
        const got = blockSeq(mine, targetPos[i]!.node, Math.max(1, DEPTH - 1));
        if (got === null) { ok = false; break; }
        pairs.push(...got);
      }
      if (!ok) continue;    /* ⚠ 空的 pairs 也要收 ✓（0 步＝這個字**就是**那個形 ✓，`明` 就是 ✓） */
      const seq = ch + pairs.map(([o, n]) => o + n).join("");
      let okSeq = false;
      try { const q = evalSeq(lib, seq, {}); okSeq = !!(q && q.ok); } catch { okSeq = false; }
      if (!okSeq) continue;
      let synthTree: SeqNode = { ch: ch };
      for (const [o, n] of pairs) synthTree = replaceLeaf(synthTree, o, { ch: n });
      oneStep.push({ tree: synthTree, pairs: pairs, base: ch, cov: scoreOf(synthTree) });
    }

    /* ---------------- 搜尋（貪婪最佳優先 ＋ beam ✓） ---------------- */
    for (let d = 0; d < DEPTH; d++) {
      const next: St[] = [];
      for (const st of frontier) {
        if (isDone(st.tree)) { done.push(st); continue; }
        const missing: string[] = [];
        for (const t of targetPos) if (!posOk(st.tree, t)) missing.push(t.ch);
        for (const old of new Set(treeLeaves(st.tree))) {
          const cands = new Map<string, SeqEntry>();
          for (const mm of missing) for (const ent of poolOf(mm)) {
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
              (isBmp(b.ent.ch) ? 1 : 0) - (isBmp(a.ent.ch) ? 1 : 0))
            .slice(0, CAND);
          for (const s of scored) next.push({ tree: s.tree2, pairs: [...st.pairs, [old, s.ent.ch]], base: st.base, cov: s.sc2 });
        }
      }
      /* 去重 ＋ 只留最好的 ✓（`Map` 留**最大覆蓋**那一個 ✓，不要留第一個 ✗） */
      const m = new Map<string, St>();
      for (const s of [...next, ...frontier]) {
        if (treeLeaves(s.tree).length > maxLeaves) continue;
        const k = s.base + s.pairs.map(([o, n]) => o + n).join("");
        const prev = m.get(k);
        if (!prev || prev.cov < s.cov) m.set(k, s);
      }
      const byScore = [...m.values()].sort(cmpState);
      for (const st of byScore.slice(0, POOL)) poolAll.push(st);
      frontier = byScore.slice(0, BEAM);
      for (const st of frontier) if (isDone(st.tree)) done.push(st);
      if (!frontier.length) break;
    }
    /* ④ ★★ **區塊配對**（第 133 輪 ✓，`glyph-by-ids.md` 測試例的關鍵一環 ✓）——
       引擎**真的支援**「一個部件換成一整串字」✓（實測 ✓）：
         `邏羅寶貝𩀨從䞃致招` ✓ 其中一步是「邏 的 **羅 → 寶貝𩀨從䞃致招**」✓
         `盟皿明` ✓ 是「盟 的 **皿 → 明**」✓。
       ⚠ 徒兒前兩輪把方向搞反了 ✗（一直想「把 `明` 換成日月」✗）——正確形式是：
         **把「目標那一塊裡的那個字」換成「真字的那個分量」** ✓。
       ⚠ **哪一個字被換掉**要用**引擎當裁判** ✓（徒兒兩輪都在這裡猜錯 ✗）。 */
    {
      const tgtSlots = treeLeaves(target);
      const charSeqOf = (n: SeqNode): string => ("ch" in n ? n.ch : n.kids.map(charSeqOf).join(""));
      const topOp = "op" in target ? target.op : null;
      const topKids = "op" in target ? target.kids.map(charSeqOf) : [charSeqOf(target)];
      /** 元素多重集的**正規化鍵** ✓（排序後接起來 ✓）——同一批元素就會得到同一個鍵 ✓。 */
      const ekey = (m: Map<string, number>): string =>
        [...m.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([k, v]) => k + v).join("");
      /** 一棵子樹的**元素多重集** ✓（每個葉展到最深 ✓）。 */
      const elemOf = (n: SeqNode): Map<string, number> => {
        const m = new Map<string, number>();
        for (const l of treeLeaves(n)) for (const e of deepLeaves(lib, l)) m.set(e, (m.get(e) ?? 0) + 1);
        return m;
      };
      if (topOp && "kids" in target) {
        const kids = (target as { op: string; kids: SeqNode[] }).kids;
        const tgtKeys = new Set([...targetElemSet.keys()]);
        /** ★★ **免費的前置篩選** ✓（第 139 輪 ✓，很重要 ✗）：
         *  ⚠ 徒兒第一版對**每一個分量都問一次引擎** ✗——`lib.comp` 有 97k 個字 ✗、
         *    每個字 2～4 個分量 ✗ × 每一塊一次 ✗ → **上百萬次 `evalSeq`** ✗，
         *    實測 `⿰⿱日月皿` 從 3 秒爆到 **312 秒** ✗、候選 13,031 條 ✗。
         *  篩選條件（**不必問引擎** ✓，`deepMultisetOf` 有快取 ✓）：
         *    **這個分量的元素必須全部落在目標的元素裡** ✓——否則它換上去會帶進
         *    目標沒有的東西 ✗（引擎就算吃得下也不是答案 ✗）。
         *  實測：這一道把「問引擎」的次數從百萬降到**幾千** ✓（312 秒 → 7.8 秒 ✓）。 */
        const fitsTarget = (m: string): boolean => {
          for (const e of deepMultisetOf(lib, m).keys()) if (!tgtKeys.has(e)) return false;
          return true;
        };
        for (const [cp, comps] of lib.comp) {
          if (F.indexOfCodePoint(lib, cp) === undefined) continue;
          const ch = String.fromCodePoint(cp);
          if (comps.length !== topKids.length) continue;
          const mines = comps.map((c) => String.fromCodePoint(c)).filter(fitsTarget);
          if (!mines.length) continue;
          /* ★★★ 第 139 輪：**候選直接生，不要靠「誰配誰」** ✓（徒兒卡了五輪的那一條 ✗）。
             徒兒試過的所有「配對」寫法都不行 ✗，理由是一個**決定性的事實** ✓：
               兩種配法會生出**同一個元素多重集** ✗——
                 (a) `明` 配第一塊 → `盟日月明`（2 步 ✗）
                 (b) `皿` 配第一塊 → `盟皿明`  （1 步 ✓，**引擎的答案** ✓）
               兩者的**樹一模一樣** ✗（`⿰ (⿱日月) 明` ✓）→ 任何基於樹的排序都**分不出來** ✗
               （實測：徒兒的五種寫法都只能生出 (a) ✗）。
             ✅ 正解：**引擎是唯一裁判** ✓——
               對目標的**每一塊**、對真字的**每一個被篩過的分量**，直接提出
               「把這一塊的葉換成這個分量」✓，引擎吃得下就留 ✓。
               排序自然會把 1 步的 `盟皿明` 排在 2 步的 `盟日月明` 前面 ✓（`steps` ✓）。
             ⚠ 舊值永遠是**一個葉** ✓（引擎的替換恆是「一個舊字 → 新值」✗），
               所以塊有多個葉時（`日月` ✗）只拿它的**第一個葉**試 ✓、並且**保留塊的結構** ✓。 */
          const seenSeq2 = new Set<string>();
          for (let b = 0; b < kids.length; b++) {
            const bl = treeLeaves(kids[b]!);
            const old = bl[0]!;
            for (const mine of mines) {
              if (mine === old) continue;
              const newKid: SeqNode = (bl.length === 1) ? { ch: mine } : kids[b]!;
              const values: SeqNode[] = kids.map((kd, i) => (i === b ? newKid : kd));
              const seq = ch + old + mine;
              if (seenSeq2.has(seq)) continue;
              seenSeq2.add(seq);
              let q: any = null;
              try { q = evalSeq(lib, seq, {}); } catch { q = null; }
              if (!q || !q.ok) continue;
              const tree: SeqNode = values.length === 1
                ? values[0]!
                : { op: topOp, kids: values };
              oneStep.push({ tree: tree, pairs: [[old, mine]], base: ch, cov: scoreOf(tree) });
            }
          }
          /* 0 步（這個真字**就是**那個形 ✓，例 `明` 對 `⿰日月` ✓）——
             ⚠ 用**元素多重集**比 ✓，不是字面的葉 ✗（`明` 的字面葉是 `明` ✗、元素才是 `日,月` ✓）。 */
          if (ekey(elemOf({ ch: ch })) === ekey(targetElemSet)) {
            const exact = comps.length === tgtSlots.length &&
              topKids.every((w, i) => w === String.fromCodePoint(comps[i]!));
            oneStep.push({ tree: { ch: ch }, pairs: [], base: ch, cov: scoreOf(target), exact: exact });
          }
        }
      }
    }
  /* ★ 用**最深部件對位** ✓：把每個葉換成它最深的部件 ✓，再看幾個目標位置被覆蓋 ✓。
     ⚠ 為什麼要另外一支 ✗：`明` 這種「**本身就是那個形**」的候選（0 步 ✓）
       它的樹只有一個葉 `明` ✗，而目標的葉是 `日,月` ✗ → `sat` 會是 0 ✗、
       排序就把它踢到 #1134 ✗（實測 ✓）。用最深部件對位就正確 ✓（`明` 最深＝日,月 ✓）。 */
  const satDeep = (t: SeqNode): number => {
    let n = 0;
    for (const p of targetPos) {
      let hit = false;
      for (const s of treePositions(t)) {
        if (s.ch !== p.ch && !partsCompatible(lib, s.ch, p.ch)) continue;
        if (Math.hypot(s.x - p.x, s.y - p.y) >= 0.2) continue;
        hit = true; break;
      }
      if (!hit) {
        for (const leaf of new Set(treeLeaves(t))) {
          for (const dl of deepLeaves(lib, leaf)) if (dl === p.ch) { hit = true; break; }
          if (hit) break;
        }
      }
      if (hit) n++;
    }
    return n;
  };
  const seqOf = (st: St): string => st.base + st.pairs.map(([o, n]) => o + n).join("");
  /** 裁判 ✓——**先算分數、先不畫 SVG** ✓（見下面的說明 ✓）。
   *  ★★ 第 137 輪的效能修正：`svgOf` 每條要 **70 ms 以上** ✗，
   *    舊版對**每一條**候選都畫 ✗（`⿰木垚` 2,329 條 ＝ 一兩百秒 ✗，實測「裁判 4.6s」是幸運情形 ✗）。
   *    但客人只會看到**前幾名** ✓ → 改成先排名、**只對要回傳的前 `SVG_TOP` 條**畫 ✓。 */
  const judgeOne = (st: St, withSvg: boolean): SeqCandidate => {
    const seq = seqOf(st);
    let okSeq: any = null;
    try { okSeq = evalSeq(lib, seq, {}); } catch { okSeq = null; }
    const svg = (withSvg && okSeq && okSeq.ok) ? svgOf(okSeq.lib, okSeq.targetIdx) : "";
    const kept = okSeq && okSeq.ok
      ? (okSeq.log ?? []).filter((s: string) => String(s).includes("沿用原框")).length : 0;
    const iouV = (okSeq && okSeq.ok && opts.img) ? (() => {
      const m = maskOf(okSeq.lib, okSeq.targetIdx);
      return m ? iou(opts.img!, m) : 0;
    })() : 0;
    const cs = Array.from(seq);
    return {
      seq: seq, value: 0, iou: iouV, kept: kept, steps: (cs.length - 1) / 2,
      bmp: cs.filter((c) => isBmp(c)).length, cov: st.cov,
      /* ★ **自形**（第 131 輪 ✓）：換上去的字是不是「**那個位置的形式**」✓——
         判準＝它自己**有多個部件** ✓（`圭`＝土,土 ✓ 是形式 ✓；`土` 只有一筆 ✗ 是基本部件 ✗）。
         ⚠ 這一項專門分開 `桂圭垚`（圭 ✓）與 `杜土垚`（土 ✗）✗——
           兩者的每一項量都一樣 ✗，只有「換上去的是不是形式」分得開 ✓（實測 ✓）。 */
      selfForm: st.pairs.filter(([, n]) => (lib.comp?.get(n.codePointAt(0)!)?.length ?? 0) >= 2).length,
      /* ★★ **同位同量**（第 131 輪 ✓）：換上去的字，**最深葉數**和被換掉的那個**一樣**嗎 ✓——
         `杜土垚`：換掉的是 `土`（土×1 ✗）、換上 `垚`（土×3 ✗）→ **不同量** ✗
         `桂圭垚`：換掉的是 `圭`（土×2 ✓）、換上 `垚`（土×3 ✓）→ **差 1** ✓（同一個構件的不同層 ✓）
         ⚠ 這是唯一分得開那兩者的量 ✗（其餘每一項都一樣 ✗，實測 ✓）。 */
      partSame: st.pairs.filter(([o, n]) => Math.abs(
        deepLeaves(lib, o).length - deepLeaves(lib, n).length) <= 1).length,
      sat: FULL - unsatOf(st.tree), satDeep: satDeep(st.tree), satSame: sameSat(st.tree), comp: compHits(st.tree),
      exact: st.exact ? 1 : 0,
      svg: svg, log: (okSeq && okSeq.log) ? okSeq.log : [],
    };
  };
  const pool = [...done, ...poolAll, ...frontier];
  const seenSeq = new Set<string>();
  const results: SeqCandidate[] = [];
  let skipped = 0;
  const t2 = Date.now();
  /* **一步解／合成解先判** ✓——它們是離答案最近的一類 ✓，但位置分數通常最低 ✗、
     排序永遠輪不到它們 ✗（實測 `⿰木垚` 的 `桂圭垚` 就是這樣被擠掉的 ✓）。 */
  for (const st of oneStep) {
    const seq = seqOf(st);
    if (process.env.SEQ_DUMP_ONE) console.log("  [one] " + seq);
    if (seenSeq.has(seq)) continue;
    seenSeq.add(seq);
    results.push(judgeOne(st, false));
  }
  for (const st of pool) {
    if (results.length >= JUDGE_MAX) break;
    if (!hasAllLeaves(st.tree)) { skipped++; continue; }
    const seq = seqOf(st);
    if (seenSeq.has(seq)) continue;
    seenSeq.add(seq);
    results.push(judgeOne(st, false));
  }
  const msJudge = Date.now() - t2;
  /* ★★ 排名（第 131～132 輪，**每一項都是被一個具體錯誤逼出來的** ✓，動它就要重跑驗收 ✗）：
     ① `partSame`：被換掉與換上的**最深葉數差 ≤ 1** ✓（`圭`→`垚` ✓ vs `土`→`垚` ✗）
     ② `selfForm`：換上的是**形式**不是基本部件 ✓
     ③ `satSame`：同位、**同一批部件** ✓
     ④ `sat` ＋ `satDeep`：目標結構覆蓋 ✓（`satDeep` 給「**0 步、本身就是那個形**」的候選 ✓——
        `明` 的樹只有一個葉 ✗，只看 `sat` 會是 0 ✗，實測排到 #1134 ✗）
     ⑤ 「沿用原框」比例 ✓ ⑥ 部件數 ✓ ⑦ 步數少 ✓ ⑧ BMP ✓ */
  const rank = (c: SeqCandidate) => opts.img
    ? c.iou + 0.002 * c.kept + 0.0002 * c.bmp - 0.0001 * c.steps
    : (c.exact ?? 0) * 1e16 + (c.partSame ?? 0) * 1e14 + (c.selfForm ?? 0) * 1e13 +
      (c.satSame ?? 0) * 1e12 +
      /* ⚠ 第 139 輪（**量出來的** ✓，不是猜的 ✓）：`(comp + kept)` 要 **1e12** ✓——
         這一項是「**引擎說它組得出來 ＋ 有沿用原框**」✓，也就是「這是一個**真字**的寫法」✓。
         `桂圭垚`（comp=1 kept=1 ✓）與 `棥木林`（合成字 ✗ comp=0 kept=0 ✗）
         除了 `(sat + satDeep)` 之外**每一項都一樣** ✗，而 `sat` 偏偏偏袒合成字 ✗。
         實測（四個係數各跑一次 ✓）：1e9 ✗ → #33；**1e11 以上 → #1** ✓，
         而 `明`（0 步 ✓）在任何係數下都是 #1 ✓（`exact` 的 1e16 是絕對的 ✓）。 */
      (c.comp + c.kept) * 1e12 + (c.sat + (c.satDeep ?? 0)) * 1e11 +
      -c.steps * 1e4 + c.bmp * 10 + c.cov * 1e-3;
  results.sort((a, b) => rank(b) - rank(a));
  for (const c of results) c.value = opts.img ? c.iou : c.kept / Math.max(1, c.steps);
  /* ★★ **只有前 `SVG_TOP` 條要畫 SVG** ✓（`svgOf` 每條 70 ms 以上 ✗，客人只看得到前幾名 ✓）——
     `--svg-top` 可以調 ✓；要**全部**都畫就給一個大數字 ✓（舊行為 ✓）。 */
  const SVG_TOP = opts.svgTop ?? 24;
  for (let i = 0; i < Math.min(results.length, SVG_TOP); i++) {
    const c = results[i]!;
    if (c.svg) continue;
    try {
      const q = evalSeq(lib, c.seq, {});
      if (q && q.ok) c.svg = svgOf(q.lib, q.targetIdx);
    } catch { /* 畫不出來就留空 ✓ */ }
  }
  return {
    ok: results.length > 0, target: ids, targetLeaves: targetLeaves, full: FULL,
    candidates: results, judged: results.length, skippedNoLeaves: skipped,
    indexEntries: idx.nEntries, msIndex: idx.ms, msSearch: t2 - t1, msJudge: msJudge,
  };
}
}

/** BMP（一般漢字區）✓——師父的原則：BMP 才容易打出來 ✓（沒有才往 extension 找 ✓） */
export function isBmp(c: string): boolean {
  const cp = c.codePointAt(0)!;
  return cp >= 0x4e00 && cp <= 0x9fff;
}
/** 讀一張 0/1 點陣 txt ✓（給 IoU 裁判用 ✓） */
export function loadMaskTxt(path: string, size: number): Uint8Array | null {
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const m = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) m[y * size + x] = (lines[y] ?? "")[x] === "1" ? 1 : 0;
  return m;
}

/* ============================ CLI ============================ */

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (n: string, d?: string) => {
    const i = argv.indexOf(n);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  const ROOT = resolve(import.meta.dir, "..");
  const IDS = arg("--ids");
  if (!IDS) { console.error('用法：bun run tools/seq-search.ts --ids "⿰木⿳金⿰水火土" [--top 5] [--image out/_mask.txt]'); process.exit(1); }
  const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
  ensureEngine();
  const maskPath = arg("--image");
  const r = searchSeqForIds(lib, IDS!, {
    depth: Number(arg("--depth", "5")),
    beam: Number(arg("--beam", "60")),
    judgeMax: Number(arg("--judge", "3000")),
    img: maskPath ? loadMaskTxt(resolve(ROOT, maskPath!), 48) : null,
    onLayer: (d, next, kept, best, full) =>
      console.log(`  第 ${d} 層：${next} 個狀態 → 留 ${kept}（最佳位置分數 ${best.toFixed(2)}/${full}）`),
  });
  if (!r.ok) { console.log("找不到候選 ✗"); process.exit(1); }
  console.log(`\n目標 ${r.target}　葉 ${r.targetLeaves.join(" ")}（${r.targetLeaves.length} 個）`);
  console.log(`索引 ${r.indexEntries.toLocaleString()} 字（${(r.msIndex / 1000).toFixed(1)} 秒）` +
    `｜搜尋 ${(r.msSearch / 1000).toFixed(1)} 秒｜裁判 ${r.judged} 條 ${(r.msJudge / 1000).toFixed(1)} 秒`);
  for (const c of r.candidates.slice(0, Number(arg("--top", "5")))) {
    console.log(`  IoU ${c.iou.toFixed(3)}　沿用原框 ${c.kept}/${c.steps}　部件對上 ${c.comp}/${c.sat}　BMP ${c.bmp}/${c.steps * 2 + 1}　${c.seq}`);
  }
}


