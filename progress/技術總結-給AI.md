# 技術總結（給 AI／下一輪接手的自己）

> 這一篇**刻意保留試錯與教訓**——它們比結論更能省下一個新對話的輪次。
> 給人看的版本是 [`技術總結-給人.md`](技術總結-給人.md)（只講結論）。

## 0. 一句話現況

字庫 **v6** 已出貨：**部件拆分（視覺）、異體、字框** 三塊都由自有資料決定，
IDS 只剩「候選名稱來源」；另加一區**理據拆分**（說文）**只供查閱、不參與組字**。
**`bun run verify` 10/10 步全綠**（第 110 輪起，一個指令跑完重建＋驗收＋指標）。

## 1. 產物與入口

| 項目 | 位置 | 備註 |
|---|---|---|
| **一鍵驗收** | `bun run verify` | **先跑這個。** 重建 → 出貨三套 → 檢查 → 指標表；失敗即停並印出那一步的尾巴 |
| 語法預檢 | `bun run tools/check-syntax.ts` | `verify` 的第一步（1 秒 ✓）：掃全部 `tools/*.ts`、`*.js` 的**語法**——專抓「template literal 註解裡的反引號」✗ |
| 字庫 | `out/lib-cjk-all.bin(.gz)` | **v6**，gz 約 2,222 KB；magic `GL` ＋ 版本位元在解壓後第 3 byte |
| 兩頁 | `out/pinxing.html`、`out/glyph-browser.html` | 各約 3.2 MB（內嵌字庫 base64） |
| 建庫 | `bun run tools/build-library.ts --out out/lib-cjk-all.bin` | 會自我檢查 ＋ 收尾驗證 |
| 建形式群 | `bun run tools/build-form-groups.ts` | → `out/form-groups.json`（1,361 碼位／18 KB）；**頁面會內嵌它，所以建頁之前要跑** ✓（`verify` 有這一步） |
| 建頁 | `bun run tools/build-pinxing.ts`、`tools/build-glyph-browser.ts` | 改頁面／改字庫後**都要重建** |
| 出貨驗收 | `check-pinxing`、`check-browser`、`free-compose-test` | 三套必須全綠（`verify` 的前三步） |
| 目標指標 | `bun run tools/check-parts.ts` | 【輸入部件就比對得到】 |
| 結構成績單 | `bun run tools/check-structure.ts` | 尺規＝新 IDS；算子**不是**目標（§6.20） |
| 異體表稽核 | `bun run tools/report-syn-groups.ts` | `out/syn-edge-classes.tsv`（**裁決用**）＋ `out/syn-group-audit.tsv` |

> `verify` 的參數：`--fast`（跳過重建）／`--lib`（只重建字庫＋三套）／`--all`（含舊消費者
> `kage-viewer`、`codemirror-kage`）／`--skip <name>`／`--list`／`--verbose`。
> ⚠ 舊消費者的字庫來源是**舊世代**（`out/lib-cjk.bin.gz`，見 `todo.md` P1-3），
> 所以預設不跑；要一起驗先跑它們的 builder。

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

## 4. 異體（syn）：來源＝**Unihan（權威）**，分兩層（資料精確 ＋ 選項寬鬆）

### 4.0 術語（師父第 110 輪定義——**文件與程式一律照這個用**）

| 詞 | 意思 | 在我們資料裡是 |
|---|---|---|
| **異體** | Unicode 認定的 variants（**碼位意義**：不同碼位、Unicode 說它們有關係） | 字庫 `syn` 區段（本節）✓ |
| **異形部件** | GlyphWiki **為了構形而產生的同碼 var**（同一個碼位的不同字形） | 字庫的**家族成員**（`familyMembers()`／`DECOMP`）——**不是** syn ✗ |

> ⚠ 以前文件把「家族成員」也叫「異體」，那是**用詞錯誤** ✗：
> 家族成員是「同碼不同字形」（異形部件）✓，例如 `u91d1` 與 `u91d1-01`。

### 4.1 來源與分層（師父：「在數據內部盡量保留精確信息，用選項區分專家與普通人」）

資料：`unihan/UnicodeData.txt`（正規單一分解＝相容字符）＋ `unihan/Unihan_Variants.txt`
（**Unihan 18.0.0**，2026-07-31）。抓法（GitHub 連不上 ✗，用**官方** ✓）：

```powershell
curl.exe -sSL -o unihan/Unihan.zip    https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip
curl.exe -sSL -o unihan/UnicodeData.txt https://www.unicode.org/Public/UCD/latest/ucd/UnicodeData.txt
```

