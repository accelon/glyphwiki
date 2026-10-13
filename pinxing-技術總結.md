# pinxing.html 技術總結（新對話交接用）

> 這份是**給新對話／新接手的人**看的：一頁掌握拼形檢視器的架構、語意、驗收與本次改動。
> 完整規格與逐條現況在 [`pinxing.md`](pinxing.md)；底層格式在 [`format.md`](format.md)；
> 專案全貌在 [`project.md`](project.md)。本檔只寫「重點 ＋ 2026-10-13 這輪的改動」。
>
> 寫作時間：2026-10-13。基準字庫：`out/lib-cjk-all.bin.gz`（v3，191,727 字形）。

---

## 1. 一句話與產出物

**拼形檢視器**＝單頁離線 HTML：輸入「**基字 ＋ 舊部件 ＋ 新內容…**」，把基字裡那個部件
**原地換掉**並畫出來；讀不成構形序列時就當**部件檢字**工具。

| 產出物 | 大小 | 內嵌字庫 | 建置 | 驗收 |
| --- | ---: | --- | --- | --- |
| `out/pinxing.html` | 3.19 MB | `lib-cjk-all.bin.gz`（v3） | `bun run tools/build-pinxing.ts` | `bun run tools/check-pinxing.ts` |
| `out/glyph-browser.html`（字集瀏覽） | 3.17 MB | 同上 | `bun run tools/build-glyph-browser.ts` | `bun run tools/check-browser.ts` |
| `out/kage-viewer.html`（唯讀檢視） | 3.09 MB | 同上 | `bun run tools/build-kage-viewer.ts` | `bun run tools/check-viewer.ts` |
| `out/codemirror-kage.html`(編輯器) | 1.65 MB | `lib-cjk.bin.gz`（**v1，BMP only**） | `bun run tools/build-codemirror-kage.ts` | `bun run tools/check-codemirror.ts` |

* **四頁都是 `file://` 直接開就會跑**：無 http、無外部資源、無 CDN。
* `pinxing`/`glyph-browser` 兩頁**共用同一份引擎與字庫**，所以**必須一起上傳**；
  互連是雙向的（`?comp=` 過去、`?baseglyph=` 回來）。

## 2. 字庫與資料

| 檔案 | 內容 | 誰用 |
| --- | --- | --- |
| `out/lib-cjk-all.bin(.gz)` | **v3**：191,727 字形、98,701 家族、**IDS 條目 92,933** | 三頁前端（base64 內嵌） |
| `out/lib-cjk-all.gnames.tsv.gz` | 內部索引 ⇥ GlyphWiki 名字 | 只有命令列工具要，**前端不內嵌** |
| `out/lib-cjk.bin(.gz)` | **v1/v2**：70,416 字形、**沒有 IDS 區段** | `codemirror-kage.html`、`free-compose-test` |

**兩個一定要記住的格式細節**：

1. **每筆原始筆畫固定存 8 個數字**，只有前 `2 × ptCountOf(kind)` 個是座標（kind 1 → 2 點、
   2/3/4 → 3 點、其餘 4 點）。多出來的是補位，**有時還留著舊的框**——把它們當座標比對會整個歪掉。
2. **kind 99 ＝引用**：`points` 就等於 `box`，另外有 `ref` 與 `stretch`。引用樹才是引擎走的結構；
   IDS 區段（`lib.comp`）**只存分量、沒有算子**（`⿰⿱` 那些不在字庫裡）。

## 3. 引擎契約（`tools/free-compose.ts`）

```
evalSeq(lib, expr, opt)      # expr = 基字 + 舊部件 + 新內容…
```

* **只有一個字** → 就是它自己。**兩個字** → 錯誤（「只有基字與舊部件」）。長度上限 `MAX_PARTS`。
* 讀法優先序（就是 UI 判讀的依據）：
  1. **整串求值**：`applyReplace()` 在 base 的**整棵 KAGE 引用樹**裡找「舊部件」的槽位，
     **沿用那個槽位的框**（框是人工手調資產），把 ref 改指到新內容。
  2. **新內容自己再遞歸**（`峰夆電雨水` 的內層先算完才代入外層）。
  3. 引用樹裡找不到時 → **IDS 槽位推斷**（§5，本輪新增）：舊部件若在 base 的 IDS 構件階層裡，
     就從筆畫反推槽位、只換掉那個構件的那幾筆。
  4. 都不成立時的退路：**橫向等分串接**（`彳舞亍` ＝ ⿲彳舞亍）。只在「舊部件確實是 base 的部件」
     或「base 沒有結構」時才允許，否則判不合法（`街無此件` 必須失敗，不能靜默畫出一坨）。
