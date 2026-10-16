// libstats — 字庫的統計與**傳輸量評估**。
//
// 為什麼要有這一支：Wails3 版要把字庫送進 JS context。有兩條路——
//
//	A. 送**原始 .bin 位元組**，讓 JS 用它現有的 `decodeLibrary()` 自己解（4.70 MB）
//	B. Go 先解好，送**解碼後的平面資料**（JS 不必再解，直接包成物件）
//
// 這一支把兩邊的**實際大小與耗時**印出來，讓那個決定有數字可依，不是憑感覺。
//
// 用法:
//
//	cd gocore
//	go run ./cmd/libstats                       # 讀 testdata/lib-cjk-all.bin
//	go run ./cmd/libstats -lib ../out/lib-cjk-all.bin
//	go run ./cmd/libstats -lib ../out/lib-cjk-all.bin.gz
package main

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"flag"
	"fmt"
	"os"
	"runtime"
	"time"

	"gocore/lib"
)

func main() {
	path := flag.String("lib", "testdata/lib-cjk-all.bin", "字庫檔（.bin 或 .bin.gz）")
	flag.Parse()

	raw, err := os.ReadFile(*path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "讀不到 %s：%v\n", *path, err)
		os.Exit(2)
	}
	isGz := len(raw) >= 2 && raw[0] == 0x1f && raw[1] == 0x8b
	bytesOnDisk := len(raw)

	fmt.Printf("檔案      %s\n", *path)
	fmt.Printf("          磁碟上 %d bytes（%s）\n", bytesOnDisk, gzName(isGz))

	t0 := time.Now()
	b := raw
	if isGz {
		zr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			fmt.Fprintln(os.Stderr, "gunzip 失敗：", err)
			os.Exit(2)
		}
		b, err = readAll(zr)
		if err != nil {
			fmt.Fprintln(os.Stderr, "gunzip 失敗：", err)
			os.Exit(2)
		}
	}
	gunzipMs := ms(t0)
	fmt.Printf("          解壓後 %d bytes（%.1f ms）\n", len(b), gunzipMs)
	fmt.Printf("          版本   v%d\n", lib.PeekVersion(b))

	// ---- Go 解碼 ----
	t0 = time.Now()
	L, err := lib.DecodeLibrary(b)
	if err != nil {
		fmt.Fprintln(os.Stderr, "解碼失敗：", err)
		os.Exit(2)
	}
	decodeMs := ms(t0)
	fmt.Printf("解碼      %.1f ms（Go）\n", decodeMs)

	// 解碼後的實際記憶體佔用（必須在 L 還活著時量；等到後面才量會被 GC 收走）
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	heapAfterDecode := m.HeapAlloc

	// ---- 結構統計 ----
	var strokes, refStrokes, points int
	for gi := range L.Glyphs {
		for si := range L.Glyphs[gi].Strokes {
			s := &L.Glyphs[gi].Strokes[si]
			strokes++
			if s.Kind == 99 {
				refStrokes++
			} else {
				points += lib.PtCountOf(s.Kind)
			}
		}
	}
	fmt.Printf("字形      %d（家族 %d、orphanStart %d）\n", len(L.Glyphs), len(L.Families), L.OrphanStart)
	fmt.Printf("筆畫      %d（其中引用 %d ＝ %.1f%%）\n", strokes, refStrokes, pct(refStrokes, strokes))
	fmt.Printf("IDS 分量  %d 筆　syn %d　phil %d\n", len(L.Comp), len(L.Syn), len(L.Phil))

	// ---- 路 A：原始位元組 ----
	// 已經量到了：len(b) 就是要送給 JS 的位元組數，然後由 JS 自己 decode。
	fmt.Printf("\n[A] 送原始位元組，JS 自己 decodeLibrary()\n")
	fmt.Printf("    傳輸量  %d bytes（%.2f MB）\n", len(b), mb(len(b)))
	fmt.Printf("    JS 成本 約 200 ms（以 bun 實測；見 refdump 的「解碼」那行）\n")

	// ---- 路 B：送解碼後的平面資料 ----
	//
	// 格式（刻意用**固定寬度 int32**，因為接收端要的是能直接包成 TypedArray 的東西，
	// 不是再叫人解一次 varint）：
	//   檔頭：glyphCount
	//   每字形：strokeCount
	//   每筆畫：一般筆 = kind,width,style,8×座標        = 11 個 int32
	//          引用筆 = kind,ref,flags,4×box,4×stretch  = 11 個 int32（剛好一樣寬）
	//
	// ⚠ 引用筆也要 8 個座標欄位才「忠實」嗎？不必——JS 的 `readBodies` 對引用筆
	//   是把 `points` 指向 `box`（4 個），所以 11 個欄位剛好一樣寬是**巧合但正確**的。
	flatInts := 1 + len(L.Glyphs) + strokes*11
	flatBytes := flatInts * 4

	// 實際做一次（不只用算的），順便量 gzip 後的大小
	buf := make([]byte, 0, flatBytes)
	var tmp [4]byte
	put := func(v int32) {
		binary.LittleEndian.PutUint32(tmp[:], uint32(v))
		buf = append(buf, tmp[:]...)
	}
	t0 = time.Now()
	put(int32(len(L.Glyphs)))
	for gi := range L.Glyphs {
		g := &L.Glyphs[gi]
		put(int32(len(g.Strokes)))
		for si := range g.Strokes {
			s := &g.Strokes[si]
			put(s.Kind)
			if s.Kind == 99 {
				put(s.Ref)
				var flags int32
				if s.Box == [4]int32{0, 0, 200, 200} {
					flags |= 1 // isFull
				}
				if s.Stretch == [4]int32{0, 0, 0, 0} {
					flags |= 2 // noStretch
				}
				put(flags)
				put(s.Box[0])
				put(s.Box[1])
				put(s.Box[2])
				put(s.Box[3])
				put(s.Stretch[0])
				put(s.Stretch[1])
				put(s.Stretch[2])
				put(s.Stretch[3])
			} else {
				put(s.Width)
				put(s.Style)
				for i := 0; i < 8; i++ {
					put(s.Points[i])
				}
			}
		}
	}
	serializeMs := ms(t0)

	t0 = time.Now()
	gz := gzipBytes(buf)
	gzipMs := ms(t0)

	fmt.Printf("\n[B] Go 解好，送解碼後的平面資料（固定寬度 int32）\n")
	fmt.Printf("    傳輸量  %d bytes（%.2f MB）＝ 路 A 的 %.2f 倍\n",
		len(buf), mb(len(buf)), float64(len(buf))/float64(len(b)))
	fmt.Printf("    gzip 後 %d bytes（%.2f MB）＝ 路 A 的 %.2f 倍（%.1f ms 壓縮）\n",
		len(gz), mb(len(gz)), float64(len(gz))/float64(len(b)), gzipMs)
	fmt.Printf("    Go 成本  解碼 %.1f ms ＋ 序列化 %.1f ms ＝ %.1f ms\n", decodeMs, serializeMs, decodeMs+serializeMs)
	fmt.Printf("    JS 成本  0（直接包成 TypedArray，不必再解格式）\n")

	// ---- 對照 ----
	fmt.Printf("\n對照\n")
	fmt.Printf("    磁碟上的 .gz        %d bytes（%.2f MB）\n", bytesOnDisk, mb(bytesOnDisk))
	fmt.Printf("    Go 解碼後的堆用量   %.1f MB（解碼後的物件比位元流大得多）\n", mb(int(heapAfterDecode)))
	fmt.Printf("    筆畫總數            %d（引用 %d ＝ %.1f%%、原始筆畫 %d）\n",
		strokes, refStrokes, pct(refStrokes, strokes), strokes-refStrokes)
	fmt.Printf("    原始筆畫的有效點數  %d（其餘是格式補位，不能當座標用）\n", points)

	// ---- 建議 ----
	fmt.Printf("\n結論\n")
	fmt.Printf("    B 的傳輸量是 A 的 %.2f 倍（gzip 後 %.2f 倍），\n",
		float64(len(buf))/float64(len(b)), float64(len(gz))/float64(len(b)))
	fmt.Printf("    但只省下約 200 ms 的 JS 解碼，代價是 Go 端多花 %.0f ms 壓縮，\n", gzipMs)
	fmt.Printf("    而且 JS 收到平面資料後**還是要建 19 萬個字形物件**——那才是解碼的主要成本。\n")
	fmt.Printf("    反倒是 A 讓前端的 `decodeLibrary()` **一行都不用改**（單一來源、零分歧風險）。\n")
	fmt.Printf("    → 走 A：exe 內嵌 .gz（%.2f MB），開檔時 Go 解壓 %.0f ms，一次把 %d bytes 交給 JS。\n",
		mb(bytesOnDisk), gunzipMs, len(b))
}

func gzName(isGz bool) string {
	if isGz {
		return "gzip"
	}
	return "未壓縮"
}

func mb(n int) float64       { return float64(n) / 1024 / 1024 }
func pct(a, b int) float64   { return float64(a) * 100 / float64(b) }
func ms(t time.Time) float64 { return float64(time.Since(t).Microseconds()) / 1000 }

func readAll(r interface{ Read([]byte) (int, error) }) ([]byte, error) {
	var buf bytes.Buffer
	_, err := buf.ReadFrom(readerOnly{r})
	return buf.Bytes(), err
}

type readerOnly struct {
	r interface{ Read([]byte) (int, error) }
}

func (o readerOnly) Read(p []byte) (int, error) { return o.r.Read(p) }

func gzipBytes(b []byte) []byte {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(b); err != nil {
		panic(err)
	}
	if err := zw.Close(); err != nil {
		panic(err)
	}
	return buf.Bytes()
}
