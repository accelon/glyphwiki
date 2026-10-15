#!/usr/bin/env bun
/**
 * build-pinxing.ts — 產生離線單一網頁：**拼形檢視器**（pinxing.html）。
 *
 * 規格見 `pinxing.md`〈介面〉七條；工程計劃見 `拼形檢視器-施工單.md` §3（P3）。
 * 形狀照抄 `tools/build-glyph-browser.ts`：同一組內嵌內容（`embed-common.ts`）、
 * 同一條寫檔前的整頁語法檢查。
 *
 * 用法: bun run tools/build-pinxing.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ROOT, commonScript, commonPageJs, libB64, formGroupsJson, assertPageScript, engineSrc, bundleSrc,
} from "./embed-common.ts";

const OUT = resolve(ROOT, "out/pinxing.html");

/* 頁面程式碼放在 tools/pinxing-page.js —— **不要**搬回樣板字串（見該檔開頭）。 */
const PAGE_JS = readFileSync(resolve(ROOT, "tools/pinxing-page.js"), "utf8")
  /* **用 replaceAll**：字串版 replace 只換第一個，而檔案開頭的說明也提到這個記號，
     base64 會整包塞進註解、真正的變數反而沒換到（施工單 §9 第 2 條）。 */
  .replaceAll("__LIB_B64__", libB64)
  /* 部件形式群（`_FORMGROUPS_` 佔位）：**建議更好的基字**要用（第 111 輪）✓ */
  .replaceAll("__FORM_GROUPS__", formGroupsJson)
  /* ★ 師父第 127 輪：庫存那兩個合文的按鈕**用他給的原圖**（`xue.png`／`elements.png` ✓）——
     base64 直接打包進頁面 ✓（各約 42／45 KB → base64 約 +116 KB，頁面 +3.5% ✓ 可接受 ✓）。 */
  .replaceAll("__IMG_XUE_B64__", readFileSync(resolve(ROOT, "xue.png")).toString("base64"))
  .replaceAll("__IMG_ELEMENTS_B64__", readFileSync(resolve(ROOT, "elements.png")).toString("base64"));

const COMMON_SCRIPT = commonScript();

