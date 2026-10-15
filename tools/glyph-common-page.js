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

/* ============================ Unicode 區塊與配色（兩頁共用） ============================
 * 12 個 CJK 漢字區塊 ＋ **每個區塊一個色相**：360 / 12 ＝ 30°，
 * 剛好繞一圈、相鄰兩區只差 30°，變化最柔和（不用黃金角 137.5°：那雖然最好分辨，
 * 但相鄰區塊會跳到完全不同的色系，不是「柔和」）。
 *
 * ⚠ **這一份是唯一的來源** ✓：字集瀏覽頁用它畫區塊面板與每一格 ✓，
 *    拼形頁用它給**候選字**上色 ✓（師父 2026-10-16：「候選字依 unicode 分區使用
 *    不同顏色，配色同 glyph-browser.html」✓）。兩頁各寫一份的話，
 *    只要一邊改了色相步長就會「A 頁可以、B 頁不一樣」✗——這個專案吃過那個虧。
 *
 * ⚠ **`BLOCKS` 的順序有意義**：色相 ＝ 索引 × 30° ✓，
 *    動了順序＝兩頁的顏色一起變 ✗（是 BMP、A、B…相容補 的順序，**不是**碼位順序 ✓）。
 *
 * HSV（不是 HSL）：固定 S／V 時 HSV 的明度比 HSL 均勻 ✓；
 * 黑底上 S 太低會灰掉、太高會刺眼，V＝1 讓顏色最亮 ✓。
 * 顏色一律經 CSS 變數 `--bc` 傳下去，字形 `fill:currentColor` ✓
 * ——這樣「字形色／邊框色／碼位色」只有一個來源，不會兩套色互相打架 ✓。 */
var BLOCKS = [
  { id: "BMP",   mark: "",   name: "CJK Unified Ideographs（基本區）",              a: 0x4E00,  b: 0x9FFF },
  { id: "A",     mark: "A",  name: "CJK Unified Ideographs Extension A",           a: 0x3400,  b: 0x4DBF },
  { id: "B",     mark: "B",  name: "CJK Unified Ideographs Extension B",           a: 0x20000, b: 0x2A6DF },
  { id: "C",     mark: "C",  name: "CJK Unified Ideographs Extension C",           a: 0x2A700, b: 0x2B73F },
  { id: "D",     mark: "D",  name: "CJK Unified Ideographs Extension D",           a: 0x2B740, b: 0x2B81F },
  { id: "E",     mark: "E",  name: "CJK Unified Ideographs Extension E",           a: 0x2B820, b: 0x2CEAF },
  { id: "F",     mark: "F",  name: "CJK Unified Ideographs Extension F",           a: 0x2CEB0, b: 0x2EBEF },
  { id: "G",     mark: "G",  name: "CJK Unified Ideographs Extension G",           a: 0x30000, b: 0x3134F },
  { id: "H",     mark: "H",  name: "CJK Unified Ideographs Extension H",           a: 0x31350, b: 0x323AF },
  { id: "I",     mark: "I",  name: "CJK Unified Ideographs Extension I",           a: 0x2EBF0, b: 0x2EE5F },
  { id: "相容",   mark: "相", name: "CJK Compatibility Ideographs（相容區）",        a: 0xF900,  b: 0xFAFF },
  { id: "相容補", mark: "補", name: "CJK Compatibility Ideographs Supplement（相容補充）", a: 0x2F800, b: 0x2FA1F }
];

/* ★ 師父 2026-10-16：碼位**左下角**要標出「這個字屬於哪一區」✓——
   Extension 區給**英文字母** ✓（A..I ＝ Ext A..I ✓）；
   兩個相容區給中文短標「相」「補」✓（**不要**給 J／K ✗：Unicode 已經有 Ext J 了，
   給了以後會跟真的擴充區撞名 ✗）；
   **基本區（BMP，2 萬字）不標** ✓——那是師父指定的例外 ✓、也是候選字裡最多的一群 ✓。
   `mark: ""` ＝ 不標 ✓。 */

var HUE_STEP = 30, SAT = 0.55, VAL = 1.0;

