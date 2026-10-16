# wails3-notice.md — 建 Wails3 程式踩過的坑

> 寫給「經常要建 Wails3 程式」的人：**先讀這一頁**，可以省下重複 debug 的時間。
> 全部在 **Windows 11 + Go 1.26 + wails v3.0.0-beta.3／beta.30** 實測過；
> 每一條都附「症狀 → 怎麼判斷 → 怎麼修」。
>
> 這裡刻意**不寫 Wails 的基本用法**（那些看官方文件就好），只寫**文件上沒有、
> 而且一踩就會卡好幾小時**的東西。

---

## 0. 三十秒版：最貴的七個坑

| # | 坑 | 症狀 | 一句話修法 |
| --- | --- | --- | --- |
| 1 | 沒加 `-H windowsgui` | 雙擊「閃退」，什麼訊息都沒有 | 產物必須是 **GUI 子系統**（PE subsystem = 2） |
| 2 | GUI 程式把錯誤印到 stderr | 同上，因為**沒有主控台可讀** | 寫日誌檔 ＋ 彈 MessageBox |
| 3 | **資料夾帶「低完整性」標籤（`Low Mandatory Level:(NW)`）** | ① 同一顆 exe 在這裡被 SmartScreen 擋、搬走就正常 ② `%APPDATA%` 全部 `Access is denied` → `800700aa` | **`icacls <資料夾>` 看標籤**；**產物不要建在 DSH 沙箱工作區內**（見 §5） |
| 4 | 硬寫的視窗高度比工作區高 | 使用者說「**看不到視窗的 title**」 | 量工作區再夾：**邏輯 = 實體 ÷ (LOGPIXELSX/96)** |
| 5 | `.ps1` 沒有 UTF-8 BOM | `Missing closing '}'`（與編碼無關的假線索） | 存成**含 BOM**，或用 ASCII-only 的 `.cmd` 入口自動補 |
| 6 | `go build` 的 `GOCACHE` 不可寫 | `open ...go-build...: Access is denied` | 把 `GOCACHE`／`GOTMPDIR` 指到可寫處 |
| 7 | 大檔走 Wails binding | 4.5 MB 膨脹好幾倍、還要 codegen | 當**靜態資產**送（`/lib.bin` ＋ 一次 `fetch`），見 §4 |

> ### ★ 如果你在 **DSH** 裡開發，先看這一條
>
> **DSH 的 Windows 沙箱會把「工作區根目錄」標成 Low 完整性**，而且**那個標籤會永久留下**
> —— 即使該會話後來切成「完整權限」也**不會**被移除。
>
> 後果有兩個，而且**都發生在你自己的機器上、DSH 之外**：
> ① 從那個資料夾建出的 exe，**雙擊會被 SmartScreen 擋**（`RequireAdmin` 時沒有「仍要執行」）；
> ② 那個 exe 啟動後是 Low 完整性 → **`%APPDATA%`／`%LOCALAPPDATA%`／`%TEMP%` 全部被拒**
> → WebView2 的 user data folder 建不出來 → `error creating controller with 800700aa`。
>
> **做法：把建置產物建到工作區外面**（`build.cmd -Out D:\app\app.exe`），
> 或把專案**複製**到新資料夾（複製會取得目的地的標籤＝正常）。
> **不要**嘗試改那個標籤——DSH 會在下一次供給時改回去，而且可能讓該工作區在受限模式下完全不能寫。
> 完整說明與出處見 **§5**。

---

## 1. 產物與視窗：GUI 子系統、exe 的身分、以及**夾進螢幕**

### 1.1 `-H windowsgui` 不是可選的

Wails 官方的正式建置參數（抄 `build/windows/Taskfile.yml`）：

```
go build -tags production -trimpath -buildvcs=false \
  -ldflags="-w -s -H windowsgui"
```

沒有 `-H windowsgui` 時產物是 **console 子系統**：

* 雙擊時 Windows 會先開一個**主控台視窗**，程式結束時它跟著關掉
* 使用者看到的只有「**閃退**」兩個字，而所有診斷訊息都印在那個一閃即逝的主控台上
* 這種失敗**不會留下事件記錄**（正常 `os.Exit` 沒有 Application Error）

**怎麼判斷產物是哪一種**（不用工具，讀 PE 標頭就好）：

```powershell
$b = [IO.File]::ReadAllBytes("app.exe")
$e = [BitConverter]::ToInt32($b, 0x3C)                 # e_lfanew
$sub = [BitConverter]::ToUInt16($b, $e + 4 + 20 + 68)  # OptionalHeader.Subsystem
# 2 = GUI（WINDOWS_GUI）  3 = CONSOLE（WINDOWS_CUI）
```

⚠ **開發建置也不要妥協**：Wails 的 dev flags（`-gcflags=all="-l"`、沒有 `-w -s`、
沒有 `-H windowsgui`）產物是 console 子系統。自己另外做一個「dev 但仍是 GUI」的
開關（用 `production` build tag 控制 DevTools，而不是用官方那組 dev flags）。

### 1.2 `.syso`＝exe 的「身分」：manifest ＋ 版本資源 ＋ 圖示

