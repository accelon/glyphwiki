# Ext B 字庫與 holy grail（回報）

> 對應 `../配合編輯器修組字引擎.md` 的目標，這是它說的**第一步**：
> 「先打包好含 BMP + CJK Ext A + CJK Ext B 的字庫，然後試試生成
> `邏羅寶貝𩀨從䞃致招`，用師父給的圖檢驗成效。」

---

## 0. 一句話結論

| 項目 | 結果 |
| --- | --- |
| 字庫（**全部 Unicode CJK 漢字區塊**） | ✅ 191,727 字形、3.74 MB（gzip **1.79 MB**） |
| `邏羅寶貝𩀨從䞃致招` 生成 | ✅ 九個字全部在庫、**用既有的 `evalSeq` 直接跑完四步** |
| 組字與查字共用一套數據 | ✅ 同一個 `out/lib-cjk-all.bin.gz` |
| 對外 API | ✅ 只用 Unicode；內部命名不外流，另有名字對照表可查回 dump |
| 與師父參考圖的相似度 | ⚠️ 版面已可用（王缶、隹貝招都看得清楚），但還沒到參考圖那樣鬆（±3 格 IoU 0.71） |

**最重要的變化**：`𩀨`（U+29028）以前不在庫，所以才要 `twoPartViaTemplate`
「借一個隹在左的字、把右件換成從」硬造。Ext B 進庫之後它就是真字，
**那個借模板的動作整個可以刪掉**，序列直接用既有引擎跑。

**第二個變化**：字庫的內部命名不再是 GlyphWiki 的名字。
名字層從 gzip 的 20.7% 降到 1.7%，而且對外介面收斂成「只認碼位」——
詳見 §1.5。

---

## 1. 字庫：舊 vs 新

| | 舊 `out/lib-cjk.bin.gz` | 新 `out/lib-cjk-all.bin.gz` |
| --- | --- | --- |
| 格式 | v1（無魔數，名字是字串） | **v2**（`"GL"` 魔數 ＋ 家族表） |
| 碼位區段 | `U+3400..U+FAFF`（含非漢字） | **12 個 CJK 漢字區塊**，URO ＋ Ext A..I ＋ 相容區／相容補充 |
| 根字（碼位字） | 40,266 | **98,701** |
| 閉包字形 | 70,416 | **191,727** |
| 家族 | — | 98,777（＋1,243 個無碼位的部件） |
| .bin | 1.65 MB | 3.74 MB |
| .gz | 0.87 MB | **1.79 MB** |
| base64（內嵌單頁） | 1.16 MB | **2.39 MB** |

舊的 `0x3400..0xFAFF` 其實還夾帶了 12,210 個**非漢字**（諺文、彝文…），
因為那個範圍橫跨了它們的區段。新版改列精確的漢字區段，
所以「換成 Ext B」不是單純變大，而是**同時換掉一批雜訊**。

### 建置指令

```powershell
bun run tools/build-library.ts --out out/lib-cjk-all.bin
```

一次寫出三個檔案：

| 檔案 | 內容 | 進前端？ |
| --- | --- | --- |
| `out/lib-cjk-all.bin` / `.bin.gz` | 字庫本體（家族表 ＋ 筆畫） | ✅ |
| `out/lib-cjk-all.gnames.tsv.gz` | 名字對照表（2.70 MB／gzip 0.89 MB） | ❌ 只有除錯／回寫 dump 要 |

* 舊行為仍可重現：`--range 0x3400 0xFAFF`（但寫出的仍是 v2 格式）。
* 想換字集：`--ranges 3400-4DBF 4E00-9FFF F900-FAFF 20000-2A6DF 2F800-2FA1F`。

### 1.1 收錄範圍：12 個 CJK 漢字區塊

