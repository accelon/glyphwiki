# pinxing-app — 拼形檢視器的 Wails3 版

> **單一 exe、零外部相依、開檔即用。**
> 這一支是 [`gocore`](../gocore/README.md) 的**測試床**：其他 Wails3 軟件要的是
> 可重用的 Go 組字能力，這裡負責證明那件事在真實的 Wails3 殼裡跑得起來。
> 架構取捨見 [`../progress/技術交接文件.md`](../progress/技術交接文件.md) §10.2。

---

## 1. 現況

| | 狀態 |
| --- | --- |
| Wails3 殼（單一 exe） | ✅ **11.33 MB**（`-w -s` 去符號；含內嵌字庫 2.22 MB） |
| GUI 子系統（`-H windowsgui`） | ✅ 沒有主控台視窗，不會再「一閃」 |
| 應用程式資訊清單（manifest） | ✅ DPI 感知、Common Controls v6、`asInvoker`、longPathAware |
| 版本資源（公司／產品／描述） | ✅ `VerQueryValue` 讀得到（見 §3 的一個怪癖） |
| 圖示 | ✅ `build/appicon.png` → `build/windows/icon.ico` |
| 內嵌字庫（`.gz`）＋ 開檔解壓 | ✅ `internal/glyphdata`，約 29 ms |
| `/lib.bin` 一次交付 4,703,188 bytes | ✅ 逐 byte 驗過（sha256 斷言） |
| 失敗**看得到**（日誌 ＋ 對話框） | ✅ `internal/diag`，見 §4 |
| asset server 伺服前端、零外部資源 | ✅ 驗過 |
| **視窗真的開起來** | ✅ **已實測**（§5：探測並改用寫得進去的 WebView2 user data folder，修好了 `800700aa`） |
| **標題列看得到** | ✅ 已實測（§9：視窗大小夾進工作區——原本 480×900 在工作區只有 693 高的機器上，置中後頂端是 **-33**） |
| 拼形 UI（輸入區／大字／部件清單） | ✅ **已接上並實測**：前端回報「191727 字 / 98701 家族 / 解碼 227 ms」（見 §6） |

---

## 2. 建置與執行

```bat
:: 建置（含 vet ＋ test）到**工作區外面**——建議用這個
pinxing-app\build.cmd -Test -Out D:\accelon26\pinxing-app.exe

:: 開發建置（不帶 production tag → DevTools 開）
pinxing-app\build.cmd -Dev -Out D:\accelon26\pinxing-app-dev.exe

:: 執行：雙擊（不寫日誌）；要記錄就從命令列加參數
D:\accelon26\pinxing-app.exe
D:\accelon26\pinxing-app.exe --log
```