```
wails3 generate syso -arch amd64 \
  -icon build/windows/icon.ico \
  -manifest build/windows/app.manifest \
  -info build/windows/info.json \
  -out wails_windows_amd64.syso
```

`go build` 會**自動連結**套件目錄裡的 `*.syso`（不必任何 flag）。

三個實測到的細節：

* **`-icon` 與 `-manifest` 都是必填**：原始碼裡留空會直接回
  `manifest is required`／`icon is required`。
* **`info.json` 的語言鍵要用真的 LANGID（`0409`、`0404`），不要用 `0000`。**
  用 `0000` 時版本資源**寫得進去、但查不出來**——`VerQueryValue` 對
  `\StringFileInfo\040904B0\ProductName` 會回「找不到」，檔案內容頁也是空的。
  實測：`0000` → 全空；`0409`／`0404` → 全部正確。
* **`wails3 generate icons` 會順便寫 macOS 的產物**，預設路徑是
  `build/darwin/icon.icns`；那個目錄不存在時它會**以非零離開碼結束**（雖然 `.ico`
  已經寫出來了）。只出 Windows 的話把 Apple 產物丟到暫存目錄：

  ```
  wails3 generate icons -input build/appicon.png -windowsfilename build/windows/icon.ico ^
      -macassetdir .cache/mac -macfilename .cache/mac/icon.icns
  ```

### 1.3 想做到「零相依（不用 npm）」就別用範本

`wails3 init` 的範本**全部都是 Vite 專案**（`vanilla`、`react`、`vue`…），
也就是說一定有 Node／npm 建置步驟。如果你要的是「**單一 exe、零外部相依、
不必 `npm install`**」，就手寫一個最小專案：

```go
//go:embed frontend
var assets embed.FS

sub, _ := fs.Sub(assets, "frontend")          // ⚠ 少了 fs.Sub 就會 404（嵌入路徑帶前綴）
app := application.New(application.Options{
    Name:   "MyApp",
    Assets: application.AssetOptions{Handler: application.AssetFileServerFS(sub)},
})
app.Window.NewWithOptions(application.WebviewWindowOptions{Title: "MyApp", URL: "/"})
app.Run()
```

前端就是**靜態檔案**（HTML／CSS／JS），改完直接重編 exe——沒有 bundler、沒有 CDN。
⚠ `fs.Sub` 那一步常被忘記：`embed.FS` 的路徑帶著目錄前綴
（`frontend/index.html`），不 `Sub` 的話 asset server 找不到 `/index.html`。

### 1.4 關於 SmartScreen：「無法辨識的應用程式」有**兩個**觸發條件

SmartScreen 的應用程式信譽功能全名是「SmartScreen for apps and files ***from the web***」。
**它不是病毒引擎**（叫 Defender 的引擎掃，會回 `found no threats`，別往那個方向查）。
它會在兩種情況下攔下未簽章的自家 exe：

| 觸發條件 | 怎麼查 | 說明 |
| --- | --- | --- |
| **① Mark of the Web**（來自網路） | `cmd /c dir /r <exe>` 看有沒有 `:Zone.Identifier` | 經典情況：從網頁下載、經由瀏覽器交付 |
| **② 低完整性標籤**（本節的重點） | **`icacls <exe>`** 看有沒有 `Mandatory Label\Low Mandatory Level` | **在低完整性的資料夾裡新建的檔案會繼承**——見 §5 |

⚠ **②比①更難查，因為它跟 exe 本身完全無關**：本機實測**同一個 sha256** 的執行檔，
放在 `D:\work\` 被擋、放在 `D:\app\` 完全正常。於是你會一直往「exe 少了什麼」去查，
而**每一次都查到「沒有少」**：

| | 被擋的那一顆 | 不被擋的那一顆 |
| --- | --- | --- |
| sha256 | `324CF11C…` | **`324CF11C…`（相同）** |
| 子系統 / manifest / 版本資源 | GUI / 有 / 有 | 相同 |
| 簽章 | NotSigned | NotSigned |
| Mark of the Web | 無 | 無 |
| **完整性標籤** | **Low Mandatory Level** | **中（沒有標籤）** |

→ **「補 manifest／版本資源／圖示／簽章」全都沒用** ✗。判準不在檔案裡，在**它所在的位置**。

**這台機器的設定（實測）**：

| 位置 | 值 | 意思 |
| --- | --- | --- |
| `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer` | `SmartScreenEnabled = RequireAdmin` | **最嚴格的一級（封鎖）**，不是預設的 `Warn` |
| `HKLM\SOFTWARE\Policies\Microsoft\Windows\System` | `EnableSmartScreen` | 原則機碼（未設） |

`RequireAdmin` 這一級**不會給「仍要執行」的連結**——所以它不是「按一下就能過」，
而是**根本進不去**。

**要讓它不出現，按這個順序試**：

1. **把 exe 產物放在沒有低完整性標籤的資料夾**（用 `icacls` 確認）。
   **產物不一定要放在工作區裡**——這是解②唯一有效也最省事的做法 ✓。
   ⚠ **簽章救不了②**：把簽好的 exe 複製進低完整性資料夾，它一樣繼承低完整性、一樣被擋。
   （實測：連微軟簽章的 `charmap.exe` 複製進去也被擋。）
2. 若是①（有 MOTW）：`Unblock-File <exe>`，或**不要經過網頁／下載式的交付路徑**。
3. 把 Windows 安全性 → 應用程式與瀏覽器控制 → 信譽式保護 →
   「檢查應用程式與檔案」由**封鎖**改成**警告**，這樣至少會出現「仍要執行」。
4. **程式碼簽章**——**要發布給別人用時**的唯一正解（**自簽沒用**，SmartScreen 要受信任 CA
   簽發且累積了信譽的憑證）。⚠ 它解的是「陌生人下載你的 exe」那個情境，
   **不是**本節的②。
5. 每個重新建置都是**新的檔案雜湊 ＝ 全新的「無法辨識」**，所以簽章之前，
   這個提示在每次重建後都可能回來——這是開發期的正常現象，不是你寫錯了什麼。

**怎麼確認一個檔案是不是「來自網路」**（用 `dir /r`，比 `Get-Item -Stream *` 可靠）：

```
cmd /c dir /r "path\to\app.exe"
# 有 MOTW 時，檔案下面會多一行：  :Zone.Identifier:$DATA
# 移除它：Unblock-File .\app.exe
```

**叫 Defender 自己的引擎掃一次**是最快的自清方式（不需要管理員）：

```
& "$env:ProgramData\Microsoft\Windows Defender\Platform\CurrentVersion\MpCmdRun.exe" ^
    -Scan -ScanType 3 -File "path\to\app.exe" -DisableRemediation
