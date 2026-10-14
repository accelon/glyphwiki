# 自由組字編輯器：CodeMirror 6 版（施工回報）

> 對應 `../自由組字編輯器：MVP 施工單.md` §六，V4（CM 整合）已完成。
> 日期：2026-10

---

## 0. 兩頁分工（師父定案）

| 檔案 | 內容 | 建置 | 驗收 |
| --- | --- | --- | --- |
| `out/kage-viewer.html` | **只做字形檢視**（1.28 MB） | `bun run tools/build-kage-viewer.ts` | `bun run tools/check-viewer.ts` |
| `out/codemirror-kage.html` | **自由組字編輯器**（1.61 MB） | `bun run tools/build-codemirror-kage.ts` | `bun run tools/check-codemirror.ts` |

`kage-viewer.html` 已**還原成原本的樣子**（1.28 MB、沒有編輯器功能、沒有 `gc-inline` CSS），
驗收第 5 項會自動檢查「這一頁不該混入 CodeMirror 或編輯器 CSS」。

---

## 1. codemirror-kage.html 的行為

用 **CodeMirror 6**（不是 CM5——可行性研究原本以 CM5 為前提，師父改指 CM6）。

| 情境 | 行為 |
| --- | --- |
| 文中的構形序列 | **就地換成內嵌 SVG**（`Decoration.replace` + widget），正常閱讀 |
| **光標所在的序列** | **還原成 `︵…︶` 純文字**（才能改）＋ 標上淡黃底 |
| 浮窗（光標在序列內） | 放大預覽＋列出可替換部件（含層級）。**不受開關影響**（見下） |
| 浮窗（光標在正常字後） | 顯示該字＋可替換部件，點一下插入「基字＋部件」。**受開關控制** |
| doc | **永遠是 `︵…︶` 純文字** → 複製出去是構形序列、可刪、可還原（提案第 0 條／第 4、5 條） |

「光標所在的那一個才還原」是關鍵：如果所有序列都被換成不能點進去的 widget，
就沒辦法編輯了。這一點由 headless 瀏覽器實測斷言（見 §4）。

### 1.2 剪貼簿：像一般文字那樣複製、貼上

**問題的根源**：序列被 `Decoration.replace` 換成 SVG widget 之後，
**DOM 選取範圍裡沒有文字**（widget 的 `textContent` 只有換行）。
實測：只選一個 `︵街圭日︶` 時 `getSelection().toString()` 會拿到**空白**，
複製出去就是一片空白——不是圖，也不是序列。

**做法**：接管 `copy` / `cut` / `paste` 三個事件（掛在 `contentDOM` 的 capture 階段），
**文字一律直接取自 doc**，不讓瀏覽器從 DOM 推斷：

| 剪貼簿格式 | 內容 | 用途 |
| --- | --- | --- |
| `text/plain` | 就是 `︵街圭日︶`（構形序列本身） | 貼回本編輯器、貼進純文字編輯器；**可再編輯**（提案第 0 條） |
| `text/html` | 同一段文字，但序列的部分是內嵌 SVG（`title` 保留構形序列） | 貼到支援 HTML 的地方（Office、網頁、Obsidian）會顯示合成字形 |

所以「看起來像一個字」與「底層是可以再編輯的序列」同時成立。

貼上一律**只取純文字**、忽略 HTML——這樣貼進來一定是可再編輯的序列，
不會帶進別人的樣式。貼上的序列會立刻走同一條裝飾管線變成合成字形。

一個連帶修好的地方：**判斷「光標是否在序列內」只看光標（head），不看整個選取範圍**。
用範圍判斷的話，只要拖曳選取碰到序列就會把它變成可編輯文字，
而複製時要複製的常常是已經合成好的字形。

### 1.3 開關：正常字浮窗 開／關

工具列上有一顆 **「正常字浮窗：開／關」**（`aria-pressed` 跟著切換）：

- **開（預設）**：光標停在普通文字後面時，只要左邊的字可組字，就顯示浮窗與部件按鈕
  ——這是提案第 1、2 條「光標在字右邊 → 開始組字」的入口。
- **關**：這種情況**不顯示**浮窗，純閱讀／打字時畫面乾淨。

**關掉不影響序列內的浮窗**：光標進到構形序列裡時，那一個序列已經被還原成 `︵…︶`
純文字，看不到合成結果——所以那個浮窗是編輯序列的必要條件，不能一起關掉。

### 1.4 浮窗定位

`position: fixed` ＋ viewport 座標，並在**下方空間不夠時自動翻到光標上方**，
左右也夾在視窗內。先前固定往右下放，靠近頁面底部的字會被切掉一半
（驗收會斷言浮窗完全落在視窗內）。

### 實測截圖

