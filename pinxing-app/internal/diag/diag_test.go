package diag

import (
	"bytes"
	"errors"
	"io"
	"log"
	"os"
	"strings"
	"testing"
	"time"
)

// failWriter 模擬「無效的 stderr」。
//
// GUI 子系統（`-H windowsgui`）的程式由檔案總管或 `cmd /c start` 啟動時，
// `os.Stderr` 就是一個無效的控制代碼，寫它會回錯誤。這正是底下那個 bug 的成因。
type failWriter struct{ calls int }

func (w *failWriter) Write(p []byte) (int, error) {
	w.calls++
	return 0, errors.New("The handle is invalid.")
}

// TestTeeWritesMainEvenWhenExtraFails 是這個 bug 的**回歸測試**。
//
// 真的踩過：寫成 `io.MultiWriter(os.Stderr, f)`，而 `io.MultiWriter` 遇到第一個
// 錯誤就返回——於是無效的 stderr 讓**檔案一個 byte 都拿不到**，
// 症狀是「`pinxing-app.log` 存在但是空的」。
//
// 這一條把「主要輸出必須拿到資料，即使附加輸出壞掉」釘住。
func TestTeeWritesMainEvenWhenExtraFails(t *testing.T) {
	var main bytes.Buffer
	bad := &failWriter{}
	w := teeBestEffort{main: &main, extra: bad}

	n, err := w.Write([]byte("hello"))
	if err != nil {
		t.Fatalf("主要輸出成功時不該回錯誤，得到 %v", err)
	}
	if n != 5 {
		t.Errorf("回傳的位元組數：want 5 got %d", n)
	}
	if main.String() != "hello" {
		t.Errorf("主要輸出沒拿到資料：%q", main.String())
	}
	if bad.calls != 1 {
		t.Errorf("附加輸出應該被嘗試一次，實際 %d 次", bad.calls)
	}
}

// TestTeeExtraNilOK：沒有附加輸出時也要正常。
func TestTeeExtraNilOK(t *testing.T) {
	var main bytes.Buffer
	w := teeBestEffort{main: &main}
	if _, err := w.Write([]byte("x")); err != nil {
		t.Fatalf("不該回錯誤：%v", err)
	}
	if main.String() != "x" {
		t.Errorf("主要輸出沒拿到資料：%q", main.String())
	}
}

// TestTeeReportsMainError：主要輸出真的壞了就要回報（那是 log 該知道的事）。
func TestTeeReportsMainError(t *testing.T) {
	w := teeBestEffort{main: &failWriter{}, extra: &bytes.Buffer{}}
	if _, err := w.Write([]byte("x")); err == nil {
		t.Error("主要輸出失敗時應該回錯誤")
	}
}

// TestInitLogDisabledTouchesNoFile 是「雙擊啟動不產生 .log」的回歸測試。
//
// 使用者要求：**雙擊不要在他旁邊留下日誌檔**，只有從命令列加參數才寫。
// 所以關閉時必須**完全不碰檔案系統**（連開檔都不試）。
//
// ⚠ 但**攔截器不可以跟著消失**：`patternWatcher` 是 GUI 程式唯一的失敗出口
// （Wails 在 WebView2 失敗時自己 `os.Exit(1)`，日誌與對話框是唯一能講話的管道）。
// 這一條用**型別斷言**把它釘住——那比「有沒有彈出對話框」可靠得多。
func TestInitLogDisabledTouchesNoFile(t *testing.T) {
	t.Setenv("PINXING_NO_DIALOG", "1") // 真的觸發時不要彈對話框卡住測試

	resetLogState()
	s := InitLog(false)

	if s.Path != "" {
		t.Errorf("關閉時不該有日誌路徑，得到 %q", s.Path)
	}
	if s.PrevFailed || s.PrevTail != "" {
		t.Error("關閉時沒有舊檔可讀，不該判定「上一次失敗」")
	}
	if LogPath() != "" {
		t.Errorf("LogPath 應該是空的，得到 %q", LogPath())
	}
	if currentFile() != nil {
		t.Error("關閉時不該開檔（currentFile 應為 nil）")
	}
	if logRequested {
		t.Error("logRequested 應該是 false，否則失敗訊息會說錯原因")
	}
	if _, ok := Writer().(*patternWatcher); !ok {
		t.Error("關閉日誌時仍然要裝 patternWatcher——那是失敗對話框唯一的出口")
	}
	// 寫進去不該 panic（輸出會被丟掉，但仍然經過攔截器）
	if _, err := Writer().Write([]byte("[WebView2 Error] 測試用\n")); err != nil {
		t.Errorf("寫入不該回錯：%v", err)
	}

	// 收尾：還原成「有日誌」的狀態，免得影響同一支測試檔後面的案例
	resetLogState()
	InitLog(true)
}

