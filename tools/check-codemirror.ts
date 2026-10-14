#!/usr/bin/env bun
/**
 * check-codemirror.ts — 驗收 `out/codemirror-kage.html`。
 *
 * 這裡驗的是**行為**，不是「檔案有沒有產生」：
 *   1. 內嵌的模組碼能在同一個作用域下編譯（兩頁都驗）——這條擋掉跨檔同名宣告
 *   2. CodeMirror 6 bundle 自己掛上 globalThis.CM6，且與 tools 模組共處一個作用域不會語法錯誤
 *   3. 內嵌的程式碼真的解得開字形庫、真的組得出字、內嵌 SVG 的三條 CSS 都在
 *   4. 語法掃描（護欄）在頁面用的那份程式碼裡行為正確
 *   5. 用 headless 瀏覽器實際跑頁面，斷言：
 *        * 不在光標的序列 → 被換成 SVG（.gc-seq 內有 <svg class="gc-inline">）
 *        * 光標所在的序列   → **還原成 ︵…︶ 純文字** ＋ 標上 .cm-seq-active
 *        * 浮窗出現、裡面有放大的字形與可替換部件按鈕
 *
 * 用法: bun run tools/check-codemirror.ts [--keep]
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const D = ROOT;
const PAGE = resolve(ROOT, "out/codemirror-kage.html");
const VIEWER = resolve(ROOT, "out/kage-viewer.html");
const CM6 = resolve(ROOT, "vendor-cm/dist/cm6.global.js");

let fail = 0;
const ok = (s: string) => console.log("  ✓ " + s);
const bad = (s: string) => { console.log("  ✗ " + s); fail++; };
const eq = (a: unknown, b: unknown, s: string) =>
  JSON.stringify(a) === JSON.stringify(b) ? ok(s) : bad(`${s}：得到 ${JSON.stringify(a)}，應為 ${JSON.stringify(b)}`);

function scriptsOf(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
}
/** 取出「引擎＋模組」那一段（不含主流程與 CM6）。
 *  標記必須與 build-codemirror-kage.ts 裡的一致——切錯位置會讓
 *  註解被截斷成「Multiline comment was not closed properly」（實際踩過）。 */
function modulesOf(scripts: string[]): string {
  const s = scripts[0]!;
  const cm = s.indexOf("/* ============================ CodeMirror 6（內嵌 IIFE）");
  return cm > 0 ? s.slice(0, cm) : s;
}

// ---------------------------------------------------------------- 1. 兩頁的內嵌碼