| 區塊 | 碼位 | 字數 |
| --- | --- | --- |
| Ext A | `U+3400..U+4DBF` | 6,592 |
| URO | `U+4E00..U+9FFF` | 20,992 |
| 相容區 | `U+F900..U+FAFF` | 472 |
| Ext B | `U+20000..U+2A6DF` | 42,720 |
| Ext C | `U+2A700..U+2B73F` | 4,160 |
| Ext D | `U+2B740..U+2B81F` | 223 |
| Ext E | `U+2B820..U+2CEAF` | 5,774 |
| Ext F | `U+2CEB0..U+2EBEF` | 7,473 |
| Ext I | `U+2EBF0..U+2EE5D` | 622 |
| 相容補充 | `U+2F800..U+2FA1F` | 542 |
| Ext G | `U+30000..U+3134F` | 4,939 |
| Ext H | `U+31350..U+323AF` | 4,192 |
| **合計** | | **98,701** |

邊界取「區塊」而不是「已編配的碼位」：區塊內的保留碼位在 DB 裡本來就沒有字形，
取了不會多收東西；反過來若把邊界寫成已編配的尾端，Unicode 之後擴充就得再改一次。

`bun run tools/check-lib-compat.ts` 會逐區塊數給你看（12 個區塊全部有字），
`bun run tools/block-sheet.ts` 則從每個區塊挑 6 個字畫成一張 `out/cjk-blocks.png`。

### 1.2 容量：多了 39% 的碼位，只多了 36% 的 gzip

| | 只有 BMP+ExtB | 全 CJK |
| --- | --- | --- |
| 根字 | 70,776 | 98,701（+39%） |
| 閉包字形 | 137,088 | 191,727（+40%） |
| .bin | 2.76 MB | 3.74 MB |
| .gz | 1.32 MB | **1.79 MB（+0.47 MB）** |
| base64（內嵌） | 1.76 MB | 2.39 MB |

攤到每個字形大約 **9.4 bytes gzip**（名字層只佔 0.17 bytes），
所以擴充區收得越多，平均成本反而被名字層的固定開銷稀釋掉。

---

## 1.5 內部命名：不再沿用 GlyphWiki 的 id

### 為什麼要改

舊版把 GlyphWiki 的名字**當成介面**：呼叫端要寫
`findGlyphIndex(lib, "u908f-j")`，於是每一處都得懂 GlyphWiki 的異體命名規則
（`-j`、`-01`、`-var-001`、`-ue0100@3`、`cdp-8bb0`、`u2ff0-u9b2f-u5f61-…`）。
而這些字串在檔案裡佔了 gzip 後的 **20.7%**。

實際上名字只有三個用途，其中只有第 1 個是介面：

1. **碼位 → 字形**（對外唯一需要的）
2. 家族關係（正字／異體）——`isVariantOf`、挑變體、搜尋過濾
3. 回查 GlyphWiki dump——**只有除錯要，不該進前端**

### 新設計

```
對外（模組使用者只看到這個）
   indexOfChar(lib, "邏")            → 字形索引
   indexOfCodePoint(lib, 0x29028)    → 𩀨
   charOf(lib, i) / codePointOf(lib, i)
   isVariantOfCp(lib, i, cp)

內部（不承諾、不該被解析）
   keyOf(i) = "g" + i.toString(36)   ← 只給 KAGE 引擎當 hash key
   lib.families[]                    ← 碼位 ＋ 成員區段（連續）

回查 dump（不進前端）
   out/lib-cjk-all.gnames.tsv.gz     ← 「內部索引 ⇥ GlyphWiki 名字」
   loadWikiNames(lib, text)          ← 載入後 displayName() 就印得出原名
```

**關鍵一步是重排字形**：把同一家族的成員排成連續區段、家族依碼位遞增。
這樣家族表只需要「碼位差值 ＋ 成員數 ＋ 偏好位移」三個數值，不必逐字存名字。
順帶讓筆畫區塊的 gzip 也少了 118 KB（同性質的資料聚在一起）。

### 效果

```
                      v1（70,416 字形）   v2（191,727 字形）
名字／家族區塊 raw       291,148            214,082
名字／家族區塊 gzip      188,604             32,793     ← 20.7% → 1.7%
每個字形攤到的 gzip        2.68 bytes          0.19 bytes
```

