/**
 * free-compose.ts — 「自由組字」的語法層與內嵌渲染：Node 與瀏覽器共用同一份原文。
 *
 * 這個檔案**不得**引入任何 Node/Bun 專屬模組（無 fs、無 sqlite），
 * 因為它同時被：
 *   1. `tools/free-compose-test.ts`（Node 端驗證）
 *   2. `out/kage-viewer.html`（瀏覽器端，用 Bun.Transpiler 內嵌原文）
 * 使用——與 `lib-format.ts` 一樣的理由：只有一份實作，不會各說各話。
 *
 * ---------------------------------------------------------------------------
 * 一、構形序列的語意（依 `format.md`「進階任務 2」的定義）
 * ---------------------------------------------------------------------------
 *   `峰夆電雨水`
 *     ＝ 峰 中的「夆」替換為「電雨水」
 *     ＝ 而「電雨水」＝ 電 上方的「雨」改為「水」
 *
 *   規則：**base + 舊部件 + 新內容…**，而「新內容」本身可以再是一個構形序列
 *   （遞歸）。所以：
 *     `街圭舞`     → 街 的 圭 → 舞
 *     `街行彳舞亍` → 街 的 行 →（彳舞亍）；而 彳舞亍 是「一串原始部件」
 *   「一串原始部件」（≥2 個、且第一個字不是基字時）橫向等分排進槽位。
 *
 *   這一條是本檔最重要的決定，也是施工單 §二 V2 的答案：
 *   引擎**吃得下**，語意就是上面這個遞歸讀法。
 *
 * ---------------------------------------------------------------------------
 * 二、內文語法與三條護欄（施工單 §三）
 * ---------------------------------------------------------------------------
 *   構形序列寫在 `︵` U+FE35 / `︶` U+FE36 之間。它們是合法 Unicode 字元
 *   （豎排古籍本來就可能出現），所以：
 *     1. 必須成對，否則不觸發
 *     2. 不跨行
 *     3. 長度上限 MAX_PARTS 個部件
 *   三條都成立才當成構形序列，否則原樣顯示純文字。
 */
import {
  toKageData, isVariantOfCp, indexOfChar, charOf, displayName, keyOfIdx, keyOf,
  isPlainIdeograph, codePointOf, indexOfCodePoint, componentKids, ptCountOf, computeTight,
} from "./lib-format.ts";
import type { Library, Glyph, Stroke } from "./lib-format.ts";
import { normalizeSvg, ensureEngine, composeFit, inkOfRefInParent, refitBand, inkAlignedBox } from "./compose-fit.ts";
import type { Lib } from "./compose-fit.ts";

/** 構形序列的定界符（豎排括號） */
export const OPEN = "\uFE35";
export const CLOSE = "\uFE36";
/** 一個構形序列最多幾個部件（護欄 3） */
export const MAX_PARTS = 12;
/** 遞歸深度上限（護欄：避免病態輸入） */
export const MAX_DEPTH = 6;

export type SeqOk = {
  ok: true;
  lib: Library;
  targetIdx: number;
  log: string[];
  /**
   * 這次求值是否真的做了「替換」？
   * false ＝ 只是把 n 個原始部件橫向串接起來（`buildRow`）。
   * 上層要靠這個旗標分辨「遞歸讀法成立」與「退化成串接」——
   * 只有前者才算 `峰夆電雨水` 那種巢狀讀法。
   */
  substituted: boolean;
};
export type SeqResult = SeqOk | { ok: false; error: string };

/**
 * 讀法選項。
 *
 * `rowFallback`（預設 true）決定「遞歸讀法不成立時」要不要退化成
 * 「一串原始部件」橫向等分：
 *
 *   true（預設，遞歸優先）
 *       `彳舞亍` → 彳 裡沒有 舞 → 退化成 ⿲彳舞亍（三件並排），**會顯示**。
 *       官方例子全部照 `format.md` 的定義走：
 *         `街圭舞`     → 街 的 圭 → 舞
 *         `峰夆電雨水` → 峰 的 夆 →（電 的 雨 → 水）
 *   false（嚴格遞歸）
 *       `彳舞亍` → 直接失敗並說明原因，**不猜**。
 *
 * 這一條是施工單 §二 V2 要師父確認的地方。UI 上做一個開關，
 * 兩種結果直接並排給師父看，不要用猜的。
 */
export interface SeqOptions {
  rowFallback?: boolean;
  /** 內部用：遞歸進來的呼叫不自行找退路（退路由最外層決定） */
  recursiveOnly?: boolean;
  /**
   * **同層讓位**（預設 true）：新內容會壓到同層兄弟的墨跡時，把框退到
   * 兄弟之外的帶狀區。關掉就回到舊行為「一律沿用原框」。
   * 與 `composeFit` 的 `FitOptions.band` 是同一條規則、同一份實作。
   */
  band?: boolean;
}

/**
 * 取一個字元在庫中的索引。
 *
 * **對外一律走 Unicode**：呼叫端給字元，這裡解碼位。
 * 偏好（`-j` 之類）由 `lib-format.ts` 的家族表決定，呼叫端不需要知道。
 */
export function idxOf(L: Library, c: string): number | undefined {
  return indexOfChar(L, c);
}

/**
 * 淺複製一份庫，之後可以安全地改寫引用。
 *
 * v1 會連名字陣列一起複製（舊網頁要用原本的 key）；v2 沒有名字陣列，
 * 新字形的 key 由索引導出，不需要維護任何字串表。
 */
function fork(L: Library): { lib: Library; glyphs: Glyph[] } {
  const glyphs: Glyph[] = L.glyphs.map((g) => ({ tight: g.tight, strokes: g.strokes }));
  const lib: Library = { ...L, glyphs };
  if (L.names) lib.names = L.names.slice();
  return { lib, glyphs };
}

/** 在庫尾加一個合成字形；v1 順便補一個名字，讓 kage 的 key 維持可讀 */
function appendSynthetic(lib: Library, glyphs: Glyph[], strokes: Stroke[], tag: string): number {
  const idx = glyphs.length;
  glyphs.push({ tight: [0, 0, 200, 200], strokes });
  if (lib.names) lib.names.push("__" + tag + idx);
  return idx;
}

/**
 * 「串接部件」：把 n 個原始部件橫向等分排進 200×200。
 *
 * 這是 `彳舞亍`（一串原始部件）的實作。**刻意用等分**——本階段不做空間優化
 * （施工單 §一「明確不做」、`format.md`「空間優化已結案」），
 * 越簡單越不會引入第二套幾何邏輯。
 *
 * 回傳新字形的索引（插在庫尾，名字為 `__row…`，不會與真實字形撞名）。
 */
export function buildRow(
  L: Library, chars: string[],
): { ok: true; lib: Library; idx: number; log: string[] } | { ok: false; error: string } {
  const { lib, glyphs } = fork(L);
  const idxs: number[] = [];
  for (const c of chars) {
    const i = idxOf(lib, c);
    if (i === undefined) return { ok: false, error: `部件「${c}」不在字形庫中` };
    idxs.push(i);
  }
  const w = 200 / idxs.length;
  const strokes: Stroke[] = idxs.map((i, k) => ({
    kind: 99, width: 0, style: 0, points: [0, 0, 0, 0],
    ref: i,
    box: [Math.round(k * w), 0, Math.round((k + 1) * w), 200],
    stretch: [0, 0, 0, 0],
  }));
  const idx = appendSynthetic(lib, glyphs, strokes, "row");
  return { ok: true, lib, idx, log: [`串接部件 ${chars.join("")}（橫向 ${idxs.length} 等分）`] };
}

/**
 * 把「新內容」解析成一個可以直接代入單一槽位的字形索引。
 *
 * 多個字的情況（施工單 §二 V2 要師父確認的那一條）：
 *   1. 先試遞歸讀法 `base 舊 新…`（`rec.substituted` 為真才算成立）
 *   2. 不成立、且允許串接時 → 退化成「一串原始部件」橫向等分（`彳舞亍` 這種）
 *
 * `o.rowFallback === false` 時跳過第 2 步。但**預設的 evalSeq 呼叫端**
 * （`resolveNew`）一定要允許第 2 步，否則官方例子 `峰夆電雨水` 會失敗
 * ——它的「新內容」是 `電雨水`，遞歸讀法成立，但那是內層自己再遞歸的事。
 */
function resolveNew(
  L: Library, expr: string, depth: number, o: SeqOptions, allowRow = true,
): { ok: true; lib: Library; idx: number; log: string[] } | { ok: false; error: string } {
  const chars = Array.from(expr);
  if (chars.length === 0) return { ok: false, error: "替換內容為空" };
  if (chars.length === 1) {
    const i = idxOf(L, chars[0]!);
    if (i === undefined) return { ok: false, error: `部件「${chars[0]}」不在字形庫中` };
    return { ok: true, lib: L, idx: i, log: [] };
  }
  const rec = evalSeq(L, expr, o, depth + 1);
  if (rec.ok && rec.substituted) {
    return { ok: true, lib: rec.lib, idx: rec.targetIdx, log: rec.log };
  }
  if (!allowRow || o.rowFallback === false) {
    return { ok: false, error: rec.ok ? `「${expr}」讀不成構形序列` : rec.error };
  }
  const row = buildRow(L, chars);
  if (!row.ok) return { ok: false, error: row.error };
  return { ok: true, lib: row.lib, idx: row.idx, log: row.log };
}

/**
 * 求值一個構形序列（遞歸）。
 *
 * 步驟：
 *   1. 只有一個字 → 就是該字本身
 *   2. 否則 base = 第 1 字、舊 = 第 2 字、新內容 = 第 3 字起
 *   3. 先把「新內容」求值成單一部件索引
 *   4. 在 base 的引用樹中找「舊」的槽位，**沿用該槽位的框與伸縮**（人工資產），
 *      把 ref 指到新內容
 *
 * 第 4 步沿用框是關鍵：框是人工手調的資產（見 `format.md`「框與自由組字」），
 * 且這樣替換者佔用同一版面關係，不需要第二套幾何。
 */
