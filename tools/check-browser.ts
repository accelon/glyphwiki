#!/usr/bin/env bun
/**
 * check-browser.ts — 驗收 `out/glyph-browser.html`（字集瀏覽頁）。
 *
 * 這一頁有三個需求，所以驗收也要逐條走一遍：
 *   1. 輸入 codepoint／跳到 Extension 區塊
 *   2. 輸入部件，只列出含有該部件的字
 *   3. 選定字／部件時，列出它能構成的所有字與其他異體
 *
 * 只驗「程式碼沒問題」不夠——`svgFor`、虛擬滾動、事件綁定都是頁面自己的程式碼，
 * 寫錯只有真的開起來才會發現。所以照 `check-viewer.ts` 的模式，
 * 最後用 Edge headless **真的跑一遍頁面並模擬這三個操作**。
 *
 * 用法: bun run tools/check-browser.ts
 */
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const D = "D:/2023/glyphwiki";
const PAGE = resolve(D, "out/glyph-browser.html");
const LIB = "lib-cjk-all";
let fail = 0;
const ok = (s: string) => console.log("  ✓ " + s);
const bad = (s: string) => { console.log("  ✗ " + s); fail++; };

// 1) 網頁存在
console.log("1. 產出物");
if (!existsSync(PAGE)) { bad("找不到 out/glyph-browser.html（先跑 build-glyph-browser.ts）"); process.exit(1); }
const html = readFileSync(PAGE, "utf8");
ok(`out/glyph-browser.html 存在（${(Buffer.byteLength(html) / 1048576).toFixed(2)} MB）`);

// 2) 內嵌的模組碼能不能解碼整份字庫、三個需求的資料層能不能跑
console.log("\n2. 內嵌程式碼：解碼 ＋ 三個需求的資料層");
{
  const sm = /<script>([\s\S]*?)<\/script>/.exec(html);
  const ENGINE_END = "/* ============ 解碼 + 量測";
  const MAIN_START = "/* ============================ 主流程";
  const script = sm ? sm[1]! : "";
  const engEnd = script.indexOf(ENGINE_END);
  const mainStart = script.indexOf(MAIN_START);
  const engineSrc = engEnd > 0 ? script.slice(0, engEnd) : "";
  const head = mainStart > 0 ? script.slice(0, mainStart) : null;
  const b64m = sm ? /var LIB_B64 = "([^"]*)"/.exec(sm[1]!) : null;
  if (!sm) bad("找不到 script 區塊");
  else if (engEnd < 0) bad("找不到引擎分隔註解");
  else if (!head) bad("找不到主流程分隔註解");
  else if (!b64m) bad("找不到 LIB_B64");
  else {
    try {
      (0, eval)(engineSrc);
      const api = new Function(
        head + "\nreturn { decodeLibrary: decodeLibrary, indexOfCodePoint: indexOfCodePoint," +
        " codePointOf: codePointOf, familyMembers: familyMembers, refSlotsOf: refSlotsOf," +
        " isPlainIdeograph: isPlainIdeograph, inkZoneOf: inkZoneOf," +
        " inkOfRefInParent: inkOfRefInParent, zoneMatches: zoneMatches," +
        " searchByComponent: searchByComponent };",
      )();
      const lib = api.decodeLibrary(new Uint8Array(Bun.gunzipSync(Buffer.from(b64m[1]!, "base64"))));
      ok(`解碼成功：${lib.glyphs.length.toLocaleString()} 字形、${lib.families.length.toLocaleString()} 家族`);
      lib.families.length > 0 ? ok("是 v2 格式（有家族表）") : bad("沒有家族表");

      // 需求 1 的資料層：12 個區塊的端點都查得到
      const EDGES: [string, number][] = [
        ["Ext A 頭", 0x3400], ["URO 頭", 0x4e00], ["Ext B 頭", 0x20000], ["Ext C 頭", 0x2a700],
        ["Ext D 頭", 0x2b740], ["Ext E 頭", 0x2b820], ["Ext F 頭", 0x2ceb0], ["Ext I 頭", 0x2ebf0],
        ["Ext G 頭", 0x30000], ["Ext H 頭", 0x31350], ["相容區 頭", 0xf900], ["相容補充 頭", 0x2f800],
        ["𩀨 U+29028", 0x29028],
      ];
      const missBlocks = EDGES.filter(([, cp]) => api.indexOfCodePoint(lib, cp) === undefined);
      missBlocks.length === 0
        ? ok(`13 個取樣碼位（12 個區塊頭 ＋ 𩀨）全部查得到`)
        : bad(`查不到：${missBlocks.map(([n]) => n).join("、")}`);

      // 需求 2 的資料層：部件索引
      const t0 = performance.now();
      const comp = new Map<number, number[]>();
      for (let i = 0; i < lib.glyphs.length; i++) {
        if (!api.isPlainIdeograph(lib, i)) continue;
        for (const s of api.refSlotsOf(lib, i)) {
          const cp = api.codePointOf(lib, s.ref);
          if (!cp) continue;
          const a = comp.get(cp);
          if (a) a.push(i); else comp.set(cp, [i]);
        }
      }
      const tIdx = performance.now() - t0;
      ok(`部件索引：${comp.size.toLocaleString()} 個部件、` +
        `${[...comp.values()].reduce((n, a) => n + a.length, 0).toLocaleString()} 條邊（${tIdx.toFixed(0)} ms）`);

      // 隹：先用索引查，再加位置篩選，兩者都要有結果且后者是前者的子集
      const ZHUI = 0x96b9;
      const all = comp.get(ZHUI) ?? [];
      all.length > 10 ? ok(`「隹」作為直接部件：${all.length} 個字`) : bad(`「隹」只有 ${all.length} 個字`);
      const left: number[] = [];
      for (const p of all) {
        for (const s of api.refSlotsOf(lib, p)) {
          if (api.codePointOf(lib, s.ref) !== ZHUI) continue;
          let z: string;
          try { z = api.inkZoneOf(lib, p, s.strokeIx, api.inkOfRefInParent); } catch { z = s.zone; }
          if (api.zoneMatches(z, "左")) { left.push(p); break; }
        }
      }
      left.length > 0 && left.length < all.length
        ? ok(`位置篩選「左」：${left.length} 個（全部 ${all.length} 個，確實變少）`)
        : bad(`位置篩選異常：全部 ${all.length}、左 ${left.length}`);

      // 需求 3 的資料層：異體 ＋ 引用樹
      const luo = api.indexOfCodePoint(lib, 0x908f)!;
      const fam = api.familyMembers(lib, 0x908f);
      fam.length > 1 ? ok(`U+908F 的異體：${fam.length} 個`) : bad(`U+908F 只有 ${fam.length} 個異體`);
      const slots = api.refSlotsOf(lib, luo);
      slots.length >= 2 ? ok(`U+908F 由 ${slots.length} 個部件構成`) : bad(`U+908F 只有 ${slots.length} 個部件`);
      const luoParents = comp.get(0x908f) ?? [];
      ok(`「邏」作為部件出現在 ${luoParents.length} 個字裡`);
      // 深層搜尋（需求 2 的「含深層」）
      const t1 = performance.now();
      const deep = api.searchByComponent(lib, { ch: "隹", level: 3, limit: 4000, inkOfRef: api.inkOfRefInParent });
      const msDeep = performance.now() - t1;
      deep.length >= all.length
        ? ok(`含深層（L3）搜尋：${deep.length} 個（直接部件 ${all.length} 個），${msDeep.toFixed(0)} ms`)
        : bad(`深層搜尋比直接部件還少：${deep.length} < ${all.length}`);
    } catch (e) {
      bad("解碼或資料層失敗：" + (e as Error).message);
    }
  }
}

// 3) 網頁 script 語法
console.log("\n3. 網頁語法");
{
  const sm = /<script>([\s\S]*?)<\/script>/.exec(html);
  try { new Function(sm![1]!); ok("script 區塊語法正確"); }
  catch (e) { bad("語法錯誤：" + (e as Error).message); }
  /* ★ 2026-10-16：區塊調色盤（`BLOCKS` ＋ `blockIndexOf`／`colorOfBlock`／`colorOfCp`／
     `colorOfGlyph`）搬進**共用層** `tools/glyph-common-page.js` ✓——拼形頁的**候選字**
     要用同一套色 ✓（師父：「配色同 glyph-browser.html」✓）。
     ⚠ 這一頁**不可以**再定義第二份 ✗（改了共用層就會兩頁一起變 ✓）。
     兩份產出物的調色盤是否**逐字相同**，由 `check-pinxing.ts` 交叉比對 ✓。 */
  const nBlocks = (sm![1]!.match(/var BLOCKS = \[/g) || []).length;
  nBlocks === 1
    ? ok("區塊表只有一份（在共用層；這一頁沒有再抄第二份 ✓）")
    : bad(`出現 ${nBlocks} 份 var BLOCKS——調色盤應該只有共用層那一份 ✗`);
}

// 4) base64 完整性
console.log("\n4. base64");
{
  const b64 = /var LIB_B64 = "([^"]*)"/.exec(html)![1]!;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) bad(`base64 格式有問題（長度 ${b64.length}）`);
  else {
    const gz = Buffer.from(b64, "base64");
    gz[0] === 0x1f && gz[1] === 0x8b
      ? ok(`base64 合法、還原為 gzip（${(gz.length / 1048576).toFixed(2)} MB）`)
      : bad("base64 還原後不是 gzip");
  }
}

