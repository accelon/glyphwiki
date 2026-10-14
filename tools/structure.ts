/**
 * structure.ts — **組字結構**：一個字的「部件拆分 ＋ 異體 ＋ 字框」。
 *
 * 目標（使用者 2026-10-13 定的方向）：
 *   「讓組字結構的信息，可以逐漸完全替代掉 IDS，即組字結構＝部件拆分、異體、字框。」
 *   所以這一支**只用自己的資料**（字庫的 KAGE 筆劃與家族表）推導結構，不讀 IDS：
 *     * 部件拆分：`kind 99` 引用（＝部件）＋ 每個部件的**原位墨跡**
 *     * 版面算子：**從部件的墨跡推**（⿰⿱⿲⿳⿴⿵⿶⿷⿸⿹⿺）——IDS 有、我們原本沒有的那一塊
 *     * 異體：同碼位的家族成員（`familyMembers`；IDS 完全沒有這一項）
 *     * 字框：`raw`＝KAGE 引用框（引擎實際用的畫板框）、`tight`＝墨跡緊框（父座標）
 *
 * ## 版面算子怎麼推（實測 97.8% 與 IDS 一致，見 `check-structure.ts`）
 *
 * **不要用 KAGE 引用框**——那些是畫板座標、幾乎都佔滿整格（`layoutOf()` 的註解記過這個坑）。
 * 要用**部件在原位的墨**（點陣遮罩）：
 *
 *   1. 兩塊墨大量重疊 → ⿻
 *   2. 墨框在某一軸上分開 → ⿰（左右）／⿱（上下）；三塊 → ⿲／⿳
 *   3. 兩軸都重疊 → 看**外框（IDS 的第一個分量）相對內框封住了哪幾邊**：
 *      每一側的「覆蓋率」＝內框在那一側的範圍，有多少比例被外框的墨封住
 *      （`⿵` 的 `門` 兩條腿會伸到 `口` 下面，但**腿在內框的欄位之外**，所以下面仍是「開」的
 *       ——這是這一條推論的關鍵，用「有沒有墨」判會誤判成 `⿴`）
 *        {L,R,T}→⿵　{L,R,B}→⿶　{T,B,L}→⿷　四邊→⿴　{T,L}→⿸　{T,R}→⿹　{B,L}→⿺
 *
 * 這個模組**不碰引擎**：點陣由呼叫端提供（`Masks`），所以命令列工具與兩個頁面都能用
 * 同一份推論。沒有遮罩時退回「只用墨框」的便宜版（`layoutFromBoxes`，包圍類明顯較差）。
 */

import { codePointOf, displayName, charOf, familyMembers, familyOfIdx, componentKids, indexOfCodePoint } from "./lib-format.ts";
import type { Library, Stroke } from "./lib-format.ts";
import { refSlotsOf, drawingIdx } from "./free-compose.ts";
import type { SlotZone } from "./free-compose.ts";

export type Box = [number, number, number, number];

/** 一個部件的墨跡遮罩（呼叫端用引擎畫出來） */
export interface Masks {
  /** 一方格幾格（遮罩是 grid×grid） */
  grid: number;
  /** 每個部件一個遮罩（與 parts 同序）；1＝有墨 */
  masks: Uint8Array[];
  /** 整個字的墨（用來算「無主墨」）；沒有就給 null */
  whole?: Uint8Array | null;
}

/** 呼叫端提供的遮罩產生器：給字形索引，回傳它的部件遮罩 */
export type MaskProvider = (gi: number) => { masks: Masks; boxes: Box[] } | null;

export interface StructurePart {
  /** 部件指向的字形索引 */
  ref: number;
  /** 顯示用的字元（庫裡沒有碼位就是空字串） */
  ch: string;
  name: string;
  /** KAGE 引用框（畫板座標；引擎實際拿去貼圖的那個矩形） */
  raw: Box;
  /** 墨跡緊框（父字座標；沒有量到就是 null） */
  tight: Box | null;
  /** 這個引用在父字 strokes 裡的索引 */
  strokeIx: number;
  /** 九宮格方位（既有 `slotPosOf`） */
  zone: SlotZone;
  /** 異體：同碼位家族的其他成員（不含自己） */
  variants: number[];
  /** 這個部件自己內部的版面算子（沒有再下一層就是 null） */
  layout: string | null;
}

export interface Structure {
  idx: number;
  name: string;
  ch: string;
  /** 真正在畫的那個節點（穿透「只有一筆引用」的包裝） */
  drawing: number;
  /** 直接部件（依 strokes 順序＝IDS 順序） */
  parts: StructurePart[];
  /** 本層的版面算子（我們自己從墨跡推的；推不出來＝null） */
  layout: string | null;
  /** 推論的信心（0..1；沒有遮罩的便宜版一律 0.5） */
  layoutConf: number;
  /** 給人看的推論說明 */
  layoutWhy: string;
  /** 沒有部件認領的墨比例（0..1）；沒有遮罩就是 null */
  orphanInk: number | null;
  /** 自己的異體家族（同碼位的所有成員） */
  family: number[];
  /** **結構樹**（巢狀）：把部件遞迴切成 ⿰⿱… 的樹；沒有遮罩就是 null */
  tree: TreeNode | null;
  /** 這份結構的資料來源 */
  source: "kage" | "empty";
}