export function evalSeq(
  L: Library, expr: string, o: SeqOptions = {}, depth = 0,
): SeqResult {
  if (depth > MAX_DEPTH) return { ok: false, error: "構形序列遞歸過深" };
  const chars = Array.from(expr);
  if (chars.length === 0) return { ok: false, error: "空的構形序列" };
  // 護欄 3：長度上限。放在求值器裡，不只靠內文掃描——
  // 直接呼叫 evalSeq 的路徑（③ 字形檢視的輸入框）也要擋。
  if (chars.length > MAX_PARTS) {
    return { ok: false, error: `構形序列過長（${chars.length} 個部件 > 上限 ${MAX_PARTS}）` };
  }
  if (chars.length === 1) {
    const i = idxOf(L, chars[0]!);
    if (i === undefined) return { ok: false, error: `字「${chars[0]}」不在字形庫中` };
    return { ok: true, lib: L, targetIdx: i, log: [], substituted: false };
  }
  if (chars.length === 2) {
    return { ok: false, error: `「${expr}」只有基字與舊部件、沒有替換內容` };
  }

  const base = chars[0]!;
  const old = chars[1]!;
  const newExpr = chars.slice(2).join("");

  // ---- 遞歸讀法：base 的 old → 新內容（新內容自己再求值）----
  // 注意「新內容求不出來」與「舊部件不在樹裡」都要走同一條退路判斷，
  // 不能一失敗就 return ——`街行彳舞亍` 屬於前者（彳舞亍 求不出遞歸），
  // 而它必須能畫出來。
  const ni = resolveNew(L, newExpr, depth, { ...o, recursiveOnly: true });
  const applied: SeqResult = ni.ok
    ? applyReplace(ni.lib, base, old, ni.idx, newExpr, ni.log, o.band !== false)
    : { ok: false, error: `「${newExpr}」：${ni.error}` };
  if (applied.ok) return applied;
  if (o.recursiveOnly || o.rowFallback === false) return applied;

  // ---- 退路：一整串原始部件橫向等分 ----
  //
  // 三個條件都要成立才走這裡（每一條都是實測踩出來的）：
  //   1. **舊部件確實是 base 的部件**（只是替換不成）——否則就是打錯字。
  //      例如 `街無此件`：`無` 不在 街 的樹裡，直接失敗比靜默畫出一坨好。
  //   2. **base 本身不是「有結構的字」**（沒有 99 引用節點），或舊部件的槽位存在。
  //      沒有結構的字才讀得成「一串部件」：`彳舞亍` 的 彳 是純筆畫字，
  //      所以它是 ⿲彳舞亍；而 `街` 有結構（行＋圭）。
  //   3. **舊部件不在 base 的 IDS 構件階層裡**（見下面的註解）：在裡面的話，
  //      使用者要的是「原地換掉它」，退化只會畫出像拼成功的錯形。
  const baseIdx = idxOf(L, base);
  if (baseIdx === undefined) return applied;
  const baseGlyph = L.glyphs[baseIdx];
  if (!baseGlyph) return applied;
  const hasRefs = baseGlyph.strokes.some((s) => s.kind === 99 && s.ref !== null);
  const oldCp = old.codePointAt(0)!;
  const oldIsPart = hasRefs && findSlotIdx(L, baseIdx, oldCp) !== null;

  /* 舊部件在 base 的 **IDS 構件階層**裡（KAGE 引用樹裡沒有）時，使用者要的是
     「原地把那個部件換掉」——引擎換不到孫級部件，所以**不可以**退化成橫向串接：
     `幸土业` 會被畫成「幸 土 业 三等分」，看起來像拼成功（使用者回報「還是有問題」）。
     寧可判不合法，並把理由說清楚（見 `pinxing.md` 的引擎限制）。
     判準用 IDS ＋ KAGE 兩條來源、家族感知比對，所以 `彳舞亍`（舞 不是 彳 的構件）
     仍然是合法的「一串部件」讀法。 */
  if (isDescendantCp(L, baseIdx, oldCp) && !oldIsPart) {
    return { ok: false, error: idsGrandchildError(base, old) };
  }
  if (hasRefs && !oldIsPart) return applied;

  const row = buildRow(L, chars);
  if (row.ok) {
    return { ok: true, lib: row.lib, targetIdx: row.idx, log: row.log, substituted: false };
  }
  return applied;
}

/**
 * `cp` 是不是 `gi` 的構件（含孫級、曾孫級）？
 *
 * 兩條來源都走：IDS 表（`lib.comp`，v3 字庫才有）與 KAGE 引用；比對用
 * `isVariantOfCp`（家族感知），因為構件經常是「同一個字的另一種寫法」
 * （例：`街` 引用 `u884c-05`，而它屬於 `行` 的家族）。
 *
 * v2 字庫沒有 IDS 區段，這時只看得到 KAGE 那條——行為與以前相同（不會誤擋）。
 */
function isDescendantCp(L: Library, gi: number, cp: number, maxDepth = 4): boolean {
  if (cp === 0) return false;
  let level = [gi];
  const seen = new Set<number>(level);
  for (let d = 0; d < maxDepth && level.length; d++) {
    const next: number[] = [];
    for (const x of level) {
      for (const kid of componentKids(L, x)) {
        if (kid === gi) continue;
        if (isVariantOfCp(L, kid, cp)) return true;
        if (!seen.has(kid)) { seen.add(kid); next.push(kid); }
      }
    }
    level = next;
  }
  return false;
}

/** 「換不到孫級部件」的說明（`報土业`、`幸土业` 都是這一條） */
function idsGrandchildError(base: string, old: string): string {
  return `「${old}」在「${base}」的構件階層裡，但不在 KAGE 引用樹中——` +
    `引擎換不到孫級部件（見 pinxing.md 的引擎限制），不當成橫向串接`;
}

/* ==================== IDS 槽位推斷（孫級部件，2026-10-13） ==================== */
/* 背景：`幸` 的 KAGE 是「一筆引用 → 一個用筆畫畫的字形」，而它的 IDS 是 `[土 𢆉]`。
 * `幸土业` 要的是「把 幸 裡的 土 原地換成 业」＝ ⿱业𢆉，但引擎走的是引用樹、
 * 土 不在裡面（字庫的 IDS 區段只存分量，沒有算子也沒有框）。
 *
 * 解法：**從筆畫反推槽位**——把父字形的筆畫依構件筆數分組、把構件攤平成絕對筆畫，
 * 逐一評分（構件映射進推得的框之後與該組筆畫的最大座標差），取最佳分組。
 * 只有在「誤差夠小」且「明顯贏過框不一樣的次佳解」時才採用，否則維持原本的
 * 「找不到部件」——寧可說不合法，也不要猜出一個錯的框。
 * 換的時候**只拔掉目標構件那幾筆**，其餘筆畫原樣保留（其他部分外觀完全不變）。
 */

const IDS_SLOT_TOL = 25;      // 容許的最大偏差（200 座標；實測 幸 14.5、畫 20.0、盟 21.5）
const IDS_SLOT_MARGIN = 1.5;  // 最佳解要贏過「框明顯不同」的次佳解這麼多倍
const IDS_SLOT_DISTINCT = 5;  // 兩個框差多少才算「明顯不同」
const IDS_SLOT_BUDGET = 20000; // 分組列舉的節點上限（避免多構件時爆掉）
/* 「部分 IDS」用自己的一組門檻：那一條路的殘筆只能「當成」沒有碼位的那個構件，
   而且**同一個碼位常常有不只一個字形**（`䴺` 引用的是**窄版**的 `麥` g1ca5，
   打「麥」拿到的是 g1ca4）——窄版是把同一個字橫向壓縮畫的，殘差自然比較大。實測：
     g1ca4（正規麥）的 `來`：誤差 14.0，次佳不同解 46.0（3.3 倍）
     g1ca5（窄版麥）的 `來`：誤差 25.5，次佳不同解 50.9（2.0 倍）——挑的是**同一組筆畫**（前 8 筆）
   所以部分 IDS 放寬到 30／1.5 倍（完整 IDS 仍是 25／1.5）。
   放寬的證據是全庫稽核（`out/partial-audit.html` 的圖）：可達的正規字形只有 100 多個，
   逐一畫出來看「紅色那組筆畫是不是真的那個構件」，含誤差 25～30 的邊緣案例。 */
const IDS_SLOT_TOL_PARTIAL = 30;
const IDS_PARTIAL_MARGIN = 1.5;

interface FlatStroke { kind: number; pts: number[] }
type SlotBox = [number, number, number, number];
/** 一格槽位。`index`／`box` 可能是 undefined／null：**沒有碼位的那個構件**
 *  （字庫存不到它，只知道「剩下的筆畫是它的」）沒有字形索引、也沒有框。 */
interface IdsSlot { cp: number | undefined; index: number | undefined; box: SlotBox | null; group: number[] }
interface IdsSolution { drawing: number; slots: IdsSlot[]; error: number; partial: boolean }

/**
 * `solveIdsSlots()` 的旋鈕。預設值＝原本的行為（置換用，寧可推不出來也不要猜錯）。
 *
 * **重畫（把筆劃改成引用）用另一組**：`{ relaxed: true, forceBest: true, tol: 40 }`
 * ——那邊不怕「猜錯」（猜錯會被墨跡 IoU 擋下來），怕的是明明解得出來卻棄權。
 * 實測：`哥`＝`⿱可可`（兩個一模一樣的分量）在預設門檻下會因為「次佳解分數接近」棄權，
 * 但兩個解其實只是把兩個同形部件互換，對「重畫」毫無差別。
 */
