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
import { compileTours } from "./tour/compiler.ts";
import { tourDataJs } from "./tour/embed.ts";
import tourConfig from "./tour/tour.config.ts";

const OUT = resolve(ROOT, "out/pinxing.html");

/* ★ 2026-10-16：**同一份頁面程式碼，兩種宿主** ✓。
 *
 *   離線單頁（預設）      out/pinxing.html                  字庫以 base64 內嵌 → `file://` 可開
 *   宿主模式（--hosted）  pinxing-app/frontend/index.html   字庫改由 `/lib.bin` 一次 fetch
 *
 * ⚠ 兩者用**同一份** `tools/pinxing-page.js` 與同一組內嵌模組 ✓——
 *   差別只有「字庫從哪裡來」那一行（`loadLibBytes()`，見該檔的說明）✗ 不各自複製 ✓。
 *   這個專案吃過「同一個東西兩份來源各說各話」的虧（見 embed-common.ts 檔頭），
 *   所以寧可在這裡多一個開關，也不要多一份頁面。
 *
 * 用法:
 *   bun run tools/build-pinxing.ts              # 離線單頁
 *   bun run tools/build-pinxing.ts --hosted     # Wails3 版的前端
 */
const HOSTED = process.argv.includes("--hosted");
const OUT_PATH = HOSTED
  ? resolve(ROOT, "pinxing-app/frontend/index.html")
  : OUT;

/* 頁面程式碼放在 tools/pinxing-page.js —— **不要**搬回樣板字串（見該檔開頭）。 */
const PAGE_JS = readFileSync(resolve(ROOT, "tools/pinxing-page.js"), "utf8")
  /* **用 replaceAll**：字串版 replace 只換第一個，而檔案開頭的說明也提到這個記號，
     base64 會整包塞進註解、真正的變數反而沒換到（施工單 §9 第 2 條）。 */
  /* ⚠ 宿主模式下換成**空字串**：`loadLibBytes()` 會改走 `window.__LIB_URL__`。
     留著 3.1 MB 的 base64 就等於白花（前端本來就只有幾百 KB）。 */
  .replaceAll("__LIB_B64__", HOSTED ? "" : libB64)
  /* 部件形式群（`_FORMGROUPS_` 佔位）：**建議更好的基字**要用（第 111 輪）✓ */
  .replaceAll("__FORM_GROUPS__", formGroupsJson)
  /* ★ 師父第 127 輪：庫存那兩個合文的按鈕**用他給的原圖**（`xue.png`／`elements.png` ✓）——
     base64 直接打包進頁面 ✓（各約 42／45 KB → base64 約 +116 KB，頁面 +3.5% ✓ 可接受 ✓）。 */
  .replaceAll("__IMG_XUE_B64__", readFileSync(resolve(ROOT, "xue.png")).toString("base64"))
  .replaceAll("__IMG_ELEMENTS_B64__", readFileSync(resolve(ROOT, "elements.png")).toString("base64"));

const COMMON_SCRIPT = commonScript();

/* ==================== 操作導覽（2026-10-25）====================
 *
 * 三塊，全部從 `tools/tour/` 讀進來（**不要**搬進這裡的樣板字串 ✗）：
 *
 *   `tour.css`    外殼樣式   → 接在既有的 <style> 最後
 *   `shell.html`  外殼 DOM   → 接在 .wrap 之後（聚光燈／氣泡／選單；都是 position:fixed）
 *   `player.js`   播放器     → 接在頁面程式碼之前（純 ES5 ✓，見該檔檔頭）
 *
 * 劇本（`tools/tour/tours/*.tour`）由 `compileTours()` 編譯成巨集 ＋ base64，
 * 以 `TOUR_INDEX`／`TOUR_BLOBS` 兩個全域內嵌（`tools/tour/embed.ts` 是寫法的唯一定義 ✓）。
 *
 * ⚠ 為什麼要**先組一份「沒有導覽資料」的頁面**：`compileTours()` 會拿 `templateHtml`
 *   做 `#id` 的靜態檢查 ✓——劇本裡寫錯一個 id 要在**建置期**就擋下來，
 *   不能等到客人面前才「⚠ 找不到」✗。而那一份的 id 必須跟真正產出的那一頁一樣，
 *   所以先組 html0、拿它去編譯、再把資料換進去（資料本身不含 id ✓）。
 */
const TOUR_CSS = readFileSync(resolve(ROOT, "tools/tour/tour.css"), "utf8");
const TOUR_SHELL = readFileSync(resolve(ROOT, "tools/tour/shell.html"), "utf8");
const TOUR_PLAYER = readFileSync(resolve(ROOT, "tools/tour/player.js"), "utf8");
/** 資料的插入點：先組一頁**沒有導覽資料**的（拿去做 #id 檢查），編譯完再把資料換進來 ✓ */
const TOUR_SLOT = "/* _____TOUR_DATA_SLOT_____ */";

/* ★ 宿主模式的前導 script（**只存在於宿主模式** ✓，離線單頁不會有 ✓）。
 *
 *   ① 告訴 `loadLibBytes()` 去哪裡拿字庫（Go 那邊的 `/lib.bin`）。
 *   ② 真的解開字庫之後**回報 Go 一聲** ✓——這樣驗收**不必看畫面**：
 *      exe 的日誌會多一行「[頁面] 已就緒 …」，一眼就知道前端解到幾個字。
 *      沒回報就是沒解開；那比「視窗開起來了但裡面是空的」好查太多了。
 *   ⚠ 這一段刻意放在**頁面程式碼之前**的獨立 script：`__LIB_URL__` 必須在
 *      `loadLibBytes()` 被呼叫之前就設好 ✓。 */
