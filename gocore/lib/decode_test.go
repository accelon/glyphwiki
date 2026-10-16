package lib

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// ===========================================================================
// 對 JS 參考實作的**全庫差分測試**
// ===========================================================================
//
// 這一支是 `gocore/lib` 的驗收：同一份 `out/lib-cjk-all.bin`，
// 用 `tools/lib-format.ts`（唯一的 JS 解碼實作）與本套件各解一次，
// 逐值比對**全庫**的結果。
//
// 為什麼要全庫而不是抽樣：格式錯位（少讀一個 varint、zigzag 用錯）**不會報錯**，
// 只會讓後面全部歪掉。歷史上真的發生過 `.bin` 與 `.gz` 不同步而靜默錯位
// （見 `format.md`〈極難查的 bug〉）。所以覆蓋率就是這個測試的全部價值：
//
//   * `kageHashAll`  每個字形的 `ToKageData`（FNV-1a 32）→ 驗整條位元流
//   * `tightAll`     每個字形的緊框 → 驗 ComputeTight 的遞迴、框映射與捨入
//   * `families`     逐筆驗家族表
//   * `comp`／`syn`／`phil`  逐筆驗三個尾端區段（含 comp 的**分量順序**）
//   * `lookup.*`     抽樣驗查詢層
//
// 產生 golden（golden 檔不入版控）：
//
//	bun run gocore/refdump.ts
//
// 然後：
//
//	cd gocore && go test ./...
//
// ⚠ DSH 沙箱下 `GOCACHE` 必須重導進工作區（見 gocore/README.md）。

const (
	testdataDir = "../testdata"
	goldenFile  = "ref.json.gz"
	libCopyFile = "lib-cjk-all.bin"
	refdumpHint = "先產生 golden：bun run gocore/refdump.ts"
	maxReported = 8
)

type goldenData struct {
	Meta struct {
		LibFile   string `json:"libFile"`
		LibBytes  int    `json:"libBytes"`
		LibSha256 string `json:"libSha256"`
		Version   int    `json:"version"`
		PtCounts  []int  `json:"ptCounts"`
	} `json:"meta"`
	Counts struct {
		Glyphs      int   `json:"glyphs"`
		Families    int   `json:"families"`
		OrphanStart int32 `json:"orphanStart"`
		Comp        int   `json:"comp"`
		Syn         int   `json:"syn"`
		Phil        int   `json:"phil"`
	} `json:"counts"`
	KageHashAll []uint32 `json:"kageHashAll"`
	TightAll    []int32  `json:"tightAll"`
	Families    []int32  `json:"families"`
	Comp        []int32  `json:"comp"`
	Syn         []int32  `json:"syn"`
	Phil        []int32  `json:"phil"`
	Lookup      struct {
		Gis           []int32  `json:"gis"`
		IndexOfCp     []int32  `json:"indexOfCp"`
		Plain         []int32  `json:"plain"`
		Keys          []string `json:"keys"`
		FamilyMembers []int32  `json:"familyMembers"`
		ComponentKids []int32  `json:"componentKids"`
	} `json:"lookup"`
	Spot []struct {
		Ch       string  `json:"ch"`
		CP       int32   `json:"cp"`
		Idx      int32   `json:"idx"`
		Tight    []int32 `json:"tight"`
		KageHash uint32  `json:"kageHash"`
		Kids     []int32 `json:"kids"`
	} `json:"spot"`
}

// fnv1a32 是 FNV-1a 32 位元。**必須與 `gocore/refdump.ts` 裡手寫的那一份逐位元相同**，
// 所以這裡也刻意不用 `hash/fnv`（雖然演算法一樣，但明寫比較不容易被誤改）。
func fnv1a32(s string) uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < len(s); i++ {
		h ^= uint32(s[i])
		h *= 0x01000193
	}
	return h
}

func loadGolden(t *testing.T) (*goldenData, []byte) {
	t.Helper()
	gzPath := filepath.Join(testdataDir, goldenFile)
	libPath := filepath.Join(testdataDir, libCopyFile)

	if _, err := os.Stat(gzPath); err != nil {
		t.Fatalf("找不到 golden 檔 %s\n%s", gzPath, refdumpHint)
	}
	if _, err := os.Stat(libPath); err != nil {
		t.Fatalf("找不到字庫複本 %s\n%s", libPath, refdumpHint)
	}

	f, err := os.Open(gzPath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	raw, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}

	var g goldenData
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	libBytes, err := os.ReadFile(libPath)
	if err != nil {
		t.Fatal(err)
	}
	return &g, libBytes
}