/* ------------------------------------------------------------------ 結構樹（巢狀） */

/**
 * 組字結構的**樹**。葉節點是部件（`part`＝parts 的索引），內部節點是版面算子。
 *
 * 為什麼需要樹：IDS 給的是**巢狀**分解（`品`＝`⿱口吅`、`吅` 自己又是 `⿰口口`），
 * 而字庫的引用是**平的**（`品` 就是三個 `口`）。要能替代 IDS，就得從**圖**把樹切回來——
 * 用文檔版面分析那套 **XY-cut**：找一條「沒有任何部件跨過」的切線，
 * 沿著它把部件分成兩堆（列切＝上下 `⿱`、欄切＝左右 `⿰`），再遞迴切下去。
 *
 *   `品`：橫向有一條空帶（上面一個 `口`、下面兩個）→ `⿱`；下面那兩個再縱切 → `⿰`
 *        ⇒ `⿱(口, ⿰(口,口))`——與 IDS 的 `⿱口吅`（`吅`＝`⿰口口`）**等價**。
 *
 * 切不開時（`困` 的框把 `木` 圍住 → 每一列都有框的墨）才退回包圍類的側邊覆蓋率判定，
 * 再不行就 `⿻`／說不出來。
 */
export interface TreeNode {
  /** 版面算子；null＝切不開（巢狀說不出來）或葉節點 */
  op: string | null;
  /** 葉節點：parts 的索引 */
  part?: number;
  kids: TreeNode[];
  conf: number;
  why: string;
  /** 這一棵子樹涵蓋的 parts 索引（方便比對與除錯） */
  covers: number[];
}

/** 一個部件在格子座標上的範圍 */
function extentOf(m: Uint8Array, grid: number) {
  let x1 = grid, x2 = -1, y1 = grid, y2 = -1;
  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < grid; x++) {
      if (!m[y * grid + x]) continue;
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
    }
  }
  return { x1, x2, y1, y2 };
}

const leafOf = (part: number): TreeNode => ({ op: null, part, kids: [], conf: 1, why: "部件", covers: [part] });

/**
 * 把一群部件遞迴切成結構樹。**只用自己的墨跡**，不看 IDS。
 * @param idxs 這一層要切的部件索引（依 strokes 順序）
 */