```

`found no threats` 就代表**不是病毒引擎**的問題，別再往那個方向查。

### 1.5 視窗大小：**Wails 不會幫你夾進螢幕**

`WebviewWindowOptions` 只有 `Width`／`Height`／`Min*`／`Max*`——**沒有定位、
也沒有「fit to screen」**。Wails 會把視窗置中，但**不會**確認它放不放得進去。

**症狀**：使用者說「**看不到視窗的 title**」。不是「視窗太大」——
是標題列整個落在畫面之上。

**實測**（3120 × 2080 面板、**300% 縮放**的筆電）：

```
主螢幕邏輯工作區              1040 × 693
請求 480 × 900 之後的實際視窗  左上 (280, -33)   大小 480 × 759
                                ↑ 負的 → 標題列在畫面外
```

**修法：自己量工作區再夾，並留邊界**（`Height` 不含標題列，工作列也要吃高度）：

```go
wantW, wantH := 480, 900
aw, ah := <工作區的邏輯像素>
if aw > 0 && ah > 0 {                       // ⚠ 量不到就原樣回傳，別當成「很小」
    if maxW := aw - 40; wantW > maxW { wantW = maxW }
    if maxH := ah - 80; wantH > maxH { wantH = maxH }
}
```

**怎麼量（Windows）**——這是我實測出來的換算，別走錯路：

| 呼叫 | 回傳 |
| --- | --- |
| `GetSystemMetrics(SM_CYSCREEN)` | **實體**像素（3120） |
| `GetMonitorInfo(...).RcWork` | **實體**像素（3120 × 2080） |
| `GetSystemMetricsForDpi(SM_CYSCREEN, 96)` | **還是 3120** ⚠ 它不會幫你換算 |
| `GetDeviceCaps(GetDC(0), LOGPIXELSX)` | 288 → 縮放 **3.0** |

→ **邏輯 = 實體 ÷ (LOGPIXELSX / 96)** ＝ 1040 × 693 ✓ 與系統回報一致。

**驗收方式**（不要只看「開起來了」）：用 `GetWindowRect` 讀實際矩形，
斷言 **`top ≥ 0`** 且 **`bottom ≤ 工作區底`**。這個檢查抓得到「標題列在畫面外」，
而肉眼在遠端桌面／多螢幕的情況下很容易漏看：

```powershell
# 跑起來之後
[W]::GetWindowRect($proc.MainWindowHandle, [ref]$r)
if ($r.Top -lt 0) { "★ 視窗頂端在工作區之上 → 標題列看不到" }
```

⚠ 還有一個下限要留（例如 360×420）：極小的螢幕上把視窗縮成一團也沒有意義。

⚠ 這一節的東西**平台專屬**（Win32）。要做跨平台就在 `WorkArea()` 那一支
補上各平台的實作（macOS `NSScreen.visibleFrame`、Linux GDK workarea），
**夾的規則本身不必分平台**——這樣才不會兩份各說各話。

---

## 2. WebView2：`800700aa` 的意思其實是「user data folder 建不出來」

### 2.1 症狀（**極難查，因為訊息完全指不到真因**）

```
[WebView2] Environment created successfully
[WebView2 Error] error creating controller with 800700aa: The requested resource is in use.
```

`800700aa` ＝ `HRESULT_FROM_WIN32(ERROR_BUSY)`。**它不是「資源被佔用」**，
而是：**環境回報建立成功，但 user data folder（UDF）從來沒被建立**，於是
`CreateCoreWebView2Controller` 失敗。

### 2.2 UDF 在哪裡

Wails 的預設（`internal/webview2/pkg/edge/chromium.go`，beta.3／beta.30 相同）：

```go
dataPath := e.DataPath
if dataPath == "" {
    // GetModuleFileName(NULL) → exe 檔名
    dataPath = filepath.Join(os.Getenv("AppData"), currentExeName)
}
```

也就是 `%APPDATA%\<exe 檔名>`（再往下是 `EBWebView\`）。
要覆寫就設 `application.Options.Windows.WebviewUserDataPath`。

**怎麼確認實際用了哪個路徑**：WebView2 的瀏覽器行程指令列裡有答案——

```powershell
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
  ForEach-Object { [regex]::Match($_.CommandLine, '--user-data-dir=("[^"]+"|\S+)').Groups[1].Value }