console.log("1. 兩個頁面的內嵌模組碼都能編譯");
for (const [name, path, modulesOnly] of [
  ["kage-viewer.html", VIEWER, true],
  ["codemirror-kage.html", PAGE, false],
] as [string, string, boolean][]) {
  if (!existsSync(path)) { bad(`${name} 不存在`); continue; }
  const html = readFileSync(path, "utf8");
  const scripts = scriptsOf(html);
  const code = modulesOnly ? modulesOf(scripts) : scripts[0]!;
  try {
    new Function(code + "\n;return 1;");
    ok(`${name}：內嵌碼語法 OK（${(code.length / 1024).toFixed(1)} KB）`);
  } catch (e) {
    bad(`${name}：內嵌碼語法錯誤 → ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------- 2. CM6 bundle

console.log("\n2. CodeMirror 6 bundle");
if (!existsSync(CM6)) bad("找不到 vendor-cm/dist/cm6.global.js（先跑 bun run vendor-cm/build.ts）");
else {
  const src = readFileSync(CM6, "utf8");
  /globalThis\.CM6\s*=/.test(src) ? ok("自己掛上 globalThis.CM6") : bad("沒有 globalThis.CM6");
  !/\bexport\s*[{*]/.test(src) ? ok("沒有 export 語句（傳統 script 才不會 SyntaxError）") : bad("殘留 export");
  try {
    // 故意放 tools 用過的名字當哨兵——就是實際撞過的那個
    new Function("const PROJ_ROOT = 1;\nconst D = 2;\n" + src + "\n;return 1;");
    ok("與 tools 模組共處一個 script 作用域不會語法錯誤（IIFE 隔離有效）");
  } catch (e) {
    bad("與 tools 模組撞名：" + (e as Error).message);
  }
}

// ---------------------------------------------------------------- 3. 內嵌碼真的能跑

console.log("\n3. 內嵌碼真的解得開字形庫、組得出字");
let api: any = null;
{
  const html = readFileSync(PAGE, "utf8");
  const scripts = scriptsOf(html);
  const engineEnd = scripts[0]!.indexOf("/* ===== 解碼 + 量測");
  // kage-engine 先進全域，Node 才畫得出來（瀏覽器裡它本來就是頂層 script）
  (0, eval)(scripts[0]!.slice(0, engineEnd));
  const mods = modulesOf(scripts);
  const b64m = /const LIB_B64 = "([^"]*)"/.exec(scripts[1]!);
  if (!b64m) bad("找不到 LIB_B64");
  else {
    try {
      api = new Function(mods + "\nreturn { decodeLibrary, findGlyphIndex, evalSeq, scanText," +
        " createSvgRenderer, listReplaceables, minCrossDistOf, INLINE_CSS, OPEN, CLOSE };")();
      const lib = api.decodeLibrary(new Uint8Array(Bun.gunzipSync(Buffer.from(b64m[1]!, "base64"))));
      eq(lib.names.length, 70416, `字形庫解碼：${lib.names.length.toLocaleString()} 字形`);
      const g = lib.glyphs[api.findGlyphIndex(lib, "u571f-j")];
      eq(g.tight, [14, 17, 186, 169], "u571f-j 緊框正確（衍生計算）");
      const r = api.evalSeq(lib, "街圭日");
      r.ok ? ok(`組字可用：${r.log.join("；")}`) : bad("組字失敗：" + r.error);
      const svg = r.ok ? api.createSvgRenderer(lib).svgForResult(r) : null;
      svg && /class="gc-inline"/.test(svg) && /currentColor/.test(svg) && /viewBox="0 0 200 200"/.test(svg)
        ? ok("內嵌 SVG 帶 gc-inline／currentColor／viewBox")
        : bad("內嵌 SVG 不正確");
      !/\swidth="/.test(svg!) ? ok("已移除 width/height（1em 縮放的前提）") : bad("還有 width/height");
      [".gc-inline", "currentColor", "1em", "vertical-align", "-0.22em", "inline-block"]
        .every((k) => api.INLINE_CSS.includes(k))
        ? ok("INLINE_CSS 六項齊全（含實測修正的 -0.22em 基線）")
        : bad("INLINE_CSS 不完整：" + api.INLINE_CSS);
    } catch (e) {
      bad("內嵌碼執行失敗：" + (e as Error).message);
    }
  }
}

// ---------------------------------------------------------------- 4. 護欄

console.log("\n4. 內文語法三條護欄");
if (!api) bad("（略過：前一項失敗）");
else {
  const lib = api.decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(resolve(D, "out/lib-cjk.bin.gz")))));
  const O = api.OPEN, C = api.CLOSE;
  const text = `內文。${O}街圭日${C}好。沒成對的${O}街圭日 不算。\n跨行${O}街圭日\n日${C}不算。${O}街行${C}太短。`;
  const segs = api.scanText(lib, text);
  const seqs = segs.filter((s: any) => s.kind === "seq");
  eq(seqs.length, 1, "只認出 1 個合法序列");
  const all = segs.map((s: any) => (s.kind === "text" ? s.text : text.slice(s.fullStart, s.fullEnd))).join("");
  eq(all, text, "掃描可完整還原原文（不丟字）");
}

// ---------------------------------------------------------------- 5. 瀏覽器實跑

console.log("\n5. 用 headless 瀏覽器實際跑頁面");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
if (!existsSync(EDGE)) {
  console.log("  ！找不到 Edge，跳過瀏覽器實跑（行為驗證請看 out/cm-*.png）");
} else {
  // 在頁面裡插入一段「驗證腳本」，把結果寫進 title，再用 --dump-dom 讀出來
  const probe = `<script>
  (function () {
    function report(t) { document.title = "PROBE|" + t; }
    var tries = 0;
    var timer = setInterval(function () {
      if (++tries > 40) { clearInterval(timer); report("TIMEOUT"); return; }
      if (typeof view === "undefined" || !view || typeof LIB === "undefined" || !LIB) return;
      clearInterval(timer);
      try {
        var out = [];
        var popEl = document.getElementById("pop");
        // 在開頭插入可辨識的哨兵，稍後用它精準定位一個序列
        var SENT = "\uE000";   // 私用區，庫裡不會有
        view.dispatch({ changes: { from: 0, insert: SENT } });
        var doc0 = view.state.doc.toString();
        var sentAt = doc0.indexOf(SENT);
        var openAt = doc0.indexOf("\uFE35", sentAt);
        var closeAt = doc0.indexOf("\uFE36", openAt);
        var selFrom = openAt, selTo = closeAt + 1;
        var line = view.state.doc.lineAt(selFrom);
        var i = 1;
        var SEQ = "\\uFE35\\u8857\\u884c\\u6708\\uFE36";  // ︵街行月︶
        view.dispatch({ selection: { anchor: line.from + i + 2 } });

        // 每一步間隔 300ms，用單層 interval 串接（多層巢狀 setTimeout 在 headless 下容易斷）
        var queue = [
          function () {
            out.push("active=" + document.querySelectorAll(".cm-seq-active").length);
            var ws = document.querySelectorAll(".gc-seq"), n = 0;
            ws.forEach(function (w) { if (w.querySelector("svg.gc-inline")) n++; });
            out.push("widgets=" + ws.length);
            out.push("widgetsWithSvg=" + n);
            out.push("popVisible=" + (getComputedStyle(popEl).display !== "none"));
            out.push("popHasSvg=" + !!document.querySelector("#pop .big svg"));
            out.push("partBtns=" + document.querySelectorAll("#parts .part").length);
            view.dispatch({ selection: { anchor: view.state.doc.line(1).from } });
          },
          function () {
            out.push("activeAfterMoveOut=" + document.querySelectorAll(".cm-seq-active").length);
            out.push("widgetsAfterMoveOut=" + document.querySelectorAll(".gc-seq").length);
            var l6 = view.state.doc.line(6), t6 = l6.text, k6 = t6.lastIndexOf("字");
            view.dispatch({ selection: { anchor: l6.from + (k6 > 0 ? k6 + 1 : t6.length - 1) } });
          },
          function () {
            var btn = document.getElementById("toggle-char");
            out.push("btnLabel=" + btn.textContent);
            out.push("pressed=" + btn.getAttribute("aria-pressed"));
            out.push("charPopOn=" + (getComputedStyle(popEl).display !== "none"));
            btn.click();
          },
          function () {
            out.push("afterOff=" + (getComputedStyle(popEl).display !== "none"));
            out.push("afterOffLabel=" + document.getElementById("toggle-char").textContent);
            out.push("afterOffPressed=" + document.getElementById("toggle-char").getAttribute("aria-pressed"));
            view.dispatch({ selection: { anchor: line.from + i + 2 } });
          },
          function () {
            out.push("seqPopStillOn=" + (getComputedStyle(popEl).display !== "none"));
            document.getElementById("toggle-char").click();
          },
          function () {
            out.push("afterOnLabel=" + document.getElementById("toggle-char").textContent);
            var pr = popEl.getBoundingClientRect();
            out.push("popRect=" + Math.round(pr.left) + "," + Math.round(pr.top) +
                     "," + Math.round(pr.width) + "," + Math.round(pr.height));
            out.push("vw=" + document.documentElement.clientWidth);
            out.push("vh=" + document.documentElement.clientHeight);
            view.dispatch({ selection: { anchor: view.state.doc.line(1).from } });
          },
          function () {
            // 先把光標移到文首（離開序列）→ 序列回到 SVG 模式，這才是要測的情境
            view.dispatch({ selection: { anchor: 0 } });
          },
          function () {
            view.dispatch({ selection: { anchor: selFrom, head: selTo } });
            out.push("selWasSvg=" + (document.querySelectorAll(".cm-seq-active").length === 0));
            out.push("selHeadInside=" + (function () {
              var h = view.state.selection.main.head;
              return (selFrom <= h && h <= selTo);
            })());
            window.__capT = null; window.__capH = null;
            // 掛在 contentDOM 上（且比頁面的處理器晚註冊 → 同元素、後執行），
            // 這樣才讀得到頁面剛寫入的內容。
            // （掛在 document 的 capture 會**先**跑，那時 clipboardData 還是空的。）
            window.__capListener = function (ev) {
              window.__capT = ev.clipboardData.getData("text/plain");
              window.__capH = ev.clipboardData.getData("text/html");
            };
            view.contentDOM.addEventListener("copy", window.__capListener, true);
            view.contentDOM.dispatchEvent(new ClipboardEvent("copy", {
              clipboardData: new DataTransfer(), bubbles: true, cancelable: true }));
            view.contentDOM.removeEventListener("copy", window.__capListener, true);
          },
          function () {
            var __rec = window.__gcLastCopy;
            var __t = window.__capT || (__rec && __rec.text) || (typeof __rec === "string" ? __rec : null);
            var __h = window.__capH || (__rec && __rec.html) || null;
            out.push("copyText=" + JSON.stringify(__t));
            out.push("copyHasSvg=" + (!!__h && /class="gc-inline"/.test(__h)));
            out.push("copyHasSeq=" + (!!__h && __h.indexOf("街圭日") >= 0));
          },
          function () {
            try {
              var before = view.state.doc.toString();
              view.dispatch({ selection: { anchor: view.state.doc.line(1).to } });
              var dt2 = new DataTransfer();
              dt2.setData("text/plain", SEQ);
              view.contentDOM.dispatchEvent(new ClipboardEvent("paste", {
                clipboardData: dt2, bubbles: true, cancelable: true }));
              var after = view.state.doc.toString();
              out.push("pasteInserted=" + (after.length > before.length));
              out.push("pasteHasSeq=" + (after.indexOf(SEQ) >= 0));
              out.push("pasteCount=" + (after.split(SEQ).length - 1));
              out.push("pasteDelta=" + (after.length - before.length) + "/" + SEQ.length);
              view.dispatch({ selection: { anchor: view.state.doc.line(1).from } });
            } catch (e2) { out.push("pasteExc=" + e2.message); }
          },
          function () {
            out.push("pastedRendered=" + (document.querySelectorAll(".gc-seq").length > 8));
            report(out.join(" "));
          }
        ];
        var qi = 0;
        var tick = setInterval(function () {
          if (qi >= queue.length) { clearInterval(tick); return; }
          try { queue[qi++](); } catch (e) { out.push("STEP" + qi + "EXC:" + e.message); }
        }, 300);
      } catch (e) { report("EXC:" + e.message); }
    }, 250);
  })();
  <\/script>`;
  const diagPath = resolve(D, "out/_cmpobe.html");
  writeFileSync(diagPath, readFileSync(PAGE, "utf8").replace("</body>", probe + "</body>"));

  const proc = Bun.spawnSync([
    EDGE, "--headless=new", "--disable-gpu", "--virtual-time-budget=60000",
    "--dump-dom", "file:///" + diagPath.replace(/\\/g, "/"),
  ], { stdout: "pipe", stderr: "ignore" });
  const dom = new TextDecoder().decode(proc.stdout);
  const m = /<title>PROBE\|([^<]*)<\/title>/.exec(dom);
  if (!m) bad("瀏覽器沒有回報結果（title 找不到 PROBE）");
  else {
    const r = m[1]!;
    console.log("  瀏覽器回報：" + r);
    const num = (k: string) => Number(new RegExp(k + "=(-?\\d+)").exec(r)?.[1] ?? "NaN");
    num("active") >= 1 ? ok("光標所在的序列標上了 .cm-seq-active（還原成文字）")
                       : bad("沒有 .cm-seq-active");
    num("widgets") >= 1 && num("widgetsWithSvg") === num("widgets")
      ? ok(`${num("widgets")} 個不在光標的序列都換成了內嵌 SVG`)
      : bad(`序列 widget 數 ${num("widgets")}，其中有 SVG 的 ${num("widgetsWithSvg")}`);
    r.includes("popVisible=true") ? ok("浮窗有出現") : bad("浮窗沒有出現");
    r.includes("popHasSvg=true") ? ok("浮窗裡有放大的字形") : bad("浮窗裡沒有字形");
    num("partBtns") >= 1 ? ok(`浮窗列出 ${num("partBtns")} 個可替換部件按鈕`)
                         : bad("浮窗沒有可替換部件按鈕");
    num("activeAfterMoveOut") === 0 ? ok("光標移開後，序列還原成 SVG（不再標記）")
                                    : bad("光標移開後仍標記為 active");
    // ---- 正常字浮窗的開關 ----
    /charPopOn=true/.test(r)
      ? ok("光標在可組字的正常字後面時，浮窗有出現")
      : bad("光標在正常字後面時浮窗沒有出現");
    /btnLabel=正常字浮窗：開/.test(r) && /pressed=true/.test(r)
      ? ok("開關初始為「開」")
      : bad("開關初始狀態不對：" + (/(btnLabel=[^\s]*)/.exec(r)?.[1] ?? "?"));
    /afterOff=false/.test(r)
      ? ok("按一下 → 正常字浮窗關掉（不出現）")
      : bad("關掉之後浮窗仍然出現");
    /afterOffLabel=正常字浮窗：關/.test(r) && /afterOffPressed=false/.test(r)
      ? ok("按鈕文字與 aria-pressed 都跟著更新")
      : bad("按鈕狀態沒有更新");
    /seqPopStillOn=true/.test(r)
      ? ok("關掉之後，光標在序列內的浮窗仍照常出現（編輯序列時必要）")
      : bad("關掉之後連序列內的浮窗都不見了");
    /afterOnLabel=正常字浮窗：開/.test(r) ? ok("再按一下 → 恢復為「開」") : bad("無法切回開");
    // ---- 浮窗不可被視窗裁掉 ----
    {
      const rt = /popRect=(-?\d+),(-?\d+),(\d+),(\d+)/.exec(r);
      if (!rt) bad("拿不到浮窗位置");
      else {
        const [_, L, T, W, H] = rt.map(Number) as unknown as [string, number, number, number, number];
        const vw = Number(/vw=(\d+)/.exec(r)?.[1] ?? 0);
        const vh = Number(/vh=(\d+)/.exec(r)?.[1] ?? 0);
        L >= 0 && T >= 0 && L + W <= vw + 1 && T + H <= vh + 1
          ? ok(`浮窗完全在視窗內（${L},${T} ${W}×${H}　視窗 ${vw}×${vh}）`)
          : bad(`浮窗被裁掉：${L},${T} ${W}×${H}　視窗 ${vw}×${vh}`);
      }
    }
    // ---- 剪貼簿：像一般文字那樣複製、貼上 ----
    /copyText="︵街圭日︶"/.test(r)
      ? ok("複製時頁面確實寫入了構形序列純文字")
      : bad("頁面沒有寫入構形序列：" + (/copyText=[^ ]*/.exec(r)?.[0] ?? "?") );
    {
      const ct = /copyText=("(?:[^"\\]|\\.)*")/.exec(r);
      const text = ct ? JSON.parse(ct[1]!) : null;
      text === "︵街圭日︶"
        ? ok(`複製得到構形序列純文字：${JSON.stringify(text)}（不是空白、不是圖）`)
        : bad(`複製得到 ${JSON.stringify(text)}，應為 "︵街圭日︶"`);
    }
    /copyHasSvg=true/.test(r) && /copyHasSeq=true/.test(r)
      ? ok("同時寫入 text/html：序列是內嵌 SVG、屬性仍帶著構形序列（可貼到 Office 等處）")
      : bad("text/html 格式不正確（貼到支援 HTML 的地方看不到字形）");
    /pasteInserted=true/.test(r) && /pasteHasSeq=true/.test(r)
      ? ok("貼上把構形序列寫回 doc")
      : bad("貼上沒有寫入構形序列");
    {
      const d = /pasteDelta=(\d+)\/(\d+)/.exec(r);
      const got = Number(d?.[1] ?? -1), want = Number(d?.[2] ?? -1);
      got === want
        ? ok(`貼上只插入一次（doc 長度增加 ${got}，正好是序列長度）`)
        : bad(`貼上長度不對：增加 ${got}，應為 ${want}`);
    }
    /pastedRendered=true/.test(r)
      ? ok("貼上的序列立刻被換成合成字形（走同一條裝飾管線）")
      : bad("貼上的序列沒有被渲染");
  }
  if (!Bun.argv.includes("--keep")) { try { unlinkSync(diagPath); } catch {} }
}

console.log(fail === 0 ? "\n全部通過" : `\n有 ${fail} 項失敗`);
process.exit(fail === 0 ? 0 : 1);
