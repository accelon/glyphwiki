// glyph-browser-page.js — 字集瀏覽頁的頁面程式碼（由 tools/build-glyph-browser.ts 內嵌）。
//
// **為什麼是獨立的 .js 而不是寫在 builder 的樣板字串裡**：
// 寫在樣板字串裡時，反引號會提前結束字串、" 會被吃掉、${} 會被插值——
// 同一個坑在這個專案已經踩了三次（每次都是整頁空白，或產生器自己編不過）。
// 抽成真正的檔案之後，編輯器與 linter 也看得到它。
//
// 這個檔案跑在瀏覽器裡，靠頁面上方內嵌的 kage-engine 與 tools/*.ts 的函式；
// 底下的字庫 base64 佔位記號由 builder 換成真資料（builder 用 replaceAll）。

/* ============================ 主流程 ============================ */
var LIB_B64 = "__LIB_B64__";

/* ---- 12 個 CJK 漢字區塊 ----
   面板上只用短標籤（BMP、A..I、相容、相容補）省空間；
   全名放在 title，滑過去就看得到。 */
var BLOCKS = [
  { id: "BMP",   name: "CJK Unified Ideographs（基本區）",              a: 0x4E00,  b: 0x9FFF },
  { id: "A",     name: "CJK Unified Ideographs Extension A",           a: 0x3400,  b: 0x4DBF },
  { id: "B",     name: "CJK Unified Ideographs Extension B",           a: 0x20000, b: 0x2A6DF },
  { id: "C",     name: "CJK Unified Ideographs Extension C",           a: 0x2A700, b: 0x2B73F },
  { id: "D",     name: "CJK Unified Ideographs Extension D",           a: 0x2B740, b: 0x2B81F },
  { id: "E",     name: "CJK Unified Ideographs Extension E",           a: 0x2B820, b: 0x2CEAF },
  { id: "F",     name: "CJK Unified Ideographs Extension F",           a: 0x2CEB0, b: 0x2EBEF },
  { id: "G",     name: "CJK Unified Ideographs Extension G",           a: 0x30000, b: 0x3134F },
  { id: "H",     name: "CJK Unified Ideographs Extension H",           a: 0x31350, b: 0x323AF },
  { id: "I",     name: "CJK Unified Ideographs Extension I",           a: 0x2EBF0, b: 0x2EE5F },
  { id: "相容",   name: "CJK Compatibility Ideographs（相容區）",        a: 0xF900,  b: 0xFAFF },
  { id: "相容補", name: "CJK Compatibility Ideographs Supplement（相容補充）", a: 0x2F800, b: 0x2FA1F }
];

var LIB = null;
var COMP = null;          /* L1：碼位 → **直接**父字索引（位置量測要用這一層） */
var DEEP = null;          /* 深層：碼位 → 含它的父字索引（任何層，去重） */
var REFBY = null;         /* 反向引用：字形索引 → 直接引用它的父字索引 */
var MARKS = null;         /* 目前清單裡「是輸入部件本身」的碼位（畫面上要標出來） */
/** 詳細區的卡片堆疊：每一張是一個字形。點部件＝往下多疊一張，可以一路探索。 */
var CARDS = [];
var SEL_BLOCKS = [0];     /* 目前選取的區塊索引（**可複選**；空的＝什麼都不列） */
var LIST = [];            /* 目前列出的碼位 */
var SEL = -1;             /* **詳細面板**現在顯示哪個字形 */
/* 格區打勾選取的那一格，和 SEL 是兩件事：
   詳細面板的「由哪些部件構成」只換 SEL，不動 GRID_SEL，
   所以在面板裡點部件不會把中間的格區帶著跑。 */
var GRID_SEL = -1;
var CELL = 62, COLS = 8, ROWH = 92, GH = 44;   /* 格區版面（由 layoutGrid 重算） */
var FILTER = null;        /* 目前的查詢（parseQuery 的結果） */

function cpOfCh(s) { var c = s.codePointAt(0); return c === undefined ? null : c; }

/* ---- 區塊配色：HSV，每個區塊轉一個角度 ----
   12 個區塊，360 / 12 = **30°**，剛好繞一圈、每相鄰兩區只差 30°，
   變化最柔和（師父要的）。不用黃金角 137.5°——那雖然最好分辨，
   但相鄰區塊會跳到完全不同的色系，不是「柔和」。

   S、V 固定：黑底上 S 太低會灰掉、太高會刺眼；V=1 讓顏色最亮。
   HSV（不是 HSL）：固定 S/V 時 HSV 的明度比 HSL 均勻。 */

/* 12 個區塊，360 / 12 = **30°**，剛好繞一圈、每相鄰兩區只差 30°，
   變化最柔和（師父要的）。不用黃金角 137.5°——那雖然最好分辨，
   但相鄰區塊會跳到完全不同的色系，不是「柔和」。

   S、V 固定：黑底上 S 太低會灰掉、太高會刺眼；V=1 讓顏色最亮。
   HSV（不是 HSL）：固定 S/V 時 HSV 的明度比 HSL 均勻。
   `hsv()` 本身在 tools/glyph-common-page.js（兩頁共用），這裡只放區塊調色盤。 */
var HUE_STEP = 30, SAT = 0.55, VAL = 1.0;

/** 無碼位（純部件）或落在 12 個 CJK 區塊以外的字：中性灰 */
var NEUTRAL = "rgb(146,152,162)";
function colorOfBlock(bi) { return bi < 0 ? NEUTRAL : hsv(bi * HUE_STEP, SAT, VAL); }
function colorOfCp(cp) { return colorOfBlock(blockIndexOf(cp)); }
function colorOfGlyph(i) {
  var cp = codePointOf(LIB, i);
  return cp ? colorOfCp(cp) : NEUTRAL;
}