> ⚠ **產物一律建到工作區外面**（例：`D:\accelon26\`）。DSH 的沙箱會把工作區
> 標成低完整性，在那裡產生的 exe 會被 SmartScreen 擋、而且寫不進 `%APPDATA%`
> ——詳見 §5 與 [`../wails3-notice.md`](../wails3-notice.md) §5。
> `build.ps1` 會在產物帶到那個標籤時**大聲警告**。

> **為什麼有 `build.cmd`**：它是**純 ASCII** 的入口，執行前會檢查 `build.ps1`
> 有沒有 UTF-8 BOM，沒有就補上。原因見下面那條警告——而那個坑我**自己重踩過一次**
> （用編輯工具改完 `build.ps1` 之後 BOM 掉了，整支腳本以 GBK 被讀，噴出
> `Missing closing '}' in statement block`）。
> ⚠ `build.cmd` 本身**不可以寫中文**（`cmd.exe` 也用 ANSI 讀 `.cmd`）——
> 我第一次寫的時候在 `rem` 裡放了中文，結果整支腳本被當成一串指令。

直接呼叫 `build.ps1` 也可以，只是要自己確保 BOM 還在：

```powershell
.\pinxing-app\build.ps1 -Test
```

`build.ps1` 的步驟與理由都寫在該檔的註解裡，摘要：

| 步驟 | 做什麼 | 為什麼 |
| --- | --- | --- |
| ⓪ | `bun run tools/build-pinxing.ts --hosted` → `frontend/index.html` | 前端**不是手寫的**：與離線單頁共用同一份 `tools/pinxing-page.js`（見 §6） |
| ① | 字庫從 `out/` 複製進來 | `go:embed` 只能嵌模組目錄內的檔案 |
| ② | 設 `GOCACHE`／`GOTMPDIR` 到工作區內 | 沙箱下 Go 的預設快取位置不可寫 |
| ③ | `wails3 generate icons` → `generate syso` | exe 的「身分」＝ manifest ＋ 版本資源 ＋ 圖示，三樣都在 `.syso` 裡 |
| ④ | `go vet` / `go test` | 不開窗的驗收 |
| ⑤ | `go build -tags production -trimpath -buildvcs=false -ldflags="-w -s -H windowsgui"` | **Wails 官方的參數**；`-H windowsgui` 是最關鍵的一個 |

⚠ **`.ps1` 一定要存成「UTF-8 **含 BOM**」**：這台機器是 Windows PowerShell 5.1，
沒有 BOM 時它會用 ANSI／GBK 讀腳本，中文字被拆壞之後連字串的結束引號都會斷，
錯誤訊息長成 `The string is missing the terminator`（**與編碼無關的假線索**）。
`build.ps1` 是含 BOM 的；**編輯工具不會幫你保留它**——用 `build.cmd` 就會自動補回來。

---

## 3. ⚠ SmartScreen 攔下 exe（**不是病毒偵測**）

**症狀**：執行 `pinxing-app.exe` 時出現 SmartScreen 的「Windows 已保護您的電腦」，
而且**沒有「仍要執行」可選**。

**真因（實測）**：這台機器的 SmartScreen 被設成**封鎖**級，不是預設的「警告」：

```
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer  SmartScreenEnabled = RequireAdmin
```

`RequireAdmin` ＝「檢查應用程式與檔案」的最嚴格一級。這一級下**任何剛編出來、
未簽章的 exe 都會被擋**，與這一支的內容無關。

⚠ **兩個容易搞錯的地方，寫下來免得下一個人又走一次冤枉路**：

1. **SmartScreen 是「信譽」判斷，不是防毒。** 所以
   「回報防毒誤判」**沒有用**；補 manifest／版本資源／圖示對它也**沒有幫助**
   （它只看數位簽章與下載信譽）。
   **自簽憑證也不行**——要受信任 CA 簽發、且累積了信譽的憑證。
2. **檔案上沒有 Mark of the Web**（`Zone.Identifier` 已驗過不存在），
   所以不是「下載來的檔案被標記」那一條路。

**可以怎麼做**：

* 用**系統管理員**身分執行（`RequireAdmin` 這一級通常允許管理員覆寫）
* 或把 Windows 安全性 → 應用程式與瀏覽器控制 → 信譽式保護 →
  「檢查應用程式與檔案」改成**警告**（**這是機器層級的資安設定變更，要不要改由你決定**）
* 要發布給別人用就得**程式碼簽章**

### 順帶做對的事（與 SmartScreen 無關，但有價值）

| 之前 | 現在 | 真正解決了什麼 |
| --- | --- | --- |
| 子系統 = **CONSOLE**（3） | **GUI**（2） | **「閃退」的成因**——之前失敗時主控台一閃就關 |
| **沒有** manifest | 有（DPI／Common Controls／`asInvoker`） | 高 DPI 不糊、有身分 |
| **沒有**版本資源 | 有（`glyphwiki` / `Setsuna Pinxing` / `0.1.0`） | 檔案內容頁有資訊 |
| **沒有**圖示 | 有 | 看起來像正常程式 |
| 17.75 MB、帶符號 | 11.33 MB、`-w -s -trimpath` | 體積 |

⚠ 另外要誠實說：exe 內嵌了 **2.22 MB 的高熵資料**（gzip 過的字庫）。
未簽章 ＋ 一大塊高熵內嵌資料，在**防毒啟發式**眼裡與「加殼的投放器」同形。
這是「單一 exe」換來的代價，不能兩全——如果哪天真被防毒誤判，
這是第一個要看的地方。

**已知的一個小怪癖**：`wails3 generate syso` 產生的版本資源，
用 Win32 的 `VerQueryValue` 讀得到全部正確值，但 **.NET 的
`FileVersionInfo`／檔案內容頁可能顯示空白**。
（對照組：這台機器上 `go.exe`、`wails3.exe` 用 .NET 讀也是空的，
所以沒有可信的基準可判斷是不是 syso 的結構問題。已記錄、未追。）

---

## 4. ⚠ 失敗時去哪裡看（**不會再是「閃退」**）

這個 App 是 `-H windowsgui`：**它沒有主控台**。所以「印到 stderr 然後結束」
對使用者就是**一閃就沒了**——沒有訊息，事件記錄裡也沒有（正常的 `os.Exit`
不會留 Application Error）。實際踩過：WebView2 建立 controller 失敗時
`app.Run()` 回錯誤，`log.Fatal` 印出一大段堆疊後結束，而使用者只看到「閃退」，
**那一段堆疊裡有全部答案**。

現在 `internal/diag` 用**三層**確保「失敗一定看得到」：

| 層 | 做什麼 | 什麼時候有用 |
| --- | --- | --- |
| ① 日誌檔 | `pinxing-app.log`（exe 旁邊；寫不進去退到 `%LOCALAPPDATA%\pinxing-app\`，再退到 `%TEMP%`） | **只有命令列加參數啟動時才寫**（見下） |
| ② `diag.Fatal` | 記錄 ＋ **對話框** ＋ `exit(1)` | 失敗**經過我們的程式碼**時 |
| ③ `patternWatcher` | 在輸出流裡攔致命特徵，**同步**彈對話框 | 失敗**在我們拿到控制權之前**就結束行程時（實測就是這種） |

### ⚠ 預設**不寫**日誌檔（`--log` 才寫）

使用者的要求：**雙擊時不要在他旁邊留下 `.log`**。

| 啟動方式 | 日誌檔 |
| --- | --- |
| **雙擊**（`os.Args` 只有 exe 路徑） | **不寫**——完全不碰檔案系統 |
| **命令列加參數**（任何參數；`--log` 最好記） | 寫（路徑優先序見 ①） |

```bat
pinxing-app.exe --log
```

⚠ **不寫日誌不會少掉失敗對話框**：關閉時仍然會裝 `patternWatcher`
（輸出改用 `io.Discard`，**攔截留著**）——那是 GUI 程式唯一的失敗出口。
回歸測試用**型別斷言**把這件事釘住（`TestInitLogDisabledTouchesNoFile`），
因為「有沒有彈對話框」在自動化裡太難驗。

⚠ 也因為沒有檔案，**「上一次的遺言」那一層在預設模式下不會作用**（沒有證據就不亂彈），
而且失敗時的對話框沒有日誌路徑可指，改為提示「用 `--log` 重跑」。

還有一層補漏：**啟動時報告上一次的遺言**——日誌結尾沒有「`=== 正常結束 ===`」就表示
上一輪死在半路，這時把結尾幾行用對話框講出來。它不依賴任何失敗路徑，所以就算
行程被外力直接砍掉也有效。（少了 `diag.Finish()` 就會讓每次啟動都誤報，別忘了。
**這一層只在有寫日誌時有效**——預設模式沒有舊檔可讀。）

日誌裡會有每一個里程碑，所以「跑到哪一步才失敗」一目了然：

```
--- 日誌開始 ---
=== 剎那拼形 啟動 ===
日誌檔：…\pinxing-app.log
字庫已載入：4703188 bytes（內嵌 2327989 bytes，sha256 babe63b5…）
路由表就緒（/、/lib.bin）
Wails 應用已建立
視窗已建立，進入事件迴圈
[WebView2] Environment created successfully
[WebView2 Error] error creating controller with 800700aa: The requested resource is in use.
```

Wails 自己的訊息（含 WebView2 的錯誤）也走同一條路（`application.Options.Logger`）。

**三個不好懂的取捨，都寫在這裡免得被「修好」**：

1. **`teeBestEffort` 為什麼檔案先寫、stderr 後寫而且忽略它的錯誤。**
   由檔案總管啟動的 GUI 程式，`os.Stderr` 是**無效的控制代碼**。若用
   `io.MultiWriter(os.Stderr, f)`（我第一版的寫法），`MultiWriter` 會在第一個
   writer 就失敗返回 → **檔案一個 byte 都拿不到**，症狀是「日誌存在但是空的」。
   回歸測試：`TestTeeWritesMainEvenWhenExtraFails`。
2. **`patternWatcher` 為什麼同步彈對話框，不用 goroutine。**
   直覺會想用 goroutine 以免卡住寫日誌的路徑，但實測**贏不了**：Wails 在
   errorCallback 之後立刻結束行程，goroutine 還沒被排到就一起被殺了。
   同步呼叫反而同時解決兩件事——對話框會出現，而且因為它阻塞了那個 callback，
   行程不會走到結束那一步。
   代價：堆疊的**後半段來不及寫進日誌**（日誌會停在攔到的那一行附近）。
   關鍵那一行與所有啟動里程碑都在，所以可接受。
3. **`PINXING_NO_DIALOG=1` 跳過所有對話框**（只留日誌）——給自動化與 CI 用：
   對話框會**阻塞到有人按確定**，那在無人看管的環境裡就是卡死。

**規則：`main.go` 裡不可以出現 `log.Fatal`／`os.Exit`**，全部走 `diag.Fatal`。

---

## 5. ⚠ 開不了視窗的真因與修法：**WebView2 的 user data folder 建不起來**

**症狀**（一個非常難查的形狀）：

```
[WebView2] Environment created successfully
[WebView2 Error] error creating controller with 800700aa: The requested resource is in use.
```

**環境回報「建立成功」，但 user data folder 從來沒被建立**，接著 controller 以
`ERROR_BUSY` 失敗——錯誤訊息完全指不到真因。

**真因**：Wails 的預設 UDF 是 `%APPDATA%\<exe 名>`。當那個目錄**建不起來**時就會這樣。
實測（用一支 25 行的最小 Wails 應用在 `main()` 開頭逐一試寫）：

| 目標 | 結果 |
| --- | --- |
| exe 旁邊（工作區內） | ✅ 成功 |
| 工作區 | ✅ 成功 |
| `%TEMP%`（`C:\temp`） | ❌ **Access is denied** |
| `%LOCALAPPDATA%` | ❌ **Access is denied** |
| **`%APPDATA%`** | ❌ **Access is denied** |

### ★ 真正的根因：**工作區資料夾帶「低完整性」標籤**（2026-10-16 查清）

⚠ **上面那張表是症狀，不是根因。** 我當初推論成「執行環境限制寫入」——**那是錯的**。
真因是一行 `icacls` 就看得見的東西：

```
> icacls "D:\2023\glyphwiki"
D:\2023\glyphwiki  Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
```

* `(OI)(CI)` ＋ `(I)`：**在裡面新建的檔案／子資料夾都繼承低完整性**
  （複製進去的也算新建）。
* `(NW)` ＝ **No-Write-Up**：**低完整性行程不能往上寫中完整性的位置** →
  `%APPDATA%`／`%LOCALAPPDATA%`／`%TEMP%` 全部被拒，**而 exe 旁邊同層級可寫** ✓
  （這正是那張表的形狀）。

**同一個標籤還造成第二個症狀**：Windows 把低完整性的執行檔當成不受信任，
所以**從檔案總管雙擊這個資料夾裡的 exe 會跳 SmartScreen「無法辨識的應用程式」**
（本機 `SmartScreenEnabled=RequireAdmin`＝封鎖，**沒有「仍要執行」**）。

**兩個症狀、一個根因**，而且**與 exe 的內容完全無關**——實測同一個 sha256
（`324CF11C…`）在這裡被擋、搬到 `D:\pinxing-app\` 就一切正常，
`★ 採用 APPDATA（Wails 預設）` 直接成功，**連 `wvdata` 的保底都不需要**。

**修法**：
1. **把產物建到沒有這個標籤的資料夾**（最省事、也最正確）：
   `.\build.cmd -Out D:\pinxing-app\pinxing-app.exe`
   ——`build.ps1` 現在會在產物帶低完整性標籤時**大聲警告**（§2 的第 ⑥ 步）。
2. 或用管理員 `icacls "<dir>" /setintegritylevel Medium`（提升完整性需要管理員；
   而且如果那是沙箱刻意加的，拿掉等於削弱沙箱——**動手前想清楚**）。
3. ⚠ **不要**把 `wvdata` 當成解法 ✗：它在正常機器上是多餘的。
   當**防禦**留著可以（讓 App 在受限環境仍能跑），但根因是標籤。

⚠ 順帶更正一個我寫錯的說法：**「這不是 ACL 問題」那句只對了一半**——
一般 ACL 確實沒問題（FullControl、無 DENY），但**強制完整性標籤不屬於一般的 ACL**，
`Get-Acl` 也**不會**顯示它，要用 **`icacls`** 才看得到。

### 修法（防禦）：`internal/wvdata`（啟動時探測，挑寫得進去的那一個）

`main.go` 建立應用之前，依序探測候選目錄，把**第一個確定寫得進去**的指定給
`Windows.WebviewUserDataPath`：

| 順序 | 候選 | 為什麼 |
| --- | --- | --- |
| 1 | `%APPDATA%\<exe 名>` | **Wails 的預設**——正常機器上就停在這裡，**行為完全不變** |
| 2 | `%LOCALAPPDATA%\pinxing-app\webview2` | 漫遊設定被政策鎖住時的常見替代 |
| 3 | **exe 旁邊** `<exe 目錄>\pinxing-app.webview2` | 保底。程式自己所在的目錄是唯一在各種受限環境下都寫得進去的地方 |

⚠ 探測**不只看 `MkdirAll`**：目錄「已存在但不可寫」時 `MkdirAll` 會回 nil，
只看它就會選到一個根本寫不進去的目錄——**那正是這個 bug 的形狀**。
所以 `ProbeWritable()` 會實際寫一個檔案再刪掉（回歸測試：`wvdata_test.go`）。

全部候選都失敗時傳空字串，讓 Wails 用它自己的預設——**不要**硬塞一個不能寫的路徑進去
（那只會把症狀換成另一個更難懂的錯誤）。

**副作用**：在受限環境下，exe 旁邊會多一個 `pinxing-app.webview2\` 目錄（已進 `.gitignore`）。

**驗證**（本專案實測、在最受限的環境下）：視窗真的開起來、標題是「剎那拼形 — Go 版」，
日誌顯示 `★ 採用 exe 旁邊（保底）`，接著 `[AssetFileServerFS] Handling request url=/app.js`
——前端載入並執行。

### 排除掉的猜測（不要再查一次）

| 猜測 | 實驗 | 結果 |
| --- | --- | --- |
| 沙箱封鎖具名管道 | —— | ✗ 機制猜錯了，真因是 UDF 建不出來 |
| 孤兒行程鎖住 user data folder | 清光 WebView2 殘留行程後重跑 | ✗ 仍然 `800700aa` |
| 是 Wails 版本太舊（`beta.3`） | 升到最新的 `v3.0.0-beta.30` 重跑 | ✗ **完全一樣**（已還原成 `beta.3`，與其他專案一致） |
| 是這一支的程式碼／syso／manifest | 25 行最小 Wails 應用重現 | ✗ **一樣失敗** |

### 為什麼非得做「日誌 ＋ 對話框」

Wails 在 WebView2 失敗時**自己結束行程**——`v3.0.0-beta.30` 的原始碼寫得很明白：

```go
func (e *Chromium) errorCallback(err error) {
	e.globalErrorCallback(err)
	os.Exit(1)
}
```

所以 `diag.Fatal` 永遠跑不到，這也是為什麼 §4 的 `patternWatcher`（在**輸出流**裡
攔致命特徵、**同步**彈對話框）是唯一能講話的管道。

### 另一個會誤導你的沙箱副作用

WebView2 的孤兒行程會**繼承啟動者的 stdio 管線**：用「捕捉輸出」的方式啟動 App 時，
主行程早已結束，但工具仍會一直等（我因此吃過一次 600 秒的逾時）。
自動化時請把 stdio 重導到檔案。

---

## 6. 字庫怎麼進到 JS（**一次性灌輸**）＋ 前端怎麼來的

```
exe 內嵌 lib-cjk-all.bin.gz（2,327,989 bytes）
  → 開檔時 Go 解壓（約 29 ms）成 4,703,188 bytes
  → 掛在 /lib.bin（Cache-Control: no-store，見 main.go 的理由）
  → 前端一次 fetch 拿完（4.49 MB）
  → 前端用它**現有的** decodeLibrary() 解開
  → render 完之後 POST /__ready 回報，Go 寫進日誌