export interface IdsSlotOptions {
  /** 允許**任意數量**沒有碼位的分量（預設：只允許一個，即「部分 IDS」） */
  relaxed?: boolean;
  /** 幾何誤差上限（預設：完整 IDS 25、部分 IDS 30） */
  tol?: number;
  /** 次佳解要差幾倍才敢用（預設：1.5） */
  margin?: number;
  /** 關掉「次佳解接近就不猜」的護欄（預設 false） */
  forceBest?: boolean;
}

/** 沿著「只有一筆引用」的包裝往下走，取到真正用筆畫畫的字形。
 *  匯出是給 `analyze-structure.ts` 用的（分析要看「真的在畫」的那個節點）。 */
export function drawingIdx(L: Library, gi: number): number {
  let cur = gi;
  for (let d = 0; d < 8; d++) {
    const g = L.glyphs[cur];
    if (!g) return cur;
    const refs = g.strokes.filter((s) => s.kind === 99 && s.ref !== null);
    if (g.strokes.length === 1 && refs.length === 1) { cur = refs[0]!.ref!; continue; }
    return cur;
  }
  return cur;
}

/** 這個字形自己有沒有引用筆畫（有的話槽位已經存在，不需要推斷）。
 *  名稱要跟 glyph-browser-page.js 的 `hasRefStroke(i)` 區隔開——兩者會被內嵌進
 *  同一個 script 作用域，同名會讓整頁「Cannot declare a function that shadows…」（踩過）。 */
const hasOwnRefStroke = (L: Library, gi: number) =>
  (L.glyphs[gi]?.strokes ?? []).some((s) => s.kind === 99 && s.ref !== null);

const boxMap = (b: SlotBox, p: SlotBox): SlotBox => [
  p[0] + (b[0] * (p[2] - p[0])) / 200, p[1] + (b[1] * (p[3] - p[1])) / 200,
  p[0] + (b[2] * (p[2] - p[0])) / 200, p[1] + (b[3] * (p[3] - p[1])) / 200,
];

/** 攤平成絕對座標筆畫。**只取前 2*ptCountOf(kind) 個座標**：格式每筆固定存 8 個數字，
 *  多出來的是補位（有時還留著舊的框），當成座標比對會整個歪掉（踩過一次）。 */
function flattenStrokes(L: Library, gi: number, box: SlotBox = [0, 0, 200, 200], depth = 0): FlatStroke[] {
  if (depth > 10) return [];
  const out: FlatStroke[] = [];
  for (const s of L.glyphs[gi]?.strokes ?? []) {
    if (s.kind === 99 && s.ref !== null && s.box) {
      out.push(...flattenStrokes(L, s.ref, boxMap(s.box as SlotBox, box), depth + 1));
      continue;
    }
    const n = ptCountOf(s.kind);
    if (n === 0) continue;
    const pts: number[] = [];
    for (let i = 0; i < n; i++) {
      pts.push(
        box[0] + (s.points[i * 2]! * (box[2] - box[0])) / 200,
        box[1] + (s.points[i * 2 + 1]! * (box[3] - box[1])) / 200,
      );
    }
    out.push({ kind: s.kind, pts });
  }
  return out;
}

function flatBox(f: FlatStroke[]): SlotBox {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const s of f) {
    for (let i = 0; i < s.pts.length / 2; i++) {
      x1 = Math.min(x1, s.pts[i * 2]!); x2 = Math.max(x2, s.pts[i * 2]!);
      y1 = Math.min(y1, s.pts[i * 2 + 1]!); y2 = Math.max(y2, s.pts[i * 2 + 1]!);
    }
  }
  return [x1, y1, x2, y2];
}

const kindSig = (f: FlatStroke[]) => f.map((s) => s.kind).sort((a, b) => a - b).join(",");

/** 由「構件自己的外框」與「它在父字形裡的那組筆畫」反推構件框 */
function deriveSlot(comp: FlatStroke[], group: FlatStroke[]): SlotBox | null {
  const c = flatBox(comp), g = flatBox(group);
  const cw = c[2] - c[0], ch = c[3] - c[1], gw = g[2] - g[0], gh = g[3] - g[1];
  if (cw <= 0 && ch <= 0) return null;
  let sx = cw > 0 ? (200 * gw) / cw : NaN;
  let sy = ch > 0 ? (200 * gh) / ch : NaN;
  if (!Number.isFinite(sx) && !Number.isFinite(sy)) return null;
  if (!Number.isFinite(sx)) sx = sy;
  if (!Number.isFinite(sy)) sy = sx;
  const bx = g[0] - (c[0] * sx) / 200, by = g[1] - (c[1] * sy) / 200;
  return [bx, by, bx + sx, by + sy];
}

/** 評分：構件每一筆映射進框後，與組內最接近的同型筆畫的最大座標差 */
function slotError(comp: FlatStroke[], group: FlatStroke[], box: SlotBox): number {
  if (kindSig(comp) !== kindSig(group)) return Infinity;
  const used = new Set<number>();
  let worst = 0;
  for (const cs of comp) {
    let best = Infinity, bestIdx = -1;
    for (let i = 0; i < group.length; i++) {
      if (used.has(i)) continue;
      const gs = group[i]!;
      if (gs.kind !== cs.kind || gs.pts.length !== cs.pts.length) continue;
      let d = 0;
      for (let k = 0; k < cs.pts.length; k++) {
        const mapped = k % 2 === 0
          ? box[0] + (cs.pts[k]! * (box[2] - box[0])) / 200
          : box[1] + (cs.pts[k]! * (box[3] - box[1])) / 200;
        d = Math.max(d, Math.abs(mapped - gs.pts[k]!));
      }
      if (d < best) { best = d; bestIdx = i; }
    }
    if (bestIdx < 0) return Infinity;
    used.add(bestIdx);
    worst = Math.max(worst, best);
  }
  return worst;
}

/** 構件分組的中心是否與 IDS 順序一致（沿 x 或沿 y 單調）——避免把構件對錯人 */
function idsOrderOk(groups: number[][], parent: FlatStroke[]): boolean {
  const cs = groups.map((grp) => flatBox(grp.map((i) => parent[i]!)))
    .map((b) => ({ x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 }));
  const mono = (v: number[]) =>
    v.every((x, i) => i === 0 || x >= v[i - 1]! - 1e-6) || v.every((x, i) => i === 0 || x <= v[i - 1]! + 1e-6);
  return mono(cs.map((c) => c.x)) || mono(cs.map((c) => c.y));
}

/** 嘗試為 `gi`（或其包裝底下的畫）推出所有 IDS 構件的槽位。
 *
 *  **部分 IDS**（2026-10-13 追加）：字庫的 IDS 區段**只存得到有碼位的構件**
 *  （建庫條件是 `comp_cp IS NOT NULL`，見 `build-library.ts`），所以
 *  `麥 U+9EA5`（真 IDS 是 `⿱來&GT-K00207;`）只留下 `[來]` 一個。
 *  這時候「多出來的筆畫」就是那個沒有碼位的構件：它**不參與分組、也不給框**，
 *  我們只推有碼位那個構件的槽位——換的時候只拔掉它那幾筆、補一筆引用，
 *  其餘筆畫原樣不動。使用者的要求就是這個：
 *  「`䴺來去` 只是要將 `來` 換掉，底下的 `&GT-K00207;` 完全不動」。
 *
 *  閘門：`ids.length === 1`（只存到一個）或**剛好丟掉一個**（2～4 個裡有一個不在庫裡），
 *  而且**必須有殘筆**（`sumKnown < parent.length`）——沒有殘筆就不是這一類，走舊路。
 *  完整 IDS（2～4 個、全部有碼位）的行為與以前完全相同。
 */
