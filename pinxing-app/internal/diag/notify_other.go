//go:build !windows

package diag

// notifyFatal 在非 Windows 平台沒有對話框可用，只能靠日誌與 stderr。
// （本 App 目前以 Windows 為目標；留這一支是為了讓套件在別的平台也能編。）
func notifyFatal(msg, logPath string) {}

// notify 同上：非 Windows 沒有對話框。
func notify(title, body string) {}