```

### 2.3 修法：探測候選目錄，挑第一個**真的寫得進去**的

```go
// 依序探測候選，回傳第一個「真的寫得進去」的目錄。
// 全部失敗回空字串 —— 讓 Wails 用它自己的預設，**不要**硬塞一個不能寫的路徑進去
// （那只會把症狀換成另一個更難懂的錯誤）。
func WritableCandidate() (string, []string) {
    var tried []string
    for _, dir := range candidates() {
        tried = append(tried, dir)
        if ProbeWritable(dir) == nil {
            return dir, tried
        }
    }
    return "", tried
}

func candidates() []string {
    var out []string
    exe, err := os.Executable()
    if err != nil {
        return out
    }
    // ① Wails 的預設：%APPDATA%\<exe 檔名>
    out = append(out, filepath.Join(os.Getenv("AppData"), filepath.Base(exe)))
    // ② 漫遊設定被政策鎖住時的常見替代
    if dir, err := os.UserCacheDir(); err == nil {
        out = append(out, filepath.Join(dir, "myapp", "webview2"))
    }
    // ③ 保底：exe 旁邊（唯一在各種受限環境下都寫得進去的地方）
    out = append(out, filepath.Join(filepath.Dir(exe), "myapp.webview2"))
    return out
}

// ⚠ **不只要 MkdirAll**：目錄「已存在但不可寫」時 MkdirAll 會回 nil，
//    於是你会選到一個根本寫不進去的目錄——那正是這個 bug 的形狀。
//    所以實際寫一個檔案再刪掉。
func ProbeWritable(dir string) error {
    if err := os.MkdirAll(dir, 0o755); err != nil { return err }
    f := filepath.Join(dir, ".write-probe")
    if err := os.WriteFile(f, []byte("x"), 0o644); err != nil { return err }
    return os.Remove(f)
}
```

指定方式：`application.Options{ Windows: application.WindowsOptions{ WebviewUserDataPath: chosen } }`。

⚠ **第一個候選一定要是 Wails 的預設**，這樣正常機器上的行為完全不變；
保底用「exe 旁邊」是因為那是唯一在各種受限環境下都寫得進去的地方。

### 2.4 其他 WebView2 的實測結論

* ⚠ **`800700aa` 最常見的根因其實是「低完整性標籤」，不是 WebView2 本身** ✗——
  低完整性行程**不能往上寫** `%APPDATA%`（No-Write-Up），所以 UDF 建不出來。
  **先查 §5 的 `icacls`，再查 WebView2。** 實測：同一顆 exe 移到沒有標籤的資料夾之後，
  `★ 採用 APPDATA（Wails 預設）` 直接成功，**保底路徑根本不會被觸發**。
* **孤兒的 `msedgewebview2.exe` 會鎖住 UDF**——但它**不是** `800700aa` 的常見成因
  （清光之後照樣失敗，實測過）。
* **孤兒行程會繼承啟動者的 stdio 管線**：用「捕捉輸出」的方式啟動 App，
  主行程早就結束了，工具卻一直等（我吃過一次 **600 秒**逾時，而且**第二次又踩**）。
  **自動化時務必把 stdout／stderr 重導到檔案。**
  ⚠ 但反過來也要注意：**加上重導會讓 `Start-Process` 從 `ShellExecute` 變成 `CreateProcess`**
  ——那會**繞過 shell 的 SmartScreen 判定**。所以要「重現使用者雙擊時的行為」時，
  不能加重導，得改用 `Start-Process explorer.exe -ArgumentList '"<path>"'`
  （explorer 會立刻交棒，不會繼承你的 stdio 管線）。
* WebView2 的瀏覽器行程是**孫行程**；如果執行環境限制子行程的檔案寫入
  （沙箱、某些 EDR），UDF 就會建不出來，而症狀正是這一節。

---

## 3. GUI 程式沒有主控台：失敗要怎麼「講話」

`-H windowsgui` 的程式沒有有效的主控台代碼。**這一節的每一條我都是先踩到才寫下來的。**

### 3.1 ⚠ `io.MultiWriter(os.Stderr, f)` 會讓你的日誌檔一個 byte 都拿不到

`io.MultiWriter` 的語意是「**遇到第一個錯誤就返回**」。GUI 程式的 `os.Stderr` 是
**無效的控制代碼**，寫它會回錯誤 → **檔案永遠沒被寫到**。
症狀是「日誌檔存在但是空的」——而它會騙你以為「程式沒跑到」。

```go
// ✗ 錯的
log.SetOutput(io.MultiWriter(os.Stderr, f))

