/**
 * component-boxes.ts — 算出「一個字裡每個部件佔的框」。
 *
 * 給兩頁共用：`glyph-browser.html`（大字上的部件框與連動）與 `pinxing.html`（大字的部件框）。
 * **只依賴 `lib-format.ts` 與 `free-compose.ts`**，不碰 node: 模組，才能直接內嵌進單頁。
 *
 * 為什麼要兩種框：
 *
 *   `raw`  是 KAGE 的**引用框**——引擎拿它把子字形貼進父字，忠實反映引擎行為。
 *          但它同時是「畫板座標」不是「版面座標」，實測很多是滿版矩形：
 *          邏的辶 `[0,0,200,200]`（佔滿 100%）、杏的口 `[14,-50,189,200]`（109%，還超出畫布）。
 *          畫出來每張都互相重疊，看不出哪個是哪個。
 *
 *   `tight` 是**墨跡緊框**——把子字形自己的墨跡範圍，經引用框映射回父座標。
 *          同一批實測：杏的口 12%、想的心 23%、想的目 12%，對得上眼睛看到的東西。
 *
 * 所以預設畫 `tight`，`raw` 留給設定切換（要對照引擎行為時才看）。
 *
 * ## 墨跡怎麼量：**用引擎的多邊形，不要走筆劃**
 *
 * 走筆劃座標看起來很省，但**量不準**：KAGE 資料裡的 `width` 幾乎都是 0，
 * 真正的筆寬是引擎用 `kMinWidthY`／`kMinWidthT` 等參數在描繪時加的。
 * 只取筆劃中心線會系統性低估——實測 `u53e3-04` 走筆劃得到 `[42,134,158,173]`，
 * 實際渲染是 `[36,126,168,188]`，四邊各差 6～15 格（畫面上就是框切進字形裡）。
 *
 * 所以正解是讀 `kage-engine` 的 `Polygons`：`polys.array[i].array[j].x/y`。
 * 引擎兩個頁面都已經內嵌了，`makeGlyph` 本來就要跑一次，順手取 bbox 幾乎不花成本。
 * `inkBoundsFromStrokes()` 留著只給「沒有引擎」的場合當退路。
 */
import { codePointOf, indexOfCodePoint, displayName, synKeyOf } from "./lib-format.ts";
import type { Library } from "./lib-format.ts";
import { refSlotsOf, drawingIdx } from "./free-compose.ts";

export type Box = [number, number, number, number];

/** 量一個字形自己的墨跡範圍（在它自己的 200×200 裡）。 */
export type InkMeasure = (gi: number) => Box | null;

export interface CompBox {
  /** 子字形在字庫裡的索引 */
  ref: number;
  refName: string;
  /** 在 `refSlotsOf()` 裡的序號；IDS-only 為 -1 */
  slotIx: number;
  /** KAGE 引用框（父字座標）；IDS-only 為 `null` */
  raw: Box | null;
  /** 墨跡緊框（父字座標）；IDS-only 為 `null` */
  tight: Box | null;
  /** 這個部件是 IDS 補的（KAGE 把它畫成原始筆劃），沒有框可畫 */
  idsOnly: boolean;
  /** 出現序號（含重複，林 = 兩個木依序 0、1） */
  order: number;
  /** 這一格在**父字 `strokes` 裡的索引** ✓（量引擎墨跡要用 ✓；IDS 補的＝-1 ✓） */
  strokeIx?: number;
}

/* ------------------------------------------------------------------ 量墨跡 */

/** 從 kage-engine 的 `Polygons` 讀出精確墨跡。**建議用這個。** */
export function inkBoundsOfPolys(polys: any): Box | null {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const arr = polys && polys.array ? polys.array : [];
  for (const poly of arr) {
    const pts = poly && poly.array ? poly.array : [];
    for (const p of pts) {
      const x = +p.x, y = +p.y;
      if (!isFinite(x) || !isFinite(y)) continue;
      if (x < x1) x1 = x; if (x > x2) x2 = x;
      if (y < y1) y1 = y; if (y > y2) y2 = y;
    }
  }
  return x1 > x2 ? null : [x1, y1, x2, y2];
}