/** 無碼位（純部件）或落在 12 個 CJK 區塊以外的字：中性灰 ✓ */
var NEUTRAL = "rgb(146,152,162)";

/** 這個碼位落在第幾個區塊（`BLOCKS` 的索引 ✓）；不在 12 區裡就是 −1 ✓ */
function blockIndexOf(cp) {
  for (var i = 0; i < BLOCKS.length; i++) if (cp >= BLOCKS[i].a && cp <= BLOCKS[i].b) return i;
  return -1;
}
function colorOfBlock(bi) { return bi < 0 ? NEUTRAL : hsv(bi * HUE_STEP, SAT, VAL); }
function colorOfCp(cp) { return colorOfBlock(blockIndexOf(cp)); }

/** ★ 師父 2026-10-16：「**BMP 要排在 Ext A 前面**」✓——
 *  ⚠ **按碼位排會相反** ✗：Ext A 是 U+3400–U+4DBF、BMP 是 U+4E00–U+9FFF ✓，
 *    所以 `a - b` 會把 Ext A 全部排在 BMP 前面 ✗（客人先看到的是罕用字 ✓，不是常用字 ✗）。
 *  這裡改成**照 `BLOCKS` 的順序**排 ✓（BMP → Ext A → B → … → Ext I → 相容 → 相容補 ✓），
 *  同一個區裡面才按碼位 ✓。不在 12 區裡的碼位排最後 ✓（`blockOrderOf` 給 `BLOCKS.length` ✓）。 */
function blockOrderOf(cp) {
  var bi = blockIndexOf(cp);
  return bi < 0 ? BLOCKS.length : bi;
}
/** 排序用：**先看是哪一區（照 BLOCKS 的順序 ✓）、再看碼位** ✓ */
function cmpByBlock(a, b) { return blockOrderOf(a) - blockOrderOf(b) || a - b; }

/* ============================ 檢字運算子的用法（兩頁共用） ============================
 * 師父 2026-10-16：「**部件檢字狀態時，要顯示運算子的用法**（滑過「部件檢字」就 popup）」✓。
 * 這兩頁用的是**同一組語法** ✓（`parseSearch()` 是一套 ✓），所以說明的內容**只寫一份** ✓——
 * 分成兩份就等著「一邊改了、另一邊沒改」✗（這個專案吃過那個虧 ✓）。
 * ⚠ `U+908F` 那一條**兩頁行為不同** ✗（字集瀏覽頁＝跳到那個碼位 ✓；拼形頁＝拿那個字去檢字 ✓），
 *   所以**只有那一行**由呼叫端給 ✓（`cpLine` ✓），其餘逐字相同 ✓（驗收會比對兩頁 ✓）。 */
var SEARCH_HELP_ROWS = [
  ["木+", "木在左"],
  ["+木", "木在右"],
  ["木/", "木在上"],
  ["/木", "木在下"],
  ["口木", "同時含口與木（往深處找）"],
  ["口口", "口出現兩次"],
  ["4木日", "扣掉木、日之後剩 4 畫"],
  ["4", "4 畫的獨體字"]
];

/** 上面那張表的 HTML ✓（`cpLine` 是 `[範例, 說明]`，沒有就只列共用的那幾條 ✓）。 */
function searchHelpHtml(cpLine) {
  var out = [], i;
  for (i = 0; i < SEARCH_HELP_ROWS.length; i++) {
    out.push("<b>" + SEARCH_HELP_ROWS[i][0] + "</b> " + SEARCH_HELP_ROWS[i][1]);
  }
  if (cpLine) out.push("<b>" + cpLine[0] + "</b> " + cpLine[1]);
  return out.join("<br>");
}

/** 這個碼位的「左下角小標」文字 ✓（Ext A..I＝A..I；相容＝相、相容補＝補；基本區／區外＝空 ✓） */
function blockMarkOf(cp) {
  var bi = blockIndexOf(cp);
  return bi < 0 ? "" : (BLOCKS[bi].mark || "");
}
/** 上面那個小標的 HTML ✓（兩頁共用同一份 markup ✓，樣式在各自的 builder ✓）。
 *  沒有小標（基本區 ✓）就回空字串 ✓——**不要**留一個空的 span ✗（會多佔一點寬度 ✓）。 */
