//go:build windows

package diag

import (
	"os"

	"github.com/wailsapp/wails/v3/pkg/w32"
)

// Win32 MessageBox 的旗標
const (
	mbOK            = 0x00000000
	mbIconError     = 0x00000010
	mbIconWarning   = 0x00000030
	mbSetForeground = 0x00010000
	mbTopMost       = 0x00040000
)

// notify 是**非致命**的對話框（資訊用，例如「上一次啟動失敗」的遺言）。
func notify(title, body string) {
	if os.Getenv("PINXING_NO_DIALOG") != "" {
		return
	}
	w32.MessageBox(0, body, title, mbOK|mbIconWarning|mbSetForeground|mbTopMost)
}

// notifyFatal 用 MessageBox 把失敗講出來。
//
// ⚠ `w32.MessageBox(hwnd, title, caption, flags)` 的參數命名**是反的**：
// 它內部呼叫的是 `MessageBoxW(hwnd, lpText, lpCaption, flags)`，
// 所以第一個字串（名叫 `title`）其實是**內容**，第二個（`caption`）才是**標題列**。
// 這裡照實際語意傳，並用註解把這個坑標住。
//
// `PINXING_NO_DIALOG=1` 會跳過對話框（只留下日誌）——給自動化與 CI 用：
// 對話框會**阻塞到有人按確定**，那在無人看管的環境裡就是卡死。
func notifyFatal(msg, logPath string) {
	if os.Getenv("PINXING_NO_DIALOG") != "" {
		return
	}
	body := msg
	switch {
	case logPath != "":
		body += "\n\n日誌檔（含完整堆疊）：\n" + logPath
	case logRequested:
		// 有要求寫、卻沒有路徑 → 是「寫不進去」，不是「這次不寫」。
		body += "\n\n（日誌檔寫不進去：所有候選路徑都失敗）"
	default:
		// **預設模式**（雙擊）：沒有日誌是預期的，講清楚怎麼拿到記錄。
		body += "\n\n這次沒有寫日誌檔。要完整記錄，請從命令列加參數重跑：\n" +
			"    pinxing-app.exe --log"
	}
	const title = "剎那拼形 — 啟動失敗"
	w32.MessageBox(0, body, title, mbOK|mbIconError|mbSetForeground|mbTopMost)
}