/** 走筆劃座標估墨跡。**會低估**（見檔頭），只在沒有引擎時當退路。 */
export function inkBoundsFromStrokes(L: Library, gi: number, depth = 0): Box | null {
  const g = L.glyphs[gi];
  if (!g || depth > 30) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const add = (x: number, y: number) => {
    if (x < x1) x1 = x; if (x > x2) x2 = x;
    if (y < y1) y1 = y; if (y > y2) y2 = y;
  };
  for (const s of g.strokes) {
    if (s.kind === 99 && s.ref !== null) {
      const b = s.box;
      if (!b) continue;
      const inner = inkBoundsFromStrokes(L, s.ref, depth + 1);
      if (!inner) continue;
      const p = projectBox(inner, b as Box);
      add(p[0], p[1]); add(p[2], p[3]);
    } else if (s.kind !== 0) {
      const p = s.points;
      for (let i = 0; i + 1 < p.length; i += 2) {
        if (!p[i] && !p[i + 1]) continue;      // 曲線的填充零點
        add(p[i]!, p[i + 1]!);
      }
    }
  }
  return x1 > x2 ? null : [x1, y1, x2, y2];
}

/** 把子字形的墨跡範圍，經引用框映射回父字座標 */
function projectBox(inner: Box, raw: Box): Box {
  const sx = (raw[2] - raw[0]) / 200, sy = (raw[3] - raw[1]) / 200;
  return [
    raw[0] + inner[0] * sx, raw[1] + inner[1] * sy,
    raw[0] + inner[2] * sx, raw[1] + inner[3] * sy,
  ];
}

/* ------------------------------------------------------------------ 部件框 */

/**
 * 一個字裡的所有部件，依「部件序列」的順序。
 *
 * 前段是 KAGE 引用（有框），後段是 IDS 補的部件（沒有框）。
 * 重複次數保留——林回傳兩個木。
 *
 * `inkOf` 沒給就退回走筆劃的估法（會低估）；瀏覽器請傳引擎版。
 */
/** 引用的碼位：`codePointOf` 對「變體名」（例 堯 的異體）會查不到 → 退回用顯示字推。
    第 64 輪的實例：`㚁` 的引用是 堯 的變體，`codePointOf` 給不出碼位，
    於是 `堯` 這個分量配不上那個引用，被誤判成「畫法沒墨」。 */
function cpOfRef(L: Library, ref: number): number | undefined {
  const direct = codePointOf(L, ref);
  if (direct != null) return direct;
  const ch = charOf(L, ref);
  return ch ? ch.codePointAt(0) : undefined;
}
/**
 * 手畫筆劃能不能沿**乾淨的縫**切成 `need` 團？（切不開回 `null`）
 *
 * 第 102 輪：從 `componentBoxes()` 的 `rawGroups` 抽出來**共用** ✓ ——
 * 建庫的「墨塊數」要用它，取代「手畫 >= 6 筆就算 2 塊」的實證近似 ✗
 * （那個近似會把 `門`（10 筆獨體）誤判成組合 ✗，也會把 `弓`／`瓜`／`瓦` 這類 6 筆獨體誤判 ✗）。
 *
 * 判準（第 33～40 輪反覆修正後定下）：兩軸各算一次切法，**優先選每組都 >= 8 單位**的那一軸；
 * 兩軸都合格才用長寬啟發式 ✓（`林`／`競` 靠這條保住 ✓）。
 */