// cmpSlice 逐值比對兩個切片；不同就列出前幾筆（不是只報第一個，
// 因為「第一個不同」常常只是同一個根因的第一個受害者）。
func cmpSlice[T comparable](t *testing.T, name string, want, got []T) {
	t.Helper()
	if len(want) != len(got) {
		t.Fatalf("%s：長度不同 want=%d got=%d", name, len(want), len(got))
	}
	bad := 0
	for i := range want {
		if want[i] != got[i] {
			if bad < maxReported {
				t.Errorf("%s[%d]：want %v，got %v", name, i, want[i], got[i])
			}
			bad++
		}
	}
	if bad > 0 {
		t.Errorf("%s：共 %d / %d 處不同（只列前 %d 筆）", name, bad, len(want), maxReported)
	}
}

// flatToMap 把「key, 長度, 值…」的攤平格式還原成 map。
func flatToMap(a []int32) map[int32][]int32 {
	m := make(map[int32][]int32)
	for i := 0; i+1 < len(a); {
		k := a[i]
		n := int(a[i+1])
		if i+2+n > len(a) {
			break // 格式壞掉；長度檢查會另外抓到
		}
		vals := make([]int32, n)
		copy(vals, a[i+2:i+2+n])
		m[k] = vals
		i += 2 + n
	}
	return m
}

// cmpFlatMap 比對「攤平 map」與 Go 的 map（逐 key、逐值，值順序**有意義**）。
func cmpFlatMap(t *testing.T, name string, wantFlat []int32, got map[int32][]int32) {
	t.Helper()
	want := flatToMap(wantFlat)
	if len(wantFlat) != 0 {
		// 攤平長度必須剛好被解析完（否則格式解讀不一致）
		used := 0
		for i := 0; i < len(wantFlat); {
			n := int(wantFlat[i+1])
			i += 2 + n
			used++
		}
		if used != len(want) {
			t.Errorf("%s：攤平格式沒有解析完（解析 %d 筆，得到 %d 筆）", name, used, len(want))
		}
	}
	if len(want) != len(got) {
		t.Errorf("%s：筆數不同 want=%d got=%d", name, len(want), len(got))
	}
	bad := 0
	for k, wv := range want {
		gv, ok := got[k]
		if !ok {
			if bad < maxReported {
				t.Errorf("%s：缺少 key %d", name, k)
			}
			bad++
			continue
		}
		if len(wv) != len(gv) {
			if bad < maxReported {
				t.Errorf("%s[%d]：長度不同 want=%v got=%v", name, k, wv, gv)
			}
			bad++
			continue
		}
		for i := range wv {
			if wv[i] != gv[i] {
				if bad < maxReported {
					t.Errorf("%s[%d][%d]：want %d got %d（want=%v got=%v）", name, k, i, wv[i], gv[i], wv, gv)
				}
				bad++
				break
			}
		}
	}
	for k := range got {
		if _, ok := want[k]; !ok {
			if bad < maxReported {
				t.Errorf("%s：多出 key %d", name, k)
			}
			bad++
		}
	}
	if bad > 0 {
		t.Errorf("%s：共 %d 處不同（只列前 %d 筆）", name, bad, maxReported)
	}
}

