#!/usr/bin/env bun
/**
 * build-kage-viewer.ts — 產生離線單一網頁：KAGE 字形檢視。
 *
 * **這一支只做字形檢視，不要加編輯器功能。**
 * 自由組字編輯器是另一支：`tools/build-codemirror-kage.ts` → `out/codemirror-kage.html`。
 * （曾經把編輯器塞進這一頁，師父指出那樣把原本好用的檢視頁弄複雜了。）
 *
 * 架構:
 *   * 資料：out/lib-cjk-all.bin.gz（base64 內嵌）— **全部 Unicode CJK 漢字區塊**
 *     （URO ＋ Ext A..I ＋ 相容區／相容補充）共 98,701 個碼位字、
 *     191,727 個字形的完整部件閉包。
 *     以前內嵌的是只收 BMP 的 lib-cjk.bin.gz，所以 `𩀨`（U+29028，Ext B）
 *     根本不在庫裡，`邏羅寶貝𩀨從䞃致招` 也就組不出來。
 *   * 解碼：**內嵌 tools/lib-format.ts 的原文**（去掉 export 與型別宣告）。
 *     這是刻意的：先前網頁另抄一份解碼邏輯，結果與 Node 端不同步、互相矛盾。
 *     現在兩邊是同一份原始碼，不會再各說各話。
 *   * 渲染：內嵌 kage-engine（`makeGlyph` 產生真實外框，含筆寬與裝飾）
 *
 * 命名：**頁面只認 Unicode**。查字走 `indexOfCodePoint`，
 * KAGE 的內部 key 走 `keyOfIdx`（實作細節，不外流）。
 * 以前這裡寫 `findGlyphIndex(L, "u"+hex)` 再去讀 `L.names[]`，
 * 那是把 GlyphWiki 的名字當介面——現在的格式裡根本沒有名字字串。
 * 名字對照表（`out/lib-cjk-all.gnames.tsv.gz`）**不內嵌**：前端不需要它。
 *
 * 輸入規則（與 `format.md`「自由組字（已可用）」一致）：
 *   以空白分隔每個詞；長度 1 直接顯示，≥3 的奇數＝組字（第 1 字為主字，
 *   其餘每兩字為「舊部件、新部件」），其他顯示錯誤說明。
 *
 * 用法: bun run tools/build-kage-viewer.ts [--out out/kage-viewer.html]
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = resolve(ROOT, "out/kage-viewer.html");
const LIB_GZ = resolve(ROOT, "out/lib-cjk-all.bin.gz");
const ENGINE_DIR = resolve(ROOT, "kage-engine");

/** 開頁就先示範「招財進寶」的 holy grail（可以清掉改打別的） */
const DEMO = "邏羅寶貝𩀨從䞃致招";


// kage-engine 的載入順序（依 sample.js）
const ENGINE_FILES = ["2d.js", "buhin.js", "curve.js", "kage.js", "kagecd.js", "kagedf.js", "polygon.js", "polygons.js"];

const engineSrc = ENGINE_FILES
  .map((f) => readFileSync(resolve(ENGINE_DIR, f), "utf8"))
  .join("\n");

// 內嵌「格式 + 量測 + 框字典 + 組字」四個模組的原文（用 Bun 轉譯器去掉型別），
// 確保網頁與 Node 端共用同一份程式碼，不會各說各話。
//   lib-format.ts  解碼／還原／組字（改寫引用）
//   lib-measure.ts 墨跡範圍、矩形運算
//   compose-fit.ts 替換部件時的縮放與置中（需要 kage-engine）
const MODULES = [
  "tools/lib-format.ts",
  "tools/lib-measure.ts",
  "tools/box-dictionary.ts",
  "tools/compose-fit.ts",
];
const transpiler = new Bun.Transpiler({ loader: "ts" });
const stripExports = (s) => s.replace(/\bexport\s+/g, "");
// 各模組尾端的 `if (import.meta.main) { ... }` 是 CLI 專用，瀏覽器不能有 import.meta
const stripCli = (s) => {
  const i = s.indexOf("if (import.meta.main)");
  return i >= 0 ? s.slice(0, i) : s;
};
const bundleSrc = MODULES
  .map((rel) => stripCli(stripExports(transpiler.transformSync(readFileSync(resolve(ROOT, rel), "utf8")))))
  // compose-fit 在 Node 端會 import node:fs 並自己 eval 載入引擎；瀏覽器端引擎已內嵌在
  // 頁面上方，所以把 ensureEngine 的實作改成「no-op」，並移除 Node 專用的 import。
  .map((s) => s
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/function ensureEngine\([^)]*\)\s*\{[\s\S]*?\n\}/, "function ensureEngine() {}"))
  .join("\n");