// ✓ 對的：檔案是權威、stderr 只是附加，而且忽略它的錯誤
type teeBestEffort struct{ main, extra io.Writer }
func (t teeBestEffort) Write(p []byte) (int, error) {
    n, err := t.main.Write(p)
    if t.extra != nil { _, _ = t.extra.Write(p) }   // 盡力而為
    return n, err
}
```

### 3.2 日誌檔要**每一行 Sync**，而且要放在「一定找得到」的地方

行程隨時可能被外力結束（當掉、被砍、使用者按叉），你要的正是「它死前寫到哪裡」。
只交給 OS 快取的話，最關鍵那幾行可能就沒了。

位置優先序：**exe 旁邊** → `%LOCALAPPDATA%\<app>\` → `%TEMP%`
（exe 放在唯讀目錄時才往後退）。

### 3.3 ⚠ Wails 在 WebView2 失敗時**自己 `os.Exit(1)`**

`v3.0.0-beta.30` 的原始碼寫得很明白：

```go
func (e *Chromium) errorCallback(err error) {
    e.globalErrorCallback(err)
    os.Exit(1)
}
```

所以：**`log.Fatal`／你自己的 fatal handler／`app.Run()` 的回傳值全都等不到。**
這是「閃退」的機械成因，也代表錯誤處理**不能依賴**這條路徑。

### 3.4 兩個能真正看到失敗的機制

**① 在輸出流裡攔致命特徵，而且必須「同步」彈對話框**

```go
var fatalHints = []string{"error creating controller with", "error calling Webview2Loader", "[WebView2 Error]"}