// 5) 這一頁的定位
console.log("\n5. 這一頁的定位");
!/[Cc]ode[Mm]irror/.test(html) ? ok("沒有 CodeMirror（編輯器在 codemirror-kage.html）")
                               : bad("混入了 CodeMirror");
// 注意：這一頁**刻意**內嵌 free-compose（要 refSlotsOf 做引用樹），
// 而那份檔案裡有 INLINE_CSS 這個字串常數（編輯器內嵌序列用的樣式）。
// 字串存在不等於功能混進來，所以改驗「沒有序列裝飾的痕跡」。
!/gc-seq/.test(html) && !/gc-deco/.test(html)
  ? ok("沒有編輯器的序列裝飾（gc-seq／gc-deco）")
  : bad("混入了編輯器的序列裝飾");
/Unicode漢字集/.test(html) ? ok("頁名是「Unicode漢字集」（不是檢視頁、不是編輯器）") : bad("頁面標題不對");

// 6) 真的用 headless 瀏覽器跑一遍，並模擬三個需求
console.log("\n6. headless 瀏覽器實跑（模擬三個需求）");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
if (!existsSync(EDGE)) {
  console.log("  ！找不到 Edge，跳過瀏覽器實跑");
} else {
  const probe = `
<script>
(function () {
  function report(s) { document.title = "PROBE|" + s; }
  var out = [];
  /* **dispatchEvent 會吃掉事件處理器裡的例外**：頁面明明拋錯，
     外層完全看不到。掛 window.onerror 把它們抓進回報裡。 */
  window.addEventListener("error", function (e) { out.push("PAGEERR:" + e.message); });
  /* 頁面的初始化鏈有自己的 .catch()，會把例外寫進 body 變成「載入失敗：…」。
     那條路**不會**觸發 error 也不會觸發 unhandledrejection，所以上面那個監聽器
     看不到——踩過一次：抽出共用檔時漏搬 HUE_STEP，整頁只顯示一行紅字，
     而所有探針都只看到 undefined，查了很久。直接盯 body 最快。 */
  window.addEventListener("unhandledrejection", function (e) {
    out.push("REJECT:" + (e.reason && e.reason.message || e.reason));
  });
  var q = [
    function () {
      var r = window.__READY__ || {};
      /* **只看非 script 的可見文字**：document.body.textContent 連 <script> 的
         原始碼都算進去，而那段 catch 的字串就在原始碼裡——直接對它做 regex
         一定命中，變成永遠誤判。初始化失敗時 body 會被整個換成一行錯誤訊息，
         所以「可見文字裡有『載入失敗』」才是真的。 */
      var vis = "";
      for (var bi = 0; bi < document.body.children.length; bi++) {
        var bel = document.body.children[bi];
        if (bel.tagName !== "SCRIPT") vis += bel.textContent + " ";
      }
      out.push("loadError=" + (/載入失敗/.test(vis) ? 1 : 0));
      out.push("bodyHead=" + encodeURIComponent(vis.replace(/\s+/g, " ").trim().slice(0, 60)));
      out.push("glyphs=" + r.glyphs);
      out.push("comps=" + r.components);
      out.push("decodeMs=" + r.decodeMs);
      out.push("indexMs=" + r.indexMs);
    },
    /* --- 預設：整個 URO 列出、每格都有碼位 --- */
    function () {
      out.push("cells=" + document.querySelectorAll("#rows .cell").length);
      var h = document.getElementById("rows").innerHTML;
      out.push("hasLabel=" + /U\\+4E00/.test(h));
      out.push("hasSvg=" + (document.querySelectorAll("#rows .cell svg").length > 0));
      /* 狀態列與區塊名有空白，一定要編碼，否則外層用空白切欄位會截斷 */
      out.push("count=" + encodeURIComponent(document.getElementById("count").textContent));
      out.push("blocks=" + document.querySelectorAll("#blocks .blk").length);
      out.push("hasH1=" + (!!document.querySelector("h1")));
      out.push("docTitle=" + encodeURIComponent(document.title.slice(0, 20)));
    },
    /* --- 需求 1：跳到碼位 --- */
    function () {
      out.push("noJumpBox=" + (!document.getElementById("jump") && !document.getElementById("jumpGo")));
      var jb = document.getElementById("comp");
      jb.value = "U+908F"; jb.dispatchEvent(new Event("input"));
      out.push("selCp=" + codePointOf(LIB, SEL).toString(16).toUpperCase());
      out.push("jumpNote=" + encodeURIComponent(document.getElementById("compNote").textContent));
      jb.value = ""; jb.dispatchEvent(new Event("input"));
      out.push("detailHas=" + /U\\+908F/.test(document.getElementById("detail").innerHTML));
    },
    /* --- 需求 1b：區塊標籤 ＋ 複選（toggle） --- */
    function () {
      var blks = document.querySelectorAll("#blocks .blk");
      out.push("labels=" + Array.prototype.map.call(blks, function (b) {
        return b.textContent.replace(/[\\d,]/g, "");
      }).join("/"));
      out.push("tips=" + (((blks[2].getAttribute("title") || "").indexOf("Extension B")) >= 0));
      out.push("tipCount=" + (((blks[2].getAttribute("title") || "").indexOf("42,720")) >= 0));
      out.push("chipText=" + encodeURIComponent(blks[2].textContent.trim()));
      out.push("sel0=" + SEL_BLOCKS.join(","));
      blks[2].click();
      out.push("sel1=" + SEL_BLOCKS.slice().sort().join(","));
      out.push("blkCount=" + encodeURIComponent(document.getElementById("count").textContent));
    },
    /* --- 需求 1c：把 BMP 關掉，只留 B --- */
    function () {
      document.querySelectorAll("#blocks .blk")[0].click();
      out.push("sel2=" + SEL_BLOCKS.slice().sort().join(","));
      out.push("blkCount2=" + encodeURIComponent(document.getElementById("count").textContent));
    },
    /* --- 需求 2：部件搜尋（輸入就立刻搜尋，沒有按鈕） --- */
    function () {
      var box = document.getElementById("comp");
      box.value = "\\u96B9";
      box.dispatchEvent(new Event("input"));
      out.push("filterAll=" + LIST.length);
      /* **放寬約束**：未選取的區塊不再濾掉，改成排到後面。
         此時只選了 B（U+20000..U+2A6DF），清單應該「先 B、再其他」，只換手一次。 */
      var inB = 0, firstOut = -1, flips = 0, prev = null;
      for (var fi = 0; fi < LIST.length; fi++) {
        var inb = (LIST[fi] >= 0x20000 && LIST[fi] <= 0x2A6DF);
        if (inb) inB++; else if (firstOut < 0) firstOut = fi;
        if (prev !== null && prev !== inb) flips++;
        prev = inb;
      }
      out.push("filterInB=" + inB);
      out.push("filterOut=" + (LIST.length - inB));
      out.push("filterFirstOut=" + firstOut);
      out.push("filterFlips=" + flips);
      /* outside 的命中排在後面，第一屏看不到——捲到清單尾端再數 */
      var g0 = document.getElementById("grid");
      g0.scrollTop = g0.scrollHeight; renderVisible();
      out.push("filterOutsideCells=" + document.querySelectorAll("#rows .cell.outside").length);
      g0.scrollTop = 0; renderVisible();
      out.push("filterNote=" + encodeURIComponent(document.getElementById("compNote").textContent));
      out.push("filterCount=" + encodeURIComponent(document.getElementById("count").textContent));
      out.push("filterCells=" + document.querySelectorAll("#rows .cell").length);
    },
    /* --- 需求 2b：把 BMP 也打開，同一個搜尋的結果應該變多 --- */
    function () {
      document.querySelectorAll("#blocks .blk")[0].click();
      out.push("filterWide=" + LIST.length);
      out.push("filterHasBmp=" + LIST.some(function (cp) { return cp < 0x20000; }));
      var bmpPos = -1, bmpCount = 0;
      for (var wi = 0; wi < LIST.length; wi++) {
        if (LIST[wi] < 0x20000) { bmpCount++; if (bmpPos < 0) bmpPos = wi; }
      }
      out.push("filterBmpPos=" + bmpPos);
      out.push("filterBmpCount=" + bmpCount);
    },
    /* --- 需求 2c：位置運算子 木+ == 木在左 --- */
    function () {
      var box = document.getElementById("comp");
      box.value = "\u6728+"; box.dispatchEvent(new Event("input"));
      out.push("posLeft=" + LIST.length);
      out.push("posLeftNote=" + encodeURIComponent(document.getElementById("compNote").textContent));
      box.value = "+\u6728"; box.dispatchEvent(new Event("input"));
      out.push("posRight=" + LIST.length);
      out.push("hasXiu=" + LIST.some(function (c) { return c === 0x4F11; }));   /* 休 = 亻+木，木在右 */
      /* 沒加運算子＝直接部件，數量應該比只算左邊多 */
      box.value = "\u6728"; box.dispatchEvent(new Event("input"));
      out.push("posNone=" + LIST.length);
    },
    /* --- 需求 2d：多部件（深層）與重複部件 --- */
    function () {
      var box = document.getElementById("comp");
      box.value = "\u53E3\u6728"; box.dispatchEvent(new Event("input"));
      out.push("multi=" + LIST.length);
      out.push("hasDai=" + LIST.some(function (c) { return c === 0x5446; }));   /* 呆 = 口+木 */
      /* 杏 = ⿱木口，但 GlyphWiki 把「木」畫成原始筆劃、沒有 ref。
         只有接上 IDS 才找得到——這條是整件事的驗收點。 */
      out.push("hasXing=" + LIST.some(function (c) { return c === 0x674F; }));
      box.value = "\u6728"; box.dispatchEvent(new Event("input"));
      out.push("muAll=" + LIST.length);
      out.push("muHasXing=" + LIST.some(function (c) { return c === 0x674F; }));
      out.push("muHasLin=" + LIST.some(function (c) { return c === 0x6797; }));
      box.value = "\u6728\u6728"; box.dispatchEvent(new Event("input"));
      out.push("muMu=" + LIST.length);
      out.push("muMuHasLin=" + LIST.some(function (c) { return c === 0x6797; }));
      box.value = "\u53E3\u53E3"; box.dispatchEvent(new Event("input"));
      out.push("dup=" + LIST.length);
      out.push("hasQi=" + LIST.some(function (c) { return c === 0x5668; }));    /* 器 = 口×2 */
      out.push("hasKu=" + LIST.some(function (c) { return c === 0x54ED; }));    /* 哭 = 口×2 */
      out.push("noDai2=" + !LIST.some(function (c) { return c === 0x5446; }));  /* 呆只有 1 個口 */
    },
    /* --- 需求 2e：數字＝扣掉部件後剩餘筆劃；純數字＝獨體字 --- */
    function () {
      var box = document.getElementById("comp");
      box.value = "4\u6728\u65E5"; box.dispatchEvent(new Event("input"));
      out.push("remain=" + LIST.length);
      out.push("has2320C=" + LIST.some(function (c) { return c === 0x2320C; }));
      out.push("remainNote=" + encodeURIComponent(document.getElementById("compNote").textContent));
      box.value = "\u6728\u65E5"; box.dispatchEvent(new Event("input"));
      out.push("noDigit=" + LIST.length);
      box.value = "4"; box.dispatchEvent(new Event("input"));
      out.push("solo=" + LIST.length);
      out.push("soloNote=" + encodeURIComponent(document.getElementById("compNote").textContent));
      out.push("soloAll4=" + LIST.every(function (c) {
        var i = indexOfCodePoint(LIB, c); return strokesOf(i) === 4 && !hasRefStroke(i);
      }));
      /* 還原 */
      box.value = "\u96B9"; box.dispatchEvent(new Event("input"));
    },
    /* --- 需求 3：選一個字看詳細 --- */
    function () {
      document.querySelector("#rows .cell").click();
      var d = document.getElementById("detail").innerHTML;
      out.push("selHasCp=" + /U\\+/.test(d));
      out.push("hasVariants=" + /\\u7570\\u9AD4\\uff08/.test(d));
      out.push("hasParts=" + /\\u7531\\u54EA\\u4E9B\\u90E8\\u4EF6\\u69CB\\u6210/.test(d));
      out.push("hasForms=" + /\\u80FD\\u69CB\\u6210\\u7684\\u5B57/.test(d));
      out.push("bigClickable=" + getComputedStyle(document.querySelector("#detail .card:last-child .big")).cursor);
      out.push("bigTitle=" + encodeURIComponent(
        (document.querySelector("#detail .card:last-child .big") || {}).getAttribute
          ? document.querySelector("#detail .card:last-child .big").getAttribute("title") : ""));
      out.push("hasActions=" + /useAsComp/.test(d));
      out.push("miniCount=" + document.querySelectorAll("#detail .mini").length);
    },
    /* --- 搜尋結果同樣受「選取的區塊」約束：切掉一個區塊，結果要跟著少 --- */
    function () {
      out.push("blkScopeBefore=" + LIST.length);
      var wasOut = 0;
      for (var bi = 0; bi < LIST.length; bi++) if (LIST[bi] < 0x20000) wasOut++;
      out.push("blkWasOut=" + wasOut);
      document.querySelectorAll("#blocks .blk")[0].click();
      out.push("blkScopeAfter=" + LIST.length);
      document.querySelectorAll("#blocks .blk")[0].click();
      out.push("blkScopeBack=" + LIST.length);
    },
    /* --- 刪光輸入框就還原成選取區塊的全部字（沒有清除按鈕） --- */
    function () {
      var box = document.getElementById("comp");
      box.value = "";
      box.dispatchEvent(new Event("input"));
      out.push("cleared=" + LIST.length);
      out.push("clearedBlks=" + document.querySelectorAll("#blocks .blk.on").length);
      out.push("clearedNote=" + encodeURIComponent(document.getElementById("compNote").textContent));
      out.push("count2=" + encodeURIComponent(document.getElementById("count").textContent));
    },
    /* --- 沒有搜尋／清除按鈕了 --- */
    function () {
      out.push("noButtons=" + (!document.getElementById("compGo") && !document.getElementById("compClear")));
      var det = document.querySelector("header.top details");
      out.push("helpHidden=" + (!!det && !det.open && /\u6728\+/.test(det.textContent)));
      out.push("sizeLabel=" + encodeURIComponent(
        document.querySelector(".bar .ctrls").textContent.replace(/\\s+/g, "")));
      out.push("setBodyHidden=" + document.getElementById("setBody").hidden);
      document.getElementById("setBtn").click();
      out.push("setOpen=" + (!document.getElementById("setBody").hidden));
      out.push("inMenu=" + [ "cellN", "wscale", "outlineBtn" ].every(function (id) {
        return !!document.getElementById(id).closest("#setBody");
      }));
      document.getElementById("setBtn").click();
      out.push("setClosed=" + document.getElementById("setBody").hidden);
    },
    /* --- 筆劃粗細（KAGE 內建參數）：拉動之後描繪結果必須真的變 --- */
    function () {
      var w = document.getElementById("wscale");
      out.push("hasW=" + (!!w));
      out.push("wDefault=" + (w ? w.value : ""));
      /* 先疊兩張卡，再拉筆劃粗細——堆疊不可以被收掉。
         （踩過：處理器用 showDetail(SEL) 重畫，而 showDetail 的語意是
            「整個堆疊換成這一個字」，一拉滑桿探索鏈就斷了。）
         注意：點大字會順便換掉格區，所以基準筆畫要在**疊完卡之後**才取。 */
      var b1 = document.querySelector("#detail .card:last-child .big");
      if (b1) b1.click();
      var m1 = document.querySelectorAll("#detail .card:last-child .secParts .mini");
      if (m1.length) m1[m1.length - 1].click();
      out.push("wCardsBefore=" + document.querySelectorAll("#detail .card").length);
      var sel = document.querySelector("#rows .cell svg path");
      var before = sel ? sel.getAttribute("d") : "";
      w.value = "180";
      w.dispatchEvent(new Event("input"));
      out.push("wCardsAfter=" + document.querySelectorAll("#detail .card").length);
      var after = document.querySelector("#rows .cell svg path");
      out.push("wChanged=" + (!!after && after.getAttribute("d") !== before));
      out.push("wLabel=" + document.getElementById("wscaleV").textContent);
      /* 還原，免得影響後面的斷言 */
      w.value = "100";
      w.dispatchEvent(new Event("input"));
      var back = document.querySelector("#rows .cell svg path");
      out.push("wRestored=" + (!!back && back.getAttribute("d") === before));
    },
    /* --- 區塊配色：不同區塊不同顏色；詳細大字與下方部件各用自己區塊的顏色 --- */
    function () {
      var blks = document.querySelectorAll("#blocks .blk");
      var bc = [], j;
      /* 讀 --bc 而不是 color：被選取的列（.on）文字會變成深色，
         color 就不是區塊色了，只有 --bc 恆定。 */
      for (j = 0; j < blks.length; j++) bc.push(getComputedStyle(blks[j]).getPropertyValue("--bc").trim());
      var uniq = {};
      for (j = 0; j < bc.length; j++) uniq[bc[j]] = 1;
      out.push("blockColors=" + Object.keys(uniq).length);
      out.push("cBmp=" + encodeURIComponent(bc[0]));
      out.push("cB=" + encodeURIComponent(bc[2]));
      /* 現在是 BMP + B，第一格是 BMP 的字 */
      out.push("cellBmp=" + encodeURIComponent(getComputedStyle(document.querySelector("#rows .cell")).color));
      /* ★ 師父 2026-10-16：碼位**左下角**的小標（所屬區）✓——
         **基本區（BMP）不標** ✓（師父指定的例外 ✓）、Extension 標英文字母 ✓；
         而且是**粗體 Arial** ＋ 自己那一區的顏色 ✓（醒目 ✓）。 */
      out.push("bmpHasMark=" + (function () {
        var f = document.querySelector("#rows .cell");
        var mk = f && f.querySelector(".c .blkmark");
        return mk ? encodeURIComponent(mk.textContent) : "no";
      })());
      /* 關掉 BMP 只剩 B，第一格應該換成 B 的顏色 */
      document.querySelectorAll("#blocks .blk")[0].click();
      out.push("cellB=" + encodeURIComponent(getComputedStyle(document.querySelector("#rows .cell")).color));
      /* 只剩 Ext B → 格區裡**不只是** Ext B：未選取區塊的命中會排在後面（「.outside」✓），
         所以這裡驗的是「**每一格的小標都對得上它自己的碼位**」✓，不是「每一格都是 B」✗。
         另外把第一個有標的格子的**算出來的樣式**帶出來 ✓（字體／粗細／顏色／淡化 ✓）。 */
      (function () {
        var cells = document.querySelectorAll("#rows .cell"), pairs = [], first = null;
        for (var q = 0; q < cells.length; q++) {
          var mk = cells[q].querySelector(".c .blkmark");
          var cpN = Number(cells[q].getAttribute("data-cp"));
          pairs.push(cpN + ":" + (mk ? mk.textContent : "-"));
          if (!first && mk) first = { cell: cells[q], mk: mk };
        }
        out.push("cellMarks=" + encodeURIComponent(pairs.join(" ")));
        out.push("cellMarkN=" + cells.length);
        if (first) {
          var ms = getComputedStyle(first.mk);
          out.push("markText=" + encodeURIComponent(first.mk.textContent));
          out.push("markFam=" + encodeURIComponent(ms.fontFamily));
          out.push("markWeight=" + ms.fontWeight);
          out.push("markSize=" + ms.fontSize);
          out.push("markColor=" + encodeURIComponent(ms.color));
          out.push("markCellBc=" + encodeURIComponent(
            getComputedStyle(first.cell).getPropertyValue("--bc").trim()));
          /* 小標**不可以**跟著碼位一起被淡化（「opacity」在 .c 上會蓋住子樹 ✗） */
          out.push("markLineOpacity=" + getComputedStyle(first.cell.querySelector(".c")).opacity);
        }
      })();
      document.querySelectorAll("#blocks .blk")[0].click();
      /* 𩀨 是 Ext B，它的部件 隹／從 都在 BMP → 大字與部件的顏色必須不同 */
      var jb1 = document.getElementById("comp");
      jb1.value = "U+29028"; jb1.dispatchEvent(new Event("input"));
      jb1.value = ""; jb1.dispatchEvent(new Event("input"));
      var big = getComputedStyle(document.querySelector("#detail .card:last-child .big")).color;
      var p0 = document.querySelector("#detail .card:last-child .secParts .mini");
      out.push("bigColor=" + encodeURIComponent(big));
      out.push("partColor=" + encodeURIComponent(p0 ? getComputedStyle(p0).color : "none"));
      out.push("bigNePart=" + (!!p0 && big !== getComputedStyle(p0).color));
      /* 截（BMP）能構成的字橫跨 BMP／Ext A／Ext B → 應該混色 */
      var jb2 = document.getElementById("comp");
      jb2.value = "U+622A"; jb2.dispatchEvent(new Event("input"));
      jb2.value = ""; jb2.dispatchEvent(new Event("input"));
      var fm = [], fset = {};
      for (j = 0; j < fm.length; j++) fset[getComputedStyle(fm[j]).color] = 1;
      out.push("formColors=" + Object.keys(fset).length);
      out.push("formSample=" + encodeURIComponent(
        Array.prototype.map.call(fm, function (m) { return getComputedStyle(m).color; })
          .slice(0, 6).join("|")));
    },
    /* --- ★ 2026-10-16（師父）：「**BMP 要排在 Ext A 前面**」✓——
       單按碼位排會相反 ✗（Ext A 從 U+3400 起、BMP 從 U+4E00 起 ✓），
       所以列表要**照 BLOCKS 的順序**排 ✓（BMP → Ext A → Ext B → …）。 --- */
    function () {
      document.querySelectorAll("#blocks .blk")[1].click();      /* 打開 Ext A ✓ */
      var cs = document.querySelectorAll("#rows .cell"), head = [];
      for (var i = 0; i < cs.length && i < 24; i++) head.push(Number(cs[i].getAttribute("data-cp")));
      var seenOther = false, bmpAfter = 0;
      for (var j = 0; j < head.length; j++) {
        if (head[j] >= 0x4E00 && head[j] <= 0x9FFF) { if (seenOther) bmpAfter++; }
        else seenOther = true;
      }
      out.push("ordFirst=" + (head[0] || 0).toString(16).toUpperCase());
      out.push("ordBmpAfter=" + bmpAfter);
      out.push("ordHead=" + encodeURIComponent(
        head.slice(0, 8).map(function (c) { return c.toString(16).toUpperCase(); }).join(",")));
      document.querySelectorAll("#blocks .blk")[1].click();      /* 還原：關掉 Ext A ✓ */
    },
    /* --- 詳細面板的「由哪些部件構成」：只看，不能動到中間的格區 --- */
    function () {
      var jb3 = document.getElementById("comp");
      jb3.value = "U+908F"; jb3.dispatchEvent(new Event("input"));
      jb3.value = ""; jb3.dispatchEvent(new Event("input"));
      out.push("dListBefore=" + LIST.length);
      out.push("dScrollBefore=" + document.getElementById("grid").scrollTop);
      out.push("dGridSelBefore=" + GRID_SEL);
      var p = document.querySelector("#detail .card:last-child .secParts .mini");
      out.push("dPartCp=" + (p ? codePointOf(LIB, Number(p.getAttribute("data-idx"))).toString(16) : "none"));
      p.click();
      out.push("cardCount=" + document.querySelectorAll("#detail .card").length);
      out.push("dDetailAfter=" + encodeURIComponent(
        (document.querySelector("#detail .card:last-child .big .u") || {}).textContent || ""));
      out.push("dListAfter=" + LIST.length);
      out.push("dScrollAfter=" + document.getElementById("grid").scrollTop);
      out.push("dGridSelAfter=" + GRID_SEL);
      /* 點詳細大字 → 以它為部件搜尋：中間格區換成「能構成它的字」 */
      var bigEl = document.querySelector("#detail .card:last-child .big");
      out.push("fFilterBefore=" + (FILTER ? 1 : 0));
      out.push("fListBefore=" + LIST.length);
      if (bigEl) bigEl.click();
      out.push("fFilterAfter=" + (FILTER ? encodeURIComponent(FILTER.raw) : ""));
      out.push("fListAfter=" + LIST.length);
      out.push("fCompBox=" + encodeURIComponent(document.getElementById("comp").value));
      out.push("fNote=" + encodeURIComponent(document.getElementById("compNote").textContent));
      out.push("dFormDetail=" + encodeURIComponent(
        (document.querySelector("#detail .card:last-child .big .u") || {}).textContent || ""));
      var jb2 = document.getElementById("comp");
      jb2.value = "U+908F"; jb2.dispatchEvent(new Event("input"));
      jb2.value = ""; jb2.dispatchEvent(new Event("input"));
    },
    /* --- 按異體：找出使用那個異體的字 --- */
    function () {
      var jb = document.getElementById("comp");
      /* 挑一個去重後仍有 >1 個異體的字：一 U+4E00（4 個） */
      jb.value = "U+4E00"; jb.dispatchEvent(new Event("input"));
      var minis = document.querySelectorAll("#detail .card:last-child .secVar .mini");
      out.push("varCount=" + minis.length);
      var before = LIST.length;
      if (minis.length > 1) minis[1].click();
      out.push("vBefore=" + before);
      out.push("vAfter=" + LIST.length);
      out.push("vNote=" + encodeURIComponent(document.getElementById("compNote").textContent));
      out.push("vIsVariant=" + (FILTER && FILTER.variant !== undefined));
      jb.value = ""; jb.dispatchEvent(new Event("input"));
    },
    /* --- 異體只有一個時不顯示 --- */
    function () {
      var jb = document.getElementById("comp");
      jb.value = "U+4E23"; jb.dispatchEvent(new Event("input"));   /* 丣：去重後剩 1 個 */
      out.push("maoVarShown=" + (!!document.querySelector("#detail .card:last-child .secVar")));
      jb.value = "U+4E00"; jb.dispatchEvent(new Event("input"));   /* 一：4 個，要顯示 */
      out.push("yiVarShown=" + (!!document.querySelector("#detail .card:last-child .secVar")));
      out.push("yiVarCount=" + document.querySelectorAll("#detail .card:last-child .secVar .mini").length);
      /* 邏 U+908F 家族 3 個，但其中 2 個是別名／同資料 → 去重後剩 1 個，不該顯示 */
      jb.value = "U+908F"; jb.dispatchEvent(new Event("input"));
      out.push("luoVarShown=" + (!!document.querySelector("#detail .card:last-child .secVar")));
      jb.value = ""; jb.dispatchEvent(new Event("input"));
    },
    /* --- 搜尋結果前面要有「輸入的部件本身」並標記 --- */
    function () {
      var jb = document.getElementById("comp");
      jb.value = "\u53E3\u6728"; jb.dispatchEvent(new Event("input"));
      var parts = document.querySelectorAll("#rows .cell.part");
      out.push("partCells=" + parts.length);
      var txt = [];
      for (var i = 0; i < parts.length; i++) txt.push(parts[i].getAttribute("data-cp"));
      out.push("partCps=" + txt.join(","));
      out.push("listHead=" + LIST.slice(0, 3).join(","));
      out.push("hasMarks=" + (!!MARKS));
      jb.value = ""; jb.dispatchEvent(new Event("input"));
    },
    /* --- 大小每級 2 --- */
    function () {
      out.push("cellStep=" + document.getElementById("cellN").getAttribute("step"));
    },
    /* --- 丣 U+4E23：點大字做部件搜尋，結果不該有重複碼位 --- */
    function () {
      var jb = document.getElementById("comp");
      jb.value = "U+4E23"; jb.dispatchEvent(new Event("input"));
      var bigMao = document.querySelector("#detail .card:last-child .big");
      if (bigMao) bigMao.click();
      var cps = [], dup = 0;
      for (var i = 0; i < LIST.length; i++) {
        if (cps.indexOf(LIST[i]) >= 0) dup++;
        cps.push(LIST[i]);
      }
      out.push("maoForms=" + LIST.length);
      out.push("maoDup=" + dup);
      out.push("maoTitle=" + encodeURIComponent(document.getElementById("compNote").textContent));
      out.push("has687A=" + (cps.indexOf(0x687A) >= 0));
      jb.value = ""; jb.dispatchEvent(new Event("input"));
    },
    /* --- 異體去重：丣 家族兩個成員渲染相同，應該只顯示一個 --- */
    function () {
      var jb = document.getElementById("comp");
      jb.value = "U+4E23"; jb.dispatchEvent(new Event("input"));
      var varTitle = document.querySelector("#detail .card:last-child .secVar b");
      out.push("varTitle=" + encodeURIComponent(varTitle ? varTitle.textContent : ""));
      out.push("varMinis=" + document.querySelectorAll("#detail .card:last-child .secVar .mini").length);
      jb.value = ""; jb.dispatchEvent(new Event("input"));
    },
    function () { report(out.join(" ")); }
  ];
  var qi = 0;
  function start() {
    var tick = setInterval(function () {
      if (qi >= q.length) { clearInterval(tick); return; }
      try { q[qi++](); } catch (e) { out.push("STEP" + qi + "EXC:" + e.message); }
    }, 300);
  }
  /* 等待用**單層 setInterval**：多層巢狀 setTimeout 在 headless 下會被截斷
     （check-codemirror.ts 已經踩過並註記在同一個地方）。
     另外：探針是寫在樣板字串裡的，**註解裡不能出現反引號**，
     否則會提前結束樣板字串、產生器自己就語法錯誤。 */
  var tries = 200;
  var boot = setInterval(function () {
    if (window.__READY__ || --tries <= 0) { clearInterval(boot); start(); }
  }, 100);
})();
<\/script>`;
  const diagPath = resolve(D, "out/_browser-probe.html");
  const shotPath = resolve(D, "out/glyph-browser-shot.png");
  /* 步驟數直接從探針數出來，免得改了步驟卻忘了改訊息 */
  const STEP_COUNT = (probe.match(/^    function \(\) \{/gm) || []).length;
  writeFileSync(diagPath, html.replace("</body>", probe + "</body>"));

  const proc = Bun.spawnSync([
    EDGE, "--headless=new", "--disable-gpu", "--virtual-time-budget=90000",
    "--window-size=1340,900", "--screenshot=" + shotPath,
    "--dump-dom", "file:///" + diagPath.replace(/\\/g, "/"),
  ], { stdout: "pipe", stderr: "ignore" });
  const dom = new TextDecoder().decode(proc.stdout);
  const m = /<title>PROBE\|([^<]*)<\/title>/.exec(dom);
  if (!m) bad("瀏覽器沒有回報結果（title 找不到 PROBE）");
  else {
    const r = m[1]!;
    console.log("  瀏覽器回報：" + r);
    const num = (k: string) => Number(new RegExp("(?:^| )" + k + "=(-?[\\d.]+)").exec(r)?.[1] ?? "NaN");
    const txt = (k: string) => {
      const mm = new RegExp("(?:^| )" + k + "=([^ ]*)").exec(r);
      if (!mm) return "";
      /* 有空白欄位用 encodeURIComponent 包過；像 "180%" 這種含孤立 % 的
         直接解會丟 URIError，所以解不開就用原字串。 */
      try { return decodeURIComponent(mm[1]!); } catch { return mm[1]!; }
    };
    /STEP\d+EXC/.test(r) ? bad("有步驟丟例外：" + (/STEP\d+EXC:[^ ]*/.exec(r) || [""])[0])
                         : ok(`${STEP_COUNT} 個步驟都沒有丟例外`);

    num("loadError") === 0
      ? ok("頁面初始化沒有失敗（body 沒有「載入失敗」）")
      : bad(`頁面初始化失敗，body 開頭是：${txt("bodyHead")}`);
    num("glyphs") === 191727 ? ok(`字庫在瀏覽器裡解碼成功（${num("glyphs").toLocaleString()} 字形）`)
                             : bad(`字形數 ${num("glyphs")}`);
    num("comps") > 50000 ? ok(`部件索引建好：${num("comps").toLocaleString()} 個部件（${num("indexMs")} ms）`)
                         : bad(`部件索引只有 ${num("comps")} 個`);
    num("decodeMs") < 3000 ? ok(`解碼 ${num("decodeMs")} ms（開頁成本可接受）`) : bad(`解碼 ${num("decodeMs")} ms 太慢`);

    // 需求 1
    txt("hasH1") === "false" ? ok("頁面不再顯示標題（只留在瀏覽視窗 title）") : bad("頁面還留著 h1");
    /^Unicode漢字集/.test(txt("docTitle")) ? ok(`瀏覽視窗 title：${txt("docTitle")}…`)
                                           : bad(`title 不對：${txt("docTitle")}`);
    num("blocks") === 12 ? ok("左欄列出 12 個 CJK 區塊") : bad(`區塊數 ${num("blocks")}`);
    txt("labels") === "BMP/A/B/C/D/E/F/G/H/I/相容/相容補"
      ? ok(`區塊標籤精簡：${txt("labels")}`)
      : bad(`區塊標籤不對：${txt("labels")}`);
    txt("tips") === "true" ? ok("標籤的 tooltip 帶著全名（省空間但不丟資訊）")
                           : bad("標籤沒有全名 tooltip");
    num("cells") > 20 ? ok(`格區描繪了 ${num("cells")} 格（只畫可見的）`) : bad(`只描繪了 ${num("cells")} 格`);
    txt("hasLabel") === "true" ? ok("每一格都標了 Unicode 碼位") : bad("格子沒有碼位標籤");
    txt("hasSvg") === "true" ? ok("格子裡是 KAGE 字形（不是系統字型）") : bad("格子裡沒有 KAGE SVG");
    /全部 20,992 字/.test(txt("count")) ? ok(`狀態列：${txt("count")}`) : bad(`狀態列不對：${txt("count")}`);
    /908F/.test(txt("selCp")) ? ok(`跳到 U+908F 成功（選到 U+${txt("selCp")}）`) : bad(`跳碼位失敗：${txt("selCp")}`);
    txt("detailHas") === "true" ? ok("詳細面板跟著換") : bad("詳細面板沒換");

    // 區塊複選（toggle）
    txt("sel0") === "0" ? ok("預設選取 BMP") : bad(`預設選取 ${txt("sel0")}`);
    txt("sel1") === "0,2" ? ok("按 B 是**加上去**（toggle 複選），不是取代：0,2")
                          : bad(`複選結果 ${txt("sel1")}`);
    /63,712/.test(txt("blkCount"))
      ? ok(`兩區合計：${txt("blkCount")}`) : bad(`兩區合計不對：${txt("blkCount")}`);
    txt("sel2") === "2" ? ok("再按 BMP 可以把它關掉，只剩 B") : bad(`關掉 BMP 後是 ${txt("sel2")}`);
    /42,720/.test(txt("blkCount2"))
      ? ok(`只剩 B：${txt("blkCount2")}`) : bad(`只剩 B 時是 ${txt("blkCount2")}`);

    // 需求 2（即時搜尋 ＋ 區塊約束）
    num("filterAll") > 10 ? ok(`部件搜尋「隹」：${num("filterAll")} 個字（${txt("filterNote")}）`)
                          : bad(`部件搜尋只得到 ${num("filterAll")} 個`);
    num("filterOut") > 0 && num("filterFlips") === 1 && num("filterFirstOut") === num("filterInB")
      ? ok(`未選取的區塊不再濾掉，改成排在後面（B ${num("filterInB")} 個在前、` +
           `其他 ${num("filterOut")} 個在後，只換手一次）`)
      : bad(`放寬後的排序不對：B ${num("filterInB")}、外 ${num("filterOut")}、` +
            `換手 ${num("filterFlips")}、第一個外部命中在第 ${num("filterFirstOut")} 位`);
    num("filterOutsideCells") > 0
      ? ok(`排在後面的格子有 outside 標記（畫得較暗，目前可見 ${num("filterOutsideCells")} 格）`)
      : bad("沒有 outside 標記");
    /篩選「隹」/.test(txt("filterCount")) ? ok(`狀態列反映篩選：${txt("filterCount")}`) : bad(`篩選狀態列不對：${txt("filterCount")}`);
    num("filterCells") > 0 ? ok(`篩選結果有描繪（${num("filterCells")} 格）`) : bad("篩選結果沒有描繪");
    num("filterWide") === num("filterAll") && txt("filterHasBmp") === "true"
      ? ok(`結果總數不受區塊選取影響（都是 ${num("filterAll")} 個）——區塊只決定排序`)
      : bad(`總數變了：${num("filterAll")} → ${num("filterWide")}`);
    num("filterBmpPos") >= 0 && num("filterBmpPos") < num("filterBmpCount")
      ? ok(`打開 BMP 後，BMP 命中進到前半段（第 ${num("filterBmpPos")} 位起、共 ${num("filterBmpCount")} 個）`)
      : bad(`BMP 命中沒有進到前面：pos=${num("filterBmpPos")} count=${num("filterBmpCount")}`);
    // 需求 2c：位置運算子
    /木」在左/.test(txt("posLeftNote")) ? ok(`木+ ＝ 木在左：${num("posLeft")} 個（${txt("posLeftNote")}）`)
                                        : bad(`木+ 的說明不對：${txt("posLeftNote")}`);
    num("posRight") > 0 && num("posRight") < num("posLeft")
      ? ok(`+木 ＝ 木在右：${num("posRight")} 個（少於在左的 ${num("posLeft")}）`)
      : bad(`+木 異常：${num("posRight")}／木+ ${num("posLeft")}`);
    txt("hasXiu") === "true"
      ? ok("休（亻+木）被 +木 找到——這是門檻從 2/3 放寬到 0.6 才修好的")
      : bad("休 沒被 +木 找到（方位門檻又太緊了）");
    num("posNone") > num("posLeft") ? ok(`不加運算子＝直接部件：${num("posNone")} 個`)
                                    : bad(`不加運算子 ${num("posNone")} ≤ 木+ ${num("posLeft")}`);

    // 需求 2d：多部件（深層）與重複部件
    num("multi") > 0 && txt("hasDai") === "true"
      ? ok(`口木：${num("multi")} 個，含呆`) : bad(`口木 找不到呆（${num("multi")} 個）`);
    num("dup") > 0 && txt("hasQi") === "true" && txt("hasKu") === "true"
      ? ok(`口口：${num("dup")} 個，含器與哭（口藏在「吅」裡，只有深層找得到）`)
      : bad(`口口 找不到器／哭（${num("dup")} 個）`);
    txt("noDai2") === "true" ? ok("口口 不含呆（呆只有一個口，重複次數有在算）")
                             : bad("口口 把只有一個口的呆也收進來了");

    // 介面調整（師父指示）
    txt("noJumpBox") === "true" ? ok("「跳到碼位」已移除") : bad("還留著跳到碼位");
    /跳到 U\+908F/.test(txt("jumpNote")) ? ok(`部件搜尋框輸入碼位就跳過去（${txt("jumpNote")}）`)
                                          : bad(`碼位輸入沒有跳：${txt("jumpNote")}`);
    txt("chipText") === "B" ? ok("Unicode 區塊是一組 toggle button（只印短標籤）")
                            : bad(`區塊 chip 文字：${txt("chipText")}`);
    txt("tipCount") === "true" ? ok("區塊字數放在 mouse hover hint") : bad("tooltip 沒有字數");
    txt("helpHidden") === "true" ? ok("運算式說明預設隱藏（details 收合）") : bad("運算式說明沒有收起來");

    // 點詳細大字 → 以它為部件搜尋
    num("fFilterBefore") === 0 && txt("fFilterAfter").length > 0
      ? ok(`點大字 → 以它為部件搜尋（篩選「${txt("fFilterAfter")}」，${num("fListBefore")} → ${num("fListAfter")} 字）`)
      : bad(`點大字沒有觸發部件搜尋：filter=${txt("fFilterAfter")} ${num("fListBefore")}→${num("fListAfter")}`);
    txt("fCompBox") === txt("fFilterAfter")
      ? ok(`搜尋框同步填入「${txt("fCompBox")}」`) : bad(`搜尋框是 ${txt("fCompBox")}`);
    /個字/.test(txt("fNote")) ? ok(`提示顯示結果數：${txt("fNote")}`) : bad(`提示不對：${txt("fNote")}`);

    // 丣 的重複
    num("maoDup") === 0 ? ok(`點丣 的大字 → 部件搜尋，${num("maoForms")} 個字且沒有重複碼位（${txt("maoTitle")}）`)
                        : bad(`丣 的搜尋結果有 ${num("maoDup")} 個重複`);
    txt("has687A") === "true" ? ok("清單裡有桺 U+687A（丣 的其中一個構成字）") : bad("清單裡沒有 U+687A");
    txt("varTitle") === ""
      ? ok("丣 的異體去重成 1 個，整段不顯示（原本 2 個畫出來一樣）")
      : bad(`丣 還是顯示異體：${txt("varTitle")}`);

    // 介面：按異體查字／單一異體不顯示／部件前置／大小級距
    txt("maoVarShown") === "false" ? ok("異體只有 1 個時整段不顯示（丣）") : bad("丣 還是顯示異體區");
    txt("yiVarShown") === "true" ? ok(`異體超過 1 個才顯示（一，${num("yiVarCount")} 個）`)
                                 : bad("一 沒顯示異體區");
    txt("luoVarShown") === "false"
      ? ok("邏 家族 3 個但其中 2 個是別名／同資料 → 去重後不顯示")
      : bad("邏 去重後只有 1 個卻還顯示異體區");
    num("varCount") > 1 && txt("vIsVariant") === "true"
      ? ok(`按異體改成查「使用它的字」：${num("vBefore")} → ${num("vAfter")} 個（${txt("vNote")}）`)
      : bad(`按異體沒有觸發查詢：varCount=${num("varCount")} variant=${txt("vIsVariant")}`);
    num("vAfter") > 0 && num("vAfter") !== num("vBefore")
      ? ok("異體查詢的結果跟原本清單不同") : bad(`異體查詢結果沒變（${num("vAfter")}）`);
    num("partCells") === 2 && txt("partCps") === "21475,26408"
      ? ok(`搜尋結果前面有輸入的部件本身（口、木），並標了記號`)
      : bad(`部件前置不對：${num("partCells")} 格、${txt("partCps")}`);
    txt("cellStep") === "2" ? ok("「大小」每級調整 2") : bad(`大小 step=${txt("cellStep")}`);

    // 需求 2f：IDS 補上的部件關係（杏、林 這種「被拆成原始筆劃」的字）
    txt("hasXing") === "true"
      ? ok("口木 找得到杏（GlyphWiki 沒給它「木」的 ref，是 IDS 補上的）")
      : bad("口木 找不到杏——IDS 索引沒接上");
    txt("muHasXing") === "true"
      ? ok(`單一部件「木」也找得到杏（${num("muAll")} 個）`) : bad("「木」找不到杏");
    txt("muHasLin") === "true"
      ? ok("單一部件「木」找得到林（林在 KAGE 裡是 0 個 ref，只有 IDS 有）")
      : bad("「木」找不到林");
    txt("muMuHasLin") === "true"
      ? ok(`木木 找得到林（${num("muMu")} 個，重複部件算得出來）`) : bad("木木 找不到林");

    // 需求 2e：數字＝剩餘筆劃；純數字＝獨體字
    num("remain") > 0 && txt("has2320C") === "true"
      ? ok(`4木日：${num("remain")} 個，含 U+2320C（${txt("remainNote")}）`)
      : bad(`4木日 找不到 U+2320C（${num("remain")} 個）`);
    num("noDigit") > num("remain")
      ? ok(`不寫數字就只比部件：${num("noDigit")} ≥ ${num("remain")}`)
      : bad(`不寫數字 ${num("noDigit")} < 有數字 ${num("remain")}`);
    num("solo") > 0 && txt("soloAll4") === "true"
      ? ok(`純數字 4：${num("solo")} 個獨體字，每個都真的是 4 畫且無部件引用`)
      : bad(`純數字 4 的結果不對（${num("solo")} 個，全部合格=${txt("soloAll4")}）`);

    // 搜尋也受區塊約束
    num("blkScopeAfter") === num("blkScopeBefore") && num("blkScopeBack") === num("blkScopeBefore")
      ? ok(`切換區塊不會改變結果數（${num("blkScopeBefore")} 個不變），只改排序`)
      : bad(`切換區塊影響了結果數：${num("blkScopeBefore")} / ${num("blkScopeAfter")} / ${num("blkScopeBack")}`);
    num("blkWasOut") > 0
      ? ok(`關掉 BMP 前有 ${num("blkWasOut")} 個命中是「未選取區塊、排在後面」的`)
      : bad("沒有觀察到排在後面的命中");

    // 需求 3
    txt("hasVariants") === "true" ? ok("詳細面板有「異體」") : bad("詳細面板沒有異體");
    num("cardCount") > 0 ? ok(`詳細區是卡片堆疊（目前 ${num("cardCount")} 張）`) : bad("沒有卡片");
    txt("hasParts") === "true" ? ok("詳細面板有「由哪些部件構成」") : bad("詳細面板沒有部件構成");
    txt("hasForms") === "false" ? ok("詳細卡已移除「能構成的字」") : bad("詳細卡還留著「能構成的字」");
    txt("bigClickable") === "pointer" ? ok("詳細大字可以點（cursor:pointer）") : bad(`大字不是可點：${txt("bigClickable")}`);
    /為部件搜尋/.test(txt("bigTitle")) ? ok(`大字有提示：${txt("bigTitle")}`) : bad(`大字沒有提示：${txt("bigTitle")}`);
    txt("hasActions") === "true" ? ok("詳細面板有動作按鈕") : bad("詳細面板沒有動作按鈕");
    num("miniCount") > 2 ? ok(`詳細面板共 ${num("miniCount")} 個縮圖格`) : bad(`詳細面板只有 ${num("miniCount")} 個縮圖`);

    // 深層 ＋ 清除
    num("cleared") === 63712 && num("clearedBlks") === 2
      ? ok(`刪光輸入框就還原成選取區塊（BMP + B）的全部字，${num("cleared").toLocaleString()} 字`)
      : bad(`還原後是 ${num("cleared")} 字、亮著的區塊 ${num("clearedBlks")} 個`);
    txt("clearedNote") === "" ? ok("還原時提示文字也清掉") : bad(`提示沒清：${txt("clearedNote")}`);

    // 拿掉搜尋／清除按鈕 ＋ 「每格」改「大小」、不顯示 px
    txt("noButtons") === "true" ? ok("沒有「搜尋」「清除」按鈕（輸入即搜尋、刪掉即還原）")
                                : bad("還留著搜尋／清除按鈕");
    /* input 的 value 不在 textContent 裡，所以這裡只看得到標籤文字 */
    txt("sizeLabel") === "設置大小筆劃100%描邊"
      ? ok(`工具列只留一顆「設置」按鈕（展開後：${txt("sizeLabel")}）`)
      : bad(`工具列標籤不對：${txt("sizeLabel")}`);
    txt("setBodyHidden") === "true" ? ok("設置下拉預設收合") : bad("設置下拉預設是開的");
    txt("setOpen") === "true" && txt("setClosed") === "true"
      ? ok("點「設置」可以開合") : bad(`設置開合壞了：open=${txt("setOpen")} closed=${txt("setClosed")}`);
    txt("inMenu") === "true"
      ? ok("大小／筆劃粗細／描邊三個控制項都在同一個下拉裡")
      : bad("有控制項不在下拉裡");

    // 筆劃粗細（KAGE 內建能力）
    txt("hasW") === "true" ? ok("有筆劃粗細控制") : bad("沒有筆劃粗細控制");
    txt("wDefault") === "100" ? ok("預設 100%（引擎預設筆寬）") : bad(`預設值 ${txt("wDefault")}`);
    txt("wChanged") === "true" ? ok(`拉到 180% 後描繪結果真的變了（標籤 ${txt("wLabel")}）`)
                               : bad("拉動筆劃粗細後描繪結果沒變");
    txt("wRestored") === "true" ? ok("拉回 100% 後回復原本的描繪") : bad("拉回 100% 沒有回復");
    num("wCardsBefore") > 1 && num("wCardsAfter") === num("wCardsBefore")
      ? ok(`調整筆劃粗細不會收掉卡片堆疊（${num("wCardsBefore")} 張不變）`)
      : bad(`拉筆劃粗細把卡片堆疊弄掉了：${num("wCardsBefore")} → ${num("wCardsAfter")}`);

    // 區塊配色（HSV，每區轉 30°）
    num("blockColors") === 12 ? ok("12 個區塊 12 種顏色（sidebar 就是色票表）")
                              : bad(`只有 ${num("blockColors")} 種區塊顏色`);
    /* getComputedStyle().color 會是 "rgb(255, 115, 115)"（有空白），
       而 --bc 是原字串 "rgb(255,115,115)"（沒有）→ 比對前先去空白 */
    const nospace = (s: string) => s.replace(/\s+/g, "");
    txt("cBmp") !== txt("cB") ? ok(`BMP ${txt("cBmp")} ≠ B ${txt("cB")}`) : bad("BMP 與 B 同色");
    nospace(txt("cellBmp")) === nospace(txt("cBmp"))
      ? ok("格子的字形用的是自己區塊的顏色")
      : bad(`格子色 ${txt("cellBmp")} ≠ 區塊色 ${txt("cBmp")}`);
    nospace(txt("cellB")) === nospace(txt("cB"))
      ? ok("換區塊後格子顏色也跟著換") : bad(`換區塊後是 ${txt("cellB")}，應為 ${txt("cB")}`);
    /* ★ 師父 2026-10-16：碼位**左下角**標所屬區 ✓——
       **基本區 2 萬字不標** ✓（師父指定的例外 ✓）、Extension 標**英文字母** ✓、
       小標是**粗體 Arial** ＋ **那一區的顏色** ✓，而且**不跟著碼位被淡化** ✓。 */
    txt("bmpHasMark") === "no"
      ? ok("基本區（BMP）的格子左下角**不標**區名（師父指定的例外 ✓）")
      : bad(`BMP 的格子標了「${txt("bmpHasMark")}」（應該不標 ✗）`);
    {
      /* 期望值在驗收裡**自己寫一份**（不是讀頁面的 `BLOCKS` ✓），才驗得出頁面真的照規則標 ✓ */
      const MARK_OF_BLOCK = ["", "A", "B", "C", "D", "E", "F", "G", "H", "I", "相", "補"];
      const RANGES: [number, number][] = [
        [0x4E00, 0x9FFF], [0x3400, 0x4DBF], [0x20000, 0x2A6DF], [0x2A700, 0x2B73F],
        [0x2B740, 0x2B81F], [0x2B820, 0x2CEAF], [0x2CEB0, 0x2EBEF], [0x30000, 0x3134F],
        [0x31350, 0x323AF], [0x2EBF0, 0x2EE5F], [0xF900, 0xFAFF], [0x2F800, 0x2FA1F],
      ];
      const wantMark = (cp: number): string => {
        const bi = RANGES.findIndex(([a, b]) => cp >= a && cp <= b);
        return bi < 0 ? "" : MARK_OF_BLOCK[bi]!;
      };
      const pairs = txt("cellMarks").split(" ").filter((s) => s.includes(":"));
      const wrong = pairs.filter((p) => {
        const [cp, got] = p.split(":");
        return (got === "-" ? "" : got) !== wantMark(Number(cp));
      });
      const hasB = pairs.some((p) => p.endsWith(":B"));
      pairs.length >= 10 && wrong.length === 0 && hasB
        ? ok(`格區 ${pairs.length} 格的小標都對得上自己的碼位（含 Ext B 的「B」✓；` +
             `未選取區塊的命中標的是**它自己的**區 ✓）`)
        : bad(`左下角小標不對：${wrong.slice(0, 5).join("／") || `只抽到 ${pairs.length} 格`}`);
    }
    /Arial/i.test(txt("markFam")) && Number(txt("markWeight")) >= 700
      ? ok(`小標是粗體 Arial（${txt("markFam")}／${txt("markWeight")}／${txt("markSize")}）——醒目 ✓`)
      : bad(`小標字體不對：${txt("markFam")}／weight ${txt("markWeight")}`);
    nospace(txt("markColor")) === nospace(txt("markCellBc"))
      ? ok(`小標的顏色＝那一區的顏色（${txt("markColor")}）✓`)
      : bad(`小標色 ${txt("markColor")} ≠ 區塊色 ${txt("markCellBc")}`);
    txt("markLineOpacity") === "1"
      ? ok("小標沒有跟著碼位被淡化（淡化搬到內層的 .cp 了 ✓）")
      : bad(`碼位那一行的 opacity 是 ${txt("markLineOpacity")}，小標會跟著淡化 ✗`);
    txt("bigNePart") === "true"
      ? ok(`詳細大字（${txt("bigColor")}）與下方部件（${txt("partColor")}）不同色＝看得出跨區塊`)
      : bad(`大字與部件同色：${txt("bigColor")}／${txt("partColor")}`);
    /* ★ 2026-10-16（師父）：「**BMP 要排在 Ext A 前面**」✓——
       單按碼位排會相反 ✗（Ext A 從 U+3400 起、BMP 從 U+4E00 起 ✓）；
       這裡同時選了 BMP 與 Ext A（兩個區都在選取內 ✓），第一格必須是 BMP ✓。
       ⚠ 「BMP 出現在非 BMP 之後」的次數必須是 0 ✓——萬一哪天又改回按碼位排 ✗，這條會抓到 ✓。 */
    (() => {
      const first = parseInt(txt("ordFirst"), 16);
      first >= 0x4e00 && first <= 0x9fff && num("ordBmpAfter") === 0
        ? ok(`BMP 排在 Ext A 前面（第一格 U+${txt("ordFirst")} ✓，` +
             `前幾格 ${txt("ordHead")} ✓，BMP 晚於別區的次數 0 ✓）`)
        : bad(`排序不對：第一格 U+${txt("ordFirst")}、BMP 晚於別區 ${num("ordBmpAfter")} 次`);
    })();

    // 詳細面板的「由哪些部件構成」不能動到中間的格區
    txt("dDetailAfter").toUpperCase() === ("U+" + txt("dPartCp")).toUpperCase()
      ? ok(`點部件後詳細面板換成 U+${txt("dPartCp")}（邏的第一個部件是辶，不是隹）`)
      : bad(`詳細面板沒換：${txt("dDetailAfter")}，應為 U+${txt("dPartCp")}`);
    num("dListAfter") === num("dListBefore")
      ? ok(`點部件不會改動格區的清單（${num("dListBefore")} → ${num("dListAfter")}）`)
      : bad(`格區清單被改動：${num("dListBefore")} → ${num("dListAfter")}`);
    num("dScrollAfter") === num("dScrollBefore")
      ? ok(`點部件不會捲動格區（scrollTop ${num("dScrollBefore")}）`)
      : bad(`格區被捲動：${num("dScrollBefore")} → ${num("dScrollAfter")}`);
    num("dGridSelAfter") === num("dGridSelBefore")
      ? ok(`點部件不會改掉格區的選取（GRID_SEL ${num("dGridSelBefore")}）`)
      : bad(`格區選取被改：${num("dGridSelBefore")} → ${num("dGridSelAfter")}`);
    /U\+/.test(txt("dFormDetail"))
      ? ok(`點大字後詳細卡仍在（${txt("dFormDetail")}）——搜尋不會動到卡片堆疊`)
      : bad(`詳細卡不見了：${txt("dFormDetail")}`);

    existsSync(shotPath) ? ok(`截圖已寫出 ${shotPath}（${(readFileSync(shotPath).length / 1024).toFixed(0)} KB）`)
                         : bad("沒有截圖");
  }
  try { unlinkSync(diagPath); } catch {}

  /* ---- 7) `?comp=` 入口：從剎那拼形帶部件過來（那一頁的「到字集瀏覽頁查 →」） ----
     這一頁原本只認輸入框打字，所以 pinxing 的按鈕會開到一張空白頁。 */
  const diag3 = resolve(D, "out/_browser-comp.html");
  const probe3 = `
<script>
(function () {
  var tries = 200;
  var boot = setInterval(function () {
    if (window.__READY__ || --tries <= 0) {
      clearInterval(boot);
      var r = window.__READY__ || {};
      document.title = "PROBE|comp=" + encodeURIComponent(r.compQuery || "") +
        " box=" + encodeURIComponent((document.getElementById("comp") || {}).value || "") +
        " list=" + (typeof LIST !== "undefined" ? LIST.length : -1) +
        " note=" + encodeURIComponent((document.getElementById("compNote") || {}).textContent || "");
    }
  }, 100);
})();
<\/script>`;
  writeFileSync(diag3, html.replace("</body>", probe3 + "</body>"));
  const proc3 = Bun.spawnSync([
    EDGE, "--headless=new", "--disable-gpu", "--virtual-time-budget=60000",
    "--dump-dom", "file:///" + diag3.replace(/\\/g, "/") + "?comp=%E8%BE%B6",
  ], { stdout: "pipe", stderr: "ignore" });
  const dom3 = new TextDecoder().decode(proc3.stdout);
  const m3 = /<title>PROBE\|([^<]*)<\/title>/.exec(dom3);
  if (!m3) bad("?comp= 入口沒有回報");
  else {
    const t3 = m3[1]!;
    const g = (k: string) => {
      const mm = new RegExp("(?:^| )" + k + "=([^ ]*)").exec(t3);
      if (!mm) return "";
      try { return decodeURIComponent(mm[1]!); } catch { return mm[1]!; }
    };
    g("comp") === "辶" && g("box") === "辶" && Number(g("list")) > 100 && /辶/.test(g("note"))
      ? ok(`?comp=辶 → 搜尋框填入「辶」、直接列出 ${Number(g("list")).toLocaleString()} 個字（${g("note")}）`)
      : bad(`?comp= 入口失效：comp=${g("comp")} box=${g("box")} list=${g("list")} note=${g("note")}`);
  }
  try { unlinkSync(diag3); } catch {}
}

console.log(fail === 0 ? "\n全部通過" : `\n有 ${fail} 項失敗`);
process.exit(fail === 0 ? 0 : 1);
