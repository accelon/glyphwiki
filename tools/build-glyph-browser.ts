#!/usr/bin/env bun
/**
 * build-glyph-browser.ts — 產生離線單一網頁：**字集瀏覽**（BabelMap 風格）。
 *
 * 設計見 `字集瀏覽介面設計.md`。三個需求：
 *   1. 輸入 codepoint 或跳到某個 Extension 區塊
 *   2. 輸入部件，只列出含有該部件的字
 *   3. 選定字／部件時，列出它能構成的所有字，以及它的其他異體
 *
 * 這一頁是**第三頁**：`kage-viewer.html`（只做檢視）與 `codemirror-kage.html`
 * （編輯器）都保持原樣，不動它們。
 *
 * 關鍵設計（都來自 `tools/browser-perf.ts` 量到的數字）:
 *   * 開頁 210 ms（gunzip ＋ 解碼 191,727 字形）→ 不需要進度條
 *   * 部件索引 149 ms、4 MB → 開頁就建好，之後查表 0 ms
 *   * 描繪一個字形 0.13 ms → 可見區域才描繪（虛擬滾動）
 *   * 一次畫完 191,727 個要 25 秒 → 絕不這樣做
 *
 * 用法: bun run tools/build-glyph-browser.ts [--out out/glyph-browser.html]
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ROOT, commonScript, commonPageJs, libB64, assertPageScript, engineSrc, bundleSrc,
} from "./embed-common.ts";

const OUT = resolve(ROOT, "out/glyph-browser.html");

/* 頁面程式碼放在 tools/glyph-browser-page.js —— **不要**搬回樣板字串，
   那裡的反引號會提前結束字串。見該檔開頭。 */
const PAGE_JS = readFileSync(resolve(ROOT, "tools/glyph-browser-page.js"), "utf8")
  /* **用 replaceAll**：字串版 replace 只換第一個，而檔案開頭的說明註解
     也提到了這個記號，base64 會整包塞進註解、真正的變數反而沒換到。 */
  .replaceAll("__LIB_B64__", libB64);

const COMMON_SCRIPT = commonScript();

