// Package diag —— 啟動期的診斷：**日誌檔** ＋ **失敗時讓使用者看得到原因**。
//
// # 為什麼需要這一支
//
// 這個 App 是 `-H windowsgui` 的 GUI 子系統程式：**它沒有主控台**。
// 所以任何「印到 stderr 然後結束」的失敗，使用者的體驗都是**一閃就沒了**——
// 沒有訊息、沒有事件記錄（正常的 `os.Exit` 不會留 Application Error）。
//
// 實際踩過：WebView2 建立 controller 失敗時 `app.Run()` 回錯誤，`log.Fatal` 印出
// 一大段堆疊之後結束；使用者只看到「閃退」，而那一段堆疊裡有全部答案。
//
// 所以 GUI 程式的失敗處理必須做兩件事：
//
//	① 寫進**檔案**（跑完之後還讀得到，也能請人回報）
//	② 用**對話框**講出來（當場就看得到，不必去找日誌）
//
// 這一包就是那兩件事。**不要**在 GUI 的進入點直接用 `log.Fatal`。
package diag

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var (
	mu      sync.Mutex
	logFile *os.File
	logPath string
	out     io.Writer
	// logRequested 記錄「呼叫端**要求**寫日誌嗎」，用來讓失敗訊息說得準確：
	// 「沒有日誌」有兩種原因——**這次本來就不寫**（雙擊）與**寫不進去**，
	// 講錯了會把使用者引到錯的方向（見 notifyFatal）。
	logRequested bool
)

// fileSink 是**主要**的輸出去處：檔案，而且**每一行都 Sync**。
//
// 為什麼每一行都要 Sync：這個行程隨時可能被外力結束（防毒、當掉、使用者按叉），
// 而我們要的正是「它死前寫到哪裡」。只交給 OS 快取的話，最關鍵的那幾行可能就沒了。
type fileSink struct{ f *os.File }

func (s fileSink) Write(p []byte) (int, error) {
	n, err := s.f.Write(p)
	_ = s.f.Sync()
	return n, err
}

// teeBestEffort 把每一行寫給 main（權威），再**盡力**寫給 extra。
//
// ⚠ **順序與錯誤處理都是刻意的，改動前先讀完這段。**
//
// GUI 子系統的程式由檔案總管（或 `cmd /c start`）啟動時，**`os.Stderr` 是無效的
// 控制代碼**，寫它會回錯誤。而 `io.MultiWriter` 的語意是「遇到第一個錯誤就返回」，
// 所以寫成 `io.MultiWriter(os.Stderr, f)` 的話，**檔案一個 byte 都拿不到**——
// 症狀正是「`pinxing-app.log` 存在但是空的」（真的踩過，而且第一次驗證時因為
// 用了 `-RedirectStandardError` 讓 stderr 有效，所以沒抓到）。
//
// 所以：**檔案先寫、stderr 只當附加、而且忽略它的錯誤。**
type teeBestEffort struct {
	main  io.Writer
	extra io.Writer
}

func (t teeBestEffort) Write(p []byte) (int, error) {
	n, err := t.main.Write(p)
	if t.extra != nil {
		_, _ = t.extra.Write(p) // 盡力而為；失敗不影響主要輸出
	}
	return n, err
}

// fatalHints 是「已經確定沒救、而且行程會在我們拿到控制權之前就結束」的訊息特徵。
//
// 為什麼要在**輸出流**裡攔：實測 WebView2 的 controller 建不起來時，Wails 會在
// `app.Run()` 返回之前就把行程結束掉——日誌裡既沒有「app.Run() 已返回」、
// 也沒有「致命錯誤」，所以 `diag.Fatal` 的對話框**根本沒機會出現**，
// 使用者只看到「閃退」。
//
// 所有輸出（我們的 `log` 與 Wails 的 slog）都經過同一個 writer，
// 所以在這裡攔是**最後一個**能講話的機會。
var fatalHints = []string{
	"error creating controller with",
	"error calling Webview2Loader",
	"[WebView2 Error]",
}

// patternWatcher 監看輸出；一旦出現 `fatalHints` 就**呼叫一次** onHint。
//
// ⚠ onHint 是**同步**呼叫的，而且這是刻意的（理由見 Write 裡）：行程會在
// errorCallback 之後立刻結束，用 goroutine 根本來不及把對話框彈出來。
type patternWatcher struct {
	w      io.Writer
	onHint func(recent string)
	once   sync.Once
	mu     sync.Mutex
	buf    []byte
}