func (p *patternWatcher) Write(b []byte) (int, error) {
    n, err := p.w.Write(b)
    // ...累積最近輸出、比對 fatalHints...
    if hit != "" {
        p.once.Do(func() { p.onHint(lastLines(recent, 14)) })  // ⚠ 同步！
    }
    return n, err
}
```

⚠ **用 goroutine 會輸**：Wails 在 callback 之後立刻結束行程，goroutine 還沒被排到
就一起被殺了，對話框永遠不會出現（實測）。同步呼叫反而同時解決兩件事——對話框會出現，
而且**因為它阻塞了那個 callback，行程就不會走到結束那一步**。
代價是堆疊的後半段來不及寫進日誌（可接受）。

**② 「上一次的遺言」報告器**

啟動時先讀舊日誌：結尾沒有結束記號 → 上一次死在半路 → 用對話框把結尾幾行講出來。
它**不依賴任何失敗路徑**，所以就算行程是被外力直接砍掉也有效。
記得在正常結束時寫下記號（`=== 正常結束 ===`），否則每次啟動都會誤報。

### 3.5 MessageBox 的參數順序**是反的**

```go
// w32 的簽名是 func MessageBox(hwnd HWND, title, caption string, flags uint) int
// 但它內部呼叫的是 MessageBoxW(hwnd, lpText, lpCaption, flags)
// 所以：第一個字串＝內容、第二個＝標題列
w32.MessageBox(0, body, titleBar, 0x10|0x40000)  // MB_ICONERROR|MB_TOPMOST
```

### 3.6 給自動化一個靜音開關

對話框會**阻塞到有人按確定**——在無人看管的環境就是卡死。
留一個環境變數（例：`APP_NO_DIALOG=1`）跳過對話框，只留日誌。

**規則：GUI 程式的進入點裡不可以出現 `log.Fatal`／`os.Exit`。**

---

## 4. 大檔案怎麼交給前端（不要走 binding）

Wails3 的 binding 是**用數字 ID 呼叫**的，需要 codegen：

```js
import { Call } from "/wails/runtime.js";
Call.ByID(2952413357, name, birthday);   // ← 那個 ID 是產生的
```

而且 binding 走 **JSON 打包**：`[]byte` 會變成「一串數字」或 base64，大檔會膨脹好幾倍。

**要送大檔（幾 MB 的資料、字庫、模型）就當靜態資產送**——一個 HTTP GET：

```go
mux.HandleFunc("/lib.bin", serveLibrary)
mux.Handle("/", application.AssetFileServerFS(subFS))
```

```js
const bytes = new Uint8Array(await (await fetch("/lib.bin")).arrayBuffer());
```

實測數字（供參考）：內嵌 `.gz` 2.22 MB → 開檔解壓 29 ms → 前端一次 fetch 4.49 MB。
**「Go 先解好再送給 JS」反而更差**：要搬 3.8 倍大的資料，而且 JS 收到之後
還是得自己建幾十萬個物件（那才是解碼的主要成本）。

**兩個容易忘的細節**：

* **`Cache-Control: no-store`**：URL 固定但內容會隨重建改變時**不要**用
  `immutable`／`max-age`——被 WebView2 快取黏住的症狀是「改了檔案卻還是舊的」，
  而且怎麼重建都一樣。同一個行程讀記憶體的代價近乎零。
* **別忘了「前端到底跑起來了沒」**：叫前端在就緒時回報一聲
  （`fetch("/__ready", {method:"POST", body: ...})`），Go 寫進日誌。
  否則「視窗開起來但裡面是空的」和「前端掛了」在日誌上**長得一模一樣**。

---

## 5. 執行環境：**低完整性標籤**是兩個大坑的共同根因

**症狀（兩個，看起來無關，其實同源）**：

1. 寫入 `%APPDATA%`／`%LOCALAPPDATA%`／`%TEMP%` 全部 `Access is denied`，
   而 **exe 自己所在的目錄寫得進去** → 直接造成 §2 的 `800700aa`。
2. **同一份 exe，放在 A 資料夾會被 SmartScreen 擋，放在 B 資料夾完全正常**
   （見 §1.4）→ 而 `SmartScreenEnabled = RequireAdmin`（封鎖）時**不給「仍要執行」**。

**根因（實測）**：該資料夾被標成 **低完整性 ＋ No-Write-Up**，而且**繼承**：

```
> icacls "D:\some\workspace"
D:\some\workspace       Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
D:\some\workspace\sub   Mandatory Label\Low Mandatory Level:(I)(OI)(CI)(NW)
```

* `(OI)(CI)` ＝ **在裡面新建的每一個檔案／子資料夾都繼承低完整性**
  （複製進去也算「新建」）。
* `(NW)` ＝ **No-Write-Up：低完整性行程不能寫中完整性的位置** → `%APPDATA%` 被拒。
* **Windows 把低完整性的執行檔視為不受信任** → shell 啟動時跳 SmartScreen
  **「Windows 已保護您的電腦／無法辨識的應用程式」**，而且因為原則是封鎖，沒有「仍要執行」。

### 5.1 ★ 誰加的：**DSH 的 Windows 沙箱**（附出處）

不是病毒、不是 ACL 設錯、不是 Windows 的怪癖——是 DSH 沙箱**刻意**做的：

| 項目 | 內容 |
| --- | --- |
| 模組 | `@deepseek-ai/dsh-sandbox-windows-acl` |
| 位置 | `<DSH 安裝目錄>\resources\app\node_modules\@deepseek-ai\dsh-sandbox-windows-acl\` |
| 文件 | 同目錄的 `README.zh.md`（〈機制〉講標籤、〈已知限制與延期工作〉講它修不掉） |
| 關鍵函式 | `buildLowLabelAcl()`（在 `lib/types-*.js`） |
| 機制（README 原文） | 呼叫者權杖被降為 **Low 完整性**；授權時在**同一次 `SetNamedSecurityInfoW`** 裡向 world SID 拒絕 `FILE_DELETE_CHILD` **並把該目錄標成 Low** |
| 為什麼只有某幾個資料夾 | 標記**每台機器每個工作區只物化一次**（`workspaceWriteSid` 由規範路徑決定性派生），之後永久留著 |

**所以「新建的 `D:\2026` 沒事、舊的 `D:\2023\glyphwiki` 被標」的原因是**：
前者從來沒被這個沙箱供給過，後者是（或曾是）一個受限模式的會話工作區。

### 5.2 ★ 為什麼改不掉（DSH 自己承認的已知限制）

`README.zh.md` 的〈已知限制與延期工作〉第一條，原文：

> **诊断保留完整性标签**——它无法修复 **Low 标签的可执行文件影响用户在 DSH 外启动程序的问题**……

**它描述的症狀就是這一節的症狀**——所以這是**已知、未修**的問題，不是誰的環境壞了。
而且：

* **DSH 沒有提供清理方式**。同檔〈未來：警告與清理表面〉說「回收常駐 ACE 的**清理命令尚未決定**」。
* **手動改會被還原**：供給時是「精確 ACE／精確 deny／**精確標籤**才跳過」，
  所以你把標籤改成 Medium 之後，**下次 DSH 再把這個資料夾當沙箱工作區就會改回 Low**。
  而 `icacls /setintegritylevel` **需要管理員**（實測非管理員 `Access is denied`、exit 5）。
* ⚠ **改了反而可能弄壞工作區**：沙箱子行程是 Low，若工作區是 Medium 就**寫不進去**
  （No-Write-Up）→ 受限模式下完全不能寫。

### 5.3 為什麼這個坑特別貴：它會讓你往完全錯的方向查

| 觀察 | 錯誤的結論 | 真相 |
| --- | --- | --- |
| exe A 被擋、exe B 不被擋 | 「A 的 manifest／版本資源有問題」 | **是資料夾**——兩顆的 sha256 可以完全相同 |
| 補 manifest／版本資源／簽章 | 「補齊身分就好了」 | **完全無效**——複製進去就繼承低完整性，**簽章程式也一樣被擋** |
| `dir /r` 看不到 `Zone.Identifier` | 「所以不是標記問題」 | 標記**不是** MOTW，是**完整性標籤**，`dir /r` 看不到 |
| 換 `WebviewUserDataPath` 到 exe 旁邊 | 「找到解法了」 | 那只是**繞過症狀**——根因是低完整性，正常機器上根本不需要 |
| 用 shell 試寫 `%APPDATA%` 成功 | 「所以寫入沒問題」 | 見下面那條不對稱 |

### 5.4 怎麼查（一行就有答案）

```
icacls "<資料夾>"        # 看有沒有 Mandatory Label\Low Mandatory Level
icacls "<exe>"           # 看檔案本身繼承到什麼
```

⚠ PowerShell 的 `Get-Item -Stream *`／`Get-Content -Stream` **對目錄列不出東西**，
`Get-Acl` 也**不會**顯示完整性標籤——**要用 `icacls`**。
（要驗證「我的偵測方法真的看得到標記」，可以自己造一個：`Set-Content -LiteralPath <dir> -Stream Zone.Identifier -Value "..."`。）

### 5.5 怎麼解

1. **把 exe 產物放到沒有這個標籤的資料夾**（最省事、也最正確）✓
   ——**產物不必放在工作區裡**。實測：同一份位元組換到 `D:\app\` 之後，
   不但不被擋，`%APPDATA%` 也**直接可用**（保底路徑根本不會被觸發）。
   或把專案**複製**到新資料夾（複製取得**目的地**的標籤＝正常）。
2. 或用管理員 `icacls "<dir>" /setintegritylevel Medium`——⚠ 見 §5.2，
   **會被還原，而且可能讓該工作區在受限模式下不能寫**；動手前想清楚。
3. **不要靠程式碼繞**（把 UDF 指到 exe 旁邊之類）：那在正常機器上是多餘的，
   而且掩蓋了真正的問題。**當防禦可以，但別把它當成解法寫進文件。**

⚠ **「誰可以寫」不對稱**：同一個環境裡，**shell（`pwsh`／`cmd`）寫得進去，
但它啟動的 exe 寫不進去**是正常的——**因為那個 exe 檔案本身是低完整性**
（從低完整性資料夾來的），所以它的行程也是低完整性。
**不要用 shell 的測試結果推論 exe 的權限。**

---

## 6. Windows 工具鏈的編碼與路徑坑

### 6.1 `.ps1` 必須是 **UTF-8 含 BOM**（Windows PowerShell 5.1）

沒有 BOM 時它用 ANSI／GBK 讀腳本，**中文被拆壞之後連字串的結束引號都會斷**，
錯誤訊息長成：

```
The string is missing the terminator: ".
Missing closing '}' in statement block or type definition.
```

**這是與編碼無關的假線索**，會讓人往語法方向查半天。

⚠ **編輯工具通常不會保留 BOM** → 每次改完都可能壞。
（我自己的編輯工具就是這樣，寫好的檔案再改一次就沒 BOM 了。）

**修法：加一個純 ASCII 的 `.cmd` 入口，執行前檢查並補 BOM。**

```bat
@echo off
setlocal
set "PS1=%~dp0build.ps1"
powershell -NoProfile -Command "$p='%PS1%'; $b=[IO.File]::ReadAllBytes($p); if (-not ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)) { $t=[IO.File]::ReadAllText($p, (New-Object Text.UTF8Encoding($false))); [IO.File]::WriteAllText($p, $t, (New-Object Text.UTF8Encoding($true))); Write-Host 'added BOM' }"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
exit /b %ERRORLEVEL%
```

### 6.2 ⚠ `.cmd` 本身**必須是純 ASCII**

`cmd.exe` 也用 ANSI 讀 `.cmd`。我在 `rem` 註解裡放了中文，結果那幾行被拆壞，
**後面的字被當成指令執行**，噴出一串 `'xxx' is not recognized as an internal command`。

### 6.3 PowerShell 的輸出與 pattern 陷阱

* `Get-Content` 讀 UTF-8 中文檔會顯示成**亂碼**（那是主控台編碼，不是檔案壞掉）。
* **不要把中文當 pattern 傳給 PowerShell 指令**——中文常值可能在傳遞過程被弄壞，
  於是比對**靜默失敗**（我用 `-match '微信打開看不到'` 得到「沒有」，
  但那是假的；改用 ASCII 的 `class="wechat"` 就對了）。
  **驗收腳本裡請用 ASCII 的 pattern。**

### 6.4 檢查 Mark of the Web 用 `dir /r`，不要只信 `Get-Item -Stream *`

```
cmd /c dir /r "path\to\app.exe"
```

有 ADS 時它會在檔案下面多列一行 `:Zone.Identifier:$DATA`。

### 6.5 Go 的環境變數

| 症狀 | 修法 |
| --- | --- |
| `go build` → `open ...\go-build\...: Access is denied` | `$env:GOCACHE`／`$env:GOTMPDIR` 指到可寫目錄 |
| 有模組快取卻 `verifying module: Get "https://sum.golang.org/..."` 失敗 | `$env:GOSUMDB="off"`、`$env:GOFLAGS="-mod=mod"`（還沒有 `go.sum` 時） |
| 完全離線 | `$env:GOPROXY="off"` |
| `proxy.golang.org` 不通、但 GitHub 通 | **不要**把 `GOPROXY` 設成 `off`；留預設讓它走 `direct`（`go list -m -versions` 就是靠這條拿到版本清單的） |

### 6.6 目錄權限測試：`MkdirAll(dir, 0o555)` **不會**讓目錄變唯讀

Windows 的目錄權限來自**繼承的 ACL**，`os.MkdirAll` 的 mode 幾乎沒有作用。
我第一次寫的「不可寫目錄」測試**三條全部假通過**，改用 `icacls` 才驗到正確行為：

```powershell
icacls "<dir>" /deny "$env:USERNAME:(OI)(CI)(W)"
# 測完一定要拿掉，否則暫存目錄清不掉：
icacls "<dir>" /remove:d "$env:USERNAME"
```

---

## 7. 驗收：不開窗能驗什麼

Wails3 **沒有 headless 模式**，但「開窗」其實只是最後一哩。以下是**全部可以不開窗驗**的，
而且它們正好是最容易默默壞掉的地方：

| 驗什麼 | 怎麼驗 | 為什麼重要 |
| --- | --- | --- |
| 內嵌檔案伺服得出來 | `httptest` 打你的 handler：根路徑、目錄索引、404 | 嵌入路徑／`fs.Sub` 前綴寫錯的症狀都是「開起來一片空白」 |
| 大檔**逐 byte 正確** | 斷言長度 ＋ **sha256** | 「檔案不同步／傳輸截斷」不會報錯，只會讓下游靜默錯位 |
| 回應標頭 | `Content-Type`、`Content-Length`、`Cache-Control: no-store` | 快取與長度錯誤都是「偶爾才出現」的 bug |
| 前端**真的跑起來了** | 前端 POST `/__ready`，Go 寫進日誌 | 「空的畫面」與「前端掛了」否則無法區分 |
| 零外部相依 | 掃描內嵌檔案擋 CDN／外部 URL | 斷網或離線時才會壞 |
| 失敗**看得到** | 針對 diag 寫測試：日誌落地、對話框觸發、只觸發一次 | 錯誤處理本身也需要驗收 |

⚠ **掃描外部相依時名單要精準**：`http://www.w3.org/2000/svg` 這類 **XML 命名空間
識別字**不是連線，註解裡的世界網址也不是。第一版寫「一律擋 `http://`」會產生假警報。
建議擋：`https://`、CDN 主機名、`src="http`／`href="http`／`url(http`、`@import`。

