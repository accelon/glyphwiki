# 技術總結（給 AI／下一輪接手的自己）

> 這一篇**刻意保留試錯與教訓**——它們比結論更能省下一個新對話的輪次。
> 給人看的版本是 [`技術總結-給人.md`](技術總結-給人.md)（只講結論）。

## 0. 一句話現況

字庫 **v6** 已出貨：**部件拆分（視覺）、異體、字框** 三塊都由自有資料決定，
IDS 只剩「候選名稱來源」；另加一區**理據拆分**（說文）**只供查閱、不參與組字**。
出貨三套驗收全綠。

## 1. 產物與入口

| 項目 | 位置 | 備註 |
|---|---|---|
| 字庫 | `out/lib-cjk-all.bin(.gz)` | **v6**，gz 約 2,275 KB；magic `GL` ＋ 版本位元在解壓後第 3 byte |
| 兩頁 | `out/pinxing.html`、`out/glyph-browser.html` | 各約 3.2 MB（內嵌字庫 base64） |
| 建庫 | `bun run tools/build-library.ts --out out/lib-cjk-all.bin` | 會自我檢查 ＋ 收尾驗證 |
| 建頁 | `bun run tools/build-pinxing.ts`、`tools/build-glyph-browser.ts` | 改頁面／改字庫後**都要重建** |
| 出貨驗收 | `check-pinxing`、`check-browser`、`free-compose-test` | 三套必須全綠 |
| 目標指標 | `bun run tools/check-parts.ts` | 【輸入部件就比對得到】 |
| 結構成績單 | `bun run tools/check-structure.ts` | 尺規＝新 IDS；算子**不是**目標（§6.20） |

## 2. 字庫格式（v6）與解碼

- v2／v3／v4／v5／v6 由 `tools/lib-format.ts` 的 `decodeV23(bytes, start, withComp, compOrdered, withSyn, withPhil)` 分派。
- **v6 新增 `phil` 區段**：`碼位差（pushS／rd.rv）→ 分量數（pushU／rd.rvRaw）→ 各分量差（pushS／rd.rv）`。
  ⚠ **有號與無號不能混**：第 100 輪把碼位差誤用 `pushU`，6,460 條只解出 2,116 條且查不到任何字。
  **`comp`／`syn`／`phil` 三區的碼位差都是有號**（與 `syn` 同慣例）。
- 解碼器結尾有「讀到的位元組數必須等於檔案長度」的檢查 ✓——**格式寫錯會大聲失敗**，不會靜默錯讀。
- ⚠ `decodeV23` 裡有**兩份相同的 syn↔phil 解碼段**（歷史遺留）。改一處要**兩處都改**，
  否則其中一條路徑會讀不完整。用「replace_all」或先確認。

## 3. 部件拆分（視覺）的規則鏈

建庫順序（`tools/build-library.ts`，都在同一個 judge 區段）：

1. **獨體字表**（`tools/atomic-chars.ts`）：`isAtomic(cp)` → **清掉 comp** ＋ 跳過 ✓（永不拆分）。
2. **畫法裁判**：先**穿透包裝**（單一 kind 99 引用＝只是指標，≤8 層）；
   取那一層的墨：`引用數 ＋ 手畫墨塊`。
3. **候選拆法由畫法選**：來源 `ids/ids_lv1.txt` 的 `primary ＋ alt` 全部當候選，
   挑「至少一個分量就是畫法引用的那個」✓（`㕻`：`⿱示口` ✗ → `⿱丶否` ✓）。
4. **筆形閘**：候選若含筆形字（一丨丶丿乙亅乀乚…）→ 不用 ✓（師父判準：拆分的目的是**分類**，
   `木` 拆 `十、八` 離意義太遠）。
5. 墨塊不足 → 沿用舊值／無 comp。

### 獨體表的來由（重要）

- 判準是**視覺**（不是說文 ✗，也不是 IDS ✗）：**只要墨是一團，就按獨體處理** ✓。
- ⚠ **「一團墨」不能自動判**：`rawClusters()`（`component-boxes.ts`）會把 225 個獨體裡的 **141 個**
  切成兩團（人、八、刀、力、女、子、手、心、木、水、火、月…全中）。**只能靠人的眼睛。**
- 表內以康熙 214 部首為底 ＋ 逐次裁定；`EXCLUDE` 收「已裁定移出」的字（**每字附理由**）。
- 已移出：`乩 亨 谷 亟 网 至 邑 金 骨 髟 鬼 麻 黑 黽 鼓 鼻 龍 龠 角 長 面 音 頁 食 首 麥`。
- **保留**：`門`（師父裁定：左右鏡象，當獨體未嘗不可）；`丈 不 与 丘 二 五 乎` 等（墨一團）。

## 4. 異體（syn）：只有一份

- 來源 `out/compat-map.tsv` → 字庫 v5 `syn`（**1,271 對**＝我挖的 895 ＋ 來源 UCV 364 ＋ 部首 12）。
- `lib-format.ts` 的 `synKeyOf(L, cp)`：對 syn 圖做**連通分量**（union-find）取最小碼位當代表。
  ⚠ **不能用「{自己}∪直接鄰居取最小」**：syn 圖不必完全連通，會出現 `辶→2ECC` 而 `辶→8FB6`，
  配對就會把部件配到錯的引用框（第 45 輪的 bug）。
