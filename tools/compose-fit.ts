// compose-fit.ts — 組字 v2：替換部件時避免溢出造成筆劃重疊。
//
// 原則（保真度優先）：
//   1. **先試完全沿用舊框**——那些框是人工手調資產。做法是實際放進去量測，
//      若結果仍落在原部件的墨跡區域內，就保留不動。
//   2. 放不下時，才以原部件的墨跡區域為槽位，**等比縮小並置中**。
//
// 縮放用「兩層引用」表達，避開 kage 的框／伸縮互相牽扯：
//   父字 ──(框, 無伸縮)──▶ 包裝字形 ──(框=滿格, 伸縮=kk)──▶ 新部件
//   kk = 100(1-k) 會把子內容等比縮到 k 倍。
//
// 位置修正：伸縮會同時移動內容，不易解析預測落點，所以「放入 → 量測 → 平移修正」，
// 仿射映射下一次修正即精確。
import { readFileSync } from "node:fs";
import {
  decodeLibrary, toKageData, isVariantOfCp, keyOfIdx, indexOfChar, displayName,
  codePointOf, familyMembers, indexOfCodePoint,
} from "./lib-format.ts";
import type { Library, Glyph, Stroke } from "./lib-format.ts";
import { inkBoxOfPolygons } from "./lib-measure.ts";
import type { Box } from "./lib-measure.ts";

/**
 * 專案根目錄（kage-engine 在 Node 端要從這裡載入）。
 *
 * **命名注意**：內嵌進網頁時，各模組的 export 會被拿掉、全部接在同一個 script
 * 作用域裡，所以模組層級的常數名不能太短。這裡曾經叫 `D`，而 CodeMirror 6 的
 * bundle 內部也有一個 `var D`，兩者同一作用域就是 SyntaxError
 * （"Cannot declare a var variable that shadows a let/const/class variable: 'D'"）
 * ——**整個 script 都不執行，頁面完全空白且沒有任何錯誤訊息**。
 */
const PROJ_ROOT = "D:/2023/glyphwiki";

/** 確保 kage-engine 已載入（Node 端用 eval；瀏覽器端已內嵌，此函式被改成 no-op） */
export function ensureEngine(): void {
  if (typeof (globalThis as any).Kage !== "undefined") return;
  let engine = "";
  for (const f of ["2d.js", "buhin.js", "curve.js", "kage.js", "kagecd.js", "kagedf.js", "polygon.js", "polygons.js"]) {
    engine += readFileSync(`${PROJ_ROOT}/kage-engine/${f}`, "utf8") + "\n";
  }
  (0, eval)(engine);
}

export type Lib = ReturnType<typeof decodeLibrary>;

/** 量出某字形（含子樹）在自身座標系的墨跡範圍 */
export function inkIn(L: Lib, rootIdx: number): Box {
  ensureEngine();
  const kage = new Kage();
  const seen = new Set<number>();
  const stack = [rootIdx];
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const g = L.glyphs[i]!;
    kage.kBuhin.push(keyOfIdx(L, i), toKageData(g, L));
    for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  const polys = new Polygons();
  kage.makeGlyph(polys, keyOfIdx(L, rootIdx));
  return inkBoxOfPolygons(polys).box;
}

/** 把父字的某個引用單獨放進引擎，量它在父座標系中的墨跡（＝該部件佔的區域） */
export function inkOfRefInParent(L: Lib, parentIdx: number, strokeIx: number): Box {
  ensureEngine();
  const one = L.glyphs[parentIdx]!.strokes[strokeIx]!;
  const kage = new Kage();
  kage.kBuhin.push(
    keyOfIdx(L, parentIdx),
    "99:0:0:" + one.box!.join(":") + ":" + keyOfIdx(L, one.ref!) + ":" + one.stretch!.join(":"),
  );
  const seen = new Set<number>();
  const stack = [one.ref!];
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const g = L.glyphs[i]!;
    kage.kBuhin.push(keyOfIdx(L, i), toKageData(g, L));
    for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  const polys = new Polygons();
  kage.makeGlyph(polys, keyOfIdx(L, parentIdx));
  return inkBoxOfPolygons(polys).box;
}

/** 父字裡「除了某個引用之外」其他引用的墨跡聯集（父座標）；只有一個引用時回 null */
export function siblingInkOf(L: Lib, parentIdx: number, exceptStrokeIx: number): Box | null {
  const g = L.glyphs[parentIdx]!;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, n = 0;
  g.strokes.forEach((s, i) => {
    if (i === exceptStrokeIx || s.kind !== 99 || s.ref === null || !s.box) return;
    const b = inkOfRefInParent(L, parentIdx, i);
    x1 = Math.min(x1, b.x1); y1 = Math.min(y1, b.y1);
    x2 = Math.max(x2, b.x2); y2 = Math.max(y2, b.y2);
    n++;
  });
  return n ? { x1, y1, x2, y2 } : null;
}

