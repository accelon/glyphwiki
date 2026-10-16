# build.ps1 — 建置 pinxing-app（**正式產物**的那一條路）。
#
# 每一步都有理由，而且都是踩過的：
#
#   ① 字庫複製進來
#      `go:embed` **只能嵌模組目錄內的檔案**，而字庫產物在 out/（模組外）。
#      複本不入版控，所以字庫重建之後要重跑這一步。
#
#   ② Go 環境（沙箱與離線）
#      * GOCACHE／GOTMPDIR 必須在**工作區內**——DSH 沙箱只允許子行程寫工作區，
#        而 Go 預設的 GOCACHE 在 %LOCALAPPDATA%，會直接 Access denied。
#      * 第一次（還沒有 go.sum）要 GOPROXY=off／GOSUMDB=off：模組快取裡已經有
#        wails v3.0.0-beta.3，但沒有 go.sum 時 Go 會想去 sum.golang.org 驗章 →
#        沙箱下連不出去。
#
#   ③ 圖示與 .syso
#      Windows 的 exe 要「有身分」需要三樣東西，而**這三樣都在 .syso 裡**：
#        * 應用程式資訊清單（app.manifest）——DPI 感知、Common Controls v6、
#          requestedExecutionLevel。**沒有它的未簽章 Go 執行檔是防毒啟發式的目標**。
#        * 版本資源（info.json）——公司／產品／描述。
#        * 圖示（icon.ico）。
#      這一步用 Wails 官方的 `wails3 generate syso`，參數與 Wails 範本的 Taskfile 相同。
#
#   ④ 編譯
#      **必須**用 Wails 官方那組參數：`-tags production -trimpath -buildvcs=false
#      -ldflags="-w -s -H windowsgui"`。
#      其中 `-H windowsgui` 最關鍵：沒有它，產物是 **console 子系統**——
#      雙擊時會先閃一個主控台視窗，失敗時使用者只看到「閃退」而讀不到訊息
#      （見 internal/diag 的說明）。
#
# 用法:
#   .\pinxing-app\build.ps1                 # 建置
#   .\pinxing-app\build.ps1 -Test           # 建置前先跑 vet ＋ test
#   .\pinxing-app\build.ps1 -Dev            # 開發建置（不帶 production tag → 開 DevTools）
#   .\pinxing-app\build.ps1 -Run            # 建置完執行（**不要**在 DSH 沙箱裡用，見下）
#
# ⚠ 執行在 DSH 沙箱下會失敗：
#     [WebView2 Error] error creating controller with 800700aa
#   沙箱封鎖具名管道，而 WebView2 的 host ↔ renderer IPC 全靠它。
#   失敗訊息會寫進 pinxing-app.log 並彈出對話框（見 internal/diag）。
#   要開視窗請在**一般終端機**執行 exe。

[CmdletBinding()]
param(
    [switch]$Test,
    [switch]$Run,
    [switch]$Dev,
    [string]$Out = "pinxing-app.exe"
)

$ErrorActionPreference = "Stop"
$AppDir = $PSScriptRoot
$RepoRoot = Split-Path $AppDir -Parent
Set-Location $AppDir

# ---------------------------------------------------------------- ⓪ 前端
#
# 前端**不是手寫的**：它由 `tools/build-pinxing.ts --hosted` 產生，
# 用**同一份** `tools/pinxing-page.js` 與同一組內嵌模組（kage-engine、lib-format、
# compose-fit…）——差別只有「字庫從哪裡來」那一行（`loadLibBytes()` 走 `/lib.bin`）。
#
# ⚠ **不要**自己手寫一份 `frontend/index.html` ✗：那會變成兩份各說各話的頁面，
#   而這個專案已經吃過那個虧（見 `tools/embed-common.ts` 的檔頭）。
#   要改前端就改 `tools/pinxing-page.js`，它同時服務離線單頁與這一頁。
Write-Host "⓪ 前端   產生 frontend/index.html（宿主模式）"
Push-Location $RepoRoot
try {
    bun run tools/build-pinxing.ts --hosted
    if ($LASTEXITCODE -ne 0) { throw "產生前端失敗（exit $LASTEXITCODE）" }
} finally {
    Pop-Location
}

# ---------------------------------------------------------------- ① 字庫
$src = Join-Path $RepoRoot "out/lib-cjk-all.bin.gz"
$dstDir = Join-Path $AppDir "internal/glyphdata"
$dst = Join-Path $dstDir "lib-cjk-all.bin.gz"
if (-not (Test-Path $src)) {
    throw "找不到字庫 $src —— 先跑：bun run tools/build-library.ts"
}
New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
Copy-Item $src $dst -Force
Write-Host ("① 字庫   {0:N0} bytes → internal/glyphdata/" -f (Get-Item $dst).Length)

# ---------------------------------------------------------------- ② Go 環境
$env:GOCACHE = Join-Path $AppDir ".cache/go-build"
$env:GOTMPDIR = Join-Path $AppDir ".cache/tmp"
New-Item -ItemType Directory -Force -Path $env:GOCACHE, $env:GOTMPDIR | Out-Null
if (-not (Test-Path (Join-Path $AppDir "go.sum"))) {
    $env:GOPROXY = "off"
    $env:GOSUMDB = "off"
    $env:GOFLAGS = "-mod=mod"
    Write-Host "② Go     以離線模式解析相依（go.sum 不存在）"
} else {
    Write-Host "② Go     環境就緒"
}