* **每次求值都 fork 一份庫、合成字形接在庫尾**；回傳 `{ ok, lib, targetIdx, substituted, log }`，
  `log` 就是 UI 上那句說明的來源。
* ⚠ **合成字形的快取鍵必須用筆畫簽章**（`pinxing-page.js` 的 `glyphSig()`），**不能**用
  （索引, 庫長度）——fork 後接在庫尾，兩次不同的組合會拿到同一組鍵，
  症狀是「改成 角 了，畫面還是 刀」（真實回報）。

## 4. 配框三步驟（`tools/compose-fit.ts`）

替換時要給新內容一個框，順序是：

1. **沿用原框**：新舊**墨跡**尺寸比落在 **0.75–1.3**（`DROPIN_LO/HI`）＝同形替換，直接沿用舊框。
2. **墨跡對齊**（`inkAlignedBox()`，本輪新增）：比例超出時，把框算成「**新墨跡正好蓋住舊墨跡**」：
   `boxW = 200 × 舊墨跡寬 ÷ 新緊框寬`、`boxX = 舊墨跡左緣 − 新緊框左緣 × boxW ÷ 200`（y 同理）。
3. **同層讓位**（`refitBand()`）：都不適用時才把框推到兄弟之外（避免糊成一團）。

| 替換 | 新／舊墨跡比 | 走哪一條 |
| --- | --- | --- |
| `初` 的 衤→礻 | 0.89×0.99 | 沿用原框 |
| `祈` 的 斤→刀 | 0.97×0.94 | 沿用原框 |
| `寶` 的 缶→支 | ~1.0 | 沿用原框 |
| `街` 的 圭→舞 | 1.63×1.13 | **墨跡對齊**（舞 91 寬，與 `衚胡舞` 的 87 一致） |
| `峰` 的 夆→水 | 1.6×1.5 | **墨跡對齊** |
| `寶` 的 貝→𩀨 | 1.16×1.05 | 讓位（高度差得多） |

**為什麼有第 2 步**：框是照著「那一個特定字形」的墨跡人工放大的。`街` 的 `圭` 框 150 寬，
但 `圭` 的墨跡只佔自己方格 57%（畫出來 78 寬）；換成墨跡吃滿 85% 的 `舞` 時沿用同一個框，
舞會畫成 127 寬、直接壓到 `行` 右半的 `亍`（使用者回報「舞太大，因為圭的框太大」）。

## 5. IDS 槽位推斷（孫級部件；本輪新增）

**問題**：`幸` 的 KAGE 是「一筆引用 → 一個**畫成 8 筆**的字形」，IDS 卻是 `[土 𢆉]`；
`幸土业`（把 幸 裡的 土 換成 业）在引用樹裡找不到 `土`，而 IDS 沒有算子、也沒有框。

**演算法**（`free-compose.ts`：`solveIdsSlots()` / `applyReplaceViaIds()`）：

1. 沿「只有一筆引用」的包裝往下走，取到**真正用筆畫畫的那個字形**（`drawingIdx`）。
2. 父字形的筆畫依 IDS 構件的**筆數**分組，構件各自**攤平**成絕對座標筆畫（引用遞迴展開；
   座標只取前 `2*ptCountOf(kind)` 個）。
3. 每組反推構件框（由構件外框與該組筆畫外框解 scale/offset），再**評分**＝構件映射進框後
   與該組筆畫的最大座標差。
4. **只採信分明的解**：誤差 ≤ `IDS_SLOT_TOL`(25) **且**贏過「框明顯不同」的次佳解 ≥
   `IDS_SLOT_MARGIN`(1.5) 倍，且分組中心與 IDS 順序一致（沿 x 或沿 y 單調）。
   列舉有 `IDS_SLOT_BUDGET`(20000) 節點上限。
5. 換的時候**只拔掉目標構件那幾筆**、補一筆指向新內容的引用（框＝推得的框），
   **其餘筆畫原樣保留**——其他部分的外觀完全不變。

實測：`幸土业` → ⿱业𢆉（土 框 `[1,8,199,80]`，誤差 14.5）；
`報土业` → 穿過三層（報→幸→土，框 `[6,8,106,80]`，誤差 7.8）；
`報𢆉田`、`幸土刀` 同理。**推不出來就維持原行為**：判不合法並說明理由
（`isDescendantCp()` ＋ `idsGrandchildError()`），不猜。
v1/v2 字庫沒有 IDS 區段 → 這條路不生效，行為與以前相同。

## 6. UI 行為（`tools/pinxing-page.js`）——使用者要求過的都在這