// resetLogState 把套件狀態清乾淨（只給測試用）。
func resetLogState() {
	mu.Lock()
	defer mu.Unlock()
	if logFile != nil {
		_ = logFile.Close()
	}
	logFile, logPath, out = nil, "", nil
	logRequested = false
}

// TestLogRequestedTracksEnabled：失敗訊息要靠它分辨「這次不寫」與「寫不進去」。
func TestLogRequestedTracksEnabled(t *testing.T) {
	t.Setenv("PINXING_NO_DIALOG", "1")
	resetLogState()
	InitLog(false)
	if logRequested {
		t.Error("InitLog(false) 之後 logRequested 應為 false")
	}
	resetLogState()
	InitLog(true)
	if !logRequested {
		t.Error("InitLog(true) 之後 logRequested 應為 true")
	}
}

// TestInitLogPersists 驗 InitLog 之後寫的每一行都真的落在檔案裡。
func TestInitLogPersists(t *testing.T) {
	s := InitLog(true)
	if s.Path == "" {
		t.Skip("這個環境建不出日誌檔")
	}
	log.Print("diag-test-marker")

	b, err := os.ReadFile(s.Path)
	if err != nil {
		t.Fatal(err)
	}
	txt := string(b)
	if !strings.Contains(txt, "--- 日誌開始 ---") {
		t.Errorf("日誌檔 %s 裡沒有 InitLog 的起始行；內容：%q", s.Path, txt)
	}
	if !strings.Contains(txt, "diag-test-marker") {
		t.Errorf("日誌檔 %s 裡找不到測試字串；內容前 200 字：%q", s.Path, firstN(txt, 200))
	}
}

// TestLogPathStableAfterInit：LogPath 要回報同一個路徑（Fatal／訊息要用它）。
func TestLogPathStableAfterInit(t *testing.T) {
	s := InitLog(true)
	if got := LogPath(); got != s.Path {
		t.Errorf("LogPath：want %q got %q", s.Path, got)
	}
}

// TestFinishWritesEndMarker 驗「正常結束」的記號真的會寫進去。
//
// 這條記號是「上一次是不是死在半路」的唯一依據，所以它壞掉就會讓
// 每一次啟動都誤報「上一次失敗」。
func TestFinishWritesEndMarker(t *testing.T) {
	s := InitLog(true)
	if s.Path == "" {
		t.Skip("這個環境建不出日誌檔")
	}
	Finish()
	b, err := os.ReadFile(s.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(strings.TrimSpace(string(b)), endMarker) {
		t.Errorf("日誌結尾應該是 %q；實際結尾：%q", endMarker, lastLines(string(b), 2))
	}
}

// TestPrevRunFailed 是「上一次失敗」判斷的表格測試。
//
// 這條判斷決定要不要在啟動時彈出「上一次啟動失敗」的對話框——
// 誤判（false positive）會讓每次啟動都多一個無意義的彈窗，
// 漏判（false negative）就等於使用者永遠看不到失敗原因。
func TestPrevRunFailed(t *testing.T) {
	cases := []struct {
		name string
		prev string
		want bool
	}{
		{"空字串（第一次跑）", "", false},
		{"只有空白", "  \r\n ", false},
		{"正常結束", "…\n" + endMarker + "\n", false},
		{"正常結束（結尾有換行）", endMarker + "\r\n", false},
		{"死在半路（有內容但沒有結束記號）", "=== 剎那拼形 啟動 ===\n[WebView2 Error] 800700aa\n", true},
		{"只有起始行", "--- 日誌開始 ---\n", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := prevRunFailed(c.prev); got != c.want {
				t.Errorf("prevRunFailed(%q)：want %v got %v", c.prev, c.want, got)
			}
		})
	}
}