export function rawClusters(strokes: { kind: number; points: number[] }[], need: number): Box[] | null {
  if (need < 2) return null;
  const items: { box: Box; cx: number; cy: number }[] = [];
  for (const st of strokes) {
    if (st.kind === 99 || st.kind === 0) continue;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (let k = 0; k + 1 < st.points.length; k += 2) {
      const x = st.points[k]!, y = st.points[k + 1]!;
      if (!x && !y) continue;   /* 填充零（不論尾端或曲線），見 inkBoundsFromStrokes() */
      if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y;
    }
    if (x1 === Infinity) continue;
    items.push({ box: [x1, y1, x2, y2], cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 });
  }
  if (items.length < need) return null;
  let ux1 = Infinity, ux2 = -Infinity, uy1 = Infinity, uy2 = -Infinity;
  for (const it of items) { ux1 = Math.min(ux1, it.box[0]); ux2 = Math.max(ux2, it.box[2]); uy1 = Math.min(uy1, it.box[1]); uy2 = Math.max(uy2, it.box[3]); }
  const axisBoxes = (ax: boolean): Box[] | null => {
    const lo4 = ax ? 0 : 1, hi4 = ax ? 2 : 3;
    const s4 = items.slice().sort((a, b) => (ax ? a.cx - b.cx : a.cy - b.cy));
    if (s4.length < need) return null;
    const gs = s4.slice(1).map((it, i4) => ({ at: i4, size: it.box[lo4]! - s4[i4]!.box[hi4]! }));
    if (gs.length < need - 1) return null;
    const ci = gs.slice().sort((a, b) => b.size - a.size).slice(0, need - 1).map((x) => x.at).sort((a, b) => a - b);
    const boxes: Box[] = [];
    let st4 = 0;
    for (const c of ci.concat([s4.length - 1])) {
      const grp = s4.slice(st4, c + 1); st4 = c + 1;
      if (!grp.length) return null;
      let ax1 = Infinity, ay1 = Infinity, ax2 = -Infinity, ay2 = -Infinity;
      for (const it of grp) { ax1 = Math.min(ax1, it.box[0]); ax2 = Math.max(ax2, it.box[2]); ay1 = Math.min(ay1, it.box[1]); ay2 = Math.max(ay2, it.box[3]); }
      if (ax2 - ax1 < 8 || ay2 - ay1 < 8) return null;
      boxes.push([ax1, ay1, ax2, ay2]);
    }
    return boxes.length === need ? boxes : null;
  };
  const aspectX = (ux2 - ux1) >= (uy2 - uy1);
  return axisBoxes(aspectX) ?? axisBoxes(!aspectX);
}

export function componentBoxes(L: Library, gi: number, inkOf?: InkMeasure,
                                opt?: { deep?: boolean; inkOfRef?: (parentIdx: number, strokeIx: number) => Box | null }): CompBox[] {
  /* ★★ 第 138 輪（師父的回報 ✓）：**深層框**。
     症狀：同一個字，**IDS 版看得到 4 個子框、構形序版只有 2 個** ✗。
     原因不是誰畫錯 ✗——`refSlotsOf()` 只回**根的引用槽** ✓，而構形序的根常常只有 2 個分量 ✓
     （`好學孔孟` 的根是 2 個 ✓），分量自己還是合字時就只算一格 ✗；
      IDS 版是把 4 個**葉**各畫一格 ✓。兩邊的「格」定義不同 ✗（一個是引用、一個是葉 ✗）。
     師父要比的是同一個東西 ✓ → `opt.deep` 讓框**遞迴到真正在畫的葉** ✓，
     一路把子框經引用框**投影**回父座標 ✓。
     ⚠ 預設**不遞迴** ✓（`glyph-browser` 與既有斷言的行為完全不變 ✓）。 */
  const deep = !!(opt && opt.deep);
  const inkOfRef = opt && opt.inkOfRef;
  const bases: { box: Box | null; out: CompBox[] }[] = [];
  collectBoxes(L, gi, inkOf, deep, null, bases, 0, inkOfRef);
  const out: CompBox[] = [];
  for (let b = 0; b < bases.length; b++) {
    const parent = bases[b]!.box;
    for (const e of bases[b]!.out) {
      out.push({
        ref: e.ref, refName: e.refName, slotIx: e.slotIx,
        raw: e.raw, tight: e.tight, idsOnly: e.idsOnly, order: out.length,
        ...(parent ? { parentBox: parent } : {}),
      });
    }
  }
  return out;
}

/** **孫框**：一個字底下**所有子孫**的框，全部投影回**根座標** ✓（直到「自己會畫」的獨體為止 ✓）。
 *
 *  ⚠ 為什麼不直接用 `componentBoxes(…, { deep: true })` ✗：
 *  那一支是第 138 輪為了**比框數**寫的 ✓，留下來的是**容器**的框（`parentBox`），
 *  不是每一個孫**自己**的框 ✗——拿來畫會全部疊在上一層的框上 ✗。
 *  這一支把每一格自己的框沿著引用框**一路投影上來** ✓（結果放在 `abs` ✓）。
 *
 *  `order` 刻意讓**根的直接分量先排 0..n-1** ✓（與 `componentBoxes()` 的前 n 筆完全一致 ✓，
 *  所以部件序列的 `data-box` 對得上 ✓）；孫從 n 起往後排 ✓。
 *
 *  停止條件與第 138 輪一致 ✓：**那一格自己有沒有手畫的筆劃** ✓——
 *  有＝它就是葉（獨體）✓，不要再往下拆 ✗；沒有（純包裝）＝往下 ✓。
 */