/** 讓位判定的容差（格）。小於這個值的重疊是人工版面本來就有的咬合，不要動它。 */
export const BAND_TOL = 3;

/** 「新舊差不多大」的容忍倍率：這個範圍內視為**直接換掉**（drop-in），不讓位。
 *
 *  為什麼需要：`初衤礻` 這種「換一個幾乎同形的部件」是教學上最常用的用法
 *  （讓孩子看出初是衣字部、不是示字部）。但 衤 與 刀 的墨跡在水平方向本來就互相
 *  咬合（初 的兩半是斜向咬在一起的），於是讓位判定會認為「新內容壓到兄弟」，
 *  把 礻 塞進一條很窄的帶狀區——使用者回報「礻 在組字內的框很小」就是這個。
 *
 *  實測的尺寸比（新／舊，各自在自己的方格裡）：
 *    衤→礻 0.89×0.99（該直接換）、斤→刀 0.97×0.94（該直接換）、
 *    貝→𩀨 1.16×1.05（讓位）、衤→刀 1.72×0.90（讓位）。
 *  取 0.75–1.3：上面兩個「該直接換」的都過，兩個「該讓位」的都不過。 */
const DROPIN_LO = 0.75, DROPIN_HI = 1.3;

/** 「直接換掉」的**位置**容差（格，畫布 200 格）：新舊墨跡的中心位移超過它就改走墨跡對齊。
 *  實測（2026-10-14）：
 *    · 該**沿用原框**的：`初衤礻` Δ=(0.0,0.0)、`邏羅寶` Δ=(0.0,0.0)（同一格墨跡）
 *    · 該**對齊**的：`秧央角` Δ=(36.5,0.0)、`祈斤刀`、`街圭舞`、`寶貝𩀨` 都 > 8
 *  取 8：把「中心幾乎沒動」的留在沿用，把「明顯偏一邊」的送去對齊 ✓。 */
const SHIFT_TOL = 8;

/**
 * **墨跡對齊**：把新內容的框算成「讓它的墨跡正好蓋住舊部件的墨跡」。
 *
 * 為什麼需要：沿用舊框的前提是「新內容的墨跡在自己的方格裡佔的比例和舊部件差不多」。
 * `街` 的 `圭` 框是 `[50,0,200,200]`（150 寬），但 `圭` 那個字形墨跡只佔框寬 57%——
 * 人工把框放大來補償它的窄墨跡，畫出來只有 78 寬。換成 `舞`（墨跡佔 85%）時
 * 沿用同一個框 → 舞畫出來 127 寬，直接壓到 `行` 右半的 `亍`
 * （使用者回報「舞太大，因為圭的框太大」；`衚胡舞` 的 `胡` 框只有 102 寬，所以那邊好看）。
 *
 * 做法：由「舊部件墨跡」與「新字形的緊框」反解出框——
 *   boxW = 200 × 舊墨跡寬 ÷ 新緊框寬，boxX = 舊墨跡左緣 − 新緊框左緣 × boxW ÷ 200
 * （y 同理），新墨跡就會剛好落在舊墨跡上、大小不變。
 *
 * 新舊墨跡比落在 `DROPIN_LO..DROPIN_HI` 時回 `null`：那種情況沿用原框就好
 * （框是人工資產；`初衤礻`、`祈斤刀` 都落在這一段，行為不變）。
 */
