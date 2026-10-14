/**
 * syn-graph.ts — 異體（syn）圖的**單一來源**：載入、閘門、連通分量。
 *
 * **資料來源已於第 110 輪換成 Unihan（權威）** ✓，理由見 `tools/unihan-variants.ts` 的檔頭：
 *   · 舊的 `out/compat-map.tsv` 是「用 IDS 版本差異**推論**」的，混進了 `口≡土`、`一≡八`
 *     這類假等價（還有一個 `∅` 佔位符污染）✗；
 *   · 師父指示「**異體＝Unicode 認定的 variants（碼位意義）**」→ 改用
 *     `UnicodeData.txt` 的正規單一分解（相容字符）＋ `Unihan_Variants.txt` 的 `kZVariant` ✓。
 *
 * 師父第 110 輪的裁定（不變）：
 *   ① **相容字符 ↔ 正規碼位** ✓ 保留（`滑`＝`滑`：用戶打不出來、當年是為了轉換才保留的）；
 *      —— 現在由 UnicodeData 的**正規分解**決定 ✓（權威），不再用「碼位落在 F900–FAFF」猜 ✗。
 *   ② **`kZVariant`** ✓ 保留（字形差異：`戶/户`、`曶/㫚`）——Unicode 說它們是同一個字。
 *   ③ **手寫的部首形 12 對** ✓ 保留（`⺡/水`、`⺣/火`…；部首不是 Unihan 的範圍）。
 *   ④ **推論來的等價一律不歸併** ✗——現在整個推論表**不再被讀取** ✓。
 *   ⑤ **偏旁形／簡繁／日新舊字體**（`金/釒`、`釒/钅`、`歩/步`）＝ **選項層** ✓
 *      （`unihan-variants.ts` 的 `OPTION_FIELDS`）：資料保留精確資訊，用選項區分專家與普通人 ✓。
 */
import { readFileSync } from "node:fs";
import { loadCompatPairs, loadVariantPairs, SYN_FIELDS, OPTION_FIELDS, type VariantPair } from "./unihan-variants.ts";

/** 部首區段：異體表的端點可以是「不是字」的部首形（⺝ ⺾ ⻏ ⺡…），這是刻意的 ✓ */
export const RADICAL_RANGES: [number, number][] = [
  [0x2e80, 0x2eff],   /* CJK 部首補充 */
  [0x2f00, 0x2fdf],   /* 康熙部首 */
];

/* ─────────────────────────────────────────────────────────────────────────
 * **師父的裁定（第 110 輪，2026-10-14）**——異體表只收兩類：
 *
 *  ① **相容字符 ↔ 正規碼位** ✓ 保留：
 *     師父原話：「F900~FA6D 是一般用戶輸入不了的，是當年 big5, gb2312, JIS 合併時，
 *     為了從 unicode 正確轉換過去而保留的，我想就可以合併到基本字了。
 *     比方說 `滑` 是可以算作 `滑`，只是 `骨` 筆劃的小差異而已，不影響識別文字。」
 *     → 同一個字的兩個碼位 ✓。`FA70–FAD9`（KS X 1001 的韓華字）與 `2F800–2FA1F`
 *       （CNS 11643）是**同一類**東西（都是 Unicode 的**正規等價**、用戶打不出來），照同一條處理 ✓。
 *     ⚠ `F900–FAFF` 裡有 **12 個是一般字**（U+FA0E／FA0F／FA11／FA13／FA14／FA1F／
 *       FA21／FA23／FA24／FA27／FA28／FA29，**沒有正規分解**）→ **不可以**當成相容字符 ✗。
 *
 *  ② **UCV 推論／無來源註記（＝用 IDS 版本差異推出來的等價）** ✗ 不歸併：
 *     師父原話：「UCV推論以及無來源註記，是『徒裁定』的，都不能歸併，不能視為相同。」
 *     → 例如 `口≡土`（21,787 個假命中）、`口≡虫`、`一≡八`、`犬≡大`、`木≡林`。
 *     ⚠ 這一批是**好壞混雜**的：裡面也有「同一偏旁的另一種寫法」（`金/釒`、`竹/𥫗`、
 *       `示/礻`、`牛/牜`、`戶/户`、`真/眞`…），丟掉會少查到約 **9,076** 個
 *       （金/釒 佔 2,223、夂/夊 2,162、示/礻 1,457…）。
 *       要保留哪幾對，**加進下面的 `SYN_WHITELIST`**（附理由）✓，不要放寬規則 ✗。
 *
 *  ③ **部首形（明確列出的）** ✓ 保留：`⺡/水`、`⺣/火`、`⺖/心`…（查字需要）。
 *
 * ⚠ **原始資料列仍留在 `out/compat-map.tsv`**（＝紀錄／證據），只是**不進 syn 表** ✓
 *   ——「不歸併」不等於「把紀錄刪掉」✓。
 * ───────────────────────────────────────────────────────────────────────── */

