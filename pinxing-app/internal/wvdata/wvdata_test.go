package wvdata

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestProbeWritableOnRealDir：一個真正可寫的目錄要通過，而且**不可以留下垃圾**。
func TestProbeWritableOnRealDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sub")
	if err := ProbeWritable(dir); err != nil {
		t.Fatalf("可寫的目錄應該通過：%v", err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("目錄應該被建立：%v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("探測檔應該被清掉，卻留下 %d 個項目", len(entries))
	}
}

// TestProbeWritableFailsWhenPathIsAFile：路徑上擋著一個**檔案**時必須失敗。
//
// ⚠ 這裡刻意**不用** `MkdirAll(dir, 0o555)` 來模擬「不可寫」：
// 在 Windows 上目錄權限來自繼承的 ACL，`0o555` 根本不會讓它變唯讀
// （第一次寫這幾條測試時就是這樣，三條全部假通過之後才發現）。
func TestProbeWritableFailsWhenPathIsAFile(t *testing.T) {
	f := filepath.Join(t.TempDir(), "afile")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ProbeWritable(filepath.Join(f, "sub")); err == nil {
		t.Error("路徑上擋著檔案時應該失敗")
	}
}

// TestProbeWritableRejectsUnwritableDir 是這個套件存在的理由：
// **目錄已存在但不可寫**時 `MkdirAll` 會回 nil —— 只看它就會選到一個根本寫不進去的
// 目錄，而那正是 `800700aa` 的形狀。
//
// 在 Windows 上要用 ACL 才能造出這種目錄（`os.Chmod` 對目錄沒用），
// 所以這一條會呼叫 `icacls`；**權限不足就 skip**，不讓它變成不穩定的測試。
func TestProbeWritableRejectsUnwritableDir(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("只在 Windows 上驗 ACL 這一條")
	}
	name := os.Getenv("USERNAME")
	if name == "" {
		t.Skip("拿不到 USERNAME")
	}
	dir := filepath.Join(t.TempDir(), "ro")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	run := func(args ...string) (string, bool) {
		out, err := exec.Command("icacls", args...).CombinedOutput()
		return string(out), err == nil
	}

	if out, ok := run(dir, "/deny", name+":(OI)(CI)(W)"); !ok {
		t.Skipf("icacls /deny 不成功，跳過：%s", strings.TrimSpace(out))
	}
	// 一定要把 deny ACE 拿掉，否則 t.TempDir 的清尾會失敗
	t.Cleanup(func() { run(dir, "/remove:d", name) })

	if err := ProbeWritable(dir); err == nil {
		t.Error("不可寫的目錄應該被拒絕（這正是 MkdirAll 看不出來的那一種）")
	} else {
		t.Logf("如期拒絕：%v", err)
	}
}

// TestResolveFromPicksFirstWritable：ResolveFrom 要挑**第一個**可用的候選，
// 而且要把每一個候選的探測結果都回報出來（日誌要靠它說明發生了什麼）。
func TestResolveFromPicksFirstWritable(t *testing.T) {
	root := t.TempDir()
	good1 := filepath.Join(root, "good1")
	good2 := filepath.Join(root, "good2")
	// 「壞的」用一個路徑上擋著檔案的位置 —— 跨平台都會失敗
	blocker := filepath.Join(root, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	bad := filepath.Join(blocker, "sub")

	opts := []Option{
		{Label: "壞的", Path: bad},
		{Label: "好的1", Path: good1},
		{Label: "好的2", Path: good2},
	}
	chosen, tried := ResolveFrom(opts)
	if chosen != good1 {
		t.Errorf("應該挑第一個可用的 %q，得到 %q", good1, chosen)
	}
	// ⚠ **成功就停**：只會回報到被選中那一個為止（2 筆），不是全部 3 筆。
	if len(tried) != 2 {
		t.Fatalf("應該回報 2 個候選（壞的 ＋ 選中的），得到 %d", len(tried))
	}
	if tried[0].Err == nil {
		t.Error("第一個候選應該被標成失敗")
	}
	if !tried[1].Used || tried[1].Err != nil {
		t.Error("第二個候選應該被標成採用")
	}
	// 選中之後不該再探測後面的候選
	if _, err := os.Stat(good2); err == nil {
		t.Error("選中之後不該再探測後面的候選")
	}
}

// TestResolveFromAllFail：全部失敗要回空字串（讓 Wails 用它自己的預設，
// 而不是硬塞一個不能寫的路徑進去——那只會把症狀換成更難懂的錯誤）。
func TestResolveFromAllFail(t *testing.T) {
	root := t.TempDir()
	blocker := filepath.Join(root, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	chosen, tried := ResolveFrom([]Option{
		{Label: "壞的", Path: filepath.Join(blocker, "sub")},
		{Label: "空的", Path: ""},
	})
	if chosen != "" {
		t.Errorf("全部失敗時應該回空字串，得到 %q", chosen)
	}
	if len(tried) != 2 {
		t.Errorf("應該回報 2 個候選，得到 %d", len(tried))
	}
}

// TestCandidatesShape：候選清單的**順序**是介面的一部分——
// 第一個必須是 Wails 的預設，最後一個必須是 exe 旁邊（保底）。
func TestCandidatesShape(t *testing.T) {
	opts := Candidates("pinxing-app.exe")
	if len(opts) < 2 {
		t.Fatalf("候選太少：%d", len(opts))
	}
	if want := Default("pinxing-app.exe"); want != "" && opts[0].Path != want {
		t.Errorf("第一個候選應該是 Wails 的預設 %q，得到 %q", want, opts[0].Path)
	}
	exe, err := os.Executable()
	if err == nil {
		last := opts[len(opts)-1]
		if filepath.Dir(last.Path) != filepath.Dir(exe) {
			t.Errorf("最後一個候選應該是 exe 旁邊，得到 %q", last.Path)
		}
	}
}