* **輸入區**：三態標籤「剎那拼形／合理拼形／部件檢字」、`#saveSeq` 存檔圖示（只有合法拼形式才出現）、
  `Escape` 清空、`Enter` 存檔。字框三態（緊／原／無，存 `localStorage['pinxing.boxmode']`）、
  筆劃粗細滑桿。
* **回饋是浮層**（`.seqrow` 裡的 absolute，不佔高度、**不推版面**）；`toast(text, kind)` 3 秒。
  * **「串接部件…」＝橫向等分串接時改用 warn 色**並寫明「不是原地換部件」——
    原本綠色一句很容易被讀成拼成功。
  * 3 個字以上拼不出來時，大字下的說明**與**浮層都帶出引擎的理由；2 個字（打到一半）刻意不吵。
* **部件清單**（標題固定「**部件清單**」、跟著輸入區光標走）：KAGE 引用 ＋ 一層 IDS；
  沒有碼位的部件畫虛線、`cursor:default`、不可點；點一下＝用它替換。
* **合成字形的碼位標示**：`evalSeq` 是在 fork 的庫裡改寫**基字那個索引**，
  `codePointOf()` 會回報基字碼位（實測 `報幸田` → U+5831）——
  畫面一律標「組出來的形（無碼位　以 U+5831 為基）」，不要照印碼位。
* **檢字語法**與 glyph-browser 同一套（`木/` 上、`/木` 下、`木+` 左、`+木` 右、`口口` 兩次、
  `4木日` 扣掉後剩 4 畫、`U+XXXX`），實測數字對得上（61/373/1906/72/2805/24 vs 63/371/1900/76/2806/26）。
* **庫存拼形九組**（按鈕畫**組出來的字**、不顯示拼形式、正方形）：
  `邏羅寶貝𩀨從䞃致招`、`初衤礻`、`颰犮电`、`峰夆電雨水`、`髜昇厏乍电`、`衚胡舞`、
  **`街圭舞`**、`寶缶支`、**`報土业`**。組不出單一形的會標「參」（目前九組都不需要）。
* **互連**：`?comp=` 去字集瀏覽、`?baseglyph=U+XXXX` 回來（`?baseglyph=` 要**三次解碼**才對）。
* `localStorage` 鍵：`pinxing.stock`（自存序列）、`pinxing.boxmode`。

## 7. 驗收（七套，全部要綠）

| 指令 | 測什麼 | 本輪新增／改過 |
| --- | --- | --- |
| `free-compose-test.ts` | 引擎語意、護欄、巢狀、品質、**IDS 槽位推斷** | 第 3 節配框預期改寫；**新增第 10 節**（含幾何斷言：新內容框必須在原下半之上） |
| `check-pinxing.ts` | headless Edge **照使用者動線逐步點**（~70 條） | `幸土业`→原地換、`報土业`→穿三層、`彳舞亍` 不受影響、庫存 9 組、產出物新鮮度 |
| `check-browser.ts` | 字集瀏覽（最大一支，18 個步驟） | `?comp=` 入口 |
| `check-codemirror.ts` | CM6 掛載、掃描護欄 | — |
| `check-viewer.ts` | 檢視頁內嵌模組、緊框推導 | `盟` 的緊框改成**自己重算再比對**（不再寫死數字，庫一重建就會差 1） |
| `check-component-boxes.ts` | 部件框（含 IDS-only） | — |
| `check-lib-compat.ts` | 字庫相容性（v1/v2/v3 讀得開） | — |

⚠ **`check-pinxing` 有一條「產出物要比原始碼新」的斷言**：改了原始碼一定要重建，
否則整頁會是舊的而驗收卻說綠（真的踩過：建置失敗、stderr 被丟掉、驗收對著舊產物說全綠）。

## 8. 本輪（2026-10-12 ~ 10-13）改動清單（patch 記錄）

`tools/` **刻意不入版控**（README 的版控範圍），所以改動以這份清單為準。

**引擎**
* `tools/free-compose.ts`
  * 新增 **IDS 槽位推斷**：`drawingIdx()`、`hasOwnRefStroke()`、`boxMap()`、`flattenStrokes()`、
    `flatBox()`、`kindSig()`、`deriveSlot()`、`slotError()`、`idsOrderOk()`、`solveIdsSlots()`、
    `applyReplaceViaIds()`；常數 `IDS_SLOT_TOL/MARGIN/DISTINCT/BUDGET`。
  * `applyReplace()`：找不到引用時改走 IDS 推斷；配框改成 **沿用原框 → 墨跡對齊 → 讓位**。
  * 新增護欄 `isDescendantCp()` 與說明 `idsGrandchildError()`（推不出來時判不合法，不退化成串接）。
  * 匯入 `ptCountOf`、`computeTight`、`componentKids`。
  * ⚠ 新函式名要**避開 `glyph-browser-page.js` 的 `hasRefStroke`**——兩者內嵌進同一作用域，
    同名會讓整個瀏覽頁空白（建置的語法檢查抓到：`Cannot declare a function that shadows…`）。
