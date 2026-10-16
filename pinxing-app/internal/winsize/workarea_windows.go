//go:build windows

package winsize

import (
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/w32"
)

// GetDeviceCaps 的索引（wingdi.h 的 LOGPIXELSX）
const logPixelsX = 88

// WorkArea 回傳主螢幕**工作區**的邏輯像素大小（扣掉工作列）。
// 拿不到時回 (0, 0)——呼叫端要能把 0 當成「不知道」，不要當成「很小」。
//
// # 單位：為什麼要自己除以縮放
//
// 實測（per-monitor-v2 的行程，面板 3120 × 2080、300% 縮放）：
//
//	GetSystemMetrics / GetMonitorInfo(RcWork) → **實體**像素（3120 × 2080）
//	GetDeviceCaps(LOGPIXELSX)                 → 288（縮放 3.0）
//	除以縮放                                   → 1040 × 693 ✓ 與系統回報的邏輯工作區一致
//
// ⚠ `GetSystemMetricsForDpi(SM_CYSCREEN, 96)` **不會**幫你換算（實測回 3120），
// 所以那條路是錯的——必須自己減。
func WorkArea() (int, int) {
	scale := systemScale()
	if scale <= 0 {
		return 0, 0
	}
	mon := w32.MonitorFromPoint(0, 0, w32.MONITOR_DEFAULTTOPRIMARY)
	if mon == 0 {
		return 0, 0
	}
	mi := w32.MONITORINFO{CbSize: uint32(unsafe.Sizeof(w32.MONITORINFO{}))}
	if !w32.GetMonitorInfo(mon, &mi) {
		return 0, 0
	}
	physW := int(mi.RcWork.Right - mi.RcWork.Left)
	physH := int(mi.RcWork.Bottom - mi.RcWork.Top)
	if physW <= 0 || physH <= 0 {
		return 0, 0
	}
	return int(float64(physW) / scale), int(float64(physH) / scale)
}

// systemScale 是主螢幕的縮放倍率（DPI / 96）。
func systemScale() float64 {
	dc := w32.GetDC(0)
	if dc == 0 {
		return 0
	}
	defer w32.ReleaseDC(0, dc)
	dpi := w32.GetDeviceCaps(dc, logPixelsX)
	if dpi <= 0 {
		return 0
	}
	return float64(dpi) / 96.0
}
