// pinxing-app — **拼形檢視器的 Wails3 版**：單一 exe、零外部相依、開檔即用。
//
// 這一支是 `gocore` 的**測試床**（見 `gocore/README.md`）：其他 Wails3 軟件要的是
// 可重用的 Go 組字能力，而這裡負責證明那件事在真實的 Wails3 殼裡跑得起來。
//
// # 字庫怎麼進到 JS
//
// 走「**一次性灌輸**」，不走 binding 的逐次呼叫：
//
//	exe 內嵌 lib-cjk-all.bin.gz（2,327,989 bytes）
//	  → 開檔時 Go 解壓（約 29 ms）成 4,703,188 bytes（見 internal/glyphdata）
//	  → 掛在 `/lib.bin`，前端一次 fetch 拿完
//	  → 前端用它**現有的** decodeLibrary() 解開（約 200 ms）
//
// 為什麼不走 binding：Wails3 的 binding 走 JSON 打包，`[]byte` 會變成
// 「一串數字」或 base64——4.49 MB 的位元組會膨脹好幾倍，而且還要 codegen 產生
// 帶數字 ID 的 wrapper（`Call.ByID(2952413357, …)`）。當靜態資產送就只是
// **一個 HTTP GET**，前端程式碼一行都不用改。量測見 `gocore/cmd/libstats`。
//
// # ⚠ 這個程式**沒有主控台**——所以失敗一律走 internal/diag
//
// 本 App 以 `-H windowsgui` 建置（GUI 子系統）。所以「印到 stderr 然後結束」
// 對使用者而言就是**一閃就沒了**：沒有訊息、事件記錄裡也沒有（正常 `os.Exit`
// 不會留 Application Error）。
//
// 實際踩過：WebView2 建立 controller 失敗時 `app.Run()` 回錯誤，`log.Fatal`
// 印出一大段堆疊後結束，而使用者只看到「閃退」——那一段堆疊裡有全部答案。
//
// **規則：這個檔案裡不可以出現 `log.Fatal`／`os.Exit`。** 全部走 `diag.Fatal`，
// 它會寫日誌檔 ＋ 彈對話框。啟動的每一個里程碑也要 `log.Printf`，
// 這樣日誌會告訴我們「跑到哪一步才失敗」。
package main

import (
	"embed"
	"fmt"
	"io"
	"io/fs"
	"log"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"

	"pinxing-app/internal/diag"
	"pinxing-app/internal/glyphdata"
	"pinxing-app/internal/winsize"
	"pinxing-app/internal/wvdata"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// frontend 是**產生出來的**（`bun run tools/build-pinxing.ts --hosted`，
// 由 build.ps1 在編譯前跑）。它不在版控裡——頁面程式碼的唯一來源是
// `tools/pinxing-page.js` 與其內嵌模組，這樣才不會出現兩份各說各話的頁面。
//
// ⚠ 直接 `go build` 而沒有先產生前端時，這一行會編譯失敗說找不到嵌入檔——
// 那是**想要**的失敗方式（比開起來一片空白好）。用 `build.ps1` 就不會遇到。
//
//go:embed frontend
var assets embed.FS

// routes 組出整個 HTTP 路由表。
//
// 抽成一支是為了**可以在沙箱裡驗收**：`main_test.go` 拿同一份路由表跑 httptest，
// 就能斷言「前端伺服得出來」「字庫一個 byte 都不差」，不必開 WebView2。
func routes() (http.Handler, error) {
	sub, err := fs.Sub(assets, "frontend")
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	// 精確路徑優先於 "/"，所以這兩個不會被 asset server 接走
	mux.HandleFunc("/lib.bin", serveLibrary)
	mux.HandleFunc("/__ready", serveReady)
	mux.Handle("/", application.AssetFileServerFS(sub))
	return mux, nil
}

// serveLibrary 把解壓後的字庫（4,703,188 bytes）整包送出去。
//
// 刻意**不做** Range／分塊：前端要的就是完整一份。
//
// ⚠ `Cache-Control: no-store` 是刻意的，不要改成 `immutable` ✗：
// 這個 URL 在建置之間**不變**，但字庫會換（重建 `out/lib-cjk-all.bin` 之後）——
// 一旦被 WebView2 的快取黏住，症狀是「改了字庫卻還是舊的字形」，
// 而且怎麼重建都一樣，非常難查。這裡不快取的代價只是**讀一次記憶體**
// （同一個行程、沒有磁碟、沒有網路），完全划得來。
func serveLibrary(w http.ResponseWriter, r *http.Request) {
	b := glyphdata.Bin()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(b)))
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodHead {
		return
	}
	if _, err := w.Write(b); err != nil {
		log.Printf("送出字庫時中斷：%v", err)
	}
}