export interface DescBox extends CompBox {
  /** 投影到根座標的**絕對框**（優先墨跡緊框 ✓）；IDS-only 為 null ✓ */
  abs: Box | null;
  /** 0＝根的直接分量 ✓；1＝孫 ✓；2＝曾孫 ✓… */
  depth: number;
}

/** 座標變換（子 → 父）：`x父 = k * x子 + tx` ✓ */
interface Tf { k: number; tx: number; ty: number }
const TF_ID: Tf = { k: 1, tx: 0, ty: 0 };
const tfThen = (outer: Tf, inner: Tf): Tf =>
  ({ k: outer.k * inner.k, tx: outer.k * inner.tx + outer.tx, ty: outer.k * inner.ty + outer.ty });
const tfBox = (b: Box, t: Tf): Box => [b[0] * t.k + t.tx, b[1] * t.k + t.ty, b[2] * t.k + t.tx, b[3] * t.k + t.ty];

/** 一格的座標變換 ✓——引擎對 kind-99 的語意是「**把子字形的墨跡等比縮放後置中**」✓
 *  （`out/_probe-ids-frame.ts` 實測：框 [0,0,100,200] 裝 108×136 的墨 → 貼在 [0,37,100,163] ✓），
 *  **不是**仿射填滿 ✗——`projectBox()` 只在墨跡長寬比剛好等於框時才與它一樣 ✓。
 *  ⚠ 孫框要**一層一層把變換乘下去** ✓（每一步都用那一層的墨跡 ✓），不然誤差會累積 ✓。 */
function placeTf(slot: Box, childInk: Box | null): Tf {
  const sw = slot[2] - slot[0], sh = slot[3] - slot[1];
  if (!childInk) return { k: 1, tx: slot[0], ty: slot[1] };
  const cw = childInk[2] - childInk[0], ch = childInk[3] - childInk[1];
  if (!(cw > 0) || !(ch > 0)) return { k: 1, tx: slot[0], ty: slot[1] };
  const k = Math.min(sw / cw, sh / ch);
  return { k, tx: slot[0] + (sw - cw * k) / 2 - childInk[0] * k,
           ty: slot[1] + (sh - ch * k) / 2 - childInk[1] * k };
}

/** 一格的**直接引用**（純 KAGE ✓）——**孫框要的是「實際畫出來」的那一格** ✓。
 *
 *  ⚠ 為什麼不用 `componentBoxesShallow()` 往下走 ✗：
 *  它會拿**這個字的 `comp` 表**去重新配對引用 ✗，而拼形的結果是把某個引用**換掉**了
 *  （例 `寶缶支`：`缶 → 支` ✓）——於是它把換上去的 `支` 又改名回原本那個
 *  `缶` 的相關字 ✗（實測：孫框會指到錯的字，數目也不對 ✗，師父 2026-10-15 抓到 ✓）。
 *  直接看**引擎真正引用的那幾格**才對得上畫面 ✓。 */
function rawRefBoxes(L: Library, g: number): CompBox[] {
  const out: CompBox[] = [];
  const slots = refSlotsOf(L, drawingIdx(L, g));
  for (let k = 0; k < slots.length; k++) {
    const s = slots[k]!;
    out.push({ ref: s.ref, refName: s.refName, slotIx: k, strokeIx: s.strokeIx,
               raw: s.box as Box, tight: null, idsOnly: false, order: out.length });
  }
  return out;
}

/** `inkOfPath`（可選）＝**引擎**量的「這條引用鏈在**根座標**的墨跡框」✓——
 *  **有給就用它當 `abs`** ✓（那才是「能包住所有筆劃的**最小框**」✓，含框與 `stretch` ✓）；
 *  沒給才退回這裡自己乘變換的估計 ✗（「等比縮放後置中」的模型遇到 `stretch` 會偏 ✗，
 *  症狀是孫框比它的父框還高／還寬 ✗，師父 2026-10-15 抓到 ✓）。 */