// TestDecodeAgainstJS 是全庫差分驗收。這是本套件最重要的一個測試。
func TestDecodeAgainstJS(t *testing.T) {
	g, libBytes := loadGolden(t)

	if len(libBytes) != g.Meta.LibBytes {
		t.Fatalf("字庫複本大小不同：want %d got %d（golden 與字庫不同步，重跑 refdump）",
			g.Meta.LibBytes, len(libBytes))
	}
	if v := PeekVersion(libBytes); v != g.Meta.Version {
		t.Fatalf("版本不同：want %d got %d", g.Meta.Version, v)
	}

	lib, err := DecodeLibrary(libBytes)
	if err != nil {
		t.Fatalf("Go 解碼失敗：%v", err)
	}

	// ---- 1. 總量 ----
	t.Run("counts", func(t *testing.T) {
		if len(lib.Glyphs) != g.Counts.Glyphs {
			t.Errorf("字形數：want %d got %d", g.Counts.Glyphs, len(lib.Glyphs))
		}
		if len(lib.Families) != g.Counts.Families {
			t.Errorf("家族數：want %d got %d", g.Counts.Families, len(lib.Families))
		}
		if lib.OrphanStart != g.Counts.OrphanStart {
			t.Errorf("orphanStart：want %d got %d", g.Counts.OrphanStart, lib.OrphanStart)
		}
		if len(lib.Comp) != g.Counts.Comp {
			t.Errorf("IDS 分量筆數：want %d got %d", g.Counts.Comp, len(lib.Comp))
		}
		if len(lib.Syn) != g.Counts.Syn {
			t.Errorf("syn 筆數：want %d got %d", g.Counts.Syn, len(lib.Syn))
		}
		if len(lib.Phil) != g.Counts.Phil {
			t.Errorf("phil 筆數：want %d got %d", g.Counts.Phil, len(lib.Phil))
		}
		if lib.Version != g.Meta.Version {
			t.Errorf("Version：want %d got %d", g.Meta.Version, lib.Version)
		}
	})

	// ---- 2. 點數判讀表（kind 的三位數變體也在裡面）----
	t.Run("ptCountOf", func(t *testing.T) {
		kinds := []int32{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 99, 103}
		for i, k := range kinds {
			if got := PtCountOf(k); got != g.Meta.PtCounts[i] {
				t.Errorf("PtCountOf(%d)：want %d got %d", k, g.Meta.PtCounts[i], got)
			}
		}
	})

	// ---- 3. 整條位元流：每個字形的 KAGE 資料 hash（全庫）----
	t.Run("kageHashAll", func(t *testing.T) {
		got := make([]uint32, len(lib.Glyphs))
		for i := range lib.Glyphs {
			got[i] = fnv1a32(ToKageData(&lib.Glyphs[i], lib))
		}
		cmpSlice(t, "kageHashAll", g.KageHashAll, got)
	})

	// ---- 4. 每個字形的緊框（全庫）----
	t.Run("tightAll", func(t *testing.T) {
		got := make([]int32, 0, len(lib.Glyphs)*4)
		for i := range lib.Glyphs {
			tv := lib.Glyphs[i].Tight
			got = append(got, tv[0], tv[1], tv[2], tv[3])
		}
		cmpSlice(t, "tightAll", g.TightAll, got)
	})

	// ---- 5. 家族表（逐筆）----
	t.Run("families", func(t *testing.T) {
		got := make([]int32, 0, len(lib.Families)*5)
		for i := range lib.Families {
			f := &lib.Families[i]
			got = append(got, f.CP, f.Start, f.Count, f.Pref, f.Plain)
		}
		cmpSlice(t, "families", g.Families, got)
	})

	// ---- 6. 三個尾端區段（逐筆，含 comp 的分量順序）----
	t.Run("comp", func(t *testing.T) { cmpFlatMap(t, "comp", g.Comp, lib.Comp) })
	t.Run("syn", func(t *testing.T) { cmpFlatMap(t, "syn", g.Syn, lib.Syn) })
	t.Run("phil", func(t *testing.T) { cmpFlatMap(t, "phil", g.Phil, lib.Phil) })

	// ---- 7. 查詢層（抽樣）----
	t.Run("lookup", func(t *testing.T) {
		lk := &g.Lookup
		if len(lk.IndexOfCp) != len(lk.Gis)*2 {
			t.Fatalf("golden 的 indexOfCp 長度與 gis 不合：%d vs %d×2", len(lk.IndexOfCp), len(lk.Gis))
		}
		if len(lk.Plain) != len(lk.Gis)*2 {
			t.Fatalf("golden 的 plain 長度與 gis 不合：%d vs %d×2", len(lk.Plain), len(lk.Gis))
		}
		if len(lk.Keys) != len(lk.Gis) {
			t.Fatalf("golden 的 keys 長度與 gis 不合：%d vs %d", len(lk.Keys), len(lk.Gis))
		}

		// CodePointOf / IndexOfCodePoint / IsPlainIdeograph / KeyOfIdx
		for i, gi := range lk.Gis {
			wantCp := lk.IndexOfCp[i*2]
			if got := CodePointOf(lib, gi); got != wantCp {
				t.Errorf("CodePointOf(%d)：want %d got %d", gi, wantCp, got)
			}
			wantIdx := lk.IndexOfCp[i*2+1]
			gotIdx := int32(-1)
			if v, ok := IndexOfCodePoint(lib, wantCp); ok {
				gotIdx = v
			}
			if gotIdx != wantIdx {
				t.Errorf("IndexOfCodePoint(%d)：want %d got %d", wantCp, wantIdx, gotIdx)
			}
			wantPlain := lk.Plain[i*2+1] == 1
			if got := IsPlainIdeograph(lib, gi); got != wantPlain {
				t.Errorf("IsPlainIdeograph(%d)：want %v got %v", gi, wantPlain, got)
			}
			if got := KeyOfIdx(lib, gi); got != lk.Keys[i] {
				t.Errorf("KeyOfIdx(%d)：want %q got %q", gi, lk.Keys[i], got)
			}
		}

		// FamilyMembers（攤平：cp, 長度, 成員…）
		{
			bad := 0
			for i := 0; i < len(lk.FamilyMembers); {
				cp := lk.FamilyMembers[i]
				n := int(lk.FamilyMembers[i+1])
				want := lk.FamilyMembers[i+2 : i+2+n]
				got := FamilyMembers(lib, cp)
				if len(want) != len(got) {
					if bad < maxReported {
						t.Errorf("FamilyMembers(%d)：want %v got %v", cp, want, got)
					}
					bad++
				} else {
					for j := range want {
						if want[j] != got[j] {
							if bad < maxReported {
								t.Errorf("FamilyMembers(%d)[%d]：want %d got %d", cp, j, want[j], got[j])
							}
							bad++
							break
						}
					}
				}
				i += 2 + n
			}
			if bad > 0 {
				t.Errorf("FamilyMembers：共 %d 筆不同", bad)
			}
		}

		// ComponentKids（攤平：gi, 長度, 成員…）
		{
			bad := 0
			for i := 0; i < len(lk.ComponentKids); {
				gi := lk.ComponentKids[i]
				n := int(lk.ComponentKids[i+1])
				want := lk.ComponentKids[i+2 : i+2+n]
				got := ComponentKids(lib, gi)
				if len(want) != len(got) {
					if bad < maxReported {
						t.Errorf("ComponentKids(%d)：want %v got %v", gi, want, got)
					}
					bad++
				} else {
					for j := range want {
						if want[j] != got[j] {
							if bad < maxReported {
								t.Errorf("ComponentKids(%d)[%d]：want %d got %d", gi, j, want[j], got[j])
							}
							bad++
							break
						}
					}
				}
				i += 2 + n
			}
			if bad > 0 {
				t.Errorf("ComponentKids：共 %d 筆不同", bad)
			}
		}
	})

	if t.Failed() {
		t.Logf("提示：golden 由 %s 產生（%d bytes、v%d）", g.Meta.LibFile, g.Meta.LibBytes, g.Meta.Version)
	}
}