const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unicode漢字集（離線單頁）</title>
<style>
  /* 固定深色：字要按區塊上色（HSV 每區轉 30°），深底才看得出顏色、
     也不用為亮底再做一組對比調整。 */
  :root { color-scheme: dark;
          --bg:#0b0c0e; --card:#15171b; --line:#2a2e35; --mut:#8b93a0;
          --acc:#5b8cff; --accbg:#22304d; }
  * { box-sizing: border-box; }
  body { margin:0; font:13px/1.5 system-ui,"Segoe UI","Microsoft JhengHei",sans-serif;
         background:var(--bg); color:inherit; overflow:hidden; }
  .app { display:flex; flex-direction:column; height:100vh; }
  main { display:flex; flex:1; min-height:0; }
  /* 左欄的功能全部搬到頂端，變成兩列：上面＝搜尋、下面＝區塊 */
  /* 只有一列：左邊搜尋、右邊區塊 chips。視窗變窄才換行。 */
  header.top { flex:none; background:var(--card); border-bottom:1px solid var(--line); padding:6px 12px; }
  .trow { display:flex; align-items:center; gap:8px; min-height:30px; flex-wrap:wrap; }
  .trow .lbl { flex:none; font-size:11px; color:var(--mut); letter-spacing:.6px; }
  .trow .lbl.right { margin-left:auto; }
  /* 部件搜尋很少超過三個部件，不需要那麼寬 */
  header.top input[type=text] { flex:0 0 150px; }
  /* 提示文字可以壓縮，不要為了它把 chips 擠掉 */
  header.top .note { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  header.top #blocks { flex:1 1 auto; justify-content:flex-end; }
  header.top details.help { flex:none; position:relative; }
  header.top summary { font-size:11px; color:var(--mut); cursor:pointer; }
  header.top .helpBody { position:absolute; z-index:30; left:0; margin-top:6px; padding:8px 10px; line-height:1.9;
    background:var(--card); border:1px solid var(--line); border-radius:8px;
    box-shadow:0 6px 20px rgba(0,0,0,.35); font-size:12px; }
  .pane { background:var(--card); overflow:auto; }
  .pane.r { flex:none; width:322px; border-left:1px solid var(--line); }
  h1 { font-size:14px; margin:0; padding:11px 12px; border-bottom:1px solid var(--line);
       background:color-mix(in srgb, var(--card) 92%, var(--bg)); font-weight:600; letter-spacing:.3px; }
  .sec { padding:9px 12px; border-bottom:1px solid var(--line); }
  .sec > b { display:block; font-size:11px; color:var(--mut); font-weight:600; letter-spacing:.6px; margin-bottom:6px; }
  /* 一組 toggle button。字數放進 title（滑過去才顯示），面板才不會擠。 */
  #blocks { display:flex; flex-wrap:wrap; gap:4px; }
  .blk { display:inline-flex; align-items:center; padding:3px 10px; border-radius:999px;
         border:1px solid color-mix(in srgb, var(--bc) 34%, var(--line));
         font-size:12px; cursor:pointer; color:var(--bc); background:transparent; }
  .blk:hover { background:color-mix(in srgb, var(--bc) 16%, transparent); }
  .blk.on { background:var(--bc); color:#0e1014; border-color:var(--bc); }
  input[type=text] { width:100%; padding:6px 8px; border:1px solid var(--line); border-radius:6px;
                     font:inherit; background:var(--card); color:inherit; }
  input[type=number] { width:56px; padding:5px 6px; border:1px solid var(--line); border-radius:6px;
                       background:var(--card); color:inherit; font:inherit; }
  .row { display:flex; gap:6px; align-items:center; margin-top:6px; flex-wrap:wrap; }
  button { padding:5px 10px; border:1px solid var(--line); border-radius:6px; background:var(--card);
           color:inherit; font:inherit; cursor:pointer; white-space:nowrap; }
  button:hover { background:color-mix(in srgb, var(--card) 85%, var(--bg)); }
  button.p { background:var(--acc); border-color:var(--acc); color:#fff; }
  .chip { padding:3px 9px; border:1px solid var(--line); border-radius:999px; font-size:12px;
          cursor:pointer; background:var(--card); }
  .chip.on { background:var(--accbg); border-color:var(--acc); color:var(--acc); }
  .chips { display:flex; flex-wrap:wrap; gap:4px; }
  label.r { display:inline-flex; align-items:center; gap:4px; font-size:12px; }
  .note { color:var(--mut); font-size:11px; }

  .center { display:flex; flex-direction:column; overflow:hidden; background:var(--card); flex:1; min-width:0; }
  .bar { display:flex; align-items:center; gap:10px; padding:8px 12px; border-bottom:1px solid var(--line);
         background:color-mix(in srgb, var(--card) 92%, var(--bg)); font-size:12px; white-space:nowrap; }
  /* 左半（區塊名／範圍／字數）可以壓縮，右半（大小／筆劃／描邊）不壓縮。
     整條工具列固定一行，不換行。 */
  .bar .grp { display:flex; align-items:center; gap:8px; min-width:0; overflow:hidden; }
  .bar .ctrls { display:flex; align-items:center; gap:8px; margin-left:auto; flex:none; }
  /* 「設置」下拉：大小／筆劃粗細／描邊全收在裡面 */
  .menu { position:relative; }
  .menuBody { position:absolute; right:0; top:100%; margin-top:6px; z-index:20;
              display:flex; flex-direction:column; gap:8px; padding:10px 12px;
              background:var(--card); border:1px solid var(--line); border-radius:8px;
              box-shadow:0 8px 24px rgba(0,0,0,.4); }
  .menuBody[hidden] { display:none; }
  .mrow { display:flex; align-items:center; gap:8px; white-space:nowrap; }
  .mrow input[type=range] { width:150px; }
  #grid { flex:1; overflow:auto; padding:6px 8px; position:relative; }
  /* align-content:start 是必要的：容器有固定高度（虛擬滾動的總高），
     預設的 stretch 會把每一列拉長去填滿，格子就會變成三倍高。 */
  #rows { position:absolute; top:6px; left:8px; right:8px; display:grid;
          align-content:start; gap:var(--gap); }
  /* 每個格子帶著自己區塊的顏色（--bc）；字形與碼位都用它，
     碼位標籤用 opacity 壓暗，選取框也用同一個顏色，不會跟色相互相打架。 */
  .cell { position:relative; border:1px solid color-mix(in srgb, var(--bc) 26%, var(--line)); border-radius:5px;
          padding:1px; text-align:center; cursor:pointer; overflow:hidden; background:var(--card); color:var(--bc); }
  .cell:hover { border-color:var(--bc); }
  .cell.sel { border-color:var(--bc); box-shadow:0 0 0 2px color-mix(in srgb, var(--bc) 45%, transparent); }
  .cell.dim { background:color-mix(in srgb, var(--card) 96%, var(--bg)); }
  /* 「輸入的部件本身」的格子：虛線框 ＋ 右上角小點，跟搜尋結果區分 */
  .cell.part { border-style:dashed; }
  .cell.outside { opacity:.42; }
  .cell.part::after { content:""; position:absolute; top:2px; right:2px; width:4px; height:4px;
                      border-radius:50%; background:var(--bc); }
  .cell .g { height:var(--gh); display:flex; align-items:center; justify-content:center; }
  .cell .g svg { width:100%; height:100%; display:block; }
  .cell .c { height:13px; line-height:13px; font-size:10px;
             font-family:ui-monospace,Consolas,monospace; }
  /* ⚠ 碼位的**淡化**從「.c」搬到裡面的「.cp」✓：小標要和碼位同一行（左下角 ✓），
     但小標要**醒目**（不可以跟著淡化 ✗）——「opacity」會蓋住整個子樹，救不回來 ✗。 */
  .cell .c .cp { opacity:.62; }
  .cell.sel .c .cp { opacity:.85; }
  /* ★ 師父 2026-10-16：碼位**左下角**標「這個字屬於哪一區」✓——
     Extension＝**英文字母**（A..I ✓）、相容區＝「相」「補」✓、**基本區 2 萬字不標** ✓
     （「mark:""」✓，見共用層的「BLOCKS」✓）。
     醒目＝**粗體 Arial** ＋ **自己那一區的顏色**（「--bc」✓，跟字形同色 ✓）＋ 比碼位大一級 ✓。 */
  .cell .c .blkmark { font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:11px;
                      line-height:1; color:var(--bc); margin-right:3px; }
  .sysfont { font-size:calc(var(--gh) * .82); line-height:1; font-family:"Microsoft JhengHei",serif; }
  body.outline .cell svg path, body.outline .mini svg path, body.outline .big svg path {
    fill:none; stroke:currentColor; stroke-width:2.2; stroke-linejoin:round; }
  .cell svg path, .mini svg path, .big svg path { fill:currentColor; }

  /* 大字：框線用虛線，滑過去變亮實線——這樣看得到字形在 200×200 畫布裡的位置。
     方框就是 KAGE 的畫布（200×200），放大到滿。 */
  .big { text-align:center; padding:8px 0 2px; color:var(--bc); }
  .big { cursor:pointer; }
  .big .g { position:relative; width:200px; height:200px; margin:0 auto;
            border:1px dashed color-mix(in srgb, var(--bc) 45%, transparent); border-radius:4px; }
  .big .g:hover { border:1px solid var(--bc); box-shadow:0 0 0 1px color-mix(in srgb, var(--bc) 40%, transparent); }
  .big .g svg { width:100%; height:100%; display:block; }
  /* 部件框：獨立一層絕對定位的 svg 疊在字形上（座標系相同，不必換算）。
     文件序在後＝畫在上面，所以小框自然疊在大框上、一定點得到。 */
  .big .g .boxlayer { position:absolute; left:0; top:0; width:100%; height:100%; }
  .cbox { fill:color-mix(in srgb, var(--c) 11%, transparent); stroke:var(--c); stroke-width:1.4; cursor:pointer; }
  .cbox:hover { fill:color-mix(in srgb, var(--c) 24%, transparent); stroke-width:2.2; }
  .cbox.on { fill:color-mix(in srgb, var(--c) 30%, transparent); stroke-width:2.6; }
  .big .u { font-family:ui-monospace,Consolas,monospace; opacity:.62; }
  .minis { display:flex; flex-wrap:wrap; gap:5px; }
  .mini { width:46px; border:1px solid color-mix(in srgb, var(--bc) 26%, var(--line)); border-radius:6px;
          text-align:center; padding:2px 0 1px; cursor:pointer; background:var(--card); color:var(--bc); }
  .mini:hover { border-color:var(--bc); }
  .mini.on { border-color:var(--bc); background:color-mix(in srgb, var(--bc) 14%, var(--card)); }
  .mini .g { width:100%; height:34px; }
  .mini .g svg { width:100%; height:100%; display:block; }
  .mini .c { font-size:8px; opacity:.6; font-family:ui-monospace,monospace; }
  hr.thin { border:0; border-top:1px solid var(--line); margin:0; }

  /* 詳細區＝可堆疊的卡片，一路往右欄疊下去，每張都能單獨關掉 */
  .card { position:relative; border:1px solid var(--line); border-left:3px solid var(--bc);
          border-radius:8px; margin:8px; background:color-mix(in srgb, var(--card) 94%, var(--bg)); }
  .card + .card { margin-top:0; }
  .cardClose { position:absolute; top:4px; right:4px; z-index:2; width:22px; height:22px; padding:0;
               line-height:1; border-radius:6px; font-size:14px; color:var(--mut); }
  .cardClose:hover { color:#ff8080; border-color:#ff8080; }
  .card .sec { padding:8px 10px; }
  @media (max-width:900px) {
    .pane.r { position:fixed; right:0; top:0; bottom:0; width:300px; z-index:5;
              box-shadow:-4px 0 16px rgba(0,0,0,.15); }
  }
</style>
</head>
<body>
<div class="app">

  <header class="top">
    <div class="trow">
      <span class="lbl">部件搜尋</span>
      <input id="comp" type="text" placeholder="木+ ／ 口木 ／ 4木日 ／ 4 ／ U+908F">
      <details class="help">
        <summary>運算式說明</summary>
        <!-- ★ 2026-10-16：內容由**共用層的「searchHelpHtml()」**填進來 ✓
             （與拼形頁的「部件檢字」popup **同一份**說明 ✓，不要在這裡再抄一份 ✗）。
             填在開頁時（見 glyph-browser-page.js ✓）——探針讀得到 ✓。 -->
        <div class="helpBody" id="helpBody"></div>
      </details>
      <span class="note" id="compNote"></span>
      <div id="blocks"></div>
    </div>
  </header>

  <main>
    <div class="center">
      <div class="bar">
        <span class="grp">
          <span class="note" id="blkRange"></span>
          <span class="note" id="count"></span>
        </span>
        <span class="ctrls">
          <!-- 大小／筆劃粗細／描邊收進同一個「設置」下拉，工具列只留一顆按鈕 -->
          <div class="menu">
            <button id="setBtn" title="字體大小、筆劃粗細、描邊">設置</button>
            <div class="menuBody" id="setBody" hidden>
              <div class="mrow"><span class="note" style="width:34px">大小</span>
                <input id="cellN" type="number" min="34" max="140" step="2" value="62"></div>
              <div class="mrow"><span class="note" style="width:34px">筆劃</span>
                <input id="wscale" type="range" min="40" max="220" step="5" value="100">
                <span class="note" id="wscaleV" style="width:38px;display:inline-block">100%</span></div>
              <div class="mrow"><span class="note" style="width:34px"></span>
                <button id="outlineBtn">描邊</button></div>
            </div>
          </div>
        </span>
      </div>
      <div id="grid"><div id="rows"></div></div>
    </div>

    <aside class="pane r">
      <div id="detail"><div class="sec note">從中間點一個字，或用上面的搜尋。</div></div>
    </aside>
  </main>
</div>

<script>
${COMMON_SCRIPT}
/* ============ 兩頁共用的頁面端程式碼（tools/glyph-common-page.js） ============ */
${commonPageJs}
${PAGE_JS}

</script>
</body>
</html>
`;

mkdirSync(dirname(OUT), { recursive: true });

// **產出後再檢查一次整段 script 的語法**。
// 上面那次檢查只涵蓋「引擎 ＋ 內嵌模組」；頁面自己的程式碼（主流程）不在裡面。
// 實際踩過：`"...class=\"minis\">"` 寫在樣板字串裡，`\"` 被吃掉之後
// 輸出變成 `"...class="minis">"`，整頁 SyntaxError 而空白——
// 那次是等到驗收腳本才發現。這裡先擋下來。
assertPageScript(html);

writeFileSync(OUT, html);
console.log(`已寫出 ${OUT}`);
console.log(`  ✓ 產出頁面的 script 語法正確`);
console.log(`  網頁大小 ${(Buffer.byteLength(html) / 1048576).toFixed(2)} MB`);
console.log(`  內嵌：kage-engine ${(Buffer.byteLength(engineSrc) / 1024).toFixed(0)} KB、` +
  `tools 模組 ${(Buffer.byteLength(bundleSrc) / 1024).toFixed(1)} KB、` +
  `字形庫 base64 ${(libB64.length / 1048576).toFixed(2)} MB`);