export function inkAlignedBox(
  L: Lib, newIdx: number, oldInk: Box, trialInk: Box, allow = true,
): number[] | null {
  if (!allow) return null;
  const ow = Math.max(1, oldInk.x2 - oldInk.x1), oh = Math.max(1, oldInk.y2 - oldInk.y1);
  const nw = Math.max(1, trialInk.x2 - trialInk.x1), nh = Math.max(1, trialInk.y2 - trialInk.y1);
  const rw = nw / ow, rh = nh / oh;
  /* **位置也要看**（第 110 輪修）：原本只看大小比，於是「大小差不多、位置差很多」的情況
     會被判成「直接換掉」而沿用原框 ✗。實例（師父回報）：
       `秧央角`——`秧` 的 `禾`／`央` 兩個 KAGE 框都幾乎是**恆等框**（`禾` [-1,0,180,200]、
       `央` [5,0,200,200]），因為那兩個部件字形**在自己的畫布裡就已經擺好位置**
       （`央` 自己的墨跡在 x=64..188＝右半）。`角` 這個字形卻是**置中**的（墨跡 x=19..160），
       大小與 `央` 差不多（1.14×1.02，落在 0.75–1.3 的 drop-in 範圍）→ 沿用恆等框，
       `角` 就畫在正中間、**侵占左邊的禾** ✗。
     所以：新舊墨跡的**中心位移**超過 `SHIFT_TOL` 就當作「差很多」→ 走墨跡對齊 ✓。 */
  const dx = Math.abs((trialInk.x1 + trialInk.x2) / 2 - (oldInk.x1 + oldInk.x2) / 2);
  const dy = Math.abs((trialInk.y1 + trialInk.y2) / 2 - (oldInk.y1 + oldInk.y2) / 2);
  const shifted = dx > SHIFT_TOL || dy > SHIFT_TOL;
  /* ⚠ 診斷輸出要用 `globalThis.process?.env`——**這個模組會被內嵌進頁面**，
     瀏覽器裡沒有 `process` ✗（第 110 輪實測：直接寫 `process.env.X` 會讓整條組字動線拋錯，
     症狀是「已經選好要換掉的X → 接著打」之後換不掉、連帶 12 條頁面斷言失敗 ✗）。 */
  if ((globalThis as any).process?.env?.DSH_FIT_DEBUG) {
    console.error(`    [fit] old=[${oldInk.x1},${oldInk.y1},${oldInk.x2},${oldInk.y2}] ` +
      `trial=[${trialInk.x1},${trialInk.y1},${trialInk.x2},${trialInk.y2}] ` +
      `rw=${rw.toFixed(2)} rh=${rh.toFixed(2)} Δ=(${dx.toFixed(1)},${dy.toFixed(1)}) ` +
      `→ ${(!shifted && rw >= DROPIN_LO && rw <= DROPIN_HI && rh >= DROPIN_LO && rh <= DROPIN_HI) ? "沿用原框" : "墨跡對齊"}`);
  }
  if (!shifted && rw >= DROPIN_LO && rw <= DROPIN_HI && rh >= DROPIN_LO && rh <= DROPIN_HI) return null;

  const t = L.glyphs[newIdx]?.tight;
  if (!t) return null;
  const tw = t[2] - t[0], th = t[3] - t[1];
  if (tw <= 0 || th <= 0) return null;      // 退化（例如純橫線）→ 不猜，沿用原框
  const bw = (200 * ow) / tw, bh = (200 * oh) / th;
  const bx = oldInk.x1 - (t[0] * bw) / 200, by = oldInk.y1 - (t[1] * bh) / 200;
  return [bx, by, bx + bw, by + bh];
}

/**
 * **同層讓位**：新內容如果壓到兄弟的墨跡，就把框推到兄弟之外、沿版面軸延伸到畫布邊緣。
 *
 * 為什麼需要：替換部件時沿用舊框，前提是「新舊內容大小差不多」。
 * 但 `寶 的 貝 → 𩀨` 這種情況，舊部件 貝 的墨跡是 88 格高，新部件 𩀨 是 171 格高，
 * 沿用舊框會讓 𩀨 直接壓到上面的「宀王缶」，整個字糊成一團。
 *
 * 做法刻意**只動被替換的那一個框**（框是人工資產，兄弟的框不要去碰）：
 *   1. 用墨跡判斷版面軸與方位（上下／左右、上／下／左／右）
 *   2. 量兄弟的墨跡聯集，算出新內容壓進去多少
 *   3. 壓超過容差 → 把框改成「從兄弟邊緣到畫布邊緣」的帶狀區，
 *      交叉軸沿用舊框的範圍
 *
 * 回傳新框；不需要讓位時回 `null`。
 */