const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>剎那拼形</title>
<style>
  :root { color-scheme: dark;
          --bg:#0b0c0e; --card:#15171b; --line:#2a2e35; --mut:#8b93a0;
          --acc:#5b8cff; --accbg:#22304d; --fg:#e8ecf4; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; }
  body { font:13px/1.5 system-ui,"Segoe UI","Microsoft JhengHei",sans-serif;
         background:var(--bg); color:var(--fg); overflow-x:hidden; }

  /* 手機豎版優先：一欄，由上到下就是操作的順序。整體盡量緊湊。 */
  .wrap { max-width:460px; margin:0 auto; padding:6px 8px 16px; }
  header.top { background:var(--card); border:1px solid var(--line); border-radius:10px;
               padding:6px 8px; margin-bottom:6px; }
  header.top b { color:var(--fg); font-size:15px; letter-spacing:.5px; }

  /* 浮層提示（toast）：貼在輸入區正下方，**absolute 所以不佔高度**——
     訊息出現／消失都不會推動下面的版面（使用者：以免造成畫面晃動）。 */
  .toast { position:absolute; left:0; right:0; top:calc(100% + 3px); z-index:20;
           display:none; padding:4px 8px; border-radius:6px; font-size:11px; line-height:1.5;
           background:color-mix(in srgb, var(--card) 70%, #000);
           border:1px solid var(--line); box-shadow:0 6px 16px rgba(0,0,0,.35);
           white-space:normal; pointer-events:none; }
  .toast.on { display:block; }
  .toast.ok { color:#7fd18a; border-color:color-mix(in srgb, #7fd18a 40%, var(--line)); }
  .toast.warn { color:#ffc46b; border-color:color-mix(in srgb, #ffc46b 40%, var(--line)); }

  .sec { background:var(--card); border:1px solid var(--line); border-radius:10px;
         padding:6px 8px; margin-bottom:6px; }
  .sec > .cap { font-size:11px; color:var(--mut); letter-spacing:.5px; margin-bottom:5px; display:flex; gap:8px; align-items:baseline; }
  .sec > .cap .r { margin-left:auto; }
  .link { color:var(--acc); font-size:11px; cursor:pointer; }
  .link:hover { text-decoration:underline; }
  .link[aria-disabled="true"] { color:var(--mut); cursor:default; text-decoration:none; }

  /* ---- 1. 拼形序列（一行純文字）----
     輸入區的底色刻意跟卡片不一樣：使用者乍看就知道要在哪裡打字。 */
  .seqrow { display:flex; align-items:center; gap:6px; position:relative; }
  .seqlbl { flex:none; font-size:13px; letter-spacing:.5px; font-weight:600; }
  .seqlbl.brand { color:var(--acc); }            /* 空白時：剎那拼形（醒目） */
  .seqlbl.good { color:#7fd18a; }                /* 合法拼形式 */
  .seqlbl.find { color:#ffc46b; }                /* 部件檢字 */
  #seq { flex:1; min-width:0; font-size:24px; line-height:1.35; padding:7px 9px; border-radius:8px;
         border:1px solid var(--line); background:#05070b; color:var(--fg);
         font-family:"Microsoft JhengHei","Segoe UI",serif; letter-spacing:.06em; }
  #seq::placeholder { font-size:15px; color:#5d646f; letter-spacing:0; }
  #seq:focus { outline:none; border-color:var(--acc); box-shadow:0 0 0 2px var(--accbg); }
  /* 模式切換的一瞬提醒：改的是**顏色**（border-color），沒有位移、不會晃動畫面 */
  @keyframes seqflash { from { box-shadow:0 0 0 3px var(--fc); } to { box-shadow:0 0 0 3px transparent; } }
  #seq.flash-ok { --fc:rgba(127,209,138,.55); animation:seqflash .7s ease-out 1; }
  #seq.flash-warn { --fc:rgba(255,196,107,.55); animation:seqflash .7s ease-out 1; }
  .iconbtn { flex:none; width:36px; height:36px; padding:4px; display:flex; align-items:center; justify-content:center; }
  .iconbtn svg { width:22px; height:22px; display:block; }
  /* ★ 師父第 136 輪：**魔術棒 🪄**（有建議的構形序時才出現 ✓） */
  #wand { font-size:20px; line-height:1; }
  /* ⚠ 作者樣式的 display 會蓋掉 [hidden] 的 display:none ✗（第 112 輪的教訓 ✓）——
     「.iconbtn」有「display:flex」，所以「[hidden]」單獨是**沒有用的** ✗。
     這條是「JS 還沒跑之前」的保險 ✓；跑起來之後由「showEl()」的行內 display 接手 ✓。 */
  #wand[hidden] { display:none; }
  .row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:5px; }
  button { padding:5px 10px; border:1px solid var(--line); border-radius:6px; background:var(--card);
           color:var(--fg); font:inherit; cursor:pointer; white-space:nowrap; }
  button:hover { background:#1d2027; }
  button:disabled { opacity:.4; cursor:default; }
  .note { color:var(--mut); font-size:11px; }
  .note.warn { color:#ffc46b; }
  .note.ok { color:#7fd18a; }
  .wrow { gap:6px; }
  .wrow input[type=range] { flex:1; min-width:70px; }
  #boxMode { font-size:12px; padding:4px 8px; }

  /* ---- 2. 大字（左）＋ 部件清單（右，豎排、靠右） ----
     flex-wrap ＋ 大字的 min-width 是**防重疊**的保險：萬一視窗真的不夠寬
     （大字 200 ＋ 右欄最少 ~50），右欄會整塊換到下一行，不會壓到大字。 */
  .stagewrap { display:flex; flex-wrap:wrap; justify-content:flex-start; align-items:flex-start; gap:8px; }
  .stage { position:relative; flex:none; width:200px; height:200px; color:var(--fg);
           border:1px dashed var(--line); border-radius:4px; }
  /* ★ 師父 2026-10-15：**部件清單要緊湊**——原本是**豎排單欄** ✗，
     部件一多就變成一條長柱、右邊卻空著一大片 ✗。
     改成**吃滿右邊剩下的寬度、自動換行** ✓（左起排、靠大字那一側開始排 ✓）。 */
  .side { flex:1 1 56px; min-width:56px; max-width:100%; display:flex; flex-direction:column; gap:4px; align-items:flex-start; text-align:left; }
  .sidecap { font-size:11px; color:var(--mut); line-height:1.4; }
  /* 部件清單：方形按鈕（KAGE 字形）**自動換行、填滿可用寬度** ✓（緊湊 ✓）。
     手機太窄時（<=430px）再縮小大字與按鈕，避免壓到大字。 */
  .chips { display:flex; flex-wrap:wrap; gap:4px; align-content:flex-start;
           justify-content:flex-start; width:100%; }
  .mini.comp { position:relative; display:flex; align-items:center; justify-content:center;
               width:44px; height:44px; flex:none; border:1px solid var(--line); border-radius:6px;
               background:var(--card); color:var(--fg); cursor:pointer; }
  .mini.comp:hover { border-color:var(--c); box-shadow:0 0 0 2px color-mix(in srgb, var(--c) 40%, transparent); }
  .mini.comp.on { border-color:var(--c); background:color-mix(in srgb, var(--c) 22%, var(--card)); }
  /* 滑過大字的框時，對應的那一格也亮 ✓（見 pinxing-page.js 的 hoverChip ✓） */
  .mini.comp.hover { border-color:var(--c); box-shadow:0 0 0 2px color-mix(in srgb, var(--c) 40%, transparent); }
  .mini.comp.idsonly { border-style:dashed; }
  /* 無名的部件（字庫裡沒有碼位、也沒有 IDS）＝只看得到，換不掉 */
  .mini.comp.unnamed, .mini.comp.stuck { border-style:dashed; opacity:.72; cursor:default; }
  .mini.comp.unnamed:hover, .mini.comp.stuck:hover { border-color:var(--line); box-shadow:none; }
  /* IDS 補的部件、但**引擎換不掉**（例：䴺 的 來——麥 的 IDS 只有一半有碼位，
     槽位反推不出來）。跟無名部件一樣看得到、點不動：點下去會走進
     「選了卻永遠換不掉」的死路（回饋原文：如同搞不定，就不要讓客人在部件清單選擇）。
     兩者的差別：這一種**有碼位**（虛線改成點線、標籤是「—」）。 */
  .mini.comp.stuck { border-style:dotted; }
  .mini.comp .g { width:36px; height:36px; display:block; }
  .mini.comp .g svg { width:100%; height:100%; display:block; }
  .mini.comp .ids { position:absolute; right:1px; bottom:0; font-size:8px; color:var(--mut);
                    font-family:ui-monospace,monospace; }
  @media (max-width:430px) {
    /* 手機過窄：大字縮到 150、按鈕縮到 38（清單本來就會自動換行 ✓），不與大字重疊 */
    .stage, .stage .boxlayer, .stage > svg { width:150px; height:150px; }
    .mini.comp { width:38px; height:38px; }
    .mini.comp .g { width:31px; height:31px; }
  }
  .stage > svg { position:absolute; left:0; top:0; width:200px; height:200px; display:block; }
  .stage .ph { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
               text-align:center; color:var(--mut); font-size:12px; line-height:1.7; }
  /* 部件框疊在大字上（座標系一樣，都是 viewBox 0 0 200 200，不必換算）。
     框是**獨立一層 svg.boxlayer**，絕對定位疊上去——
     g 單獨塞進 HTML 會被解析器丟掉（踩過：大字的框整個不見）。 */
  .stage .boxlayer { position:absolute; left:0; top:0; width:200px; height:200px; }
  .cbox { fill:color-mix(in srgb, var(--c) 11%, transparent); stroke:var(--c); stroke-width:1.4; cursor:pointer; }
  .cbox:hover { fill:color-mix(in srgb, var(--c) 24%, transparent); stroke-width:2.2; }
  .cbox.on { fill:color-mix(in srgb, var(--c) 30%, transparent); stroke-width:2.6; }
  /* ★ 「字框：孫」——深層的子孫框畫成**虛線、細一點、淡一點** ✓，
     一眼分得出「直屬」與「更深」✓（顏色照 order ✓）。 */
  .cbox.sub { stroke-dasharray:3 2.5; stroke-width:1; fill-opacity:.22; }
  /* ⚠ 孫框的「.sub」會蓋掉「.cbox:hover」／「.cbox.on」的同等特異度規則 ✗——
     要**自己再寫一份** ✓，否則滑過去／選中都不會亮（師父 2026-10-15 回報 ✓）。 */
  .cbox.sub:hover { stroke-dasharray:none; stroke-width:2; fill-opacity:.42; }
  .cbox.sub.on { stroke-dasharray:none; stroke-width:2.6; fill-opacity:.55; }

  /* ---- 3. 部件序列 ----
     樣式在上面（跟大字同一區塊），這裡只留兩頁共用 markup 會用到的部分。 */
  .minis { display:flex; flex-wrap:wrap; gap:5px; }
  .mini .c { font-size:8px; opacity:.6; font-family:ui-monospace,monospace; height:11px; }

  /* ---- 3. 庫存拼形 ----
     **正方形按鈕**，只畫組出來的字（不顯示拼形式本身——想知道就點一下）。 */
  .stockrow { display:inline-flex; gap:6px; align-items:center; margin:0 6px 6px 0;
              border:1px solid var(--line); border-radius:8px; padding:3px; cursor:pointer; vertical-align:top; }
  .stockrow:hover { border-color:var(--acc); background:#1d2027; }
  .stockrow.mine { border-left:3px solid var(--acc); }
  /* ★ IDS 合文那一列（師父第 122 輪 ✓）：左邊一道綠線、標「合」✓，一眼看得出來是範例 ✓ */
  .stockrow.ids { border-left:3px solid #7fd18a; }
  .stockrow.ids .mbflag { position:absolute; margin-top:-40px; margin-left:-30px;
                          font-size:9px; color:#7fd18a; }
  .stockcell { flex:none; width:48px; height:48px; display:flex; align-items:center; justify-content:center; }
  .stockcell .g { width:100%; height:100%; color:var(--fg); }
  .stockcell .g svg { width:100%; height:100%; display:block; }
  .stockcell .miss { font-size:22px; color:#ff8080; }
  /* 「參」＝這一組只是參考（組不出單一形，按鈕畫的是第一個字） */
  .stockcell .flag { position:absolute; margin-top:-40px; margin-left:34px; font-size:9px; color:var(--mut); }
  .delStock { padding:2px 6px; font-size:11px; }

  /* ---- 7. 候選（非法序列 → 部件搜尋） ---- */
  .cands { display:grid; grid-template-columns:repeat(auto-fill,minmax(56px,1fr)); gap:4px; }
  .cell { border:1px solid var(--line); border-radius:5px; text-align:center; cursor:pointer;
          padding:1px; overflow:hidden; background:var(--card); }
  .cell:hover { border-color:var(--acc); }
  .cell .g { height:52px; color:var(--fg); }
  .cell .g svg { width:100%; height:100%; display:block; }
  .cell .c { font-size:9px; opacity:.6; font-family:ui-monospace,Consolas,monospace; }
  @media (max-width:400px) { .cands { grid-template-columns:repeat(auto-fill,minmax(48px,1fr)); } }

  /* ---- 8. 建議更好的基字（第 111～112 輪）----
     最佳的那個**與現在的形並排**（.sugstage）；其餘放庫存區那張卡（#sugRow，同比例好比較 ✓）。
     ⚠ builder 的樣板字串裡不可以用反引號（踩過兩次 ✗）。 */
  .stagewrap .cells { display:flex; flex-direction:column; gap:3px; }
  /* ⚠ 作者樣式的 display 會蓋掉 [hidden] 的 display:none ✗——
     第 112 輪實測：空畫面時建議框還是一個空框掛在那裡（截圖才看出來 ✗）。
     註解一律用「」，不要用反引號（template literal 會提早結束 ✗）。 */
  .stagewrap .cells[hidden] { display:none; }
  .sugstage { border-color:#4a6b3a; border-style:solid; cursor:pointer; }
  .sugstage:hover { border-color:var(--acc); }
  .stagecap { font-size:11px; color:var(--mut); text-align:center; letter-spacing:.4px; }
  .stagecap b { color:#c8e8b0; font-weight:600; letter-spacing:.05em; }
  #sugRow { display:flex; flex-wrap:wrap; gap:4px; margin-bottom:6px; }
  #sugRow .cell { width:48px; height:48px; padding:2px; border:1px solid #3d4a2c; border-radius:6px;
                  background:#1b2116; cursor:pointer; }
  #sugRow .cell:hover { border-color:var(--acc); background:#242c1c; }
  #sugRow .cell svg { width:100%; height:100%; display:block; }
  /* ★ 第 126 輪：IDS 的「優化推薦」只給**文字**（不先畫美形 ✗——留到客人點下去才驚嘆 ✓） */
  .seqchip { font:12px/1.6 ui-monospace,"Microsoft JhengHei",monospace; color:#cfe3b8;
             background:#1d2418; border:1px solid #3d4a2c; border-radius:6px;
             padding:3px 7px; cursor:pointer; }
  .seqchip:hover { border-color:var(--acc); background:#242c1c; }
  /* ★ 第 127 輪：庫存合文的按鈕用**師父的原圖** ✓（base64 打包 ✓）
     ⚠ **不要加 filter:invert** ✗——實測師父的 PNG 是**白墨畫在透明底上** ✓
     （xue.png 最常見色是近白，39,839 像素 ✓），反相之後變黑 ✗ → 在深色格子裡**完全看不見** ✗
     （師父第 129 輪就是這樣發現的 ✓）。 */
  .stockcell .rawimg { width:100%; height:100%; object-fit:contain; display:block; }

  /* 授權宣告：頁尾一行小字，不搶版面 */
  .credits { margin:8px 2px 0; font-size:11px; line-height:1.7; color:var(--mut); text-align:center; }
</style>
</head>
<body>
<div class="wrap">

  <!-- 頁名不放頁面上（規格的名稱在輸入區左邊的標籤），這裡只留一句短回饋。
       回饋用**浮層**貼在輸入區下面（見 .toast），不佔排版高度，所以訊息出現／消失都不會晃動畫面。 -->
  <header class="top">
    <div class="seqrow">
      <span class="seqlbl brand" id="seqlbl">剎那拼形</span>
      <input id="seq" type="text" autocapitalize="off" autocorrect="off" spellcheck="false"
             placeholder="輸入任何字或拼形式">
      <!-- ★ 師父第 136 輪：**魔術棒 🪄** —— 有建議的構形序時才出現 ✓；
           點一下＝把下一個建議填進輸入區 ✓（再點換下一個 ✓）。
           DOM 位置在「存起來」（#saveSeq）的前一個 ✓（師父指定的位置 ✓）。 -->
      <button id="wand" class="iconbtn" title="系統建議的構形序（點一下套用；再點換下一個）" hidden>🪄</button>
      <!-- 存起來：svg 圖示（磁片）＋ 加號；Enter 也可以存。不是合法拼形式時整顆收起 -->
      <button id="saveSeq" class="iconbtn" title="存起來（或在輸入區按 Enter）">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 4h11l5 5v11H4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
          <path d="M8 4h7v5H8z" fill="currentColor"/>
          <path d="M8 14h8v6H8z" fill="none" stroke="currentColor" stroke-width="1.5"/>
          <path d="M17 3v5M14.5 5.5h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        </svg>
      </button>
      <!-- 浮層提示：貼在輸入區正下方，不佔高度（absolute），所以畫面不會晃動 -->
      <span class="toast" id="msg"></span>
    </div>
    <!-- 5. 筆劃粗細 ＋ 6. 字框（三態）：跟輸入區同一張卡，調完立刻看得到大字變化 -->
    <div class="row wrow">
      <button id="boxMode" data-mode="tight">字框：緊</button>
      <!-- ★ 師父第 124 輪：客人不會打 IDC ✓，所以要有按鈕把字**拆成構字式（IDS）** ✓ -->
      <button id="toIds" title="把這個字拆成構字式（IDS）——看看 IDS 的等比分配與構形序差多少 ✓">拆成 IDS</button>
      <span class="note">筆劃</span>
      <input id="wscale" type="range" min="40" max="220" step="5" value="100">
      <span class="note" id="wscaleV">100%</span>
    </div>
  </header>

  <!-- 2. 大字（左）＋ 4. 部件序列（右，豎排） -->
  <div class="sec">
    <div class="cap">拼出來的形<span class="r note" id="bigNote"></span></div>
    <div class="stagewrap">
      <div class="stage" id="big"></div>
      <!-- **最佳建議與現在的形並排**（師父第 112 輪的要求）：客人才看得出好在哪裡 ✓。
           點一下＝換成那個基字（不自動改 ✓）。 -->
      <div class="cells" id="sugWrap" hidden>
        <div class="stage sugstage" id="sugStage" role="button" tabindex="0"
             title="點一下＝換成這個基字"></div>
        <div class="stagecap">建議：<b id="sugCap"></b></div>
      </div>
      <div class="side">
        <div class="note sidecap" id="seqNote"></div>
        <div class="note sidecap" id="philNote"></div>
        <div class="chips" id="seqChips"></div>
      </div>
    </div>
  </div>

  <!-- 3. 庫存拼形（正方形按鈕直接顯示組出來的字；點一下連同大字帶進輸入區）。
       有候選字時整張卡收起來（見 renderSearch）——手機畫面有限。
       **建議的基字也放在這裡**（師父第 112 輪：多個推薦就用這一區，
       拼形式放 hover hint，客人可以一次比好幾個同比例的形 ✓）。 -->
  <div class="sec" id="stockSec">
    <!-- 建議的基字（第 1 個已經在「拼出來的形」那邊並排，這裡放其餘的 ✓） -->
    <div id="stockSuggest" hidden>
      <div class="cap">建議的基字<span class="r note">滑過看拼形式；點一下帶進輸入區</span></div>
      <div id="sugRow"></div>
    </div>
    <div class="cap">庫存拼形<span class="r note">點一下帶進輸入區</span></div>
    <div id="stock"></div>
    <!-- 與字集瀏覽頁的連動（那裡的入口是 P2 的工作，這邊先照規格連過去） -->
    <div class="row"><span id="toBrowser" class="link" role="button" tabindex="0"></span></div>
  </div>

  <!-- 7. 不是合法構形序列時：當部件搜尋，候選列在最下方 -->
  <div class="sec" id="candSec">
    <div class="cap">候選字<span class="r note" id="candNote"></span></div>
    <div class="cands" id="cands"></div>
    <div class="row"><button id="moreBtn" hidden>再看更多</button></div>
  </div>

  <!-- 授權宣告（使用者指定的文字，一字不改） -->
  <footer class="credits">
    基於開源字庫 Glyphwiki+Kage，拼形序依據 中国发明专利 201610984608.1 号。微信：wxx68174671
  </footer>

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
assertPageScript(html);
writeFileSync(OUT, html);
console.log(`已寫出 ${OUT}`);
console.log(`  ✓ 產出頁面的 script 語法正確`);
console.log(`  網頁大小 ${(Buffer.byteLength(html) / 1048576).toFixed(2)} MB`);
console.log(`  內嵌：kage-engine ${(Buffer.byteLength(engineSrc) / 1024).toFixed(0)} KB、` +
  `tools 模組 ${(Buffer.byteLength(bundleSrc) / 1024).toFixed(1)} KB、` +
  `字形庫 base64 ${(libB64.length / 1048576).toFixed(2)} MB`);