export function solveIdsSlots(L: Library, gi: number, o: IdsSlotOptions = {}): IdsSolution | null {
  const drawing = drawingIdx(L, gi);
  if (hasOwnRefStroke(L, drawing)) return null;      // 已經是引用結構 → 交給原本的路
  const cp = codePointOf(L, drawing);
  const ids = cp ? L.comp?.get(cp) : undefined;
  if (!ids || ids.length < 1 || ids.length > 4) return null;
  const compIdx = ids.map((c) => indexOfCodePoint(L, c));
  const knownK: number[] = [];
  for (let k = 0; k < compIdx.length; k++) if (compIdx[k] !== undefined) knownK.push(k);
  if (knownK.length === 0) return null;
  const missing = compIdx.length - knownK.length;
  /* `relaxed`（重畫用）允許**任意數量**沒有碼位的分量；預設仍只允許一個（部分 IDS）。 */
  const partial = ids.length === 1 || missing === 1 || (o.relaxed === true && missing > 0);
  if (!partial && missing > 0) return null;          // 舊路徑：完整 IDS、2～4 個構件
  const comps = knownK.map((k) => flattenStrokes(L, drawingIdx(L, compIdx[k]!)));
  const parent = flattenStrokes(L, drawing);
  if (parent.length === 0 || parent.length > 16) return null;
  const counts = comps.map((f) => f.length);
  if (comps.some((f) => f.length === 0)) return null;
  const sumKnown = counts.reduce((a, b) => a + b, 0);
  /* 完整 IDS：每一筆都要有主。部分 IDS：**必須有殘筆**（那幾筆就是沒有碼位的那個構件）。 */
  if (partial ? sumKnown >= parent.length : sumKnown !== parent.length) return null;

  const solutions: { error: number; groups: number[][]; boxes: (SlotBox | null)[] }[] = [];
  let budget = IDS_SLOT_BUDGET;
  /** `pool`＝還沒被指派的筆畫索引、`ci`＝第幾個「有碼位」的構件、`known`＝已指派的組 */
  const walk = (pool: number[], ci: number, known: number[][]) => {
    if (budget-- <= 0) return;
    if (ci >= comps.length) {
      /* 依 IDS 順序排好；沒有碼位的那一格就是剩下的筆畫（放它在 IDS 裡的位置） */
      const groups: number[][] = [];
      const boxes: (SlotBox | null)[] = [];
      let worst = 0, unknownAt = -1, ki = 0;
      for (let k = 0; k < ids.length; k++) {
        if (compIdx[k] === undefined) { unknownAt = k; groups.push([...pool]); boxes.push(null); continue; }
        const grp = known[ki]!;
        const flat = grp.map((i) => parent[i]!);
        const box = deriveSlot(comps[ki]!, flat);
        if (!box) return;
        const err = slotError(comps[ki]!, flat, box);
        if (!Number.isFinite(err)) return;
        groups.push(grp);
        boxes.push(box);
        worst = Math.max(worst, err);
        ki++;
      }
      /* `ids.length === 1` 這種沒有「缺的那一格」，殘筆補在最後（＝ IDS 的第二個分量之後） */
      if (partial && unknownAt < 0) { groups.push([...pool]); boxes.push(null); }
      solutions.push({ error: worst, groups: groups.map((g) => [...g]), boxes });
      return;
    }
    const comp = comps[ci]!;
    const n = counts[ci]!;
    const combos: number[][] = [];
    const comb = (start: number, cur: number[]) => {
      if (cur.length === n) { combos.push([...cur]); return; }
      for (let i = start; i < pool.length; i++) { cur.push(pool[i]!); comb(i + 1, cur); cur.pop(); }
    };
    comb(0, []);
    for (const pick of combos) {
      if (kindSig(pick.map((i) => parent[i]!)) !== kindSig(comp)) continue;
      known.push(pick);
      walk(pool.filter((i) => !pick.includes(i)), ci + 1, known);
      known.pop();
    }
  };
  walk(parent.map((_, i) => i), 0, []);
  if (budget <= 0) return null;

  const ordered = solutions.filter((s) => idsOrderOk(s.groups, parent)).sort((a, b) => a.error - b.error);
  const best = ordered[0];
  const tol = o.tol ?? (partial ? IDS_SLOT_TOL_PARTIAL : IDS_SLOT_TOL);
  if (!best || best.error > tol) return null;
  // 框明顯不同、分數又差不多的次佳解 → 不猜（部分 IDS 的門檻另計，見上面的常數）
  const margin = o.margin ?? (partial ? IDS_PARTIAL_MARGIN : IDS_SLOT_MARGIN);
  if (o.forceBest !== true) {
    for (let k = 1; k < ordered.length; k++) {
      const alt = ordered[k]!;
      const distinct = alt.boxes.some((b, j) =>
        !!b && !!best.boxes[j] && b.some((v, q) => Math.abs(v - best.boxes[j]![q]!) > IDS_SLOT_DISTINCT));
      if (!distinct) continue;
      if (alt.error < best.error * margin) return null;
      break;
    }
  }
  return {
    drawing, error: best.error, partial,
    slots: best.groups.map((grp, k) => ({
      cp: k < ids.length ? ids[k] : undefined,
      index: k < ids.length ? compIdx[k] : undefined,
      box: best.boxes[k] ?? null,
      group: grp,
    })),
  };
}

/**
 * 引用樹裡找不到 `old` 時的第二條路：走同一棵樹，找「IDS 有這個構件」的字形，
 * 推出槽位後**只拔掉該構件的那幾筆、補一筆指向新內容的引用**（其餘筆畫不動）。
 */
function applyReplaceViaIds(
  L: Library, base: string, bi: number, old: string, oldCp: number,
  newIdx: number, newExpr: string, log: string[],
): SeqResult | null {
  const seen = new Set<number>();
  const stack = [bi];
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const g = L.glyphs[i];
    if (!g) continue;
    const sol = solveIdsSlots(L, i);
    /* `s.index === undefined`／`s.box === null`＝沒有碼位的那個構件（部分 IDS）：
       沒有字元可以指名它，也沒有框可以放新內容——它只是「剩下的筆畫」。 */
    const slot = sol?.slots.find((s) => s.index !== undefined && !!s.box && isVariantOfCp(L, s.index, oldCp));
    const box = slot?.box;
    if (sol && slot && box) {
      const { lib, glyphs } = fork(L);
      const src = glyphs[sol.drawing]!;
      const drop = new Set(slot.group);
      const strokes = src.strokes.filter((_, k) => !drop.has(k));
      strokes.push({
        kind: 99, width: 0, style: 0, points: box.slice(),
        ref: newIdx, box: box.slice(), stretch: [0, 0, 0, 0],
      });
      glyphs[sol.drawing] = { tight: computeTight(lib, sol.drawing), strokes };
      const boxText = box.map((v) => Math.round(v)).join(",");
      return {
        ok: true, lib, targetIdx: bi, substituted: true,
        log: [...log, `${base} 的 ${old} → ${newExpr}（槽位由 IDS 構件反推 [${boxText}]，誤差 ${sol.error.toFixed(1)}）`],
      };
    }
    for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  return null;
}

/** 在 idx 的引用樹中找「cp 家族」的槽位（只回報有沒有） */function findSlotIdx(L: Library, idx: number, cp: number): { parent: number; strokeIx: number } | null {
  const seen = new Set<number>();
  const stack = [idx];
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const g = L.glyphs[i];
    if (!g) continue;
    for (let si = 0; si < g.strokes.length; si++) {
      const s = g.strokes[si]!;
      if (s.kind === 99 && s.ref !== null && isVariantOfCp(L, s.ref, cp)) return { parent: i, strokeIx: si };
    }
    for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  return null;
}

/**
 * 在 `L` 的 `base` 引用樹中，把「舊部件」的槽位改指到 `newIdx`。
 *
 * **沿用該槽位的框與伸縮**——那是人工手調的資產（見 `format.md`「框與自由組字」），
 * 這樣替換者佔用同一版面關係，不需要第二套幾何。
 * 這也是 `composeFit` 第一步「先試完全沿用舊框」的同一原則，
 * 但這裡的「新部件」可能是自訂字形（巢狀結果或串接結果），沒有字元可用，
 * 所以不能直接呼叫 `composeFit`。
 */
function applyReplace(
  L: Library, base: string, old: string, newIdx: number, newExpr: string, log: string[],
  useBand = true,
): SeqResult {
  const bi = idxOf(L, base);
  if (bi === undefined) return { ok: false, error: `基字「${base}」不在字形庫中` };

  const oldCp = old.codePointAt(0)!;
  const seen = new Set<number>();
  const stack = [bi];
  let found: { parent: number; strokeIx: number } | null = null;
  while (stack.length && !found) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const g = L.glyphs[i]!;
    for (let si = 0; si < g.strokes.length; si++) {
      const s = g.strokes[si]!;
      if (s.kind === 99 && s.ref !== null && isVariantOfCp(L, s.ref, oldCp)) {
        found = { parent: i, strokeIx: si };
        break;
      }
    }
    if (!found) for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  if (!found) {
    // 引用樹裡沒有——再試一次「IDS 槽位推斷」：`幸` 這類字形是畫成筆畫的，
    // 但 IDS 記了構件（土＋𢆉），槽位可以從筆畫反推出來（見 applyReplaceViaIds）。
    const viaIds = applyReplaceViaIds(L, base, bi, old, oldCp, newIdx, newExpr, log);
    if (viaIds) return viaIds;
    return { ok: false, error: `基字「${base}」的結構中找不到部件「${old}」` };
  }

  const { lib, glyphs } = fork(L);
  const parent0 = glyphs[found.parent]!;
  const oldStroke = parent0.strokes[found.strokeIx]!;

  const setBox = (box: number[]) => {
    const p = glyphs[found.parent]!;
    const st = p.strokes[found.strokeIx]!;
    const ss = p.strokes.slice();
    ss[found.strokeIx] = { ...st, ref: newIdx, box, stretch: [0, 0, 0, 0] };
    glyphs[found.parent] = { tight: p.tight, strokes: ss };
  };

  // 先沿用原框（框是人工資產）……
  const oldInk = inkOfRefInParent(L, found.parent, found.strokeIx);
  setBox(oldStroke.box!.slice());
  let placed = "沿用原框";
  const trialInk = inkOfRefInParent(lib, found.parent, found.strokeIx);

  // ……新舊墨跡差很多時，沿用框會把新內容拉成太大／太小（`街圭舞` 的 舞 比 `衚胡舞`
  // 寬 46%，還壓到 亍）——這時改成把新內容的墨跡對到舊部件的墨跡上，大小不變。
  const aligned = inkAlignedBox(lib, newIdx, oldInk, trialInk, useBand);
  if (aligned) {
    setBox(aligned);
    placed = `墨跡對齊到框[${aligned.map((v) => Math.round(v)).join(",")}]`;
  } else {
    // ……否則再看新內容會不會壓到同層的兄弟，會的話就讓位。
    // 這條規則與 `compose-fit.ts` 的 `composeFit` 共用同一份實作，
    // 兩條路徑（`︵…︶` 遞歸讀法 vs 檢視頁的成對讀法）才會得到同一個版面。
    const band = useBand
      ? refitBand(lib, found.parent, found.strokeIx, oldStroke.box!, trialInk, oldInk)
      : null;
    if (band) {
      setBox(band);
      placed = `讓位到框[${band.join(",")}]（沿用原框會壓到同層的兄弟）`;
    }
  }

  return {
    ok: true, lib, targetIdx: bi, substituted: true,
    log: [...log, `${base} 的 ${old} → ${newExpr}（${placed}）`],
  };
}