/** 家族去重：濾掉畫出來一樣的成員。
    最常見的是「純指標」——`uXXXX` 只是一個引用指向 `uXXXX-j`，兩者渲染完全相同
    （丣 U+4E23 就是這樣，看起來「開頭兩個異體一樣」）。
    其次是真的座標一字不差的成員（全庫 6,455 個）。 */
function dedupeFamily(fam) {
  var out = [], sigs = new Set(), members = new Set(fam);
  for (var i = 0; i < fam.length; i++) {
    var g = LIB.glyphs[fam[i]], ok = true;
    /* 純指標：整個字形只有一個引用，而且指到同家族的另一個成員 */
    if (g.strokes.length === 1 && g.strokes[0].kind === 99 && g.strokes[0].ref !== null &&
        members.has(g.strokes[0].ref)) {
      /* 被指到的那個要先留下來，不然會整個家族被濾光 */
      if (out.indexOf(g.strokes[0].ref) < 0 && fam.indexOf(g.strokes[0].ref) > i) ok = false;
    }
    if (ok) {
      var sig = glyphSignature(fam[i]);
      if (sigs.has(sig)) ok = false; else sigs.add(sig);
    }
    if (ok) out.push(fam[i]);
  }
  return out.length ? out : fam;
}

/** 筆劃資料的簽章（座標一字不差才算相同） */
function glyphSignature(i) {
  var st = LIB.glyphs[i].strokes, a = [];
  for (var k = 0; k < st.length; k++) {
    var s = st[k];
    a.push(s.kind === 99 ? ("99:" + s.ref + ":" + s.box.join(","))
      : (s.kind + ":" + s.width + ":" + s.style + ":" + s.points.join(",")));
  }
  return a.join("|");
}

/** 一個字形節點的「子節點」＝ **結構部件**。
    由字庫自己提供（`componentKids`）：有 IDS 分解就用 IDS，否則用 KAGE 引用。
    GlyphWiki 把部件畫成原始筆劃的字（杏、林）靠的就是這一層。 */
function kidsOf(i) { return componentKids(LIB, i); }

/* 反向引用索引：**這個字形**被哪些字形直接引用。
   「按異體查字」要的是精確的字形，不是碼位——同一個碼位下的不同異體
   被哪些字用到，是兩件不同的事。 */
function buildRefReverse() {
  var m = new Map();
  for (var i = 0; i < LIB.glyphs.length; i++) {
    var st = LIB.glyphs[i].strokes;
    for (var k = 0; k < st.length; k++) {
      var s = st[k];
      if (s.kind !== 99 || s.ref === null) continue;
      var a = m.get(s.ref);
      if (a) a.push(i); else m.set(s.ref, [i]);
    }
  }
  return m;
}

/** 找出**使用這個異體**的字（直接引用；不追進別人的引用樹） */
function runVariantSearch(gi, label) {
  var t0 = performance.now();
  var parents = REFBY.get(gi) || [];
  var seen = new Set(), list = [], listOut = [];
  for (var i = 0; i < parents.length; i++) {
    var pc = codePointOf(LIB, parents[i]);
    if (!pc || seen.has(pc)) continue;
    seen.add(pc);
    if (inSel(pc)) list.push(pc); else listOut.push(pc);
  }
  list.sort(function (a, b) { return a - b; });
  listOut.sort(function (a, b) { return a - b; });
  FILTER = { raw: label, variant: gi };
  LIST = list.concat(listOut);
  MARKS = null;
  drawBlocks(); updateBar();
  gridEl.scrollTop = 0; layoutGrid();
  $("compNote").textContent = label + "：" + LIST.length.toLocaleString() + " 個字" +
    (listOut.length ? "（" + listOut.length.toLocaleString() + " 個在未選取的區塊，排在後面）" : "");
}

/* ---- 建立部件索引（L1 ＋ 深層，一趟掃完） ----
   L1：位置量測要用（只有直接部件才有引用框可量），**只認 KAGE ref**。
   深層：KAGE ref ∪ IDS（見 kidsOf）。杏的「木」只有 IDS 有，
   器／哭的「口」藏在「吅」或「㗊」裡，兩邊都要才找得到。
   實測兩份一起建約 230 ms。 */
function buildIndex() {
  var l1 = new Map(), deep = new Map(), seen = new Set(), seenC = new Set();
  for (var i = 0; i < LIB.glyphs.length; i++) {
    if (!isPlainIdeograph(LIB, i)) continue;
    var st = LIB.glyphs[i].strokes, k;
    /* ---- L1：KAGE 直接引用 ∪ **IDS 直接部件** ----
       兩邊都要：杏（u674f-j）的「木」只有 IDS 有，KAGE 只把它畫成原始筆劃；
       而 KAGE 有的引用 IDS 不一定有。帶位置運算子時，
       位置量測只找得到 KAGE ref，所以 IDS-only 的命中會被自然濾掉（本來就量不到方位）。 */
    seenC.clear();
    for (k = 0; k < st.length; k++) {
      var s = st[k];
      if (s.kind !== 99 || s.ref === null) continue;
      var cp = codePointOf(LIB, s.ref);
      if (cp && !seenC.has(cp)) { seenC.add(cp); var a = l1.get(cp); if (a) a.push(i); else l1.set(cp, [i]); }
    }
    var cp0 = codePointOf(LIB, i);
    var ids0 = cp0 != null && LIB.comp ? LIB.comp.get(cp0) : null;
    if (ids0) {
      for (k = 0; k < ids0.length; k++) {
        if (seenC.has(ids0[k])) continue;
        seenC.add(ids0[k]);
        var a2 = l1.get(ids0[k]); if (a2) a2.push(i); else l1.set(ids0[k], [i]);
      }
    }
    /* ---- 深層：完整引用樹（同一顆字只記一次） ---- */
    seen.clear();
    var stack = kidsOf(i);
    while (stack.length) {
      var j = stack.pop();
      if (seen.has(j)) continue;
      seen.add(j);
      var c2 = codePointOf(LIB, j);
      if (c2) { var b = deep.get(c2); if (b) b.push(i); else deep.set(c2, [i]); }
      var kids = kidsOf(j);
      for (k = 0; k < kids.length; k++) stack.push(kids[k]);
    }
  }
  return { l1: l1, deep: deep, refby: buildRefReverse() };
}