// serveReady 是**前端回報「字庫解開了、UI render 完了」**的端點。
//
// 誰會打過來：宿主模式的前導 script（見 `tools/build-pinxing.ts` 的 `HOSTED_PRELUDE`）——
// 它在 `window.__READY__` 出現之後 POST 一次。
//
// 為什麼要有它：Wails 的日誌只看得到「資產被要走了」（`[AssetFileServerFS] Handling request`），
// **看不到前端到底解開了沒有** ✗。有了這一聲回報，驗收就不必看畫面：
// 日誌上少了「[頁面] 已就緒」就代表前端掛了——那比「視窗開起來了但裡面是空的」
// 好查太多（這兩者的日誌在之前**長得一模一樣**）。
func serveReady(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(io.LimitReader(r.Body, 4096))
	log.Printf("[頁面] 已就緒：%s", strings.TrimSpace(string(body)))
	w.WriteHeader(http.StatusNoContent)
}

// winOptions 回傳 Windows 專屬選項，**包含選好的 WebView2 user data folder**。
//
// # 為什麼要自己挑 user data folder
//
// Wails 的預設是 `%APPDATA%\<exe 名>`。那個目錄建不起來的環境會給出一個
// 指不到真因的症狀（見 internal/wvdata 的檔頭）：
//
//	[WebView2] Environment created successfully
//	[WebView2 Error] error creating controller with 800700aa
//
// 所以啟動時**先探測**，挑第一個真的寫得進去的目錄。第一個候選就是 Wails 的預設，
// 所以正常機器上的行為完全不變。
//
// `PINXING_WEBVIEW_DATA` 仍然可以強制指定（測試／多份設定檔用）。
func winOptions() application.WindowsOptions {
	var o application.WindowsOptions
	if p := os.Getenv("PINXING_WEBVIEW_DATA"); p != "" {
		o.WebviewUserDataPath = p
		log.Printf("WebView2 user data folder：%s（由 PINXING_WEBVIEW_DATA 指定）", p)
		return o
	}

	chosen, tried := wvdata.Resolve(exeName())
	for _, c := range tried {
		mark := "✗"
		detail := ""
		if c.Err != nil {
			detail = "：" + c.Err.Error()
		}
		if c.Used {
			mark = "★ 採用"
		}
		log.Printf("  user data folder 候選 %-4s %-22s %s%s", mark, c.Label, c.Path, detail)
	}
	o.WebviewUserDataPath = chosen // 空字串 ＝ 全部失敗，讓 Wails 用它的預設
	return o
}

// exeName 是 Wails 用來算預設 user data folder 的名字（exe 的檔名）。
func exeName() string {
	exe, err := os.Executable()
	if err != nil {
		return "pinxing-app.exe"
	}
	return filepath.Base(exe)
}

// shouldLog 回報這次啟動**要不要寫日誌檔**，由 `os.Args` 決定。
//
// **只有命令列帶參數才寫**：雙擊（`os.Args` 只有 exe 路徑）＝ 使用者只是想用這個程式，
// 不該在他旁邊留下 `pinxing-app.log`。**任何參數都算**（`--log` 只是最好記的那個；
// 目前沒有其他參數，所以不必解析）。
func shouldLog(args []string) bool { return len(args) > 1 }