// TestDecodeRejectsTruncated 驗「解碼不完整」的收尾檢查真的會叫。
//
// 這一條護欄的價值極高：格式解讀錯誤**不會拋錯**，只會靜默錯位。
// 把每個尾端切掉幾十個 byte，解碼就必須失敗，而不是回一份「看起來成功」的庫。
func TestDecodeRejectsTruncated(t *testing.T) {
	_, libBytes := loadGolden(t)
	if _, err := DecodeLibrary(libBytes); err != nil {
		t.Fatalf("完整檔應該解得開，卻失敗：%v", err)
	}
	for _, cut := range []int{1, 16, 1024, 65536} {
		if cut >= len(libBytes) {
			continue
		}
		if _, err := DecodeLibrary(libBytes[:len(libBytes)-cut]); err == nil {
			t.Errorf("切掉 %d bytes 之後仍然解碼成功——收尾檢查失效", cut)
		}
	}
}

// TestDecodeRejectsUnknownVersion 驗不認得的版本會**大聲失敗**，
// 而不是默默當成別的版本解（那正是 `.bin`／`.gz` 不同步那個坑的成因）。
func TestDecodeRejectsUnknownVersion(t *testing.T) {
	_, libBytes := loadGolden(t)
	bad := make([]byte, 8)
	copy(bad, libBytes[:8])
	bad[2] = 99
	if _, err := DecodeLibrary(bad); err == nil {
		t.Fatal("版本 99 應該被拒絕，卻解碼成功")
	} else {
		t.Logf("如期拒絕：%v", err)
	}
	if got := PeekVersion(bad); got != 99 {
		t.Errorf("PeekVersion：want 99 got %d", got)
	}
}