function blockMarkHtml(cp) {
  var m = blockMarkOf(cp);
  return m ? '<span class="blkmark">' + m + "</span>" : "";
}
/** 字形索引 → 它的碼位所屬區塊的顏色 ✓。
 *  ⚠ 要**擋掉越界的索引** ✗：拼形頁的合成字（fork 出來的庫）索引可能超出全域 `LIB` ✓，
 *    直接查會丟例外、整個重畫掛掉 ✗（這一頁只是要一個顏色，不值得為它冒險 ✓）。 */
function colorOfGlyph(i) {
  if (i == null || i < 0 || !LIB || i >= LIB.glyphs.length) return NEUTRAL;
  var cp = codePointOf(LIB, i);
  return cp ? colorOfCp(cp) : NEUTRAL;
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

/** 引擎量的「某個引用在**父座標**的墨跡框」→ 陣列 ✓（引擎回的是 {x1,y1,x2,y2} 物件 ✓）。 */
function inkOfRefBox(L, parentIdx, strokeIx) {
  try {
    var b = inkOfRefInParent(L, parentIdx, strokeIx);
    return b ? [b.x1, b.y1, b.x2, b.y2] : null;
  } catch (e) { return null; }
}

/** 這個字形所有部件的框（順序＝部件序列的順序，重複次數保留）
 *  ★ 墨跡緊框**直接問引擎** ✓（含框與 `stretch` 的真實落點 ✓）——
 *  自己用仿射推的只在比例剛好相符時才對 ✗（師父 2026-10-15：「最小能包住所有筆劃的框」✓）。 */
function boxesOfGlyph(i) {
  return componentBoxes(LIB, i, inkOfGlyph,
    { inkOfRef: function (p, s) { return inkOfRefBox(LIB, p, s); } });
}

/** 筆劃粗細改了要把兩份快取清掉，否則畫面上還是舊粗細 */
function clearDrawCache() { svgCache.clear(); inkCache.clear(); }

/* ============================ 部件框 ============================ */

/* ★ 師父 2026-10-15：框色改成 **HSV 色相漸變、每一格轉 30 度** ✓
   （以前是一組固定的色相 ✗——現在照順序 0、30、60… 一路排下去 ✓，
   一整圈 12 格，第 13 格再回到 0 度，與第 1 格同色 ✓）。 */
var BOX_HUE0 = 0, BOX_HUE_STEP = 30;
function boxColor(order) { return hsv((BOX_HUE0 + order * BOX_HUE_STEP) % 360, 0.72, 1); }

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
/** 部件框的提示文字：**Unicode 碼位 ＋ 第幾號異形** ✓（師父第 163 輪的需求 ✓）。
 *
 *  「第 N 號」＝它在 `familyMembers()` 家族列表裡的序號 ✓
 *  （與字集瀏覽頁「異體」清單的編號同一個慣例 ✓）；
 *  沒有碼位的純部件誠實寫「無碼位」✓（不要假裝有碼位 ✗）。
 *
 *  ⚠ 要傳**這一批框所屬的那個庫** ✗（拼形的結果是 fork 出來的副本 ✓）——
 *    所以由呼叫端用 `opt.lib` 傳進來 ✓，不要在這裡偷用全域 `LIB` ✗。 */
function boxTipText(L, b) {
  var cp = (L && b.ref !== undefined) ? codePointOf(L, b.ref) : 0;
  if (!cp) return "無碼位";
  var fam = familyMembers(L, cp);
  var k = fam.indexOf(b.ref);
  return "U+" + cp.toString(16).toUpperCase() + (k >= 0 ? "　第 " + (k + 1) + " 號異形" : "");
}

function boxRectsSvg(boxes, opt) {
  if (!boxes || !boxes.length) return "";
  var mode = opt && opt.mode === "raw" ? "raw" : opt && opt.mode === "deep" ? "deep" : "tight";
  var active = opt && opt.active !== undefined ? opt.active : -1;
  var L = opt && opt.lib ? opt.lib : null;
  var items = [];
  for (var k = 0; k < boxes.length; k++) {
    var b = boxes[k];
    /* 「孫」模式用**投影到根座標的絕對框**（`abs` ✓，來自 descendantBoxes ✓） */
    var r = mode === "raw" ? b.raw : mode === "deep" ? (b.abs || b.tight) : b.tight;
    if (!r) continue;                    /* IDS-only：沒有框可畫 */
    items.push({ order: b.order, depth: b.depth || 0, ref: b.ref, refName: b.refName,
                 x: r[0], y: r[1], w: r[2] - r[0], h: r[3] - r[1] });
  }
  items.sort(function (a, c) { return c.w * c.h - a.w * a.h; });
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    /* 深層的孫框：虛線、細一點、**不連動** ✓（沒有對應的部件格 ✓） */
    var sub = mode === "deep" && it.depth > 0;
    /* ★ 提示＝**碼位 ＋ 第幾號異形** ✓；沒有 `opt.lib` 時退回舊寫法 ✓（其他頁面不受影響 ✓） */
    var tip = L ? boxTipText(L, it)
      : (sub ? "第 " + (it.depth + 1) + " 代（第 " + (it.order + 1) + " 個框）"
             : "第 " + (it.order + 1) + " 個部件");
    /* ★ 孫框也**帶 `data-box`** ✓、也能 `.on` ✓——這樣才能和右邊的部件清單互相亮起 ✓
       （原本孫框只有 `data-depth`、點它不會亮 ✗，師父 2026-10-15 回報 ✓）。 */
    out.push('<rect class="cbox' + (sub ? " sub" : "") + (it.order === active ? " on" : "") +
      '" data-box="' + it.order + '"' + (sub ? ' data-depth="' + it.depth + '"' : "") +
      ' x="' + it.x.toFixed(1) + '" y="' + it.y.toFixed(1) + '"' +
      ' width="' + Math.max(1, it.w).toFixed(1) + '" height="' + Math.max(1, it.h).toFixed(1) + '"' +
      ' style="--c:' + boxColor(it.order) +
      '"><title>' + tip + "</title></rect>");
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

/* ============================ gzip 解壓（兩頁共用） ============================
 * 為什麼不能只靠 `DecompressionStream`：**微信內建瀏覽器沒有它** ✗——
 * iOS 的 WKWebView 要 **16.4** 才有 ✓、Android 的舊 X5 核心也沒有 ✓。
 * 沒有它就等於整包字庫解不開 → 頁面只剩「載入失敗」、庫存空的、輸入沒反應 ✗
 * （師父 2026-10-16 回報：「微信打開無法載入庫存拼形，輸入也沒有動作」✓）。
 *
 * 所以這裡自己帶一個**純 JS 的 DEFLATE 解碼**（tinf 系、公開領域 ✓）當後備：
 * 只要是跑得動這個頁面的瀏覽器都有 ✓，而且順便不再依賴 `Blob.stream()`／`Response` ✓
 * （那兩個在舊 WKWebView 也要 14.1 才有 ✓）。實測解 2.33 MB 的 gz →
 * 4.70 MB 的字庫約 **97 ms**（桌機 ✓），比內建的那條只慢一點點，當後備剛好 ✓。 */

var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
                67, 83, 99, 115, 131, 163, 195, 227, 258];
var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
                 4, 4, 4, 4, 5, 5, 5, 5, 0];