export function refitBand(
  L: Lib, parentIdx: number, strokeIx: number, oldBox: number[],
  trialInk: Box, oldInk: Box,
): number[] | null {
  const sib = siblingInkOf(L, parentIdx, strokeIx);
  if (!sib) return null;

  /* 新舊差不多大 → 直接換，不讓位。
     （讓位是為了處理「新內容大很多、會糊成一團」；同形的部件被推成細帶反而是壞的。） */
  const ow = Math.max(1, oldInk.x2 - oldInk.x1), oh = Math.max(1, oldInk.y2 - oldInk.y1);
  const nw = Math.max(1, trialInk.x2 - trialInk.x1), nh = Math.max(1, trialInk.y2 - trialInk.y1);
  const rw = nw / ow, rh = nh / oh;
  if (rw >= DROPIN_LO && rw <= DROPIN_HI && rh >= DROPIN_LO && rh <= DROPIN_HI) return null;

  const dx = (oldInk.x1 + oldInk.x2) / 2 - (sib.x1 + sib.x2) / 2;
  const dy = (oldInk.y1 + oldInk.y2) / 2 - (sib.y1 + sib.y2) / 2;
  const MIN_BAND = 20;
  let cand: number[] | null = null;
  if (Math.abs(dy) >= Math.abs(dx)) {
    if (dy > 0) {
      // 新內容在下面：不可以伸到兄弟的下緣之上
      if (sib.y2 - trialInk.y1 > BAND_TOL) {
        const y1 = Math.round(sib.y2);
        if (200 - y1 >= MIN_BAND) cand = [oldBox[0]!, y1, oldBox[2]!, 200];
      }
    } else if (trialInk.y2 - sib.y1 > BAND_TOL) {
      const y2 = Math.round(sib.y1);
      if (y2 >= MIN_BAND) cand = [oldBox[0]!, 0, oldBox[2]!, y2];
    }
  } else if (dx > 0) {
    // 新內容在右邊：不可以伸到兄弟的右緣之左
    if (sib.x2 - trialInk.x1 > BAND_TOL) {
      const x1 = Math.round(sib.x2);
      if (200 - x1 >= MIN_BAND) cand = [x1, oldBox[1]!, 200, oldBox[3]!];
    }
  } else if (trialInk.x2 - sib.x1 > BAND_TOL) {
    const x2 = Math.round(sib.x1);
    if (x2 >= MIN_BAND) cand = [0, oldBox[1]!, x2, oldBox[3]!];
  }
  if (!cand) return null;
  // 算出來的帶狀區如果跟原框幾乎一樣，那就沒有「讓位」可言——
  // 不要為了改而改（`電 的 雨 → 水` 就是這樣：算出來跟原框差不到 1 格，
  // 套上去只會讓紀錄變成「讓位」，幾何其實沒動）。
  const moved = Math.max(
    Math.abs(cand[0]! - oldBox[0]!), Math.abs(cand[1]! - oldBox[1]!),
    Math.abs(cand[2]! - oldBox[2]!), Math.abs(cand[3]! - oldBox[3]!),
  );
  return moved > BAND_TOL ? cand : null;
}

/** 找出主字樹中含 `cp` 這個碼位家族的那一層與引用索引 */
export function findSlot(
  L: Lib, start: number, cp: number,
): { parent: number; strokeIx: number; refIdx: number } | null {
  const seen = new Set<number>();
  const stack = [start];
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const g = L.glyphs[i]!;
    for (let si = 0; si < g.strokes.length; si++) {
      const s = g.strokes[si]!;
      if (s.kind === 99 && s.ref !== null && isVariantOfCp(L, s.ref, cp)) {
        return { parent: i, strokeIx: si, refIdx: s.ref };
      }
    }
    for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  return null;
}

function makeWrapper(targetIdx: number): Glyph {
  const st: Stroke = {
    kind: 99, width: 0, style: 0, points: [0, 0, 200, 200],
    ref: targetIdx, box: [0, 0, 200, 200], stretch: [0, 0, 0, 0],
  };
  return { tight: [0, 0, 200, 200], strokes: [st] };
}

/**
 * 依槽位形狀，替部件 `ch` 選出合適的變體。
 *
 * KAGE 把「部件在特定位置的形式」編碼成變體
 * （如 u6728-01 是木在左側的窄形、捺已變點——柱 用的就是這個）。
 * 不選變體、拿泛用字形硬縮，就會出現「木太矮、捺沒變點」這類問題。
 *
 * 規則：放得進槽位者優先；在候選中取與槽位形狀的 IoU 最大；
 * 同分（差距 < 0.02）時偏好名字較單純者（避免被 -var-006 之類擠掉）。
 */