/* ---- 選取的區塊 ---- */
function inSel(cp) {
  for (var i = 0; i < SEL_BLOCKS.length; i++) {
    var B = BLOCKS[SEL_BLOCKS[i]];
    if (cp >= B.a && cp <= B.b) return true;
  }
  return false;
}
function blockIndexOf(cp) {
  for (var i = 0; i < BLOCKS.length; i++) if (cp >= BLOCKS[i].a && cp <= BLOCKS[i].b) return i;
  return -1;
}
/** 選取區塊的全部碼位（區塊互不重疊，所以照索引順序接起來就是遞增） */
function listingOfSelected() {
  var idx = SEL_BLOCKS.slice().sort(function (a, b) { return a - b; });
  var out = [];
  for (var k = 0; k < idx.length; k++) {
    var B = BLOCKS[idx[k]];
    for (var cp = B.a; cp <= B.b; cp++) out.push(cp);
  }
  return out;
}

/* ============================ 格區（虛擬滾動） ============================ */
var gridEl, rowsEl;

function layoutGrid() {
  var gap = 3, padX = 8;
  var w = gridEl.clientWidth - padX * 2;
  COLS = Math.max(1, Math.floor((w + gap) / (CELL + gap)));
  /* 字形格用**正方形**（邊長 ＝ 實際欄寬），不是 CELL 的固定比例。
     先前是 height = 0.72 × CELL，而欄寬還比它寬，等於每個字左右各空一條；
     正方形之後字直接填滿格子，格與格之間只留 3px。 */
  var colW = (w - (COLS - 1) * gap) / COLS;
  GH = Math.round(colW);
  /* 格高必須是確定值，否則 translateY(列號 × 列高) 會跟實際位置對不上：
       格高 = .g(GH) + .c(13) + padding(1+1) + border(1+1) = GH + 17 */
  ROWH = GH + 17 + gap;
  document.documentElement.style.setProperty("--gh", GH + "px");
  document.documentElement.style.setProperty("--gap", gap + "px");
  rowsEl.style.gridTemplateColumns = "repeat(" + COLS + ", minmax(0, 1fr))";
  var totalRows = Math.ceil(LIST.length / COLS);
  rowsEl.style.height = (totalRows * ROWH) + "px";
  renderVisible();
}

function cellHtml(cp) {
  var idx = indexOfCodePoint(LIB, cp);
  var sel = (idx !== undefined && idx === GRID_SEL) ? " sel" : "";
  var dim = (idx === undefined) ? " dim" : "";
  var inner = idx === undefined
    ? '<span class="sysfont">' + String.fromCodePoint(cp) + "</span>"
    : glyphSvg(idx);
  var mark = (MARKS && MARKS.has(cp)) ? " part" : "";
  /* 未選取區塊的命中排到後面，並且畫得暗一點，一眼看得出「這是放寬撈進來的」 */
  if (!inSel(cp)) mark += " outside";
  return '<div class="cell' + dim + sel + mark + '" data-cp="' + cp + '" style="--bc:' + colorOfCp(cp) + '">' +
         '<div class="g">' + inner + "</div>" +
         '<div class="c">' + hex(cp) + "</div></div>";
}

function renderVisible() {
  var first = Math.max(0, Math.floor((gridEl.scrollTop - 6) / ROWH) - 2);
  var vis = Math.ceil(gridEl.clientHeight / ROWH) + 4;
  var last = Math.min(Math.ceil(LIST.length / COLS), first + vis);
  rowsEl.style.transform = "translateY(" + (first * ROWH) + "px)";
  var html = "";
  for (var k = first * COLS; k < last * COLS && k < LIST.length; k++) html += cellHtml(LIST[k]);
  rowsEl.innerHTML = html;
}

/* ============================ 詳細面板 ============================ */
function miniHtml(idx, label, on) {
  return '<div class="mini' + (on ? " on" : "") + '" data-idx="' + idx +
         '" style="--bc:' + colorOfGlyph(idx) + '">' +
         '<div class="g">' + glyphSvg(idx) + "</div>" +
         '<div class="c">' + label + "</div></div>";
}

function cap(arr, n) { return arr.length > n ? arr.slice(0, n) : arr; }

