# glyphwiki 專案入門（orientation）

> 這份文件給**完全不了解這個專案的人或模型**看。
> 目標是讓你讀完之後知道：這裡在做什麼、東西放在哪、資料怎麼流、跑什麼指令、以及**哪些原則是刻意選擇的**（不要不小心改掉）。
>
> 走訪時間：本文件撰寫時實際掃過 `tools/`（91 個檔案）、`out/`、`db/`、`unicode-cjk-ids/`、`dump/`、`kage-engine/`、`vendor-cm/`、`gokage/` 與根目錄所有 `.md`。
> 凡是查不到或不確定的，文件裡寫「不確定」，不推測。

---

## 0. 一句話

從 **GlyphWiki 的 KAGE 筆劃資料**做出一個**可離線使用的漢字字形庫**，並在它上面做**部件檢索**與**自由組字**。

---

## 1. 這個專案是什麼

### 1.1 上游

**GlyphWiki**（https://glyphwiki.org）是一個公眾自由編輯的漢字字形資料庫。它的資料格式叫 **KAGE**：一個字形是一串「筆段」，每個筆段有型別、筆寬、樣式與座標；筆段也可以是**對另一個字形的引用**（`kind = 99`），並帶一個「引用框」決定子字形畫在哪裡。

KAGE 是為**視覺組合**設計的，不是為**結構描述**設計的。這一點是本專案一切麻煩的根源。

### 1.2 三個目標（出自 `format.md`）

1. **把結構資訊與描繪資訊合而為一**。GlyphWiki 只管字形怎麼畫，`unicode-cjk-ids` 只管字怎麼拆，兩邊不一致。合起來之後才能「用部件搜尋漢字」。
2. **做一個精簡、可離線的字形庫**。原始 dump 291 MB，目標是壓到可以 base64 塞進單一 HTML。
3. **支援自由組字**。用「拼形序列」表達式，以字形庫為基礎產生 Unicode 未定義的新字形。
   例：`寶缶支` ＝ 把「寶」裡的「缶」換成「支」，框不變。
   可遞歸：`峰夆電雨水` ＝ 「峰」的「夆」換成「電雨水」，「電雨水」＝「電」的「雨」換成「水」。
   最著名的驗收案例是 holy grail：`邏羅寶貝𩀨從䞃致招`。

### 1.3 現在有什麼

| 產物 | 說明 |
|---|---|
| `out/lib-cjk-all.bin(.gz)` | 全部 Unicode CJK 漢字區塊的字形庫（12 個區塊、98,701 個碼位字、191,727 個字形） |
| `out/glyph-browser.html` | **字集瀏覽頁**（BabelMap 風格）：列碼位、看字形、用部件反查、可堆疊的詳細卡 |
| `out/kage-viewer.html` | 字形檢視頁（只做檢視，**不含編輯器功能**） |
| `out/codemirror-kage.html` | 自由組字編輯器（CodeMirror 6，文中拼形序列就地換成 SVG） |
| `tools/free-compose.ts` | 拼形序列的語法層（Node 與瀏覽器共用同一份原文） |

---

## 2. 快速上手

```bash
# 環境：Bun（沒有 node_modules，沒有相依套件；唯一例外是 vendor-cm 的 CodeMirror 6）

# 只做檢字／查資料（最快的入口）
bun run tools/q.ts show u674f          # 看 杏 的資料、部件、ASCII 框圖
bun run tools/q.ts refs u6728          # 誰引用了「木」
bun run tools/q.ts stat

# 重建整條資料流（約數分鐘）
bun run tools/build-db.ts              # dump → sqlite（約 25 秒）
bun run tools/load-ids.ts              # IDS → sqlite
bun run tools/build-components.ts      # 部件序列 → sqlite
bun run tools/build-library.ts --out out/lib-cjk-all.bin
bun run tools/build-glyph-browser.ts
bun run tools/check-browser.ts

# 五支驗收（見 §7）
bun run tools/check-lib-compat.ts
bun run tools/free-compose-test.ts
bun run tools/check-viewer.ts
bun run tools/check-codemirror.ts
bun run tools/check-browser.ts
```

**注意**：`db/` 與 `out/` 都在 `.gitignore` 裡——它們是**可重建的產物**，不是原始碼。原始碼只有 `tools/`、`kage-engine/`、`unicode-cjk-ids/`、根目錄的 `.md` 與 `dump/`（dump 也被 ignore，不確定實務上是否有另一份備份）。

---

## 3. 資料流