| 層 | 欄位 | 語意 | 預設 |
|---|---|---|---|
| **syn（永遠合併）** | UnicodeData **正規單一分解** ＋ `kZVariant` ＋ 部首形 12 對 ＋ 白名單 | **同一個字**的另一個碼位 | 開 ✓ |
| **選項**「同時找異體部件」 | `kSemanticVariant`／`kSpecializedSemanticVariant`／`kSimplifiedVariant`／`kTraditionalVariant`／`kJapaneseOldVariant`／`kJapaneseNewVariant` | 偏旁形（`金/釒`）、簡繁（`釒/钅`）、日新舊字體（`歩/步`） | 關（專家）✓ |
| **永不使用** | `kSpoofingVariant` | 同形異字（資安） | ✗ |

- 規則寫在 `tools/unihan-variants.ts`（欄位與理由）與 `tools/syn-graph.ts`（`loadSyn()`）✓。
- ⚠ **`kCompatibilityVariant` 不在 `Unihan_Variants.txt` 裡**（它是 UnicodeData 的正規分解）
  ——以前用「碼位落在 F900–FAFF」猜 ✗，實測**漏了 628 對**（`更/更`、`龜/龜`、`良/良`…）✓。
- ⚠ **Unihan 是必要輸入**：讀不到就**拒絕出貨**（`process.exit(4)`）✓。
  第 110 輪實例：`try/catch` 把「少一個 import」吞成「syn 0 對」還照樣出貨 ✗
  ——**錯誤不可以被降級成「資料少一點」** ✓。

### 4.2 現況與閘門

- `syn` **1,194 對**（相容字符 1,002 ＋ `kZVariant` 180 ＋ 部首形 12）；**最大連通群 4** ✓
  （`龜龜龜龜`）。**選項層 18,272 對**（已解析、**尚未寫進字庫** ✗，見 §9 第 1 項）。
- **端點閘門**：兩端必須是「字庫收的字」或「部首（2E80–2FDF）」。`∅`／IDC 算子／筆形
  這類雜訊由 Unihan／UnicodeData **自然排除** ✓（它們本來就不是字）。
- **連通分量閘門（兩級）**：`>150` → **拒絕出貨**；`>20` → 警告＋稽核表 ✓。
- 稽核工具：`bun run tools/report-syn-groups.ts`（→ `out/syn-sources.tsv`、`syn-groups.tsv`）；
  驗證「進 syn 的每一對畫出來本來就該很像」：`bun run tools/report-syn-similarity.ts`
  （→ `out/syn-similarity.tsv`，IoU 遞增＝最不像的排前面）。
- ⚠ 舊的 `out/compat-map.tsv`（IDS 差異**推論**表）**已不再被讀取** ✗，留作歷史紀錄；
  `report-syn-whitelist.ts` 已刪除（它的問題被 Unihan 回答了）。
- `lib-format.ts` 的 `synKeyOf(L, cp)`：對 syn 圖做**連通分量**（union-find）取最小碼位當代表。
  ⚠ **不能用「{自己}∪直接鄰居取最小」**：syn 圖不必完全連通，會出現 `辶→2ECC` 而 `辶→8FB6`，
  配對就會把部件配到錯的引用框（第 45 輪的 bug）。
- 消費者：頁面 `pinxing-page.js`（讀 `LIB.syn` 併進**手寫的** `RADICAL_SYN`）、
  `component-boxes.ts`、`check-structure.ts`（`sameChar`）、`check-parts.ts`。
  ⚠ **「查部件」（`runSearch`）比對碼位，不走 syn** ✓。


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

## 7. 目標指標（第 105～110 輪建立；**第 110 輪重測兩次**）

| 指標 | 值 | 指令 |
|---|---|---|
| `bun run verify` | **10/10 步全綠** | `tools/verify.ts`（含重建約 3 分鐘） |
| 【輸入部件就比對得到】 | **96.00%**（11,240／11,708） | `check-parts.ts` |
| IDS 替代進度（算子一致且墨全被認領） | 97.20% | `check-structure.ts` |
| syn（對數／最大連通群） | **1,194 對／4**（＋選項層 18,272 對，**尚未進字庫**） | `verify`／建庫閘門 |
| 收縮等價（容相容字符） | 40.40%　○**僅供參考** | `check-structure.ts` |
| 葉子「身分」與 IDS 不同 | 42.20%　○**大部分是刻意的** | `check-structure.ts` |
| 有名字沒框 | **0** | `check-parts`／`check-pinxing` |

