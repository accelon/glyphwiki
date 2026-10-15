#!/usr/bin/env bun
/**
 * ids-glyph.ts — **從 IDS 產生字形**（只讀既有資料，不計算「美觀的框」✗）。
 *
 * 這是 `glyph-by-ids.md` 的主模塊 ✓：IDS 是 prefix notation，按比例分框，
 * 一個 IDS 越到後面框越小 ✓（正常的 ✓）——**只要框不重疊，筆劃就不會大面積交錯** ✓。
 *
 * ============================ 量出來的事實（先量，不要推導 ✓）============================
 *
 * 1. **引擎對 kind-99 框的語意是「等比縮放後置中」** ✓（`out/_probe-ids-frame.ts` 實測）：
 *    框 `[0,0,100,200]` 裝墨跡 `108×136` 的子字形 → `k = min(100/108, 200/136) = 0.926`，
 *    結果貼在 `[0,37,100,163]` ✓ ——**不會溢出框** ✓、**不會變形** ✓。
 *    ⚠ 這與「框是內容框、子字形**非等比**映射進去」的舊假設**不同** ✗（`技術交接文件.md` §2.5 要更正）：
 *      實測是**等比置中**（與 §9.4「放得進槽位」的敘述一致 ✓）。
 *
 * 2. 所以「**把部件縮進它那一格**」＝ **保證框不重疊** ✓ ＝ 保證筆劃不交錯 ✓。
 *    反過來，現行的「不縮放、只擺位」（`pinxing-page.js` 的 `idsComposeNaive`）
 *    在 `⿰日月` 上實測**水平重疊 54.9 格** ✗（兩塊各 200×200 擺在兩個中心 ✓）——
 *    這正是師父說的「筆劃大面積交錯」✗。
 *    ★ 兩者都醜 ✓：前者是「小而不交錯」✓、後者是「大而交錯」✗。本模塊採**前者** ✓。
 *
 * ============================ 版面規則 ============================
 *
 * 每個節點拿一個**矩形區域**，由算子在區域內**等比分配**（＝師父說的「按比例分框」✓）：
 *
 *   | 算子 | 分配 |
 *   |---|---|
 *   | ⿰ ⿲ | 橫向 2／3 等分 |
 *   | ⿱ ⿳ | 縱向 2／3 等分 |
 *   | ⿴ ⿵ ⿶ ⿷ ⿸ ⿹ ⿺ | **包含型**：外件佔滿、內件內縮 15%（見 IDF_INSET） |
 *   | ⿻ | 重疊型：兩件同一區域（重疊是它的本意 ✓） |
 *
 *   ★ 巢狀**自動正確** ✓：`⿰⿱日月皿` 的 日／月 各得 100×100（＝25% ✓）、皿得 100×200（＝50% ✓），
 *     因為區域是**遞迴**相乘的 ✓——不需要為「越到後面框越小」寫任何特例 ✓。
 *
 * ⚠ **只讀既有的框／字形，不優化** ✗：葉子的字形一律取 `indexOfCodePoint` 的**代表字形**
 *   （＝家族裡 `pref` 指到的那個 ✓，零新增資料 ✓）。
 *
 * ============================ 用法 ============================
 *
 *   bun run tools/ids-glyph.ts --ids "⿰日月"                       # 印報告（框、葉、警告）
 *   bun run tools/ids-glyph.ts --ids "⿰日月" --html out/x.html     # 並排圖（需要 Edge 截圖）
 *   bun run tools/ids-glyph.ts --ids "⿰日月" --png out/x.png
 */