```
上游（兩個獨立來源，彼此不一致）
├── dump/dump_newest_only.txt            291.8 MB  GlyphWiki 全量 dump（KAGE 筆劃）
│     name | related | data   （PSQL 風格表格，前兩行是標題與分隔線）
└── unicode-cjk-ids/All.txt              2.15 MB   IDS 結構（U+碼位 \t 字 \t IDS序列）
      ↑ chise/ids 的備份修補版；另有 10 個分區塊的 .txt
                │
                ▼
        db/glyphwiki.db                   1,190 MB   ← 唯一的整合點
        ├── build-db.ts        → glyphs / parts / meta / suffix_stats
        ├── load-ids.ts        → ids / ids_ops / ids_comp / ids_ref
        │                        ＋ ids_deep / ids_tree_align（檔頭沒寫，實際有）
        └── build-components.ts → glyph_components / comp_index
                │
                ▼
        tools/build-library.ts            varint 二進位，附自我檢查
                │
                ├─▶ out/lib-cjk-all.bin      4.38 MB   全部 CJK（v3）
                │   out/lib-cjk-all.bin.gz   2.21 MB   ← 消費者讀這個
                │   out/lib-cjk-all.gnames.tsv.gz  0.90 MB  名字對照表（前端**不**內嵌）
                │
                └─▶ out/lib-cjk.bin(.gz)     1.65 / 0.87 MB  BMP only（v1，舊格式）
                │
                ▼
        三個消費者
        ├── out/glyph-browser.html      字集瀏覽（內嵌 lib-cjk-all.bin.gz）
        ├── out/kage-viewer.html        字形檢視（內嵌 lib-cjk-all.bin.gz）
        └── out/codemirror-kage.html    編輯器（內嵌 **lib-cjk.bin.gz，仍是 BMP v1**）
```

**一句話記法**：GlyphWiki 是**不完美的上游** → 我們的 DB → 我們的字庫 → 三個消費者。

---

## 4. 分層架構

### 4.1 不完美的上游

GlyphWiki 有兩個結構性缺陷，本專案花了很多力氣繞過：

**(a) 它把部件畫成原始筆劃。**
作者為了微調（例如「木」當偏旁時豎要縮短），懶得做異體部件，就直接把那幾筆拆散畫上去。
結果：`杏` 的「木」不是引用，是 4 筆散畫；`林` 更是 8 筆、**一個引用都沒有**。
後果：**問「哪些字含木」時，杏和林不在答案裡**——因為帳上只記了葉子。
（有專門的統計工具：`report-inline-components.ts`。）

**(b) 命名有陷阱。**
- GlyphWiki 的 ID 是**來源資料的識別碼**，不是穩定的對外介面（`u96b9-01@1`、`cdp-8bb0`、`u2ff0-u9b2f-u5f8`）。
- **IDS 合成字形的命名會被誤判**：GlyphWiki 把「⿰＋兩個運算元」命名成 `u2ff0-uXXXX-uYYYY`，而它的 dump metadata 把這種名字標成 `name_type=suffix, codepoint=0x2FF0, base_name=u2ff0`——也就是 dump **自己**認為它是「U+2FF0 的異體」。全庫有 77,353 個這種名字。照單全收的後果是 U+2FF0 底下掛了 698 個成員、U+2FF1 掛了 2,270 個，於是「某個異體被誰引用」會撈出 IDC 這種根本不該出現在字集裡的東西。
  **修法**：只有落在字集區段內的碼位才配擁有家族（`build-library.ts` 的 `inRanges`）。字形本身還在（該被引用時引用得到），只是不再冒充某個碼位的異體。
- **預設是日本字形**：`u80cc`（背）其實只有一個指標，真正的筆劃在 `u80cc-j`。

### 4.2 我們的 DB

`db/glyphwiki.db` 是**整合點**：GlyphWiki 的筆劃 ＋ IDS 的結構，放在同一個 SQLite 裡。

主要表（`db/` 不入版控，由工具重建）：

| 表 | 列數 | 內容 |
|---|---:|---|
| `glyphs` | 2,126,474 | dump 的每個字形：`data`（KAGE 字串）、`name_type`、`codepoint`、`base_name`、`pure_pointer`、`dangling_refs` |
| `parts` | 4,316,170 | 展開後的每個筆段（欄位化的 KAGE，含 `raw` 原文以備稽核） |
| `ids` | 93,733 | 每個字的 IDS 序列、最外層算子、深度、是否原子 |
| `ids_comp` | 314,918 | IDS 序列中的每個分量（含算子），帶 `pos` / `depth` / `group_ix` |
| `ids_ref` | 52,075 | **對接表**：某字的第 i 個 KAGE 部件 ↔ IDS 的第 j 個分量 |
| `ids_deep` | 123,062 | 深層展開（IDS 樹 vs KAGE 樹） |
| `ids_tree_align` | 311,536 | 樹對樹遞歸對齊，帶 `slot`（如 `⿰:0`）與 `quality` |
| `glyph_components` | 295,661 | 部件序列（檢字用）：`level='direct'` / `'leaf'` |
| `comp_index` | 280,048 | 反查索引：部件 → 字 |

**最重要的教訓（`format.md`）**：KAGE 的子部件順序與 IDS 分量順序**不保證一致**
（例：U+3D64「⿰氵翜」的 KAGE 子部件是 `翜, 氵`，順序相反）。
所以對接的唯一方法是**按碼位做 LCS 序列對齊**，不能按位置配對。
`ids_ref.method` 記對接品質：`exact` / `prefix` / `lcs`。

### 4.3 我們的字庫

`out/lib-cjk-all.bin` 是 DB 的**投影**：只留畫字形真正需要的東西
（哪個碼位有哪些字形、每個字形的筆段與引用框），加上一族「碼位 → 家族成員」的表。

它**沒有名字字串**——名字放在旁邊的 `.gnames.tsv.gz`，只有命令列工具需要。

### 4.4 誰讀什麼