**開發期間的自我提醒**：每次「用 shell 啟動」測試時，記得你的啟動條件可能和
使用者不同（§5）。**能重現使用者的啟動條件，才算真的驗過。**

---

## 8. 可抄的骨架

```
app/
  main.go                     殼：Options、路由表、視窗
  main_test.go                不開窗的驗收（httptest）
  build.cmd                   ASCII-only 入口（補 .ps1 的 BOM）
  build.ps1                   前端/資產 → syso → vet+test → go build
  internal/diag/              日誌檔 ＋ 對話框 ＋ pattern watcher ＋ 上次遺言
  internal/wvdata/            WebView2 user data folder 的探測
  internal/assets/            go:embed 的資產
  build/windows/{app.manifest,info.json,icon.ico}
```

`main.go` 的骨架（把 §2、§3 的重點都接起來）：

```go
func main() {
    s := diag.InitLog()                 // ① 日誌檔（每行 Sync）
    defer func() { if r := recover(); r != nil { diag.Fatal("panic: %v\n%s", r, debug.Stack()) } }()
    if s.PrevFailed { diag.Notify("上一次啟動失敗", s.PrevTail) }  // ④ 上次遺言
    if err := run(); err != nil { diag.Fatal("%v", err) }
    diag.Finish()                       // 寫下結束記號
}

func run() error {
    path, tried := wvdata.Resolve(exeName())   // ② 挑一個寫得進去的 UDF
    for _, c := range tried { log.Printf("UDF 候選 %v", c) }

    app := application.New(application.Options{
        Name:    "MyApp",
        Assets:  application.AssetOptions{Handler: handler},
        Windows: application.WindowsOptions{WebviewUserDataPath: path},
        Logger:  slog.New(slog.NewTextHandler(diag.Writer(), nil)),  // ③ Wails 的訊息也進日誌
    })
    // ... 視窗 ...
    return app.Run()
}
```