const HOSTED_PRELUDE = HOSTED
  ? `
<!-- ============ 宿主模式（Wails3）：字庫由 /lib.bin 一次 fetch ============ -->
<script>
  window.__LIB_URL__ = "/lib.bin";
  (function () {
    var waited = 0;
    var t = setInterval(function () {
      if (window.__READY__) {
        clearInterval(t);
        var r = window.__READY__;
        try {
          fetch("/__ready", {
            method: "POST",
            body: r.glyphs + " 字 / " + r.families + " 家族 / 解碼 " + r.decodeMs + " ms"
          });
        } catch (e) { /* 回報失敗不影響頁面 */ }
      } else if (++waited > 300) {
        clearInterval(t);   /* 60 秒就放棄（畫面上有開頁看門狗會處理 ✓） */
      }
    }, 200);
  })();
</script>
`
  : "";

/* 開發記錄的連結指向同資料夾的 `gouxingji.html`——宿主模式沒有那個檔，
   留著會變成 404 ✗，所以那一行只在離線單頁出現 ✓。 */
const DEV_LINK = HOSTED ? "" : `
    <span class="devlink">　·　<a href="gouxingji.html">開發記錄</a></span>`;

/* 「微信打開看不到」那一句是給離線單頁的客人看的 ✓；桌面視窗裡沒有意義 ✗。 */
const WECHAT_LINE = HOSTED ? "" : `
  <!-- ★ 師父 2026-10-16 指定的保險（微信內建瀏覽器）：放在**最底部的一行** ✓。 -->
  <p class="wechat">微信打開看不到的話，用系統自帶的瀏覽器打開。</p>`;

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
  /* 「--chip」＝部件清單的方格大小（**唯一的尺寸來源** ✓：「.mini.comp」與
     「.side」的最小寬度都吃它 ✓）。窄螢幕只改這一個值 ✓（見下面的 media query ✓）。 */
  body { --chip:44px;
         font:13px/1.5 system-ui,"Segoe UI","Microsoft JhengHei",sans-serif;
         background:var(--bg); color:var(--fg); overflow-x:hidden; }

  /* 手機豎版優先：一欄，由上到下就是操作的順序。整體盡量緊湊。 */
  .wrap { max-width:460px; margin:0 auto; padding:6px 8px 16px; }
  /* ★ 寬螢幕把卡片放寬 ✓——大字（200）＋部件清單＋建議並排（200）才排得下 ✓，
     右邊也不會空一大片 ✓（手機仍維持 460 ✓）。 */
  @media (min-width:760px) { .wrap { max-width:720px; } }
  /* 「position:relative」＝ 讓「運算子用法」那個浮層**貼在這張卡的下方** ✓
     （貼在 .seqrow 下方會蓋住同一張卡裡的「筆劃」滑桿 ✗，看起來像壞掉 ✓）。 */
  header.top { position:relative; background:var(--card); border:1px solid var(--line); border-radius:10px;
               padding:6px 8px; margin-bottom:6px; }
  header.top b { color:var(--fg); font-size:15px; letter-spacing:.5px; }

  /* 浮層提示（toast）：貼在輸入區正下方，**absolute 所以不佔高度**——
     訊息出現／消失都不會推動下面的版面（使用者：以免造成畫面晃動）。
     ⚠ 底色先給一條**舊瀏覽器認得**的實色 ✓：微信 X5／iOS 16.2 以前不認「color-mix()」✗，
        那一條會被整條丟掉 ✗ → 浮層變透明、字疊在下面的內容上 ✗。 */
  .toast { position:absolute; left:0; right:0; top:calc(100% + 3px); z-index:20;
           display:none; padding:4px 8px; border-radius:6px; font-size:11px; line-height:1.5;
           background:#101216;
           background:color-mix(in srgb, var(--card) 70%, #000);
           border:1px solid var(--line); box-shadow:0 6px 16px rgba(0,0,0,.35);
           white-space:normal; pointer-events:none; }
  .toast.on { display:block; }
  .toast.ok { color:#7fd18a; border-color:color-mix(in srgb, #7fd18a 40%, var(--line)); }
  .toast.warn { color:#ffc46b; border-color:color-mix(in srgb, #ffc46b 40%, var(--line)); }
  /* ★ 師父 2026-10-16：不合法的表意描述序要**紅色警示** ✓（缺部件／多部件／開頭不是描述符 ✓）。 */
  .toast.err { color:#ff8a8a; border-color:color-mix(in srgb, #ff8a8a 45%, var(--line)); }

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
  /* ★ 存檔 ↔ 垃圾桶（同一顆按鈕的兩態 ✓；師父 2026-10-15） */
  #saveSeq .icoDel { display:none; }
  #saveSeq.del .icoSave { display:none; }
  #saveSeq.del .icoDel { display:block; }
  #saveSeq.del { color:#ff8a8a; }
  /* ★ 師父第 136 輪：**魔術棒 🪄**（有建議的拼形序時才出現 ✓）；
     ★ 師父 2026-10-16：**🧩「拆成 IDS」搬到同一列** ✓（「與魔杖放在同一位置，用 🧩 這個圖示」✓）。
     ★ 2026-10-25：**操作導覽 🦮（導盲犬）**也在這一列、緊接在「存起來」後面 ✓（見下面 #tourEntry ✓）。
     ⚠ 三顆都是 emoji 圖示鈕，字級要一起調 ✓（「.iconbtn」的 22px 那條是給 svg 的 ✗）。 */
  #wand, #toIds, #tourEntry { font-size:20px; line-height:1; }
  /* ⚠ 作者樣式的 display 會蓋掉 [hidden] 的 display:none ✗（第 112 輪的教訓 ✓）——
     「.iconbtn」有「display:flex」，所以「[hidden]」單獨是**沒有用的** ✗。
     這兩條是「JS 還沒跑之前」的保險 ✓；跑起來之後由「showEl()」的行內 display 接手 ✓。 */
  #wand[hidden] { display:none; }
  #toIds[hidden] { display:none; }
  .row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:5px; }
  button { padding:5px 10px; border:1px solid var(--line); border-radius:6px; background:var(--card);
           color:var(--fg); font:inherit; cursor:pointer; white-space:nowrap; }
  button:hover { background:#1d2027; }
  button:disabled { opacity:.4; cursor:default; }
  .note { color:var(--mut); font-size:11px; }
  .note.warn { color:#ffc46b; }
  .note.ok { color:#7fd18a; }
  .wrow { gap:6px; }
  /* 「中間部件」勾選框（跟字框同一列 ✓） */
  .chk { display:inline-flex; align-items:center; gap:4px; font-size:12px; color:var(--fg);
         cursor:pointer; user-select:none; }
  .chk input { width:14px; height:14px; margin:0; accent-color:var(--acc); cursor:pointer; }
  .wrow input[type=range] { flex:1; min-width:70px; }
  #boxMode { font-size:12px; padding:4px 8px; }
  /* ★ 師父 2026-10-16：「暫時隱藏 筆劃粗細 bar，改為 IDC」✓——
     整組（筆劃標籤／滑桿／百分比）包在一起，用「hidden」一起收 ✓。
     ⚠ 作者樣式的 display 會蓋掉 [hidden] ✗（第 112 輪的教訓 ✓）→ 這裡補一條 ✓。 */
  .wswrap { display:flex; gap:6px; align-items:center; flex:1 1 140px; }
  .wswrap[hidden] { display:none; }
  /* IDC 描述符的按鈕排 ✓（12 顆，窄螢幕自動換行 ✓）。
     ⚠ 作者樣式的 display 會蓋掉 [hidden] ✗（第 112 輪的教訓 ✓）→ 自己補一條 ✓。 */
  .idcrow { display:flex; flex-wrap:wrap; gap:3px; align-items:center; flex:1 1 auto; }
  .idcrow[hidden] { display:none; }
  /* ★ 按鈕上放的是**描述符本身**（⿰⿱…✓）；人話（左右／上下…）在 tooltip ✓。
     字級比內文大一級 ✓（描述符的字形本來就小 ✓）。 */
  .idc { padding:1px 6px; font-size:15px; line-height:1.35; border-radius:5px; }

  /* ---- 2. 大字（左）＋ 部件清單（右，豎排、靠右） ----
     flex-wrap ＋ **部件清單的最小寬度**是防重疊的保險：萬一視窗真的不夠寬，
     右欄會整塊換到下一行，不會壓到大字。 */
  .stagewrap { display:flex; flex-wrap:wrap; justify-content:flex-start; align-items:flex-start; gap:8px; }
  /* ★ 排序：**大字 → 部件清單 →（建議並排）** ✓——
     建議並排（#sugWrap）是 200×200 的大方塊，擠在中間會把部件清單推到**大字下方** ✗
     （師父 2026-10-15 回報：「新增庫存字「幸土业」，部件清單跑到大字下方去了」✓）。 */
  .stagewrap .stage { order:0; }
  .side { order:1; }
  .stagewrap .cells { order:2; }
  /* ★ 師父 2026-10-16：**大字的空間優先** ✓——大字永遠是 200×200，
     窄螢幕**不要**把它縮小 ✗（縮小＝主角讓位給旁邊的清單 ✗）；
     不夠寬的時候讓**部件清單自己換到下一行** ✓（flex-wrap 會做 ✓）。
     ⚠ 以前在 <=430px 把「.stage」縮成 150 ✗，想省空間，結果是
        「大字的每一層都還是 200」→ 溢出自己的框、壓到部件清單上 ✗（見下面每一層的註解 ✓）。 */
  .stage { position:relative; flex:none; width:200px; height:200px; color:var(--fg);
           border:1px dashed var(--line); border-radius:4px; }
  /* ★ 師父 2026-10-15：**部件清單要緊湊**——原本是**豎排單欄** ✗，
     部件一多就變成一條長柱、右邊卻空著一大片 ✗。
     改成**吃滿右邊剩下的寬度、自動換行** ✓（左起排、靠大字那一側開始排 ✓）。
     ★ 2026-10-16：最小寬度＝**放得下三個方格** ✓（「--chip」跟著手機大小走 ✓）——
     分不到三個方格就**整塊換到下一行、吃滿整寬** ✓，不要變成一格一列的長柱 ✗
     （師父：「部件清單占位太大」✓）。 */
  .side { flex:1 1 calc(var(--chip) * 3 + 8px); min-width:calc(var(--chip) * 3 + 8px); max-width:100%;
          display:flex; flex-direction:column; gap:4px; align-items:flex-start; text-align:left; }
  .sidecap { font-size:11px; color:var(--mut); line-height:1.4; }
  /* 部件清單：方形按鈕（KAGE 字形）**自動換行、填滿可用寬度** ✓（緊湊 ✓）。
     「--chip」是唯一的尺寸來源 ✓（窄螢幕只改這一個值 ✓）。 */
  .chips { display:flex; flex-wrap:wrap; gap:4px; align-content:flex-start;
           justify-content:flex-start; width:100%; }
  .mini.comp { position:relative; display:flex; align-items:center; justify-content:center;
               width:var(--chip); height:var(--chip); flex:none; border:1px solid var(--line);
               border-radius:6px; background:var(--card); color:var(--fg); cursor:pointer; }
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
  .mini.comp .g { width:calc(var(--chip) - 8px); height:calc(var(--chip) - 8px); display:block; }
  .mini.comp .g svg { width:100%; height:100%; display:block; }
  .mini.comp .ids { position:absolute; right:1px; bottom:0; font-size:8px; color:var(--mut);
                    font-family:ui-monospace,monospace; }
  @media (max-width:430px) {
    /* 手機過窄：**只把方格縮小** ✓（大字不動 ✗）——清單會自己換行、真的擠不下就整塊換到下一行 ✓ */
    body { --chip:38px; }
  }
  /* ★ 2026-10-16：**大字裡的每一層都跟著「.stage」的大小** ✓（100% ✓）。
     ⚠ **不要**在這些規則裡寫死 200px ✗：寫死的規則在檔案裡比 media query 更後面，
        會**蓋掉**窄螢幕的尺寸 ✗ → 大字溢出自己的框、壓到右邊的部件清單上 ✗
        （師父 2026-10-16 回報的「部件清單與大字重疊」就是這個 ✓）。 */
  .stage > svg { position:absolute; left:0; top:0; width:100%; height:100%; display:block; }
  .stage .ph { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
               text-align:center; color:var(--mut); font-size:12px; line-height:1.7; padding:8px; }
  /* ★ 2026-10-16：不合法的表意描述序——**紅字留在畫面上** ✓（浮層 3 秒就消失 ✗，
     消失之後客人只看到一片空白、不知道要改哪裡 ✓）。 */
  .stage .ph.err { color:#ff8a8a; }
  /* ⚠ 這裡曾經有一條「滑過某一塊就把主字形收起來」（.stage.iso > svg.gly { opacity:0 } ✗）——
     第 176 輪**刪掉了** ✗：師父原話的括號是在**描述症狀**（高亮畫歪了、變成一塊蓋住其他部件 ✓），
     不是要求「只看那一塊」✓；他隔一輪就回報「hover 過去時，其他的白色筆劃都不見了」✗。
     滑過＝**只染色** ✓（.hllayer ✓），其他筆劃照舊看得見 ✓。 */
  /* ★ 師父 2026-10-16：「**如果大字是 Unicode 有收的字**，在**右下方**顯示 Unicode 區位及
     codepoint（字體大小可以和「中間部件」一樣大）」✓——「中間部件」是 12px ✓，這裡就 12px ✓。
     ⚠ 組出來的形（fork 出來、沒有碼位 ✗）不顯示 ✓（見 pinxing-page.js 的「renderCpInfo()」✓）。
     「pointer-events:none」✓：它疊在大字上，不可以吃掉「點框選部件」的滑鼠事件 ✗。 */
  .stage .cpinfo { position:absolute; right:4px; bottom:1px; font-size:12px; line-height:1.3;
                   color:var(--mut); letter-spacing:.5px; pointer-events:none; }
  /* 部件框疊在大字上（座標系一樣，都是 viewBox 0 0 200 200，不必換算）。
     框是**獨立一層 svg.boxlayer**，絕對定位疊上去——
     g 單獨塞進 HTML 會被解析器丟掉（踩過：大字的框整個不見）。 */
  .stage .boxlayer { position:absolute; left:0; top:0; width:100%; height:100%; }
  /* ★ 選中的部件：**筆劃染成框色**的一層 ✓（師父 2026-10-15）。
     文件序在 boxlayer **之前**＝畫在框的下面 ✓（框線不會被蓋掉 ✓）；
     不吃滑鼠事件 ✓（點框還是由框層決定 ✓）。 */
  .stage .hllayer { position:absolute; left:0; top:0; width:100%; height:100%; pointer-events:none; }
  /* ★ 師父 2026-10-16：「字框：隱」時框**只是看不見，還是有作用** ✓——
     在大字上滑過／點下去，照樣選到那一格、把它的筆劃塗成那一格的顏色 ✓。
     所以要留著框層（透明 ＋ 自己吃滑鼠事件 ✓），不是整層拿掉 ✗。 */
  .stage .boxlayer.ghost .cbox { fill:transparent; stroke:none; pointer-events:all; }
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
  /* ★ 反向連動：滑過**部件清單的格子** → 大字的框也亮 ✓（見 pinxing-page.js 的 hoverFrame ✓）。
     ⚠ 同樣要為「.sub」再寫一份，否則會被「.cbox.sub」蓋掉 ✗。 */
  .cbox.hover { fill:color-mix(in srgb, var(--c) 24%, transparent); stroke-width:2.2; }
  .cbox.sub.hover { stroke-dasharray:none; stroke-width:2; fill-opacity:.42; }
  /* ★ 2026-10-16：**不認「color-mix()」的瀏覽器要活下來** ✓——
     微信內建的 X5（Chromium 111 以前 ✓）與 iOS 16.2 以前都還不認它 ✗，
     而被丟掉的那一條是「fill」✗ → 退回**預設的黑** ✗＝字框變成一塊黑板、把大字整塊蓋掉 ✗。
     純色 ＋「fill-opacity」是新舊都認的 ✓，效果與 color-mix 那一條**完全一樣** ✓
     （「color-mix(in srgb, C 11%, transparent)」＝ C 帶 11% 的 alpha ✓；
      孫框的 .22／.42／.55 是**再乘上去**的倍率 ✓，所以這裡的值要乘進去 ✓）。 */
  @supports not (fill: color-mix(in srgb, red 11%, transparent)) {
    .cbox { fill:var(--c); fill-opacity:.11; }
    .cbox:hover { fill-opacity:.24; }
    .cbox.on { fill-opacity:.30; }
    .cbox.sub { fill-opacity:.024; }
    .cbox.sub:hover { fill-opacity:.046; }
    .cbox.sub.on { fill-opacity:.061; }
    .cbox.hover { fill-opacity:.24; }
    .cbox.sub.hover { fill-opacity:.046; }
  }

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

  /* ---- 7. 候選（非法序列 → 部件搜尋） ----
     ★ 師父 2026-10-16：「**候選字依 unicode 分區使用不同顏色，配色同 glyph-browser.html**」✓
     顏色走「--bc」（由 JS 寫進每一格 ✓）、字形「fill:currentColor」✓——
     跟字集瀏覽頁的格子**同一個做法** ✓（那裡的「.cell」也是「color:var(--bc)」✓）。
     ⚠ 調色盤只有一份：「tools/glyph-common-page.js」的「BLOCKS」／「colorOfCp()」✓。
     ⚠ 只有**候選字**上區塊色 ✓（「.cell.cand」✓）：部件清單用的是**框色**（「--c」✓），
        兩套色系刻意不同，才分得出「這個顏色在講區塊還是講第幾個部件」✓。 */
  .cands { display:grid; grid-template-columns:repeat(auto-fill,minmax(56px,1fr)); gap:4px; }
  .cell { border:1px solid var(--line); border-radius:5px; text-align:center; cursor:pointer;
          padding:1px; overflow:hidden; background:var(--card); }
  .cell:hover { border-color:var(--acc); }
  .cell .g { height:52px; color:var(--fg); }
  .cell .g svg { width:100%; height:100%; display:block; }
  .cell .c { font-size:9px; font-family:ui-monospace,Consolas,monospace; }
  /* ⚠ 碼位的**淡化**從「.c」搬到裡面的「.cp」✓：小標要和碼位同一行（左下角 ✓），
     但小標要**醒目**（不可以跟著淡化 ✗）——「opacity」會蓋住整個子樹，救不回來 ✗。 */
  .cell .c .cp { opacity:.6; }
  /* ★ 師父 2026-10-16：碼位**左下角**標「這個字屬於哪一區」✓——
     Extension＝**英文字母**（A..I ✓）、相容區＝「相」「補」✓、**基本區 2 萬字不標** ✓
     （「mark:""」✓，見共用層的「BLOCKS」✓）。
     醒目＝**粗體 Arial** ＋ **自己那一區的顏色**（「--bc」✓，跟字形同色 ✓）＋ 比碼位大一級 ✓。 */
  .cell .c .blkmark { font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:11px;
                      line-height:1; color:var(--bc); margin-right:3px; }
  /* 候選字：字形與碼位（「.c」繼承 ✓）都用**自己那一格的區塊色** ✓、邊框也染同一色 ✓
     （邊框那條「color-mix」舊瀏覽器不認 ✗ → 整條被丟掉 → 留著上面「.cell」的「var(--line)」✓）。 */
  .cell.cand { color:var(--bc); border-color:color-mix(in srgb, var(--bc) 26%, var(--line)); }
  .cell.cand:hover { border-color:var(--bc); }
  .cell.cand .g { color:var(--bc); }
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
  .credits a { color:var(--acc); text-decoration:none; }
  .credits a:hover { text-decoration:underline; }
  /* ★ 師父 2026-10-16：**微信的保險** ✓——微信內建瀏覽器（舊 X5／iOS 16.4 以前）
     不一定解得開這包字庫 ✗。純 JS 的後備已經補上了 ✓（見 glyph-common-page.js ✓），
     但**沒辦法在真的微信裡驗** ✗，所以最底部留一行白話的指示 ✓（師父指定的字，一字不改 ✓）。 */
  .wechat { margin:6px 2px 0; font-size:11px; line-height:1.7; color:var(--mut); text-align:center; }

  /* ★ 師父 2026-10-16：「**部件檢字狀態時，要顯示運算子的用法**（滑鼠 hover 到「部件檢字」就 popup）」✓。
     浮層＝**absolute** ✓（跟 .toast 一樣不佔高度、不會推動版面 ✓）；
     ⚠ 它掛在 **「header.top」**底下（不是「.seqrow」✗）——貼在輸入區那一列的下方會**蓋住同一張卡裡的
        「筆劃」滑桿** ✗，看起來像壞掉 ✓；貼在整張卡的下方＝像一張說明卡掛在工具列下面 ✓。
     「z-index」比 .toast（20 ✓）高 ✓，兩個一起出現時，客人在讀的這一份在上面 ✓。
     ⚠ 只有**部件檢字**那一個狀態會開 ✓（見 pinxing-page.js 的「showLabelHelp()」✓）——
        空白與拼形序時滑過去不該彈東西出來 ✗（那時沒有運算子可用 ✓）。 */
  .lblhelp { position:absolute; left:8px; top:calc(100% - 2px); z-index:40; display:none;
             max-width:min(320px, 92vw); padding:8px 10px; border-radius:8px;
             font-size:12px; line-height:1.9; text-align:left; color:var(--fg);
             background:var(--card); border:1px solid var(--line);
             box-shadow:0 6px 20px rgba(0,0,0,.35); }
  .lblhelp.on { display:block; }
  /* 標籤一律用問號游標 ✓＝「這裡有說明可以滑」✓（每一種狀態都有 hover 說明 ✓：
     部件檢字＝運算子用法 ✓、其餘＝拼形序的專利依據 ✓）。 */
  #seqlbl { cursor:help; }

${TOUR_CSS}
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
      <!-- ★ 師父 2026-10-16：「**「拆成 IDS」功能與「魔杖」放在同一位置。用「🧩」這個圖示。
           hover 時說明「將字拆分成IDS」**」✓——所以從下面那一列搬到**輸入區這一列** ✓、
           跟在魔杖旁邊 ✓（🧩 在 🪄 **左邊** ✓：魔杖與「存起來」的相對位置是師父指定的 ✓，
           不要插進它們中間 ✗）。
           ⚠ 只應在**輸入單個非獨體字**時出現 ✓（見 pinxing-page.js 的「showEl($("toIds"), …)」✓）；
              「hidden」單獨沒有用 ✗（「.iconbtn」的「display:flex」是作者樣式、會蓋掉它 ✓），
              所以 CSS 補一條「#toIds[hidden]」✓、開頁前也不會閃出來 ✓。 -->
      <button id="toIds" class="iconbtn" title="將字拆分成IDS" hidden>🧩</button>
      <!-- ★ 師父第 136 輪：**魔術棒 🪄** —— 有建議的拼形序時才出現 ✓；
           點一下＝把下一個建議填進輸入區 ✓（再點換下一個 ✓）。
           DOM 位置在「存起來」（#saveSeq）的前一個 ✓（師父指定的位置 ✓）。 -->
      <button id="wand" class="iconbtn" title="系統建議的拼形序（點一下套用；再點換下一個）" hidden>🪄</button>
      <!-- 存起來：svg 圖示（磁片）＋ 加號；Enter 也可以存。不是合法拼形式時整顆收起 -->
      <button id="saveSeq" class="iconbtn" title="存起來（或在輸入區按 Enter）">
        <svg class="icoSave" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 4h11l5 5v11H4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
          <path d="M8 4h7v5H8z" fill="currentColor"/>
          <path d="M8 14h8v6H8z" fill="none" stroke="currentColor" stroke-width="1.5"/>
          <path d="M17 3v5M14.5 5.5h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        </svg>
        <svg class="icoDel" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M7 6.5l1.2 13.5h7.6L17 6.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M10 10v6.5M14 10v6.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
      </button>
      <!-- ★ 2026-10-25：**操作導覽 🦮（導盲犬）** ✓——
           位置＝**存檔旁邊**（師父指定的 ✓）：那一列本來就是客人一定會看的地方 ✓，
           不必再用一個文字連結佔位置 ✓（窄螢幕上多一行字很貴 ✓）。
           ⚠ 圖示鈕只寫 emoji ✗，所以 **title 與 aria-label 兩個都要有** ✓——
             title 是滑鼠的說明、aria-label 是螢幕閱讀器的名字 ✓（skill 的規則：
             icon-only 的入口用 🦮，緊接在主要動作（存檔）後面 ✓，見
             d:\2026\agent-norms\skills\self-explaining-tour\SKILL.md 第 9 步 ✓）。
           ⚠ 不可以用 ▶／🎬／? ✗——那些讀成「播放示範」「說明頁」，客人會直接跳過 ✓。
           ⚠ 字級跟 🧩🪄 一起調（見上面「#wand, #toIds, #tourEntry」那條 ✓）。 -->
      <button id="tourEntry" type="button" class="iconbtn"
              title="操作導覽（跟著做一次就會用，約一分鐘）" aria-label="操作導覽">🦮</button>
      <!-- 浮層提示：貼在輸入區正下方，不佔高度（absolute），所以畫面不會晃動 -->
      <span class="toast" id="msg"></span>
    </div>
    <!-- 5. 筆劃粗細 ＋ 6. 字框（三態）：跟輸入區同一張卡，調完立刻看得到大字變化 -->
    <div class="row wrow">
      <button id="boxMode" data-mode="tight">字框：顯</button>
      <!-- ★ 師父 2026-10-15：**顯示中間部件** ✓——
           不勾＝只列／只框「最終組字用到的部件」✓；勾了＝連中間部件（孫框）一起 ✓。 -->
      <label class="chk" title="勾了就連中間部件一起顯示"><input type="checkbox" id="showMid"><span>中間部件</span></label>
      <!-- ★ 師父第 124 輪：客人不會打 IDC ✓，所以要有按鈕把字**拆成表意描述序** ✓
           （★ 師父 2026-10-16：「構字式（IDS）」改稱「**表意描述序**」✓——標籤、tooltip、
              人話轉寫、浮層提示一起改 ✓；按鈕上的「IDS」是國際通用簡寫，留著 ✓） -->
      <!-- ★ 師父 2026-10-16：「拆成 IDS」**搬到輸入區那一列、跟在魔杖旁邊、改用 🧩** ✓
           （見上面 #toIds 的註解 ✓）；這裡不再留一顆文字按鈕 ✗。 -->
      <!-- ★ 師父 2026-10-16：「**IDC 按鈕占用筆劃大小那一位置**（**其他模式顯示筆劃大小**）」✓——
           兩者**同一個位置**、不並排 ✓（那一列在手機上本來就擠 ✓）：
           表意描述序＝給描述符 ✓（客人打不出 ⿰ ✗）；其他模式＝給筆劃粗細 ✓。
           ⚠ 由 JS 依模式切換 ✓（見 pinxing-page.js 的「applyToolRow()」✓）——
             所以這裡**兩邊都不要寫死「hidden」**✗（寫死會讓另一個模式也看不到 ✓）；
             只是開頁那一下要「hidden」當保險 ✓（JS 一跑就會校正 ✓）。
           ⚠ 包一層「#wscaleWrap」是為了**整組一起收** ✓（標籤／滑桿／百分比三顆 ✓）。 -->
      <span class="wswrap" id="wscaleWrap">
        <span class="note">筆劃</span>
        <input id="wscale" type="range" min="40" max="220" step="5" value="100">
        <span class="note" id="wscaleV">100%</span>
      </span>
      <!-- ★ 師父 2026-10-16：**IDC 描述符**（U+2FF0–2FFF ✓）——客人打不出來 ✗，
           所以給一排按鈕，點一下插進輸入區的游標位置 ✓（見 pinxing-page.js ✓）。
           ★ 師父 2026-10-16（同日追加）：「**IDC 按鈕改用 IDC 字符來顯示，「左右」「上下」
             改為 hover hint**」✓——按鈕上就是 ⿰⿱⿲……✓，人話（左右／上下…✓）搬到 tooltip ✓。
           ⚠ 按鈕由 JS 依「IDS_ARITY」的順序生出來 ✓（不要在這裡手寫 12 顆 ✗：順序會對不上 ✓）。 -->
      <span class="note" id="idcLabel" hidden>IDC</span>
      <span class="idcrow" id="idcRow" hidden></span>
    </div>
    <!-- ★ 師父 2026-10-16：**檢字運算子的用法** ✓——只有「部件檢字」時滑過上面的標籤才彈出來 ✓。
         掛在「header.top」底下 ✓（貼在「.seqrow」下面會蓋住「筆劃」滑桿 ✗）。
         內容由共用層的「searchHelpHtml()」填 ✓（與字集瀏覽頁的「運算式說明」同一份 ✓）。 -->
    <div class="lblhelp" id="lblHelp" hidden></div>
  </header>

  <!-- 2. 大字（左）＋ 4. 部件序列（右，豎排） -->
  <div class="sec">
    <!-- ★ 師父 2026-10-15：**「拼出來的形」＋右邊那行說明（組出來的形（無碼位 以 U+… 為基礎））
         整行拿掉** ✓——省一行垂直空間 ✓。
         ⚠ 說明的內容保留在**隱藏**的 #bigNote 裡：check-pinxing 用它驗各模式的文字 ✓
         （畫面完全不佔空間 ✓）。 -->
    <span class="r note" id="bigNote" hidden></span>
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

  <!-- 7. 不是合法拼形序列時：當部件搜尋，候選列在最下方 -->
  <div class="sec" id="candSec">
    <div class="cap">候選字<span class="r note" id="candNote"></span></div>
    <div class="cands" id="cands"></div>
    <div class="row"><button id="moreBtn" hidden>再看更多</button></div>
  </div>

  <!-- 授權宣告（使用者指定的文字，一字不改）
       ★ 師父 2026-10-16：「最下方『**拼形序依據 中国发明专利 201610984608.1 号**』
         移到上方『構形序』的 hover 說明」✓——那一整句**搬到標籤的 hover 浮層** ✓
         （見 pinxing-page.js 的「PATENT_LINE」✓，字一字不改 ✓）；
         這裡只留「基於開源字庫」與微信 ✓（句子接得順，不留孤零零的標點 ✓）。 -->
  <footer class="credits">
    基於開源字庫 Glyphwiki+Kage　·　微信：wxx68174671${DEV_LINK}
  </footer>
${WECHAT_LINE}

</div>

<!-- ==================== 操作導覽的外殼（tools/tour/shell.html）====================
     放在 .wrap **外面**：聚光燈／氣泡／選單都是 position:fixed ✓，
     留在 .wrap 裡面只會被 460px 的版面牽著走（沒有好處，還多一個誤會的來源 ✗）。 -->
${TOUR_SHELL}

${HOSTED_PRELUDE}
<script>
${COMMON_SCRIPT}
/* ============ 兩頁共用的頁面端程式碼（tools/glyph-common-page.js） ============ */
${commonPageJs}
${PAGE_JS}
/* ============ 操作導覽：劇本資料（tools/tour/tours/*.tour 編譯）＋ 播放器 ============
 * ⚠ 放在頁面程式碼**之後** ✓（不是之前 ✗）：check-pinxing.ts 會把主 script 的前半段
 *   （引擎 ＋ 共用層 ＋ 這一頁的程式碼到「字庫與索引」為止）抽出來丟進 new Function() 裡跑，
 *   那一段是**沒有 window 的**（Node 端）✓。播放器一開頭就是「(function (global) …)(window)」✗，
 *   放進那一段就會得到「window is not defined」✓（實測踩過）。
 *   頁面程式碼只在 .then()／事件裡用到播放器，那時整支 script 早就跑完了 ✓。 */
${TOUR_SLOT}
${TOUR_PLAYER}

</script>

<!-- ★ 2026-10-16：**開頁看門狗** ✓——萬一這個瀏覽器連字庫都解不開（例：舊微信 ✓），
     至少要在畫面上說清楚，而不是留一個「安靜的死頁」✗（師父：「輸入也沒有動作，
     貌似數據沒有載入」——那時畫面上什麼都沒有 ✓）。
     ⚠ 一定要是**獨立的一支 script** ✓：主 script 若**語法**就掛掉（舊引擎不認新語法 ✓），
        同一支裡面的 catch 根本不會執行 ✗，只有另一支才跑得起來 ✓。
     ⚠ 這一行**不可以出現「載入失敗」四個字** ✗——驗收（check-pinxing.ts）用這四個字
        判斷「頁面起不來」✓，看門狗誤觸會變成假警報 ✗。 -->
<script>
(function () {
  var t = setTimeout(function () {
    if (window.__READY__) return;
    var d = document.createElement("div");
    d.id = "bootfail";
    d.style.cssText = "margin:8px;padding:10px 12px;border:1px solid #ff8a8a;border-radius:8px;" +
      "background:#2a1416;color:#ffb3b3;font:12px/1.8 system-ui,sans-serif";
    d.innerHTML = "這個瀏覽器沒能把字庫解開。" +
      "<br>微信打開看不到的話，用系統自帶的瀏覽器打開。";
    document.body.insertBefore(d, document.body.firstChild);
  }, 20000);
  /* 頁面起得來就把它收掉 ✓（pinxing-page.js 的 .then 會呼叫 ✓）。 */
  window.__BOOTOK__ = function () { clearTimeout(t); };
})();
</script>
</body>
</html>
`;

/* ==================== 兩段式建置：先編譯劇本、再寫頁面 ====================
 *
 * ① `html` 目前還是「沒有導覽資料」的那一頁（資料位置是 `TOUR_SLOT` 佔位）。
 *    拿它當 `templateHtml` 交給 `compileTours()`：劇本裡的選擇器會**逐個 #id 對照這一頁** ✓
 *    （`#seq`／`#big`／`#seqChips`… 改名或打錯，在這裡就失敗 ✗——不會等到客人面前 ⚠ 找不到）。
 * ② 資料只是 base64 與摘要，不含 id ✓，所以換進去之後 id 集合不變（第 ① 步的檢查仍然有效 ✓）。
 */
const compiled = compileTours({ ...tourConfig, templateHtml: html });
if (compiled.errors.length) {
  console.error("✗ 操作導覽的劇本有錯（見 tools/tour/tours/*.tour）：");
  for (const e of compiled.errors) console.error("  " + e);
  process.exit(1);
}
const TOUR_JS = tourDataJs(compiled.index, compiled.blobs);
if (html.indexOf(TOUR_SLOT) < 0) {
  console.error("✗ 產出頁裡找不到導覽資料的插入點（TOUR_SLOT 被改掉了？）");
  process.exit(1);
}
const finalHtml = html.replace(TOUR_SLOT, TOUR_JS);

mkdirSync(dirname(OUT_PATH), { recursive: true });
assertPageScript(finalHtml);
writeFileSync(OUT_PATH, finalHtml);
console.log(`已寫出 ${OUT_PATH}` + (HOSTED ? "（宿主模式：字庫走 /lib.bin）" : "（離線單頁：字庫內嵌）"));
console.log(`  ✓ 產出頁面的 script 語法正確`);
console.log(`  網頁大小 ${(Buffer.byteLength(finalHtml) / 1048576).toFixed(2)} MB`);
console.log(`  內嵌：kage-engine ${(Buffer.byteLength(engineSrc) / 1024).toFixed(0)} KB、` +
  `tools 模組 ${(Buffer.byteLength(bundleSrc) / 1024).toFixed(1)} KB、` +
  (HOSTED
    ? `字形庫 **不內嵌**（改由 /lib.bin 一次 fetch，4.49 MB）`
    : `字形庫 base64 ${(libB64.length / 1048576).toFixed(2)} MB`));
console.log(`  操作導覽：${compiled.index.length} 份劇本、` +
  `${compiled.index.reduce((a, t) => a + t.scenes, 0)} 個場景 → ` +
  `內嵌 ${(Buffer.byteLength(TOUR_JS) / 1024).toFixed(1)} KB`);

