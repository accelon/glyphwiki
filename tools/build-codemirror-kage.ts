#!/usr/bin/env bun
/**
 * build-codemirror-kage.ts — 產生離線單一網頁 `out/codemirror-kage.html`：
 * **用 CodeMirror 6 呈現「自由組字」的編輯場景。**
 *
 * 與 `build-kage-viewer.ts`（單純的字形檢視）是兩支獨立的頁面，互不影響。
 *
 * 行為（師父定案）：
 *   * 文中**所有**構形序列就地換成內嵌 SVG（正常閱讀）
 *   * **光標所在的那一個**還原成 `︵…︶` 純文字（這樣才改得動），
 *     同時在浮窗裡放大預覽它
 *   * 光標在序列右邊時，浮窗下方列出可替換部件（字形預覽按鈕，含層級）
 *   * doc 裡永遠是 `︵…︶` 純文字 → 複製出去是構形序列、可刪可還原（提案第 0 條／第 4、5 條）
 *
 * 內嵌來源：
 *   * kage-engine（原始碼）
 *   * tools/{lib-format,lib-measure,box-dictionary,compose-fit,free-compose,stroke-overlap}.ts 原文
 *   * vendor-cm/dist/cm6.iife.js（CodeMirror 6，`bun run vendor-cm/build.ts` 產生）
 *   * out/lib-cjk.bin.gz（base64）
 *
 * 用法: bun run tools/build-codemirror-kage.ts [--out out/codemirror-kage.html]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = resolve(ROOT, "out/codemirror-kage.html");
const LIB_GZ = resolve(ROOT, "out/lib-cjk.bin.gz");
const ENGINE_DIR = resolve(ROOT, "kage-engine");
const CM6_JS = resolve(ROOT, "vendor-cm/dist/cm6.global.js");

if (!existsSync(CM6_JS)) {
  console.error(`找不到 ${CM6_JS}\n請先執行： bun run vendor-cm/build.ts`);
  process.exit(1);
}

const ENGINE_FILES = ["2d.js", "buhin.js", "curve.js", "kage.js", "kagecd.js", "kagedf.js", "polygon.js", "polygons.js"];
const engineSrc = ENGINE_FILES.map((f) => readFileSync(resolve(ENGINE_DIR, f), "utf8")).join("\n");

// 內嵌「格式 + 量測 + 框字典 + 組字 + 自由組字語法 + 品質量測」六個模組的原文。
// 只有一份實作（與 Node 端共用），不會各說各話。
const MODULES = [
  "tools/lib-format.ts",
  "tools/lib-measure.ts",
  "tools/box-dictionary.ts",
  "tools/compose-fit.ts",
  "tools/free-compose.ts",
  "tools/stroke-overlap.ts",
];
const transpiler = new Bun.Transpiler({ loader: "ts" });
const stripExports = (s: string) => s.replace(/\bexport\s+/g, "");
const stripCli = (s: string) => {
  const i = s.indexOf("if (import.meta.main)");
  return i >= 0 ? s.slice(0, i) : s;
};
const bundleSrc = MODULES
  .map((rel) => stripCli(stripExports(transpiler.transformSync(readFileSync(resolve(ROOT, rel), "utf8")))))
  .map((s) => s
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/function ensureEngine\([^)]*\)\s*\{[\s\S]*?\n\}/, "function ensureEngine() {}"))
  .join("\n");

/**
 * 內嵌前把「模組碼」單獨語法檢查一次。
 *
 * 為什麼必要：各模組的 export 被拿掉之後全部接在同一個 script 作用域，
 * 只要兩個檔案有同名的 `const`／`let`／`class`，就是 SyntaxError，
 * **整個 script 都不執行**——頁面完全空白，而且沒有任何錯誤訊息。
 * 實際踩過：`compose-fit.ts` 與 `stroke-overlap.ts` 各有一個 `const D`。
 * 寧可在此 exit 1，也不要產生一片空白的網頁。
 */