function pickBestVariant(
  L: Lib, cp: number, slot: Box,
): { name: string; idx: number; iou: number } | null {
  const sw = Math.max(1, slot.x2 - slot.x1);
  const sh = Math.max(1, slot.y2 - slot.y1);
  interface Cand { name: string; idx: number; iou: number; fits: boolean; nm: number }
  let best: Cand | null = null;
  let bestAny: Cand | null = null;
  // 走家族表（同一碼位的正字與所有異體），不是走名字字串前綴——
  // 名字已經不是介面了，見 lib-format.ts 開頭。
  for (const i of familyMembers(L, cp)) {
    const n = displayName(L, i);
    const ink = inkIn(L, i);
    const w = ink.x2 - ink.x1, h = ink.y2 - ink.y1;
    // 尺度無關的 IoU：把變體等比放入槽位後的覆蓋率
    const s = Math.min(sw / Math.max(1, w), sh / Math.max(1, h));
    const fw = w * s, fh = h * s;
    const ox = (slot.x1 + slot.x2) / 2 - fw / 2;
    const oy = (slot.y1 + slot.y2) / 2 - fh / 2;
    const ix = Math.max(0, Math.min(ox + fw, slot.x2) - Math.max(ox, slot.x1));
    const iy = Math.max(0, Math.min(oy + fh, slot.y2) - Math.max(oy, slot.y1));
    const inter = ix * iy;
    const cand: Cand = {
      name: n, idx: i,
      iou: inter / (fw * fh + sw * sh - inter),
      // 「放得進」給 10% 的餘裕，而不是硬性要求。
      // 理由：KAGE 自己也不遵守硬性的框界——柱 的左槽位是 72×174，
      // 而它實際用的 u6728-01 墨跡是 78×174，本來就略寬於槽位。
      // 若堅持必須放得進，會把正確的變體排除掉（漢氵木 就是這樣選不到）。
      fits: w <= sw * 1.1 + 1 && h <= sh * 1.1 + 1,
      nm: (/@/.test(n) ? 2 : 0) + (/-var/.test(n) ? 1 : 0) + n.length * 0.001,
    };
    if (cand.fits && (best === null ||
        (Math.abs(cand.iou - best.iou) > 0.02 ? cand.iou > best.iou : cand.nm < best.nm))) {
      best = cand;
    }
    if (bestAny === null ||
        (Math.abs(cand.iou - bestAny.iou) > 0.02 ? cand.iou > bestAny.iou : cand.nm < bestAny.nm)) {
      bestAny = cand;
    }
  }
  const chosen: Cand | null = best ?? bestAny;
  return chosen ? { name: chosen.name, idx: chosen.idx, iou: chosen.iou } : null;
}

/** 一次替換的品質紀錄（給 UI 判「好不好看」用，也讓掃描工具能排序候選） */
export interface FitStep {
  oldCh: string;
  newCh: string;
  /** 用掉的字形名（可能是變體） */
  usedName: string;
  /**
   * 縮放倍率。
   *   1    ＝ 沿用原框（保真度最好；`寶缶支` 就是這種）
   *   <1   ＝ 放不下、被等比縮小。**縮得越多越醜**——
   *          提案說「行舞不好看」，就是這個數字很小。
   */
  scale: number;
  /** 與槽位形狀的長寬比差異（%） */
  arDiff: number;
  /** 溢出原槽位的格數 */
  overflow: number;
  /** 是否沿用原框（完全沒動框） */
  keptBox: boolean;
}

export interface FitComposeOk {
  lib: Lib;
  targetIdx: number;
  log: string[];
  /** 依 pairs 順序的品質紀錄 */
  steps: FitStep[];
}
export type FitComposeResult = FitComposeOk | { error: string };

/**
 * 組字選項。
 *
 * `band`（預設 true）＝**同層讓位**：新內容如果會壓到同層兄弟的墨跡，
 * 就把框退到兄弟之外的帶狀區（見 `refitBand`）。
 * 關掉就回到舊行為「一律沿用原框」。留這個開關是因為它是版面色決定，
 * 要能用同一份資料把兩種結果並排給人看（`tools/band-compare.ts`）。
 */
export interface FitOptions {
  band?: boolean;
}