// TestLastLines 驗「取最後 n 行」。
func TestLastLines(t *testing.T) {
	in := "a\nb\nc\nd\n"
	if got := lastLines(in, 2); got != "c\nd" {
		t.Errorf("want %q got %q", "c\nd", got)
	}
	if got := lastLines(in, 99); got != "a\nb\nc\nd" {
		t.Errorf("want 全部 got %q", got)
	}
	if got := lastLines("x\r\n", 3); got != "x" {
		t.Errorf("want %q got %q", "x", got)
	}
}

func firstN(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// TestPatternWatcherFiresOnFatalHint 驗「第一次執行就攔到」的機制。
//
// 這是使用者真正需要的那一條：Wails 會在 `app.Run()` 返回之前結束行程，
// 所以 `diag.Fatal` 的對話框跑不到；唯一的機會是在輸出流裡攔。
func TestPatternWatcherFiresOnFatalHint(t *testing.T) {
	ch := make(chan string, 4)
	pw := newPatternWatcher(io.Discard, func(recent string) { ch <- recent })

	// 一般輸出不該觸發
	if _, err := pw.Write([]byte("=== 剎那拼形 啟動 ===\n字庫已載入：4703188 bytes\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case s := <-ch:
		t.Fatalf("一般輸出不該觸發，卻收到：%q", s)
	case <-time.After(150 * time.Millisecond):
	}

	// 致命特徵要觸發，而且要把最近的輸出帶出去
	if _, err := pw.Write([]byte("[WebView2 Error] error creating controller with 800700aa: The requested resource is in use.\n")); err != nil {
		t.Fatal(err)
	}
	var got string
	select {
	case got = <-ch:
	case <-time.After(2 * time.Second):
		t.Fatal("致命特徵沒有觸發")
	}
	if !strings.Contains(got, "800700aa") {
		t.Errorf("帶出去的內容應該包含關鍵錯誤；實際：%q", got)
	}
	if !strings.Contains(got, "字庫已載入") {
		t.Errorf("帶出去的內容應該包含先前的輸出（才知道跑到哪一步）；實際：%q", got)
	}

	// 只觸發一次：不然每寫一行就彈一個對話框
	if _, err := pw.Write([]byte("[WebView2 Error] error creating controller with 800700aa\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case s := <-ch:
		t.Errorf("應該只觸發一次，又收到：%q", s)
	case <-time.After(200 * time.Millisecond):
	}
}

// TestPatternWatcherPassesThrough：監看不可以吃掉或改動輸出。
func TestPatternWatcherPassesThrough(t *testing.T) {
	var sink bytes.Buffer
	pw := newPatternWatcher(&sink, nil)
	const msg = "hello\n"
	n, err := pw.Write([]byte(msg))
	if err != nil || n != len(msg) {
		t.Fatalf("Write：n=%d err=%v", n, err)
	}
	if sink.String() != msg {
		t.Errorf("輸出被改動：%q", sink.String())
	}
}

// TestPatternWatcherNilHintOK：沒有回呼時不可以 panic。
func TestPatternWatcherNilHintOK(t *testing.T) {
	pw := newPatternWatcher(io.Discard, nil)
	if _, err := pw.Write([]byte("[WebView2 Error]\n")); err != nil {
		t.Fatal(err)
	}
}