/** `F900–FAFF` 裡其實是「一般字」（沒有正規分解）的 12 個碼位 */
export const SYN_UNIFIED_IN_COMPAT: number[] = [
  0xfa0e, 0xfa0f, 0xfa11, 0xfa13, 0xfa14, 0xfa1f, 0xfa21, 0xfa23, 0xfa24, 0xfa27, 0xfa28, 0xfa29,
];

/** 相容字符（Unicode 正規等價、一般用戶輸入不了的那一批） */
export function isCompatIdeograph(cp: number): boolean {
  if (cp >= 0xf900 && cp <= 0xfaff) return !SYN_UNIFIED_IN_COMPAT.includes(cp);
  return cp >= 0x2f800 && cp <= 0x2fa1f;
}

/** 手寫的**部首形**（12 對）——部首（2E80–2FDF）不在 Unihan_Variants 的範圍，由本專案列出 ✓。
 *  來源是頁面／舊表整理出來的 12 列（`out/compat-map.tsv` 裡標「部首」的那些）。
 *  ⚠ 頁面另有一份手寫的 `RADICAL_SYN`（部首→本字），那一份是**查詢用**的，與這裡互補 ✓。 */
export const RADICAL_FORM_PAIRS: [number, number, string][] = [
  [0x2EDE, 0x98DF, "⻞/食"],  // 食（左偏旁形）
  [0x2E9F, 0x6BCD, "⺟/母"],
  [0x2ED6, 0x961C, "⻖/阜"],  // 左阝
  [0x2ECF, 0x9091, "⻏/邑"],  // 右阝
  [0x2E98, 0x624B, "⺘/手"],  // 扌
  [0x2E96, 0x5FC3, "⺖/心"],  // 忄
  [0x2EA1, 0x6C34, "⺡/水"],  // 氵
  [0x2EA3, 0x706B, "⺣/火"],  // 灬
  [0x2EA8, 0x72AC, "⺨/犬"],  // 犭
  [0x2EC2, 0x8863, "⻂/衣"],  // 衤
  [0x2EB2, 0x7F51, "⺲/网"],  // 罒
  [0x2EDF, 0x98DF, "⻟/食"],  // 食（另一形）
];

/** ★ 白名單：要**例外**加進 syn 的對，寫在這裡（附理由）。
 *  ⚠ 現在 syn 來自 Unihan（權威），所以正常情況**不需要**這一張；
 *    它是給「Unihan 沒收、但師父裁定要算同一個字」的情況用的 ✓。 */
export const SYN_WHITELIST: [number, number, string][] = [
  /* 例：`[0x7AF9, 0x25AD7, "竹/𥫗：Unihan 沒收，但這是竹字頭"]`
     —— 實測 `竹/𥫗` 確實**不在** Unihan_Variants 裡（`kSemanticVariant` 也沒有）✗。 */
];
const WHITELIST_KEYS = new Set(SYN_WHITELIST.flatMap(([a, b]) => [a + "-" + b, b + "-" + a]));

export interface SynResult {
  /** 進字庫 `syn` 區段的對（**永遠合併**的層：相容字符、kZVariant、部首形、白名單） */
  pairs: [number, number][];
  /** 各來源幾對（稽核／文件用） */
  bySource: Map<string, number>;
  /** **選項層**（「同時找異體部件」）：偏旁形／簡繁／日新舊字體——**不進 syn** ✓ */
  optionPairs: [number, number][];
  optionByField: Map<string, number>;
  /** 兩端不在字集也不在部首區段的（硬擋） */
  rejectedEndpoints: number;
  /** Unihan 裡有、但兩端不在我們字集的（＝我們沒收那個字，記錄數量即可） */
  outsideLib: number;
}

/**
 * 從 Unihan 組出 syn（與選項層）。`inLib` 由呼叫者給（建庫用 `inRanges`，
 * 報告工具用同一組區段）——避免這裡又藏一份清單 ✗。
 */