// TestSanitySpotChecks 是幾個「人看得懂」的定點檢查。
//
// 差分測試保證「與 JS 一致」，但不保證「與事實一致」——萬一 JS 與 Go 一起錯呢？
// 這幾筆是文件上寫死的已知事實（`format.md`、`pinxing.md` 的實測值），
// 拿來當第二道、獨立的防線。
func TestSanitySpotChecks(t *testing.T) {
	_, libBytes := loadGolden(t)
	lib, err := DecodeLibrary(libBytes)
	if err != nil {
		t.Fatal(err)
	}

	// 一（U+4E00）在庫裡，而且是「一般漢字」
	i, ok := IndexOfCodePoint(lib, 0x4e00)
	if !ok {
		t.Fatal("U+4E00 不在庫裡")
	}
	if !IsPlainIdeograph(lib, i) {
		t.Error("U+4E00 應該是一般漢字")
	}
	if got := CharOf(lib, i); got != "一" {
		t.Errorf("CharOf：want 一 got %q", got)
	}

	// 家族成員：同一個碼位的成員必須連續，且 pref 落在範圍內
	fi := FamilyOfIdx(lib, i)
	if fi < 0 {
		t.Fatal("U+4E00 應該有家族")
	}
	f := &lib.Families[fi]
	if f.Pref < 0 || f.Pref >= f.Count {
		t.Errorf("家族 pref 超出範圍：pref=%d count=%d", f.Pref, f.Count)
	}
	if i != f.Start+f.Pref {
		t.Errorf("IndexOfCodePoint 應該回傳家族的第 pref 個成員：i=%d start=%d pref=%d", i, f.Start, f.Pref)
	}

	// 每個字形的緊框都算過了，而且不是那個「沒排除 kind 0/9」的壞值
	// （早年 build-library 的 tightOf 算出 [0,0,200,200]，這裡抽樣確認沒有全庫都是它）
	full := 0
	for gi := range lib.Glyphs {
		tv := lib.Glyphs[gi].Tight
		if tv == [4]int32{0, 0, 200, 200} {
			full++
		}
	}
	if full*100/len(lib.Glyphs) > 20 {
		t.Errorf("有 %d / %d 個字形的緊框是 [0,0,200,200]——像是沒排除 kind 0/9", full, len(lib.Glyphs))
	}
	t.Logf("緊框為 [0,0,200,200] 的字形：%d / %d", full, len(lib.Glyphs))

	// 組字要用的事實：寶（U+5BF6）的部件圖應該找得到，且非空
	if bi, ok := IndexOfCodePoint(lib, 0x5bf6); ok {
		kids := ComponentKids(lib, bi)
		if len(kids) == 0 {
			t.Error("寶 的部件圖是空的")
		} else {
			var names []string
			for _, k := range kids {
				names = append(names, DisplayName(lib, k))
			}
			t.Logf("寶 的部件圖：%v", names)
		}
	} else {
		t.Error("U+5BF6 寶 不在庫裡")
	}
}

// ---------------------------------------------------------------------------
// 點名抽查：差分測試**不保證「與事實一致」**（萬一 JS 與 Go 一起錯呢？）。
// 這一組拿文件上真的當過案例的字，斷言**人看得懂的中間結果**。
// 來源：`pinxing.md`、`glyph-by-ids.md`、`format.md`、`progress/pinxing-技術總結.md`。
// ---------------------------------------------------------------------------

func TestSpotCheckVsGolden(t *testing.T) {
	g, libBytes := loadGolden(t)
	lib, err := DecodeLibrary(libBytes)
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Spot) == 0 {
		t.Fatal("golden 裡沒有 spot 段——重跑 bun run gocore/refdump.ts")
	}
	for _, s := range g.Spot {
		t.Run(s.Ch, func(t *testing.T) {
			got, ok := IndexOfCodePoint(lib, s.CP)
			if !ok {
				t.Fatalf("U+%X 不在庫裡", s.CP)
			}
			if got != s.Idx {
				t.Errorf("索引：want %d got %d", s.Idx, got)
			}
			tv := lib.Glyphs[got].Tight
			want := [4]int32{s.Tight[0], s.Tight[1], s.Tight[2], s.Tight[3]}
			if tv != want {
				t.Errorf("緊框：want %v got %v", want, tv)
			}
			if h := fnv1a32(ToKageData(&lib.Glyphs[got], lib)); h != s.KageHash {
				t.Errorf("KAGE hash：want %d got %d", s.KageHash, h)
			}
			kids := ComponentKids(lib, got)
			gotKids := make([]int32, 0, len(kids))
			for _, k := range kids {
				gotKids = append(gotKids, CodePointOf(lib, k))
			}
			cmpSlice(t, "kids", s.Kids, gotKids)
		})
	}
}