// 內嵌前先檢查語法：各模組的 export 被拿掉後全在同一個作用域，
// 兩個檔案若有同名 const/let/class 就是 SyntaxError，**整個 script 都不執行**
// （頁面完全空白且無錯誤訊息）。實際踩過 compose-fit 與 stroke-overlap 的 `const D`。
try {
  new Function(engineSrc + "\n" + bundleSrc + "\n;return 1;");
} catch (e) {
  console.error("合併後的 script 語法錯誤（內嵌會讓整頁空白）：" + (e as Error).message);
  process.exit(1);
}

const libB64 = readFileSync(LIB_GZ).toString("base64");

const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KAGE 字形檢視（離線單頁）</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px;
    font: 15px/1.6 system-ui, "Segoe UI", "Microsoft JhengHei", sans-serif;
    background: #f7f7f8; color: #222;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e6e6e6; }
    .card { background: #202329 !important; border-color: #333842 !important; }
    input { background: #16181c !important; color: #e6e6e6 !important; border-color: #3a3f49 !important; }
  }
  h1 { font-size: 18px; margin: 0 0 12px; font-weight: 600; }
  .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
  input[type=text] {
    flex: 1 1 260px; min-width: 200px; padding: 10px 12px; font-size: 17px;
    border: 1px solid #ccd0d6; border-radius: 8px; background: #fff; color: inherit;
  }
  input[type=number] { width: 78px; padding: 8px; border-radius: 8px; border: 1px solid #ccd0d6; }
  label { display: inline-flex; align-items: center; gap: 5px; font-size: 14px; }
  button {
    padding: 9px 14px; font-size: 14px; border-radius: 8px;
    border: 1px solid #ccd0d6; background: #fff; color: inherit; cursor: pointer;
  }
  button:hover { background: #eef0f3; }
  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
  .card {
    background: #fff; border: 1px solid #e2e5ea; border-radius: 12px;
    padding: 10px; display: flex; flex-direction: column; align-items: center; gap: 6px;
  }
  .card svg { width: 100%; height: auto; display: block; }
  .meta { font-size: 12px; color: #666; font-family: ui-monospace, Consolas, monospace; text-align: center; word-break: break-all; }
  .err { color: #b3261e; }
  #status { font-size: 13px; color: #666; margin-bottom: 12px; }
  details { margin-top: 18px; font-size: 13px; }
  summary { cursor: pointer; }
  code { background: #eef0f3; padding: 1px 4px; border-radius: 4px; }
  @media (prefers-color-scheme: dark) { code { background: #2a2e36; } }
</style>
</head>
<body>
<h1>KAGE 字形檢視</h1>

<div class="bar">
  <input id="q" type="text" value="${DEMO}" placeholder="輸入漢字，例如：漢字盟寶；或構形序列 寶缶支" autofocus>
  <label>每字 <input id="size" type="number" min="32" max="600" value="200" step="16"> px</label>
  <label><input id="fill" type="checkbox" checked> 填色</label>
  <button id="go">顯示</button>
</div>
<div id="status">載入字形庫…</div>
<div id="out" class="grid"></div>

<details>
  <summary>怎麼運作（輸入規則、資料與授權）</summary>
  <p>
    <b>輸入規則</b>：以空白分隔每個詞。
    長度 1（如 <code>寶</code>）直接顯示該字形；
    長度 ≥3 的奇數（如 <code>寶缶支</code>）＝<b>組字</b>：第 1 字為主字，
    其餘每兩字為「舊部件、新部件」；
    其他（如 <code>寶缶</code>）顯示錯誤說明。
  </p>
  <p>
    <b>開頁預設的那一串就是「招財進寶」的 holy grail</b>：
    <code>${DEMO}</code>（9 字 ＝ 1 主字 ＋ 4 組替換）。
    讀法是「邏 的 羅 換成 寶，寶 的 貝 換成 𩀨，𩀨 的 從 換成 䞃，䞃 的 致 換成 招」——
    兩兩成對地讀，跟遞歸（<code>︵…︶</code>）讀法在本例會得到完全一樣的結果。
    清掉輸入框就可以改打別的。
  </p>
  <p>
    <b>資料</b>：內嵌的 <code>lib-cjk-all.bin.gz</code>（base64）是精簡字形庫，
    涵蓋 <b>全部 Unicode CJK 漢字區塊</b>——URO ＋ Ext A..I ＋ 相容區／相容補充，
    共 98,701 個碼位字的完整部件閉包（191,727 個字形、298,229 筆引用），
    未壓縮 3.74 MB、gzip 後 1.79 MB。
    格式為 varint＋zigzag；<b>幾何數值用 zigzag</b>（座標與 width 可為負），
    <b>計數／長度／索引用原始 varint</b>（不可 zigzag，否則數值會乘 2）。
  </p>
  <p>
    <b>內部命名不外流</b>：這個頁面只用 Unicode 查字（<code>indexOfCodePoint</code>）。
    字形庫裡沒有名字字串——每個字形只有「碼位 ＋ 家族」這種數值，
    KAGE 引擎要的 hash key 由索引導出（<code>keyOfIdx</code>）。
    GlyphWiki 的原始名字放在字庫**之外**的對照表
    （<code>lib-cjk-all.gnames.tsv.gz</code>，2.70 MB），前端不需要它。
    這也是為什麼收了 12 個漢字區塊之後全庫反而比舊的 BMP-only 字庫更省。
  </p>
  <p>
    <b>渲染</b>：內嵌 <a href="https://glyphwiki.org/">GlyphWiki</a> 的 kage-engine，
    以 <code>makeGlyph</code> 產生真實外框（含筆寬與羽／曲／立／鹿子／鱗／切口等裝飾），
    再由 <code>Polygons.generateSVG(true)</code> 輸出。字形資料為 GlyphWiki 公開資料；
    kage-engine 為其原作者著作，授權見 <code>kage-engine/COPYING</code>。
  </p>
  <p>
    解碼邏輯與 Node 端共用同一份原始碼（<code>tools/lib-format.ts</code>），
    不會出現兩套實作不同步的情況。
  </p>
</details>

<script>
/* ============================ kage-engine（內嵌） ============================ */
${engineSrc}

/* ============ 精簡庫解碼 + 量測 + 組字（內嵌 tools/*.ts 原文） ============ */
${bundleSrc}

/* ============================ 主流程 ============================ */
const LIB_B64 = "${libB64}";
const SIZE = 200;
let LIB = null;

function gunzip(raw) {
  if (typeof DecompressionStream === "function") {
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).arrayBuffer().then(function (buf) {
      return new Uint8Array(buf);
    });
  }
  return Promise.reject(new Error("此瀏覽器不支援 DecompressionStream，無法解壓字形庫"));
}

function svgFor(cp, lib) {
  const L = lib || LIB;
  // **Unicode 進**：只用碼位查，不去碰任何內部命名
  const idx = indexOfCodePoint(L, cp);
  if (idx === undefined) return null;
  const name = keyOfIdx(L, idx);   // KAGE 引擎的 hash key（內部細節）

  // 沿 99 引用遞迴，把這個字需要的部件全部放進引擎
  const kage = new Kage();
  const seen = new Set();
  const stack = [idx];
  while (stack.length) {
    const i = stack.pop();
    if (seen.has(i)) continue;
    seen.add(i);
    const g = L.glyphs[i];
    kage.kBuhin.push(keyOfIdx(L, i), toKageData(g, L));
    for (const s of g.strokes) {
      if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
    }
  }

  const polygons = new Polygons();
  kage.makeGlyph(polygons, name);

  // 用 path 模式（curve=true），並移除 width/height 以便隨容器縮放。
  // kage 的 <svg ...> 標籤跨多行，用 [^>]* 才比對得到。
  const svg = normalizeSvg(polygons.generateSVG(true));
  return { svg: svg, name: displayName(L, idx), code: cp.toString(16).toUpperCase() };
}

/**
 * 解析一個「詞」。
 *   長度 1        → 直接顯示該字
 *   長度 ≥3 奇數  → 組字：第 1 字為主字，其餘每兩字為「舊部件、新部件」
 *   其他          → 錯誤說明
 */
function parseToken(tok) {
  const chars = Array.from(tok);
  if (chars.length === 1) {
    return { kind: "single", ch: chars[0] };
  }
  if (chars.length < 3 || chars.length % 2 === 0) {
    return {
      kind: "error",
      ch: chars.join(""),
      msg: chars.length < 3
        ? "少於 3 個字，無法組字"
        : "字數為偶數（需 1 主字 + 成對的替換），無法組字",
    };
  }
  const base = chars[0];
  const pairs = [];
  for (let i = 1; i + 1 < chars.length; i += 2) {
    pairs.push([chars[i], chars[i + 1]]);
  }
  const r = composeFit(LIB, base, pairs);
  if (r.error) return { kind: "error", ch: chars.join(""), msg: r.error };
  return {
    kind: "compose",
    ch: chars.join(""),
    lib: r.lib,
    targetIdx: r.targetIdx,
    log: r.log,
    base: base,
    pairs: pairs,
  };
}

function render() {
  const out = document.getElementById("out");
  const size = Number(document.getElementById("size").value) || 200;
  const fill = document.getElementById("fill").checked;
  out.textContent = "";
  if (!LIB) return;

  // 以空白分隔詞：單字直接顯示，3 字以上奇數長度嘗試組字
  const tokens = document.getElementById("q").value.split(/\\s+/).filter(function (s) {
    return s.length > 0;
  });
  if (tokens.length === 0) {
    document.getElementById("status").textContent = "字形庫就緒";
    return;
  }

  let shown = 0;
  const notes = [];

  function addCard(svg, meta, errMsg) {
    const card = document.createElement("div");
    card.className = "card";
    if (svg) {
      card.innerHTML = svg;
      const svgEl = card.querySelector("svg");
      if (svgEl) {
        svgEl.setAttribute("width", size);
        svgEl.setAttribute("height", size);
        // generateSVG 固定 fill="black"；深色主題下會與卡片同色而看不見
        svgEl.querySelectorAll("path,polygon").forEach(function (el) {
          el.setAttribute("fill", "currentColor");
        });
        if (!fill) {
          svgEl.querySelectorAll("path,polygon").forEach(function (el) {
            el.setAttribute("fill", "none");
            el.setAttribute("stroke", "currentColor");
            el.setAttribute("stroke-width", "1.5");
            el.setAttribute("stroke-linejoin", "round");
          });
        }
      }
    }
    const m = document.createElement("div");
    m.className = errMsg ? "meta err" : "meta";
    m.textContent = meta;
    card.appendChild(m);
    if (errMsg) {
      const e = document.createElement("div");
      e.className = "meta err";
      e.textContent = errMsg;
      card.appendChild(e);
    }
    out.appendChild(card);
  }

  for (const tok of tokens) {
    const t = parseToken(tok);
    if (t.kind === "error") {
      notes.push(t.ch + "：" + t.msg);
      addCard(null, t.ch, t.msg);
      continue;
    }
    let r;
    if (t.kind === "single") {
      r = svgFor(t.ch.codePointAt(0));
    } else {
      // 組字結果沿用主字索引（引用已被改寫）
      const baseCp = t.base.codePointAt(0);
      r = svgFor(baseCp, t.lib);
    }
    if (!r) {
      notes.push(t.ch + "：不在庫中");
      addCard(null, t.ch, "不在庫中");
      continue;
    }
    const meta = t.kind === "single"
      ? t.ch + " U+" + r.code + "  " + r.name
      : t.ch + "（" + t.log.join("；") + "）";
    addCard(r.svg, meta, null);
    shown++;
  }

  document.getElementById("status").textContent = notes.length
    ? "顯示 " + shown + " 格；" + notes.join("；")
    : "顯示 " + shown + " 格";
}

document.getElementById("go").addEventListener("click", render);
document.getElementById("q").addEventListener("input", render);
document.getElementById("size").addEventListener("input", render);
document.getElementById("fill").addEventListener("change", render);
gunzip(Uint8Array.from(atob(LIB_B64), function (c) { return c.charCodeAt(0); }))
  .then(function (bin) {
    LIB = decodeLibrary(bin);
    document.getElementById("status").textContent =
      "字形庫就緒：" + LIB.glyphs.length.toLocaleString() + " 個字形、解壓後 " +
      (bin.length / 1048576).toFixed(2) + " MB";
    render();
  })
  .catch(function (e) {
    document.getElementById("status").innerHTML =
      '<span class="err">載入失敗：' + e.message + "</span>";
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
            `內嵌模組碼 ${(Buffer.byteLength(bundleSrc) / 1024).toFixed(1)} KB、` +
            `字形庫 base64 ${(libB64.length / 1048576).toFixed(2)} MB`);
