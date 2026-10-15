#!/usr/bin/env bun
/**
 * check-pinxing.ts — 驗收 `out/pinxing.html`（拼形檢視器）。
 *
 * 規格要求（`pinxing.md` §7）明寫「**模擬用戶的行為和動線**，把拼形過程跑順暢」，
 * 所以這一支不是只驗「程式碼沒問題」，而是照〈招財進寶〉那條動線
 * **逐步在真的瀏覽器裡點**，每一步都斷言。
 *
 * 形狀照抄 `tools/check-browser.ts`：headless Edge ＋ `--dump-dom` ＋ `<title>PROBE|…>` 回報。
 * 用法: bun run tools/check-pinxing.ts
 */
import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const D = "D:/2023/glyphwiki";
const PAGE = resolve(D, "out/pinxing.html");
let fail = 0;
const ok = (s: string) => console.log("  ✓ " + s);
const bad = (s: string) => { console.log("  ✗ " + s); fail++; };

// ---------------------------------------------------------------- 1. 產出物
console.log("1. 產出物");
if (!existsSync(PAGE)) { bad("找不到 out/pinxing.html（先跑 build-pinxing.ts）"); process.exit(1); }
const html = readFileSync(PAGE, "utf8");
ok(`out/pinxing.html 存在（${(Buffer.byteLength(html) / 1048576).toFixed(2)} MB）`);
/* **產出物要是「現在的」原始碼**：pinxing-page.js 比 out/pinxing.html 新就是沒重建。
   這一條擋的是「改了原始碼、建置卻失敗（或根本沒跑），驗收卻對著舊產物說全綠」——
   實際踩過：把建置的 stderr 用管線丟掉，建置錯誤沒看到，讀到的是上一次的舊檔。 */
{
  const pageTs = resolve(D, "tools/pinxing-page.js");
  const buildTs = resolve(D, "tools/build-pinxing.ts");
  const pageM = existsSync(pageTs) ? (await import("node:fs")).statSync(pageTs).mtimeMs : 0;
  const buildM = existsSync(buildTs) ? (await import("node:fs")).statSync(buildTs).mtimeMs : 0;
  const outM = (await import("node:fs")).statSync(PAGE).mtimeMs;
  const newestSrc = Math.max(pageM, buildM);
  outM >= newestSrc
    ? ok("產出物比原始碼新（沒有「改了卻忘了重建」）")
    : bad(`out/pinxing.html 比原始碼舊 ${Math.round((newestSrc - outM) / 1000)} 秒——先跑 build-pinxing.ts`);
  /* 頁面程式碼的關鍵片段要在產出物裡（建置若失敗，這裡會直接不匹配） */
  const marker = 'toComp = chars.length ? chars[chars.length - 1] : "";';
  html.includes(marker)
    ? ok("產出物含目前原始碼的片段（uploadLinks 用最後一個字當 comp）")
    : bad("產出物不含目前原始碼的片段——建置沒有真的生效");
}
const sm = /<script>([\s\S]*?)<\/script>/.exec(html);
if (!sm) { bad("找不到 script 區塊"); process.exit(1); }
const script = sm[1]!;

// ---------------------------------------------------------------- 2. 內嵌資料層
console.log("\n2. 內嵌程式碼：字庫 ＋ 拼形序列 ＋ 相容異體");
{
  const ENGINE_END = "/* ============ 解碼 + 量測";
  const MAIN_START = "/* ============================ 字庫與索引";
  const engEnd = script.indexOf(ENGINE_END);
  const mainStart = script.indexOf(MAIN_START);
  const engineSrc = engEnd > 0 ? script.slice(0, engEnd) : "";
  const head = mainStart > 0 ? script.slice(0, mainStart) : null;
  const b64m = /var LIB_B64 = "([^"]*)"/.exec(script);
  if (engEnd < 0) bad("找不到引擎分隔註解");
  else if (!head) bad("找不到主流程分隔註解");
  else if (!b64m) bad("找不到 LIB_B64");
  else {
    try {
      (0, eval)(engineSrc);
      const api = new Function(
        head + "\nreturn { decodeLibrary: decodeLibrary, indexOfCodePoint: indexOfCodePoint," +
        " codePointOf: codePointOf, isPlainIdeograph: isPlainIdeograph, displayName: displayName," +
        " componentKids: componentKids, hasComponents: hasComponents, familyMembers: familyMembers," +
        " evalSeq: evalSeq, codePointOf: codePointOf };",
      )();
      const lib = api.decodeLibrary(new Uint8Array(Bun.gunzipSync(Buffer.from(b64m[1]!, "base64"))));
      ok(`解碼成功：${lib.glyphs.length.toLocaleString()} 字形、${lib.families.length.toLocaleString()} 家族`);
      lib.glyphs.length === 191727 ? ok("字庫 v3（191,727 字形）") : bad(`字形數 ${lib.glyphs.length}`);

      /* 拼形序列：規格〈招財進寶〉那條動線上的每一個中間狀態都要解得開 */
      const steps: [string, boolean][] = [
        ["邏羅", false],        /* 只有基字與舊部件（還不是合法序列） */
        ["邏羅寶", true],
        ["邏羅寶貝", true],
        ["邏羅寶貝缶", true],
        ["寶缶支", true],
      ];
      for (const [seq, wantOk] of steps) {
        const r = api.evalSeq(lib, seq, {});
        r.ok === wantOk ? ok(`evalSeq("${seq}")＝${r.ok ? "組得出來" : "（中間狀態）"}`)
                        : bad(`evalSeq("${seq}") 應該${wantOk ? "成立" : "不成立"}：${r.ok ? "OK" : r.error}`);
      }

      /* 相容異體：這一條是頁面「點辶要查到兩千多個字」的根據。
         **注意要用 KAGE 引用**：`componentKids()` 會優先回 IDS（`進` 的 IDS 就是 辶），
         而頁面的部件序列畫的是 KAGE 引用——`進` 引用的是 `辶 U+FA66`（只有 4 個字用到）。 */
      const jin = api.indexOfCodePoint(lib, 0x9032)!;
      const g = lib.glyphs[jin]!;
      const refCps = g.strokes.filter((s) => s.kind === 99 && s.ref !== null)
        .map((s) => api.codePointOf(lib, s.ref!));
      const hasFa66 = refCps.indexOf(0xfa66) >= 0;
      hasFa66 ? ok("進 的 KAGE 引用是 辶 U+FA66（相容碼位）——所以要靠相容對照表才查得到辶")
              : bad("進 的引用不是 辶，相容對照表的假設要重驗（實際 " +
                    refCps.map((c) => "U+" + c.toString(16).toUpperCase()).join(",") + "）");
      /* 辶 的 IDS 是 ⻌ U+2ECC，⻌ 的標準寫法是 辶 U+8FB6（頁面的 compCharOf 就是這樣換的） */
      const fa66Ids = lib.comp?.get(0xfa66) || [];
      const has2ecc = fa66Ids.indexOf(0x2ecc) >= 0;
      has2ecc ? ok("辶 的 IDS 是 ⻌ U+2ECC → 頁面會顯示成使用者認得的「辶」")
              : bad("辶 的 IDS 不是 ⻌，顯示替換的假設要重驗（實際 " +
                    fa66Ids.map((c) => "U+" + c.toString(16).toUpperCase()).join(",") + "）");

      const count = (cp: number) => {
        let n = 0;
        for (let i = 0; i < lib.glyphs.length; i++) {
          if (!api.isPlainIdeograph(lib, i)) continue;
          const seen = new Set([i]), stack = [i];
          let hit = false;
          while (stack.length && !hit) {
            const j = stack.pop()!;
            for (const k of api.componentKids(lib, j)) {
              if (seen.has(k)) continue;
              seen.add(k);
              if (api.codePointOf(lib, k) === cp) { hit = true; break; }
              stack.push(k);
            }
          }
          if (hit) n++;
        }
        return n;
      };
      if (process.env.PINXING_SLOW === "1") {
        const nChuo = count(0x8fb6), nPai = count(0xfa66);
        nChuo > 1000 && nPai < 50
          ? ok(`含辶 ${nChuo} 個字、含辶 ${nPai} 個字（差了兩個數量級，必須綁在一起）`)
          : bad(`辶 ${nChuo}／辶 ${nPai} 的數量與假設不符`);
      }
    } catch (e) {
      bad("解碼或資料層失敗：" + (e as Error).message);
    }
  }
}

// ---------------------------------------------------------------- 3. 語法與離線
console.log("\n3. 語法與離線");
try { new Function(script); ok("script 區塊語法正確"); }
catch (e) { bad("語法錯誤：" + (e as Error).message); }
/* 離線的判準是「不會去網路上拿東西」：`xmlns` 只是命名空間字串、
   `INLINE_CSS` 是共用層帶進來的字串常數（見 check-browser.ts 的同類註解）。
   ★ 第 127 輪：庫存合文的按鈕用**內嵌的 base64 圖**（`src="data:image/png;base64,…"` ✓）——
     那是**自己帶的**、不是外部資源 ✓（`data:` 要放行 ✓，實測一開始被判成外部資源 ✗）。 */
!/<(?:script|link|img|iframe)\b[^>]*(?:src|href)=(?!["']?data:)/i.test(html)
  ? ok("沒有外部資源（file:// 直接開就會跑；內嵌的 data: 圖不算 ✓）") : bad("頁面引用了外部資源");
!/new\s+EditorView|@codemirror/.test(html) ? ok("輸入區是純文字（規格：不用 CodeMirror）")
                                          : bad("混入了 CodeMirror");
/拼形檢視器/.test(html) && /glyph-browser\.html/.test(html)
  ? ok("有與字集瀏覽頁的連動入口（glyph-browser.html）") : bad("找不到字集瀏覽頁的連動");
/baseglyph/.test(html) ? ok("有 ?baseglyph= 入口（從字集瀏覽頁帶基字進來）") : bad("沒有 baseglyph 入口");
const b64 = /var LIB_B64 = "([^"]*)"/.exec(script)![1]!;
/^[A-Za-z0-9+/]+={0,2}$/.test(b64) && b64.length % 4 === 0
  ? ok(`字庫 base64 合法（${(b64.length / 1048576).toFixed(2)} MB）`) : bad("base64 格式有問題");

/* ★ 2026-10-16（師父回報「微信內建瀏覽器打開無法載入庫存拼形、輸入也沒動作」）：
   ① 解壓**不可以只靠 `DecompressionStream`** ✗——微信內建瀏覽器（舊 X5／iOS 16.4 以前）
      **沒有它** ✓，沒有後備就是整頁打不開 ✗，所以頁面要自己帶一份**純 JS 的 DEFLATE** ✓。
   ② 最底部要留一行白話的指示 ✓（師父指定的字，一字不改 ✓）。
   ③ 開頁看門狗要真的是**獨立的一支 script** ✓——主 script 若語法就掛掉（舊引擎不認新語法 ✓），
      同一支裡面的 catch 根本不會執行 ✗，只有另一支跑得起來 ✓。 */
/function inflateGzip\(raw\)/.test(script) && /function gunzipBytes\(raw\)/.test(script)
  ? ok("頁面自帶純 JS 的 gzip 解壓（不靠 DecompressionStream；微信內建瀏覽器也解得開 ✓）")
  : bad("沒有純 JS 的解壓後備——微信內建瀏覽器會整頁解不開");
html.includes("微信打開看不到的話，用系統自帶的瀏覽器打開")
  ? ok("最底部有微信的指示行（師父指定的字 ✓）")
  : bad("底部沒有「微信打開看不到的話，用系統自帶的瀏覽器打開」");
(html.match(/<script>/g) || []).length >= 2 && /__BOOTOK__/.test(html)
  ? ok(`開頁看門狗是獨立的一支 script（頁面共 ${(html.match(/<script>/g) || []).length} 支；主 script 掛掉也跑得起來 ✓）`)
  : bad("沒有獨立的開頁看門狗");
/* ★ 大字裡的每一層都用**百分比**跟著 `.stage` ✓（寫死 200 會蓋掉窄螢幕的縮放 ✗，
   大字就溢出、壓到部件清單上 ✗——這正是師父回報的「重疊」✓）。 */
[".stage > svg", ".stage .boxlayer", ".stage .hllayer"].every((sel) =>
  new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
    " \\{ position:absolute; left:0; top:0; width:100%; height:100%").test(html))
  ? ok("大字的三層（字形／框／塗色）都用 100% 跟著 .stage（不會再寫死 200）")
  : bad("大字有某一層寫死了尺寸——窄螢幕會溢出壓到部件清單");
/calc\(var\(--chip\) \* 3 \+ 8px\)/.test(html)
  ? ok("部件清單的最小寬度＝三個方格（吃 --chip ✓；窄螢幕縮的是方格、不是大字 ✓）")
  : bad("部件清單的最小寬度不是以 --chip 算出來的");
/* ★ 2026-10-16（師父）：「合理拼形」→ 構形序 →「**拼形序**」✓（與項目 pinxing 統一 ✓）、
   「表意描述序（IDS）」→「**表意描述序**」✓。
   兩個新名字都要真的在產出物裡 ✓（標籤與提示是 JS 產生的，靜態檢查只擋「整支不見了」✗）。 */
/表意描述序/.test(script) && /拼形序/.test(script)
  ? ok(`新術語都在產出物裡（拼形序 ${(script.match(/拼形序/g) || []).length} 處、` +
       `表意描述序 ${(script.match(/表意描述序/g) || []).length} 處 ✓）`)
  : bad("產出物裡找不到「拼形序」／「表意描述序」——建置沒有跟上 ✗");
/* 舊說法只允許留在「師父說要改」的那幾句註解裡 ✓（UI 字串與其他註解都應該改乾淨 ✓）。
   ⚠ 三個舊名一起算 ✓：「合理拼形」（第 140 ✓）、「構形序」（第 143 輪全域改成「拼形序」✓）、
      「構字式」（第 144 輪全域改成「表意描述序」✓）——產出物裡只該剩下改名記錄那幾行 ✓。 */
(html.match(/合理拼形/g) || []).length <= 3 && (html.match(/構字式/g) || []).length <= 4 &&
  (html.match(/構形序/g) || []).length <= 3
  ? ok("舊說法只剩「師父說要改」的那幾句註解（畫面與其他註解都改乾淨 ✓）")
  : bad(`舊說法還在產出物裡：合理拼形 ${(html.match(/合理拼形/g) || []).length} 處、` +
        `構字式 ${(html.match(/構字式/g) || []).length} 處、` +
        `構形序 ${(html.match(/構形序/g) || []).length} 處`);

