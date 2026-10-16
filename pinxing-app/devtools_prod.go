//go:build production

package main

// devTools：正式建置（`-tags production`）關掉 DevTools。
//
// 為什麼要用 build tag 而不是寫死：這是**測試床**，診斷前端問題時 DevTools
// 幾乎是必要的；但正式產物不該留一個可以改動頁面的入口。
const devTools = false