export function induceTree(
  masks: Uint8Array[], boxes: Box[], grid: number, idxs: number[], depth = 0,
): TreeNode {
  const covers = [...idxs];
  if (idxs.length === 0) return { op: null, kids: [], conf: 0, why: "沒有部件", covers };
  if (idxs.length === 1) return leafOf(idxs[0]!);
  if (depth >= 6) {
    return { op: null, kids: idxs.map(leafOf), conf: 0, why: "切太深（>6 層）", covers };
  }
  /* 兩個部件：用第一輪那套（含包圍類與疊置） */
  if (idxs.length === 2) {
    const [a, b] = idxs as [number, number];
    const g = layoutFromMasks([masks[a]!, masks[b]!], [boxes[a]!, boxes[b]!], grid);
    return { op: g.op, kids: [leafOf(a), leafOf(b)], conf: g.conf, why: g.why, covers };
  }

  const ext = idxs.map((i) => ({ i, ...extentOf(masks[i]!, grid) }));

  /* ---- XY-cut：找「沒有部件跨過」的切線，取空帶最寬的 ---- */
  type Cand = { axis: "⿱" | "⿰"; gap: number; A: number[]; B: number[] };
  let best: Cand | null = null;
  for (const axis of ["⿱", "⿰"] as const) {
    const lo = (e: typeof ext[number]) => (axis === "⿱" ? e.y1 : e.x1);
    const hi = (e: typeof ext[number]) => (axis === "⿱" ? e.y2 : e.x2);
    /* 切線 t＝A 的墨都在 t 以上／以左，B 的墨都在 t 以下／以右 */
    for (let t = 0; t < grid - 1; t++) {
      if (ext.some((e) => lo(e) <= t && hi(e) > t)) continue;   // 有部件跨過 → 不能切這裡
      const A = ext.filter((e) => hi(e) <= t).map((e) => e.i);
      const B = ext.filter((e) => lo(e) > t).map((e) => e.i);
      if (!A.length || !B.length) continue;
      const gap = Math.min(...B.map((i) => lo(ext.find((e) => e.i === i)!))) -
                  Math.max(...A.map((i) => hi(ext.find((e) => e.i === i)!)));
      if (gap <= 0) continue;
      /* 同一個分組取最寬的空帶；分組不同就比「空帶寬度」，一樣寬時比平衡 */
      const key = (c: Cand) => c.axis + [...c.A].sort().join(",") + "|" + [...c.B].sort().join(",");
      if (best && key(best) === key({ axis, gap, A, B })) {
        if (gap > best.gap) best = { axis, gap, A, B };
        continue;
      }
      const cand: Cand = { axis, gap, A, B };
      if (!best) { best = cand; continue; }
      const score = (c: Cand) => c.gap * 100 - Math.abs(c.A.length - c.B.length) * 0.5;
      if (score(cand) > score(best)) best = cand;
    }
  }
  if (best) {
    const node: TreeNode = {
      op: best.axis,
      kids: [induceTree(masks, boxes, grid, best.A, depth + 1), induceTree(masks, boxes, grid, best.B, depth + 1)],
      conf: 0.9,
      why: `${best.axis}：切在空帶上（最寬 ${best.gap} 格，${best.A.length}／${best.B.length} 塊）`,
      covers,
    };
    return node;
  }

  /* ---- 切不開：包圍類？找一個「框住其他部件」的外框 ---- */
  for (const outer of ext) {
    const others = ext.filter((e) => e.i !== outer.i);
    if (!others.length) continue;
    const ox1 = Math.min(...others.map((e) => e.x1)), ox2 = Math.max(...others.map((e) => e.x2));
    const oy1 = Math.min(...others.map((e) => e.y1)), oy2 = Math.max(...others.map((e) => e.y2));
    const contains = outer.x1 <= ox1 && outer.x2 >= ox2 && outer.y1 <= oy1 && outer.y2 >= oy2;
    if (!contains) continue;
    const c = sideCoverage(masks[outer.i]!, [
      (ox1 / grid) * 200 - 200 / grid / 2, (oy1 / grid) * 200 - 200 / grid / 2,
      ((ox2 + 1) / grid) * 200, ((oy2 + 1) / grid) * 200,
    ], grid);
    const hi = (v: number) => v > SIDE_HI, lo = (v: number) => v < SIDE_LO;
    let op: string | null = null;
    if (hi(c.L) && hi(c.R) && hi(c.T) && hi(c.B)) op = "⿴";
    else if (hi(c.L) && hi(c.R) && hi(c.T) && lo(c.B)) op = "⿵";
    else if (hi(c.L) && hi(c.R) && hi(c.B) && lo(c.T)) op = "⿶";
    else if (hi(c.T) && hi(c.B) && hi(c.L) && lo(c.R)) op = "⿷";
    else if (hi(c.T) && hi(c.L) && !hi(c.R) && !hi(c.B)) op = "⿸";
    else if (hi(c.T) && hi(c.R) && !hi(c.L) && !hi(c.B)) op = "⿹";
    else if (hi(c.B) && hi(c.L) && !hi(c.R) && !hi(c.T)) op = "⿺";
    if (!op) continue;
    return {
      op,
      kids: [leafOf(outer.i), induceTree(masks, boxes, grid, others.map((e) => e.i), depth + 1)],
      conf: 0.7,
      why: `${op}：第 ${outer.i} 塊框住其餘（封住 L${c.L.toFixed(2)} R${c.R.toFixed(2)} T${c.T.toFixed(2)} B${c.B.toFixed(2)}）`,
      covers,
    };
  }

  /* ---- 真的切不開：全部疊在一起 ---- */
  return { op: null, kids: idxs.map(leafOf), conf: 0, why: "切不開（沒有空帶、也沒有包圍關係）", covers };
}

/** 結構樹 → 字串（比對與驗收用）：`⿱(口,⿰(口,口))` */
export function treeToString(t: TreeNode | null, labelOf?: (part: number) => string): string {
  if (!t) return "∅";
  if (t.part !== undefined) return labelOf ? labelOf(t.part) : String(t.part);
  const kids = t.kids.map((k) => treeToString(k, labelOf)).join(",");
  return `${t.op ?? "?"}(${kids})`;
}

/* ------------------------------------------------------------------ 推論：補出缺的部件 */

/**
 * 引擎側要提供的兩個能力（`structure.ts` 本身不碰引擎）。
 * 命令列工具用真的 KAGE 畫；頁面用自己的 kage 實例。
 */
export interface CompRenderer {
  /** 這個字形**自己**的墨框（在它自己的 0..200 空間） */
  inkBox(ref: number): Box | null;
  /** 把這個字形畫進指定的引用框，回傳遮罩（grid×grid） */
  renderInto(ref: number, box: Box, grid: number): Uint8Array | null;
}

const maskIou = (a: Uint8Array, b: Uint8Array) => {
  let inter = 0, uni = 0;
  for (let k = 0; k < a.length; k++) {
    const p = a[k], q = b[k];
    if (p && q) inter++;
    if (p || q) uni++;
  }
  return uni ? inter / uni : 1;
};

