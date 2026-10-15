# glyphwiki

漢字字形庫與部件檢索的工作文件。字料來自 GlyphWiki 的 KAGE 筆劃資料（**不完美的上游**），
在本機重建成自己的字庫，再在上面做部件檢索與自由組字。

這個 repo **只收文件**——程式碼、資料庫、字庫產物都可以重建，不入版控。

---

## 從哪裡開始讀

| 文件 | 內容 |
| --- | --- |
| [`project.md`](project.md) | **先讀這篇。** 專案是什麼、資料流、分層架構、建立原則、檔案地圖、怎麼跑驗收 |
| [`progress/技術總結-給人.md`](progress/技術總結-給人.md) | **給人看的結論**：系統能做什麼、三個原則、怎麼用、刻意不做什麼、已知限制 |
| [`progress/技術總結-給AI.md`](progress/技術總結-給AI.md) | **新對話／新接手時先讀這篇。** 現況、格式 v6、規則鏈、指標、踩過的坑、下一步 |
| [`progress/組字結構現況.md`](progress/組字結構現況.md) | 一頁版現況（四塊資料、數字、取捨） |
| [`組字結構.md`](組字結構.md) | 組字結構的**技術決策史**（§1～§6.21，含每一次的教訓） |
| [`progress/pinxing-技術總結.md`](progress/pinxing-技術總結.md) | **開新對話／新接手時讀這篇。** 拼形檢視器的架構、引擎語意、配框與槽位推斷、驗收、本次改動清單 |
| [`pinxing.md`](pinxing.md) | 拼形檢視器的**規格與現況**（含還沒通的部分）、介面決定的來由 |
| [`部件形式.md`](部件形式.md) | **功能構思**：位置形（左邊的手＝`扌`、右邊的刀＝`刂`）——為什麼「算框」只是治標 |
| [`format.md`](format.md) | 字庫二進位格式 v1／v2／v3、`componentKids()` 契約、家族只收區段內碼位（IDC 修正） |
| [`glyph-browser.md`](glyph-browser.md) | 字集瀏覽頁（畫面標題「Unicode漢字集」）的 UI、互動總表、維護者會踩的坑 |
| [`progress/20261015交接.md`](progress/20261015交接.md) | **最新交接（2026-10-15）。** IDC 分框的 bug 與魔術棒復原、**「tools 沒 commit 就會失去」的教訓**、現況基準與還沒做的事 |
| [`progress/20261014計劃.md`](progress/20261014計劃.md) | **要做什麼（施工單）。** v6 基準的改善方向、建議順序、驗收標準、共同規則 |
| [`progress/todo.md`](progress/todo.md) | 舊清單。基準是 **v3**，部分已改向——方向以 `progress/20261014計劃.md` 為準 |
| [`字集瀏覽介面設計.md`](字集瀏覽介面設計.md) | 設計**歷史**——描述的是當時的設計，**不是現況**，數字可能過期 |
| [`progress/技術交接文件.md`](progress/技術交接文件.md) | 早期交接文件。**檔案清單已嚴重過時**（`tools/` 只列約 20 支，實際 90 餘支） |
| `自由組字編輯器*.md`、`配合編輯器修組字引擎.md`、`progress/Ext B 字庫與 holy grail（回報）.md` | 各階段的回報與研究 |

同一個專案的另一種寫法（沿著〈煉丹篇〉的寓言線）：

這五篇放在 [`novel/`](novel/)：

- [`novel/托付篇.md`](novel/托付篇.md)　——交棒
- [`novel/煉丹篇.md`](novel/煉丹篇.md)　——把資料清乾淨、煉出字庫與自動組字
- [`novel/試丹篇.md`](novel/試丹篇.md)　——驗證：閘門要能失敗、兩把秤互相對帳
- [`novel/品丹篇.md`](novel/品丹篇.md)　——請客人來吃：從使用者的視角看拼形檢視器
- [`novel/鑑丹篇.md`](novel/鑑丹篇.md)　——照見、借鑑、監工品管；算力攻堅與人的謀定
- [`novel/問診篇.md`](novel/問診篇.md)　——問診如問路；畫像是給客人看的，不參與計算；先問爐子，再談分數
- [`novel/裁衣篇.md`](novel/裁衣篇.md)　——新法與舊法的比較：舊法是階梯，新法是丹；一件事只能有一份做法