| 消費者 | 字庫 | 內嵌模組 | 產生器 | 驗收 |
|---|---|---|---|---|
| `out/glyph-browser.html`（字集瀏覽） | `lib-cjk-all.bin.gz`（v3） | `tools/lib-format.ts`、`lib-measure.ts`、`box-dictionary.ts`、`compose-fit.ts`、`free-compose.ts`、`stroke-overlap.ts` ＋ `tools/glyph-browser-page.js` | `build-glyph-browser.ts` | `check-browser.ts` |
| `out/kage-viewer.html`（字形檢視） | `lib-cjk-all.bin.gz`（v3） | `lib-format`、`lib-measure`、`box-dictionary`、`compose-fit` | `build-kage-viewer.ts` | `check-viewer.ts` |
| `out/codemirror-kage.html`（編輯器） | **`lib-cjk.bin.gz`（v1，只有 BMP）** | 上面六個模組 | `build-codemirror-kage.ts` | `check-codemirror.ts` |
| 命令列工具 | 透過 `tools/lib-load.ts` 讀 `.bin.gz` | 直接 import | — | `free-compose-test.ts` 等 |

**三個「唯一實作」的約定**（重要，不要打破）：

- `tools/lib-format.ts` 是**唯一**的解碼實作。它不得引入任何 Node/Bun 專屬模組（無 `fs`、無 sqlite），因為它同時被 Node CLI 與網頁內嵌使用。**絕對不要手抄第二份解碼邏輯**——曾經發生過，結果兩邊不同步、互相矛盾。
- `tools/free-compose.ts` 同樣的理由，是拼形序列語意的唯一實作。
- 網頁產生器用 `Bun.Transpiler` 把這些 `.ts` 的原文去型別、去 `export`、去 CLI 段，內嵌進 HTML。同一份原始碼，只是換個地方跑。

---

## 5. 這個專案建立起來的原則

> 這一節是**刻意選擇**，不是現狀描述。動工前先讀。

### 5.1 IDS 是建置期的鷹架，不是出貨資料

**使用者只接觸字形繪製資料。**

IDS 在建置期回答「這批筆劃屬於哪個部件」，用完就拆。它不該變成消費者要讀的資料層。

> 這條原則有過一次違反與一次修正：字庫 v3 一度把 IDS 部件表（`lib.comp`）寫進出貨檔案，等於讓內部開發資料變成對外介面。方向已經定為「把部件關係還原進繪製資料，然後把那段拿掉」。

### 5.2 字形繪製資料才是權威；部件關係應該長在繪製資料上

如果一個部件在繪製資料裡是「4 筆散畫」而不是「一個引用」，那就**修繪製資料**，不要在下游另外補一張對照表。

具體做法（`tools/deinline-batch.ts`）：把被拆散的那組筆劃**原封不動**做成一個新的異體字形，用**恆等框** `[0,0,200,200]` 引用它。因為筆劃座標與渲染路徑都沒變，渲染**逐像素相同**。

**不要**走「去家族裡找一個形狀接近的現成異體」那條路：KAGE 的引用框是非等比映射，硬套會壓到筆寬（實測最佳只有 IoU 70.3%）。

### 5.3 正在與 GlyphWiki 脫鉤

GlyphWiki 是**工作基礎，不是金科玉律**。

- 新造的東西用自己的命名（例：`inl-<來源碼位>-<序號>`），不必沿用 GlyphWiki 的命名慣例。
- **不回報上游**，所以名稱衝突不是問題，但**要記錄來源**（新異體是從哪個字來的）。
- 字集範圍、家族定義、IDC 排除……這些都是我們自己定的規矩，不必迁就上游的 metadata。

### 5.4 驗證要能失敗

- **硬門檻**：`deinline` 的還原要求 **IoU 100%**，不是 99%、不是「看起來一樣」。任何一格不過就退回，不修那個字。
  （為什麼要這麼嚴：分組分錯時**渲染看不出來**——筆劃只是搬了位置。所以「看起來沒事」不能當證據。）
- **兩支獨立工具互相對帳**：`deinline-batch.ts` 自己驗一次，`verify-deinline.ts` 再獨立驗一次。
  單靠一支永遠抓不到自己的盲點——歷史上就是靠這個抓出「只修了代表字形、卻用碼位記錄來源」的 bug（㪅 U+3A85）。
- **建置期自我檢查**：`build-library.ts` 寫完立刻重讀兩檔並逐位元組比對，不一致就建置失敗。
- **驗收要真的跑起來**：`check-*.ts` 不是檢查「檔案有沒有產生」，而是用 Edge headless 真的開頁面、模擬操作、斷言結果。

### 5.5 資料現實勝過漂亮的理論

- `4木曰` 查不到資料，**不是 bug**：U+2320C 引用的其實是「日」（U+65E5），不是「曰」（U+66F0）。`4木日` 才對。
- KAGE 算出來的「筆劃數」是**筆段數**，不是康熙筆劃（口=4、日=5、木=4；傳統是 3/4/4）。但扣減算術自洽，所以搜尋語法照用，只是要記得它的定義。
- 版面模板化、規範槽位、光柵化比對——三個「聽起來很合理」的方案都被**量測否決**（見 `progress/技術交接文件.md` §11）。
- 判準要量出來才敢用。例：方位門檻本來用 1/3–2/3，實測 173,298 筆引用後發現左右不對稱（左 43,399 / 右 29,697），改成 0.40–0.60（左 43,888 / 右 47,806）才對稱。

### 5.6 其他慣例