export function descendantBoxes(L: Library, gi: number, inkOf?: InkMeasure,
                                inkOfPath?: (path: number[]) => Box | null): DescBox[] {
  const measure: InkMeasure = inkOf ?? ((i: number) => inkBoundsFromStrokes(L, i));
  const out: DescBox[] = [];
  type Frame = { ref: number; tf: Tf; path: number[] };
  /** 沿著引用路徑走到的那個字形 ✓（`path` 是每一層的 `strokeIx` ✓）。 */
  const refAtPath = (path: number[]): number | null => {
    let g = drawingIdx(L, gi);
    for (const six of path) {
      const s = refSlotsOf(L, g).find((x) => x.strokeIx === six);
      if (!s) return null;
      g = drawingIdx(L, s.ref);
    }
    return L.glyphs[g] ? g : null;
  };
  /** 把一層的框收進來 ✓；回傳「還值得往下走的引用」✓（帶它的座標變換與**引用路徑** ✓）。 */
  const emit = (boxes: CompBox[], tf: Tf, depth: number, prefix: number[]): Frame[] => {
    const next: Frame[] = [];
    for (const e of boxes) {
      const ink = e.ref >= 0 && e.ref < L.glyphs.length ? measure(e.ref) : null;
      const childTf = e.raw ? tfThen(tf, placeTf(e.raw, ink)) : null;
      const path = (e.strokeIx !== undefined && e.strokeIx >= 0) ? prefix.concat(e.strokeIx) : null;
      /* 這條路徑**實際走到的那個字形** ✓——身分要跟它對齊 ✓：
         `componentBoxesShallow` 會把「跨碼位異體」那一格**改名**（例 想 的 IDS `相` 配到 KAGE 的 `目` 格 ✗），
         那時 `e.ref` 與路徑上的實際引用不同 ✗——硬用會走到錯的子樹 ✗。 */
      const actual = path ? refAtPath(path) : null;
      /* ★ 首選：問**引擎**要這條鏈的墨跡框 ✓（＝能包住所有筆劃的**最小框** ✓，含框與 stretch ✓）。 */
      let abs: Box | null = null;
      if (inkOfPath && path && actual !== null) { try { abs = inkOfPath(path); } catch { abs = null; } }
      /* 退路：自己乘變換（沒有引擎、或 IDS-only 時用 ✓）。 */
      if (!abs) {
        abs = (ink && childTf) ? tfBox(ink, childTf)
          : (e.raw ? tfBox(e.raw, tf) : (e.tight ? tfBox(e.tight, tf) : null));
      }
      out.push({ ...e, order: out.length, abs, depth });
      /* 只往**真正的 KAGE 引用**走 ✓（`slotIx >= 0`），而且要用**路徑上的實際引用** ✓ */
      if (path && actual !== null && e.slotIx >= 0) next.push({ ref: actual, tf: childTf ?? tf, path });
    }
    return next;
  };
  const step = (from: Frame[], depth: number): void => {
    if (depth > 12 || !from.length) return;
    const next: Frame[] = [];
    for (const n of from) {
      if (!L.glyphs[n.ref]) continue;
      const cp = codePointOf(L, n.ref);
      const comps = (cp && L.comp) ? L.comp.get(cp) : undefined;
      /* ⚠ **停止條件不可以是「自己有手畫的筆劃」** ✗（第 138 輪的舊規則）——
         很多合字是**引用與手畫混著**（例 `寶缶支` 的 `𡩧`：筆劃是 `99,1,1,1,2,99`），
         用那一條會在 `𡩧` 就停住 ✗（師父 2026-10-15 抓到：那題應該有 4～5 個框 ✗）。
         正確的停止條件＝**它是不是合字** ✓（就是**獨體**的定義 ✓）：
         有碼位 → 看 `comp` 表 ✓（獨體的 `comp` 已被清掉 ✓）；
         沒有碼位的內部字形 → 退回「部件清單非空」✓。
         ⚠ 只看「部件清單非空」還不夠 ✗：`宀` 是獨體，卻有一個 KAGE 引用（冖）✗
           ——那不是它的部件，會多畫一個假框 ✗。 */
      if (cp && !(comps && comps.length)) continue;
      /* 往下一層用**實際的 KAGE 引用** ✓（見 `rawRefBoxes()` 的說明 ✓） */
      next.push(...emit(rawRefBoxes(L, n.ref), n.tf, depth, n.path));
    }
    step(next, depth + 1);
  };
  step(emit(componentBoxesShallow(L, gi, inkOf), TF_ID, 0, []), 1);
  return out;
}