func main() {
	// 雙擊不寫日誌（見 shouldLog）。要診斷就從終端機跑 `pinxing-app.exe --log`。
	//
	// ⚠ 不寫日誌**不會**少掉失敗對話框：`InitLog` 在關閉時仍然裝致命特徵的攔截器
	//   （見 internal/diag 的說明），那是 GUI 程式唯一的失敗出口。
	logging := shouldLog(os.Args)
	s := diag.InitLog(logging)

	log.Printf("=== 剎那拼形 啟動 ===")
	switch {
	case s.Path != "":
		log.Printf("日誌檔：%s", s.Path)
	case logging:
		log.Printf("警告：無法寫入日誌檔，失敗時只能靠對話框")
	default:
		log.Printf("沒有寫日誌檔（雙擊啟動的預設行為；要記錄請加參數 --log）")
	}

	// 上一次沒有正常結束嗎？→ 把它當場講出來。
	//
	// 為什麼需要這一招：**失敗不一定會經過我們的程式碼**。實測 WebView2
	// controller 建不起來時，Wails 會在 `app.Run()` 返回之前就結束行程
	// （日誌裡看不到「app.Run() 已返回」也看不到「致命錯誤」），
	// 所以 `diag.Fatal` 的對話框根本沒機會出現——使用者只看到閃退。
	// 「下一次啟動時報告上一次的遺言」是唯一不依賴失敗路徑的辦法。
	if s.PrevFailed {
		log.Printf("上一次啟動沒有正常結束；結尾如下：\n%s", s.PrevTail)
		body := "上一次啟動沒有正常結束（沒有寫下結束記號）。\n\n結尾幾行：\n" + s.PrevTail
		if s.Path != "" {
			body += "\n\n完整日誌：\n" + s.Path
		}
		diag.Notify("剎那拼形 — 上一次啟動失敗", body)
	}

	// panic 也要變成「看得到的失敗」，不可以只留一段沒人看見的堆疊。
	defer func() {
		if r := recover(); r != nil {
			diag.Fatal("啟動時發生 panic：%v\n\n%s", r, debug.Stack())
		}
	}()

	if err := run(); err != nil {
		diag.Fatal("%v", err)
	}
	diag.Finish()
}

// run 是真正的進入點；**所有失敗都用回傳 error 表達**，不在這裡結束行程。
func run() error {
	n, err := glyphdata.Load()
	if err != nil {
		return fmt.Errorf("字庫載入失敗：%w", err)
	}
	log.Printf("字庫已載入：%d bytes（內嵌 %d bytes，sha256 %s）",
		n, glyphdata.PackedSize(), glyphdata.SHA256Hex())

	handler, err := routes()
	if err != nil {
		return fmt.Errorf("建立路由表失敗：%w", err)
	}
	log.Printf("路由表就緒（/、/lib.bin）")

	// Wails 自己的訊息（含 WebView2 的錯誤）也寫進同一個日誌檔——
	// 否則 GUI 模式下它們會跟著 stderr 一起消失。
	logger := slog.New(slog.NewTextHandler(diag.Writer(), &slog.HandlerOptions{Level: slog.LevelInfo}))

	app := application.New(application.Options{
		Name:        "剎那拼形",
		Description: "拼形檢視器（Go／Wails3 版）——以字形庫為基礎的部件拼接",
		Assets: application.AssetOptions{
			Handler: handler,
		},
		Windows:  winOptions(),
		Logger:   logger,
		LogLevel: slog.LevelInfo,
	})
	log.Printf("Wails 應用已建立")

	// 視窗大小要**夾進主螢幕的工作區**（見 internal/winsize 的檔頭——
	// 硬寫 900 高在一台邏輯工作區只有 693 的機器上，標題列會跑到畫面外）。
	winW, winH := winsize.Fit(480, 900)
	if aw, ah := winsize.WorkArea(); aw > 0 {
		log.Printf("主螢幕工作區 %d×%d → 視窗 %d×%d", aw, ah, winW, winH)
	} else {
		log.Printf("量不到主螢幕工作區 → 視窗原樣 %d×%d（沒有夾）", winW, winH)
	}

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: "剎那拼形 — Go 版",
		URL:   "/",
		// ⚠ **一定要夾進工作區**（見 internal/winsize）：
		// 手機豎版的 480×900 在高 DPI 的筆電上比工作區還高，
		// Wails 置中之後頂端會變成負的 → **標題列整個在畫面之上**。
		Width:           winW,
		Height:          winH,
		MinWidth:        320,
		MinHeight:       400,
		DevToolsEnabled: devTools,
	})
	log.Printf("視窗已建立（%d×%d），進入事件迴圈", winW, winH)

	if err := app.Run(); err != nil {
		// ⚠ 這一行就是「閃退」的來源：WebView2 起不來時錯誤會從這裡出來，
		//    而它裡面有完整的堆疊與 HRESULT。diag.Fatal 會把它寫進日誌檔
		//    並彈出對話框。
		log.Printf("app.Run() 已返回，錯誤：%v", err)
		return fmt.Errorf("Wails 事件迴圈結束時回報錯誤：%w", err)
	}
	log.Printf("app.Run() 已返回，沒有錯誤")
	return nil
}