> ⚠ 「部件就比對得到」的兩次變化都要記住：**97.80% 是含假命中的舊值** ✗
> （修 `∅` → 97.51%），**裁定之後 → 96.00%** ✓（推論列不歸併，`口` 不該找到畫成 `土` 的字）。
> 其中「偏旁形查不到」已經有了**正解**：改用 Unihan 權威資料、並把偏旁形放進**選項層** ✓（§4）。
> ⚠ 「說錯／身分不同 ≤35%」原本一直是紅的（44.8%），只是**不在出貨三套裡**所以沒人看見 ✗
> （第 110 輪 `verify` 才照出來）。已依 §6.19／§6.20 拆開：**算子說錯**保留門檻（2.8% ✓）、
> **葉子身分不同** 42% 改成僅供參考 ○（`木` 列獨體、IDS 攤成 `十人`，那是刻意的）。
> ⚠ 「收縮等價 40.x%」**不是目標指標** ✗——它量樹形／算子；師父明示「**只需部件一致**」（§6.20）。
> ⚠ 「葉子層相等」也**不可用** ✗（1.52%）：IDS 會攤到筆形，我們停在畫法那一層。
> ⚠ §6.18 的「直接分量一致 99.26%」**目前沒有可重跑的指令**（當時的探針不在鏈上）✗。

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
7. **佔位符不可以進資料表**（第 110 輪）：`out/compat-map.tsv` 有 182 列寫成
   `U+XXXX → U+2205`（∅，＝「沒有對應字」的佔位符）。它在**下一個消費者眼裡就是一個字** ✗，
   讓 syn 圖長出 **397 個成員**的連通分量（木＝口＝一＝人…）。症狀是 `杏` 的 `木` **沒有框** ✗、
   `想` 多一格 ✗、`check-parts` 有 **34 個假命中**（97.80% 其實是 97.51%）。
   **要表示「沒有」，就不要寫那一列** ✓；閘門要寫在**資料入口** ✓（`tools/syn-graph.ts`）。
8. **不在出貨三套裡的檢查也會紅** ✗：`check-component-boxes`（`杏`）與
   `check-structure`（「說錯 ≤35%」44.8%）都是**先前就紅**、只是沒人跑。
   → 所以有 `bun run verify` ✓：**把「忘了跑」變成「不會忘」**。
9. **閘門分兩級**：明確的錯 → **拒收**（建庫 `process.exit(3)`）✓；
   需要人判斷的（資料政策）→ **警告 ＋ 稽核表** ✓。⚠ **不可以為了讓它過就調高門檻** ✗
   ——那正是〈試丹篇〉「閘門要能失敗」的反面。
10. **訊息裡的版本／數字不要寫死**：建庫的自我檢查寫死 `ver=5`（實際 v6），
    會讓人以為字庫版本不對 ✓ 已改成讀實際值。
11. **內嵌進頁面的模組不可以用 Node 專屬的全域**（`process`／`Buffer`／`require`）✗。
    第 110 輪實例：`compose-fit.ts` 加了 `process.env.DSH_FIT_DEBUG` 的診斷，
    瀏覽器裡沒有 `process` → 每次呼叫都拋錯，**整條組字動線壞掉、12 條頁面斷言失敗** ✗。
    修法：`globalThis.process?.env?.…` ✓（`embed-common.ts` 的 `MODULES` 就是內嵌清單：
    `compose-fit.ts`、`free-compose.ts`、`kage-engine`…）。
11b. **builder／探針的樣板字串裡不可以用反引號** ✗（第 111～112 輪踩了**五次**）：
    `build-pinxing.ts` 的 HTML、`check-pinxing.ts` 的探針**都是 template literal**，
    在**註解**裡寫 `` `初衤禾` `` 就得到 `Expected ";" but found "利刂刀"` ✓。
    **一律用「」**（中日韓引號）。
    ✅ 現在有守門：`tools/check-syntax.ts`（`verify` 第一步 ✓，1 秒內指出檔名 ✓）。
11c. **改 builder 的標記時要數 `</div>`** ✗（第 112 輪踩到，症狀很遠）：
    我在「拼出來的形」那張卡少關一個 `</div>` → 後面全部（含 `<script>`）被包進去 →
    `<script>` 不再是 `document.body` 的直接子元素 → `check-pinxing` 的
    `body` 文字掃描（排除 `SCRIPT`）把**探針自己的程式碼**也算進去 →
    裡面有 `/載入失敗/` 這個字面值 → **誤報「初始化失敗」** ✗。
    教訓：**建置腳本只檢查語法，檢查不出標籤不平衡** ✓；
    掃 body 文字時要能容忍這件事（現在會印出真正的錯誤訊息 `loadErrMsg` ✓）。