/** 一張卡片的內容＝一個字形的完整資訊 */
function cardHtml(idx, k) {
  var cp = codePointOf(LIB, idx);
  var parts = [];
  parts.push('<div class="card" data-card="' + k + '" style="--bc:' + colorOfGlyph(idx) + '">');
  parts.push('<button class="cardClose" title="關掉這張卡">×</button>');
  /* 大字本身就是「以它為部件搜尋」的按鈕——這樣就不必再列一份「能構成的字」，
     按下去中間的格區直接就是那份清單，而且還能搜、能捲、能再疊卡。 */
  parts.push('<div class="big"' + (cp ? ' title="點一下 → 以「' + String.fromCodePoint(cp) +
    '」為部件搜尋"' : "") + '><div class="g">' + bigSvgHtml(glyphSvg(idx), boxesOfGlyph(idx),
      { mode: "tight", active: -1, lib: LIB }) + "</div>" +
    '<div class="u">' + (cp ? hex(cp) : "（無碼位）") + "</div></div>");

  /* 異體：只有一個就不必顯示（沒有「不同字形」可言） */
  if (cp) {
    var famAll = familyMembers(LIB, cp);
    var fam = dedupeFamily(famAll);
    if (fam.length > 1) {
      parts.push('<div class="sec secVar"><b>異體（' + fam.length + '）</b><div class="minis">');
      var shown = cap(fam, 16);
      for (var i = 0; i < shown.length; i++) {
        parts.push(miniHtml(shown[i], String(fam.indexOf(shown[i]) + 1), shown[i] === idx));
      }
      parts.push("</div>");
      if (fam.length > shown.length) parts.push('<div class="note" style="margin-top:4px">還有 ' + (fam.length - shown.length) + " 個</div>");
      parts.push('<div class="note" style="margin-top:4px">' +
        "<b>點一個 → 找出使用那個異體的字</b>。" +
        (famAll.length > fam.length ? "　已濾掉 " + (famAll.length - fam.length) + " 個畫出來一樣的。" : "") +
        "</div></div>");
    }
  }

  /* 由哪些部件構成：KAGE 引用（能量方位）∪ IDS 部件（標「IDS」） */
  var slots = refSlotsOf(LIB, idx);
  var extraIds = [];
  if (cp) {
    var seenX = new Set();
    for (var q0 = 0; q0 < slots.length; q0++) seenX.add(codePointOf(LIB, slots[q0].ref));
    var idsC = LIB.comp ? LIB.comp.get(cp) : null;
    if (idsC) {
      for (var q1 = 0; q1 < idsC.length; q1++) {
        if (seenX.has(idsC[q1])) continue;
        seenX.add(idsC[q1]);
        var xi = indexOfCodePoint(LIB, idsC[q1]);
        if (xi !== undefined) extraIds.push(xi);
      }
    }
  }
  var nParts = slots.length + extraIds.length;
  parts.push('<hr class="thin"><div class="sec secParts"><b>由哪些部件構成（' + nParts + "）</b>");
  if (!nParts) parts.push('<div class="note">這個字是純筆畫，沒有引用部件。</div>');
  else {
    parts.push('<div class="minis">');
    for (var j = 0; j < slots.length; j++) {
      var z;
      try { z = inkZoneOf(LIB, idx, slots[j].strokeIx, inkOfRefInParent); } catch (e) { z = slots[j].zone; }
      parts.push(miniHtml(slots[j].ref, z, false));
    }
    for (var j2 = 0; j2 < extraIds.length; j2++) parts.push(miniHtml(extraIds[j2], "IDS", false));
    parts.push("</div>");
    parts.push('<div class="note" style="margin-top:4px">點一個 → <b>往下多疊一張卡</b>。' +
      (extraIds.length ? "　標「IDS」的是 Unicode 結構資料補的。" : "") + "</div>");
  }
  parts.push("</div>");

  /* 動作（每張卡各自一組，複製到的就是這張卡的字） */
  parts.push('<hr class="thin"><div class="sec">' +
    (cp ? '<div class="row"><button class="p useAsComp" data-idx="' + idx + '" style="flex:1">以「' +
      String.fromCodePoint(cp) + "」為部件搜尋</button></div>" : "") +
    '<div class="row"><button class="copyCp" data-idx="' + idx + '" style="flex:1">複製 ' +
    (cp ? hex(cp) : "—") + "</button>" +
    '<button class="copySeq" data-idx="' + idx + '" style="flex:1">複製構形序列</button></div></div>');

  parts.push("</div>");
  return parts.join("");
}

function renderCards(scrollToEnd) {
  var el = $("detail");
  if (!CARDS.length) {
    el.innerHTML = '<div class="sec note">從中間點一個字，或用上面的搜尋。</div>';
    SEL = -1;
    return;
  }
  var h = [];
  for (var k = 0; k < CARDS.length; k++) h.push(cardHtml(CARDS[k], k));
  el.innerHTML = h.join("");
  if (scrollToEnd) el.scrollTop = el.scrollHeight;
}

/** 整個堆疊換成這一個字（點格區、跳碼位時用） */
function showDetail(idx) {
  if (idx < 0 || idx >= LIB.glyphs.length) { CARDS = []; renderCards(); return; }
  SEL = idx;
  CARDS = [idx];
  renderCards(false);
}

/** 往下多疊一張（點部件／能構成的字時用）。**不動格區**。 */
function pushCard(idx) {
  if (idx < 0 || idx >= LIB.glyphs.length) return;
  SEL = idx;
  CARDS.push(idx);
  renderCards(true);
}

/* ============================ 搜尋語法 ============================
     木+   木在左        +木   木在右
     木/   木在上        /木   木在下
     口木   同時含口與木（**深層**比對）
     口口   口要出現兩次
     4木日  扣掉木、日之後剩 4 畫
     4      4 畫的獨體字

   深度是語法決定的，沒有開關：
     * 一個部件（可以帶位置運算子）→ **直接部件**。位置只有直接部件才有意義，
       深層命中根本沒有對應的引用框可以量方位。
     * 多個部件 → **深層**。像「器」「哭」的口藏在「吅」裡面，
       只看直接部件會找不到，而這正是多部件查詢要解的問題。
=================================================================== */
/* 註：這裡本來有一個 parseCpInput()，已經沒有呼叫端。
   碼位解析統一由後面的 cpFromJumpInput() 負責（它只認 U+/U/0x 開頭，
   免得「4」這種筆劃數查詢被當成碼位吃掉）。留著死函式只會讓文件指錯地方。 */

