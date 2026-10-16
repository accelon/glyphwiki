// Package winsize —— 取得**螢幕工作區的邏輯大小**，並把視窗大小夾進它。
//
// # 為什麼需要這一支
//
// **Wails 會把視窗置中，但不會幫你夾進螢幕。** `WebviewWindowOptions` 只有
// `Width`／`Height`／`Min*`／`Max*`，沒有定位、也沒有「fit」。
//
// 真的踩過：把手機豎版的尺寸（480 × 900）直接寫進桌面視窗，在一台
// **邏輯工作區只有 1040 × 693**（3120 × 2080 面板、300% 縮放）的機器上，
// 視窗比工作區還高 → 置中之後頂端座標是 **-33** → **標題列整個在畫面之上**。
// 使用者的回報是「看不到視窗的 title」，而不是「視窗太大」——
// 因為標題列根本不在畫面上。
//
// 平台專屬的只有「工作區怎麼量」（`WorkArea`）；夾的規則寫在這裡一份。
package winsize

// Fit 把「想要的大小」夾進主螢幕工作區。
//
// 工作區拿不到（回 0）時原樣回傳——**不要**因為量不到就亂改使用者的設定。
func Fit(wantW, wantH int) (int, int) {
	aw, ah := WorkArea()
	return FitIn(aw, ah, wantW, wantH)
}

// FitIn 是 Fit 的純函式版本（工作區由呼叫端給），方便測試。
//
// 為什麼要**留邊界**：`Height` 不含標題列，而標題列與工作列都是實實在在吃掉高度的。
// 不留的話「剛好等於工作區高」照樣會把標題列推出畫面。
func FitIn(availW, availH, wantW, wantH int) (int, int) {
	if availW <= 0 || availH <= 0 {
		return wantW, wantH
	}
	const marginW, marginH = 40, 80
	if maxW := availW - marginW; wantW > maxW {
		wantW = maxW
	}
	if maxH := availH - marginH; wantH > maxH {
		wantH = maxH
	}
	// 下限：比這個更小的螢幕也只能接受，否則視窗會小到不能用。
	// ⚠ 極端小的螢幕上這兩個下限**可能**讓視窗仍然比工作區大，
	//    但那已經沒有更好的選擇（使用者仍可自行調整）。
	const minW, minH = 360, 420
	if wantW < minW {
		wantW = minW
	}
	if wantH < minH {
		wantH = minH
	}
	return wantW, wantH
}
