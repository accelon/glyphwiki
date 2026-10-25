/**
 * tour.config.ts — 操作導覽的劇本設定（`bun run tools/tour/build-tours.ts` 用）。
 *
 * 路徑一律**從 repo 根目錄算**（`compileTours()` 用 process.cwd()），
 * 所以指令要在 `D:\2023\glyphwiki` 底下跑：
 *
 *   bun run tools/tour/build-tours.ts            # 編譯 ＋ 印摘要（不寫檔）
 *   bun run tools/tour/build-tours.ts --check    # 比對產出頁裡的內嵌資料（CI／verify 用）
 *
 * ⚠ 本專案**不落地** `tour-data.ts` ✓——`TOUR_INDEX`／`TOUR_BLOBS` 由
 *   `tools/build-pinxing.ts` 編譯完**直接內嵌**進 `out/pinxing.html`。
 *   理由：這個專案吃過「同一個東西兩份來源各說各話」的虧；多一份中間檔，
 *   就多一個「改了劇本、中間檔沒更新、頁面還是舊的」的坑 ✗
 *   （見 `tools/embed-common.ts` 檔頭與 `pinxing.md`〈操作導覽〉）。
 *   代價是 `--check` 要比對**產出物**而不是比對中間檔——這反而更接近客人的真相 ✓。
 */
import { defineTourConfig } from "./compiler.ts";

export default defineTourConfig({
  tourDir: "tools/tour/tours",
  /* 只有 `--check` 會用到：拿「上一次建好的頁面」當 template 做 `#id` 的靜態檢查。
     `build-pinxing.ts` 走的是 `templateHtml`（當場組好的那一頁），不必先落地再讀回來 ✓。 */
  templateFile: "out/pinxing.html",
  magic: "TOUR1",
  formatImport: "./format.ts",
  /** 選單的順序（**第一列就是客人最先點的那一份** ✓）：第一次使用 → 進階 ✓ */
  order: ["welcome", "find"],

  /* ---- 白名單：寫錯就在**建置期**擋下來，不要等到客人面前才發現 ✓ ---- */

  /** `設定` 認得的鍵（見 pinxing-page.js 的 tourAdapter().set） */
  setKeys: ["box", "wscale", "mid"],
  /** `呼叫` 認得的函式（見 tourAdapter().call） */
  callNames: ["mark", "restore"],
  /** `api:` 條件認得的鍵（見 tourAdapter().state） */
  apiKeys: ["ready", "seq", "mode", "box", "mid", "cands", "chips", "big", "composed"],

  /* 執行期才產生的元素：`build/check` 會用到（頁面的 `#bootfail` 是看門狗臨時加的）。 */
  dynamicIds: ["bootfail"],

  header: "劇本：tools/tour/tours/*.tour；內嵌者：tools/build-pinxing.ts；驗收：tools/check-pinxing.ts",
});