/** 拆查詢字串 → { n, comps, mult, pos } */
function parseQuery(raw) {
  var s = raw.replace(/\s+/g, "");
  var n = null, digits = "", comps = [], mult = [], pos = null;
  var pts = Array.from(s);
  for (var i = 0; i < pts.length; i++) {
    var ch = pts[i];
    if (ch >= "0" && ch <= "9") { digits += ch; continue; }
    if (ch === "+" || ch === "/") continue;      /* 位置另外看鄰居 */
    var cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    var at = comps.indexOf(cp);
    if (at < 0) { comps.push(cp); mult.push(1); } else mult[at]++;
  }
  if (digits) n = parseInt(digits, 10);
  /* 位置只在「恰好一個部件」時有意義。
     '+'／'/' 寫在部件**後面**表示部件在左／上，寫在前面表示在右／下
     ——也就是運算子代表的是「另一個部件」在哪一側。 */
  if (comps.length === 1) {
    var plus = s.indexOf("+"), slash = s.indexOf("/");
    if (plus >= 0 && slash < 0) pos = plus === 0 ? "右" : "左";
    else if (slash >= 0 && plus < 0) pos = slash === 0 ? "下" : "上";
  }
  return { raw: s, n: n, comps: comps, mult: mult, pos: pos };
}

/* ---- 筆劃數 ----
   非 99 的線段算 1 畫、99 是部件引用就遞迴。
   kind 0 是**全零的佔位線**（GlyphWiki 拿來當分隔），不算筆畫。
   注意這是 **KAGE 筆段數**，不是康熙筆劃：GlyphWiki 把「口」畫成 4 段
   （丨、𠃍、丨、一 各自獨立），所以 口=4、日=5、木=4。
   但「總數 − 部件」兩邊用同一套算法，差額仍然有意義。 */
var strokeMemo = new Map(), strokeBusy = new Set();
function strokesOf(i) {
  var hit = strokeMemo.get(i);
  if (hit !== undefined) return hit;
  if (strokeBusy.has(i)) return 0;             /* 自我引用就當 0，不要無限遞迴 */
  strokeBusy.add(i);
  var st = LIB.glyphs[i].strokes, n = 0;
  for (var k = 0; k < st.length; k++) {
    var s = st[k];
    if (s.kind === 99 && s.ref !== null) n += strokesOf(s.ref);
    else if (s.kind !== 0) n += 1;
  }
  strokeBusy.delete(i);
  strokeMemo.set(i, n);
  return n;
}

/** 有沒有部件引用（＝是不是合體字） */
function hasRefStroke(i) {
  var st = LIB.glyphs[i].strokes;
  for (var k = 0; k < st.length; k++) if (st[k].kind === 99 && st[k].ref !== null) return true;
  return false;
}

/** 走完整棵引用樹，數 target 這個碼位出現幾次（跟索引用同一套 kidsOf）。
    一定要帶 seen：IDS 資料雖然已經濾掉自我引用，但引用圖仍可能有環。 */
function countInTree(i, target, seen, depth) {
  if (depth > 40 || seen.has(i)) return 0;
  seen.add(i);
  var kids = kidsOf(i), n = 0;
  for (var k = 0; k < kids.length; k++) {
    if (codePointOf(LIB, kids[k]) === target) n++;
    n += countInTree(kids[k], target, seen, depth + 1);
  }
  return n;
}

function applyBlocks() {
  FILTER = null;
  MARKS = null;
  LIST = listingOfSelected();
  $("compNote").textContent = "";
  drawBlocks();
  updateBar();
  gridEl.scrollTop = 0;
  layoutGrid();
}

/** 有條件就重跑搜尋，否則回到選取區塊的全部字 */
function refresh() {
  if (FILTER && FILTER.variant !== undefined) runVariantSearch(FILTER.variant, FILTER.raw);
  else if (FILTER) runFilter(FILTER);
  else applyBlocks();
}

function queryLabel(q) {
  if (!q.comps.length) return q.n + " 畫的獨體字";
  var cs = q.comps.map(function (c) { return "「" + String.fromCodePoint(c) + "」"; }).join("");
  var s = cs;
  if (q.pos) s += "在" + q.pos;
  if (q.n !== null) s += "　扣掉部件後剩 " + q.n + " 畫";
  return s;
}