export function composeFit(
  L: Lib, baseCh: string, pairs: [string, string][], opts: FitOptions = {},
): FitComposeResult {
  const useBand = opts.band !== false;
  ensureEngine();
  const baseIdx = indexOfChar(L, baseCh);
  if (baseIdx === undefined) return { error: `主字「${baseCh}」不在字形庫中` };

  const glyphs: Glyph[] = L.glyphs.map((g) => ({ tight: g.tight, strokes: g.strokes }));
  const log: string[] = [];
  const steps: FitStep[] = [];
  const cur: Lib = { ...L, glyphs };

  for (const [oldCh, newCh] of pairs) {
    const oldCp = oldCh.codePointAt(0)!;
    const toIdx = indexOfChar(L, newCh);
    if (toIdx === undefined) return { error: `替換部件「${newCh}」不在字形庫中` };

    const slot = findSlot(cur, baseIdx, oldCp);
    if (!slot) return { error: `主字「${baseCh}」的結構中找不到部件「${oldCh}」` };

    const oldInk = inkOfRefInParent(cur, slot.parent, slot.strokeIx);
    const parent0 = glyphs[slot.parent]!;
    const oldStroke = parent0.strokes[slot.strokeIx]!;

    // ---- 決策順序（保真度優先）----
    //   1. 泛用字形能否用原框放進去？能 → 完全不動（寶缶支 就是這種，實測完美）
    //   2. 不能（如 木 換 氵，比例差三倍）→ 才去挑該部件的**變體**
    //      KAGE 把「部件在某位置的形式」編碼成變體：
    //        u6728-01 木在左側＝窄形、捺已變點（柱 用的就是這個）
    //   3. 變體也放不下 → 等比縮小並置中
    //
    // 為什麼不一律先挑變體：那會把本來就放得進的替換（如 支 換 缶）
    // 也換成別的變體並縮小，反而失去原本的保真度。
    let pick: { name: string; idx: number; iou: number } | null = null;
    let useIdx = toIdx;
    let pickNote = "";

    const setRef = (ref: number, box: number[], stretch: number[]) => {
      const strokes = parent0.strokes.slice();
      strokes[slot.strokeIx] = { ...oldStroke, ref, box, stretch };
      glyphs[slot.parent] = { tight: parent0.tight, strokes };
    };

    // ---- 步驟 1：先試泛用字形 + 原框（保真度最好）----
    setRef(useIdx, oldStroke.box!.slice(), oldStroke.stretch!.slice());
    let trialInk = inkOfRefInParent(cur, slot.parent, slot.strokeIx);

    const sw0 = Math.max(1, oldInk.x2 - oldInk.x1);
    const sh0 = Math.max(1, oldInk.y2 - oldInk.y1);

    // 沿用原框的判準（單一，兩段都用同一套，避免混用不同量測）：
    //   A. 形狀（長寬比）與槽位相近 → 這個部件在該位置「形式正確」
    //   B. 不超出父字本身範圍太多 → 不溢出字身
    //
    // 為什麼 A 必要：實測 漢 氵→木，泛用木沿用後比例 0.33→0.75（差 125%）——
    //   面積看起來沒超多少，形狀卻完全走樣。這正是「木太矮」的成因。
    // 為什麼不要求「落在原部件區域內」：太嚴。木換三點水本來就會寬一些，
    //   只要不超出字身即可。
    const TOL_AR = 0.25; // 長寬比相差 25% 以內才算形狀相近
    const parentInk = inkIn(cur, slot.parent);
    const PAD = 2;
    const arOf = (t: typeof trialInk) =>
      (t.x2 - t.x1) / Math.max(1, t.y2 - t.y1);
    const overOf = (t: typeof trialInk) =>
      Math.max(0, parentInk.x1 - t.x1) + Math.max(0, t.x2 - parentInk.x2) +
      Math.max(0, parentInk.y1 - t.y1) + Math.max(0, t.y2 - parentInk.y2);
    const arDiffOf = (t: typeof trialInk) =>
      (Math.abs(arOf(t) - sw0 / sh0) / Math.max(0.01, sw0 / sh0)) * 100;
    const fitsIn = (t: typeof trialInk) =>
      arDiffOf(t) <= TOL_AR * 100 &&
      t.x1 >= parentInk.x1 - PAD && t.x2 <= parentInk.x2 + PAD &&
      t.y1 >= parentInk.y1 - PAD && t.y2 <= parentInk.y2 + PAD;

    let within = fitsIn(trialInk);
    let trialNote = "泛用字形";
    if (!within) trialNote = `泛用字形（形狀差 ${arDiffOf(trialInk).toFixed(0)}%、超出字身 ${overOf(trialInk).toFixed(1)}）`;

    // ---- 步驟 2：泛用字形不行 → 挑變體再試 ----
    if (!within) {
      const p2 = pickBestVariant(cur, newCh.codePointAt(0)!, oldInk);
      if (p2) {
        useIdx = p2.idx;
        pickNote = `（選用 ${p2.name}，IoU ${p2.iou.toFixed(2)}）`;
        setRef(useIdx, oldStroke.box!.slice(), oldStroke.stretch!.slice());
        trialInk = inkOfRefInParent(cur, slot.parent, slot.strokeIx);
        within = fitsIn(trialInk);
        trialNote = within
          ? "變體"
          : trialNote + `；變體 ${p2.name}（形狀差 ${arDiffOf(trialInk).toFixed(0)}%、超出字身 ${overOf(trialInk).toFixed(1)}）`;
      }
    }
    pick = null; // 只用於記錄，避免後面誤用

    // ---- 步驟 2.5：同層讓位 ----
    //
    // 沿用舊框的前提是「新舊內容差不多大」。`寶 的 貝 → 𩀨` 差了一倍
    // （貝 88 格高、𩀨 171 格高），沿用舊框會讓新內容直接壓到上面的「宀王缶」，
    // 整個字糊成一團。所以縮小之前先問一句「有沒有壓到兄弟」，
    // 有就退到兄弟之外的帶狀區（沿版面軸延伸到畫布邊緣）。
    //
    // 放在挑變體**之後**：變體選擇解決的是「形狀對不對」（木在左要變窄、捺變點），
    // 讓位解決的是「有沒有位置」，兩者不能互相取代。
    // **只動這一個框**——框是人工資產，兄弟的框不碰。
    //
    // 注意這裡**不能**寫成 `if (!within)`：`fitsIn` 只看形狀與字身，
    // 完全不管同層有沒有別人。實測 `貝 → 𩀨` 的形狀差是 24.4%，
    // 剛好壓在 25% 門檻底下所以 `within` 是 true——但它其實壓了兄弟 46 格。
    {
      const band = useBand
        ? refitBand(cur, slot.parent, slot.strokeIx, oldStroke.box!, trialInk, oldInk)
        : null;
      if (band) {
        setRef(useIdx, band, [0, 0, 0, 0]);
        trialInk = inkOfRefInParent(cur, slot.parent, slot.strokeIx);
        const over =
          Math.max(0, oldInk.x1 - trialInk.x1) + Math.max(0, trialInk.x2 - oldInk.x2) +
          Math.max(0, oldInk.y1 - trialInk.y1) + Math.max(0, trialInk.y2 - oldInk.y2);
        const arSlot2 = sw0 / sh0;
        const arTrial = (trialInk.x2 - trialInk.x1) / Math.max(1, trialInk.y2 - trialInk.y1);
        steps.push({
          oldCh, newCh, usedName: displayName(L, useIdx),
          scale: 1, arDiff: (Math.abs(arTrial - arSlot2) / Math.max(0.01, arSlot2)) * 100,
          overflow: over, keptBox: false,
        });
        log.push(
          `${oldCh} → ${newCh}${pickNote}：沿用原框會壓到同層的兄弟 → ` +
          `讓位到框[${band.join(",")}]（沿版面軸延伸到畫布邊緣，兄弟不動）`,
        );
        continue;
      }
    }

    if (within) {
      const over =
        Math.max(0, oldInk.x1 - trialInk.x1) + Math.max(0, trialInk.x2 - oldInk.x2) +
        Math.max(0, oldInk.y1 - trialInk.y1) + Math.max(0, trialInk.y2 - oldInk.y2);
      const arSlot = sw0 / sh0;
      const arTrial = (trialInk.x2 - trialInk.x1) / Math.max(1, trialInk.y2 - trialInk.y1);
      const arDiff = (Math.abs(arTrial - arSlot) / Math.max(0.01, arSlot)) * 100;
      steps.push({
        oldCh, newCh, usedName: displayName(L, useIdx),
        scale: 1, arDiff, overflow: over, keptBox: true,
      });
      log.push(
        `${oldCh} → ${newCh}${pickNote}：沿用原框（${trialNote}；溢出 ${over.toFixed(1)} 格）`,
      );
      continue;
    }

    // ---- 步驟 3：還是放不下 → 用「框」直接指定等比縮放與位置 ----
    //
    // 實測出的 kage 映射規則：引用框 [bx1,by1,bx2,by2] 會把
    // 「子字形筆畫的緊框」等比縮放置中到該框的矩形。
    // 所以框邊長 / 200 就是縮放倍率，框中心就是放置中心（伸縮=0 時）。
    //
    // 因此不需要包裝層：框大小與中心即可同時決定縮放與位置。
    const childInk = inkIn(cur, useIdx);          // 子墨跡（子空間）
    const cw = Math.max(1, childInk.x2 - childInk.x1);
    const chh = Math.max(1, childInk.y2 - childInk.y1);
    const sw = Math.max(1, oldInk.x2 - oldInk.x1);
    const sh = Math.max(1, oldInk.y2 - oldInk.y1);
    // 等比縮到能放進原區域（不放大）
    const k = Math.min(sw / cw, sh / chh, 1);
    const side = 200 * k;
    const cx = (oldInk.x1 + oldInk.x2) / 2;
    const cy = (oldInk.y1 + oldInk.y2) / 2;
    setRef(
      useIdx,
      [Math.round(cx - side / 2), Math.round(cy - side / 2),
       Math.round(cx + side / 2), Math.round(cy + side / 2)],
      [0, 0, 0, 0],
    );
    // 量測後做一次平移修正（映射是仿射，一次即精確）
    const afterInk = inkOfRefInParent(cur, slot.parent, slot.strokeIx);
    const dx = cx - (afterInk.x1 + afterInk.x2) / 2;
    const dy = cy - (afterInk.y1 + afterInk.y2) / 2;
    setRef(
      useIdx,
      [Math.round(cx - side / 2 + dx), Math.round(cy - side / 2 + dy),
       Math.round(cx + side / 2 + dx), Math.round(cy + side / 2 + dy)],
      [0, 0, 0, 0],
    );

    // 縮放後的實際形狀差（用 has 修正後的最終落點量，才不會記到中間狀態）
    const finInk = inkOfRefInParent(cur, slot.parent, slot.strokeIx);
    const arFin = (finInk.x2 - finInk.x1) / Math.max(1, finInk.y2 - finInk.y1);
    steps.push({
      oldCh, newCh, usedName: displayName(L, useIdx),
      scale: k,
      arDiff: (Math.abs(arFin - sw / sh) / Math.max(0.01, sw / sh)) * 100,
      overflow: 0,
      keptBox: false,
    });
    log.push(
      `${oldCh} → ${newCh}${pickNote}：${trialNote}；原區域 ${sw.toFixed(0)}×${sh.toFixed(0)}，` +
      `新部件 ${cw.toFixed(0)}×${chh.toFixed(0)} 放不下 → 等比縮至 ${(k * 100).toFixed(0)}% 並置中`,
    );
  }
  return { lib: cur, targetIdx: baseIdx, log, steps };
}

