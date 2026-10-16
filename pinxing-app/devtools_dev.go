//go:build !production

package main

// devTools：開發建置（沒有 `production` tag）開 DevTools，方便當場看前端。
//
// 正式建置請加 `-tags production`（`build.ps1` 預設就是這樣）——
// 那時 DevTools 會關掉，見 devtools_prod.go。
const devTools = true