function runFilter(q) {
  var t0 = performance.now();
  var cand, i, k;

  if (!q.comps.length) {
    /* 只輸入數字 → 該筆劃數的獨體字（完全沒有部件引用的一般漢字） */
    cand = [];
    for (i = 0; i < LIB.glyphs.length; i++) {
      if (!isPlainIdeograph(LIB, i) || hasRefStroke(i)) continue;
      if (strokesOf(i) === q.n) cand.push(i);
    }
  } else if (q.comps.length === 1 && q.mult[0] === 1) {
    /* 一個部件、沒重複 → 直接部件 */
    cand = (COMP.get(q.comps[0]) || []).slice();
  } else {
    /* 多部件（含「口口」這種同一個部件寫兩次）→ 深層交集。
       口木 → 448 個；口口 還要再要求口出現兩次。
       注意「口口」只有**一種**部件，不能走上面的單部件分支——
       器／哭 的口藏在「吅」裡，L1 根本找不到。 */
    var first = DEEP.get(q.comps[0]);
    cand = first ? first.slice() : [];
    for (k = 1; k < q.comps.length && cand.length; k++) {
      var s = new Set(DEEP.get(q.comps[k]) || []);
      cand = cand.filter(function (x) { return s.has(x); });
    }
  }

  /* 重複部件（口口）要真的出現那麼多次，不能只算「有沒有」 */
  var reps = [];
  for (k = 0; k < q.comps.length; k++) if (q.mult[k] > 1) reps.push([q.comps[k], q.mult[k]]);

  /* 扣掉部件之後剩幾畫：查詢裡寫了幾次就扣幾次 */
  var sub = 0;
  for (k = 0; k < q.comps.length; k++) {
    var ci = indexOfCodePoint(LIB, q.comps[k]);
    if (ci !== undefined) sub += strokesOf(ci) * q.mult[k];
  }

  /* **放寬區塊約束**：未選取的區塊不再濾掉，改成排到後面。
     要找罕用部件時就不必先去調區塊選取。 */
  var seen = new Set(), list = [], listOut = [];
  for (k = 0; k < cand.length; k++) {
    var gi = cand[k], pc = codePointOf(LIB, gi);
    if (!pc || seen.has(pc)) continue;

    if (q.pos) {
      var slots = refSlotsOf(LIB, gi), hit = false;
      for (var s2 = 0; s2 < slots.length; s2++) {
        if (codePointOf(LIB, slots[s2].ref) !== q.comps[0]) continue;
        var z;
        try { z = inkZoneOf(LIB, gi, slots[s2].strokeIx, inkOfRefInParent); } catch (e) { z = slots[s2].zone; }
        if (zoneMatches(z, q.pos)) { hit = true; break; }
      }
      if (!hit) continue;
    }

    var bad = false;
    for (var r = 0; r < reps.length; r++) {
      if (countInTree(gi, reps[r][0], new Set(), 0) < reps[r][1]) { bad = true; break; }
    }
    if (bad) continue;

    if (q.n !== null && strokesOf(gi) - sub !== q.n) continue;

    seen.add(pc);
    if (inSel(pc)) list.push(pc); else listOut.push(pc);
  }

  list.sort(function (a, b) { return a - b; });
  listOut.sort(function (a, b) { return a - b; });
  var nOut = listOut.length;
  var all = list.concat(listOut);
  /* 把**輸入的部件本身**排在最前面，這樣可以直接點下去看它有哪些異體。
     用 MARKS 記起來，格子上標一個小記號跟結果區分。 */
  var pre = [];
  for (k = 0; k < q.comps.length; k++) {
    var c0 = q.comps[k];
    if (all.indexOf(c0) >= 0 || pre.indexOf(c0) >= 0) continue;
    if (indexOfCodePoint(LIB, c0) === undefined) continue;
    pre.push(c0);
  }
  MARKS = pre.length ? new Set(pre) : null;
  FILTER = q;
  LIST = pre.concat(all);
  drawBlocks();
  updateBar();
  gridEl.scrollTop = 0;
  layoutGrid();
  $("compNote").textContent = queryLabel(q) + "：" + all.length.toLocaleString() + " 個字" +
    (nOut ? "（" + nOut.toLocaleString() + " 個在未選取的區塊，排在後面）" : "");
}

/** 輸入框變動就立刻搜尋；刪光就還原成選取區塊的全部字 */
function onCompInput() {
  var raw = $("comp").value.replace(/\s+/g, "");
  if (!raw) { $("compNote").textContent = ""; applyBlocks(); return; }
  /* 輸入碼位就直接跳過去，不當查詢 */
  var jcp = cpFromJumpInput(raw);
  if (jcp !== null) {
    if (indexOfCodePoint(LIB, jcp) === undefined) {
      $("compNote").textContent = hex(jcp) + " 不在庫中";
      return;
    }
    $("compNote").textContent = "跳到 " + hex(jcp);
    selectCodepoint(jcp, true);
    return;
  }
  var q = parseQuery(raw);
  if (!q.comps.length && q.n === null) { $("compNote").textContent = "看不懂這個輸入"; return; }
  if (q.comps.length === 1 && !COMP.has(q.comps[0]) && !DEEP.has(q.comps[0])) {
    $("compNote").textContent = hex(q.comps[0]) + " 沒有含它的字";
    FILTER = q; LIST = [];
    drawBlocks(); updateBar(); gridEl.scrollTop = 0; layoutGrid();
    return;
  }
  runFilter(q);
}

/* ============================ 側欄 ============================ */
function drawBlocks() {
  var el = $("blocks"), html = "";
  for (var i = 0; i < BLOCKS.length; i++) {
    var B = BLOCKS[i], n = 0;
    for (var cp = B.a; cp <= B.b; cp++) if (indexOfCodePoint(LIB, cp) !== undefined) n++;
    /* 短標籤 ＋ tooltip；字數放 tooltip，不佔面板寬度 */
    var tip = B.name + "\n" + n.toLocaleString() + " 字　U+" +
      B.a.toString(16).toUpperCase() + " – U+" + B.b.toString(16).toUpperCase();
    html += '<div class="blk' + (SEL_BLOCKS.indexOf(i) >= 0 ? " on" : "") +
      '" data-blk="' + i + '" style="--bc:' + colorOfBlock(i) + '" title="' + tip + '">' +
      B.id + "</div>";
  }
  el.innerHTML = html;
}

/** 輸入 U+XXXX／UXXXX／0xXXXX 就跳到那個碼位（碼位一律大寫 U 開頭才當碼位，
    免得「4」這種筆劃數查詢被吃掉）。 */
function cpFromJumpInput(s) {
  var m = /^(?:U\+|U|0x|0X)([0-9a-fA-F]{4,6})$/.exec(s);
  if (!m) return null;
  var cp = parseInt(m[1], 16);
  return cp <= 0x10FFFF ? cp : null;
}