import { writeFileSync, existsSync, unlinkSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
/* ★★ **只有型別從 `lib-format.ts` 進來** ✓（`import type` 編譯後會整個消失 ✓）——
   執行期用到的 `indexOfCodePoint`／`forkLibrary`／`drawingIdx` 一律**直接呼叫裸名** ✓。
   為什麼（這一條是內嵌頁面的**鐵律** ✗）：`embed-common.ts` 會把每個模塊的 `import` 拿掉、
   把 `export` 拿掉、全部擠進**同一個作用域** ✓。所以：
     * 寫 `LF.indexOfCodePoint` ✗ → 頁面上沒有 `LF` 這個名字 → ReferenceError（Node 端卻正常 ✗）；
     * 寫裸名 `indexOfCodePoint` ✓ → Node 端靠上面的 import 綁定 ✓、頁面上靠同一個作用域的函式 ✓
       ——**兩邊都對** ✓。
   （第一版就是踩了這個坑：Node 全綠、頁面會炸 ✗，而且**只有真的踩到那條路才會炸** ✗。） */
import type { Library as LFLibrary, Stroke as LFStroke, Glyph as LFGlyph } from "./lib-format.ts";
/* 執行期要用的兩個函式**直接 import** ✓（Node 端靠這一行綁定 ✓）；
   內嵌進頁面時這一行會被 `embed-common.ts` 的 `replace(/^import.../)` 整行拿掉 ✓，
   裸名就指向同一作用域裡的同名函式 ✓——**這就是「兩邊都對」的寫法** ✓。 */
import { indexOfCodePoint, forkLibrary } from "./lib-format.ts";
import { drawingIdx } from "./free-compose.ts";
import { loadLibrary } from "./lib-load.ts";
/* ⚠ `svgOf` 與 `drawingIdx` 只在 CLI 那一段用得到，所以放**動態** import ✓：
   靜態 import 會多兩條內嵌順序的硬依賴 ✗。
   ⚠ 但**不可以**在頂層用 `await import` ✗——`embed-common.ts` 的整頁語法檢查用的是
     `new Function(...)`（非 async ✗），頂層 await 會讓它直接失敗 ✓（這一條也踩過 ✓）。
   所以放進 CLI 的 `if (import.meta.main)` 裡面用 await ✓（那段反正會被切掉 ✓）。 */

/* ============================ IDS 解析 ============================ */

/** 算子的分量數 ✓（U+2FF0–U+2FFF 全部 ✓） */
export const IDF_ARITY: Record<string, number> = {
  "⿰": 2, "⿱": 2, "⿲": 3, "⿳": 3, "⿴": 2, "⿵": 2, "⿶": 2, "⿷": 2,
  "⿸": 2, "⿹": 2, "⿺": 2, "⿻": 2,
};
/** 算子的**人話**名字 ✓——很多系統字型沒有 U+2FF0–2FFF ✗（實測 headless Edge 全變方框 ▯），
 *  所以任何給客人看的訊息**不可以只印原始 IDS** ✗。 */
export const IDF_OPNAME: Record<string, string> = {
  "⿰": "左右", "⿱": "上下", "⿲": "左中右", "⿳": "上中下",
  "⿴": "全包", "⿵": "上包", "⿶": "下包", "⿷": "左包",
  "⿸": "左上包", "⿹": "右上包", "⿺": "左下包", "⿻": "重疊",
};
/** **包含型**算子（外件佔滿、內件內縮 ✓）——它們**不分割**空間 ✗（見 `glyph-by-ids.md`：
 *  「包含型 ⿴⿸⿵ ，則要預先算好可塞入部件的框。如 产厂⿸ ，這樣的部件並不多 ✓」）。 */
export const IDF_CONTAIN: Record<string, number[]> = {
  "⿴": [1], "⿵": [1], "⿶": [1], "⿷": [1], "⿸": [1], "⿹": [1], "⿺": [1],
};
/** 內件的內縮比例 ✓（0.15 ＝ 四周各讓 15% ✓）。我們**不優化**它 ✗——
 *  它是版面的**粗坯**（師父第 126 輪：「一看就知道系統沒有布局資訊」✓）。 */
export const IDF_INSET = 0.15;

/** IDS 樹的節點 ✓ */
export type IdsNode =
  | { op: string; kids: IdsNode[] }
  | { ch: string; cp: number };

/** 解析 IDS（**嚴格 prefix notation** ✓：多一個字、少一個字都算失敗 ✓回 null）。 */
export function parseIds(s: string): IdsNode | null {
  const cs = Array.from(String(s).replace(/\s+/g, ""));
  let i = 0;
  const walk = (): IdsNode | null => {
    if (i >= cs.length) return null;
    const c = cs[i]!;
    /* `&CDP-xxxx;` 這類**不在 Unicode 裡的部件**（IDS 來源的寫法）——誠實拒絕 ✓
       （我們的字庫沒有它們，硬畫只會畫出錯的字 ✗）。 */
    if (c === "&" || c === "{" || c === "[" || c === "#" || c === "(") return null;
    if (IDF_ARITY[c] !== undefined) {
      i++;
      const kids: IdsNode[] = [];
      for (let k = 0; k < IDF_ARITY[c]!; k++) {
        const kid = walk();
        if (!kid) return null;
        kids.push(kid);
      }
      return { op: c, kids };
    }
    i++;
    return { ch: c, cp: c.codePointAt(0)! };
  };
  const root = walk();
  return root && i === cs.length ? root : null;
}

/** 葉（有序 ✓）——回傳碼位 ✓ */
export function idsLeaves(n: IdsNode): number[] {
  if ("cp" in n) return [n.cp];
  const out: number[] = [];
  for (const k of n.kids) for (const v of idsLeaves(k)) out.push(v);
  return out;
}

/** IDS → 人話 ✓（例 `左右(木｜垚)` ✓）——給訊息用 ✓（見 IDF_OPNAME 的理由 ✓）。 */
export function idsText(s: string): string {
  const root = parseIds(s);
  if (!root) return String(s);
  const walk = (n: IdsNode): string =>
    "ch" in n ? n.ch : IDF_OPNAME[n.op] + "(" + n.kids.map(walk).join("｜") + ")";
  return walk(root);
}
/** 葉序的人話（`木,垚` 這種 ✓） */
export function idsLeafText(n: IdsNode): string {
  return idsLeaves(n).map((cp) => String.fromCodePoint(cp)).join(" ");
}

/* ============================ 版面（分框） ============================ */

/** 一個葉的落點：碼位 ＋ 框（父座標系、200×200 ✓） */
export interface IdsSlot { cp: number; box: number[]; path: string; }

/** 走一遍 IDS 的版面樹 ✓（`planIds` 與 `idfWalkOk` 共用**同一支** walker ✓）——
 *  ⚠ 不要寫兩份 ✗：兩份分框實作只要有一邊改了，驗收就會「對著舊規則說全綠」✗
 *    （本專案吃過這個虧：見 `format.md` 的 IDS 章節 ✓）。 */
function idfWalk(root: IdsNode, box: number[], visit: (sl: IdsSlot) => void): void {
  const walk = (n: IdsNode, b: number[], path: string): void => {
    if ("cp" in n) { visit({ cp: n.cp, box: b.slice(), path: path }); return; }
    const op = n.op;
    const x0 = b[0]!, y0 = b[1]!, x1 = b[2]!, y1 = b[3]!;
    const w = x1 - x0, h = y1 - y0;
    for (let j = 0; j < n.kids.length; j++) {
      const kid = n.kids[j]!;
      const p = path + "/" + j;
      if (op === "⿰") walk(kid, [x0 + w * j / 2, y0, x0 + w * (j + 1) / 2, y1], p);
      else if (op === "⿱") walk(kid, [x0, y0 + h * j / 2, x1, y0 + h * (j + 1) / 2], p);
      else if (op === "⿲") walk(kid, [x0 + w * j / 3, y0, x0 + w * (j + 1) / 3, y1], p);
      else if (op === "⿳") walk(kid, [x0, y0 + h * j / 3, x1, y0 + h * (j + 1) / 3], p);
      else if (op === "⿻") walk(kid, [x0, y0, x1, y1], p);           /* 重疊是它的本意 ✓ */
      else if (IDF_CONTAIN[op]) {
        if (j === 0) walk(kid, [x0, y0, x1, y1], p);                  /* 外件佔滿 ✓ */
        else walk(kid, [x0 + w * IDF_INSET, y0 + h * IDF_INSET,
                        x1 - w * IDF_INSET, y1 - h * IDF_INSET], p);  /* 內件內縮 ✓ */
      } else walk(kid, [x0, y0, x1, y1], p);
    }
  };
  walk(root, box, "");
}

/** 把 IDS 的葉按算子**等比分配**到 200×200 ✓（不重疊 ✓、巢狀自動正確 ✓）。 */
export function planIds(root: IdsNode): IdsSlot[] {
  const out: IdsSlot[] = [];
  idfWalk(root, [0, 0, 200, 200], (sl) => out.push(sl));
  return out;
}

/** **驗收用**：走一遍確認「每一葉的框**落在**上層分給它的區域裡」✓。
 *  這是「框不重疊」的**充分條件** ✓（每個葉都在自己的區域內 → 兄弟區域不重疊 → 兩兩不重疊 ✓）——
 *  ⚠ 但**包含型／重疊型算子不算** ✗（`⿴囗玉` 的外框與內容本來就疊在同一塊 ✓ 那是它的本意 ✓）。
 *  ⚠ 用**同一支 walker** ✓（不要另寫一份分框 ✗——兩份只要有一邊改了，
 *    驗收就會「對著舊規則說全綠」✗，本專案吃過這個虧 ✓）。 */
export function idfWalkOk(root: IdsNode, box: number[] = [0, 0, 200, 200]): string[] {
  const bad: string[] = [];
  const eps = 1e-9;
  const walk = (n: IdsNode, b: number[], path: string): void => {
    /* 這一層的區域必須落在上層給的區域內 ✓（遞迴成立 → 全樹成立 ✓） */
    const inside = b[0]! >= box[0]! - eps && b[1]! >= box[1]! - eps &&
      b[2]! <= box[2]! + eps && b[3]! <= box[3]! + eps;
    if (!inside) bad.push(path + " 的框跑出上層的區域");
    if ("cp" in n) return;
    const x0 = b[0]!, y0 = b[1]!, x1 = b[2]!, y1 = b[3]!;
    const w = x1 - x0, h = y1 - y0;
    for (let j = 0; j < n.kids.length; j++) {
      const kid = n.kids[j]!;
      const p = path + "/" + j;
      let kb: number[];
      if (n.op === "⿰") kb = [x0 + w * j / 2, y0, x0 + w * (j + 1) / 2, y1];
      else if (n.op === "⿱") kb = [x0, y0 + h * j / 2, x1, y0 + h * (j + 1) / 2];
      else if (n.op === "⿲") kb = [x0 + w * j / 3, y0, x0 + w * (j + 1) / 3, y1];
      else if (n.op === "⿳") kb = [x0, y0 + h * j / 3, x1, y0 + h * (j + 1) / 3];
      else if (n.op === "⿻") kb = [x0, y0, x1, y1];
      else if (IDF_CONTAIN[n.op]) {
        kb = j === 0 ? [x0, y0, x1, y1]
          : [x0 + w * IDF_INSET, y0 + h * IDF_INSET, x1 - w * IDF_INSET, y1 - h * IDF_INSET];
      } else kb = [x0, y0, x1, y1];
      walk(kid, kb, p);
    }
  };
  walk(root, box, "");
  return bad;
}

/* ============================ 畫（造合成字形） ============================ */

export interface IdsGlyphOk {
  ok: true;
  /** 造出來的字形（`lib.glyphs` 的索引 ✓） */
  idx: number;
  /** 一份**分叉**的字庫（原庫 ＋ 這個合成字形 ✓）——交給 `svgOf`／`evalSeq` ✓ */
  lib: LFLibrary;
  /** 每個葉的落點 ✓ */
  slots: IdsSlot[];
  /** 葉子在庫裡找不到字形（例：IDS 引用了我們沒收的部件 ✗） */
  missing: number[];
  /** 壞掉的地方（人話 ✓）：算子位置錯、找不到字形… */
  problems: string[];
  /** 葉數 */
  n: number;
}
export interface IdsGlyphErr { ok: false; problems: string[]; }
export type IdsGlyphResult = IdsGlyphOk | IdsGlyphErr;

/** 找一個現成的 99 引用當**樣板** ✓（照抄欄位、只換框與參照 ✓——KAGE 的欄位很多，
 *  手寫一份只會寫漏 ✗）。 */
function findProto(lib: LFLibrary): LFStroke | null {
  for (let q = 0; q < lib.glyphs.length; q++) {
    for (const s of lib.glyphs[q]!.strokes) if (s.kind === 99 && s.ref !== null) return s;
  }
  return null;
}

/** **從 IDS 產生字形** ✓（本模塊的主函式 ✓）。
 *
 *  ⚠ 只讀既有資料 ✓：葉子的字形＝`indexOfCodePoint`（家族代表字形 ✓）、
 *    框＝等比分配的結果 ✓、伸縮＝0（不額外伸縮 ✓）。**不計算美觀的框** ✗。
 */
export function idsGlyph(ids: string, lib: LFLibrary): IdsGlyphResult {
  const fix = (s: string) => String(s).replace(/\s+/g, "");
  const raw = String(ids);
  const clean = fix(raw);
  if (!clean) return { ok: false, problems: ["IDS 是空的"] };
  const root = parseIds(clean);
  if (!root) {
    return { ok: false, problems: ["解析不了這個 IDS（prefix notation 不完整，或含 &CDP-… 這類非 Unicode 部件）"] };
  }
  const problems: string[] = [];
  /* 唯一的**葉**必須是字：算子跑到葉的位置就是壞 IDS ✗（例 产厂⿸ ✓ 來源就寫壞了）。 */
  const slots = planIds(root).filter((sl) => {
    const ch = String.fromCodePoint(sl.cp);
    if (IDF_ARITY[ch] !== undefined) {
      problems.push("算子「" + ch + "」出現在葉的位置（這個 IDS 的寫法壞了：" +
        "算子要寫在它的分量**前面**）——已略過它");
      return false;
    }
    return true;
  });
  if (!slots.length) return { ok: false, problems: problems.concat(["沒有任何可畫的葉"]) };
  const proto = findProto(lib);
  if (!proto) return { ok: false, problems: problems.concat(["字庫裡找不到 99 引用當樣板"]) };
  const strokes: LFStroke[] = [], missing: number[] = [], kept: IdsSlot[] = [];
  for (const sl of slots) {
    /* ⚠ 這裡**不可以**寫 `indexOfCodePoint` ✗——本模塊會被內嵌進頁面
       （`embed-common.ts` 把 `export` 拿掉、全部擠進同一個作用域 ✓），
       那時沒有 `F` 這個名字 ✗、只有同名函式 ✓。所以一律**直接呼叫** ✓。 */
    const gi = indexOfCodePoint(lib, sl.cp);
    if (gi === undefined) { missing.push(sl.cp); continue; }
    const s: LFStroke = { ...proto };
    s.ref = drawingIdx(lib, gi);
    s.box = sl.box.map((v) => Math.round(v * 100) / 100);
    s.stretch = [0, 0, 0, 0];        /* 0 ＝ 不額外伸縮 ✓（比例由框決定 ✓） */
    strokes.push(s);
    kept.push(sl);
  }
  if (!strokes.length) {
    return { ok: false, problems: problems.concat(
      missing.map((cp) => "字庫裡沒有 " + String.fromCodePoint(cp) + "（U+" + cp.toString(16).toUpperCase() + "）的字形")) };
  }
  if (missing.length) {
    problems.push("字庫裡沒有 " + missing.map((cp) => String.fromCodePoint(cp)).join("、") +
      " ——已略過（畫出來的會少那幾塊）");
  }
  /* 沒有引用任何東西的葉子（純筆畫的字，例如「一」）在 KAGE 裡是**畫出來的** ✓，
     不是引用 ✗——`drawingIdx` 就是處理這件事的（見 free-compose.ts ✓）。 */
  /* ⚠ `forkLibrary` 是**淺複製 + 換掉整個 glyphs** ✗（不是 append ✗）——
     所以要把原庫的字形接在前面 ✓（見 `lib-format.ts` 的 `forkLibrary` 與 `compose` ✓）。 */
  const glyphs = lib.glyphs.slice();
  glyphs.push({ strokes: strokes, tight: null } as LFGlyph);
  const L2 = forkLibrary(lib, glyphs);
  const idx = L2.glyphs.length - 1;
  return { ok: true, idx: idx, lib: L2, slots: kept, missing: missing, problems: problems, n: kept.length };
}

/** ★ **不要在這個模塊裡自己抄一份 `drawingIdx`** ✗（我第一版抄了一份，後來刪掉 ✓）：
 *  內嵌頁面時兩份同義實作會**同名衝突** ✗（整個 script 語法錯誤、整頁空白 ✓）——
 *  這正是 `format.md` 記過的「同一個東西兩份來源各說各話」的坑 ✓。
 *  本模塊**要在 `free-compose` 之後內嵌** ✓（見 `embed-common.ts` 的 MODULES 順序 ✓）。 */

/** **舊版**（第 124～128 輪，已經從頁面上刪掉 ✗）：把每個部件按**自己的大小**擺在
 *  它那一格的**中心** ✓（框一律 200×200 ✓，所以會互相壓上去 ✗）。
 *
 *  留著它的**唯一理由**是當**對照組** ✓：`tools/check-ids-glyph.ts` 用它量出
 *  「舊版 `⿰日月` 水平重疊 54.9 格 ✗ → 新版 0 格 ✓」✓——
 *  這是師父要的「今法對古法的改善」的**量化證據** ✓，不是死碼 ✓。 */
export function idsGlyphNaiveOld(ids: string, lib: LFLibrary): IdsGlyphResult {
  const root = parseIds(ids);
  if (!root) return { ok: false, problems: ["解析不了這個 IDS"] };
  const slots = planIds(root);
  const proto = findProto(lib);
  if (!proto) return { ok: false, problems: ["字庫裡找不到 99 引用當樣板"] };
  const strokes: LFStroke[] = [], missing: number[] = [], kept: IdsSlot[] = [];
  for (const sl of slots) {
    const gi = indexOfCodePoint(lib, sl.cp);
    if (gi === undefined) { missing.push(sl.cp); continue; }
    const cx = (sl.box[0]! + sl.box[2]!) / 2, cy = (sl.box[1]! + sl.box[3]!) / 2;
    const s: LFStroke = { ...proto };
    s.ref = drawingIdx(lib, gi);
    s.box = [cx - 100, cy - 100, cx + 100, cy + 100];
    s.stretch = [0, 0, 0, 0];
    strokes.push(s);
    kept.push(sl);
  }
  if (!strokes.length) return { ok: false, problems: ["沒有任何可畫的葉"] };
  const glyphs = lib.glyphs.slice();
  glyphs.push({ strokes: strokes, tight: null } as LFGlyph);
  const L2 = forkLibrary(lib, glyphs);
  return { ok: true, idx: L2.glyphs.length - 1, lib: L2, slots: kept, missing: missing,
           problems: [], n: kept.length };
}

/* ============================ 報告／CLI ============================ */

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (n: string, d?: string) => {
    const i = argv.indexOf(n);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  const IDS = arg("--ids", "⿰日月")!;
  const ROOT = resolve(import.meta.dir, "..");
  const libPath = resolve(ROOT, arg("--lib", "out/lib-cjk-all.bin.gz")!);
  /* ⚠ `.bin` 是**未壓縮**的、`.gz` 是壓縮的 ✗——`loadLibrary` 只吃 gz ✓，
     所以先看魔數（1F 8B ✓）再決定 ✓，**不要靠副檔名猜** ✗（第一版就猜錯，回
     「incorrect header check」✓）。 */
  const head = new Uint8Array(readFileSync(libPath).slice(0, 2));
  const isGz = head[0] === 0x1f && head[1] === 0x8b;
  const { lib } = loadLibrary(isGz ? libPath : libPath.replace(/\.bin$/, ".bin.gz"), { withNames: true });
  const { svgOf } = await import("./compose-fit.ts");
  const { drawingIdx } = await import("./free-compose.ts");
  const r = idsGlyph(IDS, lib);
  console.log("IDS  " + IDS + "　→　" + idsText(IDS));
  if (!r.ok) {
    for (const p of r.problems) console.log("  ✗ " + p);
    process.exit(1);
  }
  console.log("葉  " + r.n + " 個：" + idsLeafText(parseIds(IDS)!));
  for (const sl of r.slots) {
    console.log("  " + String.fromCodePoint(sl.cp) + "  框 [" + sl.box.map((v) => Math.round(v)).join(",") + "]");
  }
  for (const p of r.problems) console.log("  ⚠ " + p);
  if (r.missing.length) process.exit(1);

  /* 視覺驗收（「顯示類的改動要有一張拍得成的截圖」✓，見 `技術交接文件.md` §15.5-3） */
  const cells: { name: string; svg: string; note: string }[] = [];
  for (const cp of r.slots) {
    const ch = String.fromCodePoint(cp.cp);
    const gi = indexOfCodePoint(lib, cp.cp);
    cells.push({ name: ch, svg: gi === undefined ? "" : svgOf(lib, drawingIdx(lib, gi)),
      note: "[" + cp.box.map((v) => Math.round(v)).join(",") + "]" });
  }
  cells.push({ name: "整字（IDS 粗坯）", svg: svgOf(r.lib, r.idx), note: "按 IDC 等比分配 ✓ 不優化 ✗" });
  const seq = arg("--seq");
  if (seq) {
    const { evalSeq } = await import("./free-compose.ts");
    try {
      const q = evalSeq(lib, seq!, {});
      if (q && q.ok) cells.push({ name: seq!, svg: svgOf(q.lib, q.targetIdx), note: "拼形序（美）" });
      else cells.push({ name: seq!, svg: "", note: "組不出來 ✗" });
    } catch (e) { cells.push({ name: seq!, svg: "", note: "組不出來 ✗" }); }
  }
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'body{margin:0;background:#0b0c0e;color:#e8ecf4;font:13px system-ui,"Microsoft JhengHei",sans-serif}' +
    '.ids{font:26px system-ui,"Microsoft JhengHei",sans-serif;padding:10px 14px;color:#8fd}' +
    '.row{display:flex;gap:12px;padding:12px;flex-wrap:wrap}' +
    '.c{background:#15171b;border:1px solid #2a2e35;border-radius:10px;padding:8px;text-align:center;min-width:120px}' +
    '.g{width:180px;height:180px}.g svg{width:100%;height:100%;display:block;color:#e8ecf4}' +
    '</style></head><body><div class="ids">' + IDS + '　' + idsText(IDS) + '</div><div class="row">' +
    cells.map((c) => '<div class="c"><div class="g">' + c.svg + '</div><div>' + c.name +
      '</div><div style="color:#8a93a3">' + c.note + "</div></div>").join("") +
    "</div></body></html>";
  const htmlOut = arg("--html");
  if (htmlOut) {
    const p = resolve(ROOT, htmlOut!);
    writeFileSync(p, html, "utf8");
    console.log("並排頁：" + p);
  }
  const pngOut = arg("--png");
  if (pngOut) {
    const page = resolve(ROOT, "out/_ids-glyph.html");
    writeFileSync(page, html, "utf8");
    const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    if (!existsSync(EDGE)) { console.log("找不到 Edge（跳過截圖）"); }
    else {
      const shot = resolve(ROOT, pngOut!);
      if (existsSync(shot)) unlinkSync(shot);
      Bun.spawnSync([EDGE, "--headless", "--disable-gpu", "--screenshot=" + shot,
        "--window-size=" + (Math.max(3, cells.length) * 212 + 40) + ",290", "--hide-scrollbars",
        "--virtual-time-budget=3000", "file:///" + page.replace(/\\/g, "/")],
        { stdout: "ignore", stderr: "ignore" });
      console.log(existsSync(shot) ? "截圖：" + shot : "截圖失敗 ✗");
    }
  }
}
/* 瀏覽器內嵌時（`embed-common.ts`）不能用 `import.meta` ✗——
   所以 CLI 一定寫在 `if (import.meta.main)` 裡面 ✓（bundle 會從那裡整段切掉 ✓）。 */