```

**實測結果**（`pinxing-app.log`）：

```
[頁面] 已就緒：191727 字 / 98701 家族 / 解碼 227 ms
```

### 前端是**產生出來的**——兩種宿主共用同一份頁面程式碼

| | 離線單頁 | 宿主模式（這一支） |
| --- | --- | --- |
| 產物 | `out/pinxing.html`（**3.52 MB**） | `pinxing-app/frontend/index.html`（**569 KB**） |
| 字庫 | **以 base64 內嵌**（2.96 MB） | 改由 `/lib.bin` 一次 fetch |
| 指令 | `bun run tools/build-pinxing.ts` | `bun run tools/build-pinxing.ts --hosted` |
| 為什麼 | `file://` 直接開、微信內建瀏覽器也能跑 | 不重複搬 3.1 MB，且字庫換了不必重編前端 |

**差別只有一行**：`loadLibBytes()`（`tools/pinxing-page.js`）——
`window.__LIB_URL__` 有設就 fetch，沒設就解內嵌的 base64。

> ⚠ **不要**自己手寫一份 `frontend/index.html` ✗。頁面程式碼的唯一來源是
> `tools/pinxing-page.js` 加上它內嵌的模組（kage-engine、lib-format、compose-fit…）。
> 這個專案吃過「同一個東西兩份來源各說各話」的虧（見 `tools/embed-common.ts` 檔頭），
> 所以寧可在建置器多一個 `--hosted` 開關，也不要多一份頁面。