字形數是 2.72 倍、全檔 gzip 只多 1.07 倍（0.87 MB → 1.79 MB）。
名字層攤到每個字形是 0.17 bytes（v1 是 2.68）。
（`bun run tools/name-cost.ts` 可以隨時重算。）

### 相容性：舊檔照讀

`decodeLibrary` 會看開頭有沒有 `"GL"` 魔數：沒有就當 **v1** 讀。
所以 `out/lib-cjk.bin.gz` 與**內嵌它的兩個網頁都不必重建**，
`check-viewer.ts` / `check-codemirror.ts` 的既有斷言也還成立。

v1 的家族是查詢時由名字推出來的，而且**偏好規則與舊版逐字元一致**——
`tools/check-lib-compat.ts` 把舊版 `findGlyphIndex` 抄一份當黃金標準，
對 40,995 個碼位逐一比對，**全部一致**。

> 過程中量到一個必須照抄的怪癖：舊版是「`-j` 優先；`uXXXX` 本身**只在還沒有候選時**
> 才算候選」。所以 `u9adf-03` 若排在 `u9adf` 前面，舊版回傳的是 `u9adf-03`。
> 不照抄的話 40,995 個碼位裡會有 346 個選到不同字形。

---

## 2. 為什麼加了 Ext B 就變簡單

`𩀨`（`u29028-j`）在庫裡的真實結構（`tools/verify-box-map.ts` 量出來的）：

```
u29028-j
  框[0,0,200,200]   ↓ u96b9-01@1   ← 隹的「左偏形」，自己只有 76 格寬
  框[75,0,195,200]  ↓ u5f9e@6      ← 從
```

於是整條序列就是單純的遞歸替換，`free-compose.ts` 的 `evalSeq` 一次跑完
（`substituted = true`，不是退化成串接）：

```
1. 䞃 的 致 → 招
2. 𩀨 的 從 → 䞃致招
3. 寶 的 貝 → 𩀨從䞃致招
4. 邏 的 羅 → 寶貝𩀨從䞃致招
```

> 順帶釐清一件事：`../配合編輯器修組字引擎.md` §1.3 把側枝寫成
> 「致招 ＝ 致 的 至 → 招」。實際上 `䞃`（U+4783）的 IDS 是 **⿰貝致**，
> 所以正確的側枝是「**䞃 的 致 → 招**」——這才用得到序列裡那個 `䞃`。
> 兩種讀法（巢狀 vs 依序成對）在本例得到**同一個結果**，所以不影響成品。

```powershell
bun run tools/compose-grail-extb.ts          # 逐字檢查 → 求值 → 量測 → 查字 → 出圖
```

輸出：`out/grail-extb.svg`、`out/grail-extb.png`、`out/grail-extb-compare.png`。

---

## 3. 順手修掉的四個靜默錯誤

這幾個都不會報錯，只會讓結果悄悄錯掉，所以一併修了：

| # | 位置 | 症狀 | 修法 |
| --- | --- | --- | --- |
| 1 | `build-library.ts` 收閉包 | 用 `parts` 表推子字形，**Ext B 有一批字的 `parts` 紀錄不全** → 497 筆引用指向沒收進來的字形 | 改成**從筆畫資料 `data` 自己推**引用；懸空引用 497 → 3 |
| 2 | `build-library.ts` 寫引用 | 找不到的引用靜默寫成**索引 0**（＝指到 `names[0]`）→ 497 筆全部畫成 U+3400 㐀 | 改成**整條引用丟掉**：子字形不存在時它本來就畫不出東西 |
| 3 | `raster.ts` 填色規則 | 用 even-odd；KAGE 的筆畫是一筆一個四邊形、轉角重疊 → 每個重疊處翻成「洞」，組字圖**整片棋盤格** | 改成 **nonzero winding**（`polygons.js` 產生 `<path fill="black">` 且沒指定 `fill-rule`，SVG 預設就是 nonzero） |
| 4 | PNG 輸出 | `Bun.deflateSync` 產出的是**原始 deflate**（`63 60…`），PNG 的 IDAT 要 **zlib 包裝**（`78 9c…`）→ 檔案像 PNG 但讀圖時 broken data stream | 改用 `node:zlib` 的 `deflateSync` |
| 5 | v2 家族表 | 寫入端把 `pref`／`plain` 打包成 **5＋3 bit**，讀取端卻解成 **4＋4 bit** → `indexOfCodePoint` 全部回傳家族的第一個成員（`邏` 從 `u908f-j` 變成 `u908f`） | 兩邊統一 5＋3；並把「用剛寫出的檔自己解一次」加進建置收尾驗證 |