---

## 怎麼跑驗收

```powershell
Set-Location D:\2023\glyphwiki
bun run verify          # 重建字庫＋兩頁 → 出貨三套 → 檢查 → 指標表（約 3 分鐘）
bun run verify --fast   # 跳過重建，只跑檢查
bun run verify --list   # 列出步驟（含被跳過的）
```

失敗即停，並印出**那一步的輸出尾巴**與指令。用法與參數見
[`progress/20261014計劃.md`](progress/20261014計劃.md) §4-C1。

---

## 版控範圍

**只追蹤兩個位置的 `*.md`：根目錄，以及 `novel/`。**

（`novel/` 放非技術的寓言文本。以後若再開文件夾，這裡與下面的指令要一起改。）

不追蹤的東西（刻意留在 `git status` 的未追蹤清單裡）：

| 類別 | 項目 |
| --- | --- |
| 程式碼與設定 | `tools/`、`kage-engine/`、`vendor-cm/`、`gokage/`、`package.json` |
| 資料與產物 | `db/`、`out/`、`dump/`、`dump.tar.gz` |
| 巢狀 repo | `unicode-cjk-ids/`（自己有 `.git`，整包只算一個未追蹤目錄） |
| 上游／權威資料 | `unihan/`（Unicode 官方 Unihan 18.0.0：`UnicodeData.txt`、`Unihan_Variants.txt`…，可重新下載）、`swjz.xml`、`ids/` |
| 雜項 | `nul`（Windows 的 NUL 裝置，不是真的檔案） |

`.gitignore` 只寫「可重建」的規則（`db/`、`out/`、`node_modules/`、`vendor-cm/dist/`）。
**其餘不追蹤的東西刻意不寫進 ignore。**

---

## commit 規則

### 什麼時候

使用者說 **「今日收工」** 或 **「結束本對話」** 時，把這一輪改動過的 `.md` 上傳。
**平時不要自己 commit／push。**

### 收哪些

根目錄與 `novel/` 的 `*.md`，**用明確的清單**。

> ⚠ **不要用 `git add '*.md'`。**
> git 的 pathspec 不含斜線時會**撈到子目錄**——實測 `git add --dry-run -- '*.md'`
> 會把 `tools/_globtest.md` 也列出來。

> ⚠ **不要用 `git add -A` 或 `git add .`。**
> `dump.tar.gz` 有 **111 MB**（超過 GitHub 單檔 100 MB 上限），`dump/` 更大，
> 一起拉進來會被直接退件。

### 指令（PowerShell，實測可用）

```powershell
Set-Location D:\2023\glyphwiki

# 用明確的清單，直接把檔名當參數傳（不要靠 glob，見上面的警告）
$files = @(
  Get-ChildItem -File -Filter *.md | ForEach-Object { $_.Name }
  Get-ChildItem novel -File -Filter *.md | ForEach-Object { "novel/$($_.Name)" }
)
git add -- $files
git status --short                      # 確認清單裡只有 .md

git commit -m "docs: <這一輪改了什麼>"
git push
```

> **搬檔或改名要用 `git mv`，不要只搬檔案再 `git add` 新路徑。**
> 後者只會暫存「新增」，舊路徑的刪除還留在工作區，commit 之後舊檔會繼續存在。

### 兩個踩過的坑

1. **不要用 `--pathspec-from-file` 搭配 PowerShell 寫的清單檔。**
   `Set-Content -Encoding UTF8` 會在檔首加 BOM，第一個路徑變成 `'﻿Ext B 字庫…md'`，
   git 會回 `fatal: pathspec ... did not match any files`。直接把檔名當參數傳就沒事。
2. **檔名有中文與全形括號是正常的。** `git status`／`git ls-files` 會用八進位逃脫序列顯示
   （例如 `"\345\255\227\351\233\206..."`），那是顯示格式，不是檔名本身。

### 上傳後檢查

```powershell
git ls-files        # 應該只有根目錄的 .md
git status -sb      # 應該顯示 ## main...origin/main，且沒有 ahead
git ls-remote --heads origin   # 遠端的 commit 應該等於本機 git rev-parse HEAD
```

---

*遠端：<https://github.com/accelon/glyphwiki>　分支：`main`*