/**
 * `applyReplace()` 的**乾跑**：只回答「`baseIdx` 這個字裡換得動 `oldCp` 這個構件嗎」，
 * 不 fork 整個庫、也不產生任何字形。
 *
 * 為什麼要有這一支：頁面的「部件清單」必須**事先**知道哪幾格點下去有結果。
 * 換不動的格子如果照樣可以點，使用者就會走進「選了卻永遠換不掉」的死路
 * （使用者回報：輸入 `䴺` 之後點清單裡的 `來`，得到 `䴺來`，再打 `去` 變成 `䴺來去`
 * ——引擎說換不到，因為 `來` 是 `麥` 的 IDS 構件，而 `麥` 的 IDS 只有 `來` 一個
 * （另一半是 `&GT-K00207;` 這種沒有碼位的名字），槽位反推不出來）。
 *
 * 走法必須與 `applyReplace()` ＋ `applyReplaceViaIds()` **完全一致**，
 * 否則會出現「清單說可以、真的做卻失敗」（或反過來）的地獄。
 */
export function canReplaceCp(L: Library, baseIdx: number, oldCp: number): boolean {
  const seen = new Set<number>();
  const stack = [baseIdx];
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const g = L.glyphs[i];
    if (!g) continue;
    const sol = solveIdsSlots(L, i);                       // 與 applyReplaceViaIds 同一條
    if (sol?.slots.some((s) => s.index !== undefined && isVariantOfCp(L, s.index, oldCp))) return true;
    for (const s of g.strokes) {
      if (s.kind !== 99 || s.ref === null) continue;
      if (isVariantOfCp(L, s.ref, oldCp)) return true;
      stack.push(s.ref);
    }
  }
  return false;
}

// ------------------------------------------------------------------ 缺口一

export interface Replaceable {
  /** 在庫中的字形索引（畫預覽用） */
  idx: number;
  /** 字形名（如 u884c-05），供除錯與顯示 */
  name: string;
  /** 這個部件對應的 Unicode 字元（可能是它的來源字，如 行 來自 u884c） */
  ch: string;
  /** 層級：1 = 基字的直接部件，2 = 再下一級… */
  level: number;
  /** 出現次數（同一個部件可能在樹中出現多次） */
  count: number;
}

/**
 * 列出一個字**所有可替換的部件**（含每一級）——提案第 2 條的心臟。
 *
 * 施工單 §四 缺口一說這個函式不存在。做法：遞迴走 99 引用樹，
 * 收集每個引用節點連同層級，以字形索引去重。
 *
 * 注意這裡**只收集引用節點**（kind 99）。像 `彳`（u5f73-01）這種
 * 已經被展開成筆畫的部件，雖然畫面上是「行」的一部分，卻不是獨立的引用節點，
 * 所以換不掉它——那是「部件階層不完整」的問題，要用「整棵子樹重畫」解決，
 * 不在 MVP 範圍（見 `自由組字編輯器-可行性研究.md` §2.1）。
 */
export function listReplaceables(L: Library, baseIdx: number): Replaceable[] {
  const out = new Map<number, Replaceable>();
  const walk = (idx: number, level: number, seen: Set<number>): void => {
    if (level > 12 || seen.has(idx)) return;
    const g = L.glyphs[idx];
    if (!g) return;
    const next = new Set(seen);
    next.add(idx);
    for (const s of g.strokes) {
      if (s.kind !== 99 || s.ref === null) continue;
      const name = displayName(L, s.ref);
      const ch = charOf(L, s.ref);
      const prev = out.get(s.ref);
      if (prev) prev.count++;
      else if (ch) {
        out.set(s.ref, { idx: s.ref, name, ch, level, count: 1 });
      }
      walk(s.ref, level + 1, next);
    }
  };
  walk(baseIdx, 1, new Set());
  // 排序：層級（大部件在前）→ 出現次數 → 名字
  return [...out.values()].sort(
    (a, b) => a.level - b.level || b.count - a.count || (a.name < b.name ? -1 : 1),
  );
}

// ------------------------------------------------------------------ 內文解析

export interface SeqHit {
  kind: "seq";
  /** 在原文中的起訖（不含定界符） */
  start: number;
  end: number;
  /** 定界符整段的起訖（含） */
  fullStart: number;
  fullEnd: number;
  expr: string;
  result: SeqResult;
}
export interface TextHit {
  kind: "text";
  start: number;
  end: number;
  text: string;
}
export type Segment = TextHit | SeqHit;

/**
 * 掃描一段文字，切出「純文字」與「構形序列」。
 *
 * 掃描是從左到右的：遇到第一個 `︵` 就往下找 `︶`（且不跨行），
 * 中間的內容通過三條護欄才當成序列，否則整段（含括號）當純文字。
 */
export function scanText(L: Library, text: string, o: SeqOptions = {}): Segment[] {
  const segs: Segment[] = [];
  let i = 0;
  let textStart = 0;
  const flushText = (to: number) => {
    if (to > textStart) segs.push({ kind: "text", start: textStart, end: to, text: text.slice(textStart, to) });
  };
  while (i < text.length) {
    if (text[i] !== OPEN) { i++; continue; }
    const close = text.indexOf(CLOSE, i + 1);
    // 護欄 1 + 2：必須成對、且不跨行
    if (close < 0 || text.slice(i + 1, close).includes("\n")) { i++; continue; }
    const expr = text.slice(i + 1, close);
    const parts = Array.from(expr);
    // 護欄 3：長度上限
    if (parts.length < 3 || parts.length > MAX_PARTS) { i++; continue; }
    const result = evalSeq(L, expr, o);
    flushText(i);
    segs.push({
      kind: "seq", start: i + 1, end: close, fullStart: i, fullEnd: close + 1, expr, result,
    });
    textStart = close + 1;
    i = close + 1;
  }
  flushText(text.length);
  return segs;
}

// ------------------------------------------------------------------ 內嵌渲染

const SVG_CACHE_MAX = 512;

/**
 * 內嵌 SVG 的渲染器。
 *
 * 把組出來的字形做成 `<svg>` 元素，關鍵 CSS 三條：
 *   `fill: currentColor`（顏色跟隨旁邊的字）
 *   `width: 1em; height: 1em`（大小跟隨旁邊的字）
 *   `vertical-align: -0.1em`（基線對齊）
 *
 * generateSVG 固定輸出 `fill="black"`，深色主題下會與背景同色 → 這裡覆寫成
 * `currentColor`。這與 `build-kage-viewer.ts` 的卡片做法一致。
 *
 * 快取：同一頁裡同樣的序列常常重複出現，而 makeGlyph 是整條路最貴的一步
 * （`format.md`：完整外框生成 14,094 字/秒）。
 */
export function createSvgRenderer(L: Library) {
  const cache = new Map<string, string | null>();

  /** 只有這一份 makeGlyph 路徑：庫＋根索引 → 內嵌 SVG 字串 */
  function build(lib: Library, idx: number): string {
    ensureEngine();   // 瀏覽器端是 no-op（引擎已內嵌）；Node 端會 lazy 載入
    const kage = new (globalThis as any).Kage();
    const seen = new Set<number>();
    const stack = [idx];
    while (stack.length) {
      const i = stack.pop()!;
      if (seen.has(i)) continue;
      seen.add(i);
      const g = lib.glyphs[i]!;
      kage.kBuhin.push(keyOfIdx(lib, i), toKageData(g, lib));
      for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
    }
    const polys = new (globalThis as any).Polygons();
    kage.makeGlyph(polys, keyOfIdx(lib, idx));
    return normalizeSvg(polys.generateSVG(true))
      // generateSVG 固定 fill="black"；深色主題下會與背景同色 → 改為 currentColor
      .replace(/fill="black"/g, 'fill="currentColor"')
      // class 給 CSS 上「顏色／大小／基線」三條
      .replace(/<svg\b/, '<svg class="gc-inline"');
  }

  function memo(key: string, make: () => string): string | null {
    if (cache.has(key)) return cache.get(key)!;
    let v: string | null = null;
    try { v = make(); } catch { v = null; }
    if (cache.size > SVG_CACHE_MAX) cache.clear();
    cache.set(key, v);
    return v;
  }

  /** 取（或建）某個索引的內嵌 SVG 字串 */
  function svgOfIdx(idx: number): string | null {
    return memo("#" + idx, () => build(L, idx));
  }

  /** 取一個「求值結果」（單字或組字）的內嵌 SVG 字串 */
  function svgForResult(r: SeqResult): string | null {
    if (!r.ok) return null;
    // 組字結果是「另一個庫」——快取鍵除了索引還要含序列表現，否則不同序列會撞鍵。
    const key = r.substituted ? "seq:" + r.log.join("|") : "#" + r.targetIdx;
    return memo(key, () => build(r.lib, r.targetIdx));
  }

  /** 直接給一個構形序列（含 ︵︶ 掃描時的選項） */
  function svgOfSeq(expr: string, o: SeqOptions = {}): { svg: string | null; result: SeqResult } {
    const r = evalSeq(L, expr, o);
    return { svg: svgForResult(r), result: r };
  }

  return { svgOfIdx, svgForResult, svgOfSeq, clear: () => cache.clear() };
}

// ------------------------------------------------------------------ 缺口三·前置

export interface FittingPart extends Replaceable {
  /**
   * 把這個部件換上去時，`composeFit` 會用到的縮放倍率。
   *   1    ＝ 沿用原框（保真度最好，看起來就像本來就長這樣）
   *   <1   ＝ 放不下、會被等比縮小；**縮得越多越醜**（提案說「行舞不好看」）
   *   null ＝ 換不成（例如槽位不存在）
   */
  scale: number | null;
}