- **量測工具要留著**。`tools/` 裡大量 `probe-*.ts` / `*-compare.ts` / `layout-*.ts` 是一次性實驗，但**刻意保留**當證據。要調參數之前先讀它們，不要再走一次同樣的路。
- **踩過的坑寫進檔頭**。幾乎每個檔案的開頭註解都在講「為什麼這樣做」與「以前怎麼錯的」。那是這個專案最有價值的資產之一。
- **不要在同一個作用域裡放兩份同名宣告**。三個網頁產生器都把多個模組的 `export` 拿掉後合併進同一個 `<script>`，跨檔同名宣告會讓**整頁空白且沒有任何錯誤訊息**。所以產生器會先對合併後的程式碼做整段語法檢查。

---

## 6. 字庫格式（`out/lib-cjk-*.bin`）

**`tools/lib-format.ts` 是唯一實作。**

檔案開頭是魔數 `"GL"` ＋ 版本 byte。**沒有魔數的檔案一律當 v1 讀**，所以舊檔與內嵌它的網頁不受影響。

| 版本 | 有誰在用 | 內容 |
|---|---|---|
| **v1** | `out/lib-cjk.bin.gz` → `codemirror-kage.html` | 名字字串內嵌（碼位＋後綴索引＋後綴表）＋框字典＋筆畫 |
| **v2** | （目前沒有檔案在用，路徑保留） | 家族表（碼位 → 成員）取代名字層；字形重排讓同家族成員連續 |
| **v3** | `out/lib-cjk-all.bin.gz` → 瀏覽頁／檢視頁 | v2 ＋ **檔案尾端**的 IDS 部件區段（`lib.comp`） |

版本差異只用一個版本 byte 區分，讀取端在 `decodeLibrary()` 分派。

### 實測大小

| | `.bin` | `.gz` | base64 | 字形 | 家族 | comp 區段 |
|---|---:|---:|---:|---:|---:|---:|
| `lib-cjk-all`（v3，全部 CJK） | 4.38 MB | **2.21 MB** | 2.95 MB | 191,727 | 98,701 | 92,933 碼位 |
| `lib-cjk`（v1，BMP） | 1.65 MB | 0.87 MB | 1.16 MB | 70,416 | —（v1 無家族表） | — |

（v1 的「無家族」是格式差異：v1 沒有家族表，家族是查詢時從名字推出來的。）

### 編碼規則（**每個坑都會讓整個位元流錯位**）

- **有號用 zigzag**：座標、`width`、`style`、伸縮值、碼位差值。座標與 width 都可以是負的。
- **非負用原始 varint**：計數／長度／索引／`kind`／旗標。**不可用 zigzag**（70416 會變成 140832）。
- **`kind` 不可 zigzag**（99 會變 199，永遠比不中）。
- `kind` 有三位數變體（103/203/303），判定點數要用 `kind % 100`。
- `noStretch = 1` 時才省略後面 4 個伸縮值。
- 座標一律 8 個欄位，避免「尾欄省略」的歧義。

### 對外 API

**模組使用者一律用 Unicode 交流。**

```ts
const i = indexOfCodePoint(lib, 0x908f);   // 邏
const j = indexOfCodePoint(lib, 0x29028);  // 𩀨（Ext B）
```

內部名（`g1k2` 這種）是**實作細節**，不對外承諾、不要拿去比對或解析。
要顯示給人看用 `displayName()`；要接回 GlyphWiki dump 用 `loadWikiNames()`。

---

## 7. 怎麼跑

### 7.1 五支驗收

| 指令 | 驗什麼 |
|---|---|
| `bun run tools/check-lib-compat.ts` | **格式回歸**：把舊版 `findGlyphIndex` 的演算法抄一份當基準，與新的 `indexOfCodePoint` 逐碼位比對全部碼位，確認舊字庫選出來的字形一個都不差。另含「家族必須落在 12 區塊內」「IDC 不得被當成字」兩條資料斷言。 |
| `bun run tools/free-compose-test.ts` | `free-compose.ts` 的**語意與護欄**：拼形序列的遞歸讀法、`︵…︶` 三條護欄、部件清單、內嵌 SVG。Node 端，不需瀏覽器。 |
| `bun run tools/check-viewer.ts` | `out/kage-viewer.html`：內嵌模組能否在同一作用域編譯、解得開字庫、組得出 holy grail、用 Edge headless 真的開頁面。 |
| `bun run tools/check-codemirror.ts` | `out/codemirror-kage.html`：CM6 bundle 掛得上、語法掃描護欄正確、headless 斷言「光標外的序列換成 SVG／光標所在的還原成純文字／浮窗出現」。 |
| `bun run tools/check-browser.ts` | `out/glyph-browser.html`：**最大的一支（48 KB，18 個步驟）**。逐條走過三個需求 ＋ 搜尋語法（`木+` `+木` `口木` `口口` `4木日` `4` `U+XXXX`）＋ 區塊複選與排序 ＋ 詳細卡堆疊 ＋ 筆劃粗細 ＋ 配色。同樣用 Edge headless 真的跑。 |

共同點：**都必須先建好對應的產物**。`check-*` 不建置，只驗收。

### 7.2 建置指令

```bash
bun run tools/build-library.ts [--out out/lib-cjk-all.bin]
bun run tools/build-library.ts --ranges 4E00-9FFF 2FF0-2FFB   # 自訂區段
bun run tools/build-library.ts --range 0x3400 0xFAFF          # 舊版單一區段（相容）
```

