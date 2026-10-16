package lib

import (
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// ===========================================================================
// 對外 API：Unicode 進、Unicode 出
// ===========================================================================

// 碼位家族：某個碼位的正字與它的所有異體。家族在檔案裡**連續排列**，
// 所以 `FamilyOfIdx` 是二分搜尋、`IndexOfCodePoint` 是查表。

// CodePointOf 回報這個字形屬於哪個碼位（**0 ＝ 不屬於任何碼位**，是純部件）。
func CodePointOf(l *Library, i int32) int32 {
	if len(l.Families) > 0 {
		fi := FamilyOfIdx(l, i)
		if fi < 0 {
			return 0
		}
		return l.Families[fi].CP
	}
	if l.Names == nil || i < 0 || int(i) >= len(l.Names) {
		return 0
	}
	m := reV1Name.FindStringSubmatch(l.Names[i])
	if m == nil {
		return 0
	}
	cp, err := strconv.ParseInt(m[1], 16, 32)
	if err != nil {
		return 0
	}
	return int32(cp)
}

// FamilyOfIdx 回報這個字形屬於哪個家族（**-1 ＝ 沒有家族**）。
// v2 才有家族表，v1 一律 -1。
func FamilyOfIdx(l *Library, i int32) int32 {
	if len(l.Families) == 0 || i < 0 || int(i) >= len(l.Glyphs) {
		return -1
	}
	if i >= l.OrphanStart {
		return -1
	}
	// Families 依 Start 遞增 → 二分搜尋
	lo, hi := 0, len(l.Families)-1
	for lo <= hi {
		mid := (lo + hi) >> 1
		f := &l.Families[mid]
		switch {
		case i < f.Start:
			hi = mid - 1
		case i >= f.Start+f.Count:
			lo = mid + 1
		default:
			return int32(mid)
		}
	}
	return -1
}

func (l *Library) cpFamMap() map[int32]int32 {
	if l.cpFam == nil {
		m := make(map[int32]int32, len(l.Families))
		for i := range l.Families {
			m[l.Families[i].CP] = int32(i)
		}
		l.cpFam = m
	}
	return l.cpFam
}

// IndexOfCodePoint 是**主要的查字入口**：碼位 → 字形索引。
//
// 回傳的是該家族的「代表」（偏好順序：`-j` ＞ 正字 ＞ 最短變體）。
func IndexOfCodePoint(l *Library, cp int32) (int32, bool) {
	if len(l.Families) > 0 {
		fi, ok := l.cpFamMap()[cp]
		if !ok {
			return 0, false
		}
		f := &l.Families[fi]
		p := f.Pref
		if p > f.Count-1 {
			p = f.Count - 1
		}
		return f.Start + p, true
	}
	i, ok := l.v1PrefMap()[cp]
	return i, ok
}

// FamilyMembers 回報碼位 → 這個家族的全部成員索引（含正字與所有異體）。
func FamilyMembers(l *Library, cp int32) []int32 {
	if len(l.Families) > 0 {
		fi, ok := l.cpFamMap()[cp]
		if !ok {
			return nil
		}
		f := &l.Families[fi]
		out := make([]int32, 0, f.Count)
		for k := int32(0); k < f.Count; k++ {
			out = append(out, f.Start+k)
		}
		return out
	}
	return l.v1MembersMap()[cp]
}

// IndexOfChar 是「字元（單一 code point 的字串）→ 字形索引」。
func IndexOfChar(l *Library, ch string) (int32, bool) {
	if ch == "" {
		return 0, false
	}
	cp, _ := utf8.DecodeRuneInString(ch)
	if cp == utf8.RuneError {
		return 0, false
	}
	return IndexOfCodePoint(l, int32(cp))
}

// IsVariantOfCp 回報這個字形是不是某個碼位的異體／正字。
func IsVariantOfCp(l *Library, i int32, cp int32) bool {
	return CodePointOf(l, i) == cp
}

// CharOf 回報這個字形在庫中的字元（不是碼位字就回空字串）。
func CharOf(l *Library, i int32) string {
	cp := CodePointOf(l, i)
	if cp == 0 {
		return ""
	}
	return string(rune(cp))
}

// IsPlainIdeograph 回報是不是「一般漢字」（`uXXXX` 或 `uXXXX-j`），搜尋過濾用。
func IsPlainIdeograph(l *Library, i int32) bool {
	if len(l.Families) > 0 {
		fi := FamilyOfIdx(l, i)
		if fi < 0 {
			return false
		}
		f := &l.Families[fi]
		return i-f.Start < f.Plain
	}
	if l.Names == nil || i < 0 || int(i) >= len(l.Names) {
		return false
	}
	return reV1Plain.MatchString(l.Names[i])
}

// DisplayName 是給人看的名字。
//
// 沒有載入對照表時回傳內部 key —— 那**不是**身分，只是方便你在 log 裡認人。
// 要看到 GlyphWiki 的名字就 `LoadWikiNames`。
func DisplayName(l *Library, i int32) string {
	if l.Gwiki != nil && i >= 0 && int(i) < len(l.Gwiki) && l.Gwiki[i] != "" {
		return l.Gwiki[i]
	}
	if l.Names != nil && i >= 0 && int(i) < len(l.Names) {
		return l.Names[i]
	}
	return KeyOf(i)
}

// LoadWikiNames 載入「內部索引 → GlyphWiki 名字」對照表（tab 分隔，一行一筆），
// 回傳成功載入的筆數。
//
// 這是唯一能查回 GlyphWiki dump 的橋。**只有除錯／回寫 dump 需要它**，
// 網頁不需要，所以它不在字庫檔裡。
func LoadWikiNames(l *Library, text string) int {
	out := make([]string, len(l.Glyphs))
	n := 0
	for len(text) > 0 {
		var line string
		if i := strings.IndexByte(text, '\n'); i >= 0 {
			line, text = text[:i], text[i+1:]
		} else {
			line, text = text, ""
		}
		if line == "" {
			continue
		}
		t := strings.IndexByte(line, '\t')
		if t < 0 {
			continue
		}
		i, err := strconv.Atoi(line[:t])
		if err != nil || i < 0 || i >= len(out) {
			continue
		}
		out[i] = line[t+1:]
		n++
	}
	l.Gwiki = out
	return n
}

// ---------------------------------------------------------------- v1 的家族推導

var (
	reV1Name  = regexp.MustCompile(`(?i)^u([0-9a-f]{1,6})`)
	reV1Plain = regexp.MustCompile(`(?i)^u[0-9a-f]{1,6}(-j)?$`)
	reLegacy  = regexp.MustCompile(`(?i)^u([0-9a-f]{1,6})(-.*)?$`)
)

func (l *Library) v1PrefMap() map[int32]int32 {
	if l.v1Pref == nil {
		l.v1Pref = LegacyPreference(l.Names)
	}
	return l.v1Pref
}

func (l *Library) v1MembersMap() map[int32][]int32 {
	if l.v1Members == nil {
		m := make(map[int32][]int32)
		for i, nm := range l.Names {
			mm := reV1Name.FindStringSubmatch(nm)
			if mm == nil {
				continue
			}
			cp, err := strconv.ParseInt(mm[1], 16, 32)
			if err != nil {
				continue
			}
			c := int32(cp)
			m[c] = append(m[c], int32(i))
		}
		l.v1Members = m
	}
	return l.v1Members
}

// LegacyPreference 是舊版 `findGlyphIndex` 的偏好規則，原封不動。
//
// 規則（照抄，含它自己的怪癖）：
//
//  1. `uXXXX-j` 一定勝出（取第一個出現的）
//  2. `uXXXX` 本身**只在還沒有候選時**才成為候選 —— 所以如果 `u9adf-03` 先出現、
//     `u9adf` 後出現，舊版回傳的是 `u9adf-03`
//  3. 其餘「非 @版本」的 `uXXXX-***` 取最短的
//  4. 帶 `@版本` 的一律不列入候選（所以只存在 @ 變體時會查不到）
//
// **v1 解碼與 build-library 都必須用同一份**，否則舊字庫與新字庫對同一個碼位
// 會選到不同字形（實測 40,995 個碼位裡有 346 個會不一樣）。
func LegacyPreference(names []string) map[int32]int32 {
	pref := make(map[int32]int32)
	length := make(map[int32]int)
	settledJ := make(map[int32]bool)
	for i, nm := range names {
		m := reLegacy.FindStringSubmatch(nm)
		if m == nil {
			continue
		}
		cp64, err := strconv.ParseInt(m[1], 16, 32)
		if err != nil {
			continue
		}
		cp := int32(cp64)
		if settledJ[cp] {
			continue
		}
		suffix := m[2]
		if suffix == "-j" {
			pref[cp] = int32(i)
			length[cp] = len(nm)
			settledJ[cp] = true
			continue
		}
		if suffix == "" {
			if _, ok := pref[cp]; !ok {
				pref[cp] = int32(i)
				length[cp] = len(nm)
			}
			continue
		}
		if strings.ContainsRune(suffix, '@') {
			continue
		}
		cur, ok := pref[cp]
		if !ok || len(nm) < length[cp] {
			_ = cur
			pref[cp] = int32(i)
			length[cp] = len(nm)
		}
	}
	return pref
}

// ===========================================================================
// 部件圖
// ===========================================================================

// ComponentKids 走部件圖的一步：**有 IDS 分解就用 IDS，否則用 KAGE 引用**。
//
// 只用一種來源才不會重複計算：器的「口」走 KAGE（經「吅」）算 2 個、
// 走 IDS（經「㗊」）算 4 個、走 KAGE 引用算 2 個。
// **不要混用**：混用會多算，而「多算成多少」取決於你怎麼把兩份清單併起來，
// 所以那個數字沒有意義——有意義的是「一次只用一種來源」。
//
// 回傳字形索引，**可能有重複**（林 ＝ 木 木，代表出現兩次）。
func ComponentKids(l *Library, gi int32) []int32 {
	cp := CodePointOf(l, gi)
	if ids, ok := l.Comp[cp]; ok && len(ids) > 0 {
		out := make([]int32, 0, len(ids))
		for _, c := range ids {
			if r, ok := IndexOfCodePoint(l, c); ok {
				out = append(out, r)
			}
		}
		if len(out) > 0 {
			return out // 全部落在字庫外就退回 KAGE
		}
	}
	if gi < 0 || int(gi) >= len(l.Glyphs) {
		return nil
	}
	var out []int32
	for si := range l.Glyphs[gi].Strokes {
		s := &l.Glyphs[gi].Strokes[si]
		if s.Kind == 99 && s.Ref >= 0 {
			out = append(out, s.Ref)
		}
	}
	return out
}

// HasIdsComponents 回報這個字形有沒有 IDS 補的部件（＝KAGE 那邊是畫成筆劃的）。
func HasIdsComponents(l *Library, gi int32) bool {
	cp := CodePointOf(l, gi)
	ids, ok := l.Comp[cp]
	return ok && len(ids) > 0
}

// VariantSiblings 回報與這個碼位「同一個字、不同碼位」的碼位（v5 的 Syn；沒有就是空）。
func VariantSiblings(l *Library, cp int32) []int32 { return l.Syn[cp] }

// ===========================================================================
// 輸出
// ===========================================================================

// ToKageData 還原成 KAGE 資料字串（給 kage-engine 用）。
//
// 這是 Go 這一側與前端之間的**主要介面**：Go 送 KAGE 文字回去，前端的 kage 描繪。
func ToKageData(g *Glyph, l *Library) string {
	var sb strings.Builder
	for i := range g.Strokes {
		s := &g.Strokes[i]
		if i > 0 {
			sb.WriteByte('$')
		}
		if s.Kind == 99 {
			b, st := s.Box, s.Stretch
			sb.WriteString("99:0:0:")
			writeInts(&sb, b[0], b[1], b[2], b[3])
			sb.WriteByte(':')
			sb.WriteString(KeyOfIdx(l, s.Ref))
			sb.WriteByte(':')
			writeInts(&sb, st[0], st[1], st[2], st[3])
			continue
		}
		writeInts(&sb, s.Kind, s.Width, s.Style)
		sb.WriteByte(':')
		writeInts(&sb, s.Points[0], s.Points[1], s.Points[2], s.Points[3],
			s.Points[4], s.Points[5], s.Points[6], s.Points[7])
	}
	return sb.String()
}

func writeInts(sb *strings.Builder, vs ...int32) {
	for i, v := range vs {
		if i > 0 {
			sb.WriteByte(':')
		}
		sb.WriteString(strconv.FormatInt(int64(v), 10))
	}
}

// ===========================================================================
// 跨碼位異體的代表（v5 的連通分量）
// ===========================================================================

// SynKeyOf 回報這個碼位所在「syn 連通分量」的代表碼位（沒有 syn 就是它自己）。
//
// ⚠ **不能用「{自己} ∪ 直接鄰居 取最小」**——syn 圖**不一定完全連通**：
// `辶↔辶`、`辶↔⻌(U+2ECC)`、`辶↔⻍(U+2ECD)` 是同一個連通分量，但 `辶` 只連到 `辶`，
// 於是「取直接鄰居的最小」會得到 `辶→2ECC` 而 `辶→8FB6`，**兩者不相等**；
// 配對就會把部件配到錯的引用框（第 45 輪實測：`進` 的 `隹` 拿到 `辶` 的框、格數也變 1）。
// 這裡用 union-find 求連通分量，同分量共用「最小碼位」當代表。
func SynKeyOf(l *Library, cp int32) int32 {
	l.synKeyOnce()
	if v, ok := l.synKey[cp]; ok {
		return v
	}
	return cp
}

func (l *Library) synKeyOnce() {
	if l.synKey != nil {
		return
	}
	parent := make(map[int32]int32, len(l.Syn))
	var find func(x int32) int32
	find = func(x int32) int32 {
		r, ok := parent[x]
		if !ok {
			r = x
		}
		for {
			pr, ok := parent[r]
			if !ok || pr == r {
				break
			}
			r = pr
		}
		// 路徑壓縮
		cur := x
		for cur != r {
			next, ok := parent[cur]
			if !ok {
				next = cur
			}
			parent[cur] = r
			cur = next
		}
		return r
	}
	for a, list := range l.Syn {
		if _, ok := parent[a]; !ok {
			parent[a] = a
		}
		for _, b := range list {
			if _, ok := parent[b]; !ok {
				parent[b] = b
			}
			ra, rb := find(a), find(b)
			if ra != rb {
				hi, lo := ra, rb
				if hi < lo {
					hi, lo = lo, hi
				}
				parent[hi] = lo
			}
		}
	}
	table := make(map[int32]int32, len(parent))
	for x := range parent {
		table[x] = find(x)
	}
	l.synKey = table
}
