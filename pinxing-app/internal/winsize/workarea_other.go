//go:build !windows

package winsize

// WorkArea 在非 Windows 平台回 (0, 0)＝「不知道」。
// 那會讓 `Fit` 原樣回傳想要的大小（不夾）——**不會比原本的行為差**，
// 而這也比亂猜一個工作區大小安全。
//
// 要讓其他平台也正確，就在這裡補上該平台的實作（macOS 用 NSScreen.visibleFrame、
// Linux 用 GDK 的 workarea），`Fit`／`FitIn` 不必動。
func WorkArea() (int, int) { return 0, 0 }