另外在 `build-library.ts` 補了一個**框字典順序**的坑：
`buildBoxDict` 依「走訪順序」發索引，所以「濾掉懸空引用」必須在**建字典之前**做完，
而且重排字形之後，字典與筆畫都必須用**新的順序**走，
否則字典用舊順序、寫出用新順序，整庫的框索引會全部錯位。

驗收：`free-compose-test.ts`、`check-viewer.ts`、`check-codemirror.ts`、
`check-lib-compat.ts` 四支**全部通過**。

---

## 4. 跟參考圖比對：差在哪裡

參考圖先落地成機器可讀的 `out/ref/flat.png` / `flat.pgm`
（原檔是 RGBA、**字形藏在 alpha 通道**，RGB 全 0，要先合成到白底才看得到）。

### 4.1 參考圖不是資料庫裡的既有字

在 `db/glyphwiki.db` 搜「同時引用 隹（`u96b9*`）與 招（`u62db*`）」，
找到 19 個候選，包含一批 **IDS 命名的合成字**：

```
u2ff2-u96b9-u8c9d-u62db                              ＝ ⿲隹貝招
u2ff1-u21a67-u2ff2-u96b9-u8c9d-u62db                 ＝ ⿱𡩧⿲隹貝招
u2ffa-ufa66-u2ff3-u5b80-u73ce-u2ff2-u96b9-u8c9d-u62db ＝ ⿺辶⿳宀王⿲隹貝招
```

**但沒有一個對得上**（含 `hanzikanji_zhaocaijinbao`、`sawn-f000d`、`utc-00949`…）。
用「容許位移的 IoU」排名，**第一名是我們自己組出來的成品**——
所以參考圖應該是別的工具／別的手法做出來的，不是庫裡的現成字。

> 為什麼要「容許位移」：筆畫只有 2~3 格寬，差 1 格就讓原始 IoU 崩掉，
> 那個數字反映的是「對齊」不是「像不像」。所以同時報兩個。

### 4.2 量到的數字

| 指標 | 值 |
| --- | --- |
| 參考圖墨跡 | `[15,16,191,185]` |
| 本成品墨跡 | `[12,13,194,185]` |
| 原始 IoU | 0.3909 |
| 容許位移 ±1 / ±2 / ±3 格 | 0.4980 / 0.6019 / **0.6970** |

`招` 在成品裡的最終大小（**沿整條引用鏈疊起來**的實際墨跡，不是量單層框）：

```
招  自身 172×175  →  成品中 50×111（寬 29%、高 63%）
隹  自身 169×173  →  成品中 57×110（寬 34%、高 64%）
貝  自身 158×166  →  成品中 25×109（寬 16%、高 66%）
```

**寬被壓得比高慘得多**。原因在 `kage-engine/kage.js` 的 `getEachStrokesOfBuhin`：

```js
x1 + temp[i][3] * (x2 - x1) / 200,
y1 + temp[i][4] * (y2 - y1) / 200,
```

引用框是把子字形**整張 200×200 畫布仿射映射到框**，而且 **x、y 各自縮放**。
`compose-fit.ts` 檔頭寫的「把緊框**等比**縮放置中到該框」是**錯的**——
難怪沿用舊框時會出現「寬 29%、高 63%」這種非等比壓扁。

### 4.3 一條可行規則（有數字支撐）

