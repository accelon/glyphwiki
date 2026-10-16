package winsize

import "testing"

// TestFitInClampsToWorkArea 是這個套件存在的理由。
//
// 真實數據：一台 3120×2080 面板、300% 縮放的機器，**邏輯工作區只有 1040 × 693**。
// 想要 480 × 900 的視窗在那裡比工作區還高，置中之後頂端是 -33
// → 標題列整個在畫面之上（使用者回報「看不到視窗的 title」）。
func TestFitInClampsToWorkArea(t *testing.T) {
	w, h := FitIn(1040, 693, 480, 900)
	if h > 693 {
		t.Errorf("高度 %d 不可以超過工作區 693", h)
	}
	if w > 1040 {
		t.Errorf("寬度 %d 不可以超過工作區 1040", w)
	}
	// 具體值：693 - 80 = 613
	if h != 613 {
		t.Errorf("高度：want 613（工作區 − 邊界 80）got %d", h)
	}
	if w != 480 {
		t.Errorf("寬度本來就放得下，不該被改：want 480 got %d", w)
	}
}

// TestFitInKeepsRequestWhenItFits：放得下就**不要動**（不要自作聰明）。
func TestFitInKeepsRequestWhenItFits(t *testing.T) {
	cases := []struct{ aw, ah, w, h int }{
		{1920, 1080, 480, 900},
		{1040, 1000, 480, 900},
		{800, 600, 480, 500},
	}
	for _, c := range cases {
		w, h := FitIn(c.aw, c.ah, c.w, c.h)
		if w != c.w || h != c.h {
			t.Errorf("工作區 %d×%d 放得下 %d×%d，卻被改成 %d×%d", c.aw, c.ah, c.w, c.h, w, h)
		}
	}
}

// TestFitInUnknownWorkArea：量不到工作區（0）時原樣回傳。
//
// ⚠ 這一條很重要：**不要**把「不知道」當成「很小」而把視窗縮成一團。
func TestFitInUnknownWorkArea(t *testing.T) {
	for _, c := range [][4]int{{0, 0, 480, 900}, {-1, 693, 480, 900}, {1040, 0, 480, 900}} {
		w, h := FitIn(c[0], c[1], c[2], c[3])
		if w != c[2] || h != c[3] {
			t.Errorf("工作區 %d×%d 時應該原樣回傳 %d×%d，得到 %d×%d", c[0], c[1], c[2], c[3], w, h)
		}
	}
}

// TestFitInNeverExceedsAvailableWhenPossible：只要工作區不小於下限，結果就必須放得進去。
func TestFitInNeverExceedsAvailableWhenPossible(t *testing.T) {
	reqs := [][2]int{{480, 900}, {1000, 2000}, {100, 100}, {2000, 300}}
	avails := [][2]int{{1040, 693}, {1920, 1080}, {400, 500}, {800, 480}}
	for _, a := range avails {
		for _, r := range reqs {
			w, h := FitIn(a[0], a[1], r[0], r[1])
			// 下限是 360×420；工作區不夠大時允許超過（沒有更好的選擇）
			if a[0] >= 360 && w > a[0] {
				t.Errorf("工作區 %d×%d 想要 %d×%d → 寬 %d 超過工作區", a[0], a[1], r[0], r[1], w)
			}
			if a[1] >= 420 && h > a[1] {
				t.Errorf("工作區 %d×%d 想要 %d×%d → 高 %d 超過工作區", a[0], a[1], r[0], r[1], h)
			}
		}
	}
}

// TestFitInAppliesFloor：極小的請求會被抬到下限（視窗小到不能用沒有意義）。
func TestFitInAppliesFloor(t *testing.T) {
	w, h := FitIn(1920, 1080, 100, 100)
	if w != 360 || h != 420 {
		t.Errorf("want 360×420（下限）got %d×%d", w, h)
	}
}