---

## 9. 出貨前的檢查清單

- [ ] PE subsystem = **2**（GUI），不是 3
- [ ] **產物所在的資料夾沒有 `Low Mandatory Level` 標籤**（`icacls` 看）——否則會被 SmartScreen 擋、`%APPDATA%` 也會被拒
- [ ] **視窗大小已夾進主螢幕工作區**，而且用 `GetWindowRect` 驗過 `top ≥ 0`
- [ ] `.syso` 有產生，`info.json` 用的是**真 LANGID**（`0409`）
- [ ] `go vet` ＋ `go test` 全綠，**而且測試涵蓋不開窗的部分**
- [ ] 大檔走**靜態資產**，帶 `Cache-Control: no-store`，並且**逐 byte 驗過 sha256**
- [ ] 前端會 `POST /__ready`（或等價的就緒回報）
- [ ] 失敗時有**日誌檔 ＋ 對話框**，而且 `log.Fatal`／`os.Exit` 不在 GUI 進入點
- [ ] WebView2 的 UDF 是**探測後指定**的，不是靠預設值碰運氣
- [ ] `.ps1` 有 BOM；`.cmd` 純 ASCII
- [ ] **在與使用者相同的啟動方式下跑過一次**（雙擊／一般終端機，不是只有 agent）

---

*本檔的來源是 `pinxing-app/`（Wails3 版的拼形檢視器）與 `gocore/` 的實作過程；
逐條的完整上下文見 [`pinxing-app/README.md`](pinxing-app/README.md)。*
