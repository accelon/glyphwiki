package lib

import (
	"fmt"
	"strconv"
	"strings"
)

// itoa36 對應 JS 的 `i.toString(36)`（**小寫**）。
func itoa36(i int32) string { return strconv.FormatInt(int64(i), 36) }

// ---------------------------------------------------------------- 讀取器

// reader 是 varint 讀取器。
//
// 錯誤處理刻意用「設定 err 後回 0」而不是回傳 error：解碼是一條長長的直線，
// 每一處都寫 `if err != nil` 會把格式本身埋掉。收尾時檢查一次 err 與位置即可。
type reader struct {
	b   []byte
	p   int
	err error
}

// raw 讀一個**原始 varint（非負）**：計數、長度、索引、kind、旗標、碼位。
//
// ⚠ **不可以**用在有號欄位上（見檔頭編碼規則）。
// 回傳 uint32 是為了與 JS 的 32 位元語意逐位元相同。
func (r *reader) raw() uint32 {
	if r.err != nil {
		return 0
	}
	var v uint32
	var shift uint
	for {
		if r.p >= len(r.b) {
			r.err = fmt.Errorf("字形庫資料提前結束 @%d", r.p)
			return 0
		}
		c := r.b[r.p]
		r.p++
		v |= uint32(c&0x7f) << shift
		if c&0x80 == 0 {
			return v
		}
		shift += 7
		if shift > 35 {
			r.err = fmt.Errorf("varint 過長 @%d", r.p)
			return 0
		}
	}
}

// unzig 還原 zigzag 編碼，回傳**有號**值。
//
// 與 JS 的 `(u >>> 1) ^ -(u & 1)` 逐位元相同（含 32 位元溢出行為）。
func unzig(u uint32) int32 { return int32(u>>1) ^ -int32(u&1) }

// signed 讀一個 **zigzag（有號）** varint：座標、width、style、伸縮值、碼位差值。
func (r *reader) signed() int32 { return unzig(r.raw()) }

// str 讀 `n` 個字元（v1 的名字／後綴表用）。
func (r *reader) str(n int) string {
	var sb strings.Builder
	for i := 0; i < n && r.err == nil; i++ {
		sb.WriteRune(rune(r.raw() & 0xFFFF))
	}
	return sb.String()
}

// idx 讀一個非負索引並收斂成 int。
func (r *reader) idx() int { return int(int32(r.raw())) }

// ---------------------------------------------------------------- 解碼入口

// DecodeLibrary 解碼一份字庫。
//
// 有 `"GL"` 魔數 → 依版本 byte 解；沒有 → 當成 **v1**（舊格式）。
// 這樣舊的 `out/lib-cjk.bin.gz`（以及內嵌它的兩個網頁）不必重建就能繼續用。
//
//	v1  舊格式，名字是字串
//	v2  家族表＋盒字典，沒有部件資料
//	v3  v2 ＋ 尾端 IDS 部件區段（Comp）
//	v4  v3，但部件清單的差值改用 **zigzag（有號）**，所以可以保留 IDS 原序
//	v5  ＋ 尾端跨碼位異體區段（Syn）
//	v6  ＋ 尾端理據拆分區段（Phil；只顯示、不參與組字）
func DecodeLibrary(b []byte) (*Library, error) {
	if len(b) >= 3 && b[0] == 0x47 && b[1] == 0x4c {
		switch b[2] {
		case 2:
			return decodeV23(b, 3, false, false, false, false)
		case 3:
			return decodeV23(b, 3, true, false, false, false)
		case 4:
			return decodeV23(b, 3, true, true, false, false)
		case 5:
			return decodeV23(b, 3, true, true, true, false)
		case 6:
			return decodeV23(b, 3, true, true, true, true)
		default:
			return nil, fmt.Errorf("不認得的字形庫版本 %d（這個檔案是 v1 的話應該沒有魔數開頭）", b[2])
		}
	}
	return decodeV1(b, 0)
}