/**
 * 列出可替換部件，並**逐一實測**換上去的縮放倍率。
 *
 * 這是「部件選擇體驗」的關鍵（施工單 §四 缺口一的難點在排序）：
 * 光有清單不夠，還要讓使用者一眼看出**哪個換上去不會被縮**。
 * 實測發現 `scale` 是唯一可靠的客觀訊號——長寬比、周長、墨跡覆蓋率都試過，
 * 對 CJK 部件全都失效（每個部件都是滿格，見 `tools/good-cases.ts` 的註解）。
 *
 * 「換上去會不會好看」只對 L1 有意義：L2/L3 的槽位一定比較小，換什麼都會縮。
 *
 * 成本：每個候選跑一次 `composeFit`（含 makeGlyph 量測）。部件數通常 ≤ 6、
 * 候選池 30，所以單次約 100~200 次量測。UI 端應該**延後執行**。
 */
export function listFittingReplaceables(
  L: Library, baseIdx: number, baseCh: string, pool: string[] = DEFAULT_POOL,
): FittingPart[] {
  return listReplaceables(L, baseIdx).map((r) => {
    if (r.level !== 1) return { ...r, scale: null };
    let best: number | null = null;
    for (const nw of pool) {
      if (nw === r.ch || nw === baseCh) continue;
      const got = composeFit(L, baseCh, [[r.ch, nw]]);
      if ("error" in got) continue;
      const sc = got.steps[0]?.scale;
      if (sc === undefined) continue;
      if (best === null || sc > best) best = sc;
    }
    return { ...r, scale: best };
  });
}

/** 預設候選池：常用、且都是滿格（換上去才比得出高下）的部件 */
export const DEFAULT_POOL = [
  "日", "月", "口", "木", "水", "火", "土", "金", "人", "大", "小", "山", "川", "石", "田",
  "力", "刀", "手", "心", "目", "耳", "白", "玉", "禾", "虫", "貝", "車", "門", "雨", "風",
];

// ------------------------------------------------------------------ 按部件位置搜尋

/**
 * 部件在字裡的區位。
 *
 * 九宮格（上左／上／上右／左／中／右／下左／下／下右）加「滿」。
 * 「滿」＝與兄弟兩軸都大幅重疊（疊置或包圍）；「中」＝在正中央。
 */
export type SlotZone =
  | "上左" | "上" | "上右"
  | "左" | "中" | "右"
  | "下左" | "下" | "下右"
  | "滿";

/** 對外（UI／CLI）用的簡化位置：只看主要方向 */
export type SlotPos = "左" | "右" | "上" | "下" | "中" | "滿";

/** 把九宮格區位收斂成主要方向（給搜尋用） */
export function mainDirection(z: SlotZone): SlotPos {
  if (z === "滿") return "滿";
  if (z === "中") return "中";
  if (z.includes("左")) return "左";
  if (z.includes("右")) return "右";
  if (z.includes("上")) return "上";
  if (z.includes("下")) return "下";
  return "中";
}

/**
 * **精確**的位置判定：量「這個引用實際畫出來的墨跡」，再跟兄弟的墨跡比。
 *
 * 為什麼非量不可：引用框是畫板座標，判不出左右（見 `layoutOf` 的註解）。
 * 墨跡一量就準——實測：
 *   `難` → 左 58.8、右 142.4（左右結構）
 *   `集` → 上 70.3、下 150.6（上下結構）
 *   `想` → 目在上右(143.9,74.4)、心在下(99.3,150.8)
 *
 * 成本：每個引用一次 `makeGlyph`。所以搜尋時**先用引用樹便宜篩候選，
 * 再對候選量墨跡**，不要對全庫量。
 *
 * @param inkOfRef 由呼叫端注入 `inkOfRefInParent`（避免 free-compose 相依 compose-fit 的引擎細節）
 */
export function inkZoneOf(
  L: Library, parent: number, strokeIx: number,
  inkOfRef: (L: Library, parent: number, strokeIx: number) => { x1: number; y1: number; x2: number; y2: number },
): SlotZone {
  const g = L.glyphs[parent];
  if (!g) return "滿";
  const idxs: number[] = [];
  g.strokes.forEach((s, i) => { if (s.kind === 99 && s.ref !== null) idxs.push(i); });
  if (idxs.length <= 1) return "滿";
  const inks = idxs.map((i) => inkOfRef(L, parent, i));
  const mine = inkOfRef(L, parent, strokeIx);
  const x1 = Math.min(...inks.map((b) => b.x1));
  const x2 = Math.max(...inks.map((b) => b.x2));
  const y1 = Math.min(...inks.map((b) => b.y1));
  const y2 = Math.max(...inks.map((b) => b.y2));
  const uw = Math.max(1, x2 - x1), uh = Math.max(1, y2 - y1);
  const cx = ((mine.x1 + mine.x2) / 2 - x1) / uw;
  const cy = ((mine.y1 + mine.y2) / 2 - y1) / uh;
  const mw = (mine.x2 - mine.x1) / uw, mh = (mine.y2 - mine.y1) / uh;

  /* 門檻用 0.40/0.60，不是課本的 1/3、2/3。
     1/3、2/3 太緊：像 休（亻+木）、沐（氵+木）、析（木+斤）這種
     「左窄右寬」的組合，右半的 cx 只有 0.63～0.65，差一點點過不了 2/3，
     就被歸成「中」——於是「木在右邊」幾乎查不到東西。
     全庫量 173,298 個引用（`tools/probe-zone-threshold.ts`）：
       1/3、2/3   → 左 43,399／右 29,697（嚴重不對稱；部件沒理由偏好在左邊）
       0.40/0.60  → 左 43,888／右 47,806（接近對稱）
     中／滿也從 33,017 降到 9,386——真的橫跨中間的才留得下來。 */
  const vert: "上" | "下" | "" = cy < 0.4 ? "上" : cy > 0.6 ? "下" : "";
  const horz: "左" | "右" | "" = cx < 0.4 ? "左" : cx > 0.6 ? "右" : "";
  if (vert || horz) {
    if (vert && horz) return (vert + horz) as SlotZone;
    return (vert || horz) as SlotZone;
  }
  // 兩軸都在中間：兩軸都佔很大 → 滿；否則算中
  if (mw > 0.8 && mh > 0.8) return "滿";
  return "中";
}

/** 搜尋時用的寬鬆比對：查「左」也要能找到「上左」 */
export function zoneMatches(z: SlotZone, want: SlotPos): boolean {
  if (want === "滿") return z === "滿";
  if (want === "左") return z.includes("左");
  if (want === "右") return z.includes("右");
  if (want === "上") return z.includes("上");
  if (want === "下") return z.includes("下");
  if (want === "中") return z === "中";
  return false;
}

/** 一個引用節點在父字中的位置 */
export interface RefSlot {
  /** 父字在庫中的索引 */
  parent: number;
  parentName: string;
  /** 該引用所指的字形索引（可能是變體） */
  ref: number;
  refName: string;
  /** 引用所指的碼位字元（如 隹、集） */
  ch: string;
  box: [number, number, number, number];
  /** 這個引用在父字 strokes 裡的索引（量墨跡要用） */
  strokeIx: number;
  zone: SlotZone;
  /** 該引用框佔父字聯集的面積比例（0..1 以上，因為框會溢出） */
  area: number;
  /**
   * 這筆命中是 **IDS 補的部件**（GlyphWiki 把它畫成原始筆劃、沒有引用框）。
   * 這種命中 `box` 是假的滿格框、`strokeIx` 是 -1、`zone` 是「滿」——
   * **不要拿它去量方位或面積**。查位置時這種命中會被直接跳過。
   */
  idsOnly?: boolean;
}

/**
 * 依「引用框」粗判版面 —— **不可靠，只在需要便宜篩選時用**。
 *
 * 實測結論（別再走一次這條路）：KAGE 的引用框是**畫板座標**，不是版面座標。
 * 同一個字身裡的框幾乎都佔滿整格、互相大幅重疊，所以：
 *   `難` 的兩個框 [0,0,210,200] 與 [30,0,199,200]（實際是左右結構）
 *   `集` 的兩個框 [1,1,199,194] 與 [0,50,200,197]（實際是上下結構）
 * 拿框去切九宮格、比面積、比聯集，**全部都會得到「滿／中」**。
 * 要精確的位置必須**量墨跡**（見 `inkZoneOf`）。
 */
export function layoutOf(boxes: number[][]): { x: boolean; y: boolean } {
  const n = boxes.length;
  if (n < 2) return { x: false, y: false };
  let sumW = 0, sumH = 0;
  for (const b of boxes) {
    sumW += Math.abs(b[2]! - b[0]!);
    sumH += Math.abs(b[3]! - b[1]!);
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b[0]!, b[2]!); maxX = Math.max(maxX, b[0]!, b[2]!);
    minY = Math.min(minY, b[1]!, b[3]!); maxY = Math.max(maxY, b[1]!, b[3]!);
  }
  const unionW = Math.max(1, maxX - minX);
  const unionH = Math.max(1, maxY - minY);
  // 平均框寬 ÷ 聯集寬：接近 1 表示「大家都佔滿寬度」
  const wRatio = (sumW / n) / unionW;
  const hRatio = (sumH / n) / unionH;
  return {
    x: wRatio < 0.75,   // 有左右分開
    y: hRatio < 0.75,   // 有上下分開
  };
}

