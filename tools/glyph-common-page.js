// glyph-common-page.js — 兩個離線單頁（glyph-browser 與 pinxing）共用的頁面端程式碼。
//
// 由 builder 內嵌，順序是：kage-engine → tools/*.ts 模組 → **這個檔** → 各頁自己的程式碼。
// 所以這裡可以用模組裡的函式，也可以呼叫「後面才定義」的頁面函式
// （同一個 script，函式宣告會提升；但**不要在載入時就呼叫**）。
//
// 抽出來的判準只有一條：**兩頁都要用到的**。只有一頁要用的留在那一頁，
// 免得這裡變成什麼都塞的雜物間。分頁原則見 `pinxing.md` 的工序 P0。

/* ============================ 小工具 ============================ */
function $(id) { return document.getElementById(id); }
function hex(cp) { return "U+" + cp.toString(16).toUpperCase(); }

/** HSV → rgb 字串。固定 S/V 時 HSV 的明度比 HSL 均勻，所以用 HSV 不用 HSL。 */
function hsv(h, s, v) {
  h = ((h % 360) + 360) % 360;
  var c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  var r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return "rgb(" + Math.round((r + m) * 255) + "," + Math.round((g + m) * 255) + "," + Math.round((b + m) * 255) + ")";
}

/* ============================ 引擎與描繪 ============================ */

/* 筆劃粗細：KAGE 內建能力，就是 kMinWidthY／kMinWidthT／kMinWidthU／kWidth
   這四個實例參數。1.0 = 引擎預設值。
   注意 new Kage() 不帶參數時走的是 **gothic** 那一支的數值
   （kMinWidthY=2、kMinWidthT=6、kWidth=5、kMinWidthU=2），kShotai 才是明朝——
   這是引擎本來的行為，專案一路都是這樣畫的，所以基準值要**實測**而不是寫死。 */
var WSCALE = 1, KAGE_BASE = null;
function newKage() {
  var k = new Kage();
  if (!KAGE_BASE) KAGE_BASE = { Y: k.kMinWidthY, T: k.kMinWidthT, W: k.kWidth, U: k.kMinWidthU };
  if (WSCALE !== 1) {
    k.kMinWidthY = KAGE_BASE.Y * WSCALE;
    k.kMinWidthT = KAGE_BASE.T * WSCALE;
    k.kWidth = KAGE_BASE.W * WSCALE;
    /* 只縮放「本來就有值」的參數。kMinWidthU 若不存在的話，
       kagecd 的 UROKO 路徑會算出 NaN、整個多邊形被丟掉——
       那是既有行為，不要因為這裡補了值就讓鱗 suddenly 冒出來。 */
    if (KAGE_BASE.U !== undefined) k.kMinWidthU = KAGE_BASE.U * WSCALE;
  }
  return k;
}

/** 把一個字形（含它引用到的全部字形）塞進 kage 的 buhin。 */
function fillKage(kage, i) {
  var seen = new Set();
  var stack = [i];
  while (stack.length) {
    var j = stack.pop();
    if (seen.has(j)) continue;
    seen.add(j);
    var g = LIB.glyphs[j];
    kage.kBuhin.push(keyOfIdx(LIB, j), toKageData(g, LIB));
    for (var k = 0; k < g.strokes.length; k++) {
      var s = g.strokes[k];
      if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
    }
  }
  return kage;
}

/* ---- 描繪一個字形（唯一路徑；結果快取）---- */
var svgCache = new Map();
function glyphSvg(i) {
  var hit = svgCache.get(i);
  if (hit !== undefined) return hit;
  var polys = new Polygons();
  fillKage(newKage(), i).makeGlyph(polys, keyOfIdx(LIB, i));
  /* `generateSVG()` 固定輸出 `fill="black"`——深色底上就是**黑字看不到**。
     一定要在這裡改成 `currentColor`（跟旁邊的文字同色），
     否則部件序列、庫存按鈕、大字框全部是黑的（實測踩過）。
     快取存的就是改好的版本，所以所有呼叫端都受益。 */
  var svg = normalizeSvg(polys.generateSVG(true))
    .replace(/fill="(?:black|#000000)"/g, 'fill="currentColor"');
  if (svgCache.size > 4000) svgCache.clear();
  svgCache.set(i, svg);
  return svg;
}