/** 用（可能已改寫的）庫產生 SVG（Node 端測試用） */
export function svgOf(L: Lib, idx: number): string {
  ensureEngine();
  const kage = new Kage();
  const seen = new Set<number>();
  const stack = [idx];
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const g = L.glyphs[i]!;
    kage.kBuhin.push(keyOfIdx(L, i), toKageData(g, L));
    for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  const polys = new Polygons();
  kage.makeGlyph(polys, keyOfIdx(L, idx));
  // 與網頁端同一個處理：移除 width/height 並確保有 viewBox，
  // 否則產出的 SVG 放進 1em 的內文裡會沒有尺寸（CLI 產圖與網頁不一致過）。
  return normalizeSvg(polys.generateSVG(true));
}

/** 移除 width/height、確保有 viewBox——內嵌 1em 的前提 */
export function normalizeSvg(svg: string): string {
  return svg.replace(/<svg\b[^>]*>/, (tag) => {
    const cleaned = tag.replace(/\swidth="[^"]*"/g, "").replace(/\sheight="[^"]*"/g, "");
    return /viewBox=/.test(cleaned)
      ? cleaned
      : cleaned.replace(/<svg\b/, '<svg viewBox="0 0 200 200"');
  });
}

// ---------------------------------------------------------------- CLI 測試