| 檔案 | 內容 |
| --- | --- |
| `out/cm-shot-1.png` | 開頁原狀（序列都已合成字形） |
| `out/cm-shot-2.png` | 光標在 `︵街圭日︶` 內 → 變回文字、浮窗放大預覽、列出 L1/L2 部件 |
| `out/cm-toggle-on.png` | 光標在正常字「字」後面（開關＝**開**）→ 浮窗出現，含部件按鈕 |
| `out/cm-toggle-off.png` | 同一個位置（開關＝**關**）→ 浮窗不出現 |

---

## 2. CM6 怎麼內嵌（離線單頁）

```
vendor-cm/                 ← 只為了打包 CM6，不參與主專案
  package.json             @codemirror/{state,view,commands,language,search} 等
  src/entry.ts             重新匯出用到的符號
  src/global.ts            自己做 globalThis.CM6 = CM
  build.ts                 bun run vendor-cm/build.ts → dist/cm6.global.js（317 KB）
```

`codemirror-kage.html` 內嵌：kage-engine（99 KB）＋ tools 模組（33 KB）
＋ CM6（317 KB）＋ 字形庫 base64（1.16 MB）＝ **1.61 MB**。不連 CDN，離線可用。

**建置順序**（`vendor-cm/dist` 有進 `.gitignore`，可重建）：

```powershell
cd vendor-cm; npm install; cd ..
bun run vendor-cm/build.ts
bun run tools/build-codemirror-kage.ts
bun run tools/check-codemirror.ts
```

---

## 3. 三個踩到的坑（都加了斷言，不會再靜默發生）

### 3.1 `format:"iife" + globalName` 產不出全域賦值

Bun 1.3.11 產出 `(()=>{…})()`，**沒有** `var CM6=…`（開不開 minify 都一樣）。
改成打包 `src/global.ts`（自己做 `globalThis.CM6 = CM`）。

### 3.2 跨檔同名宣告會讓**整頁空白且沒有任何錯誤訊息**

各模組的 export 被拿掉後全部接在同一個 `<script>` 作用域，於是：

- `compose-fit.ts` 的 `const D` × `stroke-overlap.ts` 的 `const D` → SyntaxError
- 更隱蔽的：CM6 bundle 內部的 **`var D`** 與 tools 的 `const D` 也撞名

整個 script 不執行、頁面一片空白。處理：

1. tools 的常數改成不易撞的名字（`PROJ_ROOT`／`OVERLAP_ROOT`）
2. CM6 bundle **包一層 IIFE**，內部符號不外洩（`vendor-cm/build.ts` 會斷言）
3. **兩個 build script 都加了 `new Function` 語法檢查**，撞名就 exit 1 並指出原因

### 3.3 `RangeSetBuilder.add()` 有兩種重載，混用會靜默不生效

我原本混用 `add(from, to, value)` 與 `add(range, value)`，結果**整排序列都沒被換掉，
卻沒有任何錯誤**。改用 `Decoration.set(ranges, true)`（自行排序，語意單一）。

### 3.4 widget 預設不保證 inline

`WidgetType.toDOM()` 回傳的 span 沒有明確 `display`，8 個序列被排成 8 行。
已在 widget 上明確指定 `display:inline;white-space:nowrap`。

---

## 4. 驗收（`bun run tools/check-codemirror.ts`）

五段，全部通過：

1. **兩頁的內嵌模組碼都能編譯**（擋掉跨檔同名宣告）
2. **CM6 bundle**：自己掛上 `globalThis.CM6`、無 export、與 tools 共處一作用域不語法錯誤
3. **內嵌碼真的能跑**：解碼 70,416 字形、`u571f-j` 緊框 `[14,17,186,169]`、
   組字可用、內嵌 SVG 帶 `gc-inline`／`currentColor`／`viewBox`、
   已移除 width/height、`INLINE_CSS` 六項齊全（含實測修正的 `-0.22em` 基線）
4. **三條護欄**：只認出 1 個合法序列、掃描可完整還原原文
5. **headless 瀏覽器實跑**（把探針腳本注入頁面，讀 `<title>` 回報；共 19 條斷言）：

```
active=1  widgets=7  widgetsWithSvg=7  popVisible=true  popHasSvg=true  partBtns=3
activeAfterMoveOut=0  widgetsAfterMoveOut=8
btnLabel=正常字浮窗：開  pressed=true  charPopOn=true
afterOff=false  afterOffLabel=正常字浮窗：關  afterOffPressed=false
seqPopStillOn=true  afterOnLabel=正常字浮窗：開
popRect=44,297,366,242  vw=1000  vh=583
```