宿主模式還會自動：拿掉指向 `gouxingji.html` 的開發記錄連結（那個檔在 App 裡不存在，
留著會 404）與「微信打開看不到」那一句（桌面視窗裡沒有意義）。

### 為什麼不走 Wails 的 binding

binding 走 JSON 打包，`[]byte` 會變成「一串數字」或 base64——4.49 MB 會膨脹好幾倍，
而且還要 codegen 產生帶數字 ID 的 wrapper（beta.3 的形式是
`Call.ByID(2952413357, …)`）。當靜態資產送就只是**一個 HTTP GET**。

### 為什麼內嵌 `.gz` 而不是 `.bin`

用 29 ms 換 2.22 MB。

### 為什麼不送「解碼後的資料」（Go 先解好再交給 JS）

實測要搬 **17.14 MB**（3.82 倍），而且 JS 收到之後**還是要建 19 萬個字形物件**
——那才是解碼的主要成本。數字都在 `gocore/cmd/libstats`。

---

## 7. 接下來

1. ~~把拼形 UI 接上~~ ✅ **已完成**（§6）。
2. **`gocore` 往上疊語意**：`compose/`（`findSlot`／`solveIdsSlots`／`canReplaceCp`）、
   `search/`（部件檢字、IDS→拼形序——順手收攏 `seq-search.ts` 與頁面 `ladderForIds`
   的重複實作）。