預設收 **12 個 CJK 漢字區塊**（URO ＋ Ext A..I ＋ 相容區／相容補充），共 98,701 個碼位。
`--out` 的**預設值是 `out/lib-cjk.bin`（BMP）**，要建全部 CJK 必須明寫 `--out out/lib-cjk-all.bin`——這點容易忘。

寫出時附帶三個檢查：檔頭自我檢查、`.bin` 與 `.gz` 逐位元組比對、重新解碼全庫驗證引用有效。

---

## 8. 檔案地圖

### 8.1 核心模組（**唯一實作，改動要非常小心**）

| 檔案 | 一句話 |
|---|---|
| `tools/lib-format.ts` | ★ 字庫格式定義與**唯一**解碼實作；Unicode-only 對外 API；`componentKids()` 走部件圖 |
| `tools/lib-measure.ts` | 墨跡範圍、槽位推導、等比放入（需要 kage-engine 才能量到正確墨跡） |
| `tools/lib-load.ts` | Node 端載入字庫的單一入口（可選載入名字對照表）。**只能在 Node 用** |
| `tools/box-dictionary.ts` | 框字典：把差異極小的引用框聚類共用（實測淨省 15.1%） |
| `tools/compose-fit.ts` | ★ 組字：替換部件時避免溢出造成筆劃重疊；「先沿用舊框，放不下才等比縮小置中」 |
| `tools/free-compose.ts` | ★ 拼形序列的語法層與內嵌渲染（Node 與瀏覽器共用）。**不得**引入 Node 專屬模組 |
| `tools/stroke-overlap.ts` | 跨部件筆劃最短距離（0 ＝ 相交）；組字品質把關 |
| `tools/glyph-browser-page.js` | 字集瀏覽頁的頁面程式碼（`build-glyph-browser.ts` 內嵌）。**不要搬回樣板字串**（見 §9） |

### 8.2 建置管線

| 檔案 | 一句話 |
|---|---|
| `tools/build-db.ts` | dump（291.8 MB）→ sqlite；一次掃描、分批 transaction |
| `tools/load-ids.ts` | `unicode-cjk-ids/All.txt` → sqlite；與 KAGE 部件做 LCS 對接 |
| `tools/build-components.ts` | 抽「部件序列」（`glyph_components` / `comp_index`）；遇 KAGE 歸併節點改用 IDS 展開 |
| `tools/build-library.ts` | 建立精簡字形庫（varint）＋ 三個自我檢查 |
| `tools/compact-db.ts` | 產生精簡版 sqlite（只留分析／建庫真正需要的欄位） |
| `tools/export-web.ts` | 早期版本：把直接部件資料內嵌成單一 HTML → `out/glyphwiki.html` |

### 8.3 網頁產生器

| 檔案 | 一句話 |
|---|---|
| `tools/build-glyph-browser.ts` | → `out/glyph-browser.html`（字集瀏覽）。內嵌六個模組 ＋ `glyph-browser-page.js` |
| `tools/build-kage-viewer.ts` | → `out/kage-viewer.html`（字形檢視）。**只做檢視，不要加編輯器功能** |
| `tools/build-codemirror-kage.ts` | → `out/codemirror-kage.html`（編輯器）。內嵌 CodeMirror 6。**仍用 BMP v1 字庫** |

### 8.4 驗收與出圖

| 檔案 | 一句話 |
|---|---|
| `tools/check-lib-compat.ts`、`free-compose-test.ts`、`check-viewer.ts`、`check-codemirror.ts`、`check-browser.ts` | 見 §7.1 |
| `tools/shot-browser.ts` | 對瀏覽頁的四個狀態截圖（預設／搜尋／卡片堆疊／設置下拉） |
| `tools/block-sheet.ts` | 從每個 CJK 區塊挑幾個字畫出來，證明「真的收到了」（給眼睛看的版本） |
| `tools/shot-compose.ts` | 產生預填組字範例的測試頁，供截圖 |

### 8.5 查詢與組字 CLI

| 檔案 | 一句話 |
|---|---|
| `tools/q.ts` | sqlite 查詢工具（`stat` / `show` / `tree` / `refs` / `uses` / `find` / `sql`）。**取代每次重掃 292 MB dump** |
| `tools/read-library.ts` | 字庫 CLI：`--stats` 與「與資料庫原值逐筆比對」（往返驗證） |
| `tools/raster.ts` | 字形光柵化成點陣（ASCII 目視與 `--diff`）。**效能上是瓶頸，非必要不用**（改用 `skelcmp.ts`） |
| `tools/search-slot.ts` | 「哪個字裡有這個部件、而且在那個位置」（部件 ＋ 位置搜尋） |
| `tools/compose.ts` | 組字（舊版：沿用框）；策略已被 `compose-fit.ts` 取代 |
| `tools/skelcmp.ts` | 以「骨架節點位移」比較相似度（不做光柵化，每秒十餘萬字） |

### 8.6 「還原被拆散的部件」這一線（本專案當前主線）