export function loadSyn(opts: { unicodeData: string; variants: string; inLib: (cp: number) => boolean; withOptions?: boolean }): SynResult {
  const ok = (cp: number) => opts.inLib(cp) || RADICAL_RANGES.some(([a, b]) => cp >= a && cp <= b);

  /* Unihan 的總量（放行全部）vs 我們能用的量。
     ⚠ `loadCompatPairs`／`loadVariantPairs` 收到 `ok` 就會**先過濾**，所以「被過濾掉多少」
     必須另外用一個放行全部的呼叫來算——不然那個數字永遠是 0 ✗（第 110 輪踩到）。 */
  const totalAll = (() => {
    try {
      return loadCompatPairs(opts.unicodeData, () => true).length +
        loadVariantPairs(opts.variants, SYN_FIELDS, () => true).length;
    } catch { return 0; }
  })();

  const bySource = new Map<string, number>();
  const pairs: [number, number][] = [];
  const seen = new Set<string>();
  const push = (a: number, b: number, field: string) => {
    const k = a + "-" + b;
    if (seen.has(k) || a === b) return;
    seen.add(k);
    pairs.push([a, b]);
    bySource.set(field, (bySource.get(field) ?? 0) + 1);
  };

  /* ① 相容字符（UnicodeData 的正規單一分解）＋ ② kZVariant ✓ */
  for (const p of loadCompatPairs(opts.unicodeData, ok)) push(p.a, p.b, "相容字符（UnicodeData 正規分解）");
  for (const p of loadVariantPairs(opts.variants, SYN_FIELDS, ok)) push(p.a, p.b, p.field);
  /* ③ 部首形（本專案列出）＋ ④ 白名單 ✓ */
  for (const [a, b, why] of RADICAL_FORM_PAIRS) push(a, b, "部首形（本專案列出：" + why + "）");
  for (const [a, b, why] of SYN_WHITELIST) if (WHITELIST_KEYS.has(a + "-" + b)) push(a, b, "白名單：" + why);

  /* **選項層**：資料保留精確資訊，用選項區分專家與普通人 ✓（師父第 110 輪指示） */
  const optionPairs: [number, number][] = [];
  const optionByField = new Map<string, number>();
  if (opts.withOptions !== false) {
    const oSeen = new Set<string>();
    for (const p of loadVariantPairs(opts.variants, OPTION_FIELDS, ok)) {
      const k = p.a + "-" + p.b;
      if (oSeen.has(k) || seen.has(k) || seen.has(p.b + "-" + p.a)) continue;   /* syn 已有的不必重複 */
      oSeen.add(k);
      optionPairs.push([p.a, p.b]);
      optionByField.set(p.field, (optionByField.get(p.field) ?? 0) + 1);
    }
  }

  /* 扣掉重複與自己對自己，剩下的就是「Unihan 有、但我們用不到」的量 */
  const outsideLib = Math.max(0, totalAll - pairs.length);

  return { pairs, bySource, optionPairs, optionByField, rejectedEndpoints: 0, outsideLib };
}

/** 舊介面（相容）：讀 `out/compat-map.tsv`——**第 110 輪起不再用於建庫** ✗，
 *  只留給「想回頭對照舊推論表」的探針用。 */
export interface SynRow { a: number; b: number; src: string; note: string }
export function loadSynRows(file: string): SynRow[] {
  const out: SynRow[] = [];
  for (const line of readFileSync(file, "utf8").split("\n").slice(1)) {
    const c = line.split("\t");
    if (c.length < 2) continue;
    const a = parseInt((c[0] ?? "").replace("U+", ""), 16);
    const b = parseInt((c[1] ?? "").replace("U+", ""), 16);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) continue;
    out.push({ a, b, src: (c[2] ?? "").trim(), note: (c[3] ?? "").trim() });
  }
  return out;
}

/** 連通分量（union-find），**依大小遞減**回傳。`nodeCount`＝參與的相異碼位數。 */
export function synGroups(pairs: [number, number][]): { groups: number[][]; nodeCount: number } {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r)!;
    while ((parent.get(x) ?? x) !== r) { const nx = parent.get(x)!; parent.set(x, r); x = nx; }
    return r;
  };
  for (const [a, b] of pairs) {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const byRoot = new Map<number, number[]>();
  for (const x of parent.keys()) {
    const r = find(x);
    const g = byRoot.get(r);
    if (g) g.push(x); else byRoot.set(r, [x]);
  }
  const groups = [...byRoot.values()].sort((x, y) => y.length - x.length);
  for (const g of groups) g.sort((x, y) => x - y);
  return { groups, nodeCount: parent.size };
}

/** 從 `Library.syn`（已解碼的字庫）取出無向邊；同一對只算一次。 */
export function edgesOfSynMap(syn: Map<number, number[]> | undefined): [number, number][] {
  const out: [number, number][] = [];
  if (!syn) return out;
  for (const [a, arr] of syn) for (const b of arr) if (a < b) out.push([a, b]);
  return out;
}