/* ---- 精確墨跡 ----
   `componentBoxes()` 的量測器。**用引擎的多邊形，不要走筆劃座標**：
   KAGE 資料裡的 `width` 幾乎都是 0，真正的筆寬是引擎描繪時用 kMinWidth*
   加上去的，走筆劃會系統性低估（實測四邊各差 6～15 格，畫面上就是框切進字形裡）。
   用多邊形量到的值與點陣量到的值只差 1 格。 */
var inkCache = new Map();
function inkOfGlyph(i) {
  var hit = inkCache.get(i);
  if (hit !== undefined) return hit;
  var polys = new Polygons();
  fillKage(newKage(), i).makeGlyph(polys, keyOfIdx(LIB, i));
  var b = inkBoundsOfPolys(polys);
  if (inkCache.size > 4000) inkCache.clear();
  inkCache.set(i, b);
  return b;
}

/** 這個字形所有部件的框（順序＝部件序列的順序，重複次數保留） */
function boxesOfGlyph(i) { return componentBoxes(LIB, i, inkOfGlyph); }

/** 筆劃粗細改了要把兩份快取清掉，否則畫面上還是舊粗細 */
function clearDrawCache() { svgCache.clear(); inkCache.clear(); }

/* ============================ 部件框 ============================ */

/* 每個部件一個顏色。刻意跟「區塊配色」用不同的一組色相，
   免得看框的時候誤以為是在講跨區塊。 */
var BOX_HUES = [18, 200, 95, 320, 150, 265, 45, 175];
function boxColor(order) { return hsv(BOX_HUES[order % BOX_HUES.length], 0.72, 1); }

/**
 * 大字上的部件框。回傳 `<g>` 片段，直接接在字形的 svg 內容後面即可
 * ——兩邊都是 `viewBox="0 0 200 200"`，座標不必換算。
 *
 * opt = { mode: "tight" | "raw" | "deep", active: <order 或 -1>, show: true }
 *
 * `deep`（「字框：孫」✓）＝每一格用 `abs`（投影到根座標的絕對框 ✓，見 `descendantBoxes()` ✓）；
 * 深度 >= 1 的框畫成**虛線**、且**不帶 `data-box`** ✓（它沒有對應的部件格 ✓）。
 *
 * **面積由大到小排序**：SVG 的文件序在後＝命中優先，所以小框自然疊在上面、
 * 一定點得到——這就是「較小的框 z-index 較大」。巢狀的部件（框包框）靠這一條。
 *
 * `raw` 是引擎的引用框，很多是滿版矩形（邏的辶 100%、杏的口 109%），
 * 只適合對照用；預設畫 `tight`（墨跡緊框）。
 */
function boxOverlaySvg(boxes, opt) {
  return '<g class="boxlayer">' + boxRectsSvg(boxes, opt) + "</g>";
}

/**
 * 只產生 `<rect>`。**要放進 SVG 裡用**——`<g>` 單獨塞進 HTML 會被解析器整段丟掉
 * （`<g>` 不是 HTML 元素，`innerHTML` 設成它會得到空的），
 * 所以畫面端一律用下面的 `bigSvgHtml()`，不要自己接 `boxOverlaySvg()` 的字串。
 */