const watcherBufBytes = 8 * 1024

func newPatternWatcher(w io.Writer, onHint func(recent string)) *patternWatcher {
	return &patternWatcher{w: w, onHint: onHint}
}

func (p *patternWatcher) Write(b []byte) (int, error) {
	n, err := p.w.Write(b)

	p.mu.Lock()
	p.buf = append(p.buf, b...)
	if len(p.buf) > watcherBufBytes {
		p.buf = p.buf[len(p.buf)-watcherBufBytes:]
	}
	recent := string(p.buf)
	hit := ""
	for _, h := range fatalHints {
		if strings.Contains(recent, h) {
			hit = h
			break
		}
	}
	p.mu.Unlock()

	if hit != "" && p.onHint != nil {
		p.once.Do(func() {
			// ⚠ **必須同步呼叫，不可以用 goroutine。**
			//
			// 直覺會想用 goroutine 以免卡住寫日誌的路徑，但實測那樣**贏不了**：
			// Wails 在 errorCallback 之後立刻結束行程，goroutine 還沒被排到就
			// 一起被殺了——對話框永遠不會出現（真的踩過）。
			//
			// 同步呼叫反而同時解決兩件事：對話框會出現，而且**因為它阻塞了這個
			// callback，行程就不會走到結束那一步**，使用者有時間讀。
			//
			// 這裡的阻塞是安全的：會走到這條路的訊息都是**已經沒救**的
			// （見 fatalHints），而且 notify 本身不寫日誌，不會遞迴。
			p.onHint(lastLines(recent, 14))
		})
	}
	return n, err
}

// endMarker 是「這一輪正常結束」的記號。**判斷上一次是不是死在半路全靠它**，
// 所以只有 `Finish()` 可以寫它。
const endMarker = "=== 正常結束 ==="

// Session 是一次啟動的日誌狀態。
type Session struct {
	// Path 是日誌檔路徑（空字串 ＝ 寫不進去）。
	Path string
	// PrevFailed 表示**上一次**啟動沒有正常結束（見 prevRunFailed）。
	PrevFailed bool
	// PrevTail 是上一次執行的結尾幾行，用來告訴使用者「上次死在哪」。
	PrevTail string
}

// InitLog 開日誌檔、把 `log` 接到它，並回傳這次啟動的日誌狀態。
//
// # enabled == false：**完全不碰檔案系統**
//
// 這是**預設**（雙擊啟動）——使用者不希望旁邊多一個 `.log`。
//
// ⚠ 但**致命特徵的攔截器照樣要裝** ✗ 不可以因為「不寫日誌」就少掉對話框：
// 那是 GUI 程式唯一的失敗出口（見 §3.3：Wails 在 WebView2 失敗時自己 `os.Exit(1)`，
// 日誌與對話框是唯一能講話的管道）。所以這一支改成包一層 `io.Discard`：
// **輸出丟掉，攔截留著**。
//
// 不讀舊檔、也不判定「上一次失敗」——沒有檔案就沒有證據，不該亂彈對話框。
//
// # enabled == true：路徑優先序
//
//  1. **exe 旁邊**（`pinxing-app.log`）——「單一 exe」的可攜性，最容易被找到
//  2. `%LOCALAPPDATA%\pinxing-app\pinxing-app.log`——exe 放在唯讀目錄時（例如 Program Files）
//  3. `%TEMP%`
//
// 全部都失敗時回傳零值：**日誌不是必要功能**，不該因為寫不進日誌就不啟動。
func InitLog(enabled bool) Session {
	mu.Lock()
	defer mu.Unlock()

	logRequested = enabled

	if logFile != nil {
		return Session{Path: logPath}
	}

	if !enabled {
		out = newPatternWatcher(io.Discard, func(recent string) {
			notify("剎那拼形 — 啟動失敗",
				"啟動失敗，而且失敗發生在程式能回報之前。\n\n最近的輸出：\n"+recent+
					"\n\n這次沒有寫日誌檔。要完整記錄，請從命令列加參數重跑：\n"+
					"    pinxing-app.exe --log")
		})
		log.SetOutput(out)
		log.SetFlags(log.LstdFlags | log.Lmicroseconds)
		return Session{}
	}

	for _, p := range candidatePaths() {
		// ⚠ 一定要在**開檔之前**讀舊內容：開檔用的是 append，
		//    讀的是「上一次」的結尾，順序反了就會讀到這次自己的第一行。
		prev := readTail(p, maxTailBytes)
		f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			continue
		}
		logFile, logPath = f, p
		out = newPatternWatcher(teeBestEffort{main: fileSink{f: f}, extra: os.Stderr},
			func(recent string) {
				body := "啟動失敗，而且失敗發生在程式能回報之前。\n\n最近的輸出：\n" + recent +
					"\n\n完整日誌：\n" + p
				notify("剎那拼形 — 啟動失敗", body)
			})
		log.SetOutput(out)
		log.SetFlags(log.LstdFlags | log.Lmicroseconds)

		s := Session{
			Path:       p,
			PrevFailed: prevRunFailed(prev),
			PrevTail:   lastLines(prev, 10),
		}
		// 立刻寫一行並落地：這樣「檔案存在但是空的」這種狀態本身就會說話
		// （＝連這一行都沒進去，那就是寫入層壞了，而不是程式沒跑到）。
		log.Printf("--- 日誌開始 ---")
		return s
	}
	return Session{}
}