export function slotPosOf(box: number[], siblings?: number[][]): SlotZone {
  const b = box as [number, number, number, number];
  const bx1 = Math.min(b[0], b[2]), bx2 = Math.max(b[0], b[2]);
  const by1 = Math.min(b[1], b[3]), by2 = Math.max(b[1], b[3]);
  const sib = (siblings ?? []).filter((s) => s && s.length === 4);
  if (sib.length <= 1) return "滿";
  const layout = layoutOf(sib);
  let ux1 = bx1, ux2 = bx2, uy1 = by1, uy2 = by2;
  for (const s of sib) {
    ux1 = Math.min(ux1, s[0]!, s[2]!); ux2 = Math.max(ux2, s[0]!, s[2]!);
    uy1 = Math.min(uy1, s[1]!, s[3]!); uy2 = Math.max(uy2, s[1]!, s[3]!);
  }
  const uw = Math.max(1, ux2 - ux1), uh = Math.max(1, uy2 - uy1);
  const cx = ((bx1 + bx2) / 2 - ux1) / uw;
  const cy = ((by1 + by2) / 2 - uy1) / uh;

  const vert: "上" | "下" | "" = cy < 1 / 3 ? "上" : cy > 2 / 3 ? "下" : "";
  const horz: "左" | "右" | "" = cx < 1 / 3 ? "左" : cx > 2 / 3 ? "右" : "";

  if (layout.x && layout.y) {
    if (vert && horz) return (vert + horz) as SlotZone;
    if (vert) return vert;
    if (horz) return horz;
    return "中";
  }
  if (layout.x) return cx < 0.5 ? "左" : "右";
  if (layout.y) return cy < 0.5 ? "上" : "下";
  // 兩軸都大幅重疊：疊置或包圍
  const bw = bx2 - bx1, bh = by2 - by1;
  if (bw >= uw * 0.85 && bh >= uh * 0.85) return "滿";
  return "中";
}

/** 一個字形的所有引用節點（含位置判定） */
export function refSlotsOf(L: Library, parent: number): RefSlot[] {
  const g = L.glyphs[parent];
  if (!g) return [];
  const all = g.strokes.filter((s) => s.kind === 99 && s.ref !== null && s.box)
    .map((s) => s.box as number[]);
  const out: RefSlot[] = [];
  g.strokes.forEach((s, strokeIx) => {
    if (s.kind !== 99 || s.ref === null || !s.box) return;
    const b = s.box as [number, number, number, number];
    out.push({
      parent,
      parentName: displayName(L, parent),
      ref: s.ref,
      refName: displayName(L, s.ref),
      ch: charOf(L, s.ref) ?? "?",
      box: b,
      zone: slotPosOf(b, all),
      strokeIx,
      area: (Math.abs(b[2] - b[0]) * Math.abs(b[3] - b[1])) /
            Math.max(1, (function () {
              let x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity;
              for (const q of all) {
                x1 = Math.min(x1, q[0]!, q[2]!); x2 = Math.max(x2, q[0]!, q[2]!);
                y1 = Math.min(y1, q[1]!, q[3]!); y2 = Math.max(y2, q[1]!, q[3]!);
              }
              return (x2 - x1) * (y2 - y1);
            })()),
    });
  });
  return out;
}

export interface SlotHit extends RefSlot {
  /** 這個引用是在第幾層被找到的（1 ＝ 父字直接引用） */
  level: number;
}

/**
 * 搜尋「哪個字裡有這個部件、而且在那個位置」——師父要的功能。
 *
 * 例：searchByComponent(lib, { ch: "隹", pos: "左" }) → 所有「隹在左邊」的字。
 *
 * 走訪方式（踩過坑之後定下來的）：
 *   * 對每個碼位字，遞迴走它的引用樹，**記錄到達每個節點的最淺層級**。
 *   * 命中時回報「實際裝著這個部件的那個字形」（container），
 *     連帶它的框與墨跡位置——不是回報最外層的字。
 *     先前回報最外層的字，結果同一筆在 L1/L2/L3 各印一次，
 *     而且框是外層的框（`羅` 的隹會顯示成 `羅` 自己的框），完全誤導。
 *   * 每個容器只回報一次（取最淺層級）。
 *
 * @param opt.ch     部件字元（如 隹）。會連同它的變體一起算（u96b9、u96b9-02…）
 * @param opt.pos    位置（左／右／上／下／中／滿）；undefined ＝ 不限
 * @param opt.level  走訪到第幾層（1 ＝ 只看直接引用；3 ＝ 連 羅→維→隹 這種也看）
 * @param opt.onlyIdeographs 只看 uXXXX 形式的碼位字（排除 cdp-*、ᄀ 這類內部部件）
 */
export function searchByComponent(
  L: Library,
  opt: { ch?: string; pos?: SlotPos; level?: number; onlyIdeographs?: boolean;
         limit?: number; minArea?: number; maxArea?: number;
         /** 精確模式：量墨跡判定位置（慢但準）。預設 true。 */
         exact?: boolean;
         /** 精確模式要用的墨跡量測（由呼叫端注入 compose-fit 的 inkOfRefInParent） */
         inkOfRef?: (L: Library, parent: number, strokeIx: number) =>
           { x1: number; y1: number; x2: number; y2: number } },
): SlotHit[] {
  const exact = opt.exact !== false && typeof opt.inkOfRef === "function";
  const wantCp = opt.ch ? opt.ch.codePointAt(0)! : null;
  const maxLevel = opt.level ?? 1;
  const limit = opt.limit ?? 200;
  const out: SlotHit[] = [];

  for (let i = 0; i < L.glyphs.length; i++) {
    const nm = displayName(L, i);
    // 「只看一般漢字」＝不把 cdp-*、u2ff0-… 這種合成命名掃進來
    if (opt.onlyIdeographs !== false && !isPlainIdeograph(L, i)) continue;
    // 每個容器只留最淺的一次
    const best = new Map<string, SlotHit>();
    const deepest = new Map<number, number>();   // idx → 已用過的最淺層級
    const walk = (idx: number, level: number, visited: Set<number>): void => {
      if (level > maxLevel || visited.has(idx)) return;
      const prev = deepest.get(idx);
      if (prev !== undefined && prev <= level) return;
      deepest.set(idx, level);
      const next = new Set(visited);
      next.add(idx);
      const covered = new Set<number>();       // 這一層已經由 KAGE 引用涵蓋的碼位
      for (const s of refSlotsOf(L, idx)) {
        const rc = codePointOf(L, s.ref);
        if (rc != null) covered.add(rc);
        const isHit = wantCp === null || isVariantOfCp(L, s.ref, wantCp);
        if (isHit) {
          const zone = exact ? inkZoneOf(L, idx, s.strokeIx, opt.inkOfRef!) : s.zone;
          if (!opt.pos || zoneMatches(zone, opt.pos)) {
            if ((opt.minArea === undefined || s.area >= opt.minArea) &&
                (opt.maxArea === undefined || s.area <= opt.maxArea)) {
              const key = s.refName + ":" + s.box.join(",");
              if (!best.has(key)) best.set(key, { ...s, zone, level });
            }
          }
        }
        walk(s.ref, level + 1, next);
      }
      /* **IDS 補的部件**：GlyphWiki 有些字把部件畫成原始筆劃而不是引用
         （杏 = ⿱木口，`u674f-j` 卻只有「口」一個引用；林 0 個引用），
         只走 KAGE 引用永遠找不到。字庫 v3 的 `L.comp` 帶著這份分解。
         這種命中**沒有引用框**，所以量不到方位——查位置時直接跳過，
         而不是給一個假的方法。 */
      const cpIdx = codePointOf(L, idx);
      const ids = cpIdx != null ? L.comp?.get(cpIdx) : undefined;
      if (ids) {
        for (const c of ids) {
          if (covered.has(c)) continue;
          const ci = indexOfCodePoint(L, c);
          if (ci === undefined) continue;
          if (wantCp !== null && !isVariantOfCp(L, ci, wantCp)) continue;
          if (opt.pos) continue;               // IDS 命中沒有引用框，方位無從判定
          const nm2 = displayName(L, ci);
          const key = nm2 + ":#ids";
          if (!best.has(key)) {
            best.set(key, {
              parent: idx, parentName: displayName(L, idx),
              ref: ci, refName: nm2, ch: String.fromCodePoint(c),
              box: [0, 0, 200, 200], strokeIx: -1, zone: "滿" as SlotZone,
              area: 1, level, idsOnly: true,
            });
          }
          walk(ci, level + 1, next);
        }
      }
    };
    walk(i, 1, new Set());
    if (best.size) {
      const arr = [...best.values()].sort((a, b) => a.level - b.level || b.area - a.area);
      for (const h of arr) {
        out.push({ ...h, parent: i, parentName: nm });
        if (out.length >= limit) break;
      }
    }
    if (out.length >= limit) break;
  }
  // 排序：層級淺的優先（直接部件比躲在深處的重要），再比面積
  out.sort((a, b) => a.level - b.level || b.area - a.area ||
    a.parentName.localeCompare(b.parentName));
  return out.slice(0, limit);
}

export interface ComponentStat {
  ch: string;
  name: string;
  count: number;
  positions: Partial<Record<SlotZone, number>>;
}

/** 反過來：列出某個字的直接子部件與位置（給 UI 的候選清單用） */
export function describeSlots(L: Library, idx: number): RefSlot[] {
  return refSlotsOf(L, idx);
}

/**
 * 統計「所有部件的使用情況」——搜尋介面要先有這份索引。
 * 只算 L1（父字的直接引用），因為使用者要的是「這個部件在字裡的位置」。
 */
export function componentIndex(L: Library, onlyIdeographs = true): Map<string, ComponentStat> {
  const map = new Map<string, ComponentStat>();
  for (let i = 0; i < L.glyphs.length; i++) {
    if (onlyIdeographs && !isPlainIdeograph(L, i)) continue;
    for (const s of refSlotsOf(L, i)) {
      const key = s.ch;
      let st = map.get(key);
      if (!st) { st = { ch: key, name: s.refName, count: 0, positions: {} }; map.set(key, st); }
      st.count++;
      st.positions[s.zone] = (st.positions[s.zone] ?? 0) + 1;
    }
  }
  return map;
}

