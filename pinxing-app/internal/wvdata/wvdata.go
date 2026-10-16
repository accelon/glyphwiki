// Package wvdata 決定 **WebView2 的 user data folder** 要用哪一個。
//
// # 為什麼需要這一支
//
// Wails 的預設是 `%APPDATA%\<exe 名>`（見 wails 的
// `internal/webview2/pkg/edge/chromium.go`：`dataPath == ""` 時就自己算這個）。
// 那個目錄在建不起來的環境裡會出現一個**非常難查**的症狀：
//
//	[WebView2] Environment created successfully
//	[WebView2 Error] error creating controller with 800700aa: The requested resource is in use.
//
// 也就是說：**環境回報建立成功，但 user data folder 從來沒被建立**，
// 接著 `CreateCoreWebView2Controller` 以 `ERROR_BUSY` 失敗——錯誤訊息完全指不到真因。
// 實測於本專案：由 DSH 環境啟動的行程寫入被限制在工作區內，`%APPDATA%` 回
// `Access is denied`；而那**不是** ACL 問題（該目錄的 ACL 對本使用者是 FullControl、
// 沒有 DENY），是執行環境的限制。
//
// 所以這一支的職責是：**依序探測候選目錄，回傳第一個確定寫得進去的**。
// 第一個候選刻意就是 Wails 的預設——正常機器上的行為完全不變。
package wvdata

import (
	"fmt"
	"os"
	"path/filepath"
)

// Candidate 是一個候選目錄與它的探測結果。
type Candidate struct {
	Label string
	Path  string
	// Err 是這個候選的探測失敗原因（nil ＝ 可用）。
	Err error
	// Used 表示這個候選被選中了。
	Used bool
}

// Default 是 Wails 自己的預設位置：`%APPDATA%\<exe 名>`。
func Default(exeName string) string {
	appdata := os.Getenv("AppData")
	if appdata == "" {
		return ""
	}
	return filepath.Join(appdata, exeName)
}

// Option 是一個候選（標籤 ＋ 路徑）。
type Option struct {
	Label string
	Path  string
}

// Candidates 依序回傳要嘗試的候選。**順序有意義**：
//
//  1. `%APPDATA%\<exe 名>` —— Wails 的預設。正常機器上就停在這裡，行為不變。
//  2. `%LOCALAPPDATA%\pinxing-app\webview2` —— 漫遊設定被政策鎖住時的常見替代。
//  3. **exe 旁邊** `<exe 目錄>\pinxing-app.webview2` —— 最後的保底。
//     選它當保底是因為「程式自己所在的目錄」是唯一在各種受限環境下都寫得進去的地方
//     （本專案實測：連沙箱裡都寫得進去）。
func Candidates(exeName string) []Option {
	var out []Option
	add := func(label, p string) {
		if p != "" {
			out = append(out, Option{Label: label, Path: p})
		}
	}
	add("APPDATA（Wails 預設）", Default(exeName))
	if dir, err := os.UserCacheDir(); err == nil {
		add("LOCALAPPDATA", filepath.Join(dir, "pinxing-app", "webview2"))
	}
	if exe, err := os.Executable(); err == nil {
		add("exe 旁邊（保底）", filepath.Join(filepath.Dir(exe), "pinxing-app.webview2"))
	}
	return out
}

// Resolve 依序探測 `Candidates(exeName)`，回傳第一個可用的目錄，
// 以及每一個候選的探測結果（給日誌用）。
//
// 全部失敗時回傳空字串——**那時讓 Wails 用它自己的預設**，不要硬塞一個路徑進去
// （塞一個不能寫的路徑只會把症狀換成另一個更難懂的錯誤）。
func Resolve(exeName string) (string, []Candidate) {
	return ResolveFrom(Candidates(exeName))
}

// ResolveFrom 是 Resolve 的可注入版本（測試用）。
func ResolveFrom(opts []Option) (string, []Candidate) {
	tried := make([]Candidate, 0, len(opts))
	for _, o := range opts {
		err := ProbeWritable(o.Path)
		tried = append(tried, Candidate{Label: o.Label, Path: o.Path, Err: err, Used: err == nil})
		if err == nil {
			return o.Path, tried
		}
	}
	return "", tried
}

// ProbeWritable 建立目錄（已存在就沿用）並**實際寫一個檔案再刪掉**。
//
// 為什麼不只看 `MkdirAll` 有沒有回錯：目錄**已存在但不可寫**時 `MkdirAll`
// 會回 nil，於是我們會選到一個根本寫不進去的目錄——那正是這個 bug 的形狀。
func ProbeWritable(dir string) error {
	if dir == "" {
		return fmt.Errorf("路徑是空的")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f := filepath.Join(dir, ".write-probe")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		return fmt.Errorf("目錄建得起來、但寫不進去：%w", err)
	}
	if err := os.Remove(f); err != nil {
		return fmt.Errorf("寫進去了、但刪不掉：%w", err)
	}
	return nil
}