| 檔案 | 一句話 |
|---|---|
| `tools/report-inline-components.ts` | 統計「哪些部件被畫成原始筆劃」；用 **KAGE 可達**（不限直接）判斷，才不會把「歸併」誤算成「拆散」 |
| `tools/find-inline-variant.ts` | 去家族裡找形狀接近的現成異體（去尺度比對）。**結論：最佳只有 IoU 70.3%，此路不通** |
| `tools/try-inline-repair.ts` | 承上，換一個現成異體並解出引用框，看渲染對不對 |
| `tools/try-deinline.ts` | 原型：把筆劃做成新異體 ＋ 恆等框 → 渲染逐像素相同 |
| `tools/deinline-batch.ts` | 正式版：批次還原。分組用 `+`（⿰）／`/`（⿱）／`@`（其餘）；**筆劃數對帳**與 **IoU 100%** 兩道閘門。產出 `out/deinline-variants.tsv`（**1,356 字、1,771 個新異體**，全部 IoU 100%） |
| `tools/verify-deinline.ts` | 獨立再驗一次（逐字重建、逐像素比對） |

### 8.7 量測與分析（一次性實驗，**刻意保留當證據**）

| 檔案 | 一句話 |
|---|---|
| `box-dict.ts`、`dict-tune.ts`、`dict-visual.ts`、`quantize-cost.ts`、`quant-sweep.ts`、`quant-visual.ts`、`tier-quantize.ts` | 框字典與座標量化的成本／視覺代價 |
| `layout-archetype.ts`、`layout-band.ts`、`layout-band-savings.ts`、`layout-cluster.ts`、`layout-savings.ts`、`stock-layout.ts`、`stock-split.ts`、`stock-frame-full.ts`、`grid-proportion.ts` | 版面模板化的一系列量測（**結論：否決**） |
| `name-cost.ts`、`lib-breakdown.ts`、`gzip-breakdown.ts`、`base-diff.ts`、`flag-analyze.ts`、`boxexp.ts` | 位元組成本拆解 |
| `match-variant.ts`、`match-variant2.ts`、`pick-variant.ts`、`case-sheets.ts` | 變體選擇（`case-sheets` 的結論：自動評分不可靠，交給眼睛） |
| `family-dup.ts` | 家族裡有多少異體是重複的（資料相同 6,455 個可直接合併；資料不同但畫出來一樣的一批） |
| `browser-perf.ts` | 字集瀏覽介面的成本量測（介面每個設計決定的依據） |
| `tight-verify.ts` | 緊框可衍生性驗證 |
| `compose-grail.ts`、`compose-grail-extb.ts`、`grail-box-sweep.ts`、`grail-fit-compare.ts`、`grail-fit-optimize.ts`、`grail-readings.ts`、`identify-reference.ts`、`probe-grail-tree.ts`、`probe-chaicoi.ts` | holy grail 的一系列實驗（含「參考圖到底是哪個既有字」的定案） |
| `band-compare.ts`、`verify-box-map.ts`、`verify-compose.ts`、`verify-zhu.ts`、`v2-explore.ts`、`ar-probe.ts`、`inspect-tree.ts`、`inspect-variants.ts` | 組字引擎行為的驗證與實驗 |

> `_q2.ts` 已於 2026-10-13 刪除：它是一次性的改名腳本（把 `search-slot.ts` 的
> `SlotPos` 改成 `SlotZone`），改名早就套用進原始碼，檔頭又沒有註解。

### 8.8 診斷探針 `probe-*.ts`（**問題已經解決，留著當證據**）

| 檔案 | 當初要回答的問題 |
|---|---|
| `probe-strokes.ts` | 筆劃數到底怎麼算才對（KAGE 筆段數 vs 康熙筆劃） |
| `probe-search-syntax.ts` | `+ / 數字 多部件` 這套語法實作前的偵察；`4木曰` 真的找得到 U+2320C 嗎 |
| `probe-search-sizes.ts` | 單部件用 L1、多部件用深層？還是全部用深層 |
| `probe-zone-threshold.ts` | `inkZoneOf` 的 1/3、2/3 門檻是不是太緊（`+木` 只找到 44 個字） |
| `probe-ids-gap.ts` | 把 IDS 部件關係接進索引能多找到多少、要多花多少 bytes |
| `probe-extb.ts` | 把 Ext B 包進字庫的前置量測 |
| `probe-chaicoi.ts`、`probe-grail-tree.ts` | holy grail 的前置量測 |

### 8.9 `out/` 產物

| 產物 | 是什麼 |
|---|---|
| `out/lib-cjk-all.bin(.gz)` | ★ 全部 CJK 字庫（v3）。**消費者讀這個** |
| `out/lib-cjk-all.gnames.tsv.gz` | 內部索引 → GlyphWiki 名字的對照表。**前端不內嵌**，只有命令列工具要 |
| `out/lib-cjk.bin(.gz)` | BMP 字庫（v1，舊格式）。`codemirror-kage.html` 還在用 |
| `out/glyph-browser.html` (3.15 MB)、`kage-viewer.html` (2.53 MB)、`codemirror-kage.html` (1.64 MB) | 三個離線單頁 |
| `out/glyphwiki.html` (1.94 MB) | 早期版本的離線單頁（`export-web.ts`） |
| `out/deinline-variants.tsv` (316 KB) | 被拆散部件的還原清單（第一批） |
| `out/*.png` / `*.svg` | 量測與驗收的圖。命名可辨來源工具（`grail-*`、`layout-*`、`glyph-browser-shot-*`…） |
| `out/inline-components.md` / `.tsv` | 「哪些部件被拆成筆劃」的報告 |
| `out/ref/flat.pgm`、`flat.png`、`vs-ours-big.png` | 師父給的參考圖與比對圖 |
| `out/cand/*.png` | holy grail 的候選既有字形（從 GlyphWiki 收集） |
| `out/browser-mockup.*`、`demo-cases.*`、`sheet-a/b.*`、`v1-baseline-report.*`、`lib-nodict.bin*`、`shot-editor.png`、`slot-search.*`、`cm-shot-*.png` | 早期階段的產物。**產生它們的工具多數已不在 repo 裡**（`v1-baseline-report` 例外，見 `free-compose.ts`） |