/**
 * **不改畫法**，用墨跡把缺的部件補出來（第 5～7 輪驗證、第 8 輪搬進模組）。
 *
 * 情境：`進`＝引用 `辶` ＋ 手畫的 `隹`——畫法只有一個引用，平的部件清單湊不出兩個部件，
 * 結構樹就斷在這裡。做法：
 *   1. 既有引用先當部件（**身分靠幾何對，不比碼位**：`進` 的引用是相容字符 `辶`(U+FA66)，
 *      IDS 寫 `辶`(U+8FB6)，兩者不在同一家族）。
 *   2. 引用沒認領的墨 → 和「還沒對上的分量」做墨跡比對（縮放進剩下的墨框再微調）。
 *   3. **照 `lib.comp` 的分量順序排**（沒排會產生「順序顛倒」的假錯，第 7 輪實測 42.1% → 81.6%）。
 *
 * 門檻刻意放寬（`minFit` 預設 0.3，取「最像的」而不是要求像）：這些字的畫法是**手畫的**、
 * 不是構件的縮放（第 4 輪實測：`兄` 的 `口` 110×75/筆寬 10 vs 正規 `口` 128×128/筆寬 18）。
 * 對不對由驗收的**成績單**判（`check-structure.ts`：接手 217 個、與 IDS 樹一致 81.6%）。
 */
export function inferStructureParts(
  L: Library, gi: number, masks: Masks, render: CompRenderer,
  o: { minFit?: number; minIdentity?: number } = {},
): { parts: StructurePart[]; tree: TreeNode | null; inferred: number } | null {
  const minFit = o.minFit ?? 0.3;
  const minIdentity = o.minIdentity ?? 0.25;
  const grid = masks.grid;
  const cp = codePointOf(L, gi);
  const comps = cp != null ? L.comp?.get(cp) : undefined;
  if (!comps || comps.length < 2) return null;
  const refIdx = parts0(L, gi);                       /* 既有引用（依 strokes 順序） */
  if (refIdx.length === 0 || refIdx.length >= comps.length) return null;
  if (masks.masks.length < refIdx.length) return null;

  const compBoxes = comps.map((c) => {
    const ci = indexOfCodePoint(L, c);
    return ci === undefined ? null : render.inkBox(ci);
  });
  const parts: StructurePart[] = [];
  const refMasks: Uint8Array[] = [];
  const keys: number[] = [];
  refIdx.forEach((r, k) => {
    const m = masks.masks[k];
    if (!m) return;
    refMasks.push(m);
    keys.push(-1);
    const b = boxOfMask(m, grid);
    parts.push({
      ref: r, ch: charOf(L, r) ?? "", name: displayName(L, r), raw: b, tight: b,
      strokeIx: k, zone: "滿", variants: [], layout: null,
    });
  });
  if (!parts.length) return null;

  /* 剩下的墨＝整字 － 既有引用 */
  const whole = masks.whole;
  if (!whole) return null;
  const left = new Uint8Array(whole.length);
  for (let k = 0; k < left.length; k++) {
    if (!whole[k]) continue;
    let cov = false;
    for (const m of refMasks) if (m[k]) { cov = true; break; }
    if (!cov) left[k] = 1;
  }
  const leftBox = boxOfMask(left, grid);
  /* 身分：逐引用找「畫進同一個框之後最像」的分量 */
  const used = new Set<number>();
  for (let k = 0; k < refMasks.length; k++) {
    let bi = -1, bv = minIdentity;
    for (let i = 0; i < comps.length; i++) {
      if (used.has(i) || !compBoxes[i]) continue;
      const ci = indexOfCodePoint(L, comps[i]!);
      if (ci === undefined) continue;
      const m = render.renderInto(ci, parts[k]!.raw, grid);
      if (!m) continue;
      const v = maskIou(m, refMasks[k]!);
      if (v > bv) { bv = v; bi = i; }
    }
    if (bi >= 0) { used.add(bi); keys[k] = bi; }
  }
  /* 這一輪只補「剛好缺一個」；缺多個要先切剩下的墨 */
  const missing = comps.map((_, i) => i).filter((i) => !used.has(i));
  if (missing.length !== 1) return null;
  if (!leftBox || leftBox[2] - leftBox[0] <= 6 || leftBox[3] - leftBox[1] <= 6) return null;
  const i = missing[0]!;
  const cb = compBoxes[i];
  const ci = indexOfCodePoint(L, comps[i]!);
  if (!cb || ci === undefined) return null;
  /* 縮放進剩下的墨框，再做尺度／位移微調 */
  const sc = (s: number, dx: number, dy: number): Box => {
    const cw = Math.max(1e-6, cb[2] - cb[0]), ch = Math.max(1e-6, cb[3] - cb[1]);
    const tw = leftBox[2] - leftBox[0], th = leftBox[3] - leftBox[1];
    const sx = Math.min(400, Math.max(40, (200 * tw) / cw)) * s;
    const sy = Math.min(400, Math.max(40, (200 * th) / ch)) * s;
    const bx = leftBox[0] + dx - (cb[0] * sx) / 200;
    const by = leftBox[1] + dy - (cb[1] * sy) / 200;
    return [bx, by, bx + sx, by + sy];
  };
  let fit: { box: Box; iou: number } | null = null;
  for (const s of [1, 0.9, 1.1]) {
    for (const dx of [0, -8, 8]) {
      for (const dy of [0, -8, 8]) {
        const box = sc(s, dx, dy);
        const m = render.renderInto(ci, box, grid);
        if (!m) continue;
        const v = maskIou(m, left);
        if (!fit || v > fit.iou) fit = { box, iou: v };
      }
    }
  }
  if (!fit || fit.iou < minFit) return null;
  const fm = render.renderInto(ci, fit.box, grid);
  if (!fm) return null;
  keys.push(i);
  parts.push({
    ref: ci, ch: String.fromCodePoint(comps[i]!), name: displayName(L, ci),
    raw: fit.box, tight: fit.box, strokeIx: -1, zone: "中", variants: [], layout: null,
  });
  const allMasks = [...refMasks, fm];
  /* 照 IDS 分量順序排（引用是先推的、推論的補在後面） */
  const order = parts.map((_, k) => k)
    .sort((a, b) => (keys[a]! < 0 ? 99 : keys[a]!) - (keys[b]! < 0 ? 99 : keys[b]!));
  const p2 = order.map((k) => parts[k]!);
  const m2 = order.map((k) => allMasks[k]!);
  return { parts: p2, tree: induceTree(m2, p2.map((p) => p.tight ?? p.raw), grid, p2.map((_, k) => k)), inferred: 1 };
}

