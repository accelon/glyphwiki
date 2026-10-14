#!/usr/bin/env bun
/**
 * shot-browser.ts — 對 `out/glyph-browser.html` 的幾個狀態截圖。
 *
 * 驗收（`check-browser.ts`）只截最後一個狀態；這裡另外把「開頁預設」與
 * 「部件搜尋」兩個狀態也截下來，給師父看介面。
 *
 * 用法: bun run tools/shot-browser.ts
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PAGE = resolve(ROOT, "out/glyph-browser.html");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
if (!existsSync(EDGE)) { console.log("找不到 Edge"); process.exit(1); }
const html = readFileSync(PAGE, "utf8");

const SHOTS: [string, string, string][] = [
  ["glyph-browser-shot-default.png", "開頁預設：選取 BMP，每一格都標碼位",
   ""],
  ["glyph-browser-shot-multi.png", "搜尋「口木」：先列出輸入的部件本身（虛線＋小點），後面才是結果",
   /* drawBlocks() 會整個重繪清單，舊的 NodeList 會變成脫離文件的節點、
      click 不會冒泡到 #blocks，所以每次都要重新查。 */
   `document.querySelectorAll("#blocks .blk")[1].click();
    document.querySelectorAll("#blocks .blk")[2].click();
    var box=document.getElementById("comp");
    box.value="\\u53E3\\u6728"; box.dispatchEvent(new Event("input"));
    var jb=document.getElementById("comp");`],
  ["glyph-browser-shot-stack.png", "詳細區是卡片堆疊：點部件往下多疊一張，每張都能單獨關掉",
   `var box=document.getElementById("comp");
    box.value="U+6E56"; box.dispatchEvent(new Event("input"));   /* 湖 */
    /* 每次都要**重新查**：renderCards() 會換掉 innerHTML，舊的 NodeList 會變成
       脫離文件的節點，對它 click 不會冒泡到 #detail。 */
    function tapLast(){
      var m=document.querySelectorAll("#detail .card:last-child .secParts .mini");
      if(m.length) m[m.length-1].click();
    }
    tapLast(); tapLast(); tapLast();
    var d=document.getElementById("detail"); d.scrollTop=0;`],
  ["glyph-browser-shot-thick.png", "「設置」下拉：字體大小／筆劃粗細／描邊收在一起（圖為筆劃 190%）",
   `var jb=document.getElementById("comp");
    jb.value="U+6C34"; jb.dispatchEvent(new Event("input"));
    var w=document.getElementById("wscale");w.value="190";w.dispatchEvent(new Event("input"));
    document.getElementById("setBtn").click();`],
];

for (const [out, _note, body] of SHOTS) {
  // 探針只能用**單層 setInterval**：多層巢狀 setTimeout 在 headless 下會被截斷
  // （`check-codemirror.ts` 已經踩過同一個坑並記在同一句話裡）。
  // 先前用遞迴 setTimeout 等 __READY__，剛好只在「第一呼就緒」時才會動，
  // 所以三個狀態只有一個成功。
  const probe =
    "<script>(function(){" +
    "var tries=200;" +
    "var boot=setInterval(function(){" +
    "  if(!window.__READY__ && --tries>0) return;" +
    "  clearInterval(boot);" +
    "  try{" + body + "}catch(e){document.title='PROBE|EXC:'+e.message;}" +
    "},100);" +
    "})();<\/script>";
  const tmp = resolve(ROOT, "out/_shot.html");
  writeFileSync(tmp, html.replace("</body>", probe + "</body>"));
  Bun.spawnSync([
    EDGE, "--headless=new", "--disable-gpu", "--virtual-time-budget=60000",
    "--window-size=1340,900", "--screenshot=" + resolve(ROOT, "out", out),
    "file:///" + tmp.replace(/\\/g, "/"),
  ], { stdout: "ignore", stderr: "ignore" });
  try { unlinkSync(tmp); } catch {}
  console.log(`已寫出 out/${out}`);
}