function boxRectsSvg(boxes, opt) {
  if (!boxes || !boxes.length) return "";
  var mode = opt && opt.mode === "raw" ? "raw" : opt && opt.mode === "deep" ? "deep" : "tight";
  var active = opt && opt.active !== undefined ? opt.active : -1;
  var items = [];
  for (var k = 0; k < boxes.length; k++) {
    var b = boxes[k];
    /* 「孫」模式用**投影到根座標的絕對框**（`abs` ✓，來自 descendantBoxes ✓） */
    var r = mode === "raw" ? b.raw : mode === "deep" ? (b.abs || b.tight) : b.tight;
    if (!r) continue;                    /* IDS-only：沒有框可畫 */
    items.push({ order: b.order, depth: b.depth || 0, x: r[0], y: r[1], w: r[2] - r[0], h: r[3] - r[1] });
  }
  items.sort(function (a, c) { return c.w * c.h - a.w * a.h; });
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    /* 深層的孫框：虛線、細一點、**不連動** ✓（沒有對應的部件格 ✓） */
    var sub = mode === "deep" && it.depth > 0;
    out.push('<rect class="cbox' + (sub ? " sub" : "") + (it.order === active && !sub ? " on" : "") +
      '"' + (sub ? ' data-depth="' + it.depth + '"' : ' data-box="' + it.order + '"') +
      ' x="' + it.x.toFixed(1) + '" y="' + it.y.toFixed(1) + '"' +
      ' width="' + Math.max(1, it.w).toFixed(1) + '" height="' + Math.max(1, it.h).toFixed(1) + '"' +
      ' style="--c:' + boxColor(it.order) +
      '"><title>' + (sub ? "第 " + (it.depth + 1) + " 代（第 " + (it.order + 1) + " 個框）"
                         : "第 " + (it.order + 1) + " 個部件") + "</title></rect>");
  }
  return out.join("");
}

/**
 * 大字 ＋ 部件框**疊在同一個座標系**上。
 *
 * 兩邊都是 `viewBox="0 0 200 200"`，所以座標不必換算（實測確認，見施工單 §8.1）。
 * 框是**獨立的一層 `<svg class="boxlayer">`**，用 CSS 絕對定位疊在字形上：
 * 這樣 HTML 解析器才留得住它（`<g>` 單獨塞進 HTML 會被丟掉——踩過），
 * 而且框層在文件序後面＝畫在上面，命中優先。
 */
function bigSvgHtml(svg, boxes, opt) {
  var layer = boxRectsSvg(boxes, opt);
  if (!layer) return svg;
  return svg + '<svg class="boxlayer" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">' +
    layer + "</svg>";
}

/* ============================ 部件序列 ============================ */

/**
 * 「部件序列」清單的每一格。兩頁共用同一個 markup，所以連動（框 ↔ 清單）
 * 只要認 `data-box` 就通了。
 *
 * `label` 由呼叫端決定（glyph-browser 給方位、pinxing 給序號或留空）；
 * IDS-only 的部件沒有框，標「IDS」而且不上框色。
 */
function compMiniHtml(b, label, on) {
  var cls = "mini comp" + (on ? " on" : "") + (b.idsOnly ? " idsonly" : "");
  var style = "--bc:" + colorOfGlyph(b.ref) + ";" +
    (b.idsOnly ? "--c:var(--mut)" : "--c:" + boxColor(b.order));
  /* tooltip 帶上部件的 GlyphWiki 名字，否則只看得到小圖與方位，
     hover 也不知道那是哪一個部件。 */
  var tip = b.idsOnly ? "IDS 補的部件（沒有框）" : "第 " + (b.order + 1) + " 個部件";
  tip += b.refName ? "：" + b.refName : "";
  return '<div class="' + cls + '" data-idx="' + b.ref + '"' +
    (b.idsOnly ? "" : ' data-box="' + b.order + '"') +
    ' style="' + style + '" title="' + tip + '">' +
    '<div class="g">' + glyphSvg(b.ref) + "</div>" +
    '<div class="c">' + (label || "") + "</div></div>";
}

/** 整段「部件序列」。`active` 是框選中的那個 order（-1＝沒有） */
function compSeqHtml(boxes, active, labelOf) {
  var out = [];
  for (var k = 0; k < boxes.length; k++) {
    var b = boxes[k];
    out.push(compMiniHtml(b, labelOf ? labelOf(b) : "", b.order === active));
  }
  return out.join("");
}