// PeekVersion 回報檔案的格式版本（**不解碼**）。沒有魔數 → 1。
//
// 給「先看版本再決定要不要解」的呼叫端（例如 CLI 的 --stats）。
func PeekVersion(b []byte) int {
	if len(b) >= 3 && b[0] == 0x47 && b[1] == 0x4c {
		return int(b[2])
	}
	return 1
}

// ---------------------------------------------------------------- 筆畫與盒字典

// readBodies 讀「盒字典 ＋ 所有字形的筆畫」（v1／v2 完全相同）。
func readBodies(r *reader, n int) ([]Glyph, error) {
	// 盒字典：把差異很小的引用框歸成一類共用（見 tools/box-dictionary.ts）。
	nReps := r.idx()
	boxReps := make([][4]int32, 0, nReps)
	for i := 0; i < nReps && r.err == nil; i++ {
		boxReps = append(boxReps, [4]int32{r.signed(), r.signed(), r.signed(), r.signed()})
	}

	glyphs := make([]Glyph, n)
	for gi := 0; gi < n && r.err == nil; gi++ {
		nStr := r.idx()
		strokes := make([]Stroke, 0, nStr)
		for s := 0; s < nStr && r.err == nil; s++ {
			var st Stroke
			st.Kind = int32(r.raw())
			if st.Kind == 99 {
				st.Ref = int32(r.raw())
				// 旗標：一個 byte 的 bit field（bit0 = isFull、bit1 = noStretch）
				flags := r.raw()
				isFull := flags&1 != 0
				noStretch := flags&2 != 0
				// ⚠ 這兩個 `r.raw()` 有**短路**：isFull／noStretch 為真時
				//    對應的 varint **不在位元流裡**，多讀一個就會整個錯位。
				if isFull {
					st.Box = [4]int32{0, 0, 200, 200}
				} else if bi := r.idx(); bi >= 0 && bi < len(boxReps) {
					st.Box = boxReps[bi]
				} else {
					st.Box = [4]int32{0, 0, 200, 200} // JS 的 `?? [0,0,200,200]`
				}
				if noStretch {
					st.Stretch = [4]int32{0, 0, 0, 0}
				} else {
					st.Stretch = [4]int32{r.signed(), r.signed(), r.signed(), r.signed()}
				}
				// 鏡射 JS：引用筆畫的 `points` 就是 `box`。
				//
				// ⚠ JS 那邊 `points` 是**同一個 4 元素陣列**（不是 8 個）；
				// 本套件的 Points 固定 8 欄（格式如此），所以只鏡射前 4 欄。
				// 引用筆畫的任何消費者都應該讀 `Box`／`Stretch`，**不要**讀 `Points`。
				st.Points[0], st.Points[1] = st.Box[0], st.Box[1]
				st.Points[2], st.Points[3] = st.Box[2], st.Box[3]
			} else {
				st.Width = r.signed()
				st.Style = r.signed()
				for i := 0; i < 8; i++ {
					st.Points[i] = r.signed()
				}
				st.Ref = -1
			}
			strokes = append(strokes, st)
		}
		glyphs[gi] = Glyph{Strokes: strokes}
	}
	return glyphs, r.err
}

