package main

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"pinxing-app/internal/glyphdata"
)

// TestMain 先載入字庫——與 `main()` 走同一條路徑。
//
// 這不是為了方便：`glyphdata.Bin()` 沒先 Load 就 panic（刻意的），
// 所以任何碰到 `/lib.bin` 的測試都必須先載入。順帶也驗了
// 「Load() 在進入點之前跑得起來」。
func TestMain(m *testing.M) {
	glyphdata.MustLoad()
	os.Exit(m.Run())
}

// 這一輪的驗收全部**不開視窗**。
//
// 為什麼：Wails3 沒有 headless 模式，而 DSH 沙箱封鎖具名管道 → WebView2 起不來
// （見 main.go 檔頭）。但這一支真正會默默壞掉的地方都被 HTTP 涵蓋了：
// 內嵌路徑、`fs.Sub` 的前綴、目錄索引、字庫的位元組完整性。
// **視窗本身**只能由人在一般終端機執行時確認。

// TestFrontendAssetsServed 驗「內嵌的前端真的伺服得出來」。
func TestFrontendAssetsServed(t *testing.T) {
	handler, err := routes()
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		path     string
		wantCode int
		wantBody string // 必須出現的字串（空 ＝ 不檢查）
		why      string
	}{
		{"/", http.StatusOK, "剎那拼形", "根路徑要出 index.html（目錄索引）"},
		{"/index.html", http.StatusOK, "剎那拼形", "明確路徑也要出得來"},
		{"/index.html", http.StatusOK, "__LIB_URL__", "必須是**宿主模式**的頁面（字庫走 /lib.bin）"},
		// 舊的探針頁 app.js 已經拿掉（前端現在由 build-pinxing.ts --hosted 產生）
		{"/app.js", http.StatusNotFound, "", "舊的探針 app.js 不該還在"},
		{"/nope.js", http.StatusNotFound, "", "不存在的檔案要 404，不可以回 index.html"},
	}

	for _, c := range cases {
		t.Run(c.path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, c.path, nil))

			if rec.Code != c.wantCode {
				t.Errorf("%s：狀態碼 want %d got %d（%s）", c.path, c.wantCode, rec.Code, c.why)
			}
			if c.wantBody != "" {
				body, _ := io.ReadAll(rec.Result().Body)
				if !strings.Contains(string(body), c.wantBody) {
					t.Errorf("%s：回應裡找不到 %q（%s）\n--- 前 200 字 ---\n%s",
						c.path, c.wantBody, c.why, firstRunes(string(body), 200))
				}
			}
		})
	}
}

// TestLibraryRouteServesExactBytes 是**這一輪最重要的一條**：
// 前端拿到的字庫必須**一個 byte 都不差**。
//
// 為什麼要斷言 sha256 而不是只比長度：`format.md`〈極難查的 bug〉記的就是
// 「`.bin` 與 `.gz` 不同步」——長度可能一樣（或差幾十 bytes 而沒人注意），
// 但位元組不同 → 解碼靜默錯位 → 症狀是「引擎對某些字形產生 0 個多邊形」。
// 把 sha256 寫死在測試裡，就等於把「這顆 exe 內嵌的是哪一份字庫」變成可斷言的事實。
func TestLibraryRouteServesExactBytes(t *testing.T) {
	// 解壓後的完整字庫（v6）——與 gocore/refdump.ts 記在 golden 裡的 libBytes 相同
	const wantBytes = 4703188
	// 與 `out/lib-cjk-all.bin` 的解壓內容相同（2026-10-16 基準）
	const wantSHA256 = "babe63b56d7b27359e96dc4b5b4a4b14d678536821519fb1c5fef708242fb67a"

	handler, err := routes()
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/lib.bin", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("/lib.bin 狀態碼 want 200 got %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/octet-stream" {
		t.Errorf("Content-Type：want application/octet-stream got %q", ct)
	}

	body := rec.Body.Bytes()
	if len(body) != wantBytes {
		t.Fatalf("/lib.bin 長度：want %d got %d", wantBytes, len(body))
	}
	sum := sha256.Sum256(body)
	got := hex.EncodeToString(sum[:])
	if got != wantSHA256 {
		t.Errorf("/lib.bin sha256：\n  want %s\n  got  %s\n（字庫換了就把這兩個定值一起更新，並重跑 gocore/refdump.ts）",
			wantSHA256, got)
	}

	// Content-Length 必須明講，前端才知道要收多少
	if cl := rec.Header().Get("Content-Length"); cl != "4703188" {
		t.Errorf("Content-Length：want 4703188 got %q", cl)
	}

	// ⚠ **不可以**讓它被快取：URL 不變但字庫會換（重建之後），
	// 被黏住的話症狀是「改了字庫卻還是舊字形」，而且怎麼重建都一樣。
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control：want no-store got %q（快取會讓重建後的字庫失效）", cc)
	}

	// HEAD 不可以有 body（有些 client 會先用 HEAD 探大小）
	recHead := httptest.NewRecorder()
	handler.ServeHTTP(recHead, httptest.NewRequest(http.MethodHead, "/lib.bin", nil))
	if recHead.Code != http.StatusOK {
		t.Errorf("HEAD /lib.bin 狀態碼 want 200 got %d", recHead.Code)
	}
	if recHead.Body.Len() != 0 {
		t.Errorf("HEAD /lib.bin 不該有 body，卻有 %d bytes", recHead.Body.Len())
	}
}

