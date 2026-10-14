/**
 * ids-source.ts — 讀新的 IDS 來源（`ids/ids_lv1.txt` 等）並取出「直接分量」。
 *
 * 為什麼要換來源：目前字庫的分解來自**舊的 CHISE 資料**（`db` 的 `ids` / `ids_comp` 表），
 * 它把 `藵` 寫成 `⿱艹褒`（多了一個 `亠`，見 `組字結構.md` §6.6）。
 * 新的來源（`ids/`，MIT 授權）把 `藵` 的主要拆法寫成 **`⿱艹𧛱`**（＝我們畫法引用的東西 ✓），
 * 替代拆法才是 `⿱葆衣`（使用者指出的那一個 ✓）。而且它有**多重拆法**。
 *
 * 三個等級（README）：
 *   `ids_lv0`：筆畫級（用 `.` 標筆畫、附 `H/J/T` 筆形指示）——太細。
 *   `ids_lv1`：**部件級**（筆畫差異合併）← 我們要的「視覺拆分」。
 *   `ids_lv2`：再把 UCV 可統一的異體合併（更寬）。
 *
 * 檔案格式：`字 \t 主要:IDS;IDS;… \t 替代:IDS;…`
 *   每個序列後面可能帶著 `(...)` 的變體標記（要剝掉）；
 *   分量可能是：一個字（→ 碼位）、`&NAME;`（沒有碼位的構件）、`#…`（筆形）、`{…}`／`[…]`（分組）。
 *
 * 用法：
 *   const tab = loadIdsFile("ids/ids_lv1.txt");
 *   directComponents(tab.get(0x85f5)!.primary[0])  // → [0x8279(艹), 0x276F1(𧛱)]
 */
import { readFileSync } from "node:fs";

export interface IdsEntry {
  /** 主要拆法（第一個是我們要用的那個） */
  primary: string[];
  /** 替代拆法（例：`藵` 的 `⿱葆衣`） */
  alt: string[];
}

/** IDS 算子 → 分量數 */
const OP_ARITY: Record<string, number> = {
  "⿰": 2, "⿱": 2, "⿲": 3, "⿳": 3, "⿴": 2, "⿵": 2, "⿶": 2, "⿷": 2,
  "⿸": 2, "⿹": 2, "⿺": 2, "⿻": 2,
};

/** 剝掉序列尾端的變體標記 `(.,H)` */
export function stripIndicators(seq: string): string {
  return seq.replace(/\([^)]*\)\s*$/, "").trim();
}

/** 讀一個等級的檔案：字元 → { primary, alt } */
export function loadIdsFile(path: string): Map<number, IdsEntry> {
  const out = new Map<number, IdsEntry>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const col = line.split("\t");
    if (col.length < 2) continue;
    const ch = col[0]!.trim();
    if (!ch) continue;
    const cp = Array.from(ch)[0]!.codePointAt(0)!;
    const primary = (col[1] ?? "").split(";").map((s) => stripIndicators(s)).filter(Boolean);
    const alt = (col[2] ?? "").split(";").map((s) => stripIndicators(s)).filter(Boolean);
    if (primary.length || alt.length) out.set(cp, { primary, alt });
  }
  return out;
}

/**
 * 一個 IDS 序列的**直接分量**（頂層算子的運算元），只留有碼位的字。
 * 沒有算子（獨體、或是 `#` 筆形／`&NAME;` 構件）→ 回空陣列。
 */
export function directComponents(seq: string): number[] {
  const chars = Array.from(stripIndicators(seq));
  if (!chars.length || OP_ARITY[chars[0]!] === undefined) return [];
  /* 含筆形／構件／分組標記的序列一律當「沒有分解」：`#`＝筆形描述、`&`＝無碼位構件、
     `{`／`[`＝分組，這些都不是可以直接用的分量。（第 50 輪的教訓：`木` 被拆成 十+亻+丨+一） */
  if (chars.some((c) => c === "#" || c === "&" || c === "{" || c === "[" || c === "]")) return [];
  const arity = OP_ARITY[chars[0]!]!;
  const operands = chars.slice(1, 1 + arity);
  const out: number[] = [];
  for (const o of operands) {
    if (o === "#" || o === "&" || o === "{" || o === "[" || OP_ARITY[o] !== undefined) continue;
    const cp = o.codePointAt(0);
    if (cp !== undefined) out.push(cp);
  }
  return out;
}

/**
 * 便利：**主要拆法**的直接分量。
 *
 * 只取 `primary` 的**第一個序列**，而且**絕不碰 `alt`**：
 * `alt` 是「另一種拆法」（例 `藵` 的 `⿱葆衣`），是**並列的可能性**，不是補充分量清單；
 * 把它混進來會讓 `木`（主要 `⿻十人`、替代 `⿻丨𠆣`）變成 十+人+丨+𠆣 ✗（第 50 輪的錯）。
 * 沒有 IDS 算子（獨體字、筆形描述）→ 回空陣列（＝沒有分解）。
 */
export function primaryComponents(entry: IdsEntry | undefined): number[] {
  if (!entry || !entry.primary.length) return [];
  const comps = directComponents(entry.primary[0]!);
  return comps.length >= 2 ? comps : [];
}
