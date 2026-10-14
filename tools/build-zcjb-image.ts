#!/usr/bin/env bun
/**
 * 第 160 輪：產生**招財進寶的 IDS 圖**（庫存第三筆的縮圖 ✓）。
 *
 * ## 為什麼（目標的第二句 ✗）
 *
 * 目標有兩句 ✓：
 *   ① 「從 IDS 產生……字形」 ✓（徒兒做了 22 輪 ✓）
 *   ② 「**讓用戶體驗到今法對古法的改善**」 ✗ —— **徒兒還沒交付** ✗
 *
 * 頁面的庫存有 **2 筆**合文（五行 ✓、好學孔孟 ✓）—— 每一筆的縮圖是
 * **古法（IDS 等比分配）的醜字** ✓，客人一點就看到它 ✓、再用 🪄 看今法 ✓。
 * **招財進寶不在裡面** ✗ —— 而它是專案的**聖杯** ✓（`project.md` 的第一個例子 ✓）。
 *
 * 所以這一支產生 `zcjb.png` ✓，讓 `build-pinxing.ts` 打包進頁面 ✓。
 *
 * 用法: bun run tools/build-zcjb-image.ts
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { loadLibrary } from "./lib-load.ts";
import { evalSeq } from "./free-compose.ts";
import { ensureEngine, svgOf } from "./compose-fit.ts";
import { idsGlyph } from "./ids-glyph.ts";

const ROOT = resolve(import.meta.dir, "..");
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();

/* 6 葉 IDS 從文檔讀 ✓（不手打 ✓） */
const OP = "\u2FF0\u2FF1\u2FF2\u2FF3\u2FF4\u2FF5\u2FF6\u2FF7\u2FF8\u2FF9\u2FFA\u2FFB";
const re = /[\u2FF0-\u2FFB][\u2FF0-\u2FFB\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2FFFF}]+/u;
let IDS = "";
for (const line of readFileSync(resolve(ROOT, "glyph-by-ids.md"), "utf8").split(/\r?\n/)) {
  const m = re.exec(line);
  if (m && Array.from(m[0]).filter((c) => !OP.includes(c)).length >= 6) { IDS = m[0]; break; }
}
/* 正解序從頁面讀 ✓（它是專案認定的最佳答案 ✓） */
let GOOD = "";
{
  const page = readFileSync(resolve(ROOT, "tools/pinxing-page.js"), "utf8");
  for (const mm of page.matchAll(/"([\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2FFFF}]{8,})"/gu)) {
    if (evalSeq(lib, mm[1]!, {}).ok) { GOOD = mm[1]!; break; }
  }
}
const a = idsGlyph(IDS, lib);
if (!a.ok) throw new Error("古法造不出來：" + a.problems.join("；"));
if (!GOOD) throw new Error("找不到正解序");
console.log("IDS   " + IDS);
console.log("今法  " + GOOD);

const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
  'html,body{margin:0;background:#fff;width:240px;height:240px;overflow:hidden}' +
  'svg{width:240px;height:240px;display:block;background:#fff}' +
  '</style></head><body>' + svgOf(a.lib, a.idx) + '</body></html>';
const pg = resolve(ROOT, "out/_zcjb.html");
writeFileSync(pg, html, "utf8");
const shot = resolve(ROOT, "zcjb.png");
if (existsSync(shot)) unlinkSync(shot);
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
Bun.spawnSync([EDGE, "--headless", "--disable-gpu", "--screenshot=" + shot, "--window-size=240,240",
  "--hide-scrollbars", "--default-background-color=FFFFFFFF",
  "--virtual-time-budget=6000", "file:///" + pg.replace(/\\/g, "/")],
  { stdout: "ignore", stderr: "ignore" });
console.log(existsSync(shot) ? "圖：" + shot : "截圖失敗 ✗");