剪貼簿那一組：`copyText="︵街圭日︶"`（不是空白）、
`copyHasSvg=true`（text/html 裡是內嵌 SVG）、`copyHasSeq=true`（title 帶著序列）、
`pasteDelta=5/5`（貼上只插入一次，長度正好是序列長度）、`pastedRendered=true`（貼上即合成）。

即：光標所在序列被標記（還原成文字）、其餘 7 個都換成內嵌 SVG、浮窗出現、
浮窗裡有放大字形、列出 3 個可替換部件；光標移開後標記消失。
開關：正常字後面浮窗出現 → 按一下關掉（不出現、按鈕文字與 `aria-pressed` 都更新）
→ **序列內的浮窗仍照常出現** → 再按一下恢復。浮窗也確認完全落在視窗內。

---

## 5. V1 的基線修正（沿用上一輪的結論）

施工單指定 `vertical-align: -0.1em`，實測是錯的——會讓字浮起來。
逐格量測（把系統字與內嵌 SVG 放同一行 normal inline flow，比較墨跡下界）：

| `vertical-align` | 0.10 | 0.15 | 0.20 | **0.22** | 0.25 | 0.30 |
| --- | --- | --- | --- | --- | --- | --- |
| Δ（px，100px 字級） | −12 | −7 | −2 | **0** | +3 | +8 |

所以用 **`-0.22em`**（`INLINE_CSS`）。顏色與大小兩條照施工單沒改：
`fill: currentColor`、`width: 1em; height: 1em`。

> 方法論的坑：**不能**用 `position:absolute` 定位去量，絕對定位不參與基線對齊，
> 會得到完全不同的位移（我先量到錯的 −0.38em）。

---

## 6. 引擎瑕疵的處理（照師父指示：先略過）

示範素材改用引擎做得好的例子（沿用原框、100% 不縮）：

```
街圭日　街圭月　街圭山　街行月　街行土　寶貝口　寶貝山　清青日　清青月
城土日　地也日　地也山　盟明月　盟明口　峰山日　峰夆水　字宀口　字宀山　字宀大　話舌日
```

`out/demo-cases.png` 有對照。判準與量測工具：

- **唯一可靠的客觀訊號是 `composeFit` 回報的 `scale`**（放不進原槽位就被縮小，
  縮得越多越醜）。試過長寬比、多邊形周長、墨跡覆蓋率三種啟發式**全部不成立**
  （CJK 部件幾乎都是滿格），細節寫在 `tools/case-sheets.ts` 的檔頭。
- `tools/case-sheets.ts` 產生候選聯絡表（`out/sheet-a.png`、`sheet-b.png`）給人眼挑。

---

## 7. 檔案清單

| 檔案 | 動作 |
| --- | --- |
| `tools/build-codemirror-kage.ts` | **新增**：產生 CM6 編輯器單頁 |
| `tools/check-codemirror.ts` | **新增**：五段驗收（含 headless 行為斷言） |
| `vendor-cm/` | **新增**：CM6 下載與打包（`dist/` 與 `node_modules/` 已進 .gitignore） |
| `tools/build-kage-viewer.ts` | **還原**：只做字形檢視 |
| `tools/check-viewer.ts` | **還原＋加強**：加上「這一頁不該有編輯器功能」 |
| `tools/free-compose.ts` | 語意、`︵︶` 三護欄、內嵌 SVG 渲染器、部件清單（上一輪新增，兩頁共用） |
| `tools/compose-fit.ts` | 回報 `steps`（`scale`／`arDiff`／`overflow`）；常數改名避免撞名 |
| `tools/stroke-overlap.ts` | 常數改名；改呼叫 `ensureEngine()` |
| `tools/case-sheets.ts` | **新增**：候選替換聯絡表 |

護欄遵守情形：**只有一份解碼實作**（`tools/lib-format.ts` 原文內嵌，兩頁共用）；
**三個斷言都在**（`check-viewer.ts` 第 2、4 項＋`check-codemirror.ts` 第 3 項）；
改檔案全程用編輯工具。

---

## 8. 建議的下一步

1. **引擎的縮放問題**仍是「好不好用」的真正瓶頸（部件比槽位大就被縮成小字）。
   方向：按槽位形狀挑變體（`composeFit` 已有 `pickBestVariant`）再推一步，
   或做「整棵子樹重畫」讓槽位跟著新部件調整。
2. **整棵子樹重畫**：這是提案第 2、3 條完整實作的真正前置
   ——`亍`、`土` 這類已被展開成筆畫的部件目前換不掉。
3. 缺口二（文字層語意：搜尋／字數）照原計畫留到第二版。
4. 浮窗目前是「光標附近的自製面板」。若要更像 IME 的候選窗，可改用 CM6 的
   `tooltips()` 或 `showPanel()`，讓它跟著編輯器一起處理翻面與捲動。