把「`寶 的 貝 → 𩀨`」那一步的框，從資料庫的人工框 `[0,49,200,196]`
換成 **`寶` 的下半 `[0,105,200,200]`**：

| 框 | 原始 IoU | ±1 | ±2 |
| --- | --- | --- | --- |
| `[0,49,200,196]`（沿用人工框） | 0.3909 | 0.4980 | **0.6019** |
| `[0,100,200,200]`（寶的下半） | — | 0.6001 | **0.6823** |

目視上幾乎就是參考圖了（`out/grail-sweep.png` 第三格）。
再對三個框做座標下降最佳化（`tools/grail-fit-optimize.ts`）只再多一點：

```
寶的貝→𩀨   框[0,108,200,196]
𩀨的從→䞃  框[72,-21,195,211]
䞃的致→招   框[67,9,193,197]
        → ±1 0.6094　±2 0.6897
```

**但**：把「新部件用舊部件的墨跡框」這條規則**一律套在每一層**反而更差
（原始 IoU 0.3047 < 沿用原框的 0.3909）。

> 結論：不是「換一條公式」就能解決。真正缺的仍然是
> `../配合編輯器修組字引擎.md` §4.2 的**同層版面重分配**——
> 換上去的內容變寬了，同一層的兄弟框要跟著讓位，
> 而不是全部塞進舊槽位再非等比壓扁。

---

## 5. 查字：同一套數據

```powershell
bun run tools/search-slot.ts 隹 左 --lib out/lib-cjk-all.bin.gz
# → 23 筆，其中 u29028-j（𩀨）自己就在裡面

bun run tools/search-slot.ts --stats 隹 --lib out/lib-cjk-all.bin.gz
# → 隹 共 382 次直接引用：滿 163、右 90、中 62、下 33、上 23、左 11
#   全庫掃描 369 ms
```

舊字庫只有 5 個「隹在左」，新字庫多出 `u2a56a-j`、`u2a189-j`、`u29565` 等
Ext B 的字——這正是師父要的「按部件位置搜尋」的價值：
**找到別的含同位部件的字，拿來當模板或線索**。

---

## 6. 網頁 `kage-viewer.html`：換成 Ext B 字庫

師父要求「改一下網頁 kage-viewer.html」，所以這一頁現在內嵌
**BMP + Ext A + Ext B** 字庫（原本是 BMP-only，所以 `𩀨` 根本不在裡面）。

改了四件事，**沒有加新功能**（這一頁的定位仍然是「只做字形檢視」）：

| 改動 | 說明 |
| --- | --- |
| 資料 | `out/lib-cjk.bin.gz` → `out/lib-cjk-all.bin.gz`（base64 1.16 MB → 2.39 MB） |
| 查字 | `findGlyphIndex(L, "u"+hex)` → `indexOfCodePoint(L, cp)`（**只認 Unicode**） |
| KAGE key | `L.names[i]` → `keyOfIdx(L, i)`（內部 key，字庫裡已經沒有名字字串） |
| 開頁預設 | 輸入框預設就是 `邏羅寶貝𩀨從䞃致招`，打開就看到成品（清掉即可打別的） |

### 兩種讀法在這裡會得到同一個結果

`kage-viewer.html` 的組字規則是「第 1 字為主字，其餘每兩字為一組替換」（`composeFit`），
而 `︵…︶` 構形序列是遞歸讀法（`evalSeq`）。**實際畫出來量過，兩者完全一樣**：

```
A 遞歸（evalSeq）        墨跡 [12,13,201,185]　±2 0.6160
B 成對（composeFit）     墨跡 [12,13,201,185]　±2 0.6160
```

（`bun run tools/grail-readings.ts`，出圖 `out/grail-readings.png`。）
所以這一頁**不需要**為了 holy grail 改語意。

### 驗收多了一道：真的用瀏覽器開

`check-viewer.ts` 原本只驗「內嵌的模組碼在 Node 裡跑得動」，
那**不保證頁面打開來畫得出來**（`svgFor` 是頁面自己的程式碼）。
現在多一步：用 Edge headless 真的開這一頁，讀回