# ---------------------------------------------------------------- ③ 圖示與 syso
$png = "build/appicon.png"
$ico = "build/windows/icon.ico"
if (-not (Test-Path $png)) {
    Write-Host "③ 圖示   產生 build/appicon.png"
    go run build/make-icon.go
}
if (-not (Test-Path $ico) -or (Get-Item $png).LastWriteTime -gt (Get-Item $ico).LastWriteTime) {
    Write-Host "③ 圖示   產生 build/windows/icon.ico"
    New-Item -ItemType Directory -Force -Path ".cache/mac" | Out-Null
    # macOS 的產物丟進 .cache（本 App 只出 Windows；不丟的話它會因為找不到
    # build/darwin/ 而以非零離開碼結束）
    wails3 generate icons -input $png -windowsfilename $ico `
        -macassetdir .cache/mac -macfilename .cache/mac/icon.icns | Out-Null
}
$syso = "wails_windows_amd64.syso"
Write-Host "③ syso   產生 $syso（manifest ＋ 版本資源 ＋ 圖示）"
wails3 generate syso -arch amd64 -icon $ico `
    -manifest build/windows/app.manifest -info build/windows/info.json -out $syso | Out-Null

# ---------------------------------------------------------------- ④ vet / test
if ($Test) {
    Write-Host "`n=== go vet ===" -ForegroundColor Cyan
    go vet ./...
    Write-Host "`n=== go test ===" -ForegroundColor Cyan
    go test ./...
}

# ---------------------------------------------------------------- ⑤ 編譯
if ($Dev) {
    $buildArgs = @("-buildvcs=false", "-gcflags=all=-l", "-o", $Out, ".")
    $tagNote = "開發（DevTools 開）"
} else {
    $buildArgs = @("-tags", "production", "-trimpath", "-buildvcs=false",
                   "-ldflags=-w -s -H windowsgui", "-o", $Out, ".")
    $tagNote = "正式（production、GUI 子系統）"
}
Write-Host "`n④ 編譯   $tagNote" -ForegroundColor Cyan
& go build @buildArgs
if ($LASTEXITCODE -ne 0) { throw "go build 失敗（exit $LASTEXITCODE）" }

# ⚠ `-Out` 可以是**絕對路徑**：直接用 Join-Path 會在絕對路徑前面再接一次 $AppDir，
#    變成 `...\pinxing-app\D:\...`（go build 其實寫對了，但下面讀檔會找不到）。
$exe = if ([IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $AppDir $Out }
Write-Host ("`n完成   {0}   {1:N2} MB" -f $Out, ((Get-Item $exe).Length / 1MB)) -ForegroundColor Green
Write-Host "       預設**不寫**日誌檔（雙擊）；要記錄請從命令列加參數：<exe> --log"

# ---------------------------------------------------------------- ⑥ 完整性標籤檢查
#
# ★ 這一段是為了一個查了很久的坑加的（見 ../wails3-notice.md §1.4／§5）：
#
#   如果產物所在的資料夾帶「低完整性」標籤（Low Mandatory Level:(NW)），
#   那麼**在裡面新建的檔案會繼承它**，而 Windows 把低完整性的執行檔當成不受信任 →
#     ① 從檔案總管雙擊會跳 SmartScreen「無法辨識的應用程式」，
#        而且 SmartScreenEnabled=RequireAdmin（封鎖）時**沒有「仍要執行」**；
#     ② 行程也是低完整性 → **不能往上寫** %APPDATA%，WebView2 的 UDF 建不出來
#        → `error creating controller with 800700aa`。
#
#   ⚠ 這與 exe 的內容**完全無關**：同一份 sha256 換到沒有標籤的資料夾就一切正常。
#     所以「補 manifest／版本資源／簽章」對它一點用都沒有 ✗。
#
#   加這一段的理由：這個坑會讓人往完全錯誤的方向查好幾個小時，
#   而一行 icacls 就有答案——那就讓建置自己講出來。
$label = (icacls $exe 2>&1 | Select-String 'Mandatory Label')
if ($label -and $label.Line -match 'Low Mandatory Level') {
    Write-Host "`n⚠⚠⚠  產物帶有低完整性標籤，這會造成兩個很難查的症狀  ⚠⚠⚠" -ForegroundColor Red
    Write-Host "     $($label.Line.Trim())" -ForegroundColor Red
    Write-Host "     ① 檔案總管雙擊 → SmartScreen「無法辨識的應用程式」（封鎖時無「仍要執行」）" -ForegroundColor Red
    Write-Host "     ② %APPDATA% 全部 Access is denied → WebView2 UDF 失敗（800700aa）" -ForegroundColor Red
    Write-Host "     修法：把產物移到沒有這個標籤的資料夾，例如" -ForegroundColor Yellow
    Write-Host "           .\build.cmd -Out D:\pinxing-app\pinxing-app.exe" -ForegroundColor Yellow
    Write-Host "     （與 exe 內容無關；補 manifest／簽章都沒用）" -ForegroundColor DarkGray
    Write-Host ""
}

if ($Run) {
    Write-Host "`n啟動…" -ForegroundColor Yellow
    & $exe
}