/** `?comp=…` 入口：從剎那拼形帶一個部件過來查（那一頁的「到字集瀏覽頁查 →」）。
 *
 *  **要先把 `location.search` 解碼，而且要解到沒有百分號編碼為止**：`+` 在查詢字串裡
 *  是合法的保留字元（`?comp=U%2B8FB6`），而且 Edge 開 `file://` 還會再多編一層
 *  （`%2B` → `%252B`）。pinxing 的 `?baseglyph=` 踩過同一個坑，兩邊寫法一致。
 *
 *  兩種寫法都收：
 *    `?comp=辶`（一個字，pinxing 就是給這個）→ 直接塞進搜尋框，走既有的搜尋
 *    `?comp=U%2B8FB6`（碼位）→ 也塞進搜尋框，`onCompInput()` 自己會跳到該碼位 */
function compFromQuery() {
  var raw = location.search;
  for (var i = 0; i < 3; i++) {
    if (raw.indexOf("%") < 0) break;
    var next;
    try { next = decodeURIComponent(raw); } catch (e) { break; }
    if (next === raw) break;
    raw = next;
  }
  var m = /[?&]comp=([^&]+)/.exec(raw);
  if (!m) return "";
  var v = m[1].trim();
  if (!v) return "";
  var cp = cpFromJumpInput(v);
  return cp === null ? v : v.toUpperCase();
}


function updateBar() {
  var idx = SEL_BLOCKS.slice().sort(function (a, b) { return a - b; });
  /* 區塊名不放頁面了（名稱在 chip 的 tooltip 裡），所以只算碼位範圍 */
  var rangeTxt = "";
  if (idx.length === 1) {
    rangeTxt = hex(BLOCKS[idx[0]].a) + " – " + hex(BLOCKS[idx[0]].b);
  } else if (idx.length > 1) {
    rangeTxt = hex(BLOCKS[idx[0]].a) + " – " + hex(BLOCKS[idx[idx.length - 1]].b);
  }
  $("blkRange").textContent = rangeTxt;
  $("count").textContent = FILTER
    ? "篩選「" + FILTER.raw + "」" + LIST.length.toLocaleString() + " 字"
    : (idx.length === 0 ? "沒有選取區塊" : "全部 " + LIST.length.toLocaleString() + " 字");
}

/* ---- 捲到某個碼位並選取 ---- */
function selectCodepoint(cp, jump) {
  var at = LIST.indexOf(cp);
  if (at < 0 && jump) {
    /* 跳到不在目前清單裡的字：把區塊選取收斂成它所在的那一區，
       並清掉部件篩選（否則那張字永遠不會出現在格區裡）。 */
    var b = blockIndexOf(cp);
    if (b < 0) return false;
    SEL_BLOCKS = [b];
    $("comp").value = "";
    $("compNote").textContent = "";
    FILTER = null;
    LIST = listingOfSelected();
    drawBlocks(); updateBar();
    at = LIST.indexOf(cp);
  }
  var idx = indexOfCodePoint(LIB, cp);
  if (idx === undefined) return false;
  SEL = idx;
  GRID_SEL = idx;
  if (at >= 0) {
    var row = Math.floor(at / COLS);
    var top = 6 + row * ROWH, bot = top + ROWH;
    if (gridEl.scrollTop + 6 > top || gridEl.scrollTop + gridEl.clientHeight < bot) {
      gridEl.scrollTop = Math.max(0, top - gridEl.clientHeight / 2 + ROWH / 2);
    }
    renderVisible();
  }
  showDetail(idx);
  return true;
}