```
status=顯示 1 格  cards=1  hasSvg=true  paths=89  svgW=200  err=0
```

並順手截圖 `out/kage-viewer-shot.png`。

### 順帶量到的一件事：換庫會讓 522 個碼位換異體

兩份庫是不同的閉包，所以同一個碼位可能挑到不同的**異體**：

```
BMP 也有的碼位：指名相同 27,819、指名不同異體 522、指到錯的碼位 0
只有 ExtB 才有的碼位：42,466
```

522 個全部**還是同一個字**，只是換了字形（例如 `盟` 從 `u76df` 變成 `u76df-j`）——
因為 Ext B 把更多 `-j` 變體拉進了閉包，而偏好規則本來就是 `-j` 優先。
`check-lib-compat.ts` 已把這一節固定下來（判準是「有沒有指到屬於自己的字形」，
異體差異只記錄不判錯）。

> 一個已知的舊毛病（**本輪沒修**）：`U+2FF0..U+2FFB` 這幾個 IDC 組字運算子，
> 查出來的是一堆 `u2ff0-…` 的 IDS 合成字而不是運算子本身。
> 原因是那些合成字的名字以 `u2ff0` 開頭、被歸進同一個家族，
> 而真正的 `u2ff0` 不在閉包裡（沒有被任何字引用）。
> 修法很便宜：字集加一段 `2FF0-2FFB`（12 個碼位）就會蓋過去——
> `bun run tools/build-library.ts --ranges <原本的 12 段> 2FF0-2FFB`。
> v1 時代就有這個現象，只是擴充區進來之後更容易遇到。

---

## 6.5 同層讓位：修「筆劃都疊起來了」

師父看到的成品是「王缶看不清楚」——這是引擎的**版面**問題，不是字形資料問題。

### 病因（量出來的）

`寶 的 貝 → 𩀨` 這一步沿用 貝 的舊框 `[0,49,200,196]`。
那個框會把子字形的**整張 200×200 畫布**映射進去（y 縮到 73.5%），
於是 𩀨 的墨跡落在 y 61.5..187；但同層的「宀王缶」佔到 y 108。

**兩者重疊 46.5 格**，整個下半壓在上半上面。

舊的 `fitsIn` 判準完全抓不到這件事：它只看
「長寬比像不像」與「有沒有超出字身」，**根本不管同層有沒有別人**。
`貝 → 𩀨` 的形狀差是 24.4%，剛好壓在 25% 門檻底下，所以被判成「沿用原框」。

### 修法：`refitBand`（同層讓位）

替換時如果新內容壓到同層兄弟的墨跡（超過 3 格），就把框退到
「**從兄弟邊緣到畫布邊緣**」的帶狀區；交叉軸沿用舊框的範圍。

刻意**只動被替換的那一個框**——框是人工手動調的資產（`../format.md`「框與自由組字」），
兄弟的框不碰。實測結果：

```
貝 → 𩀨   框[0,49,200,196] → [0,108,200,200]     （寶 的下半）
從 → 䞃   框[75,0,195,200] → [87,0,200,199]
致 → 招   框[64,0,194,200] → [72,0,200,200]
邏 的 羅 → 寶  沒壓到兄弟 → 沿用原框不變
```

放在**挑變體之後**：挑變體解決「形狀對不對」（木在左要變窄），讓位解決「有沒有位置」，
兩者不能互相取代。

### 效果

![讓位前後](../out/band-compare.png)

| 例子 | 讓位前後相異的著墨像素 |
| --- | --- |
| `邏羅寶貝𩀨從䞃致招` | 18.09% |
| `峰夆電雨水`（官方例） | 22.55% |
| `電雨水` | 13.42% |
| `寶缶支`（已知良好） | **0.00%** |
| `街圭舞` | **0.00%** |

已知良好的兩個例子**一個像素都沒動**，該修的幾個都修好了。
與參考圖的 ±2 格相似度 0.6019 → **0.6160**、±3 格 0.6970 → 0.7137
（原始 IoU 0.3909 → 0.3554 反而降，因為那個數字主要在反映「對齊」不是「像不像」）。