var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
                 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8,
                  9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
var CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** canonical Huffman 表：`count[len]`＝碼長 len 的符號數、`sym`＝依碼長排序的符號 */
function HuffTree(n) { this.count = new Uint16Array(16); this.sym = new Uint16Array(n); }
function huffBuild(tree, lengths, n) {
  var i, l;
  for (i = 0; i < n; i++) tree.count[lengths[i]]++;
  tree.count[0] = 0;               /* 碼長 0＝沒有這個符號，不佔位置 ✓ */
  var offs = new Uint16Array(16), sum = 0;
  for (l = 1; l <= 15; l++) { offs[l] = sum; sum += tree.count[l]; }
  for (i = 0; i < n; i++) if (lengths[i]) tree.sym[offs[lengths[i]]++] = i;
}

/** 裸的 DEFLATE（沒有 zlib／gzip 標頭）。`hint`＝預期大小（gzip 尾端的 ISIZE ✓）。 */
function inflateRaw(src, hint) {
  var sp = 0, bitcount = 0, bitbuffer = 0;
  var out = new Uint8Array((hint > 0 ? hint : 1 << 16) + 64), op = 0;
  var fixed = null;

  function grow(need) {
    var want = out.length * 2;
    while (want < need) want *= 2;
    var bigger = new Uint8Array(want);
    bigger.set(out.subarray(0, op));
    out = bigger;
  }
  /* 位元讀取：一次最多要 16 位，補到用完為止（緩衝區最多 23 位，不會溢位 ✓） */
  function ensure(n) {
    while (bitcount < n) {
      if (sp >= src.length) throw new Error("壓縮資料提早結束");
      bitbuffer |= src[sp++] << bitcount;
      bitcount += 8;
    }
  }
  function bits(n) {
    if (n === 0) return 0;
    ensure(n);
    var v = bitbuffer & ((1 << n) - 1);
    bitbuffer >>>= n;
    bitcount -= n;
    return v;
  }
  /** tinf 的解碼法：逐位往下走，`count` 表就是 canonical 的界線 ✓ */
  function symbol(t) {
    var sum = 0, cur = 0, len = 0;
    do {
      cur = 2 * cur + bits(1);
      len++;
      if (len > 15) throw new Error("Huffman 碼不合法");
      sum += t.count[len];
      cur -= t.count[len];
    } while (cur >= 0);
    return t.sym[sum + cur];
  }
  function fixedTrees() {
    if (fixed) return fixed;
    var l = new Uint8Array(288), i;
    for (i = 0; i < 144; i++) l[i] = 8;
    for (; i < 256; i++) l[i] = 9;
    for (; i < 280; i++) l[i] = 7;
    for (; i < 288; i++) l[i] = 8;
    var lt = new HuffTree(288); huffBuild(lt, l, 288);
    var d = new Uint8Array(30);
    for (i = 0; i < 30; i++) d[i] = 5;
    var dt = new HuffTree(30); huffBuild(dt, d, 30);
    fixed = { lit: lt, dist: dt };
    return fixed;
  }
  function dynamicTrees() {
    var hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
    var clen = new Uint8Array(19), i;
    for (i = 0; i < hclen; i++) clen[CLEN_ORDER[i]] = bits(3);
    var ct = new HuffTree(19); huffBuild(ct, clen, 19);
    var total = hlit + hdist, lens = new Uint8Array(total), n = 0;
    while (n < total) {
      var s = symbol(ct), rep, prev;
      if (s < 16) lens[n++] = s;
      else if (s === 16) {
        if (n === 0) throw new Error("壓縮資料的長度碼不合法");
        prev = lens[n - 1]; rep = 3 + bits(2);
        while (rep-- > 0 && n < total) lens[n++] = prev;
      } else if (s === 17) { rep = 3 + bits(3); while (rep-- > 0 && n < total) lens[n++] = 0; }
      else { rep = 11 + bits(7); while (rep-- > 0 && n < total) lens[n++] = 0; }
    }
    var lt = new HuffTree(hlit); huffBuild(lt, lens, hlit);
    var dt = new HuffTree(hdist); huffBuild(dt, lens.subarray(hlit), hdist);
    return { lit: lt, dist: dt };
  }

  for (;;) {
    var last = bits(1), type = bits(2), t, len, sym, dsym, dist, i;
    if (type === 1) t = fixedTrees();
    else if (type === 2) t = dynamicTrees();
    else if (type !== 0) throw new Error("壓縮區塊的型別不合法");
    if (type === 0) {
      /* 未壓縮區塊：丟掉不足一個 byte 的位元、對齊到 byte 邊界 ✓
         （緩衝區裡永遠不滿 8 位，所以不會丟掉整顆 byte ✓） */
      bitbuffer = 0; bitcount = 0;
      if (sp + 4 > src.length) throw new Error("壓縮資料提早結束");
      len = src[sp] | (src[sp + 1] << 8);
      var nlen = src[sp + 2] | (src[sp + 3] << 8);
      sp += 4;
      if ((len ^ 0xffff) !== nlen) throw new Error("未壓縮區塊的長度不合");
      if (sp + len > src.length) throw new Error("壓縮資料提早結束");
      if (op + len > out.length) grow(op + len);
      for (i = 0; i < len; i++) out[op++] = src[sp++];
    } else {
      for (;;) {
        sym = symbol(t.lit);
        if (sym < 256) {
          if (op >= out.length) grow(op + 1);
          out[op++] = sym;
          continue;
        }
        if (sym === 256) break;                       /* 區塊結束 ✓ */
        sym -= 257;
        if (sym >= 29) throw new Error("壓縮資料的長度碼不合法");
        len = LEN_BASE[sym] + bits(LEN_EXTRA[sym]);
        dsym = symbol(t.dist);
        if (dsym >= 30) throw new Error("壓縮資料的距離碼不合法");
        dist = DIST_BASE[dsym] + bits(DIST_EXTRA[dsym]);
        if (dist > op) throw new Error("壓縮資料的距離超出範圍");
        if (op + len > out.length) grow(op + len);
        if (dist >= len) {
          out.set(out.subarray(op - dist, op - dist + len), op);   /* 不重疊→整段搬 ✓ */
          op += len;
        } else {
          for (i = 0; i < len; i++) out[op + i] = out[op + i - dist];   /* 重疊→逐 byte ✓ */
          op += len;
        }
      }
    }
    if (last) break;
  }
  /* ⚠ 回**長度剛好**的一份：`decodeLibrary` 直接吃索引，給一份 buffer 比實際長的不保險 ✓ */
  var exact = new Uint8Array(op);
  exact.set(out.subarray(0, op));
  return exact;
}