/* ============================ 事件 ============================ */
function bind() {
  gridEl = $("grid"); rowsEl = $("rows");

  gridEl.addEventListener("scroll", renderVisible);

  gridEl.addEventListener("click", function (e) {
    var cell = e.target.closest ? e.target.closest(".cell") : null;
    if (!cell) return;
    var cp = Number(cell.getAttribute("data-cp"));
    selectCodepoint(cp, false);
    renderVisible();
  });

  $("blocks").addEventListener("click", function (e) {
    var el = e.target.closest ? e.target.closest(".blk") : null;
    if (!el) return;
    /* **toggle**：按一下切換這個區塊的選取狀態，可以複選 */
    var i = Number(el.getAttribute("data-blk"));
    var at = SEL_BLOCKS.indexOf(i);
    if (at >= 0) SEL_BLOCKS.splice(at, 1); else SEL_BLOCKS.push(i);
    refresh();
  });


  $("detail").addEventListener("click", function (e) {
    var t = e.target;
    var card = t.closest ? t.closest(".card") : null;
    var k = card ? Number(card.getAttribute("data-card")) : -1;

    if (t.closest && t.closest(".cardClose")) {
      CARDS.splice(k, 1);
      SEL = CARDS.length ? CARDS[CARDS.length - 1] : -1;
      renderCards(false);
      return;
    }
    /* 點大字 → 以它為部件搜尋（取代原本的「能構成的字」清單） */
    if (t.closest && t.closest(".big") && card && k >= 0) {
      var cb = codePointOf(LIB, CARDS[k]);
      if (cb) { $("comp").value = String.fromCodePoint(cb); onCompInput(); }
      return;
    }
    var mini = t.closest ? t.closest(".mini") : null;
    if (mini) {
      var idx = Number(mini.getAttribute("data-idx"));
      if (mini.closest(".secVar")) {
        /* 按異體：**找出使用這個異體的字**（精確到字形，不是碼位） */
        var kInFam = Array.prototype.indexOf.call(mini.parentNode.children, mini);
        runVariantSearch(idx, "用「" + (codePointOf(LIB, idx) ? hex(codePointOf(LIB, idx)) : "?") +
          " 第 " + (kInFam + 1) + " 個異體」");
      } else {
        /* 部件／能構成的字：**不替代，往下多疊一張卡** */
        pushCard(idx);
      }
      return;
    }
    if (t.classList && t.classList.contains("copyCp")) {
      var c1 = codePointOf(LIB, Number(t.getAttribute("data-idx")));
      if (c1) navigator.clipboard.writeText(hex(c1));
    } else if (t.classList && t.classList.contains("copySeq")) {
      var c2 = codePointOf(LIB, Number(t.getAttribute("data-idx")));
      if (c2) navigator.clipboard.writeText("\uFE35" + String.fromCodePoint(c2) + "\uFE36");
    } else if (t.classList && t.classList.contains("useAsComp")) {
      var c3 = codePointOf(LIB, Number(t.getAttribute("data-idx")));
      if (c3) { $("comp").value = String.fromCodePoint(c3); onCompInput(); }
    }
  });

  /* 「設置」下拉：點按鈕開合，點外面關起來 */
  $("setBtn").addEventListener("click", function (e) {
    e.stopPropagation();
    var b = $("setBody");
    b.hidden = !b.hidden;
  });
  document.addEventListener("click", function (e) {
    var b = $("setBody");
    if (b.hidden) return;
    if (e.target.closest && e.target.closest(".menu")) return;
    b.hidden = true;
  });

  /* 沒有搜尋／清除按鈕：輸入就立刻搜尋，刪光就還原 */
  $("comp").addEventListener("input", onCompInput);

  $("cellN").addEventListener("input", function () {
    CELL = Math.max(34, Math.min(140, Number($("cellN").value) || 62));
    layoutGrid();
  });
  $("outlineBtn").addEventListener("click", function () {
    document.body.classList.toggle("outline");
  });

  /* 筆劃粗細：改了要**把快取清掉**，否則畫面上還是舊粗細的字形。
     格區與右欄都要重畫（兩邊都吃同一份快取）。 */
  $("wscale").addEventListener("input", function () {
    WSCALE = Number(this.value) / 100;
    $("wscaleV").textContent = this.value + "%";
    clearDrawCache();
    renderVisible();
    /* **不能呼叫 showDetail()**：它的語意是「整個堆疊換成這一個字」（CARDS = [idx]），
       在這裡用會把辛苦疊起來的探索鏈一刀砍成一張。重畫就好，堆疊留著。 */
    if (CARDS.length) renderCards(false);
  });

  window.addEventListener("resize", layoutGrid);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if ($("comp").value) { $("comp").value = ""; applyBlocks(); }
      return;
    }
    var tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input") return;
    /* 方向鍵從**格區自己的選取**出發，不是詳細面板的主角——
       否則在詳細面板點過部件之後，方向鍵會跳到別的地方去。 */
    var at = LIST.indexOf(codePointOf(LIB, GRID_SEL));
    if (at < 0) at = 0;
    var d = 0;
    if (e.key === "ArrowRight") d = 1;
    else if (e.key === "ArrowLeft") d = -1;
    else if (e.key === "ArrowDown") d = COLS;
    else if (e.key === "ArrowUp") d = -COLS;
    else if (e.key === "PageDown") d = COLS * Math.floor(gridEl.clientHeight / ROWH);
    else if (e.key === "PageUp") d = -COLS * Math.floor(gridEl.clientHeight / ROWH);
    else return;
    e.preventDefault();
    var to = Math.max(0, Math.min(LIST.length - 1, at + d));
    selectCodepoint(LIST[to], false);
  });
}

/* ============================ 開頁 ============================ */
function gunzip(raw) {
  if (typeof DecompressionStream === "function") {
    var stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  return Promise.reject(new Error("此瀏覽器不支援 DecompressionStream"));
}

var t0 = performance.now();
function b64ToBytes(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }

/* 字庫是 v3：**IDS 部件區段已經在字庫裡面**（`lib.comp`），不必再載側檔。
   先前是另外一個 `lib-cjk-all.ids.bin.gz`，只有這一頁在用——
   編輯器與命令列工具都沒接上，等於各說各話。 */
gunzip(b64ToBytes(LIB_B64))
  .then(function (bin) {
    LIB = decodeLibrary(bin);
    var t1 = performance.now();
    var ix = buildIndex();
    COMP = ix.l1; DEEP = ix.deep; REFBY = ix.refby;
    var t2 = performance.now();
    document.title = "Unicode漢字集 — " + LIB.glyphs.length.toLocaleString() + " 字形";
    bind();
    applyBlocks();
    /* `?comp=…`：從剎那拼形帶部件過來就直接查（那一頁的「到字集瀏覽頁查 →」）。
       **同時把所有 CJK 區塊打開**：從拼形頁帶過來的部件常常主要出現在 Ext A/B，
       只留預設的 BMP 會讓結果看起來少一大截（實測 辶：全開 1,113 個，
       其中 903 個在未選取的區塊——那些正是使用者要看罕用字時要的）。 */
    var incoming = compFromQuery();
    if (incoming) {
      SEL_BLOCKS = BLOCKS.map(function (_, i) { return i; });
      var cb = $("comp");
      if (cb) { cb.value = incoming; onCompInput(); }
    }
    /* 給 headless 驗收讀的 */
    window.__READY__ = {
      glyphs: LIB.glyphs.length,
      families: LIB.families.length,
      components: COMP.size,
      deepComponents: DEEP.size,
      compEntries: LIB.comp ? LIB.comp.size : 0,
      decodeMs: Math.round(t1 - t0),
      indexMs: Math.round(t2 - t1),
      compQuery: incoming
    };
    var s = document.getElementById("status");
    if (s) s.textContent = "就緒";
  })
  .catch(function (e) {
    document.body.innerHTML = '<div style="padding:20px;color:#b3261e">載入失敗：' + e.message + "</div>";
  });
