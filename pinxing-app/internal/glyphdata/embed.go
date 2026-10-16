// Package glyphdata —— 內嵌**精簡字形庫**，並在啟動時解壓一次。
//
// # 為什麼用 embed
//
// 目標是「**單一 exe、zero dependency**」：字庫不能是旁邊的一個檔案，
// 否則使用者就會遇到「exe 拿了、資料沒拿」的經典問題。
//
// # 為什麼內嵌 .gz 而不是 .bin
//
//	內嵌 .gz   2,327,989 bytes（exe 多 2.22 MB）＋ 啟動時解壓約 29 ms
//	內嵌 .bin  4,703,188 bytes（exe 多 4.49 MB）＋ 零成本
//
// 用 29 ms 換 2.22 MB，划算；而且解壓一次就結束，不是每次用到才付。
//
// # 交付給前端的方式
//
// 解壓後的位元組由 `main` 掛在 `/lib.bin` 這個路徑上，前端**一次 fetch 拿完**。
// 量測與取捨見 `gocore/cmd/libstats`；重點是**不走 Wails 的 binding**——
// binding 走 JSON 打包，4.49 MB 的位元組會膨脹好幾倍，而靜態資產就是一個 GET。
package glyphdata

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"io"
)

// lib-cjk-all.bin.gz 是 `out/lib-cjk-all.bin.gz` 的複本。
//
// ⚠ **它是產物、不入版控**（見 `.gitignore`）：`go:embed` 只能嵌模組目錄內的檔案，
// 而 `out/` 在模組外，所以需要一步複製。`build.ps1` 會做這件事。
// 檔案不在時 `go build` 會直接失敗並說找不到嵌入檔——那是**想要**的失敗方式。
//
//go:embed lib-cjk-all.bin.gz
var packed []byte

// bin 是解壓後的完整字庫（v6）。由 Load 填。
var bin []byte

// PackedSize 是內嵌（壓縮）位元組數 ＝ exe 為了字庫多出來的大小。
func PackedSize() int { return len(packed) }

// Load 解壓內嵌的字庫，回傳解壓後的位元組數。
//
// 在 `main` 一開始呼叫：這樣「字庫壞掉」會在**開檔時**大聲失敗，
// 而不是等到使用者第一次操作才發現畫面是空的。
func Load() (int, error) {
	if bin != nil {
		return len(bin), nil
	}
	zr, err := gzip.NewReader(bytes.NewReader(packed))
	if err != nil {
		return 0, fmt.Errorf("內嵌字庫的 gzip 標頭壞了：%w", err)
	}
	defer zr.Close()
	b, err := io.ReadAll(zr)
	if err != nil {
		return 0, fmt.Errorf("內嵌字庫解壓失敗：%w", err)
	}
	if len(b) == 0 {
		return 0, fmt.Errorf("內嵌字庫解壓後是空的")
	}
	bin = b
	return len(b), nil
}

// MustLoad 是 Load 的 panic 版（給「字庫是必要條件」的進入點與測試用）。
func MustLoad() int {
	n, err := Load()
	if err != nil {
		panic(err)
	}
	return n
}

// Bin 回傳解壓後的完整字庫。
//
// ⚠ 沒先 Load 就呼叫會 panic ——這是**刻意的**：靜默回傳一個 nil 會讓前端
// 拿到 0 bytes 而看起來像「載入很慢」，那種 bug 很難查。
func Bin() []byte {
	if bin == nil {
		panic("glyphdata.Bin() 在 Load() 之前被呼叫")
	}
	return bin
}

// SHA256Hex 回傳解壓後字庫的 sha256（十六進位小寫）。
//
// 用來把「這顆 exe 內嵌的是哪一份字庫」變成可以斷言的事實——
// 歷史上真的發生過 `.bin` 與 `.gz` 不同步而靜默錯位（見 `format.md`〈極難查的 bug〉）。
func SHA256Hex() string {
	sum := sha256.Sum256(Bin())
	return hex.EncodeToString(sum[:])
}