function assertModuleSyntax(src: string): void {
  // 這個檢查只需要語法合法，不需要真的跑，所以補一個回傳值避免「未定義」以外的干擾
  new Function(src + "\n;return 1;");
}
assertModuleSyntax(bundleSrc);

const cm6Src = readFileSync(CM6_JS, "utf8");
const libB64 = readFileSync(LIB_GZ).toString("base64");

// 整段 <script>（引擎＋模組＋CM6）也要能通過語法檢查。
// 這一關擋掉的是「兩個檔案同名宣告」這類跨檔衝突——它們只在合併後才看得出來。
{
  const whole = engineSrc + "\n" + bundleSrc + "\n" + cm6Src;
  try {
    new Function(whole + "\n;return 1;");
  } catch (e) {
    console.error("合併後的 script 語法錯誤（內嵌會讓整頁空白）：" + (e as Error).message);
    process.exit(1);
  }
}

const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>自由組字編輯器（CodeMirror 6，離線單頁）</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px;
    font: 14px/1.6 system-ui, "Segoe UI", "Microsoft JhengHei", sans-serif;
    background: #f7f7f8; color: #222;
  }
  h1 { font-size: 17px; margin: 0 0 4px; font-weight: 600; }
  .sub { font-size: 13px; color: #666; margin-bottom: 12px; }
  .panel { background: #fff; border: 1px solid #e2e5ea; border-radius: 12px; padding: 12px; margin-bottom: 14px; }
  .bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; font-size: 13px; }
  label { display: inline-flex; align-items: center; gap: 5px; }
  select, input[type=number], input[type=color] { padding: 5px 7px; border: 1px solid #ccd0d6; border-radius: 6px; background: #fff; color: inherit; font-size: 13px; }
  input[type=number] { width: 72px; }
  button { padding: 6px 11px; font-size: 13px; border: 1px solid #ccd0d6; border-radius: 6px; background: #fff; color: inherit; cursor: pointer; }
  button:hover { background: #eef0f3; }
  code { background: #eef0f3; padding: 1px 4px; border-radius: 4px; font-size: 12px; }

  /* ---------- 內嵌 SVG：顏色／大小／基線三條 ---------- */
  .gc-inline { fill: currentColor; width: 1em; height: 1em; vertical-align: -0.22em; display: inline-block; }

  /* ---------- CodeMirror ---------- */
  #editor { border: 1px solid #d7dbe2; border-radius: 8px; background: #fff; overflow: hidden; }
  .cm-editor { font-family: "PMingLiU", "MingLiU", "Songti TC", serif; font-size: 26px; }
  .cm-editor.cm-focused { outline: none; }
  .cm-content { padding: 12px 14px; line-height: 1.75; caret-color: #06c; }
  .cm-line { padding: 0; }
  .cm-cursor { border-left: 2px solid #06c; }
  /* 光標所在的序列：還原成純文字（widget 被拿掉），標一個淡淡的底 */
  .cm-seq-active { background: #fff4d6; border-radius: 3px; box-shadow: 0 0 0 1px #f0d79a inset; }
  .cm-seq-err { color: #b3261e; border-bottom: 2px dotted #b3261e; }

  /* ---------- 浮窗預覽 ---------- */
  /* 用 fixed 定位：座標就是 viewport 座標，不必管捲動，也不會被裁掉 */
  #pop {
    position: fixed; z-index: 50; display: none;
    background: #fff; border: 1px solid #cfd6e0; border-radius: 12px;
    box-shadow: 0 8px 26px rgba(0,0,0,.16); padding: 10px 12px;
    max-height: 80vh; overflow: auto;
  }
  /* 開關關掉時，只有「正常字浮窗」不出現；序列內的編輯浮窗照常 */
  button[aria-pressed="false"] { opacity: .55; background: #f1f3f6; }
  #pop .big { font-family: "PMingLiU", "MingLiU", serif; line-height: 1; color: #111; }
  #pop .big svg { width: 1em; height: 1em; display: block; }
  #pop .cap { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: #777; margin-top: 6px; max-width: 320px; word-break: break-all; }
  #pop .bad { color: #b3261e; }
  #pop .ok { color: #0a7a2f; }
  #parts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; max-width: 340px; }
  .part {
    display: flex; flex-direction: column; align-items: center; gap: 1px;
    border: 1px solid #d7dbe2; border-radius: 7px; padding: 4px 6px; background: #fff; cursor: pointer; min-width: 50px;
  }
  .part:hover { border-color: #7aa7ff; background: #eef4ff; }
  .part svg { width: 26px; height: 26px; fill: currentColor; }
  .part .lvl { font-size: 9px; color: #888; }
  #pop .hint { font-size: 11px; color: #888; margin-top: 6px; max-width: 340px; }

  #status { font-size: 12px; color: #666; margin-top: 8px; }
  details { font-size: 13px; margin-top: 14px; }
  summary { cursor: pointer; }
</style>
</head>
<body>
<h1>自由組字編輯器</h1>
<div class="sub">
  CodeMirror 6 ｜文中所有構形序列就地換成內嵌 SVG；<b>光標所在的那一個還原成 <code>︵…︶</code> 純文字</b>並在浮窗放大預覽。
  doc 裡永遠是純文字，所以複製出去是構形序列、可以刪、可以還原修改。
</div>

<div class="panel">
  <div class="bar">
    <label>字級 <input id="fsize" type="number" min="14" max="72" value="26" step="2"></label>
    <label>字體
      <select id="face">
        <option value="PMingLiU","MingLiU","Songti TC",serif>明體</option>
        <option value=system-ui,"Microsoft JhengHei",sans-serif>黑體</option>
      </select>
    </label>
    <label>顏色 <input id="color" type="color" value="#222222"></label>
    <label>浮窗字級 <input id="psize" type="number" min="40" max="240" value="96" step="8"></label>
    <button id="toggle-char" aria-pressed="true">正常字浮窗：開</button>
    <button id="ins">插入構形序列</button>
    <button id="reset">還原範例</button>
  </div>
  <div id="editor"></div>
  <div id="status">載入字形庫…</div>
</div>

<details>
  <summary>怎麼運作（語意、光標行為、護欄、資料與授權）</summary>
  <p>
    <b>構形序列的語意</b>（依 <code>format.md</code>「進階任務 2」）：
    <code>峰夆電雨水</code> ＝ 峰 中的「夆」替換為「電雨水」，而「電雨水」＝ 電 上方的「雨」改為「水」。
    規則為 <b>基字 ＋ 舊部件 ＋ 新內容…</b>，新內容本身可以再是一個構形序列（遞歸）。
  </p>
  <p>
    <b>內文語法與三條護欄</b>：寫在 <code>︵</code> U+FE35 與 <code>︶</code> U+FE36 之間，
    <b>必須成對、不跨行、長度 ≤ 12 個部件</b>。三條都成立才當成構形序列，
    否則原樣顯示純文字（不會吃掉內文）。
  </p>
  <p>
    <b>光標行為</b>：光標進入某個序列時，那一個還原成 <code>︵…︶</code> 以便編輯，
    其餘仍顯示合成字形；浮窗同時放大預覽光標那一個。光標在序列右邊時，
    浮窗下方列出該字可替換的部件（字形預覽按鈕）——像 <code>彳</code>、<code>亍</code>
    這類拼音打不出來的部件，只能用點的。
  </p>
  <p>
    <b>資料與授權</b>：內嵌 <a href="https://glyphwiki.org/">GlyphWiki</a> 公開字形資料
    （精簡庫 70,416 字形）與其 kage-engine（授權見 <code>kage-engine/COPYING</code>）。
    CodeMirror 6 為 Marijn Haverbeke 等著作（MIT），已打包內嵌，離線可用，不連 CDN。
    解碼／組字／語法共用 <code>tools/*.ts</code> 同一份原文。
  </p>
</details>

<div id="pop"><div class="big"></div><div class="cap"></div><div id="parts"></div><div class="hint"></div></div>

<script>
/* ============================ kage-engine（內嵌） ============================ */
${engineSrc}

/* ===== 解碼 + 量測 + 組字 + 自由組字語法 + 品質量測（內嵌 tools/*.ts 原文） ===== */
${bundleSrc}

/* ============================ CodeMirror 6（內嵌 IIFE） ============================ */
${cm6Src}
</script>

<script>
/* ============================ 主流程 ============================ */
const LIB_B64 = "${libB64}";
let LIB = null, R = null;

function gunzip(raw) {
  if (typeof DecompressionStream === "function") {
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  return Promise.reject(new Error("此瀏覽器不支援 DecompressionStream"));
}

/* ------------------------------------------------------------------ 語法掃描
 * 回傳這一行的所有序列：{ from, to, expr, result }
 * 護欄：成對、不跨行、長度 ≤ MAX_PARTS（由 free-compose 的 scanText 負責）
 */
function scanLine(state, lineNo) {
  const line = state.doc.line(lineNo);
  const segs = scanText(LIB, line.text);
  const out = [];
  let off = 0;
  for (const s of segs) {
    if (s.kind !== "seq") continue;
    out.push({
      from: line.from + s.fullStart,
      to: line.from + s.fullEnd,
      expr: s.expr,
      result: s.result,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ 裝飾
 * 每個序列：
 *   光標不在裡面 → Decoration.replace 換成內嵌 SVG widget
 *   光標在裡面   → 不換（保留 ︵…︶ 純文字）＋ 標上 .cm-seq-active
 * 少於 3 個部件或組不成 → 標 .cm-seq-err，原樣顯示
 */
class GlyphWidget extends CM6.WidgetType {
  constructor(svg, expr) { super(); this.svg = svg; this.expr = expr; }
  eq(o) { return o.svg === this.svg; }
  toDOM() {
    const w = document.createElement("span");
    // 明確指定 inline：widget 預設可能被當成 block，會被擠到自己的行
    // （實際發生過：一行 8 個序列變成 8 行）
    w.setAttribute("style", "display:inline;white-space:nowrap");
    w.className = "gc-seq";
    w.title = this.expr;
    w.innerHTML = this.svg;
    return w;
  }
  ignoreEvent() { return false; }   // 讓點擊能穿透到編輯器（把光標移進去）
}

const seqDeco = CM6.ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged || u.selectionSet ||
        u.startState.doc.length !== u.state.doc.length) {
      this.decorations = this.build(u.view);
    }
  }
  build(view) {
    const st = view.state;
    const ranges = [];
    // **只依光標（head）判斷**，不看整個選取範圍。
    // 用範圍判斷的話，只要拖曳選取碰到序列就會把它變成可編輯文字
    // ——複製時就是「畫面上是文字」，而實際要複製的常常是已經合成好的字形。
    const head = st.selection.main.head;
    for (let ln = 1; ln <= st.doc.lines; ln++) {
      for (const s of scanLine(st, ln)) {
        const hasCursor = s.from <= head && head <= s.to;
        if (!s.result.ok) {
          ranges.push(CM6.Decoration.mark({ class: "cm-seq-err" }).range(s.from, s.to));
          continue;
        }
        const svg = R.svgForResult(s.result);
        if (!svg) continue;
        if (hasCursor) {
          // 光標在這裡 → 不換掉，讓 ︵…︶ 保持可編輯，只標個底色
          ranges.push(CM6.Decoration.mark({ class: "cm-seq-active" }).range(s.from, s.to));
        } else {
          ranges.push(CM6.Decoration.replace({ widget: new GlyphWidget(svg, s.expr) })
            .range(s.from, s.to));
        }
      }
    }
    // 用 Decoration.set 而不是 RangeSetBuilder：builder 的 add() 有兩種重載
    // （add(from,to,value) 與 add(range,value)），混用會靜默不生效
    // ——實際踩過，整排序列都沒被換掉卻沒有任何錯誤。
    return CM6.Decoration.set(ranges, true);
  }
}, { decorations: (v) => v.decorations });

/* ------------------------------------------------------------------ 剪貼簿
 *
 * 為什麼一定要自己接管 copy：
 * 序列被 Decoration.replace 換成 SVG widget 之後，**DOM 選取範圍裡沒有文字**
 * （widget 的 textContent 只有換行）。實測：只選一個 ︵街圭日︶ 時
 * getSelection().toString() 會拿到空白，複製出去就是一片空白。
 * 所以在 copy 事件裡**直接寫 doc 的文字**，不讓瀏覽器從 DOM 推斷。
 *
 * 兩種格式都寫：
 *   text/plain → 就是 ︵街圭日︶（構形序列本身）。貼回本編輯器、貼進純文字
 *                編輯器都成立，而且可以再編輯（提案第 0 條）。
 *   text/html  → 同一段文字，但序列的部分是內嵌 SVG。
 *                貼到支援 HTML 的地方（Office、網頁、Obsidian）會顯示合成字形。
 *                這也讓「看起來像一個字」與「底層是序列」同時成立。
 */
function buildRichHtml(from, to) {
  const parts = [];
  for (const seg of scanText(LIB, view.state.sliceDoc(from, to))) {
    if (seg.kind === "text") {
      parts.push(escapeHtml(seg.text));
      continue;
    }
    const svg = seg.result.ok ? R.svgForResult(seg.result) : null;
    if (!svg) { parts.push(escapeHtml("︵" + seg.expr + "︶")); continue; }
    // 序列的部分是內嵌 SVG，並保留構形序列為 title（滑上去看得到原始序列）
    parts.push('<span class="gc-inline" style="display:inline-block" title="' +
      escapeAttr(seg.expr) + '">' + svg + "</span>");
  }
  // 用單引號組字串、CSS 用雙引號；不要出現跳脫引號（在 template literal 裡很容易出錯）
  const fontStack = 'PMingLiU,MingLiU,Songti TC,serif';
  return '<div style="font-family:' + fontStack + '">' + parts.join("") + "</div>";
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

/** 貼上的文字：正規化空白，並把「看起來像空白」的字元換成一般空格 */
function normalizePasted(s) {
  return s
    .replace(/[\\u00a0\\u3000\\u2000-\\u200b\\ufeff]/g, " ")
    .replace(/\\r\\n?/g, "\\n");
}
function installClipboard() {
  const dom = view.contentDOM;
  // 用 capture 確保比 CodeMirror 自己的處理器先跑
  dom.addEventListener("copy", function (e) {
    const sel = view.state.selection.main;
    if (sel.empty) return;                    // 沒選東西 → 交還瀏覽器
    const from = Math.min(sel.from, sel.to);
    const to = Math.max(sel.from, sel.to);
    // **關鍵**：文字直接取自 doc，不從 DOM 推斷
    const text = view.state.sliceDoc(from, to);
    e.clipboardData.setData("text/plain", text);
    try { e.clipboardData.setData("text/html", buildRichHtml(from, to)); } catch (err) { /* 不支援就算了 */ }
    // 供驗收／除錯確認這次到底寫了什麼。下一行的 stopImmediatePropagation() 會擋掉
    // 同一元素上後註冊的監聽器，所以外部只能在這裡留紀錄。
    window.__gcLastCopy = {
      text: text,
      html: (function () { try { return e.clipboardData.getData("text/html"); } catch (err2) { return null; } })(),
    };
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  dom.addEventListener("cut", function (e) {
    const sel = view.state.selection.main;
    if (sel.empty) return;
    const from = Math.min(sel.from, sel.to);
    const to = Math.max(sel.from, sel.to);
    e.clipboardData.setData("text/plain", view.state.sliceDoc(from, to));
    try { e.clipboardData.setData("text/html", buildRichHtml(from, to)); } catch (err) { /* 略 */ }
    e.preventDefault();
    e.stopImmediatePropagation();
    view.dispatch({ changes: { from, to, insert: "" }, selection: { anchor: from } });
  }, true);

  dom.addEventListener("paste", function (e) {
    const dt = e.clipboardData;
    if (!dt) return;
    // 一律只取純文字（構形序列），忽略 HTML——這樣貼進來一定是可再編輯的序列
    const raw = dt.getData("text/plain");
    if (!raw) return;
    // 必須擋掉 CodeMirror 自己的貼上處理器，否則會插入兩次。
    // 注意：stopPropagation() 只擋「別的元素」，同一個元素上的其他監聽器仍會跑，
    // 而 CM6 的 paste 監聽器也在 contentDOM 上——所以要用 stopImmediatePropagation()。
    e.preventDefault();
    e.stopImmediatePropagation();
    const sel = view.state.selection.main;
    const text = normalizePasted(raw);
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
      scrollIntoView: true,
      userEvent: "input.paste",
    });
  }, true);
}

/* ------------------------------------------------------------------ 浮窗 */

const pop = document.getElementById("pop");
const popBig = pop.querySelector(".big");
const popCap = pop.querySelector(".cap");
const popParts = document.getElementById("parts");
const popHint = pop.querySelector(".hint");

let composing = false;   // IME 組字中不做裝飾相關的重算
/**
 * 「正常字浮窗」開關。
 *   true  —— 光標停在普通文字後面時，只要左邊的字可組字，就顯示浮窗（含部件按鈕）
 *   false —— 這種情況不顯示浮窗
 *
 * **不影響**「光標在構形序列裡面」的浮窗：那一個是編輯序列時必要的
 * （序列已還原成文字，看不到合成結果），關掉就沒得看了。
 */
let charPopEnabled = true;

/** 光標所在的那個序列（含只有開括號、還沒收尾的情況 → 列出可組字的字） */
function seqAtCursor(state) {
  const pos = state.selection.main.head;
  for (let ln = 1; ln <= state.doc.lines; ln++) {
    const line = state.doc.line(ln);
    if (pos < line.from || pos > line.to) continue;
    for (const s of scanLine(state, ln)) {
      if (s.from <= pos && pos <= s.to) return s;
    }
  }
  return null;
}

/** 光標左邊那個可當基字的漢字 */
function charBeforeCursor(state) {
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const before = state.sliceDoc(line.from, pos);
  const chars = Array.from(before);
  for (let i = chars.length - 1; i >= 0; i--) {
    const c = chars[i];
    const cp = c.codePointAt(0);
    if (cp === 0xFE35 || cp === 0xFE36) break;
    if (cp >= 0x2E80) return { ch: c, from: pos - c.length };
    if (!/\\s/.test(c)) break;
  }
  return null;
}

/**
 * 把浮窗放在光標附近。
 *
 * 浮窗是 position:fixed，所以這裡用的都是 **viewport 座標**
 * （coordsAtPos 給的也是 viewport 座標），不必管捲動。
 * 下方空間不夠就翻到游標**上方**，左右也會夾在視窗內
 * ——先前固定往右下放，靠頁面底部的字會被切掉一半。
 */
function placePop(pos) {
  const c = view.coordsAtPos(pos);
  if (!c) { pop.style.display = "none"; return; }
  pop.style.display = "block";              // 先顯示才量得到大小
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const GAP = 8;

  let left = c.left + 8;   // 稍微偏右，避免整個蓋住光標那個字
  if (left + w > vw - GAP) left = vw - w - GAP;
  if (left < GAP) left = GAP;

  // 預設放下方；不夠就翻到上方
  let top = c.bottom + GAP;
  if (top + h > vh - GAP) {
    const above = c.top - GAP - h;
    top = above >= GAP ? above : Math.max(GAP, vh - h - GAP);
  }
  pop.style.left = left + "px";
  pop.style.top = top + "px";
}

function renderPop() {
  if (!LIB || !R || composing) return;
  const st = view.state;
  const psize = Number(document.getElementById("psize").value) || 96;
  popBig.style.fontSize = psize + "px";
  popParts.textContent = "";
  popHint.textContent = "";

  const seq = seqAtCursor(st);
  if (seq) {
    if (!seq.result.ok) {
      popBig.textContent = "✗";
      popBig.style.fontSize = (psize * 0.5) + "px";
      popCap.className = "cap bad";
      popCap.textContent = "︵" + seq.expr + "︶　" + seq.result.error;
      placePop(seq.from);
      return;
    }
    const svg = R.svgForResult(seq.result);
    popBig.style.fontSize = psize + "px";
    popBig.innerHTML = svg || "✗";
    popCap.className = "cap";
    popCap.textContent = seq.expr + "　" + seq.result.log.join("；");
    // 這個序列「舊部件」的槽位還能換什麼 → 列出同一級的其他部件
    const base = seq.expr[0];
    const bi = findGlyphIndex(LIB, "u" + base.codePointAt(0).toString(16));
    if (bi !== undefined) {
      const list = listReplaceables(LIB, bi);
      for (const r of list) {
        const b = document.createElement("div");
        b.className = "part";
        b.title = "把「" + base + "」的 " + r.ch + " 換掉（層級 " + r.level + "）";
        b.innerHTML = (R.svgOfIdx(r.idx) || "?") +
          '<span class="lvl">L' + r.level + " " + r.ch + "</span>";
        b.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          // 點下去 → 把光標移到序列內容之後，讓使用者接著打新部件
          const inside = seq.to - 1;
          view.dispatch({ selection: { anchor: inside }, scrollIntoView: true });
          view.focus();
        });
        popParts.appendChild(b);
      }
    }
    popHint.textContent = "光標在這個序列裡，所以它顯示成純文字以便編輯；移開光標就會合成字形。";
    placePop(seq.from);
    return;
  }

  // 光標不在序列裡：如果左邊是可組字的字，就顯示「開始組字」——
  // 這一段受開關控制（charPopEnabled）。
  if (!charPopEnabled) { pop.style.display = "none"; return; }
  const at = charBeforeCursor(st);
  if (!at) { pop.style.display = "none"; return; }
  const bi = findGlyphIndex(LIB, "u" + at.ch.codePointAt(0).toString(16));
  if (bi === undefined) { pop.style.display = "none"; return; }
  const list = listReplaceables(LIB, bi);
  if (list.length === 0) { pop.style.display = "none"; return; }

  popBig.style.fontSize = psize + "px";
  popBig.innerHTML = R.svgOfIdx(bi) || "✗";
  popCap.className = "cap";
  popCap.textContent = at.ch + "（" + LIB.names[bi] + "）可以組字：點一個部件，會在光標處插入「" + at.ch + "＋該部件」";
  for (const r of list) {
    const b = document.createElement("div");
    b.className = "part";
    b.title = "將「" + at.ch + "」的 " + r.ch + " 插入（層級 " + r.level + "，出現 " + r.count + " 次）";
    b.innerHTML = (R.svgOfIdx(r.idx) || "?") +
      '<span class="lvl">L' + r.level + " " + r.ch + "</span>";
    b.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      const ins = at.ch + r.ch;
      view.dispatch({
        changes: { from: at.from, to: at.from + at.ch.length, insert: ins },
        selection: { anchor: at.from + ins.length },
        scrollIntoView: true,
      });
      view.focus();
      popHint.textContent = "已插入「" + ins + "」——接著打新部件，再補上 ︵︶ 就會合成。";
    });
    popParts.appendChild(b);
  }
  popHint.textContent = "或者直接在文中打 ︵…︶ 構形序列。";
  placePop(st.selection.main.head);
}

/* ------------------------------------------------------------------ 建立編輯器 */

const SAMPLE = [
  "正常文字用系統字形，碰到構形序列才調用組字引擎。",
  "",
  "︵街圭日︶　︵街行月︶　︵寶貝山︶　︵清青日︶　︵字宀口︶　︵盟明口︶　︵地也日︶　︵話舌日︶",
  "",
  "把光標移到某個序列裡面：那一個會還原成 ︵…︶ 純文字，浮窗同時放大預覽，",
  "右邊（或下方）列出可替換的部件。移開光標，它又變回合成字形。",
  "",
  "護欄示範（不觸發）：未成對的 ︵街圭日　與太短的 ︵街行︶",
].join("\\n");

let view = null;

function buildEditor() {
  const theme = CM6.EditorView.theme({
    "&": { backgroundColor: "#fff" },
    ".cm-scroller": { overflow: "auto", maxHeight: "46vh" },
  });

  const state = CM6.EditorState.create({
    doc: SAMPLE,
    extensions: [
      CM6.history(),
      CM6.drawSelection(),
      CM6.highlightActiveLine(),
      CM6.highlightSpecialChars(),
      CM6.keymap.of([...CM6.defaultKeymap, ...CM6.historyKeymap, CM6.indentWithTab]),
      CM6.EditorView.lineWrapping,
      theme,
      seqDeco,
      CM6.EditorView.updateListener.of(function (u) {
        if (u.docChanged || u.selectionSet || u.geometryChanged) {
          // 用 microtask 避開「update 中又 dispatch」的循環
          Promise.resolve().then(renderPop);
        }
      }),
    ],
  });

  view = new CM6.EditorView({ state: state, parent: document.getElementById("editor") });
  installClipboard();
  view.focus();
}

/* ------------------------------------------------------------------ 事件 */

function applyStyle() {
  const size = Number(document.getElementById("fsize").value) || 26;
  const face = document.getElementById("face").value;
  const color = document.getElementById("color").value;
  document.getElementById("editor").style.color = color;
  const ed = document.querySelector(".cm-editor");
  if (ed) { ed.style.fontSize = size + "px"; ed.style.fontFamily = face; }
}

document.getElementById("fsize").addEventListener("input", applyStyle);
document.getElementById("face").addEventListener("change", applyStyle);
document.getElementById("color").addEventListener("input", applyStyle);
document.getElementById("psize").addEventListener("input", renderPop);
document.getElementById("toggle-char").addEventListener("click", function () {
  charPopEnabled = !charPopEnabled;
  this.setAttribute("aria-pressed", String(charPopEnabled));
  this.textContent = "正常字浮窗：" + (charPopEnabled ? "開" : "關");
  renderPop();
});
document.getElementById("reset").addEventListener("click", function () {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: SAMPLE } });
  view.focus();
});
document.getElementById("ins").addEventListener("click", function () {
  const pos = view.state.selection.main.head;
  const ins = "︵" + "街圭日" + "︶";
  view.dispatch({ changes: { from: pos, insert: ins }, selection: { anchor: pos + ins.length } });
  view.focus();
});
document.addEventListener("compositionstart", function () { composing = true; }, true);
document.addEventListener("compositionend", function () {
  composing = false;
  Promise.resolve().then(renderPop);
}, true);
window.addEventListener("resize", renderPop);
window.addEventListener("scroll", renderPop, true);

/* ------------------------------------------------------------------ 啟動 */

gunzip(Uint8Array.from(atob(LIB_B64), function (c) { return c.charCodeAt(0); }))
  .then(function (bin) {
    LIB = decodeLibrary(bin);
    R = createSvgRenderer(LIB);
    buildEditor();
    applyStyle();
    document.getElementById("status").textContent =
      "字形庫就緒：" + LIB.names.length.toLocaleString() + " 個字形、解壓後 " +
      (bin.length / 1048576).toFixed(2) + " MB　（CodeMirror 6 已內嵌，離線可用）";
    Promise.resolve().then(renderPop);
  })
  .catch(function (e) {
    document.getElementById("status").innerHTML = '<span class="err">載入失敗：' + e.message + "</span>";
  });
</script>
</body>
</html>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(`已寫出 ${OUT}`);
console.log(`  網頁大小 ${(Buffer.byteLength(html) / 1048576).toFixed(2)} MB`);
console.log(`  內嵌：kage-engine ${(Buffer.byteLength(engineSrc) / 1024).toFixed(0)} KB、` +
            `tools 模組 ${(Buffer.byteLength(bundleSrc) / 1024).toFixed(1)} KB、` +
            `CodeMirror 6 ${(Buffer.byteLength(cm6Src) / 1024).toFixed(0)} KB、` +
            `字形庫 base64 ${(libB64.length / 1048576).toFixed(2)} MB`);