/** 一個字形（穿透包裝）的直接引用索引 */
function parts0(L: Library, gi: number): number[] {
  const g = L.glyphs[drawingIdx(L, gi)];
  if (!g) return [];
  return g.strokes.filter((s) => s.kind === 99 && s.ref !== null).map((s) => s.ref!);
}

/**
 * 把「用筆劃畫的合體字」改成「用引用組的」——**這是讓組字結構真的取代 IDS 的那一步**。
 *
 * 做法：`solveIdsSlots()`（放寬版）已經把每個有碼位的分量對到「哪幾筆、放在哪個框」，
 * 於是新的筆劃清單＝**每個分量一筆 `kind 99` 引用（框用解出來的那個）＋ 沒有認領的殘筆**。
 * 引用放在**它原本第一筆的位置**，這樣疊放順序不變。
 *
 * ⚠ 這個函式只產生資料，**不驗收**。驗收要看：改完之後渲染出來的墨跡與原字差多少
 * （`redraw-check.ts` 用 IoU），以及結構樹能不能對上 IDS。
 */
export function redrawStrokes(
  L: Library, gi: number, sol: { drawing: number; slots: { index?: number | undefined; box: number[] | null; group: number[] }[] },
): Stroke[] | null {
  const g = L.glyphs[sol.drawing];
  if (!g) return null;
  /* 只支援「扁平筆劃 ＝ 自己的筆劃」：有既有引用時索引對不上，直接放棄（保守） */
  if (g.strokes.some((s) => s.kind === 99)) return null;
  const owner = new Map<number, number>();
  sol.slots.forEach((s, k) => {
    if (s.index === undefined || !s.box) return;
    for (const i of s.group) owner.set(i, k);
  });
  if (!owner.size) return null;
  const first = new Map<number, number>();
  for (const [i, k] of [...owner.entries()].sort((a, b) => a[0] - b[0])) if (!first.has(k)) first.set(k, i);
  const out: Stroke[] = [];
  g.strokes.forEach((s, i) => {
    const k = owner.get(i);
    if (k === undefined) { out.push(s); return; }
    if (first.get(k) !== i) return;                  // 已經用引用代替 → 這一筆不畫
    const slot = sol.slots[k]!;
    out.push({
      kind: 99, width: 0, style: 0, points: [],
      ref: slot.index!, box: [...slot.box!], stretch: [0, 0, 0, 0],
    });
  });
  return out.length ? out : null;
}

/* ------------------------------------------------------------------ 便宜版：只用墨框 */

const ov1 = (a1: number, a2: number, b1: number, b2: number) =>
  Math.max(0, Math.min(a2, b2) - Math.max(a1, b1)) / Math.max(1e-6, Math.min(a2 - a1, b2 - b1));

export interface LayoutGuess {
  op: string | null;
  conf: number;
  why: string;
}

/**
 * 只用**墨跡緊框**推版面算子（便宜、可內嵌；包圍類較差——`門` 的腿會誤判成 `⿴`）。
 * 有遮罩就優先用 `layoutFromMasks()`。
 */