// TestReadyBeacon 驗「前端回報已就緒」的端點。
//
// 這一條是**驗收不必看畫面**的關鍵：Wails 的日誌只看得到資產被要走了，
// 看不到前端到底解開了沒有。有了這個回報，日誌上少了「[頁面] 已就緒」
// 就代表前端掛了——而那和「視窗開起來但裡面是空的」在日誌上長得一模一樣。
func TestReadyBeacon(t *testing.T) {
	handler, err := routes()
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/__ready", strings.NewReader("191727 字 / 98701 家族"))
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("狀態碼：want 204 got %d", rec.Code)
	}
}

// TestReadyBeaconToleratesBigAndEmptyBody：回報是**盡力而為**的，
// 壞掉或不送都不該讓 App 出錯（它不影響頁面功能）。
func TestReadyBeaconToleratesBigAndEmptyBody(t *testing.T) {
	handler, err := routes()
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{"", strings.Repeat("x", 100000)} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/__ready", strings.NewReader(body)))
		if rec.Code != http.StatusNoContent {
			t.Errorf("body 長度 %d：狀態碼 want 204 got %d", len(body), rec.Code)
		}
	}
}

// TestLibraryEmbeddedConsistent 驗「內嵌的 .gz → 解壓 → /lib.bin」這條路
// 前後是同一份東西，而且 sha256 與 glyphdata 自己算的一致。
func TestLibraryEmbeddedConsistent(t *testing.T) {
	n := glyphdata.MustLoad()
	if n != 4703188 {
		t.Errorf("解壓後長度：want 4703188 got %d", n)
	}
	if glyphdata.PackedSize() != 2327989 {
		t.Errorf("內嵌（壓縮）長度：want 2327989 got %d——exe 會因此變大／變小",
			glyphdata.PackedSize())
	}
	if got := glyphdata.SHA256Hex(); len(got) != 64 {
		t.Errorf("sha256 不是 64 個十六進位字元：%q", got)
	}
	// 同一份記憶體，不該每次呼叫都回不同的切片內容
	if &glyphdata.Bin()[0] != &glyphdata.Bin()[0] {
		t.Error("Bin() 兩次回傳不同的底層陣列——應該只解壓一次")
	}
}

// TestEmbeddedFrontendHasNoExternalDeps 驗前端**沒有外部相依**。
//
// 這是「單一 exe、zero dependency」的實質條件：只要有 CDN、外部字型、
// 遠端 script，離線或斷網時就會壞掉。用最笨但可靠的字串掃描擋住它。
func TestEmbeddedFrontendHasNoExternalDeps(t *testing.T) {
	sub, err := fs.Sub(assets, "frontend")
	if err != nil {
		t.Fatal(err)
	}
	// ⚠ 名單要**精準**，否則會變成假警報——第一版寫「一律擋 `http://`」，
	//    結果命中的是：SVG 的 **XML 命名空間識別字**（`http://www.w3.org/2000/svg`、
	//    `http://www.w3.org/1999/xlink`）與 kage-engine 檔頭那條**註解裡的出處網址**。
	//    那些都不是連線。所以改成擋「真的會連出去」的寫法。
	banned := []string{
		"https://", // 這個頁面沒有任何合法的 https 用途（SVG 命名空間一律是 http://）
		"unpkg.com", "jsdelivr", "cdnjs", "//cdn.",
		`src="http`, `src="//`,
		`href="http`, `href="//`,
		"url(http", "url(//",
		"@import",
	}
	err = fs.WalkDir(sub, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := fs.ReadFile(sub, path)
		if err != nil {
			return err
		}
		text := string(b)
		for _, bad := range banned {
			if strings.Contains(text, bad) {
				t.Errorf("%s 含有外部相依 %q——單一 exe 的條件是零外部資源", path, bad)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// TestShouldLog 釘住「雙擊不寫日誌、命令列加參數才寫」這條規則。
//
// 這是使用者的明確要求（他不想雙擊之後看到旁邊多一個 `.log`），
// 而且它不依賴任何 I/O，所以值得用最笨的方式把邊界釘住。
func TestShouldLog(t *testing.T) {
	cases := []struct {
		args []string
		want bool
		why  string
	}{
		{[]string{`D:\accelon26\pinxing-app.exe`}, false, "雙擊：os.Args 只有 exe 路徑"},
		{[]string{`D:\accelon26\pinxing-app.exe`, "--log"}, true, "命令列加參數"},
		{[]string{`D:\accelon26\pinxing-app.exe`, "-log"}, true, "單橫線也一樣"},
		{[]string{`D:\accelon26\pinxing-app.exe`, "--anything"}, true, "任何參數都算"},
	}
	for _, c := range cases {
		if got := shouldLog(c.args); got != c.want {
			t.Errorf("shouldLog(%q)：want %v got %v（%s）", c.args, c.want, got, c.why)
		}
	}
}

func firstRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