- 消費者：頁面 `pinxing-page.js`（讀 `LIB.syn` 併進 `RADICAL_SYN`，已存在的鍵不覆寫）、
  `component-boxes.ts`、`check-structure.ts`（`sameChar` 用 `synKeyOf` 判同部件）。

## 5. 字框

- 來源：①引用框 ②異體配對到的引用框（**重命名既有格**，不新增一格）③單一無主分量的**手畫墨框**
  ④多分量切墨（`rawClusters`）。
- 退化／細條框（< 8 單位）**不輸出** ✓。
- 內部字形（`codePointOf` 回 U+0，例 `g41j8`）＝**有圖無名**：畫得出來、不可點 ✓（不是 bug）。

## 6. 理據（phil，v6）

- 來源 `swjz.xml`（說文解字注）→ `tools/shuowen.ts` 抽「从X ＋ X聲」→ **6,460 條**。
- **只顯示**（頁面 `#philNote`）✓，**不參與組字** ✓。
- ⚠ 說文抽取器已**凍結**：六個關鍵字（木／貝／雖／林／大／日）正確；其餘當**索引**，
  **不當自動裁判** ✗（隸變：許慎沒見過宋體字）。

## 7. 目標指標（第 105～109 輪建立）

| 指標 | 值 | 指令 |
|---|---|---|
| 出貨三套 | 全綠 | 見 §1 |
| 【輸入部件就比對得到】 | **97.80%** | `check-parts.ts` |
| 直接分量一致（忽略算子、異體合一） | 99.26% | 見 `組字結構.md` §6.18 |
| IDS 替代進度（算子一致且墨全被認領） | 97.2% | `check-structure.ts` |
| 有名字沒框 | **0** | `check-parts.ts`／`check-pinxing.ts` |

⚠ **「收縮等價 40.x%」不是目標指標** ✗——它量樹形／算子；師父明示「**只需部件一致**」（§6.20）。
⚠ 「葉子層相等」也**不可用** ✗（1.52%）：IDS 會攤到筆形，我們停在畫法那一層。

## 8. 踩過的坑（省輪次用）

1. **物件欄位名**：`RefSlot` 有 `box`（沒有 `raw`）與 `strokeIx`（沒有 `slotIx`）。
   寫成 `partner.raw` 會靜默給 `undefined`，整條框路徑失效。
2. **改檔案用手上的工具**：`edit` 工具（單行錨點）幾乎不會出錯；
   **PowerShell 字串手術連續失敗四次**（範圍少一行留孤兒 `}`、註解被轉寫弄壞、引號被 `.Replace` 拼壞）。
   多行錨點遇 CRLF 會失敗 → **能用單行就用單行**。
3. **工具「沒有輸出」先懷疑語法錯誤** ✗，不要先猜語意（孤兒 `}` 躲了兩輪）。
4. **改了程式要立刻重建產物**：`build-library.ts` 有改 → 一定要重跑 build-library ＋ 重建兩頁，
   否則頁面與字庫不一致（而測試可能還是綠的）。
5. **「清掉舊值」前先查依賴**：第 97 輪清掉獨體的 comp，弄壞 `䴺` 的部分 IDS 鏈；
   真因是**畫法限制**（`麥` 手畫、KAGE 沒有 `來` 的引用），已改由 `䴺麥去` 承擔（§6.21）。
6. **測試期望是快照**：改了資料，`check-pinxing` 的數字常要更新——**更新時一定要附原因**。

## 9. 下一步（優先序）

1. **獨體表續審**：`out/atomic-candidates-composite.tsv`（105 列，附說文構形句 ＋ 畫法墨塊）。
   「墨是一團」→ 留 ✓；「≥2 引用」→ 可移出 ✓（已做 15 ＋ 8 個）。
2. **`麥` 改畫法**（引用 `來`＋`夂`）→ `䴺來去` 就能兩全 ✓（現由 `䴺麥去` 承擔）。
3. **UI：有圖無名的內部字形**畫出圖形、給中性標籤 ✓。
4. **`rawClusters` 接進建庫**取代 `手畫 ≥ 6 筆 → 2 塊` 的近似 ✗（⚠ 它會過度切開，需搭配獨體表）。
5. **推論線（從墨跡推結構）**：§6.20 已放寬（算子不必正確），只要求部件。

## 10. 檔案地圖（這一輪相關）

```
tools/build-library.ts     建庫（獨體表 → 畫法裁判 → 候選選擇 → 筆形閘 → comp／syn／phil）
tools/lib-format.ts        解碼 v2～v6、synKeyOf()、familyMembers()
tools/component-boxes.ts   componentBoxes()、rawClusters()、cpOfRef()、inkBoundsFromStrokes()
tools/atomic-chars.ts      獨體字表（含 EXCLUDE 與每字理由）
tools/ids-source.ts        新 IDS 來源解析（loadIdsFile／primaryComponents／directComponents）
tools/shuowen.ts           說文解析（已凍結；索引用）
tools/check-parts.ts       【輸入部件就比對得到】
tools/pinxing-page.js      頁面邏輯（renderSeq／componentChips／philNote）
out/compat-map.tsv         異體來源（1,271 對）
out/atomic-candidates-composite.tsv  獨體表待審清單
組字結構.md                §1～§6.21 技術決策史（含每一次的教訓）
novel/鑑丹篇.md            今晚的寓言版
```
