// Package lib — 精簡字形庫的 **Go 解碼器與查詢層**。
//
// 規格：[`format.md`](../format.md)〈精簡庫格式〉；參考實作：[`tools/lib-format.ts`](../tools/lib-format.ts)
// （那是**唯一的** JS 解碼實作，本套件以它為行為基準，並由 `decode_test.go` 做全庫差分驗證）。
//
// # 這個套件在整體架構裡的位置
//
// 見 [`progress/技術交接文件.md`](../progress/技術交接文件.md) §10.2：
// Go 只做**資料＋語意**，描繪留給前端的 kage。所以這裡**沒有**、也不該有
// 任何幾何描繪程式碼——量墨跡要引擎的多邊形（`glyph-common-page.js`〈精確墨跡〉），
// 那是前端的責任。
//
// # 格式的三個關鍵細節（錯了就整個位元流錯位）
//
//  1. **有號用 zigzag**（座標、width、style、伸縮、碼位差值）；
//     **非負用原始 varint**（計數、長度、索引、kind、旗標）；`kind` **不可** zigzag。
//  2. **每個筆畫一律存 8 個座標欄位**（依原始 F[3..10]），點數少的尾端是補位——
//     ⚠ 那些補位**有時還留著舊的框**，所以只可以讀前 `2 × PtCountOf(kind)` 個，
//     不可以把它們當座標用（見 `format.md`）。
//  3. **解碼後的位置必須正好等於位元組數**——這是唯一能自動抓到「格式解讀錯誤」的機制，
//     歷史上真的發生過 `.bin` 與 `.gz` 不同步而**靜默**錯位（見 `format.md`〈極難查的 bug〉）。
package lib

// Stroke 是一個筆畫。
//
// `Ref`／`Box`／`Stretch` 只有 `Kind == 99`（引用）時有意義。
type Stroke struct {
	// Kind 是筆畫型別。型別有三位數變體（103／203／303 是 3 的變體），
	// 判定點數要用 `Kind % 100`（見 PtCountOf）。
	Kind int32
	// Width 與 Style 是原始 KAGE 欄位。
	//
	// ⚠ 資料庫裡的 `Width` 幾乎都是 0：真正的筆寬是**引擎描繪時**用 `kMinWidth*`
	// 加上去的。所以**不要**用它量墨跡，會系統性低估 6～15 格。
	Width int32
	Style int32
	// Points 固定 8 個欄位（格式如此）。有效的只有前 `2 × PtCountOf(Kind)` 個。
	//
	// 對引用筆畫（Kind == 99），這裡鏡射 `Box` —— 與 JS 實作一致
	// （`readBodies` 裡 `points` 與 `box` 是同一個陣列），這樣兩邊不會有
	// 「同一個欄位讀出不同值」的分歧。
	Points [8]int32
	// Ref 是引用到的字形索引；`-1` ＝ 沒有（對應 JS 的 `null`）。Kind == 99 才有意義。
	Ref int32
	// Box 是引用的框（人工資產，組字時沿用它）。Kind == 99 才有意義。
	Box [4]int32
	// Stretch 是引用的伸縮（分段線性重映射的參數，**不是**仿射）。
	// Kind == 99 才有意義。
	Stretch [4]int32
}

// Glyph 是一個字形。
type Glyph struct {
	// Tight 是緊框（由內容衍生，**不在檔案裡**）。TightSet 為 false ＝ 還沒算。
	Tight    [4]int32
	TightSet bool
	Strokes  []Stroke
}

// Family 是一個「碼位家族」：某個碼位的正字與它的所有異體，在檔案裡**連續排列**。
// 成員索引是 `[Start, Start+Count)`。
type Family struct {
	// CP 是 Unicode 碼位。
	CP int32
	// Start 是家族第一個成員的字形索引。
	Start int32
	Count int32
	// Pref 是家族內「要用哪一個」（位移，0 起算）。慣例是 `-j`（日本字形）優先。
	Pref int32
	// Plain 是前幾個成員算「一般漢字」（名字是 `uXXXX` 或 `uXXXX-j`），給搜尋過濾用。
	Plain int32
}

// Library 是一個解碼完成的字形庫。
type Library struct {
	// Version 是檔案版本（1..6；1 ＝ 沒有魔數的舊格式）。
	Version int
	// Families 依碼位遞增、成員連續。**v1 為空**——v1 只有名字，家族是查詢時推出來的。
	Families []Family
	// OrphanStart 是「沒有家族的部件字形」的起始索引（v1 ＝ len(Glyphs)）。
	OrphanStart int32
	Glyphs      []Glyph

	// Names 與 Suffix 是 **v1 專用**的原始 GlyphWiki 名字。新程式不要用它們：
	// 要 key 用 KeyOfIdx，要顯示用 DisplayName。
	Names  []string
	Suffix []string

	// Comp 是碼位 → IDS 直接部件（**保留重複次數**：林 ＝ 木 木），
	// 且 **v4 之後保留 IDS 原序**（誰左誰右、誰上誰下）。v3+ 才有。
	Comp map[int32][]int32
	// Syn 是跨碼位異體（相容字符 ↔ 正規碼位）。v5+ 才有。
	Syn map[int32][]int32
	// Phil 是**理據拆分**（說文解字注的「从X ＋ X聲」）。
	//
	// ⚠ 只供顯示／查閱，**不參與組字**——組字一律用 Comp 的視覺拆分。
	Phil map[int32][]int32
	// Gwiki 是「內部索引 → GlyphWiki 名字」的對照表；只有 LoadWikiNames 之後才有。
	Gwiki []string

	// 查詢快取（外部不要碰）
	cpFam     map[int32]int32
	v1Pref    map[int32]int32
	v1Members map[int32][]int32
	synKey    map[int32]int32
}

// PtCountOf 回傳一個筆畫型別的座標**點**數（僅供判讀用；格式一律存 8 個欄位）。
func PtCountOf(kind int32) int {
	k := kind % 100
	switch {
	case k == 0 || k == 9:
		return 0
	case k == 1:
		return 2
	case k == 2 || k == 3 || k == 4:
		return 3
	default:
		return 4
	}
}

// KeyOf 是內部 key（給 KAGE 引擎當 hash key 用）。
//
// **這是實作細節，不要外流、不要解析、不要拿來當身分。**
// 同一個字形在兩份不同的庫裡會有不同的 key，這點是刻意的。
func KeyOf(i int32) string { return "g" + itoa36(i) }

// KeyOfIdx 是某個字形在庫中的內部 key（v1 沿用原始名字，讓已內嵌的舊網頁不必重建）。
func KeyOfIdx(l *Library, i int32) string {
	if l.Names != nil {
		if i >= 0 && int(i) < len(l.Names) && l.Names[i] != "" {
			return l.Names[i]
		}
		return KeyOf(i)
	}
	return KeyOf(i)
}