`tools/band-compare.ts` 可以把讓位開／關並排給人看，
`composeFit` 與 `evalSeq` 都吃 `{ band: false }` 這個開關。
`free-compose-test.ts` 原本斷言 `電 的 雨 → 水` 的訊息是「沿用原框」，
現在改成斷言**讀法順序**，框的變化交給目視對照（並補上「該讓位／不該讓位」兩條）。

---

## 7. 下一步（還沒做）

1. **把 Ext B 字庫接進編輯器／檢視**
   只要改 `tools/build-kage-viewer.ts` 與 `tools/build-codemirror-kage.ts` 的
   `LIB_GZ` 常數指向 `out/lib-cjk-all.bin.gz`，再重建兩頁。
   代價：base64 +0.6 MB（單頁 1.6 MB → 約 2.6 MB）。
   尚未做，因為這一步會動到已經驗收過的兩頁，建議單獨一輪。
2. **缺口 B：同層版面重分配**（`overlap`／`scale` 兩個客觀訊號已就緒）。
   本檔 §4.3 的掃框結果可以直接當回歸測試：目標是把 ±2 格的 IoU 從 0.60 推到 0.85 以上。
3. **編輯器那一頁（`codemirror-kage.html`）還沒換庫**。
   它仍然內嵌 v1 的 BMP 字庫（讀得到，但拿不到 Ext B）。
   換過去只要改 `tools/build-codemirror-kage.ts` 的 `LIB_GZ` 再重建，
   但 `check-codemirror.ts` 裡「字形數 = 70416」那類斷言要一起更新——
   建議照 §6 的做法，也補一道 headless 實跑。
4. `compose-grail.ts`（舊的借模板版）現在是多餘的，可以留作對照或刪掉。

---

## 8. 本輪新增／修改的檔案