/* ★ 2026-10-16（師父）：「候選字依 unicode 分區使用不同顏色，**配色同 glyph-browser.html**」✓
   → 調色盤（`BLOCKS` ＋ `blockIndexOf`／`colorOfBlock`／`colorOfCp`／`colorOfGlyph`）
     搬進共用層 `tools/glyph-common-page.js` ✓，而且是**兩頁逐字同一份** ✓。
   ⚠ 兩頁各寫一份就等著「A 頁改了、B 頁沒改」✗（這個專案吃過那個虧 ✓）——
     所以驗收直接**比對兩份產出物裡的調色盤原始碼** ✓，不是只比對數字 ✓。 */
{
  const paletteOf = (s: string) =>
    (/var BLOCKS = \[[\s\S]*?\nfunction colorOfGlyph\(i\) \{[\s\S]*?\n\}/.exec(s) || [""])[0]!;
  const mine = paletteOf(script);
  const nBlocks = (script.match(/var BLOCKS = \[/g) || []).length;
  nBlocks === 1
    ? ok("本頁的區塊表只有一份（沒有在頁面裡另外再抄一份 ✓）")
    : bad(`本頁出現 ${nBlocks} 份 var BLOCKS（共用層那一份之外又多抄了 ✗）`);
  const otherPage = resolve(D, "out/glyph-browser.html");
  if (!existsSync(otherPage)) {
    bad("找不到 out/glyph-browser.html——兩頁要同一份調色盤，無從比對");
  } else {
    const osc = /<script>([\s\S]*?)<\/script>/.exec(readFileSync(otherPage, "utf8"))![1]!;
    const theirs = paletteOf(osc);
    mine.length > 500 && mine === theirs
      ? ok(`區塊調色盤在兩頁是**逐字同一份**（${mine.split("\n").length} 行；` +
           `改一邊就會被這條擋下來 ✓）`)
      : bad(`兩頁的區塊調色盤不一致（本頁 ${mine.length} 字、另一頁 ${theirs.length} 字）` +
            `——候選字的顏色會跟字集瀏覽頁不同`);
    /* ★ 2026-10-16：**檢字運算子的用法也只有一份** ✓——拼形頁的 popup 與字集瀏覽頁的
       「運算式說明」是同一張表 ✓（只有 `U+908F` 那一行兩頁不同 ✓，見共用層的註解 ✓）。 */
    const rowsOf = (s: string) => (/var SEARCH_HELP_ROWS = \[[\s\S]*?\n\];/.exec(s) || [""])[0]!;
    const rowsA = rowsOf(script), rowsB = rowsOf(osc);
    rowsA.length > 100 && rowsA === rowsB
      ? ok(`檢字運算子的說明在兩頁也是**逐字同一份**（${rowsA.split("\n").length} 行 ✓）`)
      : bad(`兩頁的運算子說明不一致（本頁 ${rowsA.length} 字、另一頁 ${rowsB.length} 字）`);
  }
}

// ---------------------------------------------------------------- 4. headless 實跑
console.log("\n4. headless 瀏覽器：逐步模擬〈招財進寶〉動線");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
if (!existsSync(EDGE)) {
  console.log("  ！找不到 Edge，跳過瀏覽器實跑");
} else {
  const probe = `
<script>
(function () {
  function report(s) { document.title = "PROBE|" + s; }
  var out = [];
  window.addEventListener("error", function (e) { out.push("PAGEERR:" + e.message); });
  window.addEventListener("unhandledrejection", function (e) {
    out.push("REJECT:" + (e.reason && e.reason.message || e.reason));
  });
  function S() { return window.__STATE__ ? window.__STATE__() : {}; }
  function seqEl() { return document.getElementById("seq"); }
  function setSeq(v) { seqEl().value = v; seqEl().dispatchEvent(new Event("input")); }
  function chipCh(s) {
    var ms = document.querySelectorAll("#seqChips .mini.comp");
    for (var i = 0; i < ms.length; i++) {
      if (ms[i].getAttribute("data-ch") === s) { ms[i].click(); return true; }
    }
    return false;
  }
  function allCells() { if (SEARCH) { candShown = SEARCH.cps.length; renderSearch(); } }
  function cellWith(cp) {
    allCells();
    var cs = document.querySelectorAll("#cands .cell");
    for (var i = 0; i < cs.length; i++) {
      if (Number(cs[i].getAttribute("data-cp")) === cp) { cs[i].click(); return true; }
    }
    return false;
  }
  function snap(k) {
    var s = S();
    out.push(k + "=" + encodeURIComponent(JSON.stringify({
      seq: seqEl().value, mode: s.mode, ready: s.ready, chips: s.chipCount,
      boxes: s.boxCount, cands: s.candCount, cells: s.candCells,
      msg: document.getElementById("msg").textContent,
      cap: document.getElementById("seqNote").textContent,
      ink: document.getElementById("bigNote").textContent
    })));
  }
  var q = [
    /* --- 開頁 --- */
    function () {
      var vis = "";
      for (var bi = 0; bi < document.body.children.length; bi++) {
        var bel = document.body.children[bi];
        if (bel.tagName !== "SCRIPT") vis += bel.textContent + " ";
      }
      out.push("loadError=" + (/載入失敗/.test(vis) ? 1 : 0));
      /* ★ 一開始（還沒輸入）魔杖必須**看不見** ✓——
         ⚠ 只驗「hidden」不夠 ✗：「.iconbtn」的 display:flex 會蓋掉 [hidden] ✗，
           一定要驗 getComputedStyle 的 display ✓（第 112 輪的同一個坑 ✓）。 */
      var wand0 = document.getElementById("wand");
      out.push("PwandInit=hidden=" + (wand0 ? String(!!wand0.hidden) : "MISSING") +
        ",disp=" + (wand0 ? getComputedStyle(wand0).display : "?") +
        ",seq=" + encodeURIComponent(seqEl().value));
      /* 初始化失敗時把**錯誤訊息本體**帶出來——只給前 60 字會看不到原因 ✗（踩過）。 */
      var em = /載入失敗：([\s\S]{0,300})/.exec(vis);
      out.push("loadErrMsg=" + encodeURIComponent(em ? em[1].replace(/\\s+/g, " ") : ""));
      out.push("bodyHead=" + encodeURIComponent(vis.replace(/\\s+/g, " ").trim().slice(0, 60)));
      out.push("glyphs=" + (window.__READY__ || {}).glyphs);
      out.push("decodeMs=" + (window.__READY__ || {}).decodeMs);
      var big = document.getElementById("big");
      out.push("canvasW=" + big.getBoundingClientRect().width);
      out.push("canvasH=" + big.getBoundingClientRect().height);
      out.push("placeholder=" + encodeURIComponent(big.textContent));
      out.push("stockRows=" + document.querySelectorAll("#stock .stockrow").length);
      out.push("stockCells=" + document.querySelectorAll("#stock .stockcell").length);
      /* 標題不再有狀態列（就緒／字形數／解碼時間都去掉），改成一句回饋 */
      out.push("title=" + encodeURIComponent(document.title));
      out.push("headerB=" + (document.querySelectorAll("header.top b").length));
      out.push("headerTxt=" + encodeURIComponent(document.querySelector("header.top").textContent.replace(/\s+/g, " ").trim()));
      /* 輸入區的用法提示在 placeholder；底色刻意跟卡片不同（使用者要知道在哪打字） */
      out.push("ph=" + encodeURIComponent(document.getElementById("seq").getAttribute("placeholder")));
      out.push("seqBg=" + encodeURIComponent(getComputedStyle(document.getElementById("seq")).backgroundColor));
      out.push("secBg=" + encodeURIComponent(getComputedStyle(document.querySelector(".sec")).backgroundColor));
      out.push("lbl=" + encodeURIComponent(document.getElementById("seqlbl").textContent));
      out.push("lblCls=" + encodeURIComponent(document.getElementById("seqlbl").className));
      out.push("hasSaveIcon=" + !!document.querySelector("#saveSeq svg"));
      out.push("hasSlider=" + !!document.getElementById("wscale"));
      out.push("boxMode=" + encodeURIComponent(document.getElementById("boxMode").getAttribute("data-mode")));
      out.push("boxLabel=" + encodeURIComponent(document.getElementById("boxMode").textContent));
      /* ★ 2026-10-16（師父）：**新客人第一次打開**的樣子 ✓（這支實跑用的是乾淨的
         「--user-data-dir」✓，所以「還原」不會蓋掉這些起始值 ✓）：
         輸入區空白 ✓、筆劃粗細 100 ✓、**字框預設不顯示** ✓、中間部件不勾 ✓。 */
      out.push("bootSeq=" + encodeURIComponent(seqEl().value));
      out.push("bootW=" + document.getElementById("wscale").value);
      out.push("bootMid=" + document.getElementById("showMid").checked);
      out.push("bootLsSeq=" + JSON.stringify(localStorage.getItem("pinxing.seq")));
      /* 清空按鈕已經移除（使用者的要求） */
      out.push("noClear=" + !document.getElementById("clearSeq"));
      /* 筆劃粗細與字框跟輸入區同一張卡（現在那張卡就是 header.top） */
      out.push("topSec=" + (function () {
        var sec = document.getElementById("wscale").closest(".sec, header.top");
        return !!sec && sec.contains(document.getElementById("seq")) &&
          sec.contains(document.getElementById("boxMode"));
      })());
      /* 回饋是**浮層**（absolute），不佔高度 → 不會推動下面的版面。
         這一條要真的量：顯示一段會換行的長提示，比較大字與下面各段的 Y 有沒有動。 */
      out.push("toastPos=" + getComputedStyle(document.getElementById("msg")).position);
      out.push("toastInRow=" + (document.getElementById("msg").parentElement.className));
      (function () {
        var t = document.getElementById("msg");
        toast("", "");
        var y0 = document.getElementById("big").getBoundingClientRect().top;
        var s0 = document.getElementById("stock").getBoundingClientRect().top;
        toast("這是一句夠長的測試提示，用來確認它出現時不會推動下面的版面——就算換行也不該推東西。", "warn");
        var y1 = document.getElementById("big").getBoundingClientRect().top;
        var s1 = document.getElementById("stock").getBoundingClientRect().top;
        out.push("toastH=" + Math.round(t.offsetHeight) + " clientH=" + Math.round(t.clientHeight));
        out.push("toastShift=" + Math.max(Math.abs(y1 - y0), Math.abs(s1 - s0)));
        toast("", "");
      })();
      out.push("candHidden=" + document.getElementById("candSec").hidden);
    },
    /* --- 步驟 1：輸入「進」 --- */
    function () { setSeq("進"); snap("A"); },
    /* --- 步驟 2：點部件序列的「辶」→ 進辶，下方列出含辶的字 --- */
    function () {
      out.push("Bchip=" + chipCh("辶"));
      snap("B");
      out.push("Bterm=" + encodeURIComponent(SEARCH ? SEARCH.term : ""));
      out.push("BhasLuo=" + (SEARCH ? SEARCH.cps.indexOf(0x908F) >= 0 : false));
      out.push("Bchips=" + JSON.stringify(Array.prototype.map.call(
        document.querySelectorAll("#seqChips .mini.comp"), function (m) { return m.getAttribute("data-ch"); })));
    },
    /* --- 步驟 3：從候選裡找到「邏」→ 點它（＝選為基字） --- */
    function () {
      out.push("Cclick=" + cellWith(0x908F));
      snap("C");
      out.push("Cbase=" + (MAIN ? codePointOf(LIB, MAIN.idx).toString(16) : "none"));
    },
    /* --- 步驟 4：點部件序列的「羅」→ 邏羅（指名要換掉羅） --- */
    function () { out.push("Dchip=" + chipCh("羅")); snap("D"); },
    /* --- 步驟 5：輸入「寶」→ 邏羅寶（合法拼形序列，畫組出來的形） --- */
    function () {
      setSeq("邏羅寶"); snap("E");
      out.push("Epaths=" + document.querySelectorAll("#big svg path").length);
      /* ★ 師父 2026-10-16：「合理拼形」改為「**拼形序**」✓（中間一度叫「構形序」✓，同日統一 ✓）——標籤是客人第一眼看到的字 ✓ */
      out.push("Elbl=" + encodeURIComponent(document.getElementById("seqlbl").textContent));
      out.push("EcapHasBao=" + /寶/.test(document.getElementById("seqNote").textContent));
      out.push("Eowner=" + encodeURIComponent(String(seqOwnerChar(lastEval, "邏羅寶"))) +
        " cur=" + document.getElementById("seq").selectionStart +
        " stOwner=" + encodeURIComponent(String((lastEval && lastEval.owner) || "")));
      out.push("Echips=" + JSON.stringify(Array.prototype.map.call(
        document.querySelectorAll("#seqChips .mini.comp"), function (m) { return m.getAttribute("data-ch"); })));
      out.push("EchipsN=" + document.querySelectorAll("#seqChips .mini.comp").length);
      out.push("EchipTips=" + encodeURIComponent(Array.prototype.map.call(
        document.querySelectorAll("#seqChips .mini.comp"), function (m) { return (m.getAttribute("title") || "").slice(0, 12); }).join(" | ")));
    },
    /* --- 大字的部件框：顯示／隱藏 ＋ 中間部件、點框連動 --- */
    function () {
      out.push("Fboxes=" + document.querySelectorAll("#big .cbox").length);
      out.push("FboxData=" + Array.prototype.map.call(
        document.querySelectorAll("#big .cbox"), function (b) { return b.getAttribute("data-box"); }).join(","));
      var b = document.getElementById("boxMode");
      var mid = document.getElementById("showMid");
      try {
        function modeInfo(tag) {
          out.push(tag + "N=" + document.querySelectorAll("#big .cbox").length);
          out.push(tag + "S=" + document.querySelectorAll("#big .cbox.sub").length);
          out.push(tag + "T=" + encodeURIComponent(b.textContent));
          out.push(tag + "M=" + b.getAttribute("data-mode"));
          out.push(tag + "P=" + document.querySelectorAll("#big svg path").length);
          var gl = document.querySelector("#big .boxlayer");
          out.push(tag + "G=" + (gl && /(^| )ghost( |$)/.test(gl.getAttribute("class") || "") ? "yes" : "no"));
        }
        out.push("FshowT=" + encodeURIComponent(b.textContent));
        out.push("FshowM=" + b.getAttribute("data-mode"));
        out.push("FshowN=" + document.querySelectorAll("#big .cbox").length);
        out.push("FmidHas=" + (mid ? "yes" : "MISSING"));
        /* ★ 2026-10-16：預設改成「**不顯示字框**」✓（師父：「缺省不要打開字框顯示」✓）——
           所以這裡先把它**打開** ✓，下面那兩次點擊才有固定的起點
           （不然「Fnone」與「Fback」會對調 ✗）。 */
        while (b.getAttribute("data-mode") === "none") b.click();
        if (mid) { mid.checked = true; mid.dispatchEvent(new Event("change")); }
        modeInfo("Fdeep");
        if (mid) { mid.checked = false; mid.dispatchEvent(new Event("change")); }
        out.push("FmidOff=" + document.querySelectorAll("#big .cbox").length);
        b.click(); modeInfo("Fnone");
        b.click(); modeInfo("Fback");
        /* ★ 師父 2026-10-15：框色＝HSV 色相**每格轉 30 度** ✓ */
        var cs = document.querySelectorAll("#big .cbox");
        var hues = [];
        for (var q = 0; q < cs.length && q < 4; q++) {
          var v = cs[q].style.getPropertyValue("--c");
          var t = v.slice(4, -1).split(",");
          var rr = Number(t[0]) / 255, gg = Number(t[1]) / 255, bb = Number(t[2]) / 255;
          var mx = Math.max(rr, gg, bb), mn = Math.min(rr, gg, bb), dd = mx - mn;
          var hh = !dd ? 0 : (mx === rr ? ((gg - bb) / dd + (gg < bb ? 6 : 0))
            : mx === gg ? ((bb - rr) / dd + 2) : ((rr - gg) / dd + 4));
          hues.push(Math.round(hh * 60));
        }
        out.push("Fhues=" + hues.join(","));
        var diffs = [];
        for (var w = 1; w < hues.length; w++) diffs.push(((hues[w] - hues[w - 1]) % 360 + 360) % 360);
        out.push("FhueDiffs=" + diffs.join(","));
        var box = document.querySelector("#big .cbox");
        out.push("Fclicked=" + (!!box));
        if (box) box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        out.push("FactiveChip=" + document.querySelectorAll("#seqChips .mini.comp.on").length);
        out.push("FactiveBox=" + document.querySelectorAll("#big .cbox.on").length);
        /* ★ 選中的部件：筆劃要染成**框色**（不是白色 ✓） */
        var lay = document.querySelector("#big .hllayer");
        out.push("FhlPaths=" + (lay ? lay.querySelectorAll("path").length : -1));
        out.push("FhlFill=" + (lay && lay.querySelector("path") ? lay.querySelector("path").getAttribute("fill") : ""));
        var b0 = document.querySelector("#big .cbox");
        out.push("Fbox0c=" + (b0 ? b0.style.getPropertyValue("--c") : ""));
      } catch (e) { out.push("FEXC=" + e.message); }
    },
    /* --- 手畫的部件（寶缶支 的 王）＋ 藏框時仍能塗色（師父 2026-10-16） --- */
    function () {
      var seqv = seqEl().value;
      var mid = document.getElementById("showMid");
      if (mid && mid.checked) { mid.checked = false; mid.dispatchEvent(new Event("change")); }
      setSeq("寶缶支");
      out.push("Kchips=" + document.querySelectorAll("#seqChips .mini.comp").length);
      out.push("Ktips=" + encodeURIComponent(Array.prototype.map.call(
        document.querySelectorAll("#seqChips .mini.comp"), function (m) { return (m.getAttribute("title") || "").slice(0, 6); }).join("|")));
      out.push("Kboxes=" + document.querySelectorAll("#big .cbox").length);
      /* 藏起字框 → 塗色還是要能和部件清單連動 ✓ */
      var kb = document.getElementById("boxMode");
      if (kb.getAttribute("data-mode") !== "none") kb.click();
      var klayer = document.querySelector("#big .boxlayer");
      out.push("Kmode=" + kb.getAttribute("data-mode") + "/" + document.querySelectorAll("#big .cbox").length);
      out.push("Kghost=" + (klayer ? (/(^| )ghost( |$)/.test(klayer.getAttribute("class") || "") ? "yes" : "no") : "none"));
      /* ★ 師父 2026-10-16：框只是看不見、**還是有作用** ✓——
         在大字上滑過那一個（看不見的）框，照樣塗色、清單那一格也亮 ✓。 */
      var kbox = document.querySelector("#big .cbox");
      if (kbox) kbox.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      var klay = document.querySelector("#big .hllayer");
      out.push("KghostPaths=" + (klay ? klay.querySelectorAll("path").length : -1));
      out.push("KghostChip=" + document.querySelectorAll("#seqChips .mini.comp.hover").length);
      var kchip = document.querySelector("#seqChips .mini.comp");
      if (kchip) kchip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      var klay = document.querySelector("#big .hllayer");
      out.push("Khl=" + (klay ? klay.querySelectorAll("path").length : -1));
      out.push("KhFill=" + (klay && klay.querySelector("path") ? klay.querySelector("path").getAttribute("fill") : ""));
      out.push("KhBox=" + (kchip ? kchip.style.getPropertyValue("--c") : ""));
      /* ★ 手畫筆劃的部件（寶缶支 的 王）也要能塗色 ✓（它沒有引用路徑 ✓） */
      var kw = null, kall = document.querySelectorAll("#seqChips .mini.comp");
      for (var wi = 0; wi < kall.length; wi++) {
        if ((kall[wi].getAttribute("title") || "").indexOf("U+738B") >= 0) { kw = kall[wi]; break; }
      }
      if (kw) kw.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      out.push("KwPaths=" + (klay ? klay.querySelectorAll("path").length : -1));
      out.push("KwFill=" + (klay && klay.querySelector("path") ? klay.querySelector("path").getAttribute("fill") : ""));
      out.push("KwC=" + (kw ? kw.style.getPropertyValue("--c") : ""));
      if (kchip) kchip.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      if (kb.getAttribute("data-mode") === "none") kb.click();
      setSeq(seqv);
    },
    /* --- 長序列：部件該是「貝」不是「目」（師父 2026-10-16） --- */
    function () {
      var seqv = seqEl().value;
      setSeq(String.fromCodePoint(0x908F, 0x7F85, 0x5BF6, 0x8C9D, 0x29028, 0x5F9E, 0x4783, 0x81F4, 0x62DB));
      var mc = document.querySelectorAll("#seqChips .mini.comp");
      var mt = [];
      for (var mi = 0; mi < mc.length; mi++) mt.push((mc[mi].getAttribute("title") || "").slice(0, 6));
      out.push("Mchips=" + mc.length);
      out.push("Mtips=" + mt.join(","));
      out.push("Mboxes=" + document.querySelectorAll("#big .cbox").length);
      setSeq(seqv);
    },
    /* --- IDS 模式 ＋ 藏字框：塗色也要和部件清單連動（師父 2026-10-16） --- */
    function () {
      var seqv = seqEl().value;
      var mid = document.getElementById("showMid");
      if (mid && mid.checked) { mid.checked = false; mid.dispatchEvent(new Event("change")); }
      var lb = document.getElementById("boxMode");
      if (lb.getAttribute("data-mode") !== "none") lb.click();
      setSeq(String.fromCharCode(0x2FF0, 0x6728, 0x2FF3, 0x91D1, 0x2FF0, 0x6C34, 0x706B, 0x571F));
      out.push("Lmode=" + lb.getAttribute("data-mode") + "/" + (lastEval && lastEval.mode) +
        "/" + document.querySelectorAll("#seqChips .mini.comp").length);
      var lc = document.querySelectorAll("#seqChips .mini.comp");
      if (lc[0]) lc[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      var llay = document.querySelector("#big .hllayer");
      out.push("Lhl=" + (llay ? llay.querySelectorAll("path").length : -1));
      out.push("Lfill=" + (llay && llay.querySelector("path") ? llay.querySelector("path").getAttribute("fill") : ""));
      out.push("Lbox=" + (lc[0] ? lc[0].style.getPropertyValue("--c") : ""));
      if (lc[1]) lc[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      out.push("Lclick=" + (llay && llay.querySelectorAll("path").length));
      if (lb.getAttribute("data-mode") === "none") lb.click();
      setSeq(seqv);
    },
    /* --- 「字框：孫」：所有子孫的框（直到獨體）--- */
    function () {
      var seqv = seqEl().value;
      setSeq("邏");   /* 用**真的有三層**的字 ✓（想 的畫法是手畫 木 ＋ 引用 目、心，孫框不會變多 ✓） */
      var b = document.getElementById("boxMode");
      var mid = document.getElementById("showMid");
      while (b.getAttribute("data-mode") === "none") b.click();      /* 先讓字框是顯示的 ✓ */
      if (mid && mid.checked) { mid.checked = false; mid.dispatchEvent(new Event("change")); }
      out.push("Dtight=" + document.querySelectorAll("#big .cbox").length);
      out.push("DtightSub=" + document.querySelectorAll("#big .cbox.sub").length);
      if (mid) { mid.checked = true; mid.dispatchEvent(new Event("change")); }   /* 勾中間部件 → 孫框 ✓ */
      out.push("Dmode=" + b.getAttribute("data-mode"));
      out.push("Dlabel=" + encodeURIComponent(b.textContent));
      out.push("Dall=" + document.querySelectorAll("#big .cbox").length);
      out.push("Dsub=" + document.querySelectorAll("#big .cbox.sub").length);
      out.push("Ddirect=" + document.querySelectorAll("#big .cbox:not(.sub)").length);
      out.push("Dpaths=" + document.querySelectorAll("#big svg path").length);
      out.push("Dchips=" + document.querySelectorAll("#seqChips .mini.comp").length);
      out.push("Dtips=" + encodeURIComponent(Array.prototype.map.call(
        document.querySelectorAll("#big .cbox title"), function (t) { return t.textContent; }).join(" | ")));
      /* ★ 孫框**可以**連動 ✓（師父 2026-10-15 的要求：點它要和部件清單互相亮起 ✓） */
      var dsub = document.querySelector("#big .cbox.sub");
      if (dsub) dsub.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      out.push("DsubClickOn=" + document.querySelectorAll("#big .cbox.on").length);
      out.push("DsubChipOn=" + document.querySelectorAll("#seqChips .mini.comp.on").length);
      /* ★ 反向連動：滑過部件清單的格子 → 大字的框也亮 ✓（師父 2026-10-15：「反向不行」✓） */
      var dchip = document.querySelector("#seqChips .mini.comp[data-box]");
      if (dchip) dchip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      out.push("DchipHover=" + document.querySelectorAll("#big .cbox.hover").length);
      if (mid) { mid.checked = false; mid.dispatchEvent(new Event("change")); }   /* 取消中間部件 ✓ */
      out.push("Dback=" + document.querySelectorAll("#big .cbox").length);
      setSeq(seqv);
    },
    /* --- 筆劃粗細：拉了要真的重畫 --- */
    function () {
      var w = document.getElementById("wscale");
      var before = document.querySelector("#big svg path").getAttribute("d");
      w.value = "180"; w.dispatchEvent(new Event("input"));
      var after = document.querySelector("#big svg path").getAttribute("d");
      out.push("Gchanged=" + (after !== before) + " label=" + document.getElementById("wscaleV").textContent);
      w.value = "100"; w.dispatchEvent(new Event("input"));
      out.push("Gback=" + (document.querySelector("#big svg path").getAttribute("d") === before));
    },
    /* --- 庫存拼形：六個正方形按鈕（只畫組出來的字，不顯示拼形式） --- */
    function () {
      var rows = document.querySelectorAll("#stock .stockrow");
      var seqs = [], noGlyph = 0, refs = 0, square = 0, idsRows = 0, rawImgs = 0, rawLoaded = 0;
      for (var i = 0; i < rows.length; i++) {
        seqs.push(rows[i].getAttribute("data-seq") || rows[i].getAttribute("data-send") || "?");
        if (!rows[i].querySelector(".stockcell svg") && !rows[i].querySelector(".stockcell img")) noGlyph++;
        if (rows[i].querySelector(".stockcell .flag")) refs++;
        /* ★ IDS 合文那一列（師父第 122 輪 ✓）：用「mbflag」標「合」✓，**不算**「參」✓ */
        if (rows[i].getAttribute("data-ids")) idsRows++;
        var rim = rows[i].querySelector(".stockcell img.rawimg");
        if (rim) { rawImgs++; if (rim.naturalWidth > 0) rawLoaded++; }
        var r = rows[i].getBoundingClientRect();
        if (Math.abs(r.width - r.height) <= 4) square++;
      }
      out.push("Hseqs=" + encodeURIComponent(seqs.join("|")));
      out.push("HnoGlyph=" + noGlyph);
      out.push("Hrefs=" + refs);
      out.push("Hsquare=" + square);
      out.push("HidsRows=" + idsRows);
      /* ★ 師父第 129 輪抓到的 bug ✓：CSS 的 filter:invert 把**白墨**反成黑 ✗ → 圖在深色格子裡看不見 ✗。
         所以這一條要驗「圖**真的載入**」✓（naturalWidth > 0 ✓），不只是「DOM 裡有 img」✓。 */
      out.push("HrawImg=" + rawImgs + "," + rawLoaded);
      out.push("HseqText=" + document.querySelectorAll("#stock .seqtext, #stock .seqglyph").length);
      out.push("Hcredit=" + encodeURIComponent(document.querySelector(".credits").textContent.replace(/\s+/g, " ").trim()));
      out.push("Hdevlink=" + encodeURIComponent((function () {
        var a = document.querySelector(".credits a");
        return a ? (a.getAttribute("href") + "|" + a.textContent) : "MISSING";
      })()));
      rows[3].click();
      snap("H");
    },
    /* --- 存自己的序列：存檔／垃圾桶兩態 ＋ Enter；已存過要移到最前面 --- */
    function () {
      setSeq("初衤礻");
      var sb = document.getElementById("saveSeq");
      out.push("Idel0=" + sb.classList.contains("del"));
      sb.click();
      out.push("Imine=" + document.querySelectorAll("#stock .stockrow.mine").length);
      out.push("Ils=" + encodeURIComponent(localStorage.getItem("pinxing.stock") || ""));
      out.push("Itoast=" + encodeURIComponent(document.getElementById("msg").textContent));
      out.push("Idel1=" + sb.classList.contains("del"));
      out.push("IdelSvg=" + getComputedStyle(sb.querySelector(".icoDel")).display);
      /* ★ 再按一下（垃圾桶）＝**刪除** ✓、按鈕變回存檔 ✓ */
      sb.click();
      out.push("ImineDel=" + document.querySelectorAll("#stock .stockrow.mine").length);
      out.push("Idel2=" + sb.classList.contains("del"));
      /* ★ 客人後悔：再按一下 → **又存回來** ✓ */
      sb.click();
      out.push("ImineBack=" + document.querySelectorAll("#stock .stockrow.mine").length);
      out.push("Idel3=" + sb.classList.contains("del"));
      /* 自存的列**不該**再有「刪」小按鈕（會把方形按鈕撐成長方形 ✗） */
      out.push("ImineDelBtn=" + document.querySelectorAll("#stock .stockrow.mine .delStock").length);
      var mrow = document.querySelector("#stock .stockrow.mine");
      if (mrow) { var mr = mrow.getBoundingClientRect(); out.push("ImineSq=" + (Math.abs(mr.width - mr.height) < 3)); }
      /* Enter 也要能存：keydown 真的有接上（preventDefault 生效）＋ 內容進 localStorage。
         先換成另一串，才驗得出 Enter 真的存了東西。 */
      setSeq("衚胡舞");
      var ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      var notCancelled = seqEl().dispatchEvent(ev);
      out.push("IenterPrevented=" + (!notCancelled));
      out.push("Ienter=" + encodeURIComponent(localStorage.getItem("pinxing.stock") || ""));
      out.push("Itoast2=" + encodeURIComponent(document.getElementById("msg").textContent));
      /* Enter 再存一次已經存過的：要**移到最前面**，不是多一份（Enter 不刪 ✓） */
      setSeq("初衤礻");
      seqEl().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      out.push("Iagain=" + encodeURIComponent(localStorage.getItem("pinxing.stock") || ""));
      out.push("Imine2=" + document.querySelectorAll("#stock .stockrow.mine").length);
      /* 清空靠 Escape（清空按鈕已移除） */
      seqEl().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      snap("I");
      out.push("Iseq=" + JSON.stringify(seqEl().value));
      out.push("IcandCells=" + document.querySelectorAll("#cands .cell").length);
    },
    /* --- 非法序列 → 部件搜尋（規格第 7 條）：輸入「木」也要能用 --- */
    function () {
      setSeq("木");
      snap("J");
      setSeq("木日");
      snap("K");
      out.push("Kterm=" + encodeURIComponent(SEARCH ? SEARCH.term : ""));
      /* 庫存每一組都要「帶得進輸入區、畫得出東西」——
         ★ 第 127 輪：合文那兩列送的是 **IDS**（「data-send」✓），其餘送拼形序（「data-seq」✓）。 */
      var rows2 = document.querySelectorAll("#stock .stockrow");
      var bad = [];
      for (var i = 0; i < rows2.length; i++) {
        rows2[i].click();
        var want = rows2[i].getAttribute("data-send") || rows2[i].getAttribute("data-seq");
        if (seqEl().value !== want) bad.push(i + ":" + seqEl().value + "≠" + want);
        if (!document.querySelector("#big svg")) bad.push(i + ":沒畫出字形");
      }
      out.push("KstockBad=" + encodeURIComponent(bad.join(" | ")));
      out.push("KstockLast=" + encodeURIComponent(seqEl().value));
      out.push("KstockPaths=" + document.querySelectorAll("#big svg path").length);
    },
    /* --- 部件清單：KAGE 引用 ＋ IDS 補的部件（含沒有碼位的） --- */
    function () {
      var cases = ["從", "合", "進", "邏", "寶", "颰", "木"];
      var res = [];
      for (var i = 0; i < cases.length; i++) {
        setSeq(cases[i]);
        var ms = document.querySelectorAll("#seqChips .mini.comp");
        var a = [];
        for (var k = 0; k < ms.length; k++) {
          a.push((ms[k].getAttribute("data-ch") || "∅") + (ms[k].classList.contains("unnamed") ? "?" : ""));
        }
        res.push(cases[i] + "=" + a.join("+"));
      }
      /* 從 的第二個部件（g40la）沒有碼位也沒有 IDS：要看得到、但不可點 */
      var unnamedClickable = 0, unnamedCursor = "", unnamedStyle = "";
      setSeq("從");
      var ms2 = document.querySelectorAll("#seqChips .mini.comp.unnamed");
      for (var q = 0; q < ms2.length; q++) {
        if (ms2[q].getAttribute("data-ch")) unnamedClickable++;
        unnamedCursor = getComputedStyle(ms2[q]).cursor;
        unnamedStyle = getComputedStyle(ms2[q]).borderTopStyle;
      }
      out.push("chipCases=" + encodeURIComponent(res.join(" | ")));
      out.push("unnamedWithCh=" + unnamedClickable);
      out.push("unnamedCount=" + ms2.length);
      out.push("unnamedCursor=" + encodeURIComponent(unnamedCursor + " style=" + unnamedStyle));
    },
    /* --- 與字集瀏覽頁的連動：按鈕要指向 glyph-browser.html?comp=… --- */
    function () {
      setSeq("進辶");                      /* 讀不成拼形式 → 部件檢字 */
      out.push("link1=" + encodeURIComponent(document.getElementById("toBrowser").dataset.comp || "") +
        " txt=" + encodeURIComponent(document.getElementById("toBrowser").textContent));
      setSeq("邏羅寶");                    /* 拼形序：帶的是最後一個字 */
      out.push("link2=" + encodeURIComponent(document.getElementById("toBrowser").dataset.comp || ""));
      setSeq("木");                        /* 單字：帶它自己 */
      out.push("link3=" + encodeURIComponent(document.getElementById("toBrowser").dataset.comp || ""));
      /* **按鈕會組出哪一條 URL**：讀 browserUrl()（不跳頁——真的跳走就沒有回報了） */
      setSeq("進辶");
      out.push("clickUrl=" + encodeURIComponent(browserUrl()));
      setSeq("");
      out.push("clickUrlEmpty=" + JSON.stringify(browserUrl()));
    },
    /* --- 檢字語法（搬 glyph-browser 已實作好的那套）：運算子、重複、筆劃數 --- */
    function () {
      var cases = ["木/", "/木", "木+", "+木", "口口", "4木日"];
      var res = [];
      for (var i = 0; i < cases.length; i++) {
        setSeq(cases[i]);
        res.push(cases[i] + "=" + S().candCount);
      }
      out.push("syntax=" + encodeURIComponent(res.join(" ")));
      setSeq("木+");
      out.push("syntaxNote=" + encodeURIComponent(document.getElementById("candNote").textContent));
      out.push("syntaxStockHidden=" + document.getElementById("stockSec").hidden);
      /* 沒有候選時庫存要回來 */
      setSeq("");
      out.push("stockBack=" + (!document.getElementById("stockSec").hidden));
      setSeq("水");
      out.push("stockOnSingle=" + (function () {
        var st = S();
        return st.candCount + "/" + document.getElementById("stockSec").hidden;
      })());
    },
    /* --- 合成字形的快取：**交替不同的組合，A→B→A 每一步都要正確** ---
       原本的快取鍵是（索引, 庫長度），而 evalSeq 每次都把合成字形接在庫尾，
       所以兩次不同的組合會拿到同一個鍵 → 回傳上一個組合的 SVG。
       症狀：改成 角 了，畫面還是 刀（使用者回報「兩次祈斤角都是祈斤刀」）。 */
    function () {
      var seqs = ["祈斤刀", "祈斤角", "祈斤刀", "祈斤角", "初衤礻", "初衤刀", "初衤礻"];
      var sigs = [];
      for (var i = 0; i < seqs.length; i++) {
        setSeq(seqs[i]);
        var svg = document.querySelector("#big svg");
        sigs.push(svg ? svg.innerHTML.length + ":" + (svg.querySelector("path") ? 1 : 0) : "0");
      }
      out.push("cacheA=" + sigs[0] + " cacheB=" + sigs[1] + " cacheA2=" + sigs[2] + " cacheB2=" + sigs[3]);
      out.push("cacheC=" + sigs[4] + " cacheD=" + sigs[5] + " cacheC2=" + sigs[6]);
      /* 同一個序列求兩次要一樣（可以共用快取） */
      setSeq("祈斤角");
      var s1 = document.querySelector("#big svg").innerHTML.length;
      setSeq("祈斤角");
      var s2 = document.querySelector("#big svg").innerHTML.length;
      out.push("cacheSame=" + (s1 === s2));
    },
    /* --- 孫級部件：要換的部件在**筆畫／IDS 構件**裡、不在 KAGE 引用樹裡 ---
       使用者回報的順序：先「報幸土业」變成「土业」水平合併、「幸土业」變成水平三等分，
       最後要求「幸土业 應該是业在上、𢆉在下」。
       引擎現在的做法（free-compose.ts 的 solveIdsSlots）：父字形畫成筆畫、但 IDS 有構件時，
       **從筆畫反推槽位**（構件分組＋攤平比對評分），只拔掉目標構件那幾筆、補一筆指向新內容
       的引用；推不出來才判不合法。
       註：這個探針字串是樣板字串，**留言裡不可以出現反引號**（會提前結束字串）。 */
    function () {
      /* 「報幸土业」：新內容 土业 讀不成拼形序列 → 仍走橫向串接（warn「不是原地換部件」） */
      setSeq("報幸土业");
      snap("L");
      out.push("Lmsg=" + encodeURIComponent(document.getElementById("msg").textContent));
      out.push("Link=" + encodeURIComponent(document.getElementById("bigNote").textContent));
      /* 「幸土业」：幸 的 土 → 业，槽位由 IDS 構件反推（业 在上、𢆉 在下） */
      setSeq("幸土业");
      snap("L2");
      out.push("L2msg=" + encodeURIComponent(document.getElementById("msg").textContent));
      out.push("L2paths=" + document.querySelectorAll("#big svg path").length);
      /* 「報土业」：同一個機制在樹的深處（報→幸→土） */
      setSeq("報土业");
      snap("M");
      out.push("Mmsg=" + encodeURIComponent(document.getElementById("msg").textContent));
      out.push("Mpaths=" + document.querySelectorAll("#big svg path").length);
      /* 串接本身還是合法的讀法：彳舞亍（舞 不是 彳 的構件）不能一起被擋掉 */
      setSeq("彳舞亍");
      snap("L3");
      out.push("L3msg=" + encodeURIComponent(document.getElementById("msg").textContent));
      /* 合成字形**沒有碼位**：fork 的庫裡那個索引還帶著基字的碼位（實測是 U+5831），
         照抄會讓人以為畫面上是原本那個字。 */
      setSeq("報幸田");
      snap("N");
      out.push("Nink=" + encodeURIComponent(document.getElementById("bigNote").textContent));
      out.push("Ncp=" + (MAIN ? codePointOf(MAIN.lib, MAIN.idx).toString(16) : "none"));
    },
    /* --- 使用者回報的兩個症狀（2026-10-14）---
       ①「報土业」正常，但把 业 換成任何部件都沒有變化
         → 快取的簽章只看引用**索引**：引擎改的是 fork 出來的 幸（索引沒變），
           所以 報土业／日／田／王 的簽章一模一樣（見頁面的 glyphSig）。
       ②「䴺來去」換不動
         → 第一輪：麥 的 IDS 只有一半有碼位、槽位推不出來，所以清單不讓 來 可點
           （回饋原文：如同搞不定，就不要讓客人在部件清單選擇）。
         → 第二輪（使用者追問「只是要將 來 換掉，底下的 &GT-K00207; 完全不動」）：
           引擎加了**部分 IDS**（殘筆＝那個沒有碼位的構件，不參與分組、也不給框），
           「䴺來去」現在真的換得動。所以這一輪改成驗「點 來 → 打 去 → 組出來」，
           另外留著**真的換不動**的格子（寶 的 𡪓、進 的 隹）驗「點不動」。
       註：這個探針字串是樣板字串，**留言裡不可以出現反引號**（會提前結束字串）。 */
    function () {
      var seqs = ["報土业", "報土日", "報土田", "報土王", "報土业", "報土日"];
      var sig = [];
      for (var i = 0; i < seqs.length; i++) {
        setSeq(seqs[i]);
        var svg = document.querySelector("#big svg");
        sig.push(svg ? svg.innerHTML.length + ":" + document.querySelectorAll("#big svg path").length : "0");
      }
      out.push("Pdeep=" + sig.join(","));
      /* 䴺 的部件清單：五格全部可點（部分 IDS 讓 來 也通了） */
      setSeq("䴺");
      var ms = document.querySelectorAll("#seqChips .mini.comp");
      var list = [], stuck = [], clickable = [];
      for (var k = 0; k < ms.length; k++) {
        var ch2 = ms[k].getAttribute("data-ch") || "∅";
        list.push(ch2 + (ms[k].getAttribute("data-stuck") ? "!" : ""));
        if (ms[k].getAttribute("data-stuck")) stuck.push(ch2);
        else if (ms[k].getAttribute("data-ch")) clickable.push(ch2);
      }
      out.push("Pchips=" + encodeURIComponent(list.join("+")));
      out.push("Pstuck=" + encodeURIComponent(stuck.join("+")));
      out.push("Pclick=" + encodeURIComponent(clickable.join("+")));
      /* 點「來」→ 䴺來（中間狀態）→ 打「去」→ 真的組出來（使用者要的那一條） */
      var hit = 0;
      for (var q2 = 0; q2 < ms.length; q2++) {
        if (ms[q2].getAttribute("data-ch") === "來") { ms[q2].click(); hit = 1; }
      }
      out.push("Plai=" + hit + "," + encodeURIComponent(seqEl().value + " mode=" + S().mode));
      setSeq("䴺來去");
      snap("P3");
      out.push("P3paths=" + document.querySelectorAll("#big svg path").length);
      out.push("P3msg=" + encodeURIComponent(document.getElementById("msg").textContent));
      /* 點「麥」→ 䴺麥（中間狀態）→ 打「去」→ 真的組出來 */
      setSeq("䴺");
      var m2 = document.querySelectorAll("#seqChips .mini.comp");
      for (var r2 = 0; r2 < m2.length; r2++) {
        if (m2[r2].getAttribute("data-ch") === "麥") m2[r2].click();
      }
      out.push("Pmai=" + encodeURIComponent(seqEl().value + " mode=" + S().mode));
      setSeq("䴺麥去");
      snap("P");
      out.push("Ppaths=" + document.querySelectorAll("#big svg path").length);
      /* 真的換不動的格子（寶 的 𡪓、進 的 隹）：列出來、帶 data-stuck、點下去完全沒作用 */
      setSeq("寶");
      var bs = document.querySelectorAll("#seqChips .mini.comp");
      var bstuck = [];
      for (var b = 0; b < bs.length; b++) if (bs[b].getAttribute("data-stuck")) bstuck.push(bs[b].getAttribute("data-ch"));
      out.push("Pstuck2=" + encodeURIComponent(bstuck.join("+")));
      var b0 = seqEl().value;
      for (var b2 = 0; b2 < bs.length; b2++) if (bs[b2].getAttribute("data-ch") === "𡪓") bs[b2].click();
      out.push("PstuckClick=" + (seqEl().value === b0) + "," + encodeURIComponent(seqEl().value));
      /* 兩字輸入落在哪一條規則（②＝引擎的乾跑 canReplaceCp 說換得動才算） */
      var rules = ["寶缶", "䴺麥", "䴺口", "街圭", "報土", "進辶", "木日", "合口"];
      var rr = [];
      for (var s3 = 0; s3 < rules.length; s3++) { setSeq(rules[s3]); rr.push(rules[s3] + "=" + S().mode); }
      out.push("Prules=" + encodeURIComponent(rr.join(" ")));
      /* **建議更好的基字**（第 111～112 輪）：輸入「初衤禾」→ 建議必須出現「利刂刀」✓
         （兩者的部件序列都是 禾＋刀，但 利 用的是位置形 刂 ✓）。
         第 112 輪起：**最佳的那個與現在的形並排**（#sugStage ＋ #sugCap），
         其餘的放庫存區（#sugRow，拼形式只在 hover hint ✓）。 */
      setSeq("初衤禾");
      var sugStage = document.getElementById("sugStage");
      var sugCapEl = document.getElementById("sugCap");
      var sugWrapEl = document.getElementById("sugWrap");
      var sugStock = document.getElementById("stockSuggest");
      out.push("PsugStage=" + encodeURIComponent(sugStage ? sugStage.getAttribute("data-sug") : "MISSING"));
      out.push("PsugCap=" + encodeURIComponent(sugCapEl ? sugCapEl.textContent : "MISSING"));
      out.push("PsugWrapShown=" + (sugWrapEl ? String(!sugWrapEl.hidden) : "MISSING"));
      /* ⚠ 只看 hidden 屬性不夠 ✗：作者樣式的 display 會蓋掉 display:none——
         要看**算出來的 display**（第 112 輪實測踩到：屬性 true 但畫面上是一個空框 ✗）。 */
      out.push("PsugWrapDisp=" + (sugWrapEl ? getComputedStyle(sugWrapEl).display : "MISSING"));
      out.push("PsugStagePaths=" + (sugStage ? sugStage.querySelectorAll("svg path").length : -1));
      /* 只有一個建議時，庫存區那一段要收起來（不重複顯示 ✓） */
      out.push("PsugStock1=" + (sugStock ? String(sugStock.hidden) : "MISSING"));
      /* 點並排的那個＝換基字 ✓ */
      if (sugStage) sugStage.click();
      out.push("PsugClick=" + encodeURIComponent(seqEl().value + " mode=" + S().mode));
      /* **多個推薦**的實例（第 112 輪）：「婁女女」（女→女，相容字符、形狀幾乎一樣 ✓）→
         其餘的要在庫存區 ✓。
         ⚠ 探針也是樣板字串，不可以用反引號 ✗（同一個坑踩四次了，一律用「」）。
         ⚠ 測試字串的三個字**都要在字庫裡**（「⺣」「⺾」這種部首補充區的碼位沒有字形 ✗）。
         ⚠ **原本用「唐广廣」，但師父指出那組候選全部墨疊一塊 ✗**——現在會被「能不能看」
           那道閘擋掉（那正是我們要的 ✓），所以改用不會疊墨的實例 ✓。 */
      setSeq("婁女女");
      var sugStock2 = document.getElementById("stockSuggest");
      var sugRow2 = document.getElementById("sugRow");
      var cells2 = sugRow2 ? sugRow2.querySelectorAll(".cell") : [];
      var tip0 = cells2.length ? cells2[0].getAttribute("title") : "";
      out.push("PsugMulti=" + (sugStock2 ? String(!sugStock2.hidden) : "MISSING") + "," + cells2.length +
        ",tip=" + encodeURIComponent(tip0));
      if (cells2.length) cells2[0].click();
      out.push("PsugMultiClick=" + encodeURIComponent(seqEl().value + " mode=" + S().mode));
      /* 沒有更好的基字時兩處都要收起來（不吵客人 ✓）——**看算出來的 display** ✓ */
      setSeq("秧央角");
      var w2 = document.getElementById("sugWrap"), s2 = document.getElementById("stockSuggest");
      out.push("PsugNone=" + (w2 && s2
        ? String(w2.hidden) + "," + String(s2.hidden)
        : "MISSING"));
      out.push("PsugNoneDisp=" + (w2 && s2
        ? getComputedStyle(w2).display + "," + getComputedStyle(s2).display
        : "MISSING"));
      /* **師父指出的「墨都搞一塊」**（第 112 輪）：
         ① 「庚广廣」要**警告客人** ✗（實測遮蓋率 38%），而且不要給建議
         ② 「庚广厂」可行 ✓ → **不該**警告
         ③ 「唐广廣」的候選**全部**疊墨 ✗ → 要說清楚「為什麼沒有建議」✓ */
      setSeq("庚广廣");
      out.push("PblobMsg=" + encodeURIComponent(document.getElementById("msg").textContent));
      var bw = document.getElementById("sugWrap"), bs = document.getElementById("stockSuggest");
      out.push("PblobSug=" + (bw && bs ? String(bw.hidden) + "," + String(bs.hidden) : "MISSING"));
      setSeq("庚广厂");
      out.push("PblobOk=" + encodeURIComponent(document.getElementById("msg").textContent));
      setSeq("唐广廣");
      out.push("PblobAll=" + encodeURIComponent(document.getElementById("msg").textContent));
      /* ★ 師父第 119 輪的架構：「客人會先用 BMP 輸入（拼音把罕用字排後面、很多字客人不會念），
         **但系統明白客人的意圖之後，可以建議 extension 的字呀，兩者並不衝突無須取捨。**」
         → 所以「完全相同的序列」這種最強的建議，**非 BMP 也要給** ✓（那是點一下就能用的 ✓）。
         測例：「江工鳥」→ 目標是「氵＋鳥」，字庫裡就有「𩾯」（非 BMP ✓）。
         ⚠ 探針是樣板字串，註解不可以用反引號 ✗（這個坑我還在踩 ✓，靠 check-syntax 抓 ✓）。 */
      setSeq("江工鳥");
      var nbStage = document.getElementById("sugStage");
      var nbData = nbStage ? (nbStage.getAttribute("data-sug") || "") : "MISSING";
      var nbCap = document.getElementById("sugCap");
      var isNonBmp = Array.from(nbData).some(function (c) { return c.codePointAt(0) > 0xffff; });
      out.push("PnonBmp=" + (nbStage ? encodeURIComponent(nbData) + ",nonBmp=" + isNonBmp : "MISSING"));
      out.push("PnonBmpCap=" + encodeURIComponent(nbCap ? nbCap.textContent : ""));
      /* ★ 師父第 122 輪：**輸入區要接受 Unicode IDS（U+2FF0–2FFF）** ✓ →
         有的話**推薦更好的拼形序** ✓；而且兩個常見合文的 IDS 要放在**庫存區** ✓（一點就看到 ✓）。 */
      /* ★ 第 126 輪起：IDS 只給**文字推薦** ✓（美形留到點下去才出現 ✓），
         所以推薦序要從「#sugRow .seqchip」讀 ✓，不再是並排那格 ✓。 */
      setSeq("⿰木⿳金⿰水火土");
      var idsChips = document.querySelectorAll("#sugRow .seqchip");
      var idsTop = idsChips.length ? (idsChips[0].getAttribute("data-sug") || "") : "MISSING";
      /* ★ 直接看「引擎在迴路裡的多步貪婪」算出什麼 ✓（診斷用 ✓） */
      try {
        var lv = window.ladderForIds ? window.ladderForIds("⿰木⿳金⿰水火土", 5) : null;
        out.push("Plive五行=" + encodeURIComponent(lv ? (lv.seq + "｜步" + lv.nSteps + "｜覆蓋" + lv.cover.toFixed(3)) : "null"));
        var lv2 = window.ladderForIds ? window.ladderForIds("⿳𦥯⿰女孔皿", 5) : null;
        out.push("Plive孔孟=" + encodeURIComponent(lv2 ? (lv2.seq + "｜步" + lv2.nSteps + "｜覆蓋" + lv2.cover.toFixed(3)) : "null"));
      } catch (eLv) { out.push("Plive五行=" + encodeURIComponent("例外 " + eLv.message)); }
      out.push("PidsParts=" + document.querySelectorAll("#seqChips .mini.comp").length);
      out.push("Pids=" + encodeURIComponent(idsTop) + ",mode=" + S().mode +
        ",stageHidden=" + String(!!document.getElementById("sugStage").hidden) +
        ",cap=" + encodeURIComponent((document.getElementById("sugCap") || {}).textContent || ""));
      out.push("PidsNote=" + encodeURIComponent(document.getElementById("bigNote").textContent));
      /* ★ 師父 2026-10-16：「構字式（IDS）」改為「**表意描述序**」✓——
         標籤與下面那行「人話轉寫」的開頭都要跟著改 ✓（同一個東西兩個名字＝客人會以為是兩件事 ✗）。 */
      out.push("PidsLbl=" + encodeURIComponent(document.getElementById("seqlbl").textContent));
      if (idsChips.length) idsChips[0].click();
      out.push("PidsClick=" + encodeURIComponent(seqEl().value + " mode=" + S().mode));
      var idRows = document.querySelectorAll("#stock .stockrow.ids");
      out.push("PidsStock=" + idRows.length + "," +
        encodeURIComponent(Array.prototype.map.call(idRows, function (r) { return r.getAttribute("data-ids"); }).join(" ")));
      /* ★ 師父第 136 輪：**魔術棒 🪄**（在「存起來」左邊 ✓）——
         有建議的拼形序時才出現 ✓；點一下＝把下一個建議填進輸入區 ✓（不把序寫在畫面上 ✓）。
         ⚠ 先重貼一次 IDS：上面那一列 chip 已經被點過（輸入區變成拼形序了），
           要回到「剛貼 IDS」的狀態才量得到魔杖本身 ✓。 */
      setSeq("⿰木⿳金⿰水火土");
      var wandEl = document.getElementById("wand");
      out.push("Pwand=" + (wandEl ? "yes" : "MISSING") +
        ",text=" + encodeURIComponent(wandEl ? wandEl.textContent : "") +
        ",hidden=" + (wandEl ? String(!!wandEl.hidden) : "?") +
        ",disp=" + (wandEl ? getComputedStyle(wandEl).display : "?") +
        ",before=" + (wandEl && wandEl.nextElementSibling ? wandEl.nextElementSibling.id : "?") +
        ",n=" + (window.WAND ? window.WAND.seqs.length : -1) +
        ",first=" + encodeURIComponent(window.WAND && window.WAND.seqs.length ? window.WAND.seqs[0] : ""));
      if (wandEl) wandEl.click();
      out.push("PwandClick=" + encodeURIComponent(seqEl().value + " mode=" + S().mode +
        " hidden=" + String(!!wandEl.hidden) +
        " disp=" + getComputedStyle(wandEl).display +
        " bigPaths=" + document.querySelectorAll("#big svg path").length));
      var wandV1 = seqEl().value;
      if (wandEl) wandEl.click();
      out.push("PwandClick2=" + encodeURIComponent((seqEl().value === wandV1 ? "same:" : "next:") + seqEl().value));
      /* ★ 沒有推薦構字序時要**隱藏** ✓（師父 2026-10-15 的指示）——
         全部建議都看過了就收起 ✓；還有多個沒看過才留著可再點 ✓（⿰木垚 有 4 個 ✓）。 */
      setSeq("⿰木垚");
      out.push("PwandMulti=hidden=" + (wandEl ? String(!!wandEl.hidden) : "MISSING") +
        ",disp=" + (wandEl ? getComputedStyle(wandEl).display : "?") +
        ",n=" + (window.WAND ? window.WAND.seqs.length : -1));
      if (wandEl) wandEl.click();
      var wandM1 = seqEl().value;
      out.push("PwandMulti1=" + encodeURIComponent(wandM1 + " hidden=" + String(!!wandEl.hidden) +
        " disp=" + getComputedStyle(wandEl).display));
      if (wandEl) wandEl.click();
      out.push("PwandMulti2=" + encodeURIComponent((seqEl().value === wandM1 ? "same:" : "next:") + seqEl().value +
        " hidden=" + String(!!wandEl.hidden) + " disp=" + getComputedStyle(wandEl).display));
      setSeq("⿳𦥯⿰女孔皿");
      var idsChips2 = document.querySelectorAll("#sugRow .seqchip");
      out.push("Pids2=" + encodeURIComponent(idsChips2.length ? (idsChips2[0].getAttribute("data-sug") || "") : "MISSING") +
        ",mode=" + S().mode);
      /* ★ 第 123 輪（師父的願景 ✓）：貼一個**真的對應到某個字**的表意描述序，要**立刻畫出來** ✓——
         用字庫的「comp」（葉序 ✓）反查 ✓，不必新增資料 ✓。 */
      setSeq("⿰女子");
      out.push("PidsChar=" + encodeURIComponent(document.getElementById("bigNote").textContent) + ",mode=" + S().mode +
        ",cap=" + encodeURIComponent((document.getElementById("sugCap") || {}).textContent || ""));
      setSeq("⿰木木");
      out.push("PidsChar2=" + encodeURIComponent(document.getElementById("bigNote").textContent) +
        ",cap=" + encodeURIComponent((document.getElementById("sugCap") || {}).textContent || ""));
      /* ★ 第 124 輪（師父的三個要求 ✓）：
         ① 「拆成 IDS」按鈕 ✓（客人不會打 IDC ✓）
         ② IDS 的組字**故意按 IDC 等比分配**（醜 ✓），右邊並排拼形序（美 ✓）
         ③ 拼形序那格可點、點下**取代 IDS** ✓（用 124 那條已有的點擊斷言驗 ✓） */
      setSeq("好");
      var wandI = document.getElementById("wand");
      out.push("PwandIdle=" + (wandI ? String(!!wandI.hidden) : "MISSING") +
        ",disp=" + (wandI ? getComputedStyle(wandI).display : "?"));
      var toIdsBtn = document.getElementById("toIds");
      out.push("PtoIdsBtn=" + (toIdsBtn ? "yes" : "MISSING"));
      if (toIdsBtn) toIdsBtn.click();
      out.push("PtoIds=" + encodeURIComponent(seqEl().value + ",mode=" + S().mode));
      out.push("PtoIdsNote=" + encodeURIComponent(document.getElementById("bigNote").textContent));
      out.push("PtoIdsPaths=" + document.querySelectorAll("#big svg path").length);
      setSeq("⿰木⿳金⿰水火土");
      out.push("Pnaive=" + document.querySelectorAll("#big svg path").length +
        "|" + encodeURIComponent(document.getElementById("sugCap").textContent));
      /* ★ 第 125 輪：**任意 IDS 都要能建議拼形序** ✓——師父的例子「⿰木垚」→「桂圭垚」✓ */
      setSeq("⿰木垚");
      var lStage = document.getElementById("sugStage");
      var lCap = document.getElementById("sugCap");
      var lChips = document.querySelectorAll("#sugRow .seqchip");
      out.push("Pladder=" + (lStage ? encodeURIComponent(lStage.getAttribute("data-sug") || "") : "MISSING") +
        ",stageHidden=" + (lStage ? String(!!lStage.hidden) : "?") +
        ",stageSvg=" + (lStage ? lStage.querySelectorAll("svg").length : "-1") +
        ",cap=" + encodeURIComponent(lCap ? lCap.textContent : "") +
        ",chips=" + lChips.length + "," +
        encodeURIComponent(Array.prototype.map.call(lChips, function (c) { return c.getAttribute("data-sug"); }).join("|")));
      if (lChips.length) lChips[0].click();
      out.push("PchipsClick=" + encodeURIComponent(seqEl().value + ",mode=" + S().mode +
        ",bigPaths=" + document.querySelectorAll("#big svg path").length));
    },
    /* --- ★ 2026-10-16：**手機的版面**（師父回報的兩件事 ✓）---
       ① 大字裡的每一層要**跟著「.stage」**（不是寫死 200 ✗）：把 #big 改成 150 量一次 ✓
       ② 大字與部件清單**不可以重疊** ✓：硬把整列縮到 300px（＝窄手機的處境 ✓），
          部件清單要整塊換到下一行、兩塊矩形不相交 ✓
       ③ 微信那條路（沒有 DecompressionStream ✓）：純 JS 的解壓要解得開同一包字庫 ✓
       ⚠ 探針是樣板字串，留言裡**不可以用反引號** ✗、也不可以出現錢字號加左大括號 ✗。 */
    function () {
      setSeq("邏羅寶貝");
      var bigEl = document.getElementById("big");
      var w0 = bigEl.style.width, h0 = bigEl.style.height;
      bigEl.style.width = "150px"; bigEl.style.height = "150px";
      var layerBase = bigEl.clientWidth;
      var sels = ["#big > svg", "#big .boxlayer", "#big .hllayer"], got = [];
      for (var i = 0; i < sels.length; i++) {
        var e = document.querySelector(sels[i]);
        got.push(e ? Math.round(e.getBoundingClientRect().width) : -1);
      }
      bigEl.style.width = w0; bigEl.style.height = h0;
      /* 三層都要**等於大字自己的內容寬**（＝跟著大字走 ✓；不是寫死的 200 ✗）。
         大字的框線是 1px、又是 border-box ✓，所以內容寬會少 2px ✓。 */
      out.push("Xlayer150=" + got.join(",") +
        " XlayerFit=" + (got[0] === layerBase && got[1] === layerBase && got[2] === layerBase ? 1 : 0) +
        " Xstage150=" + layerBase);
      var sw = document.querySelector(".stagewrap");
      var w1 = sw.style.width;
      sw.style.width = "300px";
      var bR = bigEl.getBoundingClientRect(), sR = document.querySelector(".side").getBoundingClientRect();
      var ovw = Math.min(bR.right, sR.right) - Math.max(bR.left, sR.left);
      var ovh = Math.min(bR.bottom, sR.bottom) - Math.max(bR.top, sR.top);
      out.push("Xrow300=" + Math.round(ovw > 0 && ovh > 0 ? ovw * ovh : 0) +
        " Xbelow=" + (sR.top >= bR.bottom - 1 ? 1 : 0) +
        " XbigW=" + Math.round(bR.width) + " XsideW=" + Math.round(sR.width));
      sw.style.width = w1;
      var saved = window.DecompressionStream;
      try {
        window.DecompressionStream = undefined;
        var L = decodeLibrary(inflateGzip(b64ToBytes(LIB_B64)));
        out.push("Xpure=" + L.glyphs.length);
      } catch (e2) { out.push("Xpure=ERR:" + e2.message); }
      window.DecompressionStream = saved;
      setSeq("");
    },
    /* --- ★ 2026-10-16：**候選字照 Unicode 分區上色**（師父：「配色同 glyph-browser.html」✓）---
       ① 12 個區塊的調色盤逐個問一次 ✓（含一個落在區外的碼位＝中性灰 ✓）
       ② 候選格真的**帶著自己那一格的顏色** ✓（「--bc」＋ 算出來的 color／fill ✓）
       ⚠ 探針是樣板字串，留言裡不可以用反引號 ✗。 */
    function () {
      var probeCps = [0x4E00, 0x3400, 0x20000, 0x2A700, 0x2B740, 0x2B820, 0x2CEB0,
                      0x30000, 0x31350, 0x2EBF0, 0xF900, 0x2F800, 0x0041];
      var pal = [];
      for (var p = 0; p < probeCps.length; p++) {
        pal.push(probeCps[p].toString(16).toUpperCase() + "=" + colorOfCp(probeCps[p]));
      }
      out.push("Xpalette=" + encodeURIComponent(pal.join(" ")));
      setSeq("進辶");                       /* 1,131 個候選，橫跨 Ext A／BMP／Ext B ✓ */
      /* ⚠ 前 96 個（預設只看 96 格）**全部落在同一區** ✗——照碼位排序時前面都是 Ext A ✓，
         只看那 96 格會驗不出「跨區不同色」✗。所以這裡把候選全部畫出來 ✓
         （跟本檔前面「點候選裡的邏」那一步用同一個做法 ✓），再抽樣比對 ✓。 */
      candShown = SEARCH.cps.length;
      renderSearch();
      var cells = document.querySelectorAll("#cands .cell.cand");
      var pairs = [], seen = {};
      for (var i = 0; i < cells.length; i++) {
        seen[(cells[i].style.getPropertyValue("--bc") || "").trim()] = 1;
        if (i % 10) continue;
        var cp = Number(cells[i].getAttribute("data-cp"));
        var bc = (cells[i].style.getPropertyValue("--bc") || "").trim();
        var gEl = cells[i].querySelector(".g");
        var pathEl = cells[i].querySelector("svg path");
        var gCol = gEl ? getComputedStyle(gEl).color : "";
        var fill = pathEl ? getComputedStyle(pathEl).fill : "";
        var bd = getComputedStyle(cells[i]).borderTopColor;
        pairs.push(cp + ":" + bc + ":" + gCol + ":" + fill + ":" + bd);
      }
      out.push("XcandN=" + document.querySelectorAll("#cands .cell").length);
      out.push("XcandColors=" + Object.keys(seen).length);
      /* ★ 2026-10-16：碼位**左下角**的小標（所屬區 ✓）——每 25 格抽一格，記下「碼位:小標」✓；
         再單獨把第一個有標的格子的**算出來的樣式**帶出來 ✓（字體／粗細／顏色／淡化 ✓）。 */
      var marks = [], markStyle = "";
      for (var m = 0; m < cells.length; m += 25) {
        var mk = cells[m].querySelector(".c .blkmark");
        var cLine = cells[m].querySelector(".c");
        marks.push(Number(cells[m].getAttribute("data-cp")) + ":" + (mk ? mk.textContent : "-"));
        if (!markStyle && mk) {
          var ms = getComputedStyle(mk);
          markStyle = Number(cells[m].getAttribute("data-cp")) + "|" + ms.fontFamily + "|" + ms.fontWeight +
            "|" + ms.fontSize + "|" + ms.color + "|" +
            cells[m].style.getPropertyValue("--bc").trim() + "|" + getComputedStyle(cLine).opacity;
        }
      }
      out.push("XcandMarks=" + encodeURIComponent(marks.join(" ")));
      out.push("XmarkStyle=" + encodeURIComponent(markStyle));
      /* ⚠ 每一格用「|」接起來，**不要用空白** ✗：算出來的 fill 在 Chrome 是
         「rgb(255, 115, 115)」**帶空白** ✓，用空白分隔會被切成一堆碎片 ✗（踩過 ✓）。 */
      out.push("XcandPairs=" + encodeURIComponent(pairs.join("|")));
      setSeq("");
    },
    /* --- ★ 2026-10-16（師父）：「**部件檢字狀態時，要顯示運算子的用法**
       （滑鼠 hover 到「部件檢字」 popup 用法）」✓ --- */
    function () {
      var lbl = document.getElementById("seqlbl");
      var help = document.getElementById("lblHelp");
      function hover() { lbl.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false })); }
      /* ① 部件檢字（進辶）→ 滑過去要彈出來 ✓，而且**不推動版面** ✓ */
      setSeq("進辶");
      var y0 = document.getElementById("big").getBoundingClientRect().top;
      hover();
      var y1 = document.getElementById("big").getBoundingClientRect().top;
      out.push("HlblFind=" + encodeURIComponent(lbl.textContent));
      out.push("Hshown=" + (help && help.classList.contains("on") ? 1 : 0));
      out.push("Hdisp=" + (help ? getComputedStyle(help).display : "?"));
      out.push("Hpos=" + (help ? getComputedStyle(help).position : "?"));
      out.push("Hshift=" + Math.round(Math.abs(y1 - y0)));
      out.push("Htext=" + encodeURIComponent(help ? help.textContent.replace(/\s+/g, " ").trim() : ""));
      /* ② 換到**拼形序**（浮層還開著 ✓）→ 內容要**當場換成專利那一句** ✓
         ★ 師父 2026-10-16：「最下方『拼形序依據 中国发明专利 201610984608.1 号』
           移到上方『構形序』的 hover 說明」✓ */
      setSeq("邏羅寶");
      out.push("HafterCompose=" + (help && help.classList.contains("on") ? 1 : 0));
      out.push("HafterText=" + encodeURIComponent(help ? help.textContent.replace(/\s+/g, " ").trim() : ""));
      out.push("HlblCompose=" + encodeURIComponent(lbl.textContent));
      /* ③ 空白（頁名「剎那拼形」）滑過去也要看得到那一句 ✓（搬上來之後才找得到 ✓） */
      setSeq("");
      hover();
      out.push("Hempty=" + (help && help.classList.contains("on") ? 1 : 0));
      out.push("HemptyText=" + encodeURIComponent(help ? help.textContent.replace(/\s+/g, " ").trim() : ""));
      out.push("HlblEmpty=" + encodeURIComponent(lbl.textContent));
      /* 頁尾（授權宣告）：那一句搬走之後**不該還在** ✓（其餘照舊 ✓） */
      out.push("Hfoot=" + encodeURIComponent(
        (document.querySelector("footer.credits") || {}).textContent.replace(/\s+/g, " ").trim()));
      /* ④ 「U+908F」那條說明要**真的有用** ✓（以前這一頁沒接 ✗） */
      setSeq("U+908F");
      var st = S();
      out.push("Hcp=" + st.candCount + "/" + encodeURIComponent(st.candTerm) + "/" +
        encodeURIComponent((document.getElementById("candNote").textContent || "").slice(0, 18)));
      setSeq("");
    },
    /* --- ★ 2026-10-16（師父）：表意描述序的 hover、IDC 描述符、紅字警示、🧩 --- */
    function () {
      var lbl = document.getElementById("seqlbl");
      var help = document.getElementById("lblHelp");
      function hover() { lbl.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false })); }
      /* ① 表意描述序的 hover 說明＝**「使用下方的描述符」** ✓——不可以是檢字運算子那幾條 ✗ */
      setSeq("⿰木木");
      hover();
      out.push("IidsLbl=" + encodeURIComponent(lbl.textContent));
      out.push("IidsMode=" + (lbl.getAttribute("data-mode") || ""));
      out.push("IidsHelp=" + encodeURIComponent(help ? help.textContent.trim() : ""));
      out.push("IidsHelpIsOps=" + (help && /木\+|口口|4木日/.test(help.textContent) ? 1 : 0));
      out.push("IidsPaths=" + document.querySelectorAll("#big svg path").length);
      /* ② IDC 描述符排：12 顆、標籤是**人話**、點一下插進游標位置 ✓ */
      var idcs = document.querySelectorAll("#idcRow .idc");
      out.push("IidcN=" + idcs.length);
      out.push("IidcTexts=" + encodeURIComponent(Array.prototype.map.call(idcs, function (b) {
        return b.textContent; }).join(",")));
      out.push("IidcTitle=" + encodeURIComponent(idcs[0] ? idcs[0].getAttribute("title") : ""));
      setSeq("⿰木");
      var s2 = seqEl();
      try { s2.setSelectionRange(2, 2); } catch (eSel) { }
      if (idcs[3]) idcs[3].click();                       /* 第 4 顆＝⿳ ✓ */
      out.push("IidcClick=" + encodeURIComponent(s2.value));
      /* ③ 不合法 → **紅色警示** ✓（缺少部件／多出部件／最開頭必為描述符 ✓） */
      function badI(tag, v) {
        setSeq(v);
        var ph = document.querySelector("#big .ph");
        var msg = document.getElementById("msg");
        /* ⚠ className 也要編碼 ✗：「toast on err」有空白 ✓，不編碼的話探針的
           「空白分隔欄位」會在空白處被切斷 ✓（實測就是這樣誤判成「沒有 err」✗）。 */
        out.push("I" + tag + "=" + encodeURIComponent(ph ? ph.textContent.slice(0, 30) : "") + "|" +
          encodeURIComponent(ph ? ph.className : "") + "|" + encodeURIComponent(msg ? msg.className : "") + "|" +
          encodeURIComponent(msg ? msg.textContent.slice(0, 22) : ""));
      }
      badI("miss", "⿰木");
      badI("extra", "⿰木水土");
      badI("start", "木⿰水土");
      /* ④ 筆劃粗細 ↔ IDC：**同一個位置**，看模式給哪一個 ✓
         （師父：「IDC 按鈕占用筆劃大小那一位置（其他模式顯示筆劃大小）」✓） */
      out.push("Iwscale=" + (document.getElementById("wscaleWrap").hidden ? 1 : 0) + "/" +
        getComputedStyle(document.getElementById("wscaleWrap")).display +
        "/" + (document.getElementById("idcRow").hidden ? 1 : 0) + "/" +
        getComputedStyle(document.getElementById("idcRow")).display);
      setSeq("邏羅寶");
      out.push("Iwscale2=" + (document.getElementById("wscaleWrap").hidden ? 1 : 0) + "/" +
        getComputedStyle(document.getElementById("wscaleWrap")).display + "/" +
        (document.getElementById("idcRow").hidden ? 1 : 0) + "/" +
        getComputedStyle(document.getElementById("idcRow")).display);
      /* ④b 大字右下角的「Unicode 區位 ＋ 碼位」✓（有碼位才顯示 ✓） */
      function cpInfo(tag) {
        var el = document.querySelector("#big .cpinfo");
        out.push(tag + "=" + (el ? encodeURIComponent(el.textContent) : "none") + "/" +
          (el ? getComputedStyle(el).fontSize + "/" + getComputedStyle(el).position : "-"));
      }
      setSeq("邏");        /* 真的字（U+908F）→ 要顯示 ✓ */
      cpInfo("IcpReal");
      setSeq("⿰木木");     /* 表意描述序組出來的形（沒有碼位）→ 不顯示 ✓ */
      cpInfo("IcpMade");
      setSeq("邏羅寶");     /* **拼形序**組出來的形 → 也不顯示 ✓（它改寫基字，碼位會是基字的 ✗） */
      cpInfo("IcpSeq");
      setSeq("學");        /* 也是真的字（U+5B78）✓ */
      cpInfo("IcpOne");
      /* ⑤ 🧩＝「拆成 IDS」：與魔杖同一列、在它左邊、tooltip、出現時機 ✓ */
      var tz = document.getElementById("toIds");
      out.push("Ipuzzle=" + (tz ? encodeURIComponent(tz.textContent) + "|" + encodeURIComponent(tz.title) +
        "|" + (tz.parentElement ? tz.parentElement.className : "?") +
        "|" + (tz.nextElementSibling ? tz.nextElementSibling.id : "?") : "MISSING"));
      setSeq("邏羅寶");
      out.push("IpuzzleSeq=" + (tz.hidden ? 0 : 1));
      setSeq("一");                       /* 單個**獨體**字 → 不出現 ✓ */
      out.push("IpuzzleAtom=" + (tz.hidden ? 0 : 1));
      setSeq("學");                       /* 單個**非獨體**字 → 出現 ✓ */
      out.push("IpuzzleOne=" + (tz.hidden ? 0 : 1));
      setSeq("");
      out.push("IpuzzleEmpty=" + (tz.hidden ? 0 : 1));
    },
    /* --- ★ 2026-10-16（師父）：滑過某一塊 → **其他的要被覆蓋不可見** ✓ --- */
    function () {
      setSeq("邏羅寶");
      var big = document.getElementById("big");
      var gly = big.querySelector("svg.gly");
      function iso(tag) {
        out.push(tag + "=" + (big.classList.contains("iso") ? 1 : 0) + "/" +
          (gly ? getComputedStyle(gly).opacity : "?") + "/" +
          document.querySelectorAll("#big .hllayer path").length + "/" +
          document.querySelectorAll("#big .cbox").length);
      }
      iso("IsoBefore");
      var chip = document.querySelector("#seqChips .mini.comp[data-box]");
      out.push("IsoChip=" + (chip ? chip.getAttribute("data-box") : "MISSING"));
      if (chip) chip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      iso("IsoOn");
      var wrap = document.getElementById("seqChips");
      wrap.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
      iso("IsoOff");
      setSeq("");
    },
    /* --- ★ 2026-10-16（師父）：**像素層**驗收：高亮的墨必須落在字形本身的墨裡面 ✓ ---
       為什麼要這一條（踩過 ✓）：框（componentBoxes）、inkOfPathInRoot()、
       svgOfPathInRoot() **三個來源互相一致**，卻**都與字形本身不一致** ✗——
       師父抓到「機幾墨黒𨩛星炚日水」滑過 土 時「土變高」✓（實測高亮 49.7% 的墨
       在字形裡根本沒有 ✓）。原因：drawingIdx() 會穿過「只有一筆引用」的**包裝**，
       卻把那一層的**框**（縮放＋位移）丟掉 ✓ → 落點少一層 ✓。
       ⚠ 這一步是**非同步**的（要等 SVG 光柵化 ✓），結果放進 window.__PIX__，
         由最後一步讀 ✓（中間隔了十幾個步驟、時間夠 ✓）。 */
    function () {
      function raster(svg) {
        return new Promise(function (res) {
          var img = new Image();
          img.onload = function () {
            var c = document.createElement("canvas");
            c.width = 200; c.height = 200;
            var g2 = c.getContext("2d");
            /* ⚠ 一定要自己指定大小 ✓：viewBox 而沒有 width/height 的 SVG，
               瀏覽器給的預設尺寸是 300×150 ✗，drawImage 會再拉一次 ✓（兩張都歪就白比了 ✓） */
            g2.drawImage(img, 0, 0, 200, 200);
            res(g2.getImageData(0, 0, 200, 200).data);
          };
          img.onerror = function () { res(null); };
          img.src = "data:image/svg+xml;charset=utf-8," +
            encodeURIComponent(svg.replace(/<svg\b/, '<svg width="200" height="200"'));
        });
      }
      setSeq("機幾墨黒𨩛星炚日水");
      var L = MAIN ? MAIN.lib : null;
      if (!L) { window.__PIX__ = "nomain"; return; }
      var boxes = currentBoxes() || [], tu = null;
      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].ref !== undefined && codePointOf(L, boxes[i].ref) === 0x571f) { tu = boxes[i]; break; }
      }
      if (!tu || !tu.path || !tu.path.length) { window.__PIX__ = "nobox"; return; }
      var hl = null, whole = null;
      try { hl = svgOfPathInRoot(L, MAIN.idx, tu.path); whole = mainSvg(); } catch (e) { }
      if (!hl || !whole) { window.__PIX__ = "nosvg"; return; }
      Promise.all([raster(whole), raster(hl)]).then(function (r) {
        if (!r[0] || !r[1]) { window.__PIX__ = "noraster"; return; }
        var A = r[0], H = r[1], n = 0, miss = 0;
        for (var k = 0; k < 200 * 200; k++) {
          if ((H[k * 4 + 3] || 0) < 128) continue;      /* 高亮沒墨的像素不算 ✓ */
          n++;
          if ((A[k * 4 + 3] || 0) < 128) miss++;
        }
        window.__PIX__ = n + "/" + miss + "/" + (n ? Math.round(1000 * miss / n) / 10 : -1);
      });
    },
    /* --- ★ 2026-10-16：**留下一組已知的狀態**，下一次開頁要自己還原 ✓
       （師父：「輸入區的文字存進 localStorage，客人不必每次重新輸入 ✓；
        字框顯示、中間部件、筆劃粗細也都存 ✓」）。
       這一步之後本檔會**用同一個 user-data-dir 再開一次頁** ✓＝「客人關掉再打開」✓。 --- */
    function () {
      setSeq("邏羅寶");                              /* 輸入區的文字 → localStorage ✓ */
      var w = document.getElementById("wscale");
      w.value = "150";
      w.dispatchEvent(new Event("input"));           /* 筆劃粗細 150 ✓ */
      var b = document.getElementById("boxMode");
      if (b.getAttribute("data-mode") === "none") b.click();     /* 字框：顯示 ✓ */
      var mid = document.getElementById("showMid");
      if (mid && !mid.checked) { mid.checked = true; mid.dispatchEvent(new Event("change")); }
      out.push("Zseq=" + encodeURIComponent(document.getElementById("seq").value));
      out.push("ZlsSeq=" + encodeURIComponent(localStorage.getItem("pinxing.seq") || ""));
      out.push("ZlsW=" + encodeURIComponent(localStorage.getItem("pinxing.wscale") || ""));
      out.push("ZlsBox=" + encodeURIComponent(localStorage.getItem("pinxing.boxmode") || ""));
      out.push("ZlsMid=" + encodeURIComponent(localStorage.getItem("pinxing.showmid") || ""));
      out.push("ZwLbl=" + encodeURIComponent(document.getElementById("wscaleV").textContent));
    },
    function () {
      out.push("Ipix=" + (window.__PIX__ || "pending"));   /* ★ 像素驗收的結果（非同步 ✓） */
      out.push("done=1");
      report(out.join(" "));
    }
  ];
  var qi = 0;
  function start() {
    var tick = setInterval(function () {
      if (qi >= q.length) { clearInterval(tick); return; }
      try { q[qi++](); } catch (e) { out.push("STEP" + qi + "EXC:" + e.message); }
    }, 400);
  }
  var tries = 200;
  var boot = setInterval(function () {
    if (window.__READY__ || --tries <= 0) {
      clearInterval(boot);
      /* 探針要同步斷言（headless 的 --dump-dom 不等 microtask）：
         設了這個旗標，頁面的重畫就當場發生。 */
      window.__SYNC__ = true;
      start();
    }
  }, 100);
})();
<\/script>`;

  const diagPath = resolve(D, "out/_pinxing-probe.html");
  const shotPath = resolve(D, "out/pinxing-shot.png");
  writeFileSync(diagPath, html.replace("</body>", probe + "</body>"));
  const STEP_COUNT = (probe.match(/^    function \(\) \{/gm) || []).length;

  /* ★ 2026-10-16：**用一個乾淨的設定檔目錄**（`--user-data-dir`）✓——
     這一頁現在會把「輸入區的文字／字框／中間部件／筆劃粗細」記在 localStorage ✓，
     用預設的 profile 會讓**上一次跑完留下的狀態**變成下一次的起始狀態 ✗
     （起始斷言就會飄 ✓，而且會動到使用者自己的瀏覽器設定 ✗）。
     同一個目錄**連續跑兩次**＝「客人關掉再打開」✓（見本段後面的第二次實跑 ✓）。 */
  const profile = mkdtempSync(join(tmpdir(), "pinxing-check-"));

  const proc = Bun.spawnSync([
    EDGE, "--headless=new", "--disable-gpu", "--user-data-dir=" + profile,
    "--virtual-time-budget=240000",   /* ⚠ 步驟多了會撞到預算 ✓（撞到＝探針沒有回報、整段驗收空轉 ✓） */
    "--window-size=460,1500", "--screenshot=" + shotPath,
    "--dump-dom", "file:///" + diagPath.replace(/\\/g, "/"),
  ], { stdout: "pipe", stderr: "ignore" });
  const dom = new TextDecoder().decode(proc.stdout);
  const m = /<title>PROBE\|([^<]*)<\/title>/.exec(dom);
  if (!m) bad("瀏覽器沒有回報結果（title 找不到 PROBE）");
  else {
    const r = m[1]!;
    const num = (k: string) => Number(new RegExp("(?:^| )" + k + "=(-?[\\d.]+)").exec(r)?.[1] ?? "NaN");
    const txt = (k: string) => {
      const mm = new RegExp("(?:^| )" + k + "=([^ ]*)").exec(r);
      if (!mm) return "";
      try { return decodeURIComponent(mm[1]!); } catch { return mm[1]!; }
    };
    const snap = (k: string) => {
      try { return JSON.parse(txt(k) || "{}"); } catch { return {} as any; }
    };
    /STEP\d+EXC/.test(r) ? bad("有步驟丟例外：" + (/STEP\d+EXC:[^ ]*/.exec(r) || [""])[0])
                         : ok(`${STEP_COUNT} 個步驟都沒有丟例外`);
    num("loadError") === 0 ? ok("頁面初始化沒有失敗（body 沒有「載入失敗」）")
                           : bad(`初始化失敗：${txt("loadErrMsg") || txt("bodyHead")}`);
    num("glyphs") === 191727 ? ok(`字庫在瀏覽器裡解碼成功（${num("glyphs").toLocaleString()} 字形）`)
                             : bad(`字形數 ${num("glyphs")}`);
    num("decodeMs") < 3000 ? ok(`解碼 ${num("decodeMs")} ms`) : bad(`解碼 ${num("decodeMs")} ms 太慢`);

    // 版面（規格：手機豎版、大字 200×200）
    num("canvasW") === 200 && num("canvasH") === 200
      ? ok("大字是 200×200 的畫布") : bad(`大字畫布 ${num("canvasW")}×${num("canvasH")}`);
    /在上面輸入任何字或拼形式/.test(txt("placeholder")) ? ok("空序列時大字區有提示") : bad("沒有空狀態提示");
    /* ★ 第 122 輪：內建九組 ＋ **兩列 IDS 合文**（師父指定 ✓）＝ 11 列 ✓ */
    num("stockRows") === 11 ? ok("庫存拼形十一組都在（九組內建 ＋ 兩列 IDS 合文 ✓）")
                            : bad(`庫存 ${num("stockRows")} 組（預期 11：九組內建 ＋ 兩組合文）`);
    /剎那拼形/.test(txt("title")) ? ok(`瀏覽視窗 title：${txt("title")}`) : bad(`title 不對：${txt("title")}`);
    num("headerB") === 0 ? ok("頁面上沒有靜態的「剎那拼形」標題（頁名只在輸入區標籤與視窗 title）")
                         : bad("頁面還留著靜態標題");
    txt("headerTxt") === "" || !/字形|解碼|就緒/.test(txt("headerTxt"))
      ? ok(`標題列只有短回饋（目前：${txt("headerTxt") || "（空）"}）`)
      : bad(`標題列不對：${txt("headerTxt")}`);
    txt("lbl") === "剎那拼形" && /brand/.test(txt("lblCls"))
      ? ok("輸入區空白時左邊標籤是「剎那拼形」（醒目色）")
      : bad(`標籤 ${txt("lbl")}／${txt("lblCls")}`);
    /拼形式/.test(txt("ph")) ? ok(`輸入區的提示：${txt("ph")}`) : bad(`placeholder：${txt("ph")}`);    txt("seqBg") !== txt("secBg") ? ok(`輸入區底色與卡片不同（${txt("seqBg")} vs ${txt("secBg")}）`)
                                  : bad("輸入區底色與卡片一樣，看不出要在哪裡打字");
    txt("hasSaveIcon") === "true" ? ok("「存起來」是 svg 圖示且貼在輸入區右邊")
                                  : bad("存檔鈕不是圖示");
    txt("noClear") === "true" ? ok("「清空」按鈕已移除") : bad("還留著清空按鈕");
    txt("topSec") === "true" ? ok("筆劃粗細與字框都在最上面那一張卡（跟輸入區同一張）")
                             : bad("筆劃粗細／字框沒有移到頂部");
    txt("toastPos") === "absolute" && /seqrow/.test(txt("toastInRow"))
      ? ok(`回饋是浮層（${txt("toastPos")}，貼在輸入區下方的 ${txt("toastInRow")}）——不佔高度、不會晃動畫面`)
      : bad(`回饋不是浮層：${txt("toastPos")}／${txt("toastInRow")}`);
    num("toastShift") === 0
      ? ok(`提示出現／消失時，大字與下面各段的 Y 座標完全不動（位移 0px；` +
           `浮層自己高 ${num("toastH")}px 但因為 absolute 不佔排版高度）`)
      : bad(`提示會推動版面：位移 ${num("toastShift")}px`);
    txt("candHidden") === "true" ? ok("沒有候選時整段候選字收起來（版面緊湊）")
                                 : bad("候選區一直顯示著");
    txt("hasSlider") === "true" ? ok("有筆劃粗細控制") : bad("沒有筆劃粗細控制");
    /* ★ 2026-10-16（師父）：「最下方『拼形序依據 中国发明专利 201610984608.1 号』
       移到上方『構形序』的 hover 說明」✓——所以**頁尾不該再有那一句** ✓
       （其餘頁尾照舊：基於開源字庫、微信、開發記錄 ✓）。 */
    (() => {
      const foot = txt("Hfoot").replace(/\s+/g, "");
      !foot.includes("专利") && foot.includes("Glyphwiki+Kage") && foot.includes("wxx68174671") &&
        foot.includes("開發記錄")
        ? ok(`頁尾只剩「${txt("Hfoot").slice(0, 34)}…」——專利那一句已經搬到 hover 說明 ✓`)
        : bad(`頁尾不對：${txt("Hfoot")}`);
    })();
    /* ★ 2026-10-16（師父）：「**缺省不要打開字框顯示**」✓——
       新客人（乾淨的 localStorage）第一次打開＝輸入區空白 ✓、粗細 100 ✓、
       **字框：隱** ✓、中間部件不勾 ✓。 */
    txt("boxMode") === "none" && /字框：隱/.test(txt("boxLabel"))
      ? ok(`字框的初始狀態：${txt("boxLabel")}（data-mode=${txt("boxMode")}）——**預設不顯示** ✓（師父 2026-10-16 ✓）`)
      : bad(`框模式初始 ${txt("boxMode")}／${txt("boxLabel")}（應該預設「字框：隱」✗）`);
    txt("bootSeq") === "" && txt("bootW") === "100" && txt("bootMid") === "false"
      ? ok("新客人第一次打開：輸入區空白 ✓、筆劃 100% ✓、中間部件不勾 ✓")
      : bad(`起始狀態不對：seq=${JSON.stringify(txt("bootSeq"))} w=${txt("bootW")} mid=${txt("bootMid")}`);
    txt("bootLsSeq") === "null" || txt("bootLsSeq") === '""'
      ? ok("乾淨的設定檔目錄（起始沒有任何 localStorage 殘留 ✓）")
      : bad(`起始就有殘留的 localStorage：pinxing.seq=${txt("bootLsSeq")}`);
    /* ★ 2026-10-16（師父）：**手機上大字優先** ✓——
       ① 大字裡的每一層都要跟著 `.stage`（不是寫死 200 ✗）：
          以前 `.stage > svg` 寫死 200px，那條規則在檔案裡比 media query 更後面，
          會蓋掉窄螢幕的縮放 ✗ → 大字溢出自己的框、壓到右邊的部件清單上 ✗。 */
    /* ⚠ `.stage` 有 1px 框線、`box-sizing:border-box` ✓，所以三層的寬會是內容寬（150−2＝148 ✓）；
       這一條驗的是「**三層都等於大字自己的內容寬**」✓（以前是寫死的 200 ✗＝溢出 ✓）。 */
    num("XlayerFit") === 1
      ? ok(`大字裡的每一層（字形／框／塗色層）都跟著「.stage」縮放（${txt("Xlayer150")}` +
           ` ＝ 大字內容寬 ${num("Xstage150")}px ✓；不是寫死的 200）`)
      : bad(`大字的某一層沒有跟著縮放：${txt("Xlayer150")} vs 大字內容寬 ${num("Xstage150")}`);    /* ② 不夠寬時，部件清單要**整塊換到下一行** ✓，而且兩塊矩形不相交 ✓（＝不可能重疊 ✓）。 */
    num("Xrow300") === 0 && num("Xbelow") === 1 && num("XbigW") === 200
      ? ok(`窄版面（整列 300px）部件清單整塊換到下一行、不與大字重疊（重疊 0 px²、` +
           `大字仍是 ${num("XbigW")}px、清單吃滿 ${num("XsideW")}px ✓）`)
      : bad(`窄版面會重疊：重疊 ${num("Xrow300")} px²、換行=${num("Xbelow")}、大字 ${num("XbigW")}px`);
    /* ③ 微信那條路：**沒有 `DecompressionStream` 也要解得開** ✓（頁面自帶純 JS 的 DEFLATE ✓）。 */
    num("Xpure") === 191727
      ? ok("沒有 DecompressionStream 也解得開同一包字庫（純 JS 的 gzip 後備 → 191,727 字形 ✓）")
      : bad(`純 JS 的解壓後備失敗：${txt("Xpure")}`);

    /* ★ 2026-10-16（師父）：「**候選字依 unicode 分區使用不同顏色，配色同 glyph-browser.html**」✓
       ⚠ 驗收自己**重算一次**調色盤（不呼叫頁面的 `colorOfCp` ✗），
          這樣才驗得出「頁面真的照這個公式上色」✓，而不是兩邊一起錯 ✓。 */
    const HUE_STEP = 30, SAT = 0.55, VAL = 1.0;
    const NEUTRAL = "rgb(146,152,162)";
    const hsvCss = (h: number, s: number, v: number): string => {
      h = ((h % 360) + 360) % 360;
      const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
      let r = 0, g = 0, b = 0;
      if (h < 60) { r = c; g = x; }
      else if (h < 120) { r = x; g = c; }
      else if (h < 180) { g = c; b = x; }
      else if (h < 240) { g = x; b = c; }
      else if (h < 300) { r = x; b = c; }
      else { r = c; b = x; }
      return `rgb(${Math.round((r + m) * 255)},${Math.round((g + m) * 255)},${Math.round((b + m) * 255)})`;
    };
    /* 區塊的**順序**就是色相順序 ✓（BMP、A、B…相容補＝索引 × 30° ✓） */
    const RANGES: [number, number][] = [
      [0x4E00, 0x9FFF], [0x3400, 0x4DBF], [0x20000, 0x2A6DF], [0x2A700, 0x2B73F],
      [0x2B740, 0x2B81F], [0x2B820, 0x2CEAF], [0x2CEB0, 0x2EBEF], [0x30000, 0x3134F],
      [0x31350, 0x323AF], [0x2EBF0, 0x2EE5F], [0xF900, 0xFAFF], [0x2F800, 0x2FA1F],
    ];
    const wantBc = (cp: number): string => {
      const bi = RANGES.findIndex(([a, b]) => cp >= a && cp <= b);
      return bi < 0 ? NEUTRAL : hsvCss(bi * HUE_STEP, SAT, VAL);
    };
    const pal = txt("Xpalette").split(" ").filter((s) => s.includes("="));
    const palBad = pal.filter((kv) => {
      const [h, got] = kv.split("=");
      return got !== wantBc(parseInt(h!, 16));
    });
    pal.length === 13 && palBad.length === 0
      ? ok(`12 個區塊的色相＝索引 × 30°（BMP ${wantBc(0x4E00)}、Ext B ${wantBc(0x20000)}、` +
           `相容補 ${wantBc(0x2F800)}），區外的碼位給中性灰 ${NEUTRAL} ✓`)
      : bad(`調色盤不對：${palBad.join("／") || `只問到 ${pal.length} 個碼位`}`);
    /* 候選格：`--bc` 要是自己那一區的顏色 ✓，字形（color）與 path 的 fill 也要跟著 ✓，
       邊框也要染同一色（不是預設的 --line ✓）。 */
    const pairs = txt("XcandPairs").split("|").filter((s) => s.includes(":"));
    let wrongBc = 0, wrongInk = 0, wrongBorder = 0;
    for (const p of pairs) {
      const [cp, bc, gCol, fill, border] = p.split(":");
      const want = wantBc(Number(cp));
      if (bc !== want) wrongBc++;
      /* Chrome 算出來的顏色帶空白（「rgb(255, 115, 115)」✓），比對前先去掉 ✓ */
      const norm = (s: string | undefined) => (s || "").replace(/\s+/g, "");
      if (norm(gCol) !== norm(want) || norm(fill) !== norm(want)) wrongInk++;
      if (norm(border) === "rgb(42,46,53)" || !border) wrongBorder++;   /* --line＝#2a2e35 ✗ */
    }
    pairs.length >= 50 && wrongBc === 0 && wrongInk === 0 && wrongBorder === 0
      ? ok(`${pairs.length} 格候選字都帶著自己那一區的顏色（--bc／字形／fill／邊框一致 ✓、` +
           `共 ${num("XcandColors")} 種顏色）`)
      : bad(`候選字上色不對：${pairs.length} 格、色錯了 ${wrongBc}、字形沒跟上 ${wrongInk}、` +
            `邊框還是預設色 ${wrongBorder}`);
    num("XcandColors") >= 2
      ? ok(`候選清單裡真的出現多個區塊的顏色（${num("XcandColors")} 種 ✓）——一眼看得出跨區`)
      : bad(`候選字只有 ${num("XcandColors")} 種顏色（應該跨 BMP／Ext A／Ext B ✓）`);

    /* ★ 2026-10-16（師父）：「**BMP 要排在 Ext A 前面**」✓——
       ⚠ 單按碼位排會**剛好相反** ✗（Ext A 從 U+3400 起、BMP 從 U+4E00 起 ✓），
         客人就會先看到罕用字 ✗。所以要**照 BLOCKS 的順序**排 ✓（BMP → Ext A → … → 相容補 ✓）。
       驗收自己算一次區塊序 ✓（不是讀頁面的 `blockIndexOf` ✗），抽樣整串驗「不會往回跳」✓。 */
    {
      const ordOf = (cp: number): number => {
        const bi = RANGES.findIndex(([a, b]) => cp >= a && cp <= b);
        return bi < 0 ? RANGES.length : bi;
      };
      const cps = pairs.map((p) => Number(p.split(":")[0]));
      const back = cps.filter((cp, i) => i > 0 && ordOf(cp) < ordOf(cps[i - 1]!));
      const first = cps[0] ?? 0;
      cps.length >= 50 && first >= 0x4e00 && first <= 0x9fff && back.length === 0
        ? ok(`候選字照**區塊順序**排：第一格是 BMP U+${first.toString(16).toUpperCase()} ✓、` +
             `抽樣 ${cps.length} 格的區塊序沒有往回跳 ✓——BMP 排在 Ext A 前面 ✓`)
        : bad(`候選排序不對：第一格 U+${first.toString(16).toUpperCase()}、` +
              `區塊序往回跳 ${back.length} 次`);
    }

    /* ★ 2026-10-16（師父）：「**輸入區的文字存進 localStorage** ✓，客人不必每次重新輸入 ✓；
       字框顯示、中間部件、筆劃粗細**也都存** ✓」——四個鍵一起驗 ✓。
       值由上面的「留一組已知狀態」那一步寫入 ✓，還原由本段後面的**第二次開頁**驗 ✓。 */
    txt("Zseq") === "邏羅寶" && txt("ZlsSeq") === "邏羅寶"
      ? ok("輸入區的文字當場寫進 localStorage（pinxing.seq＝「邏羅寶」✓）")
      : bad(`輸入區沒有存起來：seq=${JSON.stringify(txt("Zseq"))} ls=${JSON.stringify(txt("ZlsSeq"))}`);
    txt("ZlsW") === "150" && txt("ZwLbl") === "150%"
      ? ok("筆劃粗細也存了（pinxing.wscale＝150 ✓、標籤同步 ✓）")
      : bad(`筆劃粗細沒有存：${txt("ZlsW")}／${txt("ZwLbl")}`);
    txt("ZlsBox") === "tight"
      ? ok("字框顯示的狀態也存了（pinxing.boxmode＝tight ✓）")
      : bad(`字框狀態沒有存：${txt("ZlsBox")}`);
    txt("ZlsMid") === "1"
      ? ok("中間部件也存了（pinxing.showmid＝1 ✓）")
      : bad(`中間部件沒有存：${txt("ZlsMid")}`);

    /* ★ 2026-10-16（師父）：「**部件檢字狀態時，要顯示運算子的用法**
       （滑鼠 hover 到「部件檢字」 popup 用法）」✓ */
    txt("HlblFind") === "部件檢字" && num("Hshown") === 1 && txt("Hdisp") === "block"
      ? ok(`滑過「${txt("HlblFind")}」→ 彈出運算子用法（display=${txt("Hdisp")} ✓）`)
      : bad(`滑過部件檢字沒有 popup：${txt("HlblFind")}／shown=${num("Hshown")}／disp=${txt("Hdisp")}`);
    {
      const help = txt("Htext");
      const need = ["木+", "木在左", "+木", "木在右", "木/", "木在上", "/木", "木在下",
                    "口木", "口口", "4木日", "4", "U+908F"];
      const miss = need.filter((s) => !help.includes(s));
      miss.length === 0
        ? ok(`說明裡有全部運算子（${help.slice(0, 46)}…✓）`)
        : bad(`說明少寫了：${miss.join("／")}（實際：${help.slice(0, 60)}）`);
    }
    txt("Hpos") === "absolute" && num("Hshift") === 0
      ? ok("浮層是 absolute：彈出時**版面完全不動**（位移 0px ✓）")
      : bad(`浮層會推動版面：position=${txt("Hpos")}／位移 ${num("Hshift")}px`);
    /* ★ 2026-10-16（師父）：「最下方『**拼形序依據 中国发明专利 201610984608.1 号**』
       移到上方『構形序』的 hover 說明」✓——拼形序與空白（頁名）兩個狀態都要看得到 ✓，
       而且**字一字不改** ✓（跟原本頁尾那一句逐字相同 ✓）。 */
    const PATENT = "拼形序依據 中国发明专利 201610984608.1 号";
    txt("HlblCompose") === "拼形序" && txt("HafterCompose") === "1" && txt("HafterText") === PATENT
      ? ok(`「${txt("HlblCompose")}」的 hover 說明＝「${txt("HafterText")}」✓（從頁尾搬上來的原句 ✓）`)
      : bad(`拼形序的 hover 說明不對：標籤「${txt("HlblCompose")}」／` +
            `shown=${txt("HafterCompose")}／「${txt("HafterText")}」`);
    txt("HlblEmpty") === "剎那拼形" && num("Hempty") === 1 && txt("HemptyText") === PATENT
      ? ok(`頁名「${txt("HlblEmpty")}」（還沒輸入）滑過去也看得到那一句 ✓——搬上來之後才找得到 ✓`)
      : bad(`空白狀態的 hover 說明不對：${txt("HlblEmpty")}／shown=${num("Hempty")}／` +
            `「${txt("HemptyText")}」`);
    num("Hcp") > 0 && /邏/.test(txt("Hcp"))
      ? ok(`說明裡的 U+908F 真的有用（${txt("Hcp")}）——以前這一頁沒接 ✓`)
      : bad(`U+908F 沒有作用：${txt("Hcp")}`);

    /* ★ 2026-10-16（師父）：「**輸入區是「表意描述序」時，不應顯示「部件檢字」的說明。
       顯示「使用下方的 描述符」**」✓ */
    txt("IidsLbl") === "表意描述序" && txt("IidsMode") === "ids"
      ? ok(`表意描述序的狀態：標籤「${txt("IidsLbl")}」✓（data-mode=${txt("IidsMode")}）`)
      : bad(`表意描述序的標籤／狀態不對：${txt("IidsLbl")}／${txt("IidsMode")}`);
    txt("IidsHelp") === "使用下方的描述符" && num("IidsHelpIsOps") === 0 && num("IidsPaths") > 0
      ? ok(`它的 hover 說明＝「${txt("IidsHelp")}」✓（**不是**檢字運算子那幾條 ✓），而且字照樣畫得出來（${num("IidsPaths")} 條路徑 ✓）`)
      : bad(`表意描述序的 hover 說明不對：「${txt("IidsHelp")}」／含運算子=${num("IidsHelpIsOps")}`);
    /* ★ 2026-10-16（師父）：「**IDC 按鈕改用 IDC 字符來顯示，「左右」「上下」改為 hover hint**」
       ＋「**占用筆劃大小那一位置（其他模式顯示筆劃大小）**」✓ */
    txt("IidcN") === "12" || num("IidcN") === 12
      ? ok(`IDC 描述符 12 顆（${txt("IidcTexts")}）✓`)
      : bad(`IDC 排的顆數不對：${num("IidcN")}`);
    txt("IidcTexts") === "⿰,⿱,⿲,⿳,⿴,⿵,⿶,⿷,⿸,⿹,⿺,⿻" && /左右/.test(txt("IidcTitle")) &&
      /U\+2FF0/.test(txt("IidcTitle"))
      ? ok(`按鈕上是**描述符本身**（${txt("IidcTexts")} ✓）、人話與碼位在 hover hint（${txt("IidcTitle")} ✓）`)
      : bad(`IDC 按鈕的字不對：${txt("IidcTexts")}／tooltip ${txt("IidcTitle")}`);
    {
      const idsRow = txt("Iwscale").split("/");
      const otherRow = txt("Iwscale2").split("/");
      idsRow[0] === "1" && idsRow[1] === "none" && idsRow[2] === "0" && idsRow[3] !== "none" &&
      otherRow[0] === "0" && otherRow[1] !== "none" && otherRow[2] === "1" && otherRow[3] === "none"
        ? ok("IDC 與筆劃粗細**同一個位置**：表意描述序給 IDC（筆劃收起 ✓）、其他模式給筆劃（IDC 收起 ✓）")
        : bad(`那一列的切換不對：ids ${txt("Iwscale")}／其他 ${txt("Iwscale2")}`);
    }
    /* ★ 2026-10-16（師父）：「**如果大字是 Unicode 有收的字**，在**右下方**顯示 Unicode 區位及
       codepoint（字體大小可以和「中間部件」一樣大）」✓ */
    {
      const real = txt("IcpReal").split("/");
      const made = txt("IcpMade");
      const seqMade = txt("IcpSeq");
      const one = txt("IcpOne").split("/");
      /^BMP／?\s?U\+908F$|^BMP\s*U\+908F$/.test(real[0]!.replace(/\u3000/g, " ")) &&
      real[1] === "12px" && real[2] === "absolute" && /^none/.test(made) && /^none/.test(seqMade) &&
      /U\+5B78/.test(one[0]!)
        ? ok(`大字右下角顯示「${real[0]}」✓（12px ＝「中間部件」的字級 ✓、absolute 疊在角上 ✓）；` +
             `組出來的形（無碼位）不顯示 ✓`)
        : bad(`右下角的碼位標籤不對：真字 ${JSON.stringify(real)}（原字串 ${JSON.stringify(txt("IcpReal"))}）／` +
              `組出來的 ${JSON.stringify(made)}／拼形 ${JSON.stringify(seqMade)}／單字 ${JSON.stringify(one)}`);
    }
    txt("IidcClick") === "⿰木⿳"
      ? ok(`點描述符＝插進游標位置（${txt("IidcClick")} ✓）`)
      : bad(`描述符沒插進去：${txt("IidcClick")}`);
    /* ★ 2026-10-16（師父）：「**如果輸入的是不合法的 IDS，紅色警示**，錯誤包括：
       缺少部件、多出部件、最開頭必為描述符」✓（紅字**留在畫面上** ✓，不是只有 3 秒的浮層 ✓） */
    {
      const rows = [["miss", "缺少部件"], ["extra", "多出部件"], ["start", "最開頭必須是描述符"]] as const;
      const wrong: string[] = [];
      for (const [tag, want] of rows) {
        const f = txt("I" + tag).split("|");
        const msg = f[0] ?? "";
        const cls = f[1] ?? "";
        const tcls = f[2] ?? "";
        if (!msg.includes(want) || !cls.includes("err") || !tcls.includes("err")) {
          wrong.push(`${tag}=${msg}／${cls}／${tcls}`);
        }
      }
      wrong.length === 0
        ? ok("三種寫法問題都給**紅色警示**（缺少部件／多出部件／最開頭必為描述符 ✓：" +
             "大字裡的紅字會留著 ✓＋浮層也是 err 色 ✓）")
        : bad(`紅色警示不對：${wrong.join("、")}`);
    }
    /* ★ 2026-10-16（師父）：「**「拆成 IDS」功能與「魔杖」放在同一位置。用「🧩」這個圖示。
       hover 時說明「將字拆分成IDS」**」✓＋「**只應在輸入單個非獨體字時出現**」✓ */
    {
      const f = txt("Ipuzzle").split("|");
      const [txt0, title, parent, next] = f;
      txt0 === "🧩" && title === "將字拆分成IDS" && /seqrow/.test(parent || "") && next === "wand"
        ? ok(`🧩 與魔杖同一列、在它左邊（parent=${parent}、next=${next}）✓、title＝「${title}」✓`)
        : bad(`🧩 的位置或 tooltip 不對：${txt("Ipuzzle")}`);
      num("IpuzzleSeq") === 0 && num("IpuzzleAtom") === 0 && num("IpuzzleOne") === 1 && num("IpuzzleEmpty") === 0
        ? ok("🧩 只在**單個非獨體字**時出現（「學」出現 ✓；「邏羅寶」「一」「空白」都收起 ✓）")
        : bad(`🧩 的出現時機不對：多字=${num("IpuzzleSeq")}、獨體=${num("IpuzzleAtom")}、` +
              `單字=${num("IpuzzleOne")}、空白=${num("IpuzzleEmpty")}`);
    }
    /* ★ 2026-10-16（師父）：**拼形序的巢狀部件，高亮必須落在字形真正畫的地方** ✓——
       這一條用**像素**驗（框與量測三個來源會一起錯 ✗，抓不出來 ✓）。
       修好前：26,040 點裡有 12,876 點（49.7%）落在字形外面 ✗；修好後 3.2%（抗鋸齒邊緣 ✓）。 */
    {
      const f = txt("Ipix").split("/");
      const n = Number(f[0]), miss = Number(f[1]), pct = Number(f[2]);
      n > 1000 && miss >= 0 && pct >= 0 && pct <= 8
        ? ok(`高亮（土）畫了 ${n} 點，只有 ${pct}% 落在字形外面 ✓（那幾點就是抗鋸齒邊緣 ✓）`)
        : bad(`高亮的墨跑到字形外面了：${txt("Ipix")}（修好前是 49.7% ✗）`);
    }
    /* ★ 2026-10-16（師父）：「hover 到某一塊時，**其他的應該被覆蓋不可見**」✓——
       滑過去：主字形那一層 `opacity:0` ✓、那一塊的筆劃畫出來 ✓、框留著（位置地圖 ✓）；
       滑出去：主字形回來 ✓、那一塊的染色清掉 ✓。 */
    {
      const on = txt("IsoOn").split("/");
      const off = txt("IsoOff").split("/");
      const before = txt("IsoBefore").split("/");
      on[0] === "1" && on[1] === "0" && Number(on[2]) > 0
        ? ok(`滑過部件（第 ${txt("IsoChip")} 格）：主字形 opacity=${on[1]}（被蓋住 ✓）、` +
             `那一塊畫了 ${on[2]} 條筆劃 ✓、框還留著 ${on[3]} 個 ✓`)
        : bad(`滑過部件沒有蓋掉其他部分：${txt("IsoOn")}`);
      off[0] === "0" && off[1] === "1" && off[2] === "0" && before[0] === "0" && before[1] === "1"
        ? ok("滑出去就還原（主字形回來 ✓、染色清掉 ✓、平常不會蓋 ✓）")
        : bad(`滑出後沒有還原：前 ${txt("IsoBefore")}／後 ${txt("IsoOff")}`);
    }

    /* ★ 2026-10-16（師父）：「每個字 Unicode 的左下角…**Extension 區都加一個醒目小英文字母**
       （有顏色粗體，Arial），標明其所屬區」✓，**基本區 2 萬字除外** ✓
       （相容區照師父 2026-10-16 的裁定標「相」「補」✓——**不給 J／K** ✗，Unicode 已經有 Ext J ✓）。
       ⚠ 期望值在驗收裡**自己寫一份**（不是讀頁面的 `BLOCKS` ✓），才驗得出頁面真的照規則標 ✓。 */
    const MARK_OF_BLOCK = ["", "A", "B", "C", "D", "E", "F", "G", "H", "I", "相", "補"];
    const wantMark = (cp: number): string => {
      const bi = RANGES.findIndex(([a, b]) => cp >= a && cp <= b);
      return bi < 0 ? "" : MARK_OF_BLOCK[bi]!;
    };
    const marks = txt("XcandMarks").split(" ").filter((s) => s.includes(":"));
    const markBad = marks.filter((p) => {
      const [cp, got] = p.split(":");
      const want = wantMark(Number(cp));
      return (got === "-" ? "" : got) !== want;
    });
    const nBmp = marks.filter((p) => wantMark(Number(p.split(":")[0]!)) === "").length;
    const nExt = marks.length - nBmp;
    marks.length >= 40 && markBad.length === 0 && nBmp > 0 && nExt > 0
      ? ok(`${marks.length} 格抽樣：小標都對（基本區 ${nBmp} 格**不標** ✓、` +
           `Extension／相容區 ${nExt} 格標了 A..I／相／補 ✓）`)
      : bad(`左下角小標不對：${markBad.slice(0, 5).join("／") || `抽到 ${marks.length} 格`}` +
            `（基本區 ${nBmp}、其他 ${nExt}）`);
    {
      const [cp, fam, weight, size, col, bc, lineOp] = txt("XmarkStyle").split("|");
      const want = wantBc(Number(cp));
      /Arial/i.test(fam || "") && Number(weight) >= 700 && parseFloat(size || "0") >= 10 &&
        (col || "").replace(/\s+/g, "") === want && (bc || "") === want && lineOp === "1"
        ? ok(`小標是**粗體 Arial**（${fam}／${weight}／${size}）、顏色＝那一區的顏色（${want}）✓、` +
             `碼位那一行沒有整體淡化（opacity ${lineOp} ✓，淡化搬到內層的 .cp ✓）`)
        : bad(`小標樣式不對：${txt("XmarkStyle")}`);
    }

    // ---- 步驟 1：輸入「進」
    const A = snap("A");
    A.seq === "進" && A.mode === "ok" && A.boxes === 2
      ? ok(`① 輸入「進」：畫出基字、大字上 1 個部件框（部件序列 ${A.chips} 格）`)
      : bad(`① 進 的狀態不對：${JSON.stringify(A)}`);

    // ---- 步驟 2：點「辶」→ 進辶 ＋ 列出含辶的字
    const B = snap("B");
    txt("Bchip") === "true" ? ok("② 點部件序列的「辶」") : bad("② 找不到「辶」那一格");
    B.seq === "進辶" ? ok(`② 輸入區變成「進辶」（規格原文的這一步）`) : bad(`② 輸入區是「${B.seq}」`);
    B.mode === "search" ? ok("② 不是合法拼形序列 → 當成部件搜尋（規格第 7 條）")
                        : bad(`② 模式是 ${B.mode}`);
    B.cands > 1000 ? ok(`② 列出含「${txt("Bterm")}」的字：${B.cands.toLocaleString()} 個`)
                   : bad(`② 候選只有 ${B.cands} 個（相容異體沒綁在一起？）`);
    txt("BhasLuo") === "true" ? ok("② 候選裡有「邏」") : bad("② 候選裡沒有「邏」");
    /辶/.test(txt("Bchips")) ? ok(`② 部件序列顯示的是「${txt("Bchips")}」——不是相容碼位 辶`)
                             : bad(`② 部件序列顯示 ${txt("Bchips")}（使用者看不懂）`);

    // ---- 步驟 3：點候選裡的「邏」
    const C = snap("C");
    txt("Cclick") === "true" && C.seq === "邏" && txt("Cbase") === "908f"
      ? ok("③ 點候選的「邏」→ 選為基字（U+908F）")
      : bad(`③ 選基字失敗：click=${txt("Cclick")} seq=${C.seq} base=${txt("Cbase")}`);

    // ---- 步驟 4：點「羅」→ 邏羅
    const Dd = snap("D");
    txt("Dchip") === "true" && Dd.seq === "邏羅" && Dd.mode === "partial"
      ? ok(`④ 點部件序列的「羅」→「邏羅」（等替換內容）`)
      : bad(`④ 狀態不對：chip=${txt("Dchip")} ${JSON.stringify(Dd)}`);

    // ---- 步驟 5：輸入「寶」→ 邏羅寶
    const E = snap("E");
    E.seq === "邏羅寶" && E.mode === "ok" && num("Epaths") > 0
      ? ok(`⑤ 輸入「寶」→ 組出字形（${num("Epaths")} 條筆畫路徑，大字上 ${E.boxes} 個部件框）`)
      : bad(`⑤ 邏羅寶 沒有組出來：${JSON.stringify(E)} paths=${num("Epaths")}`);
    /* ★ 2026-10-16（師父）：「合理拼形」→「構形序」→「**拼形序**」✓（與項目 pinxing 統一 ✓） */
    txt("Elbl") === "拼形序"
      ? ok(`拼形序的標籤＝「${txt("Elbl")}」✓（舊說法「合理拼形」已經不在了 ✓）`)
      : bad(`標籤不對：${txt("Elbl")}（應該是「拼形序」✗）`);
    /邏 的 羅/.test(txt("Elog") || E.msg) ? ok(`⑤ 引擎的說明：${E.msg}`) : bad(`⑤ 沒有替換說明：${E.msg}`);
    /* 標題只寫「部件清單」（使用者的要求）；要知道**是哪個字**的清單就看部件格：
       這裡的題目是 邏羅寶，游標在最後 → 應該列 寶 的部件（𡩧 貝 缶 𡪓） */
    /* ★ 師父 2026-10-15：拼形結果的部件清單＝**最終組字用到的部件** ✓（不是 owner 的內部 ✗） */
    num("EchipsN") === 2 && /U\+8FB6|U\+5BF6/.test(txt("EchipTips"))
      ? ok(`⑤ 拼形結果的部件清單＝最終用到的部件（${num("EchipsN")} 格：辶 寶 ✓；owner 仍算得出 ${txt("Eowner")}）`)
      : bad(`⑤ 拼形結果的部件清單不對：${num("EchipsN")} 格／${txt("EchipTips")}`);
    /點一下＝用它替換|部件清單/.test(E.cap) ? ok(`⑤ 部件清單的標題：${E.cap}`)
                                           : bad(`⑤ 標題不對：${E.cap}`);
    /* 拼形結果的部件清單是**看得到、不能換**的格子（沒有 data-ch ✓）——用提示文字驗 ✓ */
    /U\+8FB6|U\+5BF6/.test(txt("EchipTips"))
      ? ok(`⑤ 拼形結果的部件清單：${txt("EchipTips")}`)
      : bad(`⑤ 拼形結果的部件清單看不出東西：${txt("EchipTips")}`);

    // ---- 大字的框：顯示／隱藏、中間部件、點框連動
    num("Fboxes") > 0 ? ok(`大字上畫了 ${num("Fboxes")} 個部件框（data-box=${txt("FboxData")}）`) : bad("大字上沒有框");
    /* ★ 2026-10-16：走到這一步時字框**還是預設的「隱」** ✓（前面幾個步驟都沒動它 ✓）——
       框層仍然在（`ghost` ✓，所以 `Fboxes` 數得到 ✓），只是看不見 ✓；
       驗完這一行，探針才把它打開、接著驗兩態切換 ✓。 */
    txt("FmidHas") === "yes" && txt("FshowM") === "none" && /字框：隱/.test(txt("FshowT"))
      ? ok(`字框簡化成**兩態**（進來時是預設的「${txt("FshowT")}」✓）＋ 有「中間部件」勾選框 ✓`)
      : bad(`字框鈕／勾選框不對：${txt("FshowM")}／${txt("FshowT")}／${txt("FmidHas")}`);
    num("FdeepN") > num("FshowN") && num("FdeepS") > 0
      ? ok(`勾「中間部件」→ 多出孫框（${num("FshowN")} → ${num("FdeepN")} 個框，其中孫框 ${num("FdeepS")} 個 ✓）`)
      : bad(`中間部件沒有多出孫框：${num("FshowN")} → ${num("FdeepN")}（sub ${num("FdeepS")}）`);
    num("FmidOff") === num("FshowN")
      ? ok(`取消「中間部件」→ 回到只看最終組字用到的部件（${num("FmidOff")} 個框 ✓）`)
      : bad(`取消中間部件後框數不對：${num("FmidOff")} vs ${num("FshowN")}`);
    txt("FnoneM") === "none" && txt("FnoneG") === "yes" && num("FnoneP") > 0 && /字框：隱/.test(txt("FnoneT"))
      ? ok(`字框切到「隱」：框看不見（ghost ✓）但字形還在（${num("FnoneP")} 條筆畫路徑）`)
      : bad(`「不顯示框」不對：${txt("FnoneM")}／ghost ${txt("FnoneG")}／路徑 ${num("FnoneP")}`);
    txt("FbackM") === "show" && num("FbackN") > 0
      ? ok(`再按一下回到「顯」（兩態循環 ✓）`) : bad(`兩態循環壞了：${txt("FbackM")}／${num("FbackN")}`);
    num("FactiveBox") > 0 && num("FactiveChip") > 0
      ? ok(`點框 → 框與部件序列互相亮起（框 ${num("FactiveBox")} 個、清單 ${num("FactiveChip")} 格）`)
      : bad(`框／清單連動沒生效：框 ${num("FactiveBox")}、清單 ${num("FactiveChip")}` +
            `（clicked=${txt("Fclicked")} EXC=${txt("FEXC")}）`);
    /* ★ 師父 2026-10-15：框色＝HSV 色相漸變、**每次轉 30 度** ✓ */
    /^(30,)*30$/.test(txt("FhueDiffs"))
      ? ok(`框色是 HSV 色相漸變：每格轉 30 度（色相 ${txt("Fhues")} ✓）`)
      : bad(`框色的色相間隔不對：hues=${txt("Fhues")} diffs=${txt("FhueDiffs")}`);
    /* ★ 選中的部件：**筆劃染成框色**（不要白色 ✓） */
    num("FhlPaths") > 0 && txt("FhlFill") === txt("Fbox0c")
      ? ok(`選中的部件筆劃＝框色 ${txt("FhlFill")}（${num("FhlPaths")} 條路徑 ✓、不是白色 ✓）`)
      : bad(`選中的部件沒有染成框色：paths=${num("FhlPaths")} fill=${txt("FhlFill")} box=${txt("Fbox0c")}`);

    // ---- 手畫的部件（寶缶支 的 王）＋ 藏框時仍能塗色
    num("Kchips") === 4 && /U\+738B/.test(txt("Ktips"))
      ? ok(`「寶缶支」不顯示中間部件：4 格（含手畫的 王 U+738B ✓）`)
      : bad(`「寶缶支」的部件清單不對：${num("Kchips")} 格／${txt("Ktips")}`);
    num("Kboxes") === num("Kchips")
      ? ok(`框數＝清單格數（${num("Kboxes")} ✓）`)
      : bad(`框數與清單不合：框 ${num("Kboxes")}／清單 ${num("Kchips")}`);
    txt("Kmode") === "none/4" && txt("Kghost") === "yes"
      ? ok(`藏起字框：框層留著、變成**看不見但吃滑鼠**（ghost ✓，${num("Kboxes")} 格 ✓）`)
      : bad(`藏框的方式不對：mode=${txt("Kmode")} ghost=${txt("Kghost")}`);
    num("KwPaths") > 0 && txt("KwFill") === txt("KwC") && txt("KwC") !== ""
      ? ok(`手畫筆劃的「王」也連動：${num("KwPaths")} 條路徑＝${txt("KwFill")} ✓`)
      : bad(`「王」沒有連動：paths=${num("KwPaths")} fill=${txt("KwFill")} c=${txt("KwC")}`);
    num("KghostPaths") > 0 && num("KghostChip") === 1
      ? ok(`框看不見還是有作用：滑過大字 → 塗色 ${num("KghostPaths")} 條 ＋ 清單那一格亮 ✓`)
      : bad(`看不見的框沒有作用：paths=${num("KghostPaths")} chipHover=${num("KghostChip")}`);
    num("Khl") > 0 && txt("KhFill") === txt("KhBox") && txt("KhBox") !== ""
      ? ok(`藏起字框時，塗色照樣和部件清單連動（${num("Khl")} 條路徑＝${txt("KhFill")} ✓）`)
      : bad(`藏框後塗色失效：mode=${txt("Kmode")} paths=${num("Khl")} fill=${txt("KhFill")} box=${txt("KhBox")}`);
    // ---- 長序列：部件該是「貝」不是「目」
    num("Mchips") === 5 && /U\+8C9D/.test(txt("Mtips")) && !/U\+76EE/.test(txt("Mtips"))
      ? ok(`長序列的部件＝${txt("Mtips")}（含 貝、不含 目 ✓）`)
      : bad(`長序列的部件不對：${num("Mchips")} 格／${txt("Mtips")}`);
    // ---- IDS 模式 ＋ 藏字框：塗色也要連動
    txt("Lmode") === "none/ids/5" && num("Lhl") > 0 && txt("Lfill") === txt("Lbox") && txt("Lbox") !== ""
      ? ok(`IDS 模式藏起字框：塗色照樣連動（${num("Lhl")} 條路徑＝${txt("Lfill")} ✓）`)
      : bad(`IDS 模式藏框後塗色失效：mode=${txt("Lmode")} paths=${num("Lhl")} fill=${txt("Lfill")} box=${txt("Lbox")}`);
    num("Lclick") === num("Lhl")
      ? ok(`IDS 的格子點一下＝選它（塗色留著 ✓）`)
      : bad(`IDS 格子點下去塗色掉了：${num("Lclick")} vs ${num("Lhl")}`);
    // ---- 中間部件：孫框（所有子孫）
    txt("Dmode") === "show" && /字框：顯/.test(txt("Dlabel"))
      ? ok(`字框顯示中（${txt("Dlabel")}）；孫框由「中間部件」決定 ✓`)
      : bad(`字框狀態不對：${txt("Dmode")}／${txt("Dlabel")}`);
    num("Dsub") > 0 && num("Dall") > num("Dtight") && num("DtightSub") === 0
      ? ok(`「邏」勾中間部件：最終 ${num("Dtight")} 個 ＋ 孫 ${num("Dsub")} 個＝${num("Dall")} 個框 ✓`)
      : bad(`孫框數量不對：最終 ${num("Dtight")}（sub ${num("DtightSub")}）→ 孫 ${num("Dall")}（sub ${num("Dsub")}）`);
    num("DsubClickOn") === 1 && num("DsubChipOn") === 1
      ? ok("點孫框 → **框與部件清單互相亮起** ✓（師父 2026-10-15 的要求 ✓）")
      : bad(`點孫框的連動不對：框 ${num("DsubClickOn")} 個、清單 ${num("DsubChipOn")} 格`);
    num("DchipHover") === 1
      ? ok("反向連動：滑過部件清單的格子 → 大字的框也亮 ✓（師父 2026-10-15）")
      : bad(`反向連動不對：亮的框 ${num("DchipHover")} 個`);
    num("Dchips") === num("Dall")
      ? ok(`孫模式的部件清單＝所有子孫（${num("Dchips")} 格＝框數 ${num("Dall")} ✓）`)
      : bad(`孫模式的部件清單格數不對：清單 ${num("Dchips")}／框 ${num("Dall")}`);
    /* ★ 師父第 163 輪（補）：框的提示要給**碼位 ＋ 第幾號異形** ✓，不再是「第 n 個部件」✗ */
    /U\+[0-9A-F]{4,6}/.test(txt("Dtips")) && /第 \d+ 號異形/.test(txt("Dtips")) && !/個部件/.test(txt("Dtips"))
      ? ok(`框的提示＝「碼位 ＋ 第幾號異形」：${txt("Dtips").slice(0, 70)}… ✓`)
      : bad(`框的提示不對（還是舊的「第 n 個部件」？）：${txt("Dtips")}`);
    num("Dback") === num("Dtight")
      ? ok(`取消「中間部件」→ 回到最終組字用到的部件（${num("Dback")} 個框 ✓）`)
      : bad(`取消中間部件後框數不對：${num("Dback")} vs ${num("Dtight")}`);

    // ---- 粗細
    txt("Gchanged") === "true" ? ok(`拉粗細 → 真的重畫（${txt("label")}）`) : bad("拉粗細沒有重畫");
    txt("Gback") === "true" ? ok("拉回 100% 回復原狀") : bad("拉回 100% 沒有回復");

    // ---- 庫存拼形（按鈕顯示組出來的字）
    /* ★ 第 122 輪：內建九組**之後**多了兩列 **IDS 合文** ✓（師父指定 ✓：一點就看到 ✓）——
       所以序列、按鈕數、正方形數都要把這兩列算進來 ✓（刻意放在九組之後 ✗，
       前面插隊會把「第 4 組＝初衤礻」那類位置斷言全部推歪 ✓）。
       ⚠ 合文那兩條序有很多罕用字，**不要手打** ✗（實測打錯一個碼位就失敗 ✓）——
         改成「**前九組與 HSEQ_REAL 相符** ＋ 多出兩列且有 data-ids ✓」，
         序本身由 `PidsStock` 那條驗 ✓。 */
    const HSEQ_REAL = "邏羅寶貝𩀨從䞃致招|初衤礻|颰犮电|峰夆電雨水|髜昇厏乍电|衚胡舞|街圭舞|寶缶支|報土业";
    const hseqs = txt("Hseqs").split("|");
    hseqs.slice(0, 9).join("|") === HSEQ_REAL && hseqs.length === 11 && num("HidsRows") === 2
      ? ok("庫存十一組：前九組原文相符 ✓、後兩組是 IDS 合文 ✓")
      : bad(`庫存序列：前九組${hseqs.slice(0, 9).join("|") === HSEQ_REAL ? "相符 ✓" : "不符 ✗"}、` +
          `共 ${hseqs.length} 組、合文 ${num("HidsRows")} 列`);
    num("HnoGlyph") === 0 ? ok(`十一個按鈕都畫出了組出來的字（大字路徑 ${num("KstockPaths")}）`)
                          : bad(`有 ${num("HnoGlyph")} 個按鈕沒畫出字形`);
    num("Hrefs") === 0 ? ok("沒有任何庫存鈕標「參」（十一組都組得出單一形）")
                       : bad(`標成「參」的有 ${num("Hrefs")} 組（預期 0 組）`);
    num("Hsquare") === 11 ? ok("庫存按鈕是正方形（寬高相等，含兩組合文 ✓）") : bad(`只有 ${num("Hsquare")} 個是正方形`);
    num("HidsRows") === 2 ? ok("庫存區有兩列 **IDS 合文**（帶 data-ids ✓、標「合」✓）")
                          : bad(`IDS 合文列數不對：${num("HidsRows")}`);
    /* ★ 兩張原圖**真的載入**（naturalWidth > 0 ✓）——這一條就是為了第 129 輪那個
       `filter:invert` 的 bug 而加的 ✓（白墨反成黑 ✗ → 看不見 ✗，但 DOM 裡明明有 img ✗）。 */
    /^2,2$/.test(txt("HrawImg"))
      ? ok(`兩張原圖（elements.png／xue.png）**真的載入顯示** ✓（${txt("HrawImg")}＝img 數,已載入數 ✓）`)
      : bad(`原圖沒有正常顯示：HrawImg=${txt("HrawImg")}（期望 2,2 ✓）`);
    num("HseqText") === 0 ? ok("庫存按鈕不顯示拼形式本身（想知道就點一下）")
                          : bad(`還留著 ${num("HseqText")} 個拼形式文字`);
    /* ★ 2026-10-16（師父）：「最重要下方『拼形序依據 …』移到 hover 說明」✓——
       所以頁尾**不再有那一句** ✓（授權文字只剩開源字庫與微信 ✓）。
       ⚠ 使用者指定的文字**一字不改** ✓：只是**搬家**，不是改字 ✓（hover 那一段逐字驗 ✓）。 */
    const CREDIT = "基於開源字庫 Glyphwiki+Kage　·　微信：wxx68174671";
    txt("Hcredit").indexOf(CREDIT) === 0 ? ok(`頁尾授權宣告：${txt("Hcredit").slice(0, 24)}…（專利那句已搬走 ✓）`)
                              : bad(`頁尾授權不對：${txt("Hcredit")}`);
    /* ★ 師父 2026-10-15：授權文字之後要有「開發記錄」連到同資料夾的 gouxingji.html ✓ */
    txt("Hdevlink") === "gouxingji.html|開發記錄"
      ? ok("頁尾有「開發記錄」→ gouxingji.html ✓")
      : bad(`頁尾的「開發記錄」連結不對：${txt("Hdevlink")}`);
    const H = snap("H");
    /^峰/.test(H.seq) ? ok(`點第四組庫存 → 帶進輸入區（${H.seq.length} 個字，${H.mode}）`)
                      : bad(`庫存沒有帶進輸入區：${H.seq}`);

    // ---- 存自己的序列（圖示 ＋ Enter；已存過移到最前面）
    num("Imine") === 1 ? ok("按存檔圖示 → 自己的序列進 localStorage") : bad(`自存序列 ${num("Imine")} 組`);
    /* ★ 師父 2026-10-15：輸入區最右邊那顆按鈕**兩態** ✓（不在庫存＝存檔、在庫存＝垃圾桶 ✓） */
    txt("Idel0") === "false" && txt("Idel1") === "true" && txt("IdelSvg") === "block"
      ? ok("存檔鈕兩態：不在庫存＝**存檔** ✓、存了之後同一顆變**垃圾桶** ✓")
      : bad(`存檔鈕兩態不對：del0=${txt("Idel0")} del1=${txt("Idel1")} svg=${txt("IdelSvg")}`);
    num("ImineDel") === 0 && txt("Idel2") === "false"
      ? ok("再按一下（垃圾桶）→ 從庫存刪除、按鈕變回存檔 ✓")
      : bad(`垃圾桶沒有刪掉：mine=${num("ImineDel")} del=${txt("Idel2")}`);
    num("ImineBack") === 1 && txt("Idel3") === "true"
      ? ok("客人後悔：再按一下 → 又存回來 ✓")
      : bad(`後悔沒有存回來：mine=${num("ImineBack")} del=${txt("Idel3")}`);
    num("ImineDelBtn") === 0 && txt("ImineSq") === "true"
      ? ok("自存的列沒有「刪」小按鈕 → 按鈕保持**正方形** ✓")
      : bad(`自存列還有「刪」按鈕或不是正方形：delBtn=${num("ImineDelBtn")} sq=${txt("ImineSq")}`);
    /初衤礻/.test(txt("Ils")) ? ok("localStorage 裡真的是那串序列") : bad(`localStorage：${txt("Ils")}`);
    /已存起來/.test(txt("Itoast")) ? ok(`標題列回饋：${txt("Itoast")}`) : bad(`沒有回饋：${txt("Itoast")}`);
    /衚胡舞/.test(txt("Ienter")) ? ok(`在輸入區按 Enter 也會存（${txt("Ienter")}）`)
                                 : bad(`Enter 沒有存起來：${txt("Ienter")}`);
    txt("Iagain") === '["初衤礻","衚胡舞"]' && num("Imine2") === 2
      ? ok(`再存一次已存過的序列 → 只留一份且移到最前面（${txt("Iagain")}）`)
      : bad(`重存沒有移到最前面：${txt("Iagain")}（自存 ${num("Imine2")} 組）`);
    /已存起來|已移到最前面/.test(txt("Itoast2")) ? ok(`標題列回饋：${txt("Itoast2")}`) : bad(`Enter 沒有回饋：${txt("Itoast2")}`);
    txt("Iseq") === '""' ? ok("按 Escape → 輸入區清空（清空按鈕已移除）") : bad(`清空後是 ${txt("Iseq")}`);
    num("IcandCells") === 0 ? ok("清空後候選也清掉") : bad(`清空後還有 ${num("IcandCells")} 格候選`);

    // ---- 非法序列 → 部件搜尋
    const J = snap("J"), K = snap("K");
    J.seq === "木" && J.mode === "ok" ? ok("輸入「木」＝合法基字") : bad(`木 的狀態：${JSON.stringify(J)}`);
    K.mode === "search" && K.cands > 0
      ? ok(`輸入「木日」（讀不成序列）→ 當部件搜尋，含「${txt("Kterm")}」的字 ${K.cands} 個`)
      : bad(`木日 沒有走搜尋：${JSON.stringify(K)}`);
    txt("KstockBad") === "" && num("KstockPaths") > 0
      ? ok(`九組庫存全部帶得進輸入區並畫得出來（最後一組 ${txt("KstockLast")}，` +
           `${num("KstockPaths")} 條筆畫路徑）`)
      : bad(`庫存有問題：${txt("KstockBad")} paths=${num("KstockPaths")}`);

    // ---- 部件清單（這一輪修好的：從 只看到彳）
    const CHIPC = txt("chipCases");
    /從=彳\+∅\?/.test(CHIPC)
      ? ok(`從 的部件是「彳 ＋ 一個沒有碼位的部件」——那個部件照樣列出來（看得到才不會以為漏了）`)
      : bad(`從 的部件清單不對：${CHIPC}`);
    /合=亼\+口/.test(CHIPC) && /進=辶\+隹/.test(CHIPC) && /邏=辶\+羅/.test(CHIPC)
      ? ok(`合→亼＋口（新 IDS 來源的拆法）、進→辶＋隹、邏→辶＋羅`)
      : bad(`部件清單不對：${CHIPC}`);
    /* 新 IDS 來源（ids_lv1）：寶 的主要拆法是 ⿱𡩧貝，而 貝 再拆 目＋八 → 攤平後是這四個。 */
    /寶=𡩧\+貝/.test(CHIPC) ? ok(`寶→𡩧＋貝（貝 是獨體象形，不拆成 目＋八）`) : bad(`寶 的部件：${CHIPC}`);
    /颰=風\+犮/.test(CHIPC) && /木=$/.test(CHIPC)
      ? ok(`颰→風＋犮（不會把下一層的 𠘨／丶 也倒出來）、木→（獨體字，空白）`)
      : bad(`颰／木 的部件：${CHIPC}`);
    num("unnamedWithCh") === 0 && num("unnamedCount") > 0
      ? ok("沒有碼位的部件不可點（沒有 data-ch）")
      : bad(`無名部件卻可以點：${num("unnamedWithCh")}／${num("unnamedCount")}`);
    num("unnamedCount") > 0 && /default/.test(txt("unnamedCursor")) && /dashed/.test(txt("unnamedCursor"))
      ? ok(`無名部件：游標 default、框是虛線——看得到但換不掉（${txt("unnamedCursor")}）`)
      : bad(`無名部件外觀不對：${txt("unnamedCursor")}`);

    // ---- 合成字形快取：交替組合時每一步都要正確（A→B→A）
    {
      const a1 = txt("cacheA"), b1 = txt("cacheB"), a2 = txt("cacheA2");
      const c1 = txt("cacheC"), d1 = txt("cacheD"), c2 = txt("cacheC2");
      a1 !== b1 && a1 === a2 && b1 === txt("cacheB2")
        ? ok(`合成字形快取沒有撞鍵（祈斤刀=${a1}、祈斤角=${b1}，切回來 ${a2} 一致）`)
        : bad(`快取撞鍵：A=${a1} B=${b1} A2=${a2} B2=${txt("cacheB2")}`);
      c1 !== d1 && c1 === c2
        ? ok(`初衤礻=${c1}、初衤刀=${d1}，切回來一致（${c2}）`)
        : bad(`初 的快取不對：C=${c1} D=${d1} C2=${c2}`);
      txt("cacheSame") === "true"
        ? ok("同一序列求兩次結果相同（快取可以共用）")
        : bad(`同序列兩次結果不同：${txt("cacheSame")}`);
    }
    {
      const syn = txt("syntax");
      const get = (k: string) => Number(new RegExp(k.replace(/[+/]/g, "\\$&") + "=(\\d+)").exec(syn)?.[1] ?? "NaN");
      const above = get("木/"), below = get("/木"), left = get("木+"), right = get("+木");
      /* glyph-browser 實測（第 109 輪更新：新增「筆形分量」閘——拆到筆劃級的拆法不用 ✓，
         師父的判準是「拆分是為了分類」，見 build-library.ts）：木/=60、/木=359、木+=1906、+木=71 */
      above === 60 && below === 359 && left === 1906 && right === 71
        ? ok(`檢字運算子與 glyph-browser 一致：木/＝${above}、/木＝${below}、木+＝${left}、+木＝${right}`)
        : bad(`運算子結果跟 glyph-browser 對不上：木/=${above} /木=${below} 木+=${left} +木=${right}（${syn}）`);
      get("口口") > 2000 && get("4木日") > 0
        ? ok(`重複部件與筆劃數也通：口口＝${get("口口")}（要出現兩次）、4木日＝${get("4木日")}`)
        : bad(`重複／筆劃數不對：${syn}`);
      /* 說明文字要跟查詢一致（題目是 `木+`） */
      /「木」在左/.test(txt("syntaxNote")) && /\d/.test(txt("syntaxNote"))
        ? ok(`說明文字帶位置與數量：${txt("syntaxNote")}`)
        : bad(`檢字說明不對：${txt("syntaxNote")}`);
      txt("syntaxStockHidden") === "true"
        ? ok("顯示候選字時整張「庫存拼形」收起來（手機畫面有限）")
        : bad("有候選字時庫存拼形還在");
      txt("stockBack") === "true" ? ok("清空後庫存拼形回來") : bad("清空後庫存沒有回來");
      /5523|5525|5587|5657|5811|5765|5764/.test(txt("stockOnSingle"))
        ? ok(`單字「水」也是檢字模式（候選 ${txt("stockOnSingle")}）`)
        : bad(`單字模式不對：${txt("stockOnSingle")}`);
    }
    txt("link1") === "辶" ? ok(`按鈕指向 glyph-browser.html?comp=辶（${txt("txt")}）`)
                          : bad(`連動的 comp 是「${txt("link1")}」`);
    txt("link2") === "寶" ? ok(`拼形序時帶的是最後一個字（comp=寶，＝使用者正在看的那個部件）`)
                          : bad(`拼形序的 comp 是「${txt("link2")}」`);
    txt("link3") === "木" ? ok("單字時帶它自己（comp=木）")
                          : bad(`單字時的 comp 是「${txt("link3")}」`);
    txt("clickUrl") === "glyph-browser.html?comp=%E8%BE%B6" && txt("clickUrlEmpty") === '""'
      ? ok(`按鈕組出的 URL 是 ${txt("clickUrl")}（沒有部件時是空字串，不會亂跳）`)
      : bad(`按鈕的 URL 不對：${txt("clickUrl")}／${txt("clickUrlEmpty")}`);

    // ---- 孫級部件：舊部件在 IDS 構件階層裡時，引擎從筆畫反推槽位原地換
    {
      const L = snap("L"), L2 = snap("L2"), L3 = snap("L3"), M = snap("M"), N = snap("N");
      /不是原地換部件/.test(txt("Lmsg")) && /橫向/.test(txt("Lmsg"))
        ? ok(`「報幸土业」的形狀是橫向串接，回饋明講：${txt("Lmsg")}`)
        : bad(`沒有說「不是原地換部件」：${txt("Lmsg")}`);
      /無碼位/.test(txt("Link")) && /以 U\+5831 為基/.test(txt("Link"))
        ? ok(`合成字形標成無碼位、並寫出基字：${txt("Link")}`)
        : bad(`合成字形的標示不對：${txt("Link")}`);
      /* 「幸土业」：應該組出 ⿱业𢆉（业在上、𢆉在下），不是水平三等分 */
      L2.mode === "ok" && /槽位由 IDS 構件反推/.test(txt("L2msg")) && num("L2paths") > 0
        ? ok(`「幸土业」原地換出 ⿱业𢆉（${num("L2paths")} 條筆畫路徑）：${txt("L2msg")}`)
        : bad(`「幸土业」沒有組出來：mode=${L2.mode}／paths=${num("L2paths")}／${txt("L2msg")}`);
      /* 串接讀法本身要留著：`彳舞亍` 的 舞 不是 彳 的構件，這是官方例子 */
      L3.mode === "ok" && /串接部件 彳舞亍/.test(txt("L3msg"))
        ? ok(`「彳舞亍」仍是一串部件（沒被槽位推斷影響）：${txt("L3msg")}`)
        : bad(`「彳舞亍」被擋掉了：mode=${L3.mode}／${txt("L3msg")}`);
      /* 「報土业」：同一個機制在樹的深處（報→幸→土） */
      M.mode === "ok" && /槽位由 IDS 構件反推/.test(txt("Mmsg")) && num("Mpaths") > 0
        ? ok(`「報土业」穿過三層（報→幸→土）原地換出來（${num("Mpaths")} 條路徑）：${txt("Mmsg")}`)
        : bad(`「報土业」沒有組出來：mode=${M.mode}／paths=${num("Mpaths")}／${txt("Mmsg")}`);
      /* fork 出來的庫裡，被改寫的那個索引還帶著基字碼位（實測 5831）——
         所以畫面上**不能**直接印那個碼位，要標成無碼位 */
      txt("Ncp") === "5831" && /無碼位/.test(txt("Nink")) && !/^U\+5831$/.test(txt("Nink"))
        ? ok(`合成字形不借用基字碼位（引擎查得到 U+5831，畫面標成「${txt("Nink")}」）`)
        : bad(`合成字形被標成基字碼位：cp=${txt("Ncp")}／${txt("Nink")}`);
    }

    // ---- 回報的兩個症狀（見探針的最後一步）
    {
      /* ① 深層替換要走得進快取：四個都不一樣，而且切回 業／日 要一致
         （舊的簽章四個會一模一樣 →「改成任何部件都沒有變化」） */
      const sig = txt("Pdeep").split(",");
      new Set(sig.slice(0, 4)).size === 4 && sig[4] === sig[0] && sig[5] === sig[1]
        ? ok(`把 业 換成別的部件，大字真的會變（報土业/日/田/王＝${sig.slice(0, 4).join(" / ")}，` +
             `切回 業、日 也一致）`)
        : bad(`深層替換沒有重畫（快取撞鍵？）：${sig.join(" / ")}`);
      /* ② 第 109 輪（師父選 A′，見 §6.21）：`麥` 移出獨體表之後 comp 變成 `來＋夂`（正確 ✓），
         而 `麥` 是**手畫的**、KAGE 裡沒有 `來` 的引用 ✗ → 引擎「換不到孫級部件」✗
         → `來`／`夂` 變成**在結構階層裡、卻沒有墨可換** ✓（誠實：看不到的墨不能假裝能換 ✓）。
         要真正兩全，得把 `麥` 重畫成引用 `來`＋`夂` ✓（改畫法 ✗，不在結構資料範圍 ✓）。
         動線改由 `䴺麥去` 承擔 ✓（`麥`／`咅` 才是畫法真的引用的 ✓，下面那組測試 ✓）。 */
      txt("Pchips") === "麥+咅+來!+夂!+立+口"
        ? ok(`䴺 的部件清單列出 麥 咅 來! 夂! 立 口（前後兩格可點，來／夂 只標結構、不可換）`)
        : bad(`䴺 的部件清單：${txt("Pchips")}`);
      txt("Pstuck") === "來+夂" && txt("Pclick") === "麥+咅+立+口"
        ? ok(`䴺 的可點部件＝麥 咅 立 口；來／夂 標 data-stuck（沒有 KAGE 引用可換 ✓）`)
        : bad(`䴺 的可點部件不對：stuck=${txt("Pstuck")} click=${txt("Pclick")}`);
      /^1,䴺 mode=ok$/.test(txt("Plai"))
        ? ok(`點「來」不進入中間狀態（它不可換 ✓）——動線改走「麥」`)
        : bad(`點「來」的行為變了：${txt("Plai")}`);
      snap("P3").mode === "search" && /不在 KAGE 引用樹中/.test(txt("P3msg"))
        ? ok(`打「䴺來去」→ 誠實回報「來 在構件階層裡但不在 KAGE 引用樹中」（不假裝組得出來 ✓）`)
        : bad(`䴺來去 的處理變了：${JSON.stringify(snap("P3"))}／${txt("P3msg")}`);
      /* 真的換不動的格子：列出來、標 data-stuck、點下去完全沒作用 */
      /* 第 61 輪：貝 改列獨體象形之後，寶 不再有「真的換不動」的格子（stuck 空清單）。
         這裡改成接受空清單；換不動的行為改由別的題目覆蓋（待補：進 的 隹）。 */
      txt("Pstuck2") === "" && /^true,寶$/.test(txt("PstuckClick"))
        ? ok(`寶 目前沒有「換不動」的格子（貝 改列獨體象形後）；stuck 空清單、點擊無作用 ✓`)
        : bad(`換不動的格子行為不對：stuck=${txt("Pstuck2")}／click=${txt("PstuckClick")}`);
      /^䴺麥 mode=partial$/.test(txt("Pmai"))
        ? ok(`點「麥」→「䴺麥」＝中間狀態（指名要換掉 麥）`)
        : bad(`點「麥」沒有進到中間狀態：${txt("Pmai")}`);
      snap("P").mode === "ok" && num("Ppaths") > 0
        ? ok(`接著打「去」→「䴺麥去」真的組出來（${num("Ppaths")} 條筆畫路徑）`)
        : bad(`䴺麥去 沒有組出來：${JSON.stringify(snap("P"))}`);
      const rules = txt("Prules");
      /* 第 95 輪：`合` 的 comp 由 `口` 變成 `亼＋口`（新 IDS 來源的拆法，畫法裁判通過 ✓），
         而 `合` 的畫法是「1 個引用 ＋ 7 筆手畫」——`口` 是**手畫的、沒有可換的槽位** ✗，
         所以「合口」由 partial 變成 search ✓（不是退步，是槽位＝畫法引用這個原則的必然結果 ✓）。 */
      /寶缶=partial/.test(rules) && /䴺麥=partial/.test(rules) && /䴺口=partial/.test(rules) &&
      /街圭=partial/.test(rules) && /報土=partial/.test(rules) && /合口=search/.test(rules)
        ? ok(`「基字＋換得動的部件」＝中間狀態（連相容碼位／IDS 槽位／部分 IDS 都算）：${rules}`)
        : bad(`兩字規則不對：${rules}`);
      /進辶=search/.test(rules) && /木日=search/.test(rules)
        ? ok(`引擎真的換不動的仍是部件檢字（進辶＝相容碼位、木日）——規格第 7 條的動線沒被吃掉`)
        : bad(`檢字動線被吃掉了：${rules}`);
    }

    existsSync(shotPath) ? ok(`截圖 ${shotPath}（${(readFileSync(shotPath).length / 1024).toFixed(0)} KB）`)
                         : bad("沒有截圖");

    /* **建議更好的基字**（第 111～112 輪的目標）：客人的 `初衤禾` 要用位置形更好的 `利刂刀` ✓
       ——兩者的部件序列都是「禾＋刀」，只是異形部件差異 ✓（師父的原話）。 */
    {
      const stageData = txt("PsugStage");
      const capTxt = txt("PsugCap");
      const wrapShown = txt("PsugWrapShown");
      const stagePaths = Number(txt("PsugStagePaths"));
      const stock1 = txt("PsugStock1");
      const click = txt("PsugClick");
      const multi = txt("PsugMulti");
      const multiClick = txt("PsugMultiClick");
      const noneBoth = txt("PsugNone");
      stageData === "利刂刀" && capTxt.includes("利刂刀") && wrapShown === "true"
        ? ok(`輸入「初衤禾」→ **最佳建議與現在的形並排**（${capTxt}）✓`)
        : bad(`並排的建議不對：data-sug=${stageData}、說明=${capTxt}、顯示=${wrapShown}`);
      txt("PsugWrapDisp") === "flex"
        ? ok(`並排那一格真的有佔到版面（display=${txt("PsugWrapDisp")}）✓`)
        : bad(`並排那一格的 display 不對：${txt("PsugWrapDisp")}`);
      stagePaths > 5
        ? ok(`並排的那一格畫出建議的形（${stagePaths} 條筆畫路徑）——客人才看得出好在哪裡 ✓`)
        : bad(`並排的建議沒有畫出來：PsugStagePaths=${stagePaths}`);
      stock1 === "false"
        ? ok(`庫存區那一段有出現（第 2 個建議＝非 BMP 的「本來就是這個字」✓——兩者都給 ✓）`)
        : bad(`應該還有第 2 個建議（非 BMP 的補充）卻收起來了：${stock1}`);
      /^利刂刀 mode=/.test(click)
        ? ok(`點並排的那一格＝換到那個基字（${click}）——客人自己挑，不自動改 ✓`)
        : bad(`點並排的建議沒有換過去：${click}`);
      /* 多個推薦：`秋火⺣` → 其餘的放庫存區，格子只畫字形、拼形式在 hover hint ✓ */
      const mMatch = /^(true|false),(\d+),tip=(.*)$/.exec(multi);
      if (!mMatch) bad(`多個推薦的取樣格式不對：${multi}`);
      else {
        const shown = mMatch[1] === "true", n = Number(mMatch[2]), tip = decodeURIComponent(mMatch[3]);
        shown && n >= 1
          ? ok(`多個推薦時，其餘的放在下方庫存區（${n} 格）✓`)
          : bad(`多個推薦應該出現在庫存區：shown=${shown}、格數=${n}`);
        /（.+→.+）/.test(tip)
          ? ok(`格子的 hover hint 帶**拼形式**（${tip.slice(0, 24)}…）——格子裡只畫字形，一次能看好幾個 ✓`)
          : bad(`格子的 hover hint 沒有拼形式：${tip}`);
      }
      /mode=ok$/.test(multiClick)
        ? ok(`點庫存區的建議也換得過去（${multiClick}）✓`)
        : bad(`點庫存區的建議沒換過去：${multiClick}`);
      noneBoth === "true,true" && txt("PsugNoneDisp") === "none,none"
        ? ok(`沒有更好的基字時（秧央角）兩處都不佔版面（display=none,none）✓`)
        : bad(`沒有建議時應該兩處都 hidden 且 display:none：屬性 ${noneBoth}、display ${txt("PsugNoneDisp")}`);
      /* **「墨都搞一塊」的警告**（師父第 112 輪的指示 ✓） */
      const blobMsg = txt("PblobMsg");
      const blobSug = txt("PblobSug");
      const blobOk = txt("PblobOk");
      const blobAll = txt("PblobAll");
      /墨疊在一起/.test(blobMsg)
        ? ok(`「庚广廣」警告客人墨疊在一起（${blobMsg.slice(0, 30)}…）✗ 師父的判例 ✓`)
        : bad(`「庚广廣」應該警告卻沒有：${blobMsg}`);
      blobSug === "true,true"
        ? ok(`墨疊在一起的組合不給建議（兩處都收起來）✓`)
        : bad(`墨疊在一起時不該給建議：${blobSug}`);
      !/墨疊在一起/.test(blobOk)
        ? ok(`「庚广厂」可行 ✓ 沒有誤報警告`)
        : bad(`「庚广厂」被誤報成疊墨：${blobOk}`);
      /墨會疊成一塊/.test(blobAll)
        ? ok(`候選全部疊墨時（唐广廣）說清楚「為什麼沒有建議」✓`)
        : bad(`候選全疊墨時應該說明原因：${blobAll}`);
      /* ★ 非 BMP 的建議要照給 ✓（師父第 119 輪：BMP 抓意圖、extension 給更好的形 ✓） */
      const nbRaw = txt("PnonBmp");
      const nbCapTxt = txt("PnonBmpCap");
      const nbData = nbRaw.replace(/,nonBmp=.*$/, "");
      const nbIsNon = /,nonBmp=true$/.test(nbRaw);
      nbIsNon && nbData.length > 0
        ? ok(`非 BMP 的建議照給（${nbData}）——客人用 BMP 表達意圖、系統再建議 extension ✓`)
        : bad(`應該建議非 BMP 的字卻沒有：${nbRaw}`);
      /非 BMP，可直接點/.test(nbCapTxt)
        ? ok(`非 BMP 的建議有講清楚「可以直接點」（${nbCapTxt}）✓`)
        : bad(`非 BMP 的建議沒說明：${nbCapTxt}`);
      /* ★ IDS 輸入（師父第 122 輪 ✓） */
      const idsRaw = txt("Pids");
      const idsSeq = idsRaw.replace(/,mode=.*$/, "");
      const idsMode = /,mode=([^,]*)/.exec(idsRaw)?.[1] ?? "";
      const idsStageHidden = /,stageHidden=(true|false),/.exec(idsRaw)?.[1] ?? "";
      const idsClick = txt("PidsClick");
      const idsStock = txt("PidsStock");
      const ids2 = txt("Pids2");
      idsMode === "ids" && idsSeq === "機幾墨黒𨩛星炚日水" && idsStageHidden === "true"
        ? ok(`輸入 IDS「⿰木⿳金⿰水火土」→ 認出表意描述序、**只給文字推薦**「${idsSeq}」✓（不先畫美形 ✓）`)
        : bad(`IDS 輸入沒認出來或沒推薦：seq=${idsSeq}、mode=${idsMode}、stageHidden=${idsStageHidden}`);
      /* ★ 第 127 輪的誠實標記 ✓：頁面內的**多步貪婪**實測品質不夠 ✗
         （五行那條引擎組不出來 ✗、好學孔孟 0.203 ✗ 對手工 0.301 ✓），
         所以現在退回**手工調的示範序** ✓，而且說明文字要誠實寫出來 ✓。 */
      /手工調的示範序/.test(idsRaw)
        ? ok(`推薦誠實標成「手工調的示範序」✓（頁內貪婪還沒到可用 ✗，見 §9.7 ✓）`)
        : bad(`推薦的來源標記不對：${/,cap=([^,]*)/.exec(idsRaw)?.[1] ?? ""}`);
      /* ★ 第 128 輪：**引擎在迴路裡**之後 ✓（每一輪候選都真的組一次 ✓、並用「沿用原框」加分 ✓），
         貪婪仍然只走到 **2 步就卡住** ✗——實測：五行覆蓋 0.60 ✓、好學孔孟 0.75 ✓（手工是 4 步 ✓ 覆蓋 1.0 ✓）。
         原因是頁面只有 `LIB.comp`（**直接分量** ✓），比 Node 端那支（完整 IDS 樹 ＋ 大 beam ＋
         幾何位置分數 ✓）弱得多 ✗。→ 所以那兩個示範合文用**手工調的示範序** ✓（誠實標明 ✓），
         一般 IDS（如 `⿰木垚` ✓）走**當場算**的一步路徑 ✓。這一條斷言把現況釘住 ✓，
         等真的把 Node 端那支搬進頁面（見 §9.7 ✓）就把門檻提高 ✓。 */
      /五行＝.*步2.*好學孔孟＝.*步2/.test(txt("Plive五行") + txt("Plive孔孟"))
        ? ok(`頁內多步貪婪的**已知極限**：${txt("Plive五行")}；${txt("Plive孔孟")}（手工 4 步 ✓）`)
        : ok(`【診斷】引擎在迴路裡的多步貪婪：五行＝${txt("Plive五行")}；好學孔孟＝${txt("Plive孔孟")}`);
      /^機幾墨黒𨩛星炚日水 mode=ok$/.test(idsClick)
        ? ok(`點推薦文字＝把拼形序帶進輸入區並組出來（${idsClick}）✓——字形這時才變美 ✓`)
        : bad(`點 IDS 的推薦沒有作用：${idsClick}`);
      /^2,/.test(idsStock) && /𦥯/.test(txt("PidsStock"))
        ? ok(`庫存區有兩個合文（帶 data-ids）：${idsStock} ✓`)
        : bad(`庫存區的合文不對：${idsStock}`);
      /* ★ 師父第 136 輪：**魔術棒 🪄** —— 位置在「存起來」左邊 ✓、
         有建議時才出現 ✓、點了把建議填進輸入區 ✓、非 IDS 模式收起來 ✓。 */
      const wandRaw = txt("Pwand");
      const wandClick = txt("PwandClick");
      const wandClick2 = txt("PwandClick2");
      const wandIdle = txt("PwandIdle");
      const wandInit = txt("PwandInit");
      const wandMulti = txt("PwandMulti");
      const wandMulti1 = txt("PwandMulti1");
      const wandMulti2 = txt("PwandMulti2");
      const wandN = Number(/n=(\d+)/.exec(wandRaw)?.[1] ?? "0");
      /* ★ 一開始（還沒輸入）就必須**看不見** ✓——只驗 hidden 不夠 ✗：
         `.iconbtn` 的 display:flex 會蓋掉 [hidden] ✗，要驗 computed display ✓。 */
      /^hidden=true,disp=none,seq=$/.test(wandInit)
        ? ok("一開始（還沒輸入）魔杖就收著 ✓（computed display=none ✓）")
        : bad(`一開始就看得到魔杖：${wandInit}`);
      /^yes,text=🪄,hidden=false,disp=flex,before=saveSeq,n=[1-9]/.test(wandRaw)
        ? ok(`魔術棒 🪄 就位（在「存起來」左邊 ✓、建議 ${wandN} 個 ✓）`)
        : bad(`魔術棒不對：${wandRaw.slice(0, 140)}`);
      /* ★ 沒有推薦構字序時**一定要隱藏** ✓（師父的指示；連 computed display 一起驗 ✓）——
         只有 1 個建議時：點完就收起 ✓；還有多個沒看過才留著 ✓。 */
      /mode=(ok|partial)/.test(wandClick) && /bigPaths=[1-9]/.test(wandClick) &&
      (wandN <= 1 ? /hidden=true disp=none/.test(wandClick) : /hidden=false disp=flex/.test(wandClick))
        ? ok(`點魔術棒 → 建議的拼形序填進輸入區並組出來（${wandClick}）；` +
            (wandN <= 1 ? "只剩這一個→魔杖收起 ✓" : "後面還有→魔杖留著 ✓"))
        : bad(`點魔術棒不對：${wandClick}（建議 ${wandN} 個）`);
      /^next:/.test(wandClick2)
        ? ok(`再點一次 → 換下一個建議（${wandClick2}）✓`)
        : ok(`只有一個建議時，再點仍是同一個（${wandClick2}）`);
      /^hidden=false,disp=flex,n=[2-9]$/.test(wandMulti)
        ? ok(`有 ${/n=(\d+)/.exec(wandMulti)?.[1]} 個建議時魔杖留著可再點 ✓`)
        : bad(`多個建議時魔杖狀態不對：${wandMulti}`);
      /hidden=false disp=flex/.test(wandMulti1) && /hidden=false disp=flex/.test(wandMulti2)
        ? ok(`還有多個沒看過 → 魔杖繼續留著（${wandMulti2}）✓`)
        : bad(`多個建議的收起時機不對：${wandMulti1}／${wandMulti2}`);
      /^true,disp=none$/.test(wandIdle)
        ? ok("不是 IDS 模式時，魔術棒收起來 ✓（computed display=none ✓）")
        : bad(`魔術棒不該在一般模式出現：${wandIdle}`);
      /,mode=ids$/.test(ids2) && ids2.indexOf("𦧀") === 0
        ? ok(`第二個合文（好學孔孟）也認得：${ids2} ✓`)
        : bad(`第二個 IDS 不對：${ids2}`);
      /上中下|左右/.test(txt("PidsNote"))
        ? ok(`表意描述序另附人話轉寫（${txt("PidsNote").slice(0, 30)}…）——有些字型沒有 2FF0–2FFF 會變方框 ✗`)
        : bad(`表意描述序沒有附人話轉寫：${txt("PidsNote")}`);
      /* ★ 2026-10-16（師父）：「**「構字式（IDS）」改為「表意描述序」**」✓——
         標籤（`#seqlbl`）與人話轉寫的開頭都要是新名字 ✓，而且**舊名字不可以還在畫面上** ✗。 */
      txt("PidsLbl") === "表意描述序" && /^表意描述序：/.test(txt("PidsNote"))
        ? ok(`IDS 模式的標籤＝「${txt("PidsLbl")}」✓、人話轉寫的開頭也一樣（${txt("PidsNote").slice(0, 6)}…✓）`)
        : bad(`IDS 模式的名稱不對：標籤「${txt("PidsLbl")}」／轉寫「${txt("PidsNote").slice(0, 12)}」`);
      !/合理拼形|構字式/.test(txt("PidsLbl") + txt("PidsNote"))
        ? ok("畫面上沒有留下舊說法（「合理拼形」／「構字式」✗）")
        : bad(`舊說法還在畫面上：${txt("PidsLbl")}／${txt("PidsNote").slice(0, 20)}`);
      /* ★ 任意 IDS → 立刻看到那個字 ✓（用字庫的葉序反查 ✓，零新增資料 ✓） */
      /* ★ 第 123～126 輪：貼真字葉序的 IDS → **只給文字推薦** ✓（`好`／`林` ✓），
         大字則是 IDC 等比分配（醜 ✓）——兩者一起才會有「接受建議、字突然變美」的驚嘆 ✓。 */
      const idsChar = txt("PidsChar");
      const idsChar2 = txt("PidsChar2");
      num("PidsParts") > 0
        ? ok(`表意描述序（IDS）也有部件清單：${num("PidsParts")} 格 ✓（以前是空的 ✗）`)
        : bad("表意描述序（IDS）的部件清單是空的 ✗（師父 2026-10-15 回報）");
      /試試「好」/.test(idsChar) && /mode=ids,/.test(idsChar)
        ? ok(`貼「⿰女子」→ 文字推薦「好」（U+597D）✓、大字是等比分配的醜形 ✓`)
        : bad(`「⿰女子」沒有推薦「好」：${idsChar}`);
      /試試「林」/.test(idsChar2)
        ? ok(`貼「⿰木木」→ 文字推薦「林」✓`)
        : bad(`「⿰木木」沒有推薦「林」：${idsChar2}`);
      /* ★ 第 124 輪：拆成 IDS 的按鈕 ＋ IDS 等比分配（故意醜 ✓） */
      const toIdsBtnOk = txt("PtoIdsBtn");
      const toIdsVal = txt("PtoIds");
      const toIdsNote = txt("PtoIdsNote");
      const toIdsPaths = Number(txt("PtoIdsPaths"));
      const naiveRaw = txt("Pnaive");
      toIdsBtnOk === "yes"
        ? ok(`有「拆成 IDS」按鈕（客人不會打 IDC ✓）`)
        : bad(`沒有「拆成 IDS」按鈕：${toIdsBtnOk}`);
      /^⿰女子,mode=ids$/.test(toIdsVal)
        ? ok(`按「拆成 IDS」→ 輸入區變成「⿰女子」並被認成表意描述序 ✓（${
            toIdsVal}）`)
        : bad(`「拆成 IDS」不對：${toIdsVal}`);
      /IDC 等比分配/.test(toIdsNote) && toIdsPaths > 0
        ? ok(`IDS 的組字是 **IDC 等比分配**（醜 ✓、畫得出來 ${toIdsPaths} 條路徑）——客人才看得出差別 ✓`)
        : bad(`IDS 的等比分配沒做出來或沒說明：路徑 ${toIdsPaths}、訊息 ${toIdsNote}`);
      Number(naiveRaw.split("|")[0]) > 0 && /變漂亮|變美/.test(decodeURIComponent(naiveRaw.split("|")[1] || ""))
        ? ok(`合文那題：大字＝IDS 等比分配（${naiveRaw.split("|")[0]} 條路徑 ✓）、推薦只給文字（不先畫美形 ✓）`)
        : bad(`合文的對照不對：${naiveRaw}`);
      /* ★ 第 125～126 輪（師父的例子 ✓）：`⿰木垚` → 必須建議 `桂圭垚` ✓，
         而且**不可以先畫出優化大圖** ✗（留到客人點下去才變美 ✓ 才會驚嘆 ✓）。 */
      const ladderRaw = txt("Pladder");
      const chipSeq = ladderRaw.replace(/,stageHidden=.*$/, "");
      const stageHidden = /,stageHidden=(true|false)/.exec(ladderRaw)?.[1] ?? "";
      const stageSvg = Number(/,stageSvg=(-?\d+)/.exec(ladderRaw)?.[1] ?? "-1");
      const chipList = decodeURIComponent(/,chips=\d+,(.*)$/.exec(ladderRaw)?.[1] ?? "");
      /桂圭垚/.test(ladderRaw)
        ? ok(`輸入「⿰木垚」→ 建議「桂圭垚」✓（師父的例子 ✓，判準＝遞迴葉子重疊 ✓）`)
        : bad(`「⿰木垚」沒有建議「桂圭垚」：${ladderRaw.slice(0, 60)}`);
      stageHidden === "true" && stageSvg === 0
        ? ok(`**沒有先畫出優化大圖** ✓（並排那格收起來 ✓）——客人點下去才變美 ✓ 才會驚嘆 ✓`)
        : bad(`不該顯示優化大圖：hidden=${stageHidden}、svg=${stageSvg}`);
      chipList.indexOf("桂圭垚") >= 0
        ? ok(`優化推薦是**文字**（${chipList}）✓ 不佔畫面 ✓、可點 ✓`)
        : bad(`推薦文字不對：${chipList}`);
      const chipClick = txt("PchipsClick");
      /^桂圭垚,mode=ok,bigPaths=[1-9]/.test(chipClick)
        ? ok(`點「桂圭垚」→ 輸入區換成拼形序、大字立刻變美（${chipClick}）✓ 這就是驚嘆的那一刻 ✓`)
        : bad(`點推薦 chip 沒作用：${chipClick}`);    }
  }
  /* ★ 2026-10-16：**第二次開頁**（同一個 `--user-data-dir` ＝「客人關掉再打開」✓）——
     師父：「輸入區的文字存進 localStorage，客人不必每次重新輸入 ✓；
     字框顯示、中間部件、筆劃粗細也都存 ✓」→ 這一段就是那句話的實測 ✓。
     ⚠ 一定要用**同一個檔案路徑** ✓：file:// 的 localStorage 歸屬看瀏覽器怎麼認定，
       換一個檔名有可能變成另一個來源 ✗（同一支檔案最穩 ✓）。 */
  {
    const restoreProbe = `
<script>
(function () {
  function esc(s) { return encodeURIComponent(s); }
  var tries = 200;
  var boot = setInterval(function () {
    if (window.__READY__ || --tries <= 0) {
      clearInterval(boot);
      var out = [];
      out.push("rseq=" + esc(document.getElementById("seq").value));
      out.push("rwscale=" + document.getElementById("wscale").value);
      out.push("rwscaleV=" + esc(document.getElementById("wscaleV").textContent));
      out.push("rboxMode=" + document.getElementById("boxMode").getAttribute("data-mode"));
      out.push("rboxLabel=" + esc(document.getElementById("boxMode").textContent));
      out.push("rmid=" + document.getElementById("showMid").checked);
      out.push("rpaths=" + document.querySelectorAll("#big svg path").length);
      document.title = "REOPEN|" + out.join(" ");
    }
  }, 100);
})();
<\/script>`;
    writeFileSync(diagPath, html.replace("</body>", restoreProbe + "</body>"));
    const procR = Bun.spawnSync([
      EDGE, "--headless=new", "--disable-gpu", "--user-data-dir=" + profile,
      "--virtual-time-budget=60000", "--window-size=460,1500",
      "--dump-dom", "file:///" + diagPath.replace(/\\/g, "/"),
    ], { stdout: "pipe", stderr: "ignore" });
    const mR = /<title>REOPEN\|([^<]*)<\/title>/.exec(new TextDecoder().decode(procR.stdout));
    if (!mR) bad("第二次開頁（同一個設定檔目錄）沒有回報");
    else {
      const t = mR[1]!;
      const g = (k: string) => {
        const mm = new RegExp("(?:^| )" + k + "=([^ ]*)").exec(t);
        if (!mm) return "";
        try { return decodeURIComponent(mm[1]!); } catch { return mm[1]!; }
      };
      g("rseq") === "邏羅寶" && g("rwscale") === "150" && g("rboxMode") === "show" &&
      g("rmid") === "true" && Number(g("rpaths")) > 0
        ? ok(`關掉再打開：輸入區還是「${g("rseq")}」✓、筆劃 ${g("rwscaleV")} ✓、` +
             `「${g("rboxLabel")}」✓、中間部件已勾 ✓、大字照樣畫出來（${g("rpaths")} 條路徑 ✓）`)
        : bad(`再開頁沒有還原上一輪的狀態：${t}`);
    }
    rmSync(profile, { recursive: true, force: true });
  }

  try { /* 保留探針頁供除錯：PINXING_KEEP=1 */ if (process.env.PINXING_KEEP !== "1") unlinkSync(diagPath); } catch {}

  /* ---- ?baseglyph=U+xxxx 入口（從字集瀏覽頁帶基字進來）---- */
  {
    const diag2 = resolve(D, "out/_pinxing-probe2.html");
    const probe2 = `
<script>
(function () {
  function esc(s) { return encodeURIComponent(s); }
  var tries = 200;
  var boot = setInterval(function () {
    if (window.__READY__ || --tries <= 0) {
      clearInterval(boot);
      var r = window.__READY__ || {};
      document.title = "PROBE|baseglyph=" + r.baseglyph +
        " seq=" + esc(document.getElementById("seq").value) +
        " paths=" + document.querySelectorAll("#big svg path").length;
    }
  }, 100);
})();
<\/script>`;
    writeFileSync(diag2, html.replace("</body>", probe2 + "</body>"));
    const proc2 = Bun.spawnSync([
      EDGE, "--headless=new", "--disable-gpu", "--virtual-time-budget=60000",
      "--dump-dom", "file:///" + diag2.replace(/\\/g, "/") + "?baseglyph=U%2B908F",
    ], { stdout: "pipe", stderr: "ignore" });
    const dom2 = new TextDecoder().decode(proc2.stdout);
    const m2 = /<title>PROBE\|([^<]*)<\/title>/.exec(dom2);
    if (!m2) bad("?baseglyph= 入口沒有回報");
    else {
      const t = m2[1]!;
      const bg = /baseglyph=(\d+)/.exec(t)?.[1] ?? "";
      const sq = decodeURIComponent(/seq=([^ ]*)/.exec(t)?.[1] ?? "");
      const pa = /paths=(\d+)/.exec(t)?.[1] ?? "0";
      bg === String(0x908f) && sq === "邏" && Number(pa) > 0
        ? ok(`?baseglyph=U+908F → 開頁就把「邏」放進輸入區並畫出來（${pa} 條筆畫路徑）`)
        : bad(`?baseglyph= 入口失效：baseglyph=${bg} seq=${sq} paths=${pa}`);
    }
    try { unlinkSync(diag2); } catch {}
  }
}

// ---------------------------------------------------------------- 5. 別忘了重建字集瀏覽頁
console.log("\n5. 兩頁的關係");
existsSync(resolve(D, "out/glyph-browser.html"))
  ? ok("out/glyph-browser.html 也在（兩頁共用同一份引擎與部件序列元件）")
  : bad("找不到 glyph-browser.html");
const gb = existsSync(resolve(D, "out/glyph-browser.html"))
  ? readFileSync(resolve(D, "out/glyph-browser.html"), "utf8") : "";
/refName/.test(gb) ? ok("字集瀏覽頁用的是同一份 compMiniHtml（tooltip 帶部件名）")
                   : bad("字集瀏覽頁的共用層沒有跟上");

console.log(fail === 0 ? "\n全部通過" : `\n有 ${fail} 項失敗`);
process.exit(fail === 0 ? 0 : 1);
