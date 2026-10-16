# gocore — 字形庫與組字能力的 **Go 模組**

> 這一支是為了讓**其他 Wails3 軟件**也能有組字能力而存在的。
> 完整的來由與取捨見 [`../progress/技術交接文件.md`](../progress/技術交接文件.md) §10.2；
> 格式規格見 [`../format.md`](../format.md)。

---

## 1. 這一支是什麼、不是什麼

| | 內容 |
| --- | --- |
| **是** | 字庫解碼／索引／查詢、IDS 解析、組字結構、部件檢索……也就是**資料＋語意** |
| **不是** | **描繪**。Go 這一側不產生 SVG、也不量墨跡 |

**為什麼不量墨跡**：配框要量墨跡，而量墨跡**一定要跑引擎的多邊形**
（`tools/glyph-common-page.js`〈精確墨跡〉：KAGE 資料裡的 `width` 幾乎都是 0，
真正的筆寬是引擎描繪時用 `kMinWidth*` 加上去的，走筆劃座標會系統性低估 6～15 格）。
所以墨跡對齊那一步留在前端，Go 只回**組字信息**（哪個槽位被換、舊框是多少）。

```
Go（gocore）                    前端（既有的 kage）
─────────────────────────────   ─────────────────────────
字庫解碼／索引／查詢             墨跡量測（inkOfRefInParent）
IDS 解析／idsGlyph               配框（inkAlignedBox／refitBand）
組字結構（structureOf）          描繪（kage-engine）
槽位（findSlot／solveIdsSlots）
可換性（canReplaceCp）
檢索（部件檢字、IDS→拼形序）
───────────── 送「組字信息」──→
```

⚠ **不要**為了「Go 比較快」而把引擎搬過來：已量測，單執行緒只快 1.8×，
而且 JS 的完整外框生成本來就有 14,094 字/秒（見 §10.2 第一段）。搬的理由是
**consumer 是 Go 程式、import 不了 TS／JS**，不是速度。

⚠ **不要**讓 Go 與 JS 各有一份「同一件事」的實作而不加護欄 ✗。目前**只有解碼**是
兩份（Go 的 `lib` 與 JS 的 `tools/lib-format.ts`），而它由**全庫差分測試**鎖住（見 §3）。
要再加第二份之前，先想清楚誰來當那條鎖。

---

## 2. 目錄

| 路徑 | 是什麼 |
| --- | --- |
| `lib/` | **字庫**：解碼（v1～v6）＋查詢。目前完成的部分 |
| `refdump.ts` | 產生差分測試的 golden 檔（**JS 那一半**，用 `tools/lib-format.ts`） |
| `testdata/` | **產物、不入版控**：golden ＋ 字庫複本（`bun run gocore/refdump.ts` 產生） |
| `_gen/` | **產物、不入版控**：`lib-format.ts` 的暫存複本（只在沙箱下需要，見 §4） |
| `.cache/` | **產物、不入版控**：Go 的 build cache（見 §4） |

預計往上疊的套件（尚未動工）：`compose/`（槽位、可換性、配框決策）、
`struc/`（組字結構）、`search/`（部件檢字、IDS→拼形序）、`api/`（Wails3 綁定用的薄層）。

---

## 3. 驗收：對 JS 的全庫差分測試

```powershell
# 1. 產生 golden（用唯一的 JS 解碼實作）
bun run gocore/refdump.ts

# 2. 跑測試
cd gocore
$env:GOCACHE = "D:\2023\glyphwiki\gocore\.cache\go-build"   # 見 §4
go test ./...
```

`go test` 會比對**全庫**（不是抽樣）：

| 驗的項目 | 覆蓋 | 為什麼 |
| --- | --- | --- |
| `kageHashAll` | 191,727 個字形的 `ToKageData` hash | 等於把整條位元流逐筆驗一遍 |
| `tightAll` | 191,727 個緊框 | 驗 `ComputeTight` 的遞迴、框映射、`Math.round` 語意 |
| `families` | 98,701 筆 | 家族表 |
| `comp`／`syn`／`phil` | 97,079／2,073／6,460 | 三個尾端區段（**含 comp 的分量順序**） |
| `lookup` | 7,622 筆查詢 | 查詢層 |
| `spot` | 19 個點名字 | **與事實**一致，不只「兩邊一樣」 |

**為什麼一定要全庫**：格式錯位（少讀一個 varint、zigzag 用錯）**不會拋錯**，
只會讓後面全部歪掉。歷史上真的發生過 `.bin` 與 `.gz` 不同步而靜默錯位
（`format.md`〈極難查的 bug〉）。所以覆蓋率就是這個測試的全部價值。

三條獨立護欄：`TestDecodeAgainstJS`（與 JS 一致）、`TestSpotCheckVsGolden` ＋
`TestDocumentedFacts`（與事實一致）、`TestDecodeRejectsTruncated` ＋
`TestDecodeRejectsUnknownVersion`（錯了要大聲，不要靜默）。

---

## 4. 環境坑（DSH 沙箱下必看）

### 4.1 `GOCACHE` 必須重導進工作區

沙箱只允許子行程寫**工作區內**的路徑，而 Go 預設的 `GOCACHE`
（`C:\Users\<你>\AppData\Local\go-build`）在外面：

```
go : pattern ./...: open C:\Users\...\go-build\...: Access is denied.
```

```powershell
$env:GOCACHE = "D:\2023\glyphwiki\gocore\.cache\go-build"
$env:GOTMPDIR = "D:\2023\glyphwiki\gocore\.cache\tmp"
```

（`.cache/` 已進 `.gitignore`。**不要**對它做遞迴列舉——裡面有上萬個檔案。）

### 4.2 bun 的模組載入器用 `r+` 開檔，所以載入不到 `tools/`

沙箱對**子行程**封鎖 `tools/`、`out/`、`db/`、`kage-engine/`、`vendor-cm/`、
`unicode-cjk-ids/` 的**寫入**（`progress/`、`novel/`、`gocore/`、根目錄可寫）。
而 **bun 的模組載入器是用讀寫模式（`r+`）開啟檔案的**：

```
bun -e "await import('./tools/lib-format.ts')"     # → EPERM reading ...
bun -e "require('fs').readFileSync('tools/lib-format.ts','utf8')"   # → 正常
```

**讀取**完全正常，只有「載入成模組」會失敗。所以 `gocore/refdump.ts` 會
**先試直接載入**（正常環境不留痕跡），被擋才把 `lib-format.ts`（它沒有任何 import、
是自足的）複製到可寫的 `gocore/_gen/` 再載入，並印出來源的 sha256 以示是同一份。

同樣的原因：`out/` 不能寫 → golden 放 `gocore/testdata/`（不入版控）；
`tools/` 不能寫 → 沙箱下不要試著在 `tools/` 建暫存檔（建了也刪不掉）。

### 4.3 其他

* `.gitignore` 是 **UTF-8 無 BOM**（PowerShell 的 `Get-Content` 會顯示成亂碼，
  那是主控台編碼，不是檔案壞掉）。
* 本專案的 `.md`／原始碼用編輯工具寫，**不要**用 PowerShell 的 `Set-Content`／`>`。
