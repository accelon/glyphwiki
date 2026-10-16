package lib

import "math"

// jsRound 等價於 JS 的 `Math.round`。
//
// ⚠ **不是** Go 的 `math.Round`：JS 的 Math.round 對 .5 **一律往 +∞** 進位
// （`Math.round(-0.5) === -0`），而 Go 的 math.Round 是「離開零」。
// 這個專案已經在 Go 移植上吃過一次這個虧（見 `gokage/main.go` 的同名函式）。
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

// ComputeTight 計算一個字形的緊框（由內容衍生，因此不必存在檔案裡）。
//
// 定義：自己所有**有效**筆畫的點，加上所有子部件（經框映射後）的緊框，取聯集。
// `Kind == 0/9` 不描繪，必須排除——早年的 `tightOf` 沒排除，
// 才會算出 `[0,0,200,200]` 這種無用的值。
//
// 行為與 `lib-format.ts` 的 `computeTight()` 逐值相同（含：
//   - `seen` 只累積**當前這一層的 idx**（不是 `s.Ref`）；
//   - 子字形已有緊框就直接用它（所以 `FillTight` 的**索引順序有意義**）；
//   - 映射是 `b[0] + cx*(b[2]-b[0])/200`（**線性**，與 KAGE 引擎的 `stretch`
//     那條分段線性重映射**不同**——緊框只做線性映射，這是規格如此）。
func ComputeTight(l *Library, idx int32, seen []int32) [4]int32 {
	x1, y1 := math.Inf(1), math.Inf(1)
	x2, y2 := math.Inf(-1), math.Inf(-1)
	upd := func(a, b float64) {
		if a < x1 {
			x1 = a
		}
		if a > x2 {
			x2 = a
		}
		if b < y1 {
			y1 = b
		}
		if b > y2 {
			y2 = b
		}
	}
	updBox := func(bx [4]int32) {
		upd(float64(bx[0]), float64(bx[1]))
		upd(float64(bx[2]), float64(bx[3]))
	}

	g := &l.Glyphs[idx]
	for si := range g.Strokes {
		s := &g.Strokes[si]
		if s.Kind == 99 {
			if s.Ref < 0 || inSeen(seen, s.Ref) {
				updBox(s.Box)
				continue
			}
			if int(s.Ref) >= len(l.Glyphs) {
				updBox(s.Box)
				continue
			}
			child := &l.Glyphs[s.Ref]
			var cb [4]int32
			if child.TightSet {
				cb = child.Tight
			} else {
				next := make([]int32, len(seen), len(seen)+1)
				copy(next, seen)
				next = append(next, idx)
				cb = ComputeTight(l, s.Ref, next)
			}
			b := s.Box
			mapX := func(cx float64) float64 {
				return float64(b[0]) + cx*float64(b[2]-b[0])/200
			}
			mapY := func(cy float64) float64 {
				return float64(b[1]) + cy*float64(b[3]-b[1])/200
			}
			upd(mapX(float64(cb[0])), mapY(float64(cb[1])))
			upd(mapX(float64(cb[2])), mapY(float64(cb[3])))
			continue
		}
		np := PtCountOf(s.Kind)
		if np == 0 {
			continue
		}
		for i := 0; i < np; i++ {
			upd(float64(s.Points[i*2]), float64(s.Points[i*2+1]))
		}
	}

	if math.IsInf(x1, 1) {
		return [4]int32{0, 0, 0, 0}
	}
	return [4]int32{
		int32(jsRound(x1)), int32(jsRound(y1)),
		int32(jsRound(x2)), int32(jsRound(y2)),
	}
}

func inSeen(seen []int32, v int32) bool {
	for _, s := range seen {
		if s == v {
			return true
		}
	}
	return false
}

// FillTight 就地補上全庫的緊框。解碼尾端會自動呼叫，外部通常不需要自己叫。
func FillTight(l *Library) {
	for gi := range l.Glyphs {
		l.Glyphs[gi].Tight = ComputeTight(l, int32(gi), nil)
		l.Glyphs[gi].TightSet = true
	}
}