if (import.meta.main) {
  const lib = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${PROJ_ROOT}/out/lib-cjk.bin.gz`))));
  const cases: [string, [string, string][]][] = [
    ["盟", [["皿", "月"]]],
    ["寶", [["缶", "支"]]],
    ["盟", [["皿", "日"]]],
    ["漢", [["氵", "木"]]],
  ];
  const cells: string[] = [];
  let x = 0;
  const S = 200;
  for (const [base, pairs] of cases) {
    const label = base + pairs.map(([a, b]) => a + b).join("");
    const baseI = indexOfChar(lib, base)!;
    const before = inkIn(lib, baseI);
    const r = composeFit(lib, base, pairs);
    if ("error" in r) { console.log(`✗ ${label}: ${r.error}`); continue; }
    const after = inkIn(r.lib, r.targetIdx);
    const f = (b: Box) => [b.x1, b.y1, b.x2, b.y2].map((v) => v.toFixed(0)).join(",");
    console.log(`✓ ${label}: ${r.log.join("、")}`);
    console.log(`    原字 [${f(before)}] → 組字後 [${f(after)}]`);
    const svg = svgOf(r.lib, r.targetIdx);
    const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "");
    cells.push(`<g transform="translate(${x},0)">${inner}</g>`);
    cells.push(`<text x="${x + S / 2}" y="${S + 18}" text-anchor="middle" font-size="14" fill="#333" font-family="sans-serif">${label}</text>`);
    x += S;
  }
  const out = `<svg xmlns="http://www.w3.org/2000/svg" width="${x}" height="${S + 28}" viewBox="0 0 ${x} ${S + 28}"><rect width="100%" height="100%" fill="#fff"/><g fill="#111">${cells.join("")}</g></svg>`;
  Bun.write(`${PROJ_ROOT}/out/fit-test.svg`, out);
  console.log(`\n已寫出 fit-test.svg（${x}px）`);
}

