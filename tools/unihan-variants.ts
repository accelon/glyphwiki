/**
 * unihan-variants.ts — **Unihan 的變體資料（權威來源）**。
 *
 * 為什麼換過來（師父第 110 輪的指示）：
 *   早先的 `out/compat-map.tsv` 是「用 IDS 版本差異**推論**」出來的，結果混進了
 *   `口≡土`、`一≡八`、`犬≡大`、`木≡林` 這種假等價 ✗（還有一個 `∅` 佔位符污染）。
 *   師父指示：**「異體」指 Unicode 認定的 variants（碼位意義）**，並給了
 *   <https://github.com/CNMan/Unicode/blob/master/Unihan/Unihan_Variants.txt>。
 *   GitHub 在我們這裡連不上 ✗，所以直接抓**官方**（更權威）：
 *   <https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip>（Unihan **18.0.0**，2026-07-31）
 *   與 <https://www.unicode.org/Public/UCD/latest/ucd/UnicodeData.txt> ✓
 *   → 解到 `unihan/`（不版控；`dump/`、`ids/`、`swjz.xml` 同一類）。
 *
 * **術語（師父的定義，文件與程式一律照這個用）**：
 *   · **異體**＝Unicode 認定的 variants：**不同碼位**、Unicode 說它們有關係 → 本檔 ✓
 *   · **異形部件**＝GlyphWiki **為了構形而產生的同碼 var**（同一個碼位的不同字形）
 *     → 那是字庫的**家族成員**（`lib-format.ts` 的 `familyMembers()`／`DECOMP`），**不是**這裡的東西 ✗
 *     （例：`u91d1` 與 `u91d1-01` 是同一個碼位的兩種畫法＝異形部件 ✓）
 *
 * **分層（師父：「在數據內部盡量保留精確信息，用選項區分專家與普通人」）**：
 *
 *   | 層 | 欄位 | 語意 | 預設 |
 *   |---|---|---|---|
 *   | **syn**（永遠合併） | UnicodeData 的**正規單一分解**（＝相容字符 ①）＋ `kZVariant` | **同一個字**的另一個碼位 | 開 ✓ |
 *   | **選項**「同時找異體部件」 | `kSemanticVariant`／`kSpecializedSemanticVariant`／`kSimplifiedVariant`／`kTraditionalVariant`／`kJapaneseOldVariant`／`kJapaneseNewVariant` | 偏旁形（`金/釒`）、簡繁（`釒/钅`）、日新舊字體（`歩/步`）… | 關（專家）✓ |
 *   | **永不使用** | `kSpoofingVariant` | 同形異字（資安警告） | ✗ |
 *
 * ① 相容字符為什麼算「同一個字」——師父原話：
 *   「F900~FA6D 是一般用戶輸入不了的，是當年 big5, gb2312, JIS 合併時，為了從 unicode
 *   正確轉換過去而保留的……`滑` 是可以算作 `滑`，只是 `骨` 筆劃的小差異而已，不影響識別文字。」
 *   ⚠ 用 `UnicodeData.txt` 的**正規分解**當來源（權威 ✓），不要再用「碼位落在 F900–FAFF」猜 ✗
 *   ——實測：這樣才對，之前靠區段猜的版本**漏了 628 對**（`更/更`、`龜/龜`、`良/良`…）。
 */
import { readFileSync } from "node:fs";

export interface VariantPair { a: number; b: number; field: string }

/** syn 層（永遠合併）的 Unihan 欄位。相容字符來自 `UnicodeData.txt`，不在這裡。 */
export const SYN_FIELDS = ["kZVariant"];

/** 選項層（「同時找異體部件」）的 Unihan 欄位——依師父指示放在**選項**，不進資料的預設值 ✓ */
export const OPTION_FIELDS = [
  "kSemanticVariant",            /* 語意異體：`金/釒`、`示/礻`、`言/訁`、`食/飠`、`真/眞` */
  "kSpecializedSemanticVariant", /* 專用字：`㒚/文`、`㔾/卩` */
  "kSimplifiedVariant",          /* 簡化字：`釒/钅`、`惡/恶` */
  "kTraditionalVariant",         /* 傳統字（與上一欄互為反向） */
  "kJapaneseOldVariant",         /* 日本舊字體：`歩/步`、`悪/惡` */
  "kJapaneseNewVariant",         /* 日本新字體 */
];

/** **永不使用**：同形異字（資安用，例 `㓕/滅`）✗ */
export const NEVER_FIELDS = ["kSpoofingVariant"];

/**
 * UnicodeData.txt 的**正規單一分解**（`XXXX;...;DECOMP;...`，DECOMP 不含 `<...>` 且只有一個碼位）
 * ＝相容字符 ↔ 正規碼位 ✓。這是「同一個字的兩個碼位」的**權威定義**，不再用區段猜。
 */
export function loadCompatPairs(path: string, ok: (cp: number) => boolean, bOk?: (cp: number) => boolean): VariantPair[] {
  const other = bOk ?? ok;
  const out: VariantPair[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    const c = line.split(";");
    const cp = parseInt(c[0] ?? "", 16);
    const dec = c[5] ?? "";
    if (!Number.isFinite(cp) || !dec || dec.includes("<")) continue;
    const parts = dec.trim().split(/\s+/);
    if (parts.length !== 1) continue;             /* 只收單一分解（＝相容字符） */
    const t = parseInt(parts[0]!, 16);
    if (!Number.isFinite(t) || t === cp) continue;
    if (!ok(cp) || !other(t)) continue;
    out.push({ a: cp, b: t, field: "kCompatibilityVariant" });
  }
  return out;
}

/** 讀 `Unihan_Variants.txt` 的指定欄位（`U+XXXX\tkField\tU+YYYY U+ZZZZ<kSource`）。 */
export function loadVariantPairs(path: string, fields: string[], ok: (cp: number) => boolean, bOk?: (cp: number) => boolean): VariantPair[] {
  const want = new Set(fields);
  const other = bOk ?? ok;
  const out: VariantPair[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line || line[0] === "#") continue;
    const c = line.split("\t");
    if (c.length < 3 || !want.has(c[1]!)) continue;
    const a = parseInt(c[0]!.replace("U+", ""), 16);
    if (!Number.isFinite(a)) continue;
    for (const v of c[2]!.split(/\s+/)) {
      const b = parseInt(v.split("<")[0]!.replace("U+", ""), 16);
      if (!Number.isFinite(b) || b === a) continue;
      if (!ok(a) || !other(b)) continue;
      out.push({ a, b, field: c[1]! });
    }
  }
  return out;
}

/** 這一對在 Unihan 裡有沒有被列為「同一個字」（syn 層）——查詢正規化用得到 ✓ */
export function indexPairs(pairs: VariantPair[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const p of pairs) {
    const l = m.get(p.a);
    if (l) l.push(p.b); else m.set(p.a, [p.b]);
  }
  return m;
}