11d. **頁面測試的輸入三個字都要在字庫裡** ✗：`⺣`、`⺾`（部首補充區 2E80–2FDF）
    **不在**字集的 12 區段裡、沒有字形 → 引擎畫不出來、輸入會落到中間狀態、
    永遠不會有建議 ✓（我用「秋火⺣」寫測試，白跑一輪 ✗）。
11e. **作者樣式的 `display` 會蓋掉 `[hidden]` 的 `display:none`** ✗（第 112 輪）：
    我給建議框加了 `display:flex` → 空畫面時它變成**一個空框掛在那裡** ✗，
    而「驗 `hidden` 屬性」的斷言**照樣通過** ✗——是**截圖**才看出來的 ✓。
    → 驗「有沒有顯示」要看 `getComputedStyle(el).display` ✓；
      需要 `[hidden]` 生效時要自己補一條 `xxx[hidden] { display:none }` ✓。
11f. **要內嵌進頁面的模組，整份都不能出現 `import.meta`** ✗（第 112 輪要把 `raster.ts` 內嵌時踩到）：
    `import.meta is only valid inside modules` → **合併後的 script 整份不執行、頁面空白** ✗。
    連**函式裡面**也不行（非 module 的 script 一律拒絕 ✓）。要專案路徑就只在
    「會被 `stripCli` 切掉的 CLI 區塊」裡用 ✓。另外頂層 `readFileSync`／`Database` 那類
    Node 專屬載入也要改成共用 `ensureEngine()` ✓（頁面上它會被換成 no-op ✓）。
11g. **只驗「引擎換得動」不夠，要驗「換完能不能看」** ✗（第 112 輪師父的警告）：
    「庚广廣」墨都搞一塊 ✗——`canReplaceCp()` 說可以 ✗，但結果是一團墨 ✓。
    判準＝**新部件的墨 蓋掉「其餘筆劃」的比率**（`ink-conflict.ts`），門檻 **20%**：
    ✗ 27.6～44.4%（庚广廣 38%、庚广艹 27.6%、唐广廣 44.4%）／✓ 0～1.9%（庚广厂 0.2%、利刂刀 0%、拍 1.9%）。
    ⚠ 「墨量比」「縮放」「框重疊」**都分不開** ✗（庚广厂 ✓ 0.76× vs 庚广艹 ✗ 0.56× 幾乎一樣）；
    `siblingInkOf` 也抓不到**手畫的筆劃** ✗（要自己按筆劃過濾點陣 ✓）。
11h. **`txt()` 已經 `decodeURIComponent` 過了** ✗（第 112 輪）：再解一次，只要訊息裡有 `%`
    （例如「38%」）就 `URIError` ✓。驗收腳本裡的 `decodeURIComponent(txt("X"))` 是重複解碼 ✗。
11i. **「非 BMP 就別建議」是錯的** ✗（第 119 輪師父指正的架構）：
    客人**輸入**用 BMP ✓（拼音把罕用字排後面、很多字不會念），但**建議**可以是 extension 的字 ✓
    ——那是**點一下**就用的，不必客人打出來 ✓（我要把「客人打不出來所以不建議」的成見丟掉 ✗）。
    ⚠ 但排序要對：**BMP 優先、其次才是「本來就是這個字」** ✓——
    實測 `初衤禾` 讓非 BMP 的完全吻合字（`𰨛`）排第一，就把師父要的 `利刂刀` 擠掉 ✗。
12. **「差不多大」不等於「可以直接換」**：替換部件的「沿用原框」判準原本只看**大小比**
    （0.75–1.3），`秧央角` 的 `角/央` 是 1.14×1.02 但**位置差 34 格** → 沿用恆等框、
    `角` 壓到左邊的 `禾` ✗。已加**中心位移**判準（`SHIFT_TOL = 8`，見 §6.23）。
    ⚠ 這類錯誤**渲染不會報錯、測試也不會紅**——只有人眼看得出來 ✓。

## 9. 下一步（優先序）

