/**
 * embed.ts — 「操作導覽的劇本資料怎麼寫進頁面」的**唯一定義**。
 *
 * 為什麼要單獨一支：建置器（`build-pinxing.ts`，寫進去）與驗收
 * （`tour/build-tours.ts --check`，讀出來比對）**必須用同一組標記**。
 * 兩邊各寫一份 regex 就等著「改了一邊、另一邊還在找舊記號」✗
 * ——這個專案吃過「同一個東西兩份來源各說各話」的虧（見 `tools/embed-common.ts` 檔頭）。
 *
 * 資料形狀（頁面端 `tools/tour/player.js` 只讀這兩個全域）：
 *
 *   /* __TOUR_INDEX__ *\/ var TOUR_INDEX = [{id,title,intro,scenes,steps,require,bytes}, …];
 *   /* __TOUR_BLOBS__ *\/ var TOUR_BLOBS = {"welcome":"BASE64…", …};
 *
 * ⚠ 兩行都只有一行（`JSON.stringify` 不換行 ✓），這樣 `--check` 用一個 regex 就抓得到 ✓。
 */

export const TOUR_INDEX_MARK = "/* __TOUR_INDEX__ */";
export const TOUR_BLOBS_MARK = "/* __TOUR_BLOBS__ */";

/** 劇本資料的 JS 片段（要塞在 `TOUR_INDEX` 被用到之前 ✓）。 */
export function tourDataJs(index: unknown, blobs: Record<string, string>): string {
  return TOUR_INDEX_MARK + " var TOUR_INDEX = " + JSON.stringify(index) + ";\n" +
    TOUR_BLOBS_MARK + " var TOUR_BLOBS = " + JSON.stringify(blobs) + ";\n";
}

/** 從頁面 HTML 把兩行資料讀回來（讀不到回 null ✓——「找不到」比「以為比對過了」安全）。 */
export function readTourData(html: string): { index: string; blobs: string } | null {
  const idx = new RegExp(escapeRe(TOUR_INDEX_MARK) + " var TOUR_INDEX = ([^\\n]*?);\\s*\\n").exec(html);
  const blob = new RegExp(escapeRe(TOUR_BLOBS_MARK) + " var TOUR_BLOBS = ([^\\n]*?);\\s*\\n").exec(html);
  if (!idx || !blob) return null;
  return { index: idx[1]!, blobs: blob[1]! };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