// TestDocumentedFacts 把文件上寫死的組字事實變成斷言。
//
// 這些不是「與 JS 一致」的問題，而是**這個庫到底是什麼**的問題：
// 如果哪天字庫重建後 `盟` 的部件不再是 `明 皿`，這裡會先叫，
// 而不是等到前端的部件清單看起來怪怪的才發現。
func TestDocumentedFacts(t *testing.T) {
	_, libBytes := loadGolden(t)
	lib, err := DecodeLibrary(libBytes)
	if err != nil {
		t.Fatal(err)
	}

	kidsOf := func(ch string) []int32 {
		i, ok := IndexOfChar(lib, ch)
		if !ok {
			t.Fatalf("%s 不在庫裡", ch)
		}
		var out []int32
		for _, k := range ComponentKids(lib, i) {
			out = append(out, CodePointOf(lib, k))
		}
		return out
	}

	cases := []struct {
		ch   string
		want []int32
		why  string
	}{
		{"盟", []int32{0x660E, 0x76BF}, "盟 ＝ 明 ＋ 皿（組字結構文件的例子）"},
		{"邏", []int32{0x8FB6, 0x7F85}, "邏 ＝ 辶 ＋ 羅（拼形序範例的基字）"},
		{"幸", []int32{0x571F, 0x22189}, "幸 的 IDS 是 [土 𢆉]（孫級部件推斷的由來）"},
		{"街", []int32{0x884C, 0x572D}, "街 ＝ 行 ＋ 圭（配框案例：街圭舞）"},
		{"峰", []int32{0x5C71, 0x5906}, "峰 ＝ 山 ＋ 夆（配框案例：峰夆水）"},
		{"寶", []int32{0x21A67, 0x8C9D}, "寶 ＝ 𡪓 ＋ 貝（𡪓 是推不出槽位的那一個）"},
		{"進", []int32{0x8FB6, 0x96B9}, "進 ＝ 辶 ＋ 隹（辶 是相容碼位案例）"},
		{"林", []int32{0x6728, 0x6728}, "林 ＝ 木 木（**重複要保留**）"},
		{"杏", []int32{0x6728, 0x53E3}, "杏 ＝ 木 ＋ 口（KAGE 畫成筆劃、靠 IDS 補的一類）"},
		{"一", nil, "一 是獨體字，沒有部件"},
		{"土", nil, "土 是獨體字，沒有部件"},
		{"木", nil, "木 是獨體字，沒有部件"},
	}
	for _, c := range cases {
		got := kidsOf(c.ch)
		if len(got) != len(c.want) {
			t.Errorf("%s：want %v got %v（%s）", c.ch, c.want, got, c.why)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("%s：want %v got %v（%s）", c.ch, c.want, got, c.why)
				break
			}
		}
	}

	// 幾何常識：`一` 的緊框必須是**一條細橫**（上下緣同高），否則緊框的推導壞了
	if i, ok := IndexOfChar(lib, "一"); ok {
		tv := lib.Glyphs[i].Tight
		if tv[1] != tv[3] {
			t.Errorf("一 的緊框應該是一條橫線（y1 == y2），得到 %v", tv)
		}
		if tv[0] >= tv[2] {
			t.Errorf("一 的緊框左右顛倒：%v", tv)
		}
	} else {
		t.Error("一 不在庫裡")
	}

	// 檢索要用的事實：`辶` 這種常用部件必須查得到（`?comp=辶` 的動線）
	if i, ok := IndexOfChar(lib, "辶"); ok {
		if CodePointOf(lib, i) != 0x8FB6 {
			t.Errorf("辶 的碼位不對：U+%X", CodePointOf(lib, i))
		}
	} else {
		t.Error("辶 不在庫裡——`?comp=辶` 的動線會壞掉")
	}
}