/** 遞迴收集 ✓（`deep=false` 時與舊版**完全一樣** ✓：一次呼叫、不投影 ✓）。 */
function collectBoxes(L: Library, gi: number, inkOf: InkMeasure | undefined, deep: boolean,
                      parentBox: Box | null, acc: { box: Box | null; out: CompBox[] }[], depth: number,
                      inkOfRef?: (parentIdx: number, strokeIx: number) => Box | null): void {
  const boxes = componentBoxesShallow(L, gi, inkOf, inkOfRef);
  if (!deep || depth > 12) { acc.push({ box: parentBox, out: boxes }); return; }
  for (const e of boxes) {
    /* 這一格自己還是「合字」嗎 ✓——是的話就往下一層 ✓（框投影回**根**座標 ✓）。
       ★ 停止條件（第 138 輪 ✓）：**它自己有沒有手畫的筆劃** ✓——
         有筆劃＝它自己就在畫 ✓（就是一個葉 ✓，不要再往下拆 ✗，不然會多出一堆重複的框 ✗）；
         沒有筆劃、只有引用＝**包裝** ✓ → 往下 ✓（這正是舊版只回一格的那個坑 ✓）。 */
    const refIx = e.ref !== undefined ? e.ref : -1;
    const hasOwnStrokes = refIx >= 0 &&
      L.glyphs[refIx]!.strokes.some((s) => s.kind !== 99 && s.kind !== 0);
    const innerBoxes = (refIx >= 0 && !hasOwnStrokes) ? componentBoxesShallow(L, refIx, inkOf, inkOfRef) : [];
    const canGoDeeper = innerBoxes.length > 1 && e.raw !== null;
    if (!canGoDeeper) { acc.push({ box: parentBox, out: [e] }); continue; }
    /* 子框在**這一格的座標** ✓（把 `e.raw` 當成這一格自己的畫布 ✓，再投影回上一層 ✓） */
    const childAcc: { box: Box | null; out: CompBox[] }[] = [];
    collectBoxes(L, refIx, inkOf, true, e.raw, childAcc, depth + 1, inkOfRef);
    for (const c of childAcc) {
      const abs = projectBox(c.box ?? e.raw, e.raw);       /* 這一格的框 → 上一層座標 ✓ */
      const finalBox = parentBox ? projectBox(abs, parentBox) : abs;   /* → 再往上一層 ✓ */
      acc.push({ box: finalBox, out: c.out.map((x) => ({ ...x, slotIx: e.slotIx })) });
    }
  }
}