### 8.10 其他目錄

| 目錄 | 是什麼 |
|---|---|
| `db/` | `glyphwiki.db`（1,190 MB，整合點）、`glyphwiki-lean.db`（584 MB，精簡副本）。**不入版控** |
| `dump/` | GlyphWiki 原始 dump（`dump_newest_only.txt` 291.8 MB）＋ README/LICENSE。**不要直接讀**（用 `q.ts` 查 DB） |
| `unicode-cjk-ids/` | IDS 結構來源（`All.txt` ＋ 10 個分區塊 txt）。是 [chise/ids] 的備份修補版，本身就是一個 git repo |
| `kage-engine/` | 渲染引擎（原 JS 實作，8 個 `.js`）。**外部相依，不要改**；是 git repo |
| `vendor-cm/` | CodeMirror 6 的下載與打包（`src/entry.ts` → `dist/cm6.global.js`）。**不入版控** |
| `gokage/` | KAGE 的 Go 移植實驗（骨架模式）。**全量移植暫緩**（效能理由仍成立；打包需求改走「Go 做資料＋語意、繪圖留前端 kage」，見 `progress/技術交接文件.md` §10.2） |
| `gocore/` | **Go 模組**：字庫解碼／查詢（`lib/`），往後是組字語意。給**其他 Wails3 軟件**用的可重用能力。驗收＝對 JS 的**全庫差分測試**（見 `gocore/README.md`） |
| `pinxing-app/` | **拼形檢視器的 Wails3 版**：單一 exe、零外部相依、字庫 `go:embed` ＋ 開檔一次交付給前端。`gocore` 的測試床（見 `pinxing-app/README.md`） |
| `nul` | 不是檔案——那是 Windows 的 NUL 裝置，被 `Get-ChildItem` 列出來而已 |

---

## 9. 已知陷阱（踩過的，別再犯）

這些在各自的檔頭都有詳細記載，這裡只列最容易被絆到的：

1. **跨檔同名宣告 → 整頁空白且沒有任何錯誤訊息。** 三個網頁產生器都把多個模組的 `export` 拿掉後合併成一個 `<script>`。所以產生器會先做整段語法檢查。
2. **`.bin` 與 `.gz` 不同步**。症狀極具誤導性：「Node 端解碼完全正確、瀏覽器卻錯位」，會讓人反覆懷疑瀏覽器快取、編碼、非同步——全部不是。`build-library.ts` 現在會逐位元組比對。
3. **頁面程式碼不要寫回樣板字串**。`tools/glyph-browser-page.js` 是獨立檔案。寫在 TS 樣板字串裡會踩兩個方向的跳脫問題：寫的時候 `\"` 被吃掉、反引號提前結束字串；**從樣板字串抽出來**的時候，為了樣板字串寫的 `\\+`、`\\s` 會原封不動留著，語意整個跑掉（實際症狀：`parseCpInput("U+908F")` 的 regex 變成 `/u\\+/` 對不上，掉到 fallback 回傳 `'U'` 的碼位 85，整個「跳到碼位」失效）。
4. **`String.replace` 換字串版只換第一個。** 用 `replaceAll`。（踩過：檔頭註解也寫了同一個佔位記號，結果 2.94 MB 的 base64 整包塞進註解。）
5. **`renderCards()` 會換掉 `innerHTML`。** 舊的 `NodeList` 會變成脫離文件的節點，對它 `click()` 不會冒泡。要連續操作必須每次重新查。
6. **PowerShell 會弄壞 UTF-8。** `-replace` / `Set-Content` 處理非 ASCII 檔案不可靠；非 ASCII 的編輯優先用編輯工具或 Python（明寫 `encoding="utf-8"`）。Python 的 stdout 是 GBK，結果要寫進檔案再讀回來。
7. **headless Edge 的探針**：多層巢狀 `setTimeout` 會被截斷，要用單層 `setInterval`；`dispatchEvent` 會吞掉 listener 的例外，所以探針要自己掛 `window.addEventListener("error")`。
8. **KAGE 的引用框不是「等比縮放置中」。** 實際是「把子字形整個 200×200 畫布仿射映射到框，x 與 y 各自縮放（可非等比）」。這一條決定了組字時「放不放得下」的判斷，必須用引擎實測（`verify-box-map.ts`）。
9. **KAGE 會看相鄰筆劃調整筆端與折角。** 所以搬動筆劃時**不能重新排序**，引用也要插回原本的位置。否則渲染會變（實測有字從 IoU 100% 掉到 12%）。

---

## 10. 既有文件與現況的落差

走訪時發現的，供後續維護參考（**這份 `project.md` 以實際檔案為準**）：

