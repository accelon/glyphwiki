//go:build ignore

// make-icon.go —— 產生 pinxing-app 的圖示（`build/appicon.png`）。
//
// 只用到標準庫的 `image`／`image/png`：**不需要外部工具、不需要字型檔**。
// 圖案是「2×2 的部件方格、其中一格最亮」——對應「把部件拼起來」這件事；
// 底色是品牌藍的圓角方塊。
//
// ⚠ 這支**不參與模組建置**（`//go:build ignore`）：它是一次性的資產產生器，
// 產物 `build/appicon.png` 才是要進版控的東西。
//
// 用法:
//
//	cd pinxing-app
//	go run build/make-icon.go                 # → build/appicon.png（256×256）
//	wails3 generate icons -input build/appicon.png \
//	    -windowsfilename build/windows/icon.ico
package main

import (
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"
)

const size = 256
const ss = 4 // 每軸的超取樣數（反鋸齒）

// roundRect 回報 (px,py) 是否落在圓角矩形內。
func roundRect(px, py, x0, y0, x1, y1, r float64) bool {
	if px < x0 || px > x1 || py < y0 || py > y1 {
		return false
	}
	// 只有四個角需要檢查圓
	if r <= 0 {
		return true
	}
	cx := math.Min(math.Max(px, x0+r), x1-r)
	cy := math.Min(math.Max(py, y0+r), y1-r)
	dx, dy := px-cx, py-cy
	if dx == 0 && dy == 0 {
		return true
	}
	return dx*dx+dy*dy <= r*r
}

// coverage 用 ss×ss 超取樣回傳覆蓋率（0..1），用來做反鋸齒。
func coverage(x, y int, x0, y0, x1, y1, r float64) float64 {
	hit := 0
	for sy := 0; sy < ss; sy++ {
		for sx := 0; sx < ss; sx++ {
			px := float64(x) + (float64(sx)+0.5)/ss
			py := float64(y) + (float64(sy)+0.5)/ss
			if roundRect(px, py, x0, y0, x1, y1, r) {
				hit++
			}
		}
	}
	return float64(hit) / float64(ss*ss)
}

func lerp(a, b, t float64) float64 { return a + (b-a)*t }

// blend 把 src 以 alpha 疊到 dst 上（兩者都是非預乘）。
func blend(dst, src color.RGBA, alpha float64) color.RGBA {
	a := alpha * float64(src.A) / 255
	return color.RGBA{
		R: uint8(lerp(float64(dst.R), float64(src.R), a)),
		G: uint8(lerp(float64(dst.G), float64(src.G), a)),
		B: uint8(lerp(float64(dst.B), float64(src.B), a)),
		A: uint8(math.Min(255, float64(dst.A)+a*255)),
	}
}

func main() {
	img := image.NewRGBA(image.Rect(0, 0, size, size))

	// 底色：圓角方塊 ＋ 由上到下的藍色漸層
	const bgTop = 0x5b8cff // 品牌藍
	const bgBot = 0x22304d // 深藍
	top := color.RGBA{0x5b, 0x8c, 0xff, 255}
	bot := color.RGBA{0x22, 0x30, 0x4d, 255}
	_ = bgTop
	_ = bgBot

	// 四塊部件：位置（左, 上, 大小, 圓角, 白度）
	// 左上最亮 ＝「正在被放進去的那一塊」，其餘依序轉暗。
	type block struct{ x, y, s, r, light float64 }
	blocks := []block{
		{46, 46, 74, 14, 1.00},
		{136, 46, 74, 14, 0.62},
		{46, 136, 74, 14, 0.62},
		{136, 136, 74, 14, 0.30},
	}

	white := color.RGBA{255, 255, 255, 255}

	for y := 0; y < size; y++ {
		// 漸層參數
		t := float64(y) / float64(size-1)
		bg := color.RGBA{
			R: uint8(lerp(float64(top.R), float64(bot.R), t)),
			G: uint8(lerp(float64(top.G), float64(bot.G), t)),
			B: uint8(lerp(float64(top.B), float64(bot.B), t)),
			A: 255,
		}
		for x := 0; x < size; x++ {
			// 圓角方塊本體（留 2px 邊界避免硬切）
			cov := coverage(x, y, 2, 2, size-3, size-3, 48)
			if cov <= 0 {
				continue
			}
			px := blend(color.RGBA{}, bg, 1)
			px.A = uint8(cov * 255)

			// 疊上四塊部件
			for _, b := range blocks {
				bx0, by0 := b.x, b.y
				bx1, by1 := b.x+b.s-1, b.y+b.s-1
				if float64(x) < bx0-1 || float64(x) > bx1+1 || float64(y) < by0-1 || float64(y) > by1+1 {
					continue
				}
				bc := coverage(x, y, bx0, by0, bx1, by1, b.r)
				if bc <= 0 {
					continue
				}
				px = blend(px, white, bc*b.light)
			}
			img.SetRGBA(x, y, px)
		}
	}

	out := filepath.Join("build", "appicon.png")
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		log.Fatal(err)
	}
	f, err := os.Create(out)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		log.Fatal(err)
	}
	st, _ := f.Stat()
	log.Printf("已產生 %s（%d×%d，%d bytes）", out, size, size, st.Size())
}