0. **★把「同時找異體部件」接起來**（師父第 110 輪的指示，見 `20261014計劃.md` §2-A5）。
   兩件事：①**輸入正規化**——使用者打 `钅`／`釒` 就**內部換成 `金`**（帶位置：`金+` 表左偏旁）；
   ②**選項**「同時找異體部件」開關（**預設關**＝專家；開＝普通人，會多找到偏旁形／簡繁／日新舊字體）。
   資料層已解析好（`tools/unihan-variants.ts` 的 `OPTION_FIELDS`，**18,272 對**），
   但**還沒寫進字庫** ✗ → 要先決定「v7 新區段」還是「頁面內嵌」。
   ⚠ 為什麼放選項、不放資料：選項層的視覺相似度中位只有 **0.29**（syn 是 0.70、相容字符近 1.00）
   ——它們**本來就不是同一個字** ✓（`金/釒`、`釒/钅`、`歩/步`）。
1. **獨體表續審**：`out/atomic-candidates-composite.tsv`（105 列，附說文構形句 ＋ 畫法墨塊）。
   「墨是一團」→ 留 ✓；「≥2 引用」→ 可移出 ✓（已做 15 ＋ 8 個）。
2. **`麥` 改畫法**（引用 `來`＋`夂`）→ `䴺來去` 就能兩全 ✓（現由 `䴺麥去` 承擔，§6.21）。
3. **UI：有圖無名的內部字形**畫出圖形、給中性標籤 ✓。
4. **`rawClusters` 接進建庫**取代 `手畫 ≥ 6 筆 → 2 塊` 的近似 ✗（⚠ 它會過度切開，需搭配獨體表）。
5. **推論線（從墨跡推結構）**：§6.20 已放寬（算子不必正確），只要求部件。
6. **把 §6.18 的「直接分量一致」補成探針**（現在沒有可重跑的指令 ✗），併進 `verify` 的指標表。

## 10. 檔案地圖（這一輪相關）

```
tools/verify.ts            一鍵驗收（重建 → 出貨三套 → 檢查 → 指標表）；**先跑這個**
tools/build-library.ts     建庫（獨體表 → 畫法裁判 → 候選選擇 → 筆形閘 → comp／syn／phil）
tools/lib-format.ts        解碼 v2～v6、synKeyOf()、familyMembers()
tools/component-boxes.ts   componentBoxes()、rawClusters()、cpOfRef()、inkBoundsFromStrokes()
tools/syn-graph.ts         異體圖的單一來源：`loadSyn()`（來源＝Unihan）、端點／連通分量閘門、
                           `SYN_WHITELIST`、`RADICAL_FORM_PAIRS`（建庫／驗收／稽核共用）
tools/unihan-variants.ts   **Unihan 權威來源**：`SYN_FIELDS`／`OPTION_FIELDS`／`NEVER_FIELDS`
                           與 `loadCompatPairs()`／`loadVariantPairs()`
tools/report-syn-groups.ts 異體稽核（→ out/syn-sources.tsv、out/syn-groups.tsv）
tools/report-syn-similarity.ts 「進 syn 的每一對本來就該很像」的驗證 → out/syn-similarity.tsv
tools/atomic-chars.ts      獨體字表（含 EXCLUDE 與每字理由）
tools/ids-source.ts        新 IDS 來源解析（loadIdsFile／primaryComponents／directComponents）
tools/shuowen.ts           說文解析（已凍結；索引用）
tools/check-parts.ts       【輸入部件就比對得到】
tools/pinxing-page.js      頁面邏輯（renderSeq／componentChips／philNote／RADICAL_SYN）
unihan/                     **Unihan 18.0.0**（官方；不版控）：UnicodeData.txt、Unihan_Variants.txt
                            ＋順便一起下載的 Unihan_RadicalStrokeCounts.txt（kRSUnicode，未來的部首／筆劃用）
out/syn-sources.tsv         syn 的來源組成（相容字符／kZVariant／部首形）＋選項層規模
out/syn-groups.tsv          連通分量（≥3）的成員與邊
out/syn-similarity.tsv      「進 syn 的每一對像不像」＋選項層各欄位的分佈（驗證用）
out/compat-map.tsv          **已不再被讀取** ✗（IDS 差異推論表，留作歷史紀錄）
out/atomic-candidates-composite.tsv  獨體表待審清單
20261014計劃.md            施工單（§0 基準、§0.1 第 110 輪、§2-A5 選項待做、§4-C1 已完成）
組字結構.md                §1～§6.22 技術決策史（§6.21 麥的教訓、§6.22 ∅ 事件與 Unihan 換源）
novel/鑑丹篇.md             寓言版
```