// decodeV23 解 v2～v6。
//
// 尾端區段（IDS／syn／phil）放在**字形之後**，所以 v2 的解碼路徑完全不用動，
// 讀完字形再讀區段，長度檢查仍然成立。
func decodeV23(b []byte, start int, withComp, compOrdered, withSyn, withPhil bool) (*Library, error) {
	r := &reader{b: b, p: start}
	version := int(b[2])

	n := r.idx()
	nFams := r.idx()
	families := make([]Family, 0, nFams)
	var cursor int32
	var prevCp int32
	for i := 0; i < nFams && r.err == nil; i++ {
		cp := prevCp + r.signed()
		prevCp = cp
		count := int32(r.raw())
		// 打包：高 5 bit ＝ pref、低 3 bit ＝ plain（與 build-library.ts 對稱）
		packed := r.raw()
		families = append(families, Family{
			CP: cp, Start: cursor, Count: count,
			Pref: int32(packed >> 3), Plain: int32(packed & 7),
		})
		cursor += count
	}

	glyphs, err := readBodies(r, n)
	if err != nil {
		return nil, err
	}
	lib := &Library{Version: version, Glyphs: glyphs, Families: families, OrphanStart: cursor}

	if withComp {
		// 碼位 → IDS 直接部件（保留重複次數；v4 之後保留 IDS 順序）
		nEnt := r.idx()
		comp := make(map[int32][]int32, nEnt)
		var cp int32
		for i := 0; i < nEnt && r.err == nil; i++ {
			cp += int32(r.raw())
			k := r.idx()
			arr := make([]int32, 0, k)
			var c int32
			for j := 0; j < k; j++ {
				// v4：有號差值（可以任意順序）；v3：無號差值（順序已經被排序丟掉）
				if compOrdered {
					c += r.signed()
				} else {
					c += int32(r.raw())
				}
				arr = append(arr, c)
			}
			comp[cp] = arr
		}
		lib.Comp = comp
	}

	if withSyn {
		// v5：跨碼位異體（相容字符 ↔ 正規碼位）。家族表只綁同碼位，這一區補
		// 「同一個字、兩個碼位」——頁面的部件名字（IDS 的碼位）與框（畫法的碼位）靠它對起來。
		nSyn := r.idx()
		syn := make(map[int32][]int32, nSyn*2)
		var a, c int32
		for i := 0; i < nSyn && r.err == nil; i++ {
			a += r.signed()
			c += r.signed()
			syn[a] = append(syn[a], c)
			syn[c] = append(syn[c], a)
		}
		lib.Syn = syn
	}

	if withPhil {
		// v6：理據拆分（說文解字注的「从X ＋ X聲」）。⚠ 只顯示，不參與組字。
		// 編碼與 Comp 同型：碼位差、分量數、各分量差（全部 zigzag varint）。
		nPhil := r.idx()
		phil := make(map[int32][]int32, nPhil)
		var pa int32
		for i := 0; i < nPhil && r.err == nil; i++ {
			pa += r.signed()
			k := r.idx()
			arr := make([]int32, 0, k)
			// ⚠ 與 Comp 不同：這裡從 `pa` **起算累加**（鏡射 JS 實作）
			cc := pa
			for j := 0; j < k; j++ {
				cc += r.signed()
				arr = append(arr, cc)
			}
			phil[pa] = arr
		}
		lib.Phil = phil
	}

	if err := r.err; err != nil {
		return nil, err
	}
	// 完整性檢查：解碼後的位置必須正好等於位元組數。
	// 這是唯一能自動抓到「格式解讀錯誤」的機制（見 format.md〈極難查的 bug〉）。
	if r.p != len(b) {
		return nil, fmt.Errorf("字形庫解碼不完整：讀到 %d / %d bytes（格式不符）", r.p, len(b))
	}

	FillTight(lib)
	return lib, nil
}

// decodeV1 解舊格式（名字是字串，家族在解碼時由名字推導）。
func decodeV1(b []byte, start int) (*Library, error) {
	r := &reader{b: b, p: start}
	n := r.idx()
	ns := r.idx()

	suffix := make([]string, 0, ns)
	for i := 0; i < ns && r.err == nil; i++ {
		suffix = append(suffix, r.str(r.idx()))
	}

	names := make([]string, n)
	for gi := 0; gi < n && r.err == nil; gi++ {
		cp := r.raw()
		if cp != 0 {
			six := r.idx()
			nm := "u" + strconv.FormatUint(uint64(cp), 16)
			if six != 0 && six-1 < len(suffix) {
				nm += suffix[six-1]
			}
			names[gi] = nm
		} else {
			names[gi] = r.str(r.idx())
		}
	}

	glyphs, err := readBodies(r, n)
	if err != nil {
		return nil, err
	}
	if err := r.err; err != nil {
		return nil, err
	}
	if r.p != len(b) {
		return nil, fmt.Errorf("字形庫解碼不完整：讀到 %d / %d bytes（格式不符）", r.p, len(b))
	}

	lib := &Library{
		Version: 1, Glyphs: glyphs, Families: nil,
		OrphanStart: int32(n), Names: names, Suffix: suffix,
	}
	FillTight(lib)
	return lib, nil
}