/** 舊版的**淺層**框（一次 `refSlotsOf` ✓）——`componentBoxes()` 的非遞迴路徑就是它 ✓。 */
function componentBoxesShallow(L: Library, gi: number, inkOf?: InkMeasure,
                               inkOfRef?: (parentIdx: number, strokeIx: number) => Box | null): CompBox[] {
  /* ⚠ **先往下走到「真正在畫」的字形**：字庫裡很多碼位的字形只是一個**包裝**
     （一筆引用指向 `-j`／`-g` 那個真的畫出來的異體，例 `藵` #49163 → #49164）。
     不往下走的話 `refSlotsOf()` 只會回**一格**（＝包裝自己、框是滿格），
     部件的框就全部對不上——回報的 `藵`「兩個部件可點、卻沒有框」就是這個。
     引擎側本來就有這支（`free-compose.ts` 的 `drawingIdx()`），這裡照用。 */
  gi = drawingIdx(L, gi);
  const measure: InkMeasure = inkOf ?? ((i: number) => inkBoundsFromStrokes(L, i));
  const out: CompBox[] = [];
  const slots = refSlotsOf(L, gi);
  for (let k = 0; k < slots.length; k++) {
    const s = slots[k]!;
    const raw = s.box as Box;
    /* ★ 墨跡緊框優先問**引擎** ✓（`inkOfRefInParent`：含框與 stretch 的真實落點 ✓）——
       自己用仿射 `projectBox()` 推的只在「框的比例剛好等於墨跡比例」時才對 ✗
       （例 邏 的 羅：仿射 [47,14,197,164] vs 引擎 [56,13,188,173] ✗）。 */
    let tight: Box | null = null;
    if (inkOfRef) { try { tight = inkOfRef(gi, s.strokeIx); } catch { tight = null; } }
    if (!tight) { const inner = measure(s.ref); tight = inner ? projectBox(inner, raw) : null; }
    out.push({
      ref: s.ref, refName: s.refName, slotIx: k, strokeIx: s.strokeIx,
      raw, tight,
      idsOnly: false, order: out.length,
    });
  }

  /* 自己一筆原始筆劃都沒有的字，**不可能有東西被畫成原始筆劃**，所以**不可以**無中生有
     一個「IDS 補的部件」：品 KAGE 三個口引用、0 條原始筆劃，照扣會留下「吅」，
     清單變成「口 口 口 吅」（多了一個根本沒被單獨畫出來的東西）；器同理由「⿱吅大 吅」
     被多塞「㗊 犬」。
     但**配得上既有引用**的 IDS 分量還是要處理——那是「跨碼位異體」：
     `藵` 的畫法引用 `𧛱`(U+276F1)、IDS 卻寫 `褒`(U+8912)，配不到就沒有框
     （回報：可點卻沒框；全庫 13,135 個同症狀）。所以下面照樣跑，
     只是**沒有配到引用時**不補（見 `if (!partner)`）。 */
  /* v5 的跨碼位異體（相容字符 ↔ 正規碼位）：`進` 的 IDS 寫 `辶`(U+8FB6)、畫法引用相容字符
     `辶`(U+FA66)——照碼位配永遠配不到，框就不見了。兩邊都**正規化到同一組的代表碼位**
     （組內最小）再比，既有配對邏輯不必改。 */
  const synKeyCp = (c: number | null | undefined): number | null => (c == null ? null : synKeyOf(L, c));   /* 連通分量代表碼位，見 lib-format 的 synKeyOf() */
  const hasRaw = L.glyphs[gi]!.strokes.some((s) => s.kind !== 99 && s.kind !== 0);
  /* 原始筆劃的墨框：IDS 有、畫法沒有對應引用的分量（`進` 的 `隹`、`合` 的 `口`）
     那一塊墨其實就是這幾筆——框從**墨**來，不是從 IDS 來。 */
  const rawBox = (function () { let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const st of L.glyphs[gi]!.strokes) { if (st.kind === 99 || st.kind === 0) continue;
      for (let k = 0; k + 1 < st.points.length; k += 2) { const x = st.points[k]!, y = st.points[k + 1]!; if (!x && !y) continue;   /* 填充零（不論尾端或曲線），見 inkBoundsFromStrokes() */
        if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; } }
    return x1 === Infinity ? null : [x1, y1, x2, y2] as Box; })();
  if (!hasRaw) return out;

  /* IDS 補的部件。已被引用涵蓋的要扣掉，而且**要按次數扣**——
     只留一個 Set 會只扣一次，林（木×2，KAGE 一個都沒引用）會被算成一次。 */
  const cp = codePointOf(L, gi);
  const comps = cp != null ? L.comp?.get(cp) : undefined;
  if (comps) {
    const remaining = new Map<number, number>();
    for (const s of slots) {
      const c = synKeyCp(cpOfRef(L, s.ref));
      if (c != null) remaining.set(c, (remaining.get(c) ?? 0) + 1);
    }
    /* 「引用有、IDS 分量卻沒點名」的槽位：`藵` 的畫法引用 `𧛱`(U+276F1)，
       IDS 卻寫 `褒`(U+8912)——**跨碼位的異體**，而家族表只綁同碼位的字形（異體表缺口）。
       兩邊都是 IDS 序（第 1 輪實測引用順序與分量順序 99.9% 一致，第 3 輪讓 `lib.comp`
       也保留 IDS 序），所以剩下的一對一按順序配，**沿用那個引用的框**。
       不這樣做的話，`褒` 會被當成「IDS 補的部件、沒有框」→ 頁面就不畫框了
       （兩個部件可點、卻沒有框——回報的症狀）。 */
    const unclaimed = slots.filter((s) => {
      const c = synKeyCp(cpOfRef(L, s.ref));
      return c == null || !comps.some((x) => synKeyCp(x) === c);
    });
    /* 還會有幾個分量拿不到引用？＝「配不上既有引用的分量數」減「可用的沒被點名引用數」
       （partner 是一個配一個，配完還有剩的才是真的沒有墨可以指）。 */
    const unmatchedTotal = comps.filter((x) => (remaining.get(synKeyCp(x)!) ?? 0) === 0).length - unclaimed.length;
    /* 多個分量、墨分不開時：把原始筆劃沿**乾淨的縫**切開（`林` 的兩個 `木`）。
       第 102 輪：演算法已抽成模組層的 `rawClusters()` ✓（建庫也用同一套 ✓，不再各寫一份 ✗）。 */
    const rawGroups = rawClusters(L.glyphs[gi]!.strokes, unmatchedTotal);
    let ui = 0, umSeen = 0;
    for (const c of comps) {   /* 用**原碼位**當身分（代表碼位可能是字庫沒有的部首，例 ⺼ U+2EBC）；synKey 只用來配對 */
      const n = remaining.get(synKeyCp(c)!) ?? 0;
      if (n > 0) { remaining.set(c, n - 1); continue; }
      const ci = indexOfCodePoint(L, c);
      if (ci === undefined) continue;
      const partner = unclaimed[ui];
      /* 配到了引用：**不新增一格**，改成把既有那一格換上 IDS 分量的身分（名字用 IDS 的、框用畫法的）——
         `進` 的 `辶`(引用) 與 `辶`(IDS) 是**同一塊墨的兩個名字**，畫兩格框會重疊。
         這樣一格、一個名字、一個框，客人才看得懂。 */
      if (partner) { ui++; const pi = slots.indexOf(partner); if (pi >= 0 && out[pi]) { const e = out[pi]!; e.ref = ci; e.refName = displayName(L, ci); continue; } }
      /* 沒有引用可以配（＝這個分量在畫法裡沒有對應的墨）→ 只有在「有原始筆劃」時才列出來
         （那幾筆可能就是它畫的）；沒有原始筆劃的字就不無中生有（見上面的 品／器）。 */
      if (!hasRaw) continue;
      if (unmatchedTotal === 1 && rawBox && rawBox[2] - rawBox[0] >= 8 && rawBox[3] - rawBox[1] >= 8)   /* 細條框不給（`一` 這種全橫筆的墨框高度是 0——點座標沒有筆寬） */ { out.push({ ref: ci, refName: displayName(L, ci), slotIx: -1, strokeIx: -1, raw: rawBox, tight: rawBox, idsOnly: false, order: out.length }); continue; }
      if (rawGroups && umSeen < rawGroups.length) { const gb = rawGroups[umSeen++]!; out.push({ ref: ci, refName: displayName(L, ci), slotIx: -1, strokeIx: -1, raw: gb, tight: gb, idsOnly: false, order: out.length }); continue; }
      out.push({
        ref: ci, refName: displayName(L, ci), slotIx: -1, strokeIx: -1,
        raw: null, tight: null, idsOnly: true, order: out.length,
      });
    }
  }
  return out;
}

/**
 * 這個字形有沒有部件（＝能不能當基字拼形）。**獨體字回 false。**
 *
 * 刻意寫得便宜：`componentBoxes()` 會跑 `refSlotsOf()` 又量一輪墨跡，
 * 而這個問題只要看「有沒有引用」與「IDS 有沒有分解」就夠了。
 */
export function hasComponents(L: Library, gi: number): boolean {
  const g = L.glyphs[gi];
  if (!g) return false;
  if (g.strokes.some((s) => s.kind === 99 && s.ref !== null)) return true;
  const cp = codePointOf(L, gi);
  const comps = cp != null ? L.comp?.get(cp) : undefined;
  return !!comps?.length;
}