// Finish 標記「這一輪正常結束」。**在 main 的最後呼叫**，別忘了——
// 少了它，下一次啟動就會被誤判成「上一次失敗」而彈出對話框。
func Finish() {
	log.Printf("%s", endMarker)
	if f := currentFile(); f != nil {
		_ = f.Sync()
	}
}

const maxTailBytes = 64 * 1024

func readTail(path string, max int64) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.Size() == 0 {
		return ""
	}
	if size := st.Size(); size > max {
		if _, err := f.Seek(size-max, io.SeekStart); err != nil {
			return ""
		}
	}
	b, err := io.ReadAll(f)
	if err != nil {
		return ""
	}
	return string(b)
}

// prevRunFailed 回報「上一次的日誌結尾」是否代表沒有正常結束。
func prevRunFailed(prev string) bool {
	t := strings.TrimSpace(prev)
	if t == "" {
		return false // 沒有上一次（第一次跑）→ 不算失敗
	}
	return !strings.HasSuffix(t, endMarker)
}

// lastLines 取最後 n 行（給「上一次失敗」的訊息用）。
func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\r\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	for i := range lines {
		lines[i] = strings.TrimRight(lines[i], "\r")
	}
	return strings.Join(lines, "\n")
}

func candidatePaths() []string {
	var out []string
	if exe, err := os.Executable(); err == nil {
		out = append(out, filepath.Join(filepath.Dir(exe), "pinxing-app.log"))
	}
	if dir, err := os.UserCacheDir(); err == nil {
		d := filepath.Join(dir, "pinxing-app")
		if err := os.MkdirAll(d, 0o755); err == nil {
			out = append(out, filepath.Join(d, "pinxing-app.log"))
		}
	}
	out = append(out, filepath.Join(os.TempDir(), "pinxing-app.log"))
	return out
}

// Writer 是「同一份輸出」的 writer，給 Wails 的 slog logger 用
// （`application.Options.Logger`）——這樣 **Wails 自己的訊息**（包含 WebView2 的錯誤）
// 也會進同一個日誌檔，而不只是我們的 log。
func Writer() io.Writer {
	mu.Lock()
	defer mu.Unlock()
	if out == nil {
		return os.Stderr
	}
	return out
}

// LogPath 回傳日誌檔路徑（沒有就是空字串）。
func LogPath() string {
	mu.Lock()
	defer mu.Unlock()
	return logPath
}

// Notify 彈一個**非致命**的對話框（失敗時才顯示的資訊、上一次執行的遺言…）。
//
// `PINXING_NO_DIALOG` 有設就什麼都不做（自動化用）。
func Notify(title, body string) {
	notify(title, body)
}

// Fatal 記錄失敗、**讓使用者看得到**，然後以 1 結束。
//
// 這是 GUI 程式唯一該用的致命錯誤出口（取代 `log.Fatal`）。
func Fatal(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	log.Printf("致命錯誤：%s", msg)
	// 先把日誌寫進磁碟，再彈對話框——對話框會 block 到使用者按下確定，
	// 那時候可能已經被工作管理員砍掉了。
	if f := currentFile(); f != nil {
		_ = f.Sync()
	}
	notifyFatal(msg, LogPath())
	os.Exit(1)
}

func currentFile() *os.File {
	mu.Lock()
	defer mu.Unlock()
	return logFile
}