* `tools/compose-fit.ts`：新增 **`inkAlignedBox()`**（墨跡對齊）與它的長註解（含實測比）。

**頁面**
* `tools/pinxing-page.js`：拼不出來時把**引擎的理由**帶進說明與浮層（`st.reason`）；
  串接退化改 warn 色並寫「不是原地換部件」；合成字形標「無碼位　以 U+… 為基」；
  **庫存改九組**（放回 `報土业`、加入 `街圭舞`）。
* `tools/glyph-browser-page.js`：`?comp=` 入口（`compFromQuery()`，最多三次解碼，接進初始化鏈）。

**驗收**
* `tools/free-compose-test.ts`：第 3 節配框預期改寫（原本把「街圭舞 沿用原框」寫成預期＝回報的 bug）、
  **第 10 節 IDS 槽位推斷**（含幾何斷言）。
* `tools/check-pinxing.ts`：L/L2/L3/M/N 步驟改寫（幸土业、報土业、彳舞亍、無碼位標示）、
  庫存 9 組與「沒有任何按鈕標參」。
* `tools/check-viewer.ts`：`盟` 緊框改成自行重算比對。

**文件**：`pinxing.md`（配框三步驟、IDS 槽位推斷、庫存九組、尚未通清單更新）、本檔。

**產出物**：四頁全部重建（`out/*.html`）；對照圖 `out/cmp-jiewu.png`（街圭舞 vs 衚胡舞）。

## 9. 已知限制與待辦（誠實清單）

* **`報幸土业` 仍是橫向串接**：新內容 `土业` 讀不成構形序列，與官方例子 `街行彳舞亍` **同形**，
  字面上分不出「想換 幸 裡的 土」還是「想用 土业 取代 幸」——只把結果講清楚，不誤判。
  （現在 `報土业` 直接可用，不需要這條替代寫法。）
* **檢視頁的成對替換（`composeFit`）還沒同步「墨跡對齊」**：目前只有 `evalSeq` 這條路有；
  兩條路的讓位規則本來共用，要一致的話得在 `composeFit` 也接上（並重跑 `check-codemirror`／
  `check-viewer`）。
* **IDS 沒有算子**：字形階層只知道「有哪些分量」，不知道左右／上下。目前的框是**從筆畫推**的，
  所以推不出來就沒有別的路（除非擴充字庫格式存算子）。
* **v1/v2 字庫 `codemirror-kage.html` 沒有 IDS 區段**，所以那一頁沒有槽位推斷。
* `todo.md` 裡還有：把 codemirror 的字庫換成 v3、IDS 側檔那條線、`out/` 無主產物的處置。
* glyph-browser 的 P1/P2（畫框與清單雙向連動、改名「部件序列」並移到「異體」之上、
  大字下加「作為基字拼形」按鈕）**還沒做**，記在 `pinxing.md`。
* 施工單 `拼形檢視器-施工單.md` 的驗收清單可再對一次（本輪新增的兩條引擎規則沒有寫回施工單）。

## 10. 環境坑（別重踩）

1. **builder 的樣板字串裡不可以出現反引號**——會提前結束字串，整頁空白；同一個坑專案踩過三次。
   `check-*.ts` 的探針字串同理（留言裡也不行）。
2. **不要用 PowerShell 改原始碼**（`Set-Content`／`>` 會弄壞 UTF-8）。要寫檔就用編輯工具；
   真的要用指令時 `[System.IO.File]::WriteAllText(path, text, UTF8Encoding($false))`。
3. **建置的 stderr 不可以丟掉**（`| Out-Null`）；建置失敗卻讀舊產物是最貴的錯。
4. **新增的頂層函式名要避開其他內嵌模組的同名函式**（見 §8 的 `hasRefStroke`）。
5. **`out/` 是產物、不進版控**；`nul` 是 Windows 的 NUL 裝置，不是檔案。
6. 版控規則：**只追蹤根目錄與 `novel/` 的 `*.md`**，使用者說「今日收工」才 commit（見 `README.md`）。

---

*相關文件：[`pinxing.md`](pinxing.md)（規格＋現況）、[`拼形檢視器-施工單.md`](拼形檢視器-施工單.md)（施工與驗收清單）、
[`format.md`](format.md)（字庫格式）、[`project.md`](project.md)（專案全貌）。*