3. 封裝（`wails3 package`：NSIS／MSIX）與程式碼簽章。

---

## 8. 檔案

| 路徑 | 是什麼 |
| --- | --- |
| `main.go` | 殼：路由表、`/lib.bin`、`/__ready`、視窗、啟動里程碑日誌 |
| `main_test.go` | **不開窗的驗收**：前端伺服、字庫逐 byte、`no-store`、就緒回報、零外部相依 |
| `internal/diag/` | 日誌檔 ＋ 失敗對話框（**GUI 程式唯一該用的致命錯誤出口**） |
| `internal/wvdata/` | 探測並挑選 WebView2 的 user data folder（修 `800700aa` 的那一支） |
| `internal/winsize/` | 量主螢幕工作區並把視窗大小夾進去（修「看不到 title」的那一支，見 §9） |
| `internal/glyphdata/` | 內嵌字庫與解壓（`*.bin.gz` 是產物、不入版控） |
| `internal/diag/notify_windows.go` | MessageBox（含 `w32.MessageBox` 參數順序反了的坑） |
| `frontend/index.html` | **產生出來的、不入版控**：`bun run tools/build-pinxing.ts --hosted`（見 §6） |
| `build/make-icon.go` | 圖示產生器（`//go:build ignore`，只用標準庫、不需字型） |
| `build/windows/app.manifest` | Windows 資訊清單（來源資產） |
| `build/windows/info.json` | 版本資源（來源資產） |
| `build/windows/icon.ico`、`build/appicon.png` | 圖示（來源資產） |
| `build.ps1` | 建置（⓪ 前端 → ① 字庫 → ② 環境 → ③ syso → ④ 測試 → ⑤ 編譯） |
| `devtools_dev.go`／`devtools_prod.go` | 用 `production` build tag 控制 DevTools |