/** gzip 外殼（跳過標頭、讀尾端的 ISIZE、把 DEFLATE 交給 `inflateRaw`） */
function inflateGzip(raw) {
  if (raw.length < 18 || raw[0] !== 0x1f || raw[1] !== 0x8b) throw new Error("不是 gzip 資料");
  if (raw[2] !== 8) throw new Error("gzip 的壓縮方法不是 deflate");
  var flg = raw[3], p = 10;
  if (flg & 4) { if (p + 2 > raw.length) throw new Error("gzip 標頭不完整"); p += 2 + (raw[p] | (raw[p + 1] << 8)); }
  if (flg & 8) { while (p < raw.length && raw[p]) p++; p++; }        /* FNAME ✓ */
  if (flg & 16) { while (p < raw.length && raw[p]) p++; p++; }       /* FCOMMENT ✓ */
  if (flg & 2) p += 2;                                              /* FHCRC ✓ */
  if (p > raw.length - 8) throw new Error("gzip 標頭不完整");
  var isize = (raw[raw.length - 4] | (raw[raw.length - 3] << 8) |
               (raw[raw.length - 2] << 16) | (raw[raw.length - 1] << 24)) >>> 0;
  var got = inflateRaw(raw.subarray(p, raw.length - 8), isize);
  if (got.length !== isize) throw new Error("解壓後的大小不符（" + got.length + " ≠ " + isize + "）");
  return got;
}

/** 解 gzip，回 Promise<Uint8Array>：**先試內建的** ✓（最快），沒有／失敗才走純 JS ✓。 */
function gunzipBytes(raw) {
  if (typeof DecompressionStream === "function" && typeof Blob === "function" &&
      Blob.prototype && typeof Blob.prototype.stream === "function") {
    try {
      var stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"));
      return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); },
        function () { return inflateGzip(raw); });
    } catch (e) { /* 掉到下面的純 JS ✓ */ }
  }
  try { return Promise.resolve(inflateGzip(raw)); }
  catch (e) { return Promise.reject(e); }
}