export function layoutFromBoxes(boxes: (Box | null)[]): LayoutGuess {
  const bs = boxes.filter((b): b is Box => !!b);
  if (bs.length < 2) return { op: null, conf: 0, why: "部件少於兩個" };
  if (bs.length === 3) {
    let xOk = true, yOk = true;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      if (ov1(bs[i]![0], bs[i]![2], bs[j]![0], bs[j]![2]) > 0.2) xOk = false;
      if (ov1(bs[i]![1], bs[i]![3], bs[j]![1], bs[j]![3]) > 0.2) yOk = false;
    }
    if (xOk && !yOk) return { op: "⿲", conf: 0.8, why: "三塊在 x 上分開" };
    if (yOk && !xOk) return { op: "⿳", conf: 0.8, why: "三塊在 y 上分開" };
    return { op: null, conf: 0, why: "三塊的框互相重疊" };
  }
  if (bs.length > 3) return { op: null, conf: 0, why: "部件超過三個（巢狀結構）" };
  const a = bs[0]!, b = bs[1]!;
  const xo = ov1(a[0], a[2], b[0], b[2]);
  const yo = ov1(a[1], a[3], b[1], b[3]);
  if (xo < 0.2 && yo > 0.35) return { op: "⿰", conf: Math.min(1, (0.2 - xo) * 4), why: "x 上分開" };
  if (yo < 0.2 && xo > 0.35) return { op: "⿱", conf: Math.min(1, (0.2 - yo) * 4), why: "y 上分開" };
  if (xo > 0.35 && yo > 0.35) {
    const sl = 8;
    let m = 0;
    if (a[0] < b[0] - sl) m |= 1;
    if (a[2] > b[2] + sl) m |= 2;
    if (a[1] < b[1] - sl) m |= 4;
    if (a[3] > b[3] + sl) m |= 8;
    const op = SIDE_OP[m];
    return op ? { op, conf: 0.5, why: "兩軸重疊、外框在多出來的邊上（框版，較不可靠）" }
              : { op: null, conf: 0, why: "兩軸重疊、框的邊界分不出誰包誰" };
  }
  if (xo < 0.2 && yo < 0.2) return { op: xo <= yo ? "⿰" : "⿱", conf: 0.6, why: "兩軸都分開，取分得較開的那一軸" };
  return { op: xo < yo ? "⿰" : "⿱", conf: 0.4, why: "寬鬆判定（兩軸都部分重疊）" };
}

/* ------------------------------------------------------------------ 準版：用墨跡遮罩 */

const SIDES = { L: 1, R: 2, T: 4, B: 8 } as const;
export const SIDE_OP: Record<number, string> = {
  [SIDES.L | SIDES.R | SIDES.T]: "⿵",
  [SIDES.L | SIDES.R | SIDES.B]: "⿶",
  [SIDES.T | SIDES.B | SIDES.L]: "⿷",
  [SIDES.L | SIDES.R | SIDES.T | SIDES.B]: "⿴",
  [SIDES.T | SIDES.L]: "⿸",
  [SIDES.T | SIDES.R]: "⿹",
  [SIDES.B | SIDES.L]: "⿺",
};

export interface SideCoverage { L: number; R: number; T: number; B: number }

/** 外框相對內框，四個邊各「封住」多少比例（0..1） */
export function sideCoverage(outer: Uint8Array, inner: Box, grid: number): SideCoverage {
  const ix = (x: number) => Math.max(0, Math.min(grid - 1, Math.floor((x / 200) * grid)));
  const inX1 = ix(inner[0]), inX2 = ix(inner[2]), inY1 = ix(inner[1]), inY2 = ix(inner[3]);
  const cov: SideCoverage = { L: 0, R: 0, T: 0, B: 0 };
  let hit = 0, tot = 0;
  for (let y = inY1; y <= inY2; y++) {                 // 左：逐列看左邊有沒有墨
    tot++;
    for (let x = 0; x < inX1; x++) if (outer[y * grid + x]) { hit++; break; }
  }
  cov.L = hit / Math.max(1, tot);
  hit = 0; tot = 0;
  for (let y = inY1; y <= inY2; y++) {                 // 右
    tot++;
    for (let x = inX2 + 1; x < grid; x++) if (outer[y * grid + x]) { hit++; break; }
  }
  cov.R = hit / Math.max(1, tot);
  hit = 0; tot = 0;
  for (let x = inX1; x <= inX2; x++) {                 // 上
    tot++;
    for (let y = 0; y < inY1; y++) if (outer[y * grid + x]) { hit++; break; }
  }
  cov.T = hit / Math.max(1, tot);
  hit = 0; tot = 0;
  for (let x = inX1; x <= inX2; x++) {                 // 下
    tot++;
    for (let y = inY2 + 1; y < grid; y++) if (outer[y * grid + x]) { hit++; break; }
  }
  cov.B = hit / Math.max(1, tot);
  return cov;
}

/** 遮罩的墨框（父座標） */
export function boxOfMask(m: Uint8Array, grid: number): Box {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (let py = 0; py < grid; py++) {
    for (let px = 0; px < grid; px++) {
      if (!m[py * grid + px]) continue;
      const x = ((px + 0.5) / grid) * 200, y = ((py + 0.5) / grid) * 200;
      x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y);
    }
  }
  return [x1, y1, x2, y2];
}

/** 門檻：某一側覆蓋率 ≥ HI＝封住；≤ LO＝開的（實測 97.8% 與 IDS 一致） */
export const SIDE_HI = 0.55;
export const SIDE_LO = 0.25;