---

## 9. 視窗大小：標題列為什麼看不到

**症狀**：使用者說「**看不到視窗的 title**」。

**真因**：**Wails 會把視窗置中，但不會幫你夾進螢幕**（`WebviewWindowOptions` 只有
`Width`／`Height`／`Min*`／`Max*`，沒有定位、也沒有 fit）。原本硬寫的
`Height: 900` 在本機的**邏輯工作區只有 1040 × 693**（3120 × 2080 面板、300% 縮放）
上比工作區還高，置中之後：

```
視窗矩形  左上 (280, -33)   大小 480 × 759
                ↑ 負的 → 標題列整個在畫面之上
```

**修法**：`internal/winsize` —— 量工作區，把想要的大小夾進去（留 40／80 的邊界
給標題列與工作列），並留下限 360×420。

**單位換算是實測出來的**（別走錯路）：

| 呼叫 | 回傳 |
| --- | --- |
| `GetSystemMetrics(SM_CYSCREEN)` | 實體像素（3120） |
| `GetMonitorInfo(...).RcWork` | 實體像素 |
| `GetSystemMetricsForDpi(SM_CYSCREEN, 96)` | **還是 3120** ⚠ 不會幫你換算 |
| `GetDeviceCaps(GetDC(0), LOGPIXELSX)` | 288 → 縮放 3.0 |

→ **邏輯 = 實體 ÷ (LOGPIXELSX / 96)** ＝ 1040 × 693 ✓

**驗收**：用 `GetWindowRect` 讀實際矩形，斷言 `top ≥ 0`。修好之後實測：

```
主螢幕工作區 1040×693 → 視窗 480×613
視窗矩形 左上 (280,40)  右下 (760,653)      ← 頂端 40 ≥ 0 ✓
```

⚠ 量不到工作區時**原樣回傳**（不要把「不知道」當成「很小」）；
夾的規則不分成平台，只有「工作區怎麼量」是平台專屬
（`workarea_windows.go` ／ `workarea_other.go`）——跨平台時只補後者。

> 這一條的**通用版**（含驗收用的 PowerShell）寫在
> [`../wails3-notice.md`](../wails3-notice.md) §1.5。