| 檔案 | 內容 |
| --- | --- |
| `tools/lib-format.ts` | **改**：格式 v2（魔數 ＋ 家族表）、Unicode-first API（`indexOfChar`／`codePointOf`／`isVariantOfCp`／`charOf`／`isPlainIdeograph`／`displayName`／`loadWikiNames`）、內部 key `keyOf()`；v1 仍可讀且偏好規則逐字元相容 |
| `tools/build-library.ts` | **改**：多區段 `--ranges`、家族歸屬改讀 DB 的 `name_type`／`codepoint`、**重排字形**讓家族連續、寫出 v2 ＋ 名字對照表、收尾自我解碼驗證 |
| `tools/lib-load.ts` | **新**：Node 端載入字庫（含自動載入名字對照表）的單一入口 |
| `out/lib-cjk-all.bin` / `.gz` | **新**：全 CJK 字庫（3.74 MB / **1.79 MB gzip**） |
| `out/lib-cjk-all.gnames.tsv.gz` | **新**：名字對照表（內部索引 ⇥ GlyphWiki 名字，2.70 MB / 0.89 MB gzip，**不進前端**） |
| `tools/check-lib-compat.ts` | **新**：把舊版 `findGlyphIndex` 抄成黃金標準，對全部碼位比對新舊一致性；再加「跨字庫異體差異」與「12 個 CJK 區塊覆蓋率」兩節 |
| `tools/block-sheet.ts` | **新**：從每個 CJK 區塊挑 6 個字畫成一張對照表（`out/cjk-blocks.png`） |
| `tools/grail-readings.ts` | **新**：同一條序列的「遞歸 vs 成對」兩種讀法畫出來量，證明結果相同 |
| `tools/band-compare.ts` | **新**：同層讓位開／關的並排對照（版面色決定要靠看的） |
| `tools/compose-fit.ts` | **改**：新增 `siblingInkOf`／`refitBand`（同層讓位）與 `FitOptions.band` 開關 |
| `tools/free-compose.ts` | **改**：`applyReplace` 也走同一條讓位規則；`SeqOptions.band` 開關 |
| `tools/free-compose-test.ts` | **改**：`電 的 雨 → 水` 由「框不變」改成斷言**讀法順序**，並補「該讓位／不該讓位」兩條 |
| `tools/build-kage-viewer.ts` | **改**：內嵌 Ext B 字庫、改用 Unicode API、開頁預設 holy grail 序列 |
| `tools/check-viewer.ts` | **改**：改驗 Ext B／v2／holy grail，並加一道 **headless 瀏覽器實跑＋截圖** |
| `out/kage-viewer.html` | **改**：1.6 MB → 2.5 MB（字庫 1.16 → 2.39 MB base64） |
| `out/codemirror-kage.html` | **改**：重建以帶入同一條讓位規則（仍用 BMP 字庫） |
| `out/kage-viewer-shot.png` | **新**：headless Edge 開這一頁的截圖 |
| `out/band-compare.png` | **新**：讓位開／關並排（5 個例子） |
| `out/zhaocaijinbao-4chars.png` | **新**：招財進寶四個字 |
| `out/grail-readings.png` | **新**：參考圖／讓位前／讓位後 三格對照 |
| `tools/name-cost.ts` | **改**：算名字／家族區塊的成本，v1 與 v2 對照 |
| `tools/compose-grail-extb.ts` | **新**：holy grail 施工＋量測＋查字＋與參考圖比對出圖 |
| `tools/probe-extb.ts` | **新**：Ext B 覆蓋率、閉包大小、九字與 IDS 前置量測 |
| `tools/probe-grail-tree.ts` | **新**：直接從 DB 印引用樹與框 |
| `tools/verify-box-map.ts` | **新**：實測 kage 引用框的映射公式（證明「框是**非等比**映射整張畫布」） |
| `tools/identify-reference.ts` | **新**：在 DB 裡搜「隹＋招」候選，比對參考圖 |
| `tools/grail-fit-compare.ts` | **新**：五種放入策略（keep／uniform／uniform-grow／inkfit／inkbox）比 IoU |
| `tools/grail-box-sweep.ts` | **新**：單一框的掃描（找出「寶的下半」） |
| `tools/grail-fit-optimize.ts` | **新**：三個框的座標下降最佳化 |
| `tools/raster.ts` | **改**：even-odd → nonzero winding；加包圍盒加速 |
| `tools/compose-fit.ts`、`free-compose.ts`、`stroke-overlap.ts` | **改**：改走 Unicode API 與內部 key，v1／v2 兩種庫都能跑 |
| `tools/search-slot.ts` | **改**：加 `--lib`，查字可指向 Ext B 字庫 |
| `out/ref/flat.png` / `.pgm` | **新**：參考圖的機器可讀版本（從 alpha 通道合成白底） |
| `out/grail-extb.png` / `.svg` / `-compare.png` | **新**：成品與「參考／成品／差異」對照圖 |
| `out/grail-sweep.png`、`grail-optimized.png`、`grail-fit-compare.png`、`ref-identify.png` | **新**：各項量測的證據圖 |
| `out/grail-extb-report.txt` | **新**：`compose-grail-extb.ts` 的完整輸出 |

### 驗收指令

```powershell
bun run tools/check-lib-compat.ts        # v1 的 40,995 個碼位全部與舊版一致；跨字庫無指錯；12 區塊都有字
bun run tools/free-compose-test.ts       # 全部通過
bun run tools/check-viewer.ts            # 全部通過（含 headless 瀏覽器實跑＋截圖）
bun run tools/check-codemirror.ts        # 全部通過
bun run tools/block-sheet.ts             # 每個 CJK 區塊挑 6 個字出圖
bun run tools/compose-grail-extb.ts      # 九字在庫、四步求值、出圖與比對
bun run tools/grail-readings.ts          # 遞歸 vs 成對，兩種讀法結果相同
bun run tools/band-compare.ts            # 同層讓位開／關並排（版面色決定）
bun run tools/name-cost.ts               # 名字層成本：20.7% → 1.7%
```