/** 用**部件的墨跡遮罩**推版面算子（準版；實測 97.8%） */
export function layoutFromMasks(masks: Uint8Array[], boxes: Box[], grid: number): LayoutGuess {
  if (masks.length < 2) return { op: null, conf: 0, why: "部件少於兩個" };
  if (masks.length === 3) {
    let xOk = true, yOk = true;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      if (ov1(boxes[i]![0], boxes[i]![2], boxes[j]![0], boxes[j]![2]) > 0.2) xOk = false;
      if (ov1(boxes[i]![1], boxes[i]![3], boxes[j]![1], boxes[j]![3]) > 0.2) yOk = false;
    }
    if (xOk && !yOk) return { op: "⿲", conf: 0.8, why: "三塊墨在 x 上分開" };
    if (yOk && !xOk) return { op: "⿳", conf: 0.8, why: "三塊墨在 y 上分開" };
    return { op: null, conf: 0, why: "三塊墨互相重疊" };
  }
  if (masks.length > 3) return { op: null, conf: 0, why: "部件超過三個（巢狀結構）" };
  const a = boxes[0]!, b = boxes[1]!;
  const xo = ov1(a[0], a[2], b[0], b[2]);
  const yo = ov1(a[1], a[3], b[1], b[3]);
  /* ⿰／⿱ 用**兩軸重疊率的差**判，不要用固定門檻：
     `明` 的日／月墨框在 x 上重疊 0.40（字距近、筆畫寬），固定門檻 0.2 會把它推進包圍類。 */
  const d = xo - yo;
  /* 第二個訊號：**兩塊墨的中心偏向哪一軸**。兩個訊號一致才敢說；
     不一致（例：小部件擠在角落）就棄權——實測這樣把「說錯」從 1.0% 壓到 0.3%。 */
  const ux1 = Math.min(a[0], b[0]), ux2 = Math.max(a[2], b[2]);
  const uy1 = Math.min(a[1], b[1]), uy2 = Math.max(a[3], b[3]);
  const dx = Math.abs((a[0] + a[2]) / 2 - (b[0] + b[2]) / 2) / Math.max(1, ux2 - ux1);
  const dy = Math.abs((a[1] + a[3]) / 2 - (b[1] + b[3]) / 2) / Math.max(1, uy2 - uy1);
  const byOverlap = d > 0 ? "y" : "x";
  const byCenter = dy > dx ? "y" : "x";
  const strong = Math.abs(d) > 0.6;
  if (Math.abs(d) > 0.35 && (byOverlap === byCenter || strong)) {
    const op = byOverlap === "y" ? "⿱" : "⿰";
    const conf = byOverlap === byCenter ? Math.min(1, Math.abs(d)) : 0.45;
    return {
      op, conf,
      why: `${op}：${byOverlap === "y" ? "y" : "x"} 上分開（x 重疊 ${xo.toFixed(2)}、y ${yo.toFixed(2)}；` +
        `中心偏移 x ${dx.toFixed(2)}、y ${dy.toFixed(2)}${byOverlap === byCenter ? "" : "，兩訊號不一致"}）`,
    };
  }
  if (xo > 0.35 && yo > 0.35) {
    const c = sideCoverage(masks[0]!, b, grid);
    const hi = (v: number) => v > SIDE_HI, lo = (v: number) => v < SIDE_LO;
    const why = (op: string) =>
      `${op}：封住 L${c.L.toFixed(2)} R${c.R.toFixed(2)} T${c.T.toFixed(2)} B${c.B.toFixed(2)}`;
    if (hi(c.L) && hi(c.R) && hi(c.T) && hi(c.B)) return { op: "⿴", conf: 0.9, why: why("四邊封住") };
    if (hi(c.L) && hi(c.R) && hi(c.T) && lo(c.B)) return { op: "⿵", conf: 0.9, why: why("上＋左右封住、下面開") };
    if (hi(c.L) && hi(c.R) && hi(c.B) && lo(c.T)) return { op: "⿶", conf: 0.9, why: why("下＋左右封住、上面開") };
    if (hi(c.T) && hi(c.B) && hi(c.L) && lo(c.R)) return { op: "⿷", conf: 0.9, why: why("上下＋左封住、右面開") };
    if (hi(c.T) && hi(c.L) && !hi(c.R) && !hi(c.B)) return { op: "⿸", conf: 0.75, why: why("上＋左") };
    if (hi(c.T) && hi(c.R) && !hi(c.L) && !hi(c.B)) return { op: "⿹", conf: 0.75, why: why("上＋右") };
    if (hi(c.B) && hi(c.L) && !hi(c.R) && !hi(c.T)) return { op: "⿺", conf: 0.75, why: why("下＋左") };
    /* 兩塊墨大量重疊 → 疊置 */
    let both = 0, any = 0;
    for (let k = 0; k < masks[0]!.length; k++) {
      const p = masks[0]![k], q = masks[1]![k];
      if (p && q) both++;
      if (p || q) any++;
    }
    if (any && both / any > 0.5) return { op: "⿻", conf: 0.6, why: "兩塊墨大面積重疊" };
    return { op: null, conf: 0, why: why("四邊覆蓋率落不出規則") };
  }
  /* 兩軸都分開（斜角）或差不到門檻：取分得較開的那一軸，信心照差距給 */
  const ad = Math.abs(d);
  return {
    op: d > 0 ? "⿱" : "⿰",
    conf: Math.min(1, ad * 2) * 0.6,
    why: `兩軸分得差不多（x ${xo.toFixed(2)}、y ${yo.toFixed(2)}），取 y/x 較開的那一軸`,
  };
}