1. **`progress/技術交接文件.md` §13 檔案清單已過時**。它列的 `out/*` 大小（`lib-cjk.bin` 1.86 MB、`kage-viewer.html` 1.32 MB…）是早期數字；現在 `kage-viewer.html` 2.53 MB、`glyph-browser.html` 3.15 MB、`codemirror-kage.html` 1.64 MB，而清單裡完全沒有 `glyph-browser.html`。`tools/` 只列了約 20 支，實際有 91 支。
2. **`progress/技術交接文件.md` §6 建立流程用 `--out out/lib-cjk.bin`（BMP）**。要建全部 CJK 必須明寫 `--out out/lib-cjk-all.bin`——但 `build-library.ts` 的**檔案內用法說明**寫的是 `--out out/lib-cjk-all.bin`，而**程式碼預設值**是 `out/lib-cjk.bin`。三者不一致，容易建錯。
3. **`load-ids.ts` 檔頭說「產出四張表」**（`ids_ops` / `ids` / `ids_comp` / `ids_ref`），實際 DB 裡還有 `ids_deep`、`ids_tree_align`（以及 `suffix_stats`、`meta`）。`format.md` 有提到 `ids_tree_align`，所以是檔頭漏寫，不是功能缺失。
4. **`check-lib-compat.ts` 的檔頭**說它的職責是「新舊 `findGlyphIndex` 的逐碼位對照」，但它現在同時是**唯一的字庫層級資料斷言**（家族必須落在區段內、IDC 不得被當成字、12 區塊都要有字）。只看檔頭會低估它的重要性。
5. **`out/` 裡有一批無主的產物**：`browser-mockup.*`、`demo-cases.*`、`sheet-a/b.*`、`lib-nodict.bin*`、`shot-editor.png`、`cm-shot-*.png`。在 `tools/` 裡找不到產生它們的程式（可能是早期版本的工具已刪除）。不確定是否還需要保留。
6. **`ascii` 名稱的歷史遺留**：字庫檔叫 `lib-cjk-all`，但頁面檔案叫 `glyph-browser.html`、產生器叫 `build-glyph-browser.ts`、頁面程式碼叫 `glyph-browser-page.js`，而**畫面上的標題是「Unicode漢字集」**。三套名字指同一個東西。
7. **根目錄 `nul`**：這是 Windows 的 NUL 裝置被列出來，不是真的檔案。若真有工具想寫入 `nul`，那是無效的。
8. **`tools/_q2.ts` 已刪除**（2026-10-13）：它是一次性改名腳本（`search-slot.ts` 的 `SlotPos` → `SlotZone`），改名已套用，檔案本身沒有用途。

---

## 11. 名詞對照

| 詞 | 意思 |
|---|---|
| **KAGE** | GlyphWiki 的字形描述格式：一串筆段，筆段可為直線／二次／三次曲線，也可以是對另一個字形的引用（`kind=99`） |
| **筆段 / stroke** | KAGE 的一個 `$` 分隔單位。注意：**不是**傳統筆劃（口 = 4 段，傳統 3 劃） |
| **引用框 / box** | `kind=99` 筆段帶的 4 個數字。實際語意是「把子字形的 200×200 畫布仿射映射到這個矩形」，x/y 各自縮放 |
| **緊框 / tight box** | 一個字形內容的實際外接矩形（去掉留白） |
| **部件 / component** | 構成形狀的子字形 |
| **拼形序列** | 自由組字的表達式：`基字 舊部件 新內容…`，可遞歸 |
| **基字** | 拼形序列的第一個字，被替換的容器 |
| **IDS** | Ideographic Description Sequence，Unicode 的漢字結構描述（`⿰木口`）。本專案只用它做**建置期的鷹架** |
| **IDC** | Ideographic Description Character，IDS 的算子（U+2FF0–U+2FFB：⿰⿱⿸…）。**不是漢字**，不該出現在字集裡 |
| **holy grail** | 專案的極限驗收案例：`邏羅寶貝𩀨從䞃致招`（招財進寶的合體字）。`𩀨`（U+29028）在 Ext B，是這條序列的關鍵 |
| **異體 / variant** | 同一個碼位的不同寫法。GlyphWiki 用後綴區分（`u6728-03`） |
| **純指標 / pure pointer** | 一個字形整個內容只有一個引用（`u80cc` → `u80cc-j`）。它與被指向的字形渲染完全相同 |
| **歸併 / merged** | KAGE 為了視覺方便，把複合部件寫成單一名字，導致那個節點沒有乾淨的子部件 |
| **拆散 / inlined** | 作者把部件直接畫成原始筆劃，完全不引用。**本專案要修的就是這個** |
| **suffix 後綴** | GlyphWiki 名字中 `u6728` 之後的部分（`-03`、`-j`、`@4`） |

---

## 12. 如果你只能帶走三件事

1. **GlyphWiki 是資料來源，不是規格。** 它的 metadata 會騙人（IDS 合成字被標成 U+2FF0 的異體）、它的命名是實作細節、它的字形預設是日本風格。我們的 DB 與字庫才是權威。
2. **IDS 是鷹架，不是產品。** 部件關係應該長在字形繪製資料上；IDS 只在建置期回答「這批筆劃屬於哪個部件」。
3. **量測取代猜測，而且驗證要能失敗。** 這個專案裡幾乎每個設計決定背後都有一支 `probe-*.ts` 或 `*-compare.ts`；三個「聽起來很合理」的優化方案（規範槽位、版面模板化、光柵化比對）就是被量測否決的。要改參數之前，先讀那支工具。
