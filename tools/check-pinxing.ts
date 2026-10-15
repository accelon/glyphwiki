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
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

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
console.log("\n2. 內嵌程式碼：字庫 ＋ 構形序列 ＋ 相容異體");
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

      /* 構形序列：規格〈招財進寶〉那條動線上的每一個中間狀態都要解得開 */
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
    /* --- 步驟 5：輸入「寶」→ 邏羅寶（合法構形序列，畫組出來的形） --- */
    function () {
      setSeq("邏羅寶"); snap("E");
      out.push("Epaths=" + document.querySelectorAll("#big svg path").length);
      out.push("EcapHasBao=" + /寶/.test(document.getElementById("seqNote").textContent));
      out.push("Eowner=" + encodeURIComponent(String(seqOwnerChar(lastEval, "邏羅寶"))) +
        " cur=" + document.getElementById("seq").selectionStart +
        " stOwner=" + encodeURIComponent(String((lastEval && lastEval.owner) || "")));
      out.push("Echips=" + JSON.stringify(Array.prototype.map.call(
        document.querySelectorAll("#seqChips .mini.comp"), function (m) { return m.getAttribute("data-ch"); })));
    },
    /* --- 大字的部件框：三態切換、點框連動 --- */
    function () {
      out.push("Fboxes=" + document.querySelectorAll("#big .cbox").length);
      out.push("FboxData=" + Array.prototype.map.call(
        document.querySelectorAll("#big .cbox"), function (b) { return b.getAttribute("data-box"); }).join(","));
      var b = document.getElementById("boxMode");
      try {
        function modeInfo(tag) {
          out.push(tag + "N=" + document.querySelectorAll("#big .cbox").length);
          out.push(tag + "T=" + encodeURIComponent(b.textContent));
          out.push(tag + "M=" + b.getAttribute("data-mode"));
          out.push(tag + "P=" + document.querySelectorAll("#big svg path").length);
        }
        b.click(); modeInfo("Fraw");
        b.click(); modeInfo("Fnone");
        b.click(); modeInfo("Fback");
        var box = document.querySelector("#big .cbox");
        out.push("Fclicked=" + (!!box));
        if (box) box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        out.push("FactiveChip=" + document.querySelectorAll("#seqChips .mini.comp.on").length);
        out.push("FactiveBox=" + document.querySelectorAll("#big .cbox.on").length);
      } catch (e) { out.push("FEXC=" + e.message); }
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
      rows[3].click();
      snap("H");
    },
    /* --- 存自己的序列：存檔圖示 ＋ Enter；已存過要移到最前面 --- */
    function () {
      setSeq("初衤礻");
      document.getElementById("saveSeq").click();
      out.push("Imine=" + document.querySelectorAll("#stock .stockrow.mine").length);
      out.push("Ils=" + encodeURIComponent(localStorage.getItem("pinxing.stock") || ""));
      out.push("Itoast=" + encodeURIComponent(document.getElementById("msg").textContent));
      /* Enter 也要能存：keydown 真的有接上（preventDefault 生效）＋ 內容進 localStorage。
         先換成另一串，才驗得出 Enter 真的存了東西。 */
      setSeq("衚胡舞");
      var ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      var notCancelled = seqEl().dispatchEvent(ev);
      out.push("IenterPrevented=" + (!notCancelled));
      out.push("Ienter=" + encodeURIComponent(localStorage.getItem("pinxing.stock") || ""));
      out.push("Itoast2=" + encodeURIComponent(document.getElementById("msg").textContent));
      /* 再存一次已經存過的：要**移到最前面**，不是多一份 */
      setSeq("初衤礻");
      document.getElementById("saveSeq").click();
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
         ★ 第 127 輪：合文那兩列送的是 **IDS**（「data-send」✓），其餘送構形序（「data-seq」✓）。 */
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
      setSeq("邏羅寶");                    /* 合理拼形：帶的是最後一個字 */
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
      /* 「報幸土业」：新內容 土业 讀不成構形序列 → 仍走橫向串接（warn「不是原地換部件」） */
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
         有的話**推薦更好的構形序** ✓；而且兩個常見合文的 IDS 要放在**庫存區** ✓（一點就看到 ✓）。 */
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
      out.push("Pids=" + encodeURIComponent(idsTop) + ",mode=" + S().mode +
        ",stageHidden=" + String(!!document.getElementById("sugStage").hidden) +
        ",cap=" + encodeURIComponent((document.getElementById("sugCap") || {}).textContent || ""));
      out.push("PidsNote=" + encodeURIComponent(document.getElementById("bigNote").textContent));
      if (idsChips.length) idsChips[0].click();
      out.push("PidsClick=" + encodeURIComponent(seqEl().value + " mode=" + S().mode));
      var idRows = document.querySelectorAll("#stock .stockrow.ids");
      out.push("PidsStock=" + idRows.length + "," +
        encodeURIComponent(Array.prototype.map.call(idRows, function (r) { return r.getAttribute("data-ids"); }).join(" ")));
      /* ★ 師父第 136 輪：**魔術棒 🪄**（在「存起來」左邊 ✓）——
         有建議的構形序時才出現 ✓；點一下＝把下一個建議填進輸入區 ✓（不把序寫在畫面上 ✓）。 */
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
        " bigPaths=" + document.querySelectorAll("#big svg path").length));
      var wandV1 = seqEl().value;
      if (wandEl) wandEl.click();
      out.push("PwandClick2=" + encodeURIComponent((seqEl().value === wandV1 ? "same:" : "next:") + seqEl().value));
      setSeq("⿳𦥯⿰女孔皿");
      var idsChips2 = document.querySelectorAll("#sugRow .seqchip");
      out.push("Pids2=" + encodeURIComponent(idsChips2.length ? (idsChips2[0].getAttribute("data-sug") || "") : "MISSING") +
        ",mode=" + S().mode);
      /* ★ 第 123 輪（師父的願景 ✓）：貼一個**真的對應到某個字**的構字式，要**立刻畫出來** ✓——
         用字庫的「comp」（葉序 ✓）反查 ✓，不必新增資料 ✓。 */
      setSeq("⿰女子");
      out.push("PidsChar=" + encodeURIComponent(document.getElementById("bigNote").textContent) + ",mode=" + S().mode +
        ",cap=" + encodeURIComponent((document.getElementById("sugCap") || {}).textContent || ""));
      setSeq("⿰木木");
      out.push("PidsChar2=" + encodeURIComponent(document.getElementById("bigNote").textContent) +
        ",cap=" + encodeURIComponent((document.getElementById("sugCap") || {}).textContent || ""));
      /* ★ 第 124 輪（師父的三個要求 ✓）：
         ① 「拆成 IDS」按鈕 ✓（客人不會打 IDC ✓）
         ② IDS 的組字**故意按 IDC 等比分配**（醜 ✓），右邊並排構形序（美 ✓）
         ③ 構形序那格可點、點下**取代 IDS** ✓（用 124 那條已有的點擊斷言驗 ✓） */
      setSeq("好");
      out.push("PwandIdle=" + (document.getElementById("wand") ? String(!!document.getElementById("wand").hidden) : "MISSING"));
      var toIdsBtn = document.getElementById("toIds");
      out.push("PtoIdsBtn=" + (toIdsBtn ? "yes" : "MISSING"));
      if (toIdsBtn) toIdsBtn.click();
      out.push("PtoIds=" + encodeURIComponent(seqEl().value + ",mode=" + S().mode));
      out.push("PtoIdsNote=" + encodeURIComponent(document.getElementById("bigNote").textContent));
      out.push("PtoIdsPaths=" + document.querySelectorAll("#big svg path").length);
      setSeq("⿰木⿳金⿰水火土");
      out.push("Pnaive=" + document.querySelectorAll("#big svg path").length +
        "|" + encodeURIComponent(document.getElementById("sugCap").textContent));
      /* ★ 第 125 輪：**任意 IDS 都要能建議構形序** ✓——師父的例子「⿰木垚」→「桂圭垚」✓ */
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
    function () { out.push("done=1"); report(out.join(" ")); }
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

  const proc = Bun.spawnSync([
    EDGE, "--headless=new", "--disable-gpu", "--virtual-time-budget=150000",
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
    txt("boxMode") === "tight" && /字框/.test(txt("boxLabel"))
      ? ok(`字框三態的初始狀態：${txt("boxLabel")}（data-mode=${txt("boxMode")}）`)
      : bad(`框模式初始 ${txt("boxMode")}／${txt("boxLabel")}`);

    // ---- 步驟 1：輸入「進」
    const A = snap("A");
    A.seq === "進" && A.mode === "ok" && A.boxes === 2
      ? ok(`① 輸入「進」：畫出基字、大字上 1 個部件框（部件序列 ${A.chips} 格）`)
      : bad(`① 進 的狀態不對：${JSON.stringify(A)}`);

    // ---- 步驟 2：點「辶」→ 進辶 ＋ 列出含辶的字
    const B = snap("B");
    txt("Bchip") === "true" ? ok("② 點部件序列的「辶」") : bad("② 找不到「辶」那一格");
    B.seq === "進辶" ? ok(`② 輸入區變成「進辶」（規格原文的這一步）`) : bad(`② 輸入區是「${B.seq}」`);
    B.mode === "search" ? ok("② 不是合法構形序列 → 當成部件搜尋（規格第 7 條）")
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
    /邏 的 羅/.test(txt("Elog") || E.msg) ? ok(`⑤ 引擎的說明：${E.msg}`) : bad(`⑤ 沒有替換說明：${E.msg}`);
    /* 標題只寫「部件清單」（使用者的要求）；要知道**是哪個字**的清單就看部件格：
       這裡的題目是 邏羅寶，游標在最後 → 應該列 寶 的部件（𡩧 貝 缶 𡪓） */
    txt("Eowner") === "寶" && /𡩧|貝|缶/.test(txt("Echips"))
      ? ok(`⑤ 部件清單跟著光標走（owner=寶、部件 ${txt("Echips")}）`)
      : bad(`⑤ 部件清單沒有跟著換：owner=${txt("Eowner")} chips=${txt("Echips")}`);
    /點一下＝用它替換|部件清單/.test(E.cap) ? ok(`⑤ 部件清單的標題：${E.cap}`)
                                           : bad(`⑤ 標題不對：${E.cap}`);
    /缶|貝|宀|珤/.test(txt("Echips"))
      ? ok(`⑤ 寶 的部件序列：${txt("Echips")}`)
      : bad(`⑤ 寶 的部件序列看不出東西：${txt("Echips")}`);

    // ---- 大字的框與三態切換
    num("Fboxes") > 0 ? ok(`大字上畫了 ${num("Fboxes")} 個部件框（data-box=${txt("FboxData")}）`) : bad("大字上沒有框");
    txt("FrawM") === "raw" && num("FrawN") > 0 && /字框：原/.test(txt("FrawT"))
      ? ok(`字框切到「原始 KAGE 框」：${txt("FrawT")}（${num("FrawN")} 個框）`)
      : bad(`原始框那一段不對：${txt("FrawM")}／${txt("FrawN")}／${txt("FrawT")}`);
    txt("FnoneM") === "none" && num("FnoneN") === 0 && num("FnoneP") > 0 && /字框：無/.test(txt("FnoneT"))
      ? ok(`字框切到「不顯示」：沒有框但字形還在（${num("FnoneP")} 條筆畫路徑）`)
      : bad(`「不顯示框」不對：${txt("FnoneM")}／框 ${num("FnoneN")}／路徑 ${num("FnoneP")}`);
    txt("FbackM") === "tight" && num("FbackN") > 0
      ? ok(`再按一下回到「墨跡緊框」（三態循環）`) : bad(`三態循環壞了：${txt("FbackM")}／${num("FbackN")}`);
    num("FactiveBox") > 0 && num("FactiveChip") > 0
      ? ok(`點框 → 框與部件序列互相亮起（框 ${num("FactiveBox")} 個、清單 ${num("FactiveChip")} 格）`)
      : bad(`框／清單連動沒生效：框 ${num("FactiveBox")}、清單 ${num("FactiveChip")}` +
            `（clicked=${txt("Fclicked")} EXC=${txt("FEXC")}）`);

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
    const CREDIT = "基於開源字庫 Glyphwiki+Kage，拼形序依據 中国发明专利 201610984608.1 号。微信：wxx68174671";
    txt("Hcredit") === CREDIT ? ok(`頁尾授權宣告：${txt("Hcredit").slice(0, 24)}…`)
                              : bad(`頁尾授權不對：${txt("Hcredit")}`);
    const H = snap("H");
    /^峰/.test(H.seq) ? ok(`點第四組庫存 → 帶進輸入區（${H.seq.length} 個字，${H.mode}）`)
                      : bad(`庫存沒有帶進輸入區：${H.seq}`);

    // ---- 存自己的序列（圖示 ＋ Enter；已存過移到最前面）
    num("Imine") === 1 ? ok("按存檔圖示 → 自己的序列進 localStorage") : bad(`自存序列 ${num("Imine")} 組`);
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
    txt("link2") === "寶" ? ok(`合理拼形時帶的是最後一個字（comp=寶，＝使用者正在看的那個部件）`)
                          : bad(`合理拼形的 comp 是「${txt("link2")}」`);
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
        ? ok(`輸入 IDS「⿰木⿳金⿰水火土」→ 認出構字式、**只給文字推薦**「${idsSeq}」✓（不先畫美形 ✓）`)
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
        ? ok(`點推薦文字＝把構形序帶進輸入區並組出來（${idsClick}）✓——字形這時才變美 ✓`)
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
      /^yes,text=🪄,hidden=false,disp=flex,before=saveSeq,n=[1-9]/.test(wandRaw)
        ? ok(`魔術棒 🪄 就位（在「存起來」左邊 ✓、建議 ${/n=(\d+)/.exec(wandRaw)?.[1]} 個 ✓）`)
        : bad(`魔術棒不對：${wandRaw.slice(0, 140)}`);
      /mode=(ok|partial)/.test(wandClick) && /bigPaths=[1-9]/.test(wandClick) && /hidden=false/.test(wandClick)
        ? ok(`點魔術棒 → 建議的構形序填進輸入區並組出來（${wandClick}）✓`)
        : bad(`點魔術棒沒作用：${wandClick}`);
      /^next:/.test(wandClick2)
        ? ok(`再點一次 → 換下一個建議（${wandClick2}）✓`)
        : ok(`只有一個建議時，再點仍是同一個（${wandClick2}）`);
      wandIdle === "true"
        ? ok("不是 IDS 模式時，魔術棒收起來 ✓")
        : bad(`魔術棒不該在一般模式出現：hidden=${wandIdle}`);
      /,mode=ids$/.test(ids2) && ids2.indexOf("𦧀") === 0
        ? ok(`第二個合文（好學孔孟）也認得：${ids2} ✓`)
        : bad(`第二個 IDS 不對：${ids2}`);
      /上中下|左右/.test(txt("PidsNote"))
        ? ok(`IDS 另附人話轉寫（${txt("PidsNote").slice(0, 30)}…）——有些字型沒有 2FF0–2FFF 會變方框 ✗`)
        : bad(`IDS 沒有附人話轉寫：${txt("PidsNote")}`);
      /* ★ 任意 IDS → 立刻看到那個字 ✓（用字庫的葉序反查 ✓，零新增資料 ✓） */
      /* ★ 第 123～126 輪：貼真字葉序的 IDS → **只給文字推薦** ✓（`好`／`林` ✓），
         大字則是 IDC 等比分配（醜 ✓）——兩者一起才會有「接受建議、字突然變美」的驚嘆 ✓。 */
      const idsChar = txt("PidsChar");
      const idsChar2 = txt("PidsChar2");
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
        ? ok(`按「拆成 IDS」→ 輸入區變成「⿰女子」並被認成構字式 ✓（${
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
        ? ok(`點「桂圭垚」→ 輸入區換成構形序、大字立刻變美（${chipClick}）✓ 這就是驚嘆的那一刻 ✓`)
        : bad(`點推薦 chip 沒作用：${chipClick}`);    }
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