/* ------------------------------------------------------------------ 結構 */

/**
 * 一個字的**直接部件**（＝組字結構的「部件拆分」那一層）。
 * 純資料：引用框、方位、異體都來自字庫；`tight` 要呼叫端量（`inkOf`）。
 */
export function structureParts(
  L: Library, gi: number, inkOf?: (i: number) => Box | null,
): StructurePart[] {
  const slots = refSlotsOf(L, gi);
  const out: StructurePart[] = [];
  for (const s of slots) {
    const cp = codePointOf(L, s.ref);
    const inner = inkOf ? inkOf(s.ref) : null;
    const raw = s.box as Box;
    /* 子字形的墨跡經引用框映射回父座標（與 `componentBoxes` 同一條） */
    const tight: Box | null = inner
      ? [
          raw[0] + (inner[0] * (raw[2] - raw[0])) / 200,
          raw[1] + (inner[1] * (raw[3] - raw[1])) / 200,
          raw[0] + (inner[2] * (raw[2] - raw[0])) / 200,
          raw[1] + (inner[3] * (raw[3] - raw[1])) / 200,
        ]
      : null;
    const fam = cp != null ? familyMembers(L, cp) : [];
    out.push({
      ref: s.ref,
      ch: charOf(L, s.ref) ?? "",
      name: displayName(L, s.ref),
      raw,
      tight,
      strokeIx: s.strokeIx,
      zone: s.zone,
      variants: fam.filter((v) => v !== s.ref),
      layout: null,
    });
  }
  return out;
}

/** 一個字的組字結構（部件拆分 ＋ 版面 ＋ 異體 ＋ 字框）。 */
export function structureOf(
  L: Library, gi: number,
  o: { inkOf?: (i: number) => Box | null; masks?: Masks; depth?: number } = {},
): Structure {
  const depth = o.depth ?? 1;
  const drawing = drawingIdx(L, gi);
  const cp = codePointOf(L, gi);
  const parts = structureParts(L, drawing, o.inkOf);
  let layout: string | null = null;
  let conf = 0, why = "沒有部件";
  if (parts.length >= 2) {
    if (o.masks && o.masks.masks.length === parts.length) {
      const g = layoutFromMasks(o.masks.masks, o.masks.masks.map((m) => boxOfMask(m, o.masks!.grid)), o.masks.grid);
      layout = g.op; conf = g.conf; why = g.why;
    } else {
      const g = layoutFromBoxes(parts.map((p) => p.tight ?? p.raw));
      layout = g.op; conf = g.conf; why = g.why;
    }
  }
  /* 無主墨：整字的墨沒有被任何部件蓋到的比例（要遮罩才算得出來） */
  let orphanInk: number | null = null;
  if (o.masks && o.masks.whole) {
    const { whole, masks } = o.masks;
    let ink = 0, covered = 0;
    for (let k = 0; k < whole.length; k++) {
      if (!whole[k]) continue;
      ink++;
      for (const m of masks) if (m[k]) { covered++; break; }
    }
    orphanInk = ink ? (ink - covered) / ink : 0;
  }
  /* 結構樹：把平的部件清單遞迴切成 ⿰⿱… 的樹（巢狀結構，IDS 的那一層） */
  let tree: TreeNode | null = null;
  if (o.masks && o.masks.masks.length === parts.length && parts.length > 0) {
    const boxes = parts.map((p) => p.tight ?? p.raw);
    tree = induceTree(o.masks.masks, boxes, o.masks.grid, parts.map((_, k) => k));
  }
  /* 每個部件自己內部的版面（遞迴一層，夠用且便宜） */
  if (depth > 0) {
    for (const p of parts) {
      const sub = structureParts(L, drawingIdx(L, p.ref));
      if (sub.length >= 2) {
        const g = layoutFromBoxes(sub.map((q) => q.tight ?? q.raw));
        p.layout = g.op;
      }
    }
  }
  return {
    idx: gi,
    name: displayName(L, gi),
    ch: charOf(L, gi) ?? "",
    drawing,
    parts,
    layout,
    layoutConf: conf,
    layoutWhy: why,
    orphanInk,
    family: cp != null ? familyMembers(L, cp) : [],
    tree,
    source: parts.length ? "kage" : "empty",
  };
}

/** 這個字在庫裡的家族代號（-1＝沒有家族表） */
export function familyIndexOf(L: Library, gi: number): number {
  return familyOfIdx(L, gi);
}

/** 遞迴走完整棵結構樹的部件數（含自己這一層）；用來量「結構有多深」 */
export function structureSize(L: Library, gi: number, depth = 0): number {
  if (depth > 8) return 0;
  const kids = componentKids(L, gi);
  let n = kids.length;
  for (const k of kids) n += structureSize(L, k, depth + 1);
  return n;
}