// ------------------------------------------------------------------ 新建槽位組字

export type Layout = "⿰" | "⿱" | "⿴";

/**
 * 依「版面運算子」算出每個部件的引用框。
 *
 * 這是 composeFit 缺的那一半：composeFit 只能**替換既有槽位**，
 * 而 `⿰隹從` 這種「庫裡沒有現成字」的組合需要**先造一個含槽位的字形**。
 *
 * 框的規則是本專案實測出來的（見 compose-fit.ts 的註解）：
 * 引用框 [bx1,by1,bx2,by2] 會把子字形的緊框等比縮放置中到該矩形。
 * 所以「左右各半」＝ [0,0,100,200] 與 [100,0,200,200]。
 */
export function layoutBoxes(kind: Layout, n: number): [number, number, number, number][] {
  if (kind === "⿰") {
    const w = 200 / n;
    return Array.from({ length: n }, (_, i) =>
      [Math.round(i * w), 0, Math.round((i + 1) * w), 200] as [number, number, number, number]);
  }
  if (kind === "⿱") {
    const h = 200 / n;
    return Array.from({ length: n }, (_, i) =>
      [0, Math.round(i * h), 200, Math.round((i + 1) * h)] as [number, number, number, number]);
  }
  // ⿴ 包圍：第 1 件滿格（外框），其餘疊在中央
  return Array.from({ length: n }, (_, i) =>
    (i === 0 ? [0, 0, 200, 200] : [30, 30, 170, 170]) as [number, number, number, number]);
}

export interface Assembly {
  ok: true;
  lib: Library;
  idx: number;
  /** 新字形的名字（`__asm…`，不會與真實字形撞名） */
  name: string;
  log: string[];
}

/**
 * 用「版面運算子 ＋ 部件」造一個新字形，插進庫尾。
 *
 * 這是解決「𩀨 不在庫中」的關鍵一步：
 *   𩀨 ＝ ⿰隹從  →  assemble(lib, "⿰", ["隹", "從"])
 * 造出來的字形有正常的引用框，所以**可以再被 composeFit 當成替換目標**——
 * 也就是說它與庫裡既有的字地位相同，能直接餵進構形序列。
 */
export function assembleGlyph(L: Library, kind: Layout, chars: string[]): Assembly | { ok: false; error: string } {
  if (!chars.length) return { ok: false, error: "沒有部件" };
  const { lib, glyphs } = fork(L);
  const idxs: number[] = [];
  for (const c of chars) {
    const i = idxOf(lib, c);
    if (i === undefined) return { ok: false, error: `部件「${c}」不在字形庫中` };
    idxs.push(i);
  }
  const boxes = layoutBoxes(kind, idxs.length);
  const strokes: Stroke[] = idxs.map((ref, k) => ({
    kind: 99, width: 0, style: 0, points: boxes[k]!.slice(),
    ref, box: boxes[k]!, stretch: [0, 0, 0, 0],
  }));
  const idx = appendSynthetic(lib, glyphs, strokes, "asm");
  const name = lib.names ? lib.names[idx]! : keyOf(idx);
  return { ok: true, lib, idx, name, log: [`${kind} ${chars.join("")}（新建字形 ${name}）`] };
}

export interface AssembledResult {
  ok: true;
  lib: Library;
  idx: number;
  log: string[];
}

/**
 * 「庫裡沒有這個字」時的全套流程：**先造、再用**。
 *
 * 把構形序列裡的某個「不在庫中」的目標，先用 IDS／版面運算子造出來，
 * 插進庫尾，然後照原本的替換流程餵給 `applyReplace`。
 *
 * 例：`邏羅寶貝𩀨…` 需要 𩀨，而 𩀨 ＝ ⿰隹從（IDS 資料庫），於是：
 *   1. `assembleGlyph(lib, "⿰", ["隹","從"])` → 得到一個臨時字形
 *   2. 把 貝 的槽位指到它
 */
export function composeWithNewGlyph(
  L: Library, kind: Layout, parts: string[],
): AssembledResult | { ok: false; error: string } {
  const asm = assembleGlyph(L, kind, parts);
  if (!asm.ok) return asm;
  return { ok: true, lib: asm.lib, idx: asm.idx, log: asm.log };
}

// ------------------------------------------------------------------ 品質把關

/**
 * 組字品質（施工單 §四 缺口三）：跨部件筆劃最短距離，0 ＝ 相交。
 *
 * **必須比較「增量」，不能看絕對值**——`format.md` 的「筆劃重疊檢查的分組原則」
 * 已經寫過：3000 字樣本中門檻 6 就有 8.9% 的字本來就有跨部件筆觸相接
 * （KAGE 拆連筆所致）。實測 `寶` 自己的基線就是 0.7，
 * 而**已知良好**的 `寶缶支` 也是 0.7——若拿絕對門檻去擋，會把好結果一起擋掉。
 *
 * 所以這裡的判準是：結果比原字**明顯變差**（預設 0.5 格以上）才算警示。
 */
export const WARN_ABS = 2;
export const WARN_DELTA = 0.5;

export interface QualityReport {
  /** 結果的跨部件最短距離（Infinity ＝ 沒有成對部件可比） */
  dist: number;
  /** 原字（基字）的跨部件最短距離 */
  baseDist: number;
  /** 是否警示 */
  warn: boolean;
  /** 說明用的門檻值 */
  threshold: number;
}

export function qualityOf(
  L: Library, baseCh: string, result: { lib: Library; targetIdx: number },
  distOf: (L: Library, idx: number) => number,
): QualityReport | null {
  try {
    const baseIdx = idxOf(L, baseCh);
    const dist = distOf(result.lib, result.targetIdx);
    if (baseIdx === undefined) return { dist, baseDist: Infinity, warn: dist < WARN_ABS, threshold: WARN_ABS };
    const baseDist = distOf(L, baseIdx);
    const threshold = Math.min(WARN_ABS, Number.isFinite(baseDist) ? baseDist - WARN_DELTA : WARN_ABS);
    return { dist, baseDist, warn: dist < threshold, threshold };
  } catch {
    return null;
  }
}

/**
 * 內嵌 SVG 的關鍵 CSS。
 *
 * 顏色與大小兩條照施工單 §二 V1：
 *   `fill: currentColor`（顏色跟隨旁邊的字）
 *   `width: 1em; height: 1em`（大小跟隨旁邊的字）
 *
 * **`vertical-align` 是實測修正過的**：施工單寫 `-0.1em`，但實測會讓字浮起來。
 * 量測方法（`out/v1-baseline-report.html`）：把系統字與內嵌 SVG 放在**同一行
 * 正常的 inline flow** 裡（字級 100px、line-height 1.2），逐列比較兩者墨跡下界。
 * 注意**不能**用 `position:absolute` 定位去量——絕對定位不參與基線對齊，
 * 會得到完全不同的位移（我第一次就是這樣量錯的）。
 *
 * 掃描結果（Δ = SVG 墨跡下界 − 系統字墨跡下界，單位 px，100px 字級）：
 *
 *   voff    0.18   0.20   0.22   0.24   0.26
 *   Δ        -4     -2    **0**   +2     +4
 *
 * 所以 **-0.22em** 是唯一讓墨跡下界與系統字基線重合的值
 * （系統字 街 的墨跡下界就在基線上，緊框 [12,14,189,183]）。
 *
 * 交叉驗證（同一 -0.22em，六種字形）：
 *   街圭舞 0、國 0、寶缶支 0、街行彳舞亍 +1、日 +5、一 +6。
 * 後兩個是 KAGE 字形本身畫得比較低（`一` 的緊框是 [14,101,186,101]，貼在基線上），
 * 不是對齊誤差。
 */
export const INLINE_CSS =
  ".gc-inline{fill:currentColor;width:1em;height:1em;vertical-align:-0.22em;display:inline-block}";

/** 從 INLINE_CSS 取出基線位移值（em，負數＝往下） */
export function inlineAlignEm(): number {
  const m = /vertical-align:\s*(-?[\d.]+)em/.exec(INLINE_CSS);
  return m ? Number(m[1]) : 0;
}

export interface BaselineReport {
  /** 系統字的墨跡下界，相對基線（em；0 ＝ 墨跡正好坐在基線上） */
  sysBottom: number;
  /** 內嵌 SVG 的墨跡下界，相對基線（em） */
  svgBottom: number;
  /** 兩者之差（em）：0 ＝ 完美對齊，正值 ＝ SVG 偏低 */
  delta: number;
}

/**
 * 預測「內嵌 SVG 的墨跡下界」與「系統字基線」的差，**不需要瀏覽器**。
 *
 * 幾何（與 `out/v1-baseline-report.html` 的實測對照過，兩者一致）：
 *   * CSS 讓 SVG 元素是 1em × 1em。
 *   * viewBox 是 `0 0 200 200`，所以字形 200 方格裡的 y 對應到 SVG 元素的 y/200 em。
 *   * 相對定位的 inline-block 以**元素底端**坐在文字基線上（CSS 2.1 §10.8.1），
 *     再套用 `vertical-align` 的位移。
 *   * 墨跡下界＝字形的緊框 y2。
 *
 * `sysBottomEm` 是系統字墨跡下界的實測值：`街` 在「明體」下約為 +0.12em
 * （＝墨跡略微越過基線，這是 CJK 字形的常態）。
 */
export function baselineDelta(
  L: Library, r: SeqResult, sysBottomEm = 0.12,
): BaselineReport | null {
  if (!r.ok) return null;
  const tight = r.lib.glyphs[r.targetIdx]?.tight;
  if (!tight) return null;
  const align = inlineAlignEm();
  const svgBottom = 1 - tight[3] / 200 + align;
  return { sysBottom: sysBottomEm, svgBottom, delta: svgBottom - sysBottomEm };
}
