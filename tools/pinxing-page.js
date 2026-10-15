// pinxing-page.js — 剎那拼形（pinxing.html）的頁面程式碼（由 tools/build-pinxing.ts 內嵌）。
//
// **為什麼是獨立的 .js，不要寫進 builder 的樣板字串**：
// 樣板字串裡的反引號會提前結束字串、`"` 會被吃掉、`${}` 會被插值——
// 這個坑專案踩過三次，每次都是整頁空白（見 拼形檢視器-施工單.md §9）。
//
// 依賴（都在這個 script 的上方內嵌）：
//   kage-engine、tools/*.ts（lib-format／compose-fit／free-compose／component-boxes…）、
//   tools/glyph-common-page.js（$／glyphSvg／inkOfGlyph／boxesOfGlyph／bigSvgHtml…）
//
// 版面手機豎版優先，由上到下＝輸入 → 大字 → 部件序列 → 庫存拼形 → 候選。

/* ============================ 字庫與索引 ============================ */
var LIB_B64 = "__LIB_B64__";
var LIB = null;

/** ★ 師父第 136 輪：**魔術棒 🪄** 要記住「這一次的建議拼形序」✓。
 *  ⚠ 宣告一定要在檔頭 ✗：var 的提升只有宣告、沒有賦值 ✗——
 *    寫在檔案中段時，render() 先跑就會踩到 TDZ ✗（第 136 輪實測：整頁起不來 ✗）。 */
var WAND = { seqs: [], ix: -1 };

/** 這個字庫裡「只由一個引用構成」的字：把它看成那個被引用的字。
    `uXXXX` 這種純指標名字就是這一類，沒有這一步輸入「邏」會找不到字形。 */
function glyphIndexOf(ch) {
  var i = indexOfChar(LIB, ch);
  if (i !== undefined) return i;
  var cp = ch.codePointAt(0);
  if (cp === undefined) return undefined;
  var fam = familyMembers(LIB, cp);
  for (var k = 0; k < fam.length; k++) {
    var g = LIB.glyphs[fam[k]];
    if (g.strokes.length === 1 && g.strokes[0].kind === 99 && g.strokes[0].ref !== null) return fam[k];
  }
  return undefined;
}

/* ---- 顏色 ----
   ★ 師父 2026-10-16：「**候選字依 unicode 分區使用不同顏色，配色同 glyph-browser.html**」✓
   → 12 個區塊的調色盤（`BLOCKS`／`blockIndexOf`／`colorOfBlock`／`colorOfCp`／
     `colorOfGlyph`）搬進**共用層** `tools/glyph-common-page.js` ✓，兩頁同一份 ✓
     （**不要**在這一頁再寫一份 ✗）。這一頁原本的 `colorOfGlyph` 只回前景色 ✗，已刪掉 ✓。

   這一頁的顏色分工：
     `--bc`＝**區塊色**（候選字用 ✓，跟字集瀏覽頁完全一樣 ✓）；
     `--c` ＝**框色**（`boxColor(order)`，部件清單／大字的框用 ✓，照部件順序轉色相 ✓）。
   兩套色系刻意不同 ✓，免得「這個顏色是在講區塊還是在講第幾個部件」分不出來 ✗。 */

/* ============================ 組字結果的描繪 ============================ */
/* free-compose 的結果常常在**另一個庫**（fork 出來的副本、庫尾多了合成字形），
   所以不能走 `glyphSvg(i)`（它綁死全域 LIB）。這一組是「給定 lib」的版本。 */

var seqSvgCache = new Map(), seqInkCache = new Map();

/** 合成字形的快取鍵：**用筆劃簽章，不要用（索引, 庫長度）**。
 *
 *  為什麼：`evalSeq()` 每次都 fork 一個新庫、把合成字形接在**庫尾**，
 *  所以兩次不同的組合會拿到**同一個索引、同一個庫長度**——
 *  鍵一樣就回傳上一個組合的 SVG，症狀是「改成 角 了，畫面上還是 刀」
 *  （使用者回報「先輸入祈斤角、再輸入祈斤角還是得到祈斤刀」）。
 *  簽章只認筆劃內容，不同組合一定不同鍵，相同組合又剛好可以共用快取。
 *
 *  **引用（kind 99）要遞迴展開**——只寫 `s.ref` 這個索引是不夠的，這是第二個、
 *  更隱蔽的撞鍵（使用者回報「`報土业` 正常，但把 `业` 換成任何部件都沒有變化」）：
 *  `報` 的 `土` 藏在 `幸` 裡面，引擎改的是 **fork 出來的 `幸`**（同一個索引、
 *  內容被換掉），所以 `報土业`／`報土日`／`報土田` 在 `報` 這一層的引用索引、
 *  框、伸縮**完全相同**——簽章一模一樣，快取就把 業 的圖回給 日。
 *  `幸土业` 沒有這個症狀（那一層的引用索引真的不同），所以看起來像只有深層壞掉。
 *
 *  遞迴要有深度上限：正常資料不會有環，但真的遇到也不能把整頁鎖死
 *  （`lib.glyphs` 由參數傳進來，所以同一份簽章函式可以給 fork 過的庫用）。 */
function glyphSig(lib, g, depth) {
  if (!g) return "?";
  if (depth === undefined) depth = 0;
  if (depth > 32) return "…";
  var st = g.strokes, a = [];
  for (var i = 0; i < st.length; i++) {
    var s = st[i];
    if (s.kind === 99) {
      var kid = (lib && lib.glyphs && s.ref !== null && s.ref !== undefined) ? lib.glyphs[s.ref] : null;
      a.push("r" + s.ref + "[" + glyphSig(lib, kid, depth + 1) + "]" +
        ":" + (s.box ? s.box.join(",") : "") + ":" + (s.stretch ? s.stretch.join(",") : ""));
    } else {
      a.push(s.kind + ":" + s.width + ":" + s.style + ":" + (s.points ? s.points.join(",") : ""));
    }
  }
  return a.join("|");
}

function svgOfLib(lib, idx) {
  var g = lib.glyphs[idx];
  var key = lib === LIB ? "#" + idx : "seq:" + glyphSig(lib, g);
  var hit = seqSvgCache.get(key);
  if (hit !== undefined) return hit;
  var svg = glyphSvgIn(lib, idx);
  if (seqSvgCache.size > 600) seqSvgCache.clear();
  seqSvgCache.set(key, svg);
  return svg;
}
function inkOfLib(lib, idx) {
  var g = lib.glyphs[idx];
  var key = lib === LIB ? "#" + idx : "seq:" + glyphSig(lib, g);
  var hit = seqInkCache.get(key);
  if (hit !== undefined) return hit;
  var b = inkOfGlyphIn(lib, idx);
  if (seqInkCache.size > 600) seqInkCache.clear();
  seqInkCache.set(key, b);
  return b;
}

/** 庫＋索引 → SVG。與共用層的 `glyphSvg()` 同一條路，只是庫是參數。 */
function glyphSvgIn(lib, idx) {
  var kage = newKage();
  fillKageIn(kage, lib, idx);
  var polys = new Polygons();
  kage.makeGlyph(polys, keyOfIdx(lib, idx));
  return normalizeSvg(polys.generateSVG(true))
    .replace(/fill="(?:black|#000000)"/g, 'fill="currentColor"')
    .replace(/<svg\b/, '<svg class="gly"');
}

/** 庫＋索引 → 精確墨跡（引擎多邊形，不要走筆劃座標——見施工單 §8.3） */
function inkOfGlyphIn(lib, idx) {
  var kage = newKage();
  fillKageIn(kage, lib, idx);
  var polys = new Polygons();
  kage.makeGlyph(polys, keyOfIdx(lib, idx));
  return inkBoundsOfPolys(polys);
}

function fillKageIn(kage, lib, i) {
  var seen = new Set(), stack = [i];
  while (stack.length) {
    var j = stack.pop();
    if (seen.has(j)) continue;
    seen.add(j);
    var g = lib.glyphs[j];
    if (!g) continue;
    kage.kBuhin.push(keyOfIdx(lib, j), toKageData(g, lib));
    for (var k = 0; k < g.strokes.length; k++) {
      var s = g.strokes[k];
      if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
    }
  }
  return kage;
}

/** 粗細改了：兩份快取都要清（共用層的 ＋ 這一頁自己的） */
function clearAllCache() { clearDrawCache(); seqSvgCache.clear(); seqInkCache.clear(); if (MAIN) MAIN.deep = null; }

/* ============================ 畫面上那一個大字 ============================ */
/* MAIN ＝ { lib, idx, boxes, ink } ——「現在畫的是哪個庫裡的哪個字形」。 */
var MAIN = null;

function setMain(lib, idx) {
  if (lib === null || idx === undefined || idx === null || idx < 0) { MAIN = null; return; }
  var boxes = lib === LIB ? boxesOfGlyph(idx)
    : componentBoxes(lib, idx, function (i) { return inkOfLib(lib, i); },
        { inkOfRef: function (p, s) { return inkOfRefBox(lib, p, s); } });
  MAIN = { lib: lib, idx: idx, boxes: boxes, ink: lib === LIB ? inkOfGlyph(idx) : inkOfLib(lib, idx), deep: null };
}

/** **孫框**（`字框：孫`）用的那一組框 ✓；算一次就快取在 `MAIN.deep` ✓（粗細改了要清 ✓）。 */
function deepBoxesOfMain() {
  if (!MAIN) return [];
  if (!MAIN.deep) {
    try {
      var ink = MAIN.lib === LIB ? inkOfGlyph : function (i) { return inkOfLib(MAIN.lib, i); };
      /* ★ 孫框的框＝**引擎量「這條引用鏈在根座標的墨跡框」** ✓
         （＝能包住那個子孫所有筆劃的**最小框** ✓，含框與 stretch ✓）。 */
      var pathInk = function (path) {
        try {
          var b = inkOfPathInRoot(MAIN.lib, MAIN.idx, path);
          return b ? [b.x1, b.y1, b.x2, b.y2] : null;
        } catch (e0) { return null; }
      };
      MAIN.deep = descendantBoxes(MAIN.lib, MAIN.idx, ink, pathInk);
    } catch (e) { MAIN.deep = []; }
  }
  return MAIN.deep;
}

/** 這個大字是**拼形拼出來的副本**嗎 ✓（不是原庫的字＝有東西被換過 ✓）。 */
function isComposed() { return !!(MAIN && MAIN.lib && MAIN.lib !== LIB); }

/** 「**最終組字用到的部件**」＝拼形結果裡**沒有再被改過的**那一層 ✓
 *  （師父 2026-10-15：邏羅寶貝𩀨從䞃致招 只留 辶 隹 貝 𡩧 招 ✓）。
 *  作法：從根往下走；**只有「在副本裡被改過」的節點才繼續往下** ✓——
 *  沒有被改過的節點（＝庫裡現成的字形）就是一個**用到的部件** ✓，不再拆它的內部 ✓。
 *  框一樣直接問**引擎** ✓（見 inkOfPathInRoot ✓）。 */

/** 序列 log 裡**被換掉的舊部件**（「X 的 **Y** → Z」的 Y ✓）；用來判斷手畫筆劃代表什麼 ✓。 */
function oldCharsOf(st) {
  var set = {}, log = st && st.eval && st.eval.log;
  if (!log) return set;
  for (var i = 0; i < log.length; i++) {
    var m = /^([^ ]+) 的 ([^ ]+) →/.exec(log[i]);
    if (m) set[m[2]] = 1;
  }
  return set;
}

/** ★ 師父 2026-10-16：這一格**手畫的筆劃**對應到哪些「沒被換掉、又沒有引用」的 IDS 部件 ✓。
 *  例：「寶缶支」的 𡩧（= 宀 + 珤，珤 = 王 + 缶）——引擎把 缶 換成 支 ✓、
 *  **王 留在原地變成手畫筆劃** ✓，所以 王 不會出現在引用清單裡 ✗，要在這裡補 ✓。
 *  回傳 `[{ ci, at }]`：`ci`＝那個部件的字形索引 ✓、`at`＝插在第幾筆之前 ✓。 */
function rawPartsOf(gi) {
  var out = [];
  if (!MAIN || gi < 0 || !MAIN.lib.glyphs[gi]) return out;
  var g = MAIN.lib.glyphs[gi];
  var firstOwn = -1, ownCount = 0;
  for (var i = 0; i < g.strokes.length; i++) {
    var s = g.strokes[i];
    if (s.kind === 99 || s.kind === 0) continue;
    if (firstOwn < 0) firstOwn = i;
    ownCount++;
  }
  if (!ownCount || !MAIN.lib.comp) return out;
  var cp = codePointOf(MAIN.lib, gi);
  var ids = cp ? MAIN.lib.comp.get(cp) : null;
  if (!ids || !ids.length) return out;
  var olds = oldCharsOf(lastEval);
  var have = {}, kids = refSlotsOf(MAIN.lib, gi);
  for (var k = 0; k < kids.length; k++) {
    var kcp = codePointOf(MAIN.lib, kids[k].ref);
    if (kcp) have[kcp] = 1;
  }
  var stack = ids.slice(), guard = 0;
  while (stack.length && guard++ < 40) {
    var c = stack.shift();
    if (!c || olds[String.fromCodePoint(c)] || have[c]) continue;
    var sub = MAIN.lib.comp.get(c);
    if (sub && sub.length) { for (var m = 0; m < sub.length; m++) stack.push(sub[m]); continue; }
    var ci = indexOfCodePoint(MAIN.lib, c);
    if (ci !== undefined) out.push({ ci: ci, at: firstOwn + out.length });
  }
  return out;
}

/** ★ 目前**畫面上那一份框**（框、部件清單、筆劃塗色**三處一定同一份** ✓）——
 *  師父的連動要求靠這一條才成立 ✓；以前三處各算各的，IDS 模式就對不上 ✗。 */
function currentBoxes() {
  if (!MAIN) return [];
  /* 表意描述序：清單就是**表意描述序的那幾塊** ✓（框也跟著 ✓，不要跳去「最終部件」✗） */
  if (lastEval && lastEval.mode === "ids") return MAIN.boxes;
  if (SHOW_MID) return deepBoxesOfMain();
  if (isComposed()) return frontierBoxesOfMain();
  return MAIN.boxes;
}

function frontierBoxesOfMain() {
  var out = [];
  if (!MAIN) return out;
  /* 中間部件＝序列 log 裡「被改過的字」✓（例 邏/寶/𩀨/䞃）——**即使引擎沒有改動它的筆劃** ✓
     （例 䞃：引擎發現它本來就有「招」✓，但仍要往下看它的 貝／招 ✓）。 */
  var mids = baseCharsOf(lastEval);   /* ★ 只認**被改過的基字** ✓（舊部件 Y 不算 ✗） */
  var isMid = function (ref) {
    if (modInFork(ref)) return true;
    var cp = codePointOf(MAIN.lib, ref);
    return !!(cp && mids[String.fromCodePoint(cp)]);
  };
  var walk = function (g, path, depth) {
    var gi = drawingIdx(MAIN.lib, g);
    var slots = refSlotsOf(MAIN.lib, gi);
    /* ★ 師父 2026-10-16：這一格**自己手畫的筆劃**如果對應到「沒被換掉、又沒有引用」的
       IDS 部件（例「寶缶支」的 𡩧 保留了 **王** ＝ 手畫 ✓、缶 被換成 支 ✓），
       就把它插在**正確的筆劃位置** ✓（它畫在兩個引用之間 ✓）。 */
    var extras = rawPartsOf(gi);
    var items = [];
    for (var k = 0; k < slots.length; k++) items.push({ six: slots[k].strokeIx, slot: slots[k], ix: k });
    for (var r = 0; r < extras.length; r++) items.push({ six: extras[r].at, extra: extras[r].ci });
    items.sort(function (a, b) { return a.six - b.six; });
    var ExtraBox = null, extraTried = false;
    for (var q = 0; q < items.length; q++) {
      var it = items[q];
      if (it.extra !== undefined) {
        if (!extraTried) {
          extraTried = true;
          try { var ob = inkOfOwnInRoot(MAIN.lib, MAIN.idx, path); if (ob) ExtraBox = [ob.x1, ob.y1, ob.x2, ob.y2]; } catch (e3) { }
        }
        out.push({ ref: it.extra, refName: "", slotIx: -1, strokeIx: -1,
                   raw: ExtraBox, tight: ExtraBox, idsOnly: true, order: out.length,
                   abs: ExtraBox, depth: depth, path: null,
                   ownPath: path });   /* ★ 它沒有引用路徑 ✓——塗色要靠**這一格自己的筆劃** ✓ */
        continue;
      }
      var k = it.ix, s = it.slot;
      var p = path.concat(s.strokeIx);
      var box = null;
      try {
        var b = inkOfPathInRoot(MAIN.lib, MAIN.idx, p);
        if (b) box = [b.x1, b.y1, b.x2, b.y2];
      } catch (e) { }
      var kids = [];
      try { kids = refSlotsOf(MAIN.lib, drawingIdx(MAIN.lib, s.ref)); } catch (e2) { kids = []; }
      if (isMid(s.ref) && kids.length) {
        walk(s.ref, p, depth + 1);          /* 中間部件：往下走、**不列** ✓ */
      } else {
        out.push({ ref: s.ref, refName: s.refName, slotIx: k, strokeIx: s.strokeIx,
                   raw: box, tight: box, idsOnly: false, order: out.length,
                   abs: box, depth: depth, path: p });
      }
    }
  };
  walk(MAIN.idx, [], 0);
  return out;
}
/** ★ 師父 2026-10-15：選中一個框時，**屬於它的筆劃要染成框的顏色**（不要白色）。
 *  作法：只把那一條引用路徑交給引擎畫一次（根座標），再把黑填色換成框色。
 *  回傳的是**內部的 <path>**（不含 <svg>）。找不到就回空字串。 */
function partSvgOfMain(order) {
  if (!MAIN || order < 0) return "";
  var list = currentBoxes();
  var b = null;
  for (var i = 0; i < (list || []).length; i++) {
    if (list[i] && list[i].order === order) { b = list[i]; break; }
  }
  if (!b) return "";
  var path = b.path || ((b.strokeIx !== undefined && b.strokeIx >= 0) ? [b.strokeIx] : null);
  /* 緊框的清單是**配對過的** CompBox ✓，不一定帶 `strokeIx` ✗——
     退回「子孫表」裡找**同一個引用**那一格（第一個＝最淺的那一層 ✓）。 */
  if (!path || !path.length) {
    var nodes = deepBoxesOfMain();
    for (var n = 0; n < (nodes || []).length; n++) {
      if (nodes[n] && nodes[n].ref === b.ref && nodes[n].path && nodes[n].path.length) {
        path = nodes[n].path; break;
      }
    }
  }
  var svg = null;
  if (path && path.length) {
    try { svg = svgOfPathInRoot(MAIN.lib, MAIN.idx, path); } catch (e) { svg = null; }
  }
  /* ★ 師父 2026-10-16：**手畫筆劃的部件**（例「寶缶支」的 王）沒有引用路徑 ✗——
     改畫**那一格自己的筆劃** ✓，這樣它也會跟著框一起變色 ✓。 */
  if (!svg && b.ownPath && b.ownPath.length) {
    try { svg = svgOfOwnInRoot(MAIN.lib, MAIN.idx, b.ownPath); } catch (e2) { svg = null; }
  }
  if (!svg) return "";
  var inner = svg.replace(/^[\s\S]*?<svg\b[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  return inner.replace(/fill="(?:black|#000000)"/gi, 'fill="' + boxColor(order) + '"');
}

/** 把 `.hllayer` 的內容換成「第 box 個部件、染成框色」的筆劃 ✓。
 *  ⚠ **只換這一層**、不重畫整個字形 ✓——滑過框時才不會閃爍 ✓（換掉游標底下的元素會抖 ✗）。
 *
 *  ★★ 曾經做過、**已經拿掉**的「只看那一塊」（第 146 輪加了 `iso`、第 176 輪刪掉 ✗）——
 *  師父 2026-10-16 的原話要**連著括號一起讀**：
 *    「hover 到「土」時，變成很大，白色的「土」和青色的「土」同時存在
 *      （其他的應該被覆蓋不可見。）」
 *  → 那是在**描述症狀** ✓：高亮畫歪了、變成一大塊蓋住其他部件，所以「其他的看不見」✗。
 *    我當時讀成「要求只看那一塊」✗，於是把主字形收起來（`opacity:0` ✓）——
 *    師父隔一輪就回報「hover 過去時，**其他的白色筆劃都不見了**」✗（＝那不是他要的 ✓）。
 *  ⚠ 教訓：**括號裡的描述不可以當成指令** ✗——分不出來就先問 ✓，
 *    不要拿一個「畫面會少東西」的猜測去改 ✗（少東西比多東西更難解釋 ✓）。 */
function paintActiveStrokes(box) {
  var host = $("big");
  var lay = host ? host.querySelector(".hllayer") : null;
  if (!lay) return;
  if (box === undefined || box === null) box = ACTIVE_BOX;
  lay.innerHTML = box >= 0 ? partSvgOfMain(box) : "";
}

function mainSvg() { return MAIN ? svgOfLib(MAIN.lib, MAIN.idx) : ""; }

/* ============================ 相容異體 ============================ */
/* 同一個部件在字庫裡可能是**不同碼位**——實測撞到的牆：
 *   `進` 的引用是 **辶 U+FA66**（CJK 相容字符），不是 `辶 U+8FB6`。
 *   全庫：含 辶 的字 2,032 個、含 辶 的只有 4 個、**交集 0**。
 * 所以照部件格顯示的 辶 去搜尋只會找到 4 個字。這張表把同一個部件的碼位綁在一起。 */
var RADICAL_SYN = {
  0x2E80: 0x2ECC, 0x2E81: 0x5382, 0x2E84: 0x4E36, 0x2E85: 0x4EBB, 0x2E86: 0x5F41, 0x2E87: 0x9F98,
  0x2E88: 0x5200, 0x2E8A: 0x535C, 0x2E8B: 0x353E, 0x2E8C: 0x5B50, 0x2E8D: 0x5B53, 0x2E8E: 0x5C0F,
  0x2E8F: 0x5C22, 0x2E90: 0x5C38, 0x2E91: 0x5C71, 0x2E92: 0x5DD2, 0x2E93: 0x5DF3, 0x2E94: 0x5DF4,
  0x2E95: 0x5E7A, 0x2E96: 0x5DE2, 0x2E97: 0x5EFE, 0x2E98: 0x5F50, 0x2E99: 0x5F61, 0x2E9B: 0x5EF3,
  0x2E9C: 0x65E5, 0x2E9D: 0x6708, 0x2E9E: 0x6B63, 0x2E9F: 0x6BCD, 0x2EA0: 0x6C11, 0x2EA1: 0x6C35,
  0x2EA2: 0x6C3A, 0x2EA3: 0x706B, 0x2EA4: 0x722A, 0x2EA5: 0x7236, 0x2EA6: 0x725B, 0x2EA7: 0x72AC,
  0x2EA8: 0x738B, 0x2EA9: 0x7384, 0x2EAA: 0x74DC, 0x2EAB: 0x74E6, 0x2EAC: 0x7518, 0x2EAD: 0x751F,
  0x2EAE: 0x7528, 0x2EAF: 0x7530, 0x2EB0: 0x758B, 0x2EB1: 0x767D, 0x2EB2: 0x76AE, 0x2EB3: 0x76BF,
  0x2EB4: 0x76CA, 0x2EB5: 0x76DB, 0x2EB6: 0x76E3, 0x2EB7: 0x76F4, 0x2EB8: 0x7701, 0x2EB9: 0x77E2,
  0x2EBA: 0x77F3, 0x2EBB: 0x793A, 0x2EBC: 0x8089, 0x2EBD: 0x81E3, 0x2EBE: 0x81EA, 0x2EBF: 0x81F3,
  0x2EC0: 0x81FC, 0x2EC1: 0x820C, 0x2EC2: 0x8218, 0x2EC3: 0x826E, 0x2EC4: 0x8272, 0x2EC5: 0x864D,
  0x2EC6: 0x866B, 0x2EC7: 0x8840, 0x2EC8: 0x884C, 0x2EC9: 0x8863, 0x2ECA: 0x897E, 0x2ECB: 0x8A00,
  0x2ECC: 0x8FB6, 0x2ECD: 0x8FB6, 0x2ECE: 0x8FB6, 0x2ECF: 0x9091, 0x2ED0: 0x91D1, 0x2ED1: 0x9577,
  0x2ED2: 0x9580, 0x2ED3: 0x961C, 0x2ED4: 0x96B6, 0x2ED5: 0x961D, 0x2ED6: 0x96B9, 0x2ED7: 0x96E8,
  0x2ED8: 0x9752, 0x2ED9: 0x975E, 0x2EDA: 0x9762, 0x2EDB: 0x9769, 0x2EDC: 0x97CB, 0x2EDD: 0x97ED,
  0x2EDE: 0x97F3, 0x2EDF: 0x9801, 0x2EE0: 0x98A8, 0x2EE1: 0x98DB, 0x2EE2: 0x98DF, 0x2EE3: 0x9996,
  0x2EE4: 0x9999, 0x2EE5: 0x99AC, 0x2EE6: 0x9AA8, 0x2EE7: 0x9AD8, 0x2EE8: 0x9ADF, 0x2EE9: 0x9B25,
  0x2EEA: 0x9B2F, 0x2EEB: 0x9B32, 0x2EEC: 0x9B3C, 0x2EED: 0x9B5A, 0x2EEE: 0x9CE5, 0x2EEF: 0x9E75,
  0x2EF0: 0x9E7F, 0x2EF1: 0x9E93, 0x2EF2: 0x9EA5, 0x2EF3: 0x9EBB,
  /* CJK 相容字符：同一個部件的另一種編碼，全庫各只有 0～4 個字在用 */
  0xFA0C: 0x5140, 0xFA0D: 0x55C0, 0xFA0E: 0x9F9C, 0xFA0F: 0x5DE2, 0xFA10: 0x585A, 0xFA11: 0x5C6E,
  0xFA12: 0x6C2B, 0xFA13: 0x6C2B, 0xFA14: 0x7387, 0xFA15: 0x7572, 0xFA16: 0x8C6C, 0xFA17: 0x9CE5,
  0xFA18: 0x793C, 0xFA19: 0x795E, 0xFA1A: 0x7965, 0xFA1B: 0x798F, 0xFA1C: 0x9756, 0xFA1D: 0x7CBE,
  0xFA1E: 0x7FBD, 0xFA20: 0x8612, 0xFA21: 0x8728, 0xFA22: 0x8AF7, 0xFA23: 0x8AF7, 0xFA24: 0x8B39,
  0xFA25: 0x8C55, 0xFA26: 0x8C7A, 0xFA27: 0x9813, 0xFA28: 0x9838, 0xFA29: 0x9838, 0xFA2A: 0x98EF,
  0xFA2B: 0x98FC, 0xFA2C: 0x9928, 0xFA2D: 0x9DB4, 0xFA30: 0x4FAE, 0xFA31: 0x50E7, 0xFA32: 0x514D,
  0xFA33: 0x52C9, 0xFA34: 0x52E4, 0xFA35: 0x5351, 0xFA36: 0x559D, 0xFA37: 0x5606, 0xFA38: 0x5668,
  0xFA39: 0x5840, 0xFA3A: 0x58A8, 0xFA3B: 0x5C64, 0xFA3C: 0x5C6E, 0xFA3D: 0x6094, 0xFA3E: 0x6168,
  0xFA3F: 0x618E, 0xFA40: 0x61F2, 0xFA41: 0x654F, 0xFA42: 0x65E2, 0xFA43: 0x6691, 0xFA44: 0x6885,
  0xFA45: 0x6D77, 0xFA46: 0x6E1A, 0xFA47: 0x6F22, 0xFA48: 0x716E, 0xFA49: 0x722B, 0xFA4A: 0x7422,
  0xFA4B: 0x7891, 0xFA4C: 0x793E, 0xFA4D: 0x7949, 0xFA4E: 0x7948, 0xFA4F: 0x7950, 0xFA50: 0x7956,
  0xFA51: 0x795D, 0xFA52: 0x798D, 0xFA53: 0x798E, 0xFA54: 0x7A40, 0xFA55: 0x7A81, 0xFA56: 0x7BC0,
  0xFA57: 0x7DF4, 0xFA58: 0x7E09, 0xFA59: 0x7E41, 0xFA5A: 0x7F72, 0xFA5B: 0x8005, 0xFA5C: 0x81ED,
  0xFA5D: 0x8279, 0xFA5E: 0x8279, 0xFA5F: 0x8457, 0xFA60: 0x8910, 0xFA61: 0x8996, 0xFA62: 0x8B01,
  0xFA63: 0x8B39, 0xFA64: 0x8CD3, 0xFA65: 0x8D08, 0xFA66: 0x8FB6, 0xFA67: 0x8FB6, 0xFA68: 0x96E3,
  0xFA69: 0x97FF, 0xFA6A: 0x983B,
  /* 常見偏旁（同一個部件的不同碼位） */
  0x4EBA: 0x4EBB, 0x4EBB: 0x4EBA, 0x624B: 0x624C, 0x624C: 0x624B, 0x6C34: 0x6C35, 0x6C35: 0x6C34,
  0x6C3A: 0x6C34, 0x5FC3: 0x5FC4, 0x5FC4: 0x5FC3, 0x72AD: 0x72AC, 0x793B: 0x793A, 0x7CF9: 0x7CF8,
  0x7E9F: 0x7CF8, 0x8BA0: 0x8A00, 0x8EBB: 0x8FB6, 0x9485: 0x91D1, 0x9484: 0x91D1, 0x9581: 0x99AC,
  0x961E: 0x961C, 0x9A6C: 0x99AC, 0x9C7C: 0x9B5A, 0x9E1F: 0x9CE5, 0x9EA6: 0x9EA5
};

/* 第 67 輪：**異體知識收攏成一份**——把字庫 v5 的 `syn`（跨碼位異體，1,259 對）併進這張表
   （查不到才用上面手寫的那幾十對）。`syn` 是分組，這裡統一取「同組最小碼位」當代表，
   與 `component-boxes.ts` 的 `synKeyOf()`（連通分量）一致；已存在的鍵不覆寫，保持手寫表的優先。 */
(function () {
  try {
    if (!LIB || !LIB.syn || typeof LIB.syn.forEach !== "function") return;
    var n = 0;
    LIB.syn.forEach(function (list, a) {
      var rep = a;
      for (var i = 0; i < list.length; i++) if (list[i] < rep) rep = list[i];
      if (rep === a) return;
      if (RADICAL_SYN[a] === undefined) { RADICAL_SYN[a] = rep; n++; }
    });
    if (typeof console !== "undefined" && console.log) console.log("[syn] 併入字庫異體 " + n + " 筆");
  } catch (e) { /* 併不進去也不影響原本行為 */ }
})();

/** 一個部件字元搜尋時要一起查的碼位：自己、家族成員、以及綁在一起的相容異體。 */
var synCache = new Map();
function synCps(cp) {
  var hit = synCache.get(cp);
  if (hit) return hit;
  var out = [];
  var add = function (c) { if (c && out.indexOf(c) < 0) out.push(c); };
  add(cp);
  var canon = RADICAL_SYN[cp];
  add(canon);
  for (var k in RADICAL_SYN) {
    var kk = Number(k), vv = RADICAL_SYN[k];
    if (kk === cp || vv === cp) { add(kk); add(vv); }
    if (canon !== undefined && (kk === canon || vv === canon)) { add(kk); add(vv); }
  }
  add(RADICAL_SYN[out[1]]);
  var fam = familyMembers(LIB, cp);
  for (var f = 0; f < fam.length; f++) add(codePointOf(LIB, fam[f]));
  synCache.set(cp, out);
  return out;
}

/** 這個字形在畫面上要當成哪個部件字元。
    只有相容碼位時（`進` 引用 `辶`，它的 IDS 是 `⻌ U+2ECC`），
    沿著 IDS ＋ 相容表換成使用者認得的寫法（`辶`）。 */
function compCharOf(idx) {
  var cp = codePointOf(LIB, idx);
  if (!cp) return "";
  if (RADICAL_SYN[cp] === undefined) return String.fromCodePoint(cp);
  var ids = LIB.comp ? LIB.comp.get(cp) : null;
  if (ids && ids.length) {
    var c0 = ids[0];
    var canon = RADICAL_SYN[c0] !== undefined ? RADICAL_SYN[c0] : c0;
    if (canon && RADICAL_SYN[canon] === undefined) return String.fromCodePoint(canon);
  }
  var direct = RADICAL_SYN[cp];
  return direct !== undefined ? String.fromCodePoint(direct) : String.fromCodePoint(cp);
}

/* ============================ 拼形序列（替換法） ============================ */
/* 讀法就是 free-compose 的 `base + 舊部件 + 新內容…`（見 free-compose.ts 檔頭）。
 * 判斷只有**兩條規則**，規格舉的兩個例子就是這兩條：
 *   ① 整串求得出一個字形（`evalSeq` 會走整棵引用樹找槽位）→ 就畫它。
 *   ② 求不出來，但前綴是「基字 ＋ 一個換得動的部件」→ 中間狀態（已指名要換掉哪個部件）。
 *   ③ 其餘 → 當成部件搜尋（規格第 7 條）。
 * 舊寫法把「舊部件必須是**直接**引用」當閘門是錯的：`邏` 的直接引用是 `辶 羅`，
 * 而 `羅` 的子樹裡還有 `罒 維`，引擎的 `applyReplace()` 走的是整棵樹。
 * 第二個坑是**比字形索引**：同一個字在庫裡有多個字形（`䴺` 引用 g1ca5 的 `麥`，
 * 打「麥」卻是 g1ca4），索引對不上就永遠走不進②——`canReplaceCp()` 問的是引擎。 */

var lastEval = null;
/** 上一次的標籤模式（`empty`／`good`／`find`），用來決定要不要閃一下輸入區。 */
var lastLabelMode = null;

function legalizeSeq(seq) {
  var tryEval = function (s) {
    /* **參數順序是（lib, expr, opt）**——寫反了不會報錯，
       只會得到「空的拼形序列」（`Array.from(字庫物件)` 是空的），查半天。 */
    try { return evalSeq(LIB, s, {}); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  };
  var full = tryEval(seq);
  if (full.ok) return { mode: "ok", seq: seq, eval: full };
  for (var guard = 0; guard < 8 && seq.length > 2; guard++) {
    seq = seq.slice(0, -1);
    var m = tryEval(seq);
    if (m.ok) return { mode: "ok", seq: seq, eval: m };
  }
  return null;
}

/** 基字的**直接** KAGE 引用（替換法只換得動引用節點：IDS 補的部件是原始筆劃，沒有槽位）。 */
function refKidsOf(gi) {
  var g = LIB.glyphs[gi], out = [];
  if (!g) return out;
  for (var k = 0; k < g.strokes.length; k++) {
    var s = g.strokes[k];
    if (s.kind === 99 && s.ref !== null) out.push(s.ref);
  }
  return out;
}

/** 基字到樹裡每個部件的層級（基字 0、直接引用 1、再下一層 2…）。 */
function levelMapOf(gi) {
  var lev = new Map([[gi, 0]]), q = [gi];
  while (q.length) {
    var i = q.shift(), d = lev.get(i);
    if (d > 12) continue;
    var kids = refKidsOf(i);
    for (var k = 0; k < kids.length; k++) {
      if (lev.has(kids[k])) continue;
      lev.set(kids[k], d + 1);
      q.push(kids[k]);
    }
  }
  return lev;
}

function evalInput(seq) {
  var raw = String(seq).trim();                /* 檢字條件要保留運算子（`木/` 的 `/`） */
  var noSpace = raw.replace(/\s+/g, "");       /* 字元判讀用（濾掉空白） */
  if (noSpace.length === 0) return { mode: "empty" };
  var chars = Array.from(noSpace);
  /* ★ 師父第 122 輪：輸入區要**接受 Unicode IDS**（U+2FF0–2FFF 的構字算子 ✓）——
     有的話就**推薦更好的拼形序** ✓。⚠ IDS 不是拼形序 ✗：這條路只推薦 ✓、不直接組字 ✓。 */
  var ops = idsOperators(noSpace);
  if (ops) {
    var lk = idsLeafKey(noSpace);
    var hits = lk ? (leafIndexOf(lk) || []) : [];
    return { mode: "ids", ids: noSpace, ops: ops, chars: chars, leafKey: lk, hits: hits,
             recommend: idsRecommend(noSpace), note: "IDS：" + ops };
  }
  var baseIdx = glyphIndexOf(chars[0]);
  var labels = labelSet(chars);
  /* 檢字關鍵字與搜尋字串。
     * 顯示用的 `kw`：輸入區**最後一個字**。
     * 搜尋用的 `q`（規則與理由）：
         1. 只有一個字元 → 用整串（含 `木/`、`/木`、`4木日` 這種單字元查詢）
         2. 含有運算子或數字 → **整串**交給 `parseSearch()`（`口口`、`4木日`、
            `木+`、`/木` 都是 glyph-browser 的語法，要一起解）
         3. 第一個字是**庫裡有部件的基字**、而且後面沒再出現它
            （例「進辶」＝輸入區正在拼形，基字是進、要查的是辶）
            → 只查**最後一個字**（含辶的 2,038 個，不是「同時含進與辶」的 18 個）
         4. 其餘 → 整串（`木日`＝同時含木與日，深層交集） */
  var kw = chars[chars.length - 1] || chars[0];
  var hasOp = /[+/0-9]/.test(noSpace);
  var firstIx = glyphIndexOf(chars[0]);
  var firstElsewhere = false;
  for (var fi = 1; fi < chars.length; fi++) if (chars[fi] === chars[0]) { firstElsewhere = true; break; }
  var basePrefix = !hasOp && chars.length >= 2 && !firstElsewhere &&
    firstIx !== undefined && hasComponents(LIB, firstIx);
  var q;
  if (noSpace.length === 1 || hasOp || !basePrefix) q = noSpace;
  else q = kw;
  if (baseIdx === undefined) {
    return { mode: "search", chars: chars, term: kw, q: q, owner: chars[0],
             note: "「" + chars[0] + "」不在字庫中", labels: labels };
  }
  /* 只有一個字：**它是基字也是檢字條件**。
     使用者說「輸入合，要列出所有含合的字」——`合` 有部件（口），但它同時是很好的
     檢字條件，所以單字一律**兩種都給**：大字畫它、部件序列列它的部件、下面列出含它的字。
     獨體字（`木`）沒有部件可列，那就只畫大字 ＋ 列字（標籤也走檢字那一路）。 */
  if (chars.length === 1) {
    return { mode: "ok", chars: chars, owner: chars[0], labels: labels, single: true,
             showList: true, listTerm: noSpace,
             eval: { ok: true, lib: LIB, targetIdx: baseIdx, log: [], substituted: false } };
  }

  /* ① 整串求得出一個字形 → 畫它。
     但基字底下**只有「基字＋一個直接部件」**時要走規則②，
     否則「邏羅」會被 evalSeq 讀成別的讀法而落到搜尋去。 */
  var r = evalSeq(LIB, seq, {});
  if (r.ok) {
    if (chars.length === 2) {
      var oldIx = glyphIndexOf(chars[1]);
      if (oldIx === undefined || !containsIdx(refKidsOf(baseIdx), oldIx)) {
        return { mode: "search", chars: chars, term: kw, q: q, owner: chars[0],
                 note: "「" + chars[1] + "」不是「" + chars[0] + "」的部件", labels: labels };
      }
    }
    return { mode: "ok", chars: chars, owner: ownerFor(chars, baseIdx), labels: labels, eval: r };
  }
  var lg = legalizeSeq(seq);
  if (lg) return { mode: "ok", chars: chars, owner: ownerFor(chars, baseIdx), labels: labels, eval: lg.eval };

  /* ② 前綴是「基字 ＋ 一個**換得動**的部件」→ 中間狀態（已指名要換掉哪個部件）。
     條件用 `canReplaceCp()`（引擎 `applyReplace()` 的乾跑），**不要只比對
     「KAGE 直接引用的字形索引」**：
       * 同一個字在庫裡常常有多個字形——`䴺` 引用的是 `麥` 的 g1ca5，而打「麥」
         拿到的是 g1ca4。比索引永遠對不上，`䴺麥` 就落到③變成「含麥的字」317 個，
         使用者以為在部件清單點一下沒作用。
       * `寶` 的 `缶`、`報` 的 `土` 是 **IDS 槽位**（引擎從筆畫反推得出來、換得動），
         但它們不是 KAGE 直接引用——舊條件同樣會落到③（查含缶／含土的字）。
     反過來 `進辶`（引用是相容碼位 `辶`，引擎真的換不動）仍然走③＝查含辶的字，
     那是規格第 7 條要的動線，不能一起放進來。 */
  var oldIx2 = glyphIndexOf(chars[1]);
  if (oldIx2 !== undefined && canReplaceCp(LIB, baseIdx, chars[1].codePointAt(0))) {
    return { mode: "partial", chars: chars, ready: true, baseIdx: baseIdx,
             baseCh: chars[0], oldCh: chars[1], slotCh: chars[1], note: r.error || "",
             owner: chars[0], labels: labels,
             eval: { ok: true, lib: LIB, targetIdx: baseIdx, log: [], substituted: false } };
  }

  /* ③ 其餘 → 部件搜尋。
     三個字以上＝使用者是在拼形（不是在查部件），組不出來時**要把引擎的理由說出來**：
     輸入「報土业」時 `土` 根本不在 報 的 KAGE 樹裡（它在 幸 的筆畫裡），
     只顯示「業 的檢字」會讓使用者以為自己打錯字（使用者回報）。
     兩個字（`報土`）是打到一半的中間狀態，不要吵。 */
  return { mode: "search", chars: chars, term: kw, q: q, owner: chars[0],
           reason: chars.length >= 3 ? (r.error || "") : "",
           note: "「" + chars[1] + "」不是「" + chars[0] + "」的部件", labels: labels };
}

/** 輸入區左邊的標籤：空白＝「剎那拼形」（醒目色）、合法拼形式＝「拼形序」、
    其餘＝「部件檢字」。 */
function labelSet(chars) {
  return (chars || []).join("");
}

/** 部件序列要畫**哪個字**的部件。
 *
 *  使用者的要求：**隨輸入區的光標改變**——「颰犮电」把光標移到基字之後，
 *  就要看得到 颰 的部件（風、犮）才能換掉它。
 *  所以取「光標前一個字」；沒有光標資訊（還沒 focus 過）才退回最後一個字。
 *  該字是獨體字（沒有部件）時退回上一個有部件的位置。 */
function seqOwnerChar(st, seq, skip) {
  var chars = Array.from(seq);
  if (!chars.length) return "";
  var skipCh = function (c) { return !!(skip && skip[c]); };
  var at = cursorCharIx(seq);                       /* 光標前一個字的位置（-1＝最前面） */
  for (var i = at; i >= 0; i--) {
    if (skipCh(chars[i])) continue;                 /* 被改掉的字不能當主角 ✓ */
    var gi = glyphIndexOf(chars[i]);
    if (gi !== undefined && hasComponents(LIB, gi)) return chars[i];
  }
  for (var j = chars.length - 1; j > at; j--) {
    if (skipCh(chars[j])) continue;
    var gj = glyphIndexOf(chars[j]);
    if (gj !== undefined && hasComponents(LIB, gj)) return chars[j];
  }
  if (skip) return "";                              /* 有「被改掉」的資訊時，**不要**硬挑一個 ✗ */
  if (st && st.owner) return st.owner;
  return chars[0];
}

/** 序列裡**已經被改掉的字**：log 每一列是「X 的 Y → Z…」✓——
 *  X（基字）與 Y（被換掉的舊部件）**都不在最後的字形裡** ✓，不能當部件清單的主角 ✗
 *  （師父 2026-10-15：「峰夆電雨水」不該列「電」、「髜昇厏乍电」不該列「厏」✓）。 */
/** 序列 log 裡**被改過的基字**（「**X** 的 Y → Z」的 X ✓）——只有它們才是「中間部件」✓。
 *  ⚠ **不要**用「被換掉的舊部件（Y）」✗：名字會撞到別處的真部件——
 *  例 `邏羅寶貝𩀨從䞃致招`：`貝` 是「寶 的 貝 → …」的舊部件 ✓，
 *  但它同時也是 `䞃` 底下**真正的**一個部件（那裡的 貝 不是它 ✗）——
 *  用 Y 會把那個 貝 誤當成中間部件、往下拆成 `目` ✗（師父 2026-10-16 抓到 ✓）。 */
function baseCharsOf(st) {
  var set = {}, log = st && st.eval && st.eval.log;
  if (!log) return set;
  for (var i = 0; i < log.length; i++) {
    var m = /^([^ ]+) 的 ([^ ]+) →/.exec(log[i]);
    if (m) set[m[1]] = 1;
  }
  return set;
}

function changedCharsOf(st) {
  var set = {}, log = st && st.eval && st.eval.log;
  if (!log) return set;
  for (var i = 0; i < log.length; i++) {
    var m = /^([^ ]+) 的 ([^ ]+) →/.exec(log[i]);
    if (m) { set[m[1]] = 1; set[m[2]] = 1; }
  }
  return set;
}

/** 這個字形在**拼形結果的副本**裡被改過嗎 ✓（同一個索引、筆劃不同 ✗）。 */
function modInFork(i) {
  if (!MAIN || !MAIN.lib || MAIN.lib === LIB || i < 0) return false;
  try { return JSON.stringify(MAIN.lib.glyphs[i].strokes) !== JSON.stringify(LIB.glyphs[i].strokes); }
  catch (e) { return true; }
}

/** **拼形結果**（fork）的部件清單 ✓——用在「輸入區沒有『沒被改過』的字可以當主角」時 ✓。
 *  ⚠ 被拼形**改過**的引用（例 電 的 雨→水、厏 的 乍→电）**不可以再用原來的碼位名字** ✗，
 *  改成列它**實際畫的引用** ✓（否則就會出現師父說「不必出現」的「電」「厏」✗）。 */
function composedChips() {
  var out = [];
  if (!MAIN) return out;
  var boxes = MAIN.boxes || [];
  for (var k = 0; k < boxes.length; k++) {
    var b = boxes[k];
    if (!b.idsOnly && b.ref >= 0 && modInFork(b.ref)) {
      try {
        var kids = refSlotsOf(MAIN.lib, drawingIdx(MAIN.lib, b.ref));
        for (var j = 0; j < kids.length; j++) {
          var cp = codePointOf(MAIN.lib, kids[j].ref);
          var gi = cp ? glyphIndexOf(String.fromCodePoint(cp)) : undefined;
          if (gi !== undefined) out.push({ ref: gi, order: 100 + out.length, idsOnly: true });
        }
      } catch (e0) { }
      continue;
    }
    out.push(b);
  }
  return out;
}

/** 光標前一個字在 chars 裡的索引（光標在最前面＝-1）。
    `selectionStart` 是 UTF-16 索引，要先換算成「第幾個字」。 */
function cursorCharIx(seq) {
  var el = $("seq");
  var pos = (el && el.selectionStart !== undefined && el.selectionStart !== null)
    ? el.selectionStart : seq.length;
  var chars = Array.from(seq);
  var at = 0, acc = 0;
  for (var k = 0; k < chars.length; k++) {
    acc += chars[k].length;
    if (acc <= pos) at = k + 1; else break;
  }
  return at - 1;
}

/** 部件序列要畫**哪個字**的部件。回傳輸入區裡的那個**字元**。
    實際邏輯在 `seqOwnerChar()`（跟著光標走），這裡只是給 `evalInput()` 用的別名。 */
function ownerFor(chars, baseIdx) {
  void baseIdx;
  return seqOwnerChar(null, chars.join(""));
}

function containsIdx(arr, idx) {
  for (var k = 0; k < arr.length; k++) if (arr[k] === idx) return true;
  return false;
}

/* ============================ 深層部件走訪 ============================ */
/** 一個字形整棵樹的部件節點（`componentKids`：IDS 優先，退回 KAGE 引用）。 */
function deepComponentsOf(gi) {
  var seen = new Set([gi]), stack = [gi], out = [];
  while (stack.length) {
    var i = stack.pop();
    var kids = componentKids(LIB, i);
    for (var k = 0; k < kids.length; k++) {
      /* **推進去之前就要記**：只記「已處理過的節點」會讓同一個子節點被多個父節點各推一次，
         同一筆結果重複塞進 out（搜尋結果是照 seen 去重的）。 */
      if (seen.has(kids[k])) continue;
      seen.add(kids[k]);
      out.push(kids[k]);
      stack.push(kids[k]);
    }
  }
  return out;
}

/* ============================ 部件搜尋（第 7 條） ============================ */
/* 深層索引只建一次：部件碼位 → 含它的字（碼位）。191,727 個字形約 300 ms，
   所以**延後到第一次搜尋**才建。 */
var DEEP = null, deepMs = 0;

function buildDeepIndex() {
  if (DEEP) return;
  var t0 = performance.now();
  var m = new Map(), seen = new Set();
  for (var i = 0; i < LIB.glyphs.length; i++) {
    if (!isPlainIdeograph(LIB, i)) continue;
    var mine = codePointOf(LIB, i);
    if (!mine) continue;
    seen.clear();
    var comps = deepComponentsOf(i);
    for (var k = 0; k < comps.length; k++) {
      var j = comps[k];
      if (seen.has(j)) continue;
      seen.add(j);
      var cp = codePointOf(LIB, j);
      if (!cp) continue;
      /* 相容碼位要**同時**以標準碼位登記，否則照 進 的部件格點下去
         （顯示的是辶）只會查到 4 個字。 */
      var canon = RADICAL_SYN[cp];
      var a = m.get(cp);
      if (a) a.push(mine); else m.set(cp, [mine]);
      if (canon !== undefined) {
        var b = m.get(canon);
        if (b) b.push(mine); else m.set(canon, [mine]);
      }
    }
  }
  DEEP = m;
  deepMs = Math.round(performance.now() - t0);
}

var SEARCH = null;   /* { term, raw, cps, chars, pos, stroke, mult, scanned } */

/** 檢字條件：**搬 glyph-browser 已經實作好的那套語法**（使用者：「請參考
 *  glyph-browser.html 已實作好的功能」）。它在那裡已經被驗收釘住，這裡只是搬到
 *  同一個輸入區共用（`?comp=` 那條路也是同一組語意）。
 *
 *    木+ / +木    木在左／右
 *    木/ / /木    木在上／下（使用者的「/ 木」＝木在上）
 *    口木         同時含口與木（往深處找）
 *    口口         口要出現兩次
 *    4木日        扣掉木、日之後剩 4 畫
 *    U+908F       直接看那個碼位
 *
 *  回傳 `{ terms, mult, pos, stroke }`。 */
function parseSearch(raw) {
  var s = String(raw).replace(/\s+/g, "");
  /* ★ 師父 2026-10-16：**`U+908F` 要能用** ✓——字集瀏覽頁與上面那段說明都這樣寫 ✓，
     但這一頁以前**沒有接** ✗（實測 `U+908F` 被讀成「U」「F」＋剩 908 畫 → 0 個 ✗）。
     這裡把它當成**那個字本身** ✓（與直接打那個字同一條路 ✓：單字＝檢字 ✓）。 */
  var um = /^u\+([0-9a-f]{4,6})$/i.exec(s);
  if (um) {
    var ucp = parseInt(um[1], 16);
    if (ucp > 0 && ucp <= 0x10ffff) {
      var uch = String.fromCodePoint(ucp);
      return { raw: s, term: uch, terms: [uch], mult: [1], pos: null, stroke: null };
    }
  }
  var n = null, digits = "", terms = [], mult = [], pos = null;
  var pts = Array.from(s);
  for (var i = 0; i < pts.length; i++) {
    var ch = pts[i];
    if (ch >= "0" && ch <= "9") { digits += ch; continue; }
    if (ch === "+" || ch === "/") continue;      /* 位置另外看鄰居 */
    var at = terms.indexOf(ch);
    if (at < 0) { terms.push(ch); mult.push(1); } else mult[at]++;
  }
  if (digits) n = parseInt(digits, 10);
  /* 位置只在「恰好一個部件」時有意義：運算子代表**另一個部件**在哪一側。
     所以 `木+`＝木在左、`+木`＝木在右；`木/`＝木在上、`/木`＝木在下。 */
  if (terms.length === 1) {
    var plus = s.indexOf("+"), slash = s.indexOf("/");
    if (plus >= 0 && slash < 0) pos = plus === 0 ? "右" : "左";
    else if (slash >= 0 && plus < 0) pos = slash === 0 ? "下" : "上";
  }
  return { raw: s, term: terms.length ? terms[terms.length - 1] : "", terms: terms, mult: mult, pos: pos, stroke: n };
}

/** 這個字裡有沒有 `term`、而且在 `pos` 那一側（量墨跡，跟 glyph-browser 同一支 `inkZoneOf`）。 */
function matchesPos(gi, term, pos) {
  if (!pos) return true;
  var slots = refSlotsOf(LIB, gi);
  for (var i = 0; i < slots.length; i++) {
    var s = slots[i];
    if (s.idsOnly || codePointOf(LIB, s.ref) !== term.codePointAt(0)) continue;
    var z;
    try { z = inkZoneOf(LIB, gi, s.strokeIx, inkOfRefInParent); } catch (e) { z = s.zone; }
    if (zoneMatches(z, pos)) return true;
  }
  return false;
}

/** 扣掉部件之後剩幾畫（跟 glyph-browser 同一套：非 99 的線段算 1 畫、99 遞迴）。 */
var strokeMemo = new Map(), strokeBusy = new Set();
function strokesOf(i) {
  var hit = strokeMemo.get(i);
  if (hit !== undefined) return hit;
  if (strokeBusy.has(i)) return 0;
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

/** 走完整棵樹數 `target` 這個碼位出現幾次（重複部件用） */
function countInTree(i, target, seen, depth) {
  if (depth > 40 || seen.has(i)) return 0;
  seen.add(i);
  var kids = componentKids(LIB, i), n = 0;
  for (var k = 0; k < kids.length; k++) {
    if (codePointOf(LIB, kids[k]) === target) n++;
    n += countInTree(kids[k], target, seen, depth + 1);
  }
  return n;
}

/** 部件檢字：拿輸入區整串當**查詢語法**（不是只拿最後一個字），跟 glyph-browser 一致。 */
function runSearch(raw) {
  buildDeepIndex();
  var q = parseSearch(raw);
  var out = [], seenCp = new Set();
  if (!q.terms.length && q.stroke === null) {
    SEARCH = { raw: q.raw, term: "", cps: [], chars: Array.from(String(raw)), q: q };
    return SEARCH;
  }

  /* 候選：多個部件取深層交集（跟 glyph-browser 一樣）；沒有部件就只有筆劃數 */
  var cand = null;
  if (q.terms.length) {
    var first = searchCps(q.terms[0]);
    cand = [];
    first.forEach(function (cp) { cand.push(cp); });
    for (var k = 1; k < q.terms.length && cand.length; k++) {
      var s = searchCps(q.terms[k]);
      cand = cand.filter(function (x) { return s.has(x); });
    }
  } else {
    cand = [];
    for (var i = 0; i < LIB.glyphs.length; i++) if (isPlainIdeograph(LIB, i)) cand.push(codePointOf(LIB, i));
  }

  /* 扣掉部件之後剩幾畫：查詢裡寫了幾次就扣幾次 */
  var sub = 0;
  for (var t = 0; t < q.terms.length; t++) {
    var ti = glyphIndexOf(q.terms[t]);
    if (ti !== undefined) sub += strokesOf(ti) * q.mult[t];
  }
  /* 重複部件要真的出現那麼多次 */
  var reps = [];
  for (var r = 0; r < q.terms.length; r++) if (q.mult[r] > 1) reps.push([q.terms[r].codePointAt(0), q.mult[r]]);

  for (var c = 0; c < cand.length; c++) {
    var cp = cand[c];
    if (!cp || seenCp.has(cp)) continue;
    var gi = indexOfCodePoint(LIB, cp);
    if (gi === undefined) continue;
    if (q.pos && !matchesPos(gi, q.terms[0], q.pos)) continue;
    var bad = false;
    for (var rr = 0; rr < reps.length; rr++) {
      if (countInTree(gi, reps[rr][0], new Set(), 0) < reps[rr][1]) { bad = true; break; }
    }
    if (bad) continue;
    if (q.stroke !== null && strokesOf(gi) - sub !== q.stroke) continue;
    seenCp.add(cp);
    out.push(cp);
  }

  out.sort(function (a, b) {
    /* ★ 師父 2026-10-16：「**BMP 要排在 Ext A 前面**」✓——
       所以**區塊順序是第一順位** ✓：BMP **全部**排在 Ext A 前面 ✓
       （⚠ 不是「大部分」✗：把「一般漢字」擺第一順位時，非 uXXXX 的 BMP 字會被夾在
         Ext A 後面 → 中間就跳回去了 ✗，實測就是這樣被抓到的 ✓）。
       同一個區裡面：一般漢字（`uXXXX`／`uXXXX-j` ✓）排前面，再按碼位 ✓。 */
    var byBlock = cmpByBlock(a, b);
    if (byBlock) return byBlock;
    var ai = indexOfCodePoint(LIB, a), bi = indexOfCodePoint(LIB, b);
    var ap = ai !== undefined && isPlainIdeograph(LIB, ai) ? 0 : 1;
    var bp = bi !== undefined && isPlainIdeograph(LIB, bi) ? 0 : 1;
    return ap - bp || a - b;
  });
  SEARCH = { raw: q.raw, term: q.term, cps: out, chars: Array.from(String(raw)), q: q, scanned: cand.length };
  return SEARCH;
}

/** 檢字條件的說明文字（跟 glyph-browser 的 `queryLabel()` 同一套講法）。 */
function searchLabel(q) {
  if (!q) return "";
  var s = "";
  if (q.terms.length) {
    s = q.terms.map(function (c) { return "「" + c + "」"; }).join("");
    if (q.pos) s += "在" + q.pos;
  }
  if (q.stroke !== null) s += (s ? "　" : "") + "扣掉部件後剩 " + q.stroke + " 畫";
  return s || q.raw;
}

/** 「含這個部件」的字（碼位集合）：同一個部件的所有相容碼位的命中聯集。 */
function searchCps(ch) {
  var cp = ch ? ch.codePointAt(0) : undefined;
  var set = new Set();
  if (cp === undefined || !DEEP) return set;
  var cps = synCps(cp);
  for (var k = 0; k < cps.length; k++) {
    var list = DEEP.get(cps[k]);
    if (!list) continue;
    for (var j = 0; j < list.length; j++) set.add(list[j]);
  }
  return set;
}

/* 候選格：一次只畫 CAND_MAX 個（全庫一次畫完要 25 秒，見 build-glyph-browser.ts 檔頭） */
var CAND_MAX = 96, candShown = 96;

function candCellHtml(cp) {
  var idx = indexOfCodePoint(LIB, cp);
  if (idx === undefined) return "";
  /* ★ 師父 2026-10-16：候選字**照 Unicode 分區上色** ✓（`--bc`＋`fill:currentColor` ✓，
     與字集瀏覽頁的格子**同一個做法、同一份調色盤** ✓）。
     同一輪再加：碼位**左下角**標出所屬區 ✓（`blockMarkHtml()`，共用層 ✓）——
     Ext A..I 給字母 ✓、相容區給「相」「補」✓、**基本區 2 萬字不標** ✓（師父指定的例外 ✓）。 */
  return '<div class="cell cand" data-cp="' + cp + '" title="' + hex(cp) + '"' +
    ' style="--bc:' + colorOfCp(cp) + '">' +
    '<div class="g">' + glyphSvg(idx) + "</div>" +
    '<div class="c">' + blockMarkHtml(cp) +
    '<span class="cp">' + hex(cp).replace("U+", "") + "</span></div></div>";
}

function renderSearch() {
  var el = $("cands"), note = $("candNote");
  if (!SEARCH) {
    el.innerHTML = "";
    note.textContent = "";
    $("candSec").hidden = true;
    $("stockSec").hidden = false;
    return;
  }
  var n = SEARCH.cps.length;
  var shown = SEARCH.cps.slice(0, candShown);
  var html = "";
  for (var k = 0; k < shown.length; k++) html += candCellHtml(shown[k]);
  el.innerHTML = html;
  $("candSec").hidden = false;
  /* 有候選字時**把庫存拼形收起來**（使用者的要求：手機畫面有限） */
  $("stockSec").hidden = n > 0;
  note.textContent = (searchLabel(SEARCH.q) || "含「" + SEARCH.term + "」") + "：" +
    n.toLocaleString() + " 個" +
    (n > shown.length ? "（顯示前 " + shown.length + " 個）" : "") +
    (deepMs ? "　索引 " + deepMs + " ms" : "");
  $("moreBtn").hidden = n <= shown.length;
}

/* ============================ 部件序列 ============================ */
/** 這個字形畫得出來的**一階**部件（依 KAGE 引用，再補 IDS 補上的那些）。
 *
 *  只取一階是有意的：`颰`＝風＋犮，列風、犮就夠；再往下一層（風 的 IDS 有 𠘨、
 *  犮 有 丶）就變噪音了。使用者的要求是「輸入進要看得到隹」——
 *  而 `進` 的 KAGE 直接引用只有 `辶`（字形 g1dbz），`隹` 是 IDS 補的，
 *  所以**兩邊都要**：KAGE 引用（有槽位）∪ 它與逐層 IDS 分解裡沒有槽位的內嵌部件。
 *  實測結果：`合`→口、`進`→辶 隹、`颰`→風 犮、`邏`→辶 羅、`寶`→𡩧 貝 缶 𡪓、`初`→衤 刀。
 *
 *  每一格帶：
 *    `ch`       顯示用的部件字元（相容碼位換成標準寫法）
 *    `parent`   要換掉它時，輸入區該寫的字（有槽位＝自己；內嵌部件＝掛它的那個節點）
 *    `box`      KAGE 框的序號（沒有自己的框＝-1，清單上標 IDS）
 *    `idsOnly`  沒有可替換的槽位
 *    `stuck`    IDS 補的部件，但**引擎換不掉**（`canReplaceCp()` 說不行）→ 列出來但不可點
 */
function componentChips(gi) {
  var boxes = boxesOfGlyph(gi);
  var out = [], seenName = {}, seen = new Set([gi]);
  var boxOfRef = {};
  for (var k = 0; k < boxes.length; k++) {
    if (!boxes[k].idsOnly && boxOfRef[boxes[k].ref] === undefined) boxOfRef[boxes[k].ref] = boxes[k].order;
  }
  var rootCh = compCharOf(gi);

  /* 有槽位的部件字元＝**KAGE 直接引用**那一批（只算第一階）。
     這是要扣掉 IDS 那一側的重複：`邏` 的 IDS 也寫了「羅 辶」，那兩個已經在 KAGE 清單裡了。
     **不可以遞迴整棵樹**——那樣 `隹`（藏 進→辶→… 深處）、`缶`（藏 寶→𡩧→珤 深處）
     全都會被當成「有槽位」而濾掉，清單就只剩第一階。 */
  var hasSlot = {};
  for (var s0 = 0; s0 < boxes.length; s0++) {
    if (!boxes[s0].idsOnly) hasSlot[compCharOf(boxes[s0].ref)] = 1;
  }
  /* 有 KAGE 子節點的直接引用。**用字形索引當鍵，不要用部件字元**：
     `峰` 的最後一個直接引用是 `夆`，而 `夆` 的子節點裡剛好也有一個「山」
     （與 `峰` 的另一個直接引用同名）——用字元當鍵會讓整批被誤判，
     丰／夂 就又冒出來了（實測就是這樣）。 */
  var hasKidRef = new Set();
  for (var s1 = 0; s1 < boxes.length; s1++) {
    if (!boxes[s1].idsOnly && refKidsOf(boxes[s1].ref).length) hasKidRef.add(boxes[s1].ref);
  }

  /** `ch` 可以是空字串：**沒有碼位、也沒有 IDS 的部件**（例：`從` 的第二個部件
      是 `g40la`，一個純筆劃字形）。那種部件畫得出來、但沒有名字可以打進輸入區，
      所以照樣列出來（讓使用者看得到整個結構）但**不可點**。 */
  var add = function (ch, parent, box, isIds, ref) {
    if (seenName[ch]) return false;
    if (isIds && hasSlot[ch]) return false;        /* 有槽位的會由 KAGE 那一側列出 */
    seenName[ch] = 1;
    /* 這一格點下去**到底有沒有結果**：IDS 補的部件沒有槽位，要問引擎
       （`canReplaceCp()`＝`applyReplace()` 的乾跑）。
       換不動的照樣列出來（看得到才不會以為漏了整個結構），但**不可點**——
       否則使用者會走進「選了卻永遠換不掉」的死路（回報：`䴺` 點 `來` → `䴺來` →
       打 `去` → `䴺來去` 引擎說換不到）。
       有槽位的（KAGE 直接引用）**一律可點**：即使它的字元是相容碼位
       （`進` 顯示 `辶`、引用其實是 `辶`），點下去仍然有意義（＝指名換掉它／查含它的字）。 */
    var stuck = isIds && !!ch && !canReplaceCp(LIB, gi, ch.codePointAt(0));
    out.push({ ch: ch, parent: parent, box: box === undefined ? -1 : box,
               idsOnly: box < 0, ref: ref === undefined ? -1 : ref, stuck: stuck });
    return true;
  };

  /* 第一階：KAGE 直接引用（有槽位） */
  for (var b0 = 0; b0 < boxes.length; b0++) {
    var br = boxes[b0];
    if (br.idsOnly || seen.has(br.ref)) continue;
    if (add(compCharOf(br.ref), compCharOf(br.ref), br.order, false, br.ref)) seen.add(br.ref);
  }
  /* IDS 補的內嵌部件（沒有 KAGE 槽位的那種）。
     只往「**沒有自己子節點**的引用」裡看一層，不再往下遞迴：
       `邏`→辶羅（羅 有子節點，不再展開，否則多出 罒／維）
       `進`→辶隹（辶 沒有子節點 → 看它的 IDS，得到隹）
       `寶`→𡩧貝缶𡪓（𡩧 沒有子節點 → 缶、𡪓）
       `從`→彳∅（∅ 沒有子節點，但它沒有碼位，列出來但不可點）
     再往下一層就變噪音（`峰` 會多出 丰／夂、`雨` 會多出四個 丶）——使用者回報的
     「峰夆電雨水的部件清單很奇怪」就是這個。 */
  var layer = [gi];
  for (var b1 = 0; b1 < boxes.length; b1++) {
    if (boxes[b1].idsOnly) continue;
    if (hasKidRef.has(boxes[b1].ref)) continue;   /* 它自己有子節點 → 不展開 IDS */
    layer.push(boxes[b1].ref);
  }
  for (var q = 0; q < layer.length; q++) {
    var node = layer[q], nch = q === 0 ? rootCh : compCharOf(node);
    var cp2 = codePointOf(LIB, node);
    var ids2 = cp2 && LIB.comp ? LIB.comp.get(cp2) : null;
    if (!ids2) continue;
    for (var m2 = 0; m2 < ids2.length; m2++) {
      var ci2 = indexOfCodePoint(LIB, ids2[m2]);
      if (ci2 === undefined || seen.has(ci2)) continue;
      /* 這個 IDS 部件的字元如果**已經在清單裡**（通常是它整個就是上層已經列出的那個字形，
         例：`電` 的 雨 —— KAGE 只引用 雨，IDS 也寫 雨），就不要重複列。
         使用者回報「峰夆電雨水的部件清單很奇怪」，`電` 列出「雨 雨(IDS)」就是這一個。 */
      if (seenName[compCharOf(ci2)]) continue;
      if (add(compCharOf(ci2), nch, -1, true, ci2)) seen.add(ci2);
    }
  }
  return out;
}

/** 這個部件在 KAGE 樹裡「掛在哪一個可以直接替換的節點底下」
    （替換法只換得動引用節點：`寶` 的「缶」要送進輸入區的是 `𡩧`）。 */
function kageParentOf(baseIdx, ref) {
  if (ref === undefined || ref < 0) return "";
  if (containsIdx(refKidsOf(baseIdx), ref)) return "";
  var ch = compCharOf(ref);
  if (!ch) return "";
  var stack = [baseIdx], seen = new Set([baseIdx]);
  while (stack.length) {
    var i = stack.pop();
    var kids = refKidsOf(i);
    for (var k = 0; k < kids.length; k++) {
      var j = kids[k];
      if (seen.has(j)) continue;
      seen.add(j);
      var cp = codePointOf(LIB, j);
      var ids = cp && LIB.comp ? LIB.comp.get(cp) : null;
      if (ids) {
        for (var m = 0; m < ids.length; m++) {
          if (ids[m] === ch.codePointAt(0)) return compCharOf(j);
        }
      }
      stack.push(j);
    }
  }
  return "";
}

/* ================= 建議更好的基字（第 111 輪） =================
 *
 * 客人輸入「初衤禾」（把 `初` 的 `衤` 換成 `禾`）時，結果的**部件序列**是「禾＋刀」，
 * 但 `初` 的左槽本來是為 `衤` 準備的 ✗；而「利刂刀」的結果是**同一個序列**（禾＋刀），
 * `利` 的左半本來就是左形的 `禾`、右槽是為 `刂`（刀的右形）準備的 ✓ → 好看得多 ✓。
 *
 * 所以：找出**同一個部件序列（模形式差異）**的字，讓客人**自己挑**要不要改用它當基字 ✓。
 *   · 「形式」由 `out/form-groups.json`（`__FORM_GROUPS__` 內嵌）回答 ✓
 *     ——`刂→刀`、`扌→手`、`釒→金`、`讠→言`…（來源見 tools/form-groups.ts ✓）
 *   · **只建議引擎真的換得動的**（`canReplaceCp()` 乾跑 ✓）——清單說可以、做卻失敗是地獄 ✗
 *   · **一律不自動改**：建議只是按鈕，客人點了才換 ✓（目標：「讓客人檢視挑擇」✓）
 */
var FORM_GROUPS = __FORM_GROUPS__;
var SEQ_INDEX = null;
/** 這個碼位的「本形」（不在形式群裡就回自己） */
function canonOf(cp) {
  var g = FORM_GROUPS && FORM_GROUPS.canon;
  var c = g ? g[cp.toString(16)] : undefined;
  return c === undefined ? cp : c;
}
/** 這條形式關係的人話理由（師父的表 ✓；沒有就回空字串） */
function formWhy(cp) {
  var w = FORM_GROUPS && FORM_GROUPS.why;
  var s = w ? w[cp.toString(16)] : undefined;
  return s || "";
}
/** 「正規化後的部件序列 → 有哪些字」的索引（**第一次要用才建**，約 8 萬個字） */
function buildSeqIndex() {
  if (SEQ_INDEX) return SEQ_INDEX;
  SEQ_INDEX = {};
  if (LIB.comp) {
    LIB.comp.forEach(function (comps, cp) {
      if (!comps || !comps.length || comps.length > 8) return;
      var key = "", i;
      for (i = 0; i < comps.length; i++) key += (i ? "," : "") + canonOf(comps[i]);
      var list = SEQ_INDEX[key];
      if (list) list.push(cp); else SEQ_INDEX[key] = [cp];
    });
  }
  return SEQ_INDEX;
}
/** 建議：同一個部件序列、但形式更好的基字（最多 3 個） */
function suggestBasesFor(chars) {
  var out = [];
  if (!chars || chars.length !== 3) return out;          /* 只處理「基字＋舊部件＋單一新部件」✓ */
  var baseIx = glyphIndexOf(chars[0]);
  if (baseIx === undefined) return out;
  var baseCp = codePointOf(LIB, baseIx);
  if (!baseCp || !LIB.comp) return out;
  var comps = LIB.comp.get(baseCp);
  if (!comps || !comps.length) return out;
  var oldCp = chars[1].codePointAt(0), newCp = chars[2].codePointAt(0);
  var target = [], tkey = "", i, changed = false;
  for (i = 0; i < comps.length; i++) {
    var c = comps[i] === oldCp ? newCp : comps[i];
    if (comps[i] === oldCp) changed = true;
    target.push(c);
    tkey += (i ? "," : "") + canonOf(c);
  }
  if (!changed) return out;        /* 舊部件不在序列裡（例：手畫的部件）→ 沒得比 ✓ */
  var cands = buildSeqIndex()[tkey] || [];
  for (i = 0; i < cands.length; i++) {
    var cp = cands[i];
    if (cp === baseCp) continue;
    var seq = LIB.comp.get(cp);
    if (!seq || seq.length !== target.length) continue;
    var diff = -1, n = 0, j;
    for (j = 0; j < seq.length; j++) if (seq[j] !== target[j]) { diff = j; n++; }
    /* ⓪ **完全相同的序列** → 那個字本來就是這個結果 ✓（最強的建議 ✓）。
       ★ 師父第 119 輪的架構：「客人會先用 BMP 輸入……**但系統明白客人的意圖之後，
         可以建議 extension 的字呀，兩者並不衝突無須取捨。**」
         → 所以**非 BMP 也照建議** ✓（那是**點一下**就用的 ✓，不必客人打出來 ✓）；
           一般漢字區只當**排序加分** ✓。
       ★★ 但排序是 **BMP 優先、其次才是「本來就是這個字」** ✓——
         實測：`初衤禾` 若讓非 BMP 的「本來就是這個字」排第一 ✗，
         會把師父要的 `利刂刀`（BMP、常用 ✓）擠掉 ✗。兩者都給，但**好打的排前面** ✓。 */
    if (n === 0) {
      var exBmp = (cp >= 0x4e00 && cp <= 0x9fff);
      out.push({
        input: String.fromCodePoint(cp),      /* 直接用那個字，不必換部件 ✓ */
        fromCh: "", toCh: "", why: "", exact: true, bmp: exBmp,
        rank: (exBmp ? 10 : 0) + 5,
      });
      continue;
    }
    if (n !== 1) continue;                               /* 只建議「只差一個形式」的 ✓ */
    var fromCp = seq[diff], toCp = target[diff];
    if (canonOf(fromCp) !== canonOf(toCp)) continue;     /* 必須同一個形式群（＝只是異形部件差異 ✓） */
    var gi = indexOfCodePoint(LIB, cp);
    if (gi === undefined || !canReplaceCp(LIB, gi, fromCp)) continue;   /* 引擎真的換得動 ✓ */
    var fromCh = String.fromCodePoint(fromCp), toCh = String.fromCodePoint(toCp);
    var bmp = (cp >= 0x4e00 && cp <= 0x9fff);
    out.push({
      input: String.fromCodePoint(cp) + fromCh + toCh,   /* 建議的輸入字串（照原語法 ✓） */
      fromCh: fromCh, toCh: toCh, why: formWhy(fromCp), exact: false, bmp: bmp,
      /* 排序：**BMP 優先** ✓（好打的排前面 ✓）；另一個碼位的形式（`刂`）比同碼 var 更像專用偏旁形 ✓ */
      rank: (bmp ? 10 : 0) + (fromCp !== canonOf(fromCp) ? 2 : 0),
    });
  }
  out.sort(function (a, b) { return b.rank - a.rank; });
  /* 最多 6 個：第 1 個在「拼出來的形」那邊**並排**，其餘放庫存區 ✓
     （師父第 112 輪：「可以讓客人多看到幾個比例」——庫存區的格子同比例，好比較 ✓）。 */
  return out.slice(0, 6);
}
/** 組一個建議字串，並量「墨有沒有搞成一塊」（師父第 112 輪的警告 ✗）。
 *  （「新部件是第幾筆」用內嵌模組 `ink-conflict.ts` 的 `partStrokeOf` ✓，不要自己再寫一份 ✗）
 *  回傳 null＝組不出來；否則 `{svg, blob, note}` ✓ */
function composeSuggestion(input, newCp) {
  try {
    var rr = evalSeq(LIB, input, {});
    if (!rr || !rr.ok) return null;
    var svg = svgOfLib(rr.lib, rr.targetIdx);
    var si = partStrokeOf(rr.lib, rr.targetIdx, newCp);
    if (si < 0) return { svg: svg, blob: false, note: "" };
    var c = inkConflictOf(rr.lib, rr.targetIdx, si);
    return { svg: svg, blob: isInkBlob(c), note: inkConflictNote(c) };
  } catch (e) { return null; }
}

/** 把「建議／推薦」那兩塊收起來 ✓（IDS 模式與建議列共用 ✓） */
function clearSuggestRow() {
  var wrap = $("sugWrap"), stage = $("sugStage"), cap = $("sugCap");
  var stockBox = $("stockSuggest"), row = $("sugRow");
  showEl(wrap, false);
  if (stage) stage.innerHTML = "";
  if (cap) cap.textContent = "";
  if (stockBox) showEl(stockBox, false);
  if (row) row.innerHTML = "";
}

/** 顯示／收起一個元素 ✓（hidden 屬性 ＋ **行內 display** ✓）。
 *  ⚠ 作者樣式的 display 會蓋掉 [hidden] 的 display:none ✗（第 112 輪的教訓 ✓）——
 *    所以收起時要一起寫行內 display:none ✓、顯示時要清掉它 ✓。 */
function showEl(el, on) {
  if (!el) return;
  el.hidden = !on;
  el.style.display = on ? "" : "none";
}

/** 設定魔術棒的狀態 ✓（見檔頭的 WAND ✓）。
 *  seqs 有值＝這次 IDS 算出來的建議序（**不寫在畫面上** ✗）；
 *  setWand(null, true)＝「保留」：輸入區現在就是剛套用的**那一個**建議序，
 *  而且**後面還有沒看過的** ✓ → 魔術棒繼續站著（再點換下一個 ✓）。
 *  ⚠ **沒有推薦構字序時一定要收起來** ✗——包括「全部建議都看過了」的情形 ✓
 *    （師父 2026-10-15 的指示：沒有推薦就隱藏魔杖 ✓）。 */
function setWand(seqs, keepIfCurrent) {
  var b = $("wand");
  if (seqs) { WAND.seqs = seqs.slice(); WAND.ix = -1; }
  else if (!(keepIfCurrent && WAND.seqs.length &&
             WAND.ix < WAND.seqs.length - 1 &&              /* 後面還有沒看過的 ✓ */
             $("seq").value === WAND.seqs[WAND.ix])) {
    WAND.seqs = []; WAND.ix = -1;
  }
  /* ⚠ 一定要用 showEl ✓——`.iconbtn` 的 `display:flex` 是作者樣式，
     會蓋掉 `[hidden]` 的 `display:none` ✗：只設 `hidden` 的話按鈕**還是看得見** ✗
     （第 112 輪的同一個坑；師父 2026-10-15 一開始就看到了 ✓）。 */
  showEl(b, WAND.seqs.length > 0);
}

/** 點魔術棒：把**下一個**建議的拼形序填進輸入區並重畫 ✓（再點換下一個 ✓）。 */
function wandNext() {
  if (!WAND.seqs.length) return;
  WAND.ix = (WAND.ix + 1) % WAND.seqs.length;
  var s = WAND.seqs[WAND.ix];
  $("seq").value = s;
  lastLabelMode = null;
  render();
  toast("已套用建議的拼形序「" + s + "」✓（再點 🪄 換下一個 ✓）", "ok");
}

/** 畫建議（師父第 112 輪的兩個要求）：
 *  ① **最佳的那個與現在的形並排**（`#sugStage` ＋ `#sugCap`）——客人才看得出好在哪裡 ✓
 *  ② 其餘的放**下方庫存區**（`#sugRow`，同一個比例所以好比較 ✓）；
 *     **拼形式放在 hover hint**（`title`），格子裡只畫字形，客人一次可以多看幾個 ✓。
 *  ⚠ **一律先驗「換完能不能看」**（`inkConflictOf` ✓）：師父第 112 輪指出
 *    「庚广廣」墨都搞一塊 ✗、「庚广艹」還組不好 ✗——只驗「引擎換得動」是不夠的 ✗。
 *  ⚠ 一律**點了才換**（不自動改 ✓）；沒有建議時兩處都收起來 ✓。 */
function renderSuggest(st, r) {
  var wrap = $("sugWrap"), stage = $("sugStage"), cap = $("sugCap");
  var stockBox = $("stockSuggest"), row = $("sugRow");
  var clear = function () {
    showEl(wrap, false);
    showEl(stockBox, false);
    if (stage) stage.innerHTML = "";
    if (row) row.innerHTML = "";
    if (cap) cap.textContent = "";
  };
  if (!wrap || !stockBox) return;
  var sug = (r && r.substituted) ? suggestBasesFor(st.chars) : [];
  if (!sug.length) { clear(); return; }

  /* 組出建議的形，並**把「墨搞成一塊」的候選剔除** ✗（留著只會害客人 ✓） */
  var made = [], blobs = 0;
  for (var i = 0; i < sug.length; i++) {
    var newCp = sug[i].toCh.codePointAt(0);
    var got = composeSuggestion(sug[i].input, newCp);
    if (!got) continue;                       /* 組不出來 → 不建議 ✓ */
    if (got.blob) { blobs++; continue; }      /* 一團墨 → 不建議 ✓（師父的判例） */
    made.push({ s: sug[i], svg: got.svg, note: got.note });
  }
  if (!made.length) {
    clear();
    /* 全部候選都不可用時，講清楚為什麼（不要讓客人以為「沒有更好的」）✓
       ⚠ 這句要**回傳**給 `render()` 合併，不要直接 toast ✗——不然會蓋掉
       「客人自己那個組合疊墨」的警告（實測踩到 ✓）。 */
    return (blobs > 0 && r && r.substituted)
      ? "有 " + blobs + " 個看起來更好的基字，但換上去墨會疊成一塊 ✗——所以不建議"
      : "";
  }

  /* ① 最佳的並排 */
  var best = made[0];
  stage.innerHTML = best.svg;
  stage.setAttribute("data-sug", best.s.input);
  cap.textContent = best.s.exact
    ? best.s.input + "（本來就是這個字 ✓）"
    : best.s.input + "（" + best.s.fromCh + "→" + best.s.toCh + "）";
  if (!best.s.bmp) cap.textContent += "　非 BMP，可直接點 ✓";
  showEl(wrap, true);

  /* ② 其餘的放庫存區（拼形式只在 hover hint ✓） */
  if (made.length > 1) {
    var html = "";
    for (var k = 1; k < made.length; k++) {
      var m = made[k];
      var tip = m.s.input + "（" + m.s.fromCh + "→" + m.s.toCh + "）" +
        (m.s.why ? "——" + m.s.why : "");
      html += '<div class="cell" data-sug="' + m.s.input + '" title="' + tip + '">' + m.svg + "</div>";
    }
    row.innerHTML = html;
    showEl(stockBox, true);
  } else {
    row.innerHTML = "";
    showEl(stockBox, false);
  }
  return "";
}

/** **警告客人：現在這個組合墨疊在一起了**（師父第 112 輪的指示 ✓）。
 *  只在「原地換一個部件」的結果上量（真字的畫法不會有這個問題 ✓）。
 *  「換上去的那一筆」＝結果裡引用著**客人打的那個新部件**的那一筆 ✓。
 *  回傳警告字串或 "" ✓ */
function inkWarningOf(st, r) {
  if (!r || !r.ok || !r.substituted) return "";
  if (!st || !st.chars || st.chars.length !== 3) return "";
  var newCp = st.chars[2].codePointAt(0);
  if (!newCp) return "";
  try {
    var si = partStrokeOf(r.lib, r.targetIdx, newCp);
    if (si < 0) return "";
    var c = inkConflictOf(r.lib, r.targetIdx, si);
    return isInkBlob(c) ? inkConflictNote(c) : "";
  } catch (e) { return ""; }
}

/** 滑過大字的框 → 把對應的那一格加上 `hover` ✓（滑出＝全部清掉 ✓）。
 *  孫框、表意描述序的方塊都靠這一條才看得出「框 ↔ 清單」的對應 ✓（師父 2026-10-15 的要求 ✓）。 */
function hoverChip(box) {
  var ms = document.querySelectorAll("#seqChips .mini.comp");
  for (var i = 0; i < ms.length; i++) {
    var on = box >= 0 && Number(ms[i].getAttribute("data-box")) === box;
    if (on) ms[i].classList.add("hover"); else ms[i].classList.remove("hover");
  }
}

/** 反向連動：滑過部件清單的格子 → **大字上對應的那個框也亮** ✓
 *  （師父 2026-10-15：「從大字可以連動部件清單，但**反向不行**」✓）。 */
function hoverFrame(box) {
  var rs = document.querySelectorAll("#big .cbox");
  for (var i = 0; i < rs.length; i++) {
    var on = box >= 0 && Number(rs[i].getAttribute("data-box")) === box;
    if (on) rs[i].classList.add("hover"); else rs[i].classList.remove("hover");
  }
}

/** 把一組框畫成「部件清單」的格子 ✓——**只看得到、不能換** ✓。
 *
 *  用於沒有「替換槽位」語意的兩處：
 *  ① **表意描述序** ✓——清單＝表意描述序的那幾塊（以前整段清空 ✗，
 *     師父 2026-10-15 回報「點庫存 IDS，部件清單都是空的」✓）；
 *  ② **字框：孫** ✓——清單＝所有子孫的框（點框／點格子才互相亮得起來 ✓）。
 *  `data-box` 是連動的鑰匙 ✓（大字的框也帶同一個號碼 ✓）。 */
function renderBoxChips(boxes, capText) {
  var el = $("seqChips"), cap = $("seqNote"), note = $("philNote");
  if (note) note.textContent = "";
  if (!boxes || !boxes.length) { el.innerHTML = ""; cap.textContent = ""; return; }
  var L = (MAIN && MAIN.lib) ? MAIN.lib : LIB;
  var h = [];
  for (var k = 0; k < boxes.length; k++) {
    var b = boxes[k];
    var depth = b.depth || 0;
    var label = depth > 0 ? (depth === 1 ? "孫" : "孫" + depth) : "";
    var tip = "";
    try { tip = boxTipText(L, b); } catch (e0) { tip = ""; }
    tip += (depth > 0 ? "　第 " + (depth + 1) + " 代" : "") + "　（只看得到；點一下＝選它 ✓）";
    var g = "";
    try { g = b.ref >= 0 ? glyphSvg(b.ref) : ""; } catch (e1) { g = ""; }
    h.push('<div class="mini comp idsonly' + (b.order === ACTIVE_BOX ? " on" : "") + '"' +
      ' data-box="' + b.order + '"' +
      ' style="--bc:' + colorOfGlyph(b.ref) + ';--c:' + boxColor(b.order) + '"' +
      ' title="' + tip + '">' +
      '<span class="g">' + g + "</span>" +
      (label ? '<span class="ids">' + label + "</span>" : "") + "</div>");
  }
  el.innerHTML = h.join("");
  var sel = ACTIVE_BOX >= 0 && MAIN ? boxCoordText(ACTIVE_BOX) : "";
  cap.textContent = (capText || "部件清單") + (sel ? "　·　" + sel : "");
}

function renderSeq(st) {
  var el = $("seqChips"), cap = $("seqNote");
  /* ★ 表意描述序：部件清單＝**表意描述序的那幾塊** ✓（師父 2026-10-15 回報空的 ✗） */
  /* ★ 看得到、不能換的清單（表意描述序／中間部件／拼形結果的最終部件）——一律走 currentBoxes() ✓，
     框、清單、塗色才會指著同一格 ✓（師父的連動要求 ✓）。 */
  if (st && st.mode === "ids") { renderBoxChips(currentBoxes(), "部件清單"); return; }
  if (MAIN && (SHOW_MID || isComposed())) { renderBoxChips(currentBoxes(), "部件清單"); return; }
  var seq = $("seq").value.replace(/\s+/g, "");
  var chars = Array.from(seq);
  if (!chars.length) { el.innerHTML = ""; cap.textContent = ""; $("philNote").textContent = ""; return; }
  var skip = (st && st.eval && st.eval.substituted) ? changedCharsOf(st) : null;
  var ch = seqOwnerChar(st, seq, skip);
  /* ★ 沒有「沒被改過」的字可以當主角（例「峰夆電雨水」「髜昇厏乍电」）→
     直接列**拼出來的形**自己的部件 ✓（師父 2026-10-15 的回報 ✓）。 */
  var gi = ch ? glyphIndexOf(ch) : undefined;
  var chips = gi === undefined ? [] : componentChips(gi);
  /* ★ 被改過的字不能當主角 ✓；主角是拼形結果裡的葉、列不出部件時，
     直接列**拼出來的形**自己的部件 ✓
     （師父 2026-10-15：「峰夆電雨水」不該列「電」、「髜昇厏乍电」不該列「厏」✓）。 */
  if (skip && !chips.length && MAIN) { renderBoxChips(composedChips(), "部件清單"); return; }
  /* 獨體字、或沒有部件可列：**整段不顯示**（使用者的要求），不是留一句說明。 */
  if (gi === undefined || !chips.length) {
    el.innerHTML = "";
    cap.textContent = "";
    $("philNote").textContent = "";
    return;
  }
  var at = chars.indexOf(ch);
  var sel = ACTIVE_BOX >= 0 && MAIN ? boxCoordText(ACTIVE_BOX) : "";
  /* 只寫「部件清單」就好（使用者的要求）——是哪個字的清單看輸入區就知道；
     選了框才多帶座標。 */
  cap.textContent = "部件清單" + (sel ? "　·　" + sel : "");
  /* 第 101 輪：**理據拆分**（說文，v6 的 `LIB.phil`）——**只顯示、不參與組字** ✓。
     例 `雖`：理據＝虫＋唯 ✓（視覺＝虽＋隹，那是拿來組字的）✓ → 讓檢字軟件對文字學家也有用 ✓。
     刻意放在**另一個元素**（`philNote`）✗ 不動 `seqNote`：後者是既有驗收的快照欄位 ✓。 */
  (function () {
    var note = $("philNote");
    try {
      var cp = ch ? ch.codePointAt(0) : undefined;
      var pl = cp !== undefined && LIB && LIB.phil && LIB.phil.get ? LIB.phil.get(cp) : null;
      note.textContent = pl && pl.length >= 2
        ? "理據（說文）：" + pl.map(function (x) { return String.fromCodePoint(x); }).join("＋")
        : "";
    } catch (e) { note.textContent = ""; }
  })();
  /* 每一格：KAGE 字形 ＋ 小字標籤（有槽位的不標、IDS 的標 IDS、換不掉的標「—」）；
     點一下＝用它替換（見 `replaceWith`）。**不可點的兩種**：
     沒有碼位也沒有 IDS 的部件（沒有字元可以打進輸入區）、以及 `stuck`
     （有字元、但引擎換不到，見 `componentChips()`）。 */
  var h = [];
  for (var k = 0; k < chips.length; k++) {
    var c = chips[k];
    var hasBox = c.box >= 0;
    var named = !!c.ch;
    /* 有字元而且換得動的才可點（`stuck`＝IDS 補的部件但引擎換不到，
       見 `componentChips()`；沒有碼位的部件本來就沒有字元可以打進輸入區）。 */
    var clickable = named && !c.stuck;
    var glyph = c.ref >= 0 ? glyphSvg(c.ref)
      : (glyphIndexOf(c.ch) === undefined ? c.ch : glyphSvg(glyphIndexOf(c.ch)));
    var tip = (hasBox ? "第 " + (c.box + 1) + " 個部件（有槽位）" : "IDS 補的部件（沒有槽位）") +
      (clickable ? "：" + c.ch + "　點一下＝用它替換"
                 : named ? "：" + c.ch + "　引擎換不到這個部件（沒有可用的槽位）——只看得到"
                         : "：這個部件在字庫裡沒有碼位，換不掉（只看得到）");
    h.push('<div class="mini comp' + (hasBox ? "" : " idsonly") +
      (named ? "" : " unnamed") + (c.stuck ? " stuck" : "") +
      (hasBox && c.box === ACTIVE_BOX ? " on" : "") + '"' +
      (named ? ' data-ch="' + c.ch + '" data-parent="' + (c.parent || c.ch) + '"' : "") +
      (c.stuck ? ' data-stuck="1"' : "") +
      (hasBox ? ' data-box="' + c.box + '"' : "") +
      ' style="--bc:' + colorOfGlyph(c.ref) + ";" +
      (hasBox ? "--c:" + boxColor(c.box) : "--c:var(--mut)") + '"' +
      ' title="' + tip + '">' +
      '<span class="g">' + glyph + "</span>" +
      (hasBox ? "" : '<span class="ids">' + (clickable ? "IDS" : "—") + "</span>") + "</div>");
  }
  el.innerHTML = h.join("");
}

/** 選定部件的座標文字（框的上方要顯示座標——使用者的要求）。
    用**原始 KAGE 框**（引擎實際用的那個矩形），`[x1,y1,x2,y2]`。 */
function boxCoordText(order) {
  if (!MAIN) return "";
  var deep = SHOW_MID && !(lastEval && lastEval.mode === "ids");
  var list = currentBoxes();
  if (!list) return "";
  for (var k = 0; k < list.length; k++) {
    var b = list[k];
    if (b.order !== order) continue;
    /* 孫框的 `raw`／`tight` 是**在它自己那一格裡的座標** ✗——
       要顯示的是投影到**根座標**的 `abs` ✓（見 descendantBoxes ✓）。 */
    var r = (deep ? b.abs : null) || b.raw || b.tight;
    var head = "第 " + (order + 1) + " 個框" +
      (deep && b.depth > 0 ? "（第 " + (b.depth + 1) + " 代）" : "");
    if (!r) return head + "：IDS（沒有框）";
    var q = [r[0], r[1], r[2], r[3]].map(function (v) { return Math.round(v); });
    return head + "（" + compCharOf(b.ref) + "）[" + q.join(",") + "]" + (b.idsOnly ? "　IDS" : "");
  }
  return "";
}

/* ============================ 庫存拼形 ============================ */
/* **原文貼上，不要手打**——庫存裡有罕用字（𩀨），打錯看不出來。
   來源：pinxing.md 的〈介面〉第 3 條。
   `報土业` 一度因為組不出來被移出（引擎換不到孫級部件），2026-10-13 引擎加了
   IDS 槽位推斷之後**放回來**；`街圭舞` 是使用者要求放進來檢查「舞 太大」的那一組
   （放進來時已改成墨跡對齊，大小與 `衚胡舞` 一致）。 */
var STOCK = [
  "邏羅寶貝𩀨從䞃致招",
  "初衤礻",
  "颰犮电",
  "峰夆電雨水",
  "髜昇厏乍电",
  "衚胡舞",
  "街圭舞",
  "寶缶支",
  "報土业"
];

/* ★ 師父第 122 輪：把兩個 **IDS**（常見的合文 ✓）放在庫存區，讓客人一點就看到 ✓。
   ⚠ IDS 不是拼形序 ✗——IDS 說「要什麼」（`⿰木⿳金⿰水火土`），
     拼形序說「**怎麼拼**」（`機幾墨黒𨩛星炚日水`）✓。兩者不能互換 ✓。
     這裡的拼形序是師父手工擬的 ✓（實測 IoU：elements 0.359 ✓、xue 0.301 ✓，
     比自動搜尋的 0.366／0.277 更穩 ✓——xue 那題看圖也是手工的乾淨 ✓）。 */
/** IDS 用人話寫出來 ✓——**很多系統字型沒有 U+2FF0–2FFF** ✗（實測 headless Edge 全變方框 ▯ ✓），
 *  所以訊息裡不能只印原始 IDS ✓，要附一句「左右（木｜上中下（金｜左右（水火）｜土））」✓。 */
var IDS_OPNAME = { "⿰": "左右", "⿱": "上下", "⿲": "左中右", "⿳": "上中下",
  "⿴": "全包", "⿵": "上包", "⿶": "下包", "⿷": "左包",
  "⿸": "左上包", "⿹": "右上包", "⿺": "左下包", "⿻": "重疊" };
var IDS_ARITY = { "⿰": 2, "⿱": 2, "⿲": 3, "⿳": 3, "⿴": 2, "⿵": 2, "⿶": 2, "⿷": 2, "⿸": 2, "⿹": 2, "⿺": 2, "⿻": 2 };
function idsToText(s) {
  var cs = Array.from(String(s)), i = 0;
  function walk() {
    if (i >= cs.length) return "";
    var c = cs[i];
    if (IDS_OPNAME[c]) {
      i++;
      var k = IDS_ARITY[c], parts = [];
      for (var j = 0; j < k; j++) parts.push(walk());
      return IDS_OPNAME[c] + "(" + parts.join("｜") + ")";
    }
    i++;
    return c;
  }
  var out = "";
  while (i < cs.length) out += walk();
  return out;
}
/** 把 IDS 的**葉**取成有序的碼位陣列 ✓（解析不了回 null ✓） */
function idsLeafList(s) {
  var cs = Array.from(String(s)), out = [];
  for (var i = 0; i < cs.length; i++) {
    var c = cs[i];
    if (IDS_ARITY[c]) continue;
    if (c === "&" || c === "{" || c === "[" || c === "#" || c === "(" || c === ")" || c === "}") return null;
    out.push(c.codePointAt(0));
  }
  return out;
}
/** 把 IDS 的**葉**拉平（例 `⿰女子` → `女,子` ✓）——解析不了就回 "" ✓。
 *  用途：拿它去**反查字庫**（`LIB.comp` 就是每個字的葉序 ✓）→ 客人貼 IDS 就能立刻看到那個字 ✓。 */
function idsLeafKey(s) {
  var cs = Array.from(String(s)), out = [];
  for (var i = 0; i < cs.length; i++) {
    var c = cs[i];
    if (IDS_ARITY[c]) continue;                 /* 算子跳過 ✓ */
    if (c === "&" || c === "{" || c === "[" || c === "#" || c === "(" || c === ")" || c === "}") return "";
    out.push(c.codePointAt(0));
  }
  return out.join(",");
}
/** 葉序 → 有哪些字（**懶建** ✓：第一次要查才掃 `LIB.comp`，約 0.5 秒 ✓） */
var LEAF_INDEX = null;
function leafIndexOf(key) {
  if (!LEAF_INDEX) {
    LEAF_INDEX = {};
    if (LIB.comp) {
      LIB.comp.forEach(function (comps, cp) {
        if (!comps || !comps.length || comps.length > 8) return;
        var k = comps.join(",");
        var list = LEAF_INDEX[k];
        if (list) list.push(cp); else LEAF_INDEX[k] = [cp];
      });
    }
  }
  return LEAF_INDEX[key] || null;
}

/* ==================== IDS ↔ 字形（師父第 124 輪） ====================
 * ① **把 IDS 按 IDC 等比分配組出來**（故意醜 ✓）——客人才看得出「拼形序」好在哪裡 ✓。
 *    做法：把每個葉依算子切成等分方格（⿰ 左右各半、⿳ 上中下各三分之一… ✓），
 *    造一個**合成字形**（每個葉一個引用 ＋ 等分框 ＋ 不伸縮 ✓）再交給引擎畫 ✓。
 *    這正是師父說的「按 IDC 的等比分配」✓——**沒有墨跡對齊、沒有讓位** ✓，所以醜 ✓。
 * ② **把字拆成 IDS**（依**畫法**推 ✓，零新增資料 ✓）——客人不會打 IDC，所以要有按鈕 ✓。
 */
var IDS_DIV = { "⿰": [2, 0], "⿱": [2, 1], "⿲": [3, 0], "⿳": [3, 1] };

/** 產生「等比分配」的合成字形 ✓；回傳 {lib, idx, n, problems, slots} 或 null ✓
 *
 *  ★ 正解＝**直接呼叫模塊 ids-glyph.ts 的 idsGlyph()** ✓——
 *    它把每一葉**等比縮進自己那一格** ✓（例 木 [0,0,100,200]、金 [100,0,200,67] ✓），
 *    所以**兄弟框不重疊** ✓＝筆劃不會糊成一大塊 ✓。
 *  ⚠ 舊版（把 200×200 的部件擺在格心、**不縮放**）會讓每一塊都大幅溢出 ✗——
 *    「⿰木⿳金⿰水火土」就是這樣糊成一團 ✗（師父 2026-10-15 抓到 ✓）。
 *
 *  ⚠ 這裡**不要再自己寫一份分框** ✗：曾經寫過兩份，頁面這一份忘了縮放就壞了 ✓。
 *    分框只有一個來源＝tools/ids-glyph.ts ✓（check-ids-glyph.ts 在驗它 ✓）。 */
function idsComposeNaive(ids) {
  var r = null;
  try { r = idsGlyph(String(ids), LIB); } catch (e) { return null; }
  if (!r || !r.ok) return null;
  return { lib: r.lib, idx: r.idx, n: r.n, problems: r.problems || [], slots: r.slots };
}

/* ==================== 任意 IDS → 建議拼形序（師父第 125 輪） ====================
 * 師父的例子：客人打「⿰木垚」→ 系統按 IDC 各半畫得醜醜的 ✓ →
 * 然後建議「**桂圭垚**」（`桂`＝木＋圭 ✓，把 `圭` 換成 `垚` ✓）→ 點一下字就漂亮了 ✓。
 *
 * 演算法（**零新增資料** ✓，用字庫的 `comp`＝**直接分量** ✓）：
 *   ① 目標的葉序（例 木,垚 ✓）
 *   ② 掃字庫：分量數相同、**只差一個位置**的字 ✓（＝換一次就好 ✓）
 *   ③ **排序用「遞迴葉子重疊」** ✓✓——這是實測出來的關鍵判準 ✓：
 *      `垚` 遞迴展開是 土,土,土 ✓；`圭` 是 土,土 ✓ → 重疊 2/3 ✓ **第 2 名** ✓；
 *      而「木＋千」「木＋山」這些 ✗ 一個土都沒有 ✓ → 0 ✓。
 *      （我試錯過兩個判準：**墨框面積比** → 桂 738 名 ✗；**形狀 IoU** → 1772 名 ✗
 *        ——因為正規化會把長寬比壓掉 ✗，而 `圭`(2土) 與 `垚`(3土) 的差別正在比例 ✓。）
 *   ④ 再用引擎真組一次 ✓、剔掉「墨疊一塊」的 ✓。
 */
function leafMultiset(cp, depth) {
  var out = new Map();
  var comps = LIB.comp ? LIB.comp.get(cp) : null;
  if (!comps || !comps.length || depth > 4) { out.set(cp, 1); return out; }
  for (var i = 0; i < comps.length; i++) {
    leafMultiset(comps[i], depth + 1).forEach(function (v, k) { out.set(k, (out.get(k) || 0) + v); });
  }
  return out;
}
/** 為一個 IDS 找建議的拼形序 ✓（回傳 [{seq, share, extra, bmp}] ✓，最多 limit 個 ✓） */
function seqCandidatesForIds(ids, limit) {
  var leaves = idsLeafList(ids);
  if (!leaves || leaves.length < 2 || leaves.length > 6 || !LIB.comp) return [];
  var out = [];
  LIB.comp.forEach(function (comps, cp) {
    if (comps.length !== leaves.length) return;
    var diff = -1, n = 0, i;
    for (i = 0; i < comps.length; i++) {
      if (comps[i] !== leaves[i]) { diff = i; n++; if (n > 1) return; }
    }
    if (n !== 1) return;
    var oldCp = comps[diff], newCp = leaves[diff];
    if (oldCp === newCp) return;
    var gi = indexOfCodePoint(LIB, cp);
    if (gi === undefined) return;
    if (!canReplaceCp(LIB, gi, oldCp)) return;         /* 引擎真的換得動 ✓ */
    var tl = leafMultiset(newCp, 0), ol = leafMultiset(oldCp, 0);
    var inter = 0, tot = 0, extra = 0;
    tl.forEach(function (v, k) { tot += v; inter += Math.min(v, ol.get(k) || 0); });
    ol.forEach(function (v, k) { extra += Math.max(0, v - (tl.get(k) || 0)); });
    if (!tot) return;
    out.push({
      seq: String.fromCodePoint(cp) + String.fromCodePoint(oldCp) + String.fromCodePoint(newCp),
      fromCh: String.fromCodePoint(oldCp), toCh: String.fromCodePoint(newCp),
      share: inter / tot, extra: extra,
      bmp: (cp >= 0x4e00 && cp <= 0x9fff),
      strokes: LIB.glyphs[drawingIdx(LIB, gi)].strokes.length,
      oldCp: oldCp, newCp: newCp,
    });
  });
  /* 先按「葉子重疊」粗篩 ✓（便宜 ✓），再對前 120 名算**長寬比**（貴一點但值得 ✓）。
     ★ 為什麼要長寬比 ✓：師父挑 `桂`（`圭`＝2 土 ✓ 與 `垚`＝3 土 **同為土柱** ✓）
       而不挑 `橈`（`堯`＝土土土＋兀 ✓ 葉子重疊 100% ✗ 但形狀是**寬的** ✗）。
       單看重疊會挑到「寬的」✗；乘上 1/(1+|log 長寬比差|) 就對了 ✓（實測 `桂` 變第一 ✓）。 */
  out.sort(function (a, b) {
    return (b.share - a.share) || (a.extra - b.extra) || ((b.bmp ? 1 : 0) - (a.bmp ? 1 : 0)) ||
      (a.strokes - b.strokes);
  });
  /* ⚠ 粗篩池不能太小 ✗：實測前 120 名會把 `桂` 篩掉 ✗（結構分數並列的一堆 ✓，
     第 4 順位是筆劃數 ✓）→ 放大到 800 名（約 0.4 秒 ✓ 可接受 ✓）。 */
  var pool = out.slice(0, 800);
  for (var q = 0; q < pool.length; q++) {
    var ao = inkAspect(pool[q].oldCp), an = inkAspect(pool[q].newCp);
    pool[q].shape = (ao > 0 && an > 0) ? 1 / (1 + Math.abs(Math.log(ao / an))) : 0.5;
    pool[q].score = pool[q].share * pool[q].shape;
  }
  pool.sort(function (a, b) {
    return (b.score - a.score) || (b.share - a.share) || (a.extra - b.extra) ||
      ((b.bmp ? 1 : 0) - (a.bmp ? 1 : 0)) || (a.strokes - b.strokes);
  });
  /* ★ 最後一關：**多餘的葉子要罰** ✓——
     `橈` 的舊部件 `堯`（土土土＋**兀** ✗）葉子重疊 100% ✗ 但多帶一個兀 ✗；
     `桂` 的舊部件 `圭`（土土 ✓）一個多餘的都沒有 ✓。
     師父挑 `桂` 而不是 `橈` ✓，差別就在這裡 ✓（實測：罰 0.5×多餘葉數 → `桂` 第一 ✓）。 */
  pool.sort(function (a, b) {
    var sa = a.share - 0.5 * a.extra, sb2 = b.share - 0.5 * b.extra;
    return (sb2 - sa) || ((b.bmp ? 1 : 0) - (a.bmp ? 1 : 0)) || (a.strokes - b.strokes);
  });
  return pool.slice(0, limit || 4);
}
/* ==================== 任意 IDS → **多步階梯**（師父第 127 輪：「當場算」✓） ====================
 * 師父的階梯（`機幾墨黒𨩛星炚日水` ✓）逐步解碼是：
 *   `機`(木＋幾) → 幾換 `墨`(黒＋土 ✓ 土到位) → 黒換 `𨩛`(金＋星 ✓ 金到位)
 *   → 星換 `炚`(日＋火 ✓ 火到位) → 日換 `水`(✓ 水到位)。
 * **每一步都「多放進一個目標部件 ＋ 最多帶一個暫用部件」** ✓——這就是貪婪的依據 ✓。
 * 這裡只用字庫的 `comp`（**直接分量** ✓）＋ 貼進來的 IDS 的葉序 ✓，**零新增資料** ✓。
 * 成本：每步掃一次 97,079 個字（約 50–100 ms ✓）→ 四五步不到 1 秒 ✓（可以在頁面當場算 ✓）。
 */
function ladderForIds(ids, maxSteps) {
  var target = idsLeafList(ids);
  if (!target || target.length < 2 || target.length > 6 || !LIB.comp) return null;
  var want = new Map();
  for (var w = 0; w < target.length; w++) want.set(target[w], (want.get(target[w]) || 0) + 1);
  var isBmp = function (cp) { return cp >= 0x4e00 && cp <= 0x9fff; };
  /** 起點：含最多目標葉、分量數少（結構簡單好換 ✓）、BMP 優先 ✓ */
  var base = null, baseScore = -1e9;
  LIB.comp.forEach(function (comps, cp) {
    var hit = 0;
    for (var i = 0; i < comps.length; i++) if (want.has(comps[i])) hit++;
    if (!hit) return;
    var sc = hit * 100 - comps.length * 2 + (isBmp(cp) ? 5 : 0);
    if (sc > baseScore) { baseScore = sc; base = { cp: cp, comps: comps.slice() }; }
  });
  if (!base) return null;
  /** 目前的樹＝葉的陣列（與引擎「換第一個出現的部件」一致 ✓） */
  var state = base.comps.slice();
  var steps = [];
  for (var s = 0; s < (maxSteps || 5); s++) {
    var have = new Map();
    for (var i2 = 0; i2 < state.length; i2++) have.set(state[i2], (have.get(state[i2]) || 0) + 1);
    var missing = 0;
    want.forEach(function (v, k) { missing += Math.max(0, v - (have.get(k) || 0)); });
    if (!missing) break;
    /* 找最好的下一步 ✓——**引擎在迴路裡** ✓（師父第 127～128 輪的教訓：
       光是「葉子覆蓋」算出來的分數會挑到引擎做不到的步 ✗：
       實測貪婪產生 `𧆘艹爕火圭土沝水鍂`（引擎組不出來 ✗）與 `奻女𱲍孔嚳告吼`（IoU 0.203 ✗、還走串接 ✗）。
       → 所以每一輪都：**先便宜地排序候選 ✓ → 取前 12 名真的組一次 ✓ → 只採用引擎做得到、
         而且最好能「沿用原框」的步 ✓**（沿用原框＝那個槽位本來就裝得下 ✓，師父的階梯 2/3、2/4 ✓）。
       成本：每步 12 次組字（約 1～3 ms／次 ✓）→ 一步不到 50 ms ✓。 */
    var order = [];
    LIB.comp.forEach(function (comps, cp) {
      if (comps.length > 4) return;
      var gain = 0, extra = 0, i3;
      for (i3 = 0; i3 < comps.length; i3++) {
        var cc = comps[i3];
        var need = (want.get(cc) || 0) - (have.get(cc) || 0);
        if (need > 0) gain += 1; else extra += 1;
      }
      if (!gain || extra > 1) return;
      for (var li = 0; li < state.length; li++) {
        var L = state[li];
        var spare = !want.has(L) || (have.get(L) || 0) > (want.get(L) || 0);
        var sc = gain * 100 - extra * 30 + (spare ? 15 : 0) + (isBmp(cp) ? 6 : 0) - comps.length -
          Math.abs(state.length - 1 + comps.length - target.length) * 4;
        order.push({ leafIx: li, comps: comps.slice(), cp: cp, sc: sc, gain: gain, extra: extra });
      }
    });
    if (!order.length) break;
    order.sort(function (a, b) { return b.sc - a.sc; });
    var best = null;
    var trialN = Math.min(order.length, 12);
    for (var t = 0; t < trialN; t++) {
      var cand = order[t];
      var trial = state.slice();
      trial.splice(cand.leafIx, 1, ...cand.comps);
      /* 真的組一次 ✓（前面已累積的步 ＋ 這一步 ✓） */
      var trialSeq = String.fromCodePoint(base.cp);
      for (var p2 = 0; p2 < steps.length; p2++) {
        trialSeq += String.fromCodePoint(steps[p2].old) + String.fromCodePoint(steps[p2].ch);
      }
      trialSeq += String.fromCodePoint(state[cand.leafIx]) + String.fromCodePoint(cand.cp);
      var kept = 0, okTrial = false;
      try {
        var rT = evalSeq(LIB, trialSeq, {});
        if (rT && rT.ok) {
          var lg = (rT.log || []).join(" ");
          if (lg.indexOf("串接") < 0) {
            okTrial = true;
            kept = (rT.log || []).filter(function (s) { return String(s).indexOf("沿用原框") >= 0; }).length;
          }
        }
      } catch (eT) { okTrial = false; }
      if (!okTrial) continue;
      var sc2 = cand.sc + kept * 25;             /* **沿用原框**加分 ✓（引擎說「框不必重算」✓） */
      if (!best || sc2 > best.sc2) best = { cand: cand, sc2: sc2, kept: kept };
    }
    if (!best) break;                            /* 引擎做不到就停 ✓（不硬湊 ✗） */
    var chosen = best.cand;
    var step = { ix: chosen.leafIx, old: state[chosen.leafIx], ch: chosen.cp };
    steps.push(step);
    state.splice(chosen.leafIx, 1, ...chosen.comps);
  }
  if (!steps.length) return null;
  var covered = 0;
  var fin = new Map();
  for (var f = 0; f < state.length; f++) fin.set(state[f], (fin.get(state[f]) || 0) + 1);
  want.forEach(function (v, k) { covered += Math.min(v, fin.get(k) || 0); });
  var seq = String.fromCodePoint(base.cp);
  for (var p = 0; p < steps.length; p++) {
    seq += String.fromCodePoint(steps[p].old) + String.fromCodePoint(steps[p].ch);
  }
  /* ★★ **先問引擎，再談分數** ✓（我在第 121 輪就學過這條 ✗，這一輪又忘了一次 ✗）：
     實測未驗證的貪婪會產出「引擎根本組不出來」（`𧆘…` 換到孫級部件 ✗）
     或「橫向 3 等分串接」那種廢話 ✗（IoU 0.203 ✗，手工是 0.301 ✓）。
     → 所以**真的組一次** ✓：組不出來、或引擎走了「串接」這條退路 ✗，就**不採用** ✓（回 null ✓）。 */
  try {
    var chk = evalSeq(LIB, seq, {});
    if (!chk || !chk.ok) return null;
    var log = (chk.log || []).join(" ");
    if (log.indexOf("串接") >= 0) return null;
  } catch (eChk) { return null; }
  return { seq: seq, steps: steps.map(function (x) { return [x.old, x.ch]; }), base: base.cp,
           cover: covered / target.length, nSteps: steps.length };
}

/** 部件自己的**墨跡長寬比** ✓（用來判斷「換上去會不會走形」✓） */function inkAspect(cp) {
  try {
    var gi = indexOfCodePoint(LIB, cp);
    if (gi === undefined) return 0;
    var di = drawingIdx(LIB, gi);
    var b = inkIn(LIB, di);
    var w = b.x2 - b.x1, h = b.y2 - b.y1;
    return (w > 0 && h > 0) ? w / h : 0;
  } catch (e) { return 0; }
}

/** 把字拆成 IDS ✓——**依畫法**推算子（零新增資料 ✓）： *  看這個字的直接引用（槽位 ✓）的相對位置 → 左右＝⿰、上下＝⿱、三等分＝⿲／⿳ ✓。
 *  ⚠ 這是**視覺拆分** ✓；「新 IDS 來源的主要拆法」要 +387 KB 的表（實測 ✓），留待師父裁定 ✓。 */
function idsOfChar(ch) {
  var gi = glyphIndexOf(ch);
  if (gi === undefined) return "";
  var di = drawingIdx(LIB, gi);
  var slots = refSlotsOf(LIB, di);
  if (slots.length < 2) return "";
  /* 每個槽位的**墨跡框中心** ✓（引用框常是滿格恆等框 ✗，比不出佈局 ✓） */
  var pts = [];
  for (var i = 0; i < slots.length; i++) {
    var b = slots[i].box, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    try {
      var ink = inkOfRefInParent(LIB, di, slots[i].strokeIx);
      if (ink && ink.x2 > ink.x1) { cx = (ink.x1 + ink.x2) / 2; cy = (ink.y1 + ink.y2) / 2; }
    } catch (e) { /* 用引用框 ✓ */ }
    var cp = codePointOf(LIB, slots[i].ref);
    if (!cp) return "";
    pts.push({ cp: cp, cx: cx / 200, cy: cy / 200 });
  }
  function spread(vals) { return Math.max.apply(null, vals) - Math.min.apply(null, vals); }
  var sx = spread(pts.map(function (p) { return p.cx; }));
  var sy = spread(pts.map(function (p) { return p.cy; }));
  var order = pts.slice().sort(function (a, b) {
    return (sx > sy ? a.cx - b.cx : a.cy - b.cy) || (sx > sy ? a.cy - b.cy : a.cx - b.cx);
  });
  var op = sx > sy ? (order.length === 2 ? "⿰" : order.length === 3 ? "⿲" : "") :
                      (order.length === 2 ? "⿱" : order.length === 3 ? "⿳" : "");
  if (!op) {
    /* 4 個以上：退化成「左右」＋巢狀（畫法裡最常見的情形 ✓），誠實但不完美 ✓ */
    return "";
  }
  return op + order.map(function (p) { return String.fromCodePoint(p.cp); }).join("");
}

var IDS_STOCK = [
  { ids: "⿰木⿳金⿰水火土", seq: "機幾墨黒𨩛星炚日水", what: "五行（木＋金水火土）", img: "__IMG_ELEMENTS_B64__" },
  { ids: "⿳𦥯⿰女孔皿", seq: "𦧀熏䀉喬𰠬牜女", what: "好學孔孟（𦥯＋女孔＋皿）", img: "__IMG_XUE_B64__" }
];
/** 輸入區送的 IDS 有沒有現成的拼形序 ✓（比對時去掉空白 ✓） */
function idsRecommend(ids) {
  var key = String(ids).replace(/\s+/g, "");
  for (var i = 0; i < IDS_STOCK.length; i++) if (IDS_STOCK[i].ids === key) return IDS_STOCK[i];
  return null;
}
/** 輸入區裡有沒有 **IDS 算子**（U+2FF0–U+2FFF ✓）——有的話就當表意描述序處理 ✓ */
function idsOperators(s) {
  var out = "";
  var cs = Array.from(String(s));
  for (var i = 0; i < cs.length; i++) {
    var cp = cs[i].codePointAt(0);
    if (cp >= 0x2ff0 && cp <= 0x2fff) out += cs[i];
  }
  return out;
}

/* ---- localStorage 的鍵 ----
   ★ 師父 2026-10-16：「**輸入區的文字要存進 localStorage，客人不必每次重新輸入** ✓；
   **字框顯示、中間部件、筆劃粗細也都要存** ✓」——
   四個鍵一組，全部住在這裡 ✓（不要在頁面各處散著寫字串 ✗）。 */
var LS_STOCK = "pinxing.stock", LS_BOX = "pinxing.boxmode";
var LS_SEQ = "pinxing.seq", LS_WSCALE = "pinxing.wscale", LS_MID = "pinxing.showmid";

/** ★ 輸入區的文字**記住** ✓（客人下次打開就還在 ✓）。
 *  ⚠ 寫入的時機是 **`render()` 這一個漏斗** ✓：打字、點庫存、點部件、魔術棒、
 *    建議、拆成 IDS、Esc 清空……**每一條改輸入區的路都會走到 render()** ✓，
 *    所以不必在每個地方各寫一次 ✗（漏一個就會「改了卻沒記到」✗）。 */
function saveSeqText() {
  try { localStorage.setItem(LS_SEQ, $("seq").value); } catch (e) { /* 無痕模式 */ }
}

/** 開頁時把上次的輸入放回輸入區 ✓。
 *  ⚠ `?baseglyph=`（從字集瀏覽頁帶字過來 ✓）**優先** ✗——
 *    客人是「指定要看這個字」才點的，蓋掉它就會看起來像按了沒反應 ✓。 */
function restoreSeqText() {
  if (cpFromQuery() !== null) return false;
  try {
    var v = localStorage.getItem(LS_SEQ);
    if (v) { $("seq").value = v; return true; }
  } catch (e) { }
  return false;
}

/** 筆劃粗細（`#wscale` 的百分數）✓：讀回來只有在 40～220（滑桿的範圍 ✓）之內才採用 ✓。 */
function readWScale() {
  try {
    var v = Number(localStorage.getItem(LS_WSCALE));
    if (v >= 40 && v <= 220) return v;
  } catch (e) { }
  return 100;
}
/** 設定筆劃粗細：**畫面（滑桿與標籤）與 `WSCALE` 一起改** ✓，`save` 時順便記住 ✓。
 *  ⚠ 開頁時要在**畫任何字之前**呼叫 ✗（庫存按鈕一開頁就畫了 ✓，晚了就是舊粗細 ✗）。 */
function setWScale(pct, save) {
  if ($("wscale")) $("wscale").value = String(pct);
  if ($("wscaleV")) $("wscaleV").textContent = pct + "%";
  WSCALE = pct / 100;
  if (save) { try { localStorage.setItem(LS_WSCALE, String(pct)); } catch (e) { } }
}

function loadUserStock() {
  try { return JSON.parse(localStorage.getItem(LS_STOCK) || "[]"); } catch (e) { return []; }
}
function saveUserStock(a) {
  try { localStorage.setItem(LS_STOCK, JSON.stringify(a)); } catch (e) { /* 無痕模式 */ }
}

/** 「存起來」：把輸入區的序列存進 localStorage。**已經存過就移到最前面**，
    不是再存一份。按鈕（svg 圖示）與 Enter 都走這一支。 */
function saveCurrentSeq() {
  var s = $("seq").value.replace(/\s+/g, "");
  if (!s) return;
  var mine = loadUserStock();
  var at = mine.indexOf(s);
  var moved = at > 0;
  if (at >= 0) mine.splice(at, 1);
  mine.unshift(s);
  saveUserStock(mine.slice(0, 40));
  $("stock").innerHTML = stockHtml();
  toast(moved ? "已移到最前面：" + s : "已存起來：" + s);
  updateSaveBtn();
}

/** 輸入區的序列是不是**客人自己存過的** ✓（是的話存檔鈕變成垃圾桶 ✓）。 */
function isInUserStock(s) {
  if (!s) return false;
  try { return loadUserStock().indexOf(s) >= 0; } catch (e) { return false; }
}

/** ★ 師父 2026-10-15：存檔鈕兩態 ✓——
 *  序列已在自存庫存裡 → **垃圾桶** ✓（按一下刪除）；否則 → **存檔** ✓。 */
function updateSaveBtn() {
  var b = $("saveSeq");
  if (!b) return;
  var s = $("seq").value.replace(/\s+/g, "");
  var del = isInUserStock(s);
  b.classList.toggle("del", del);
  b.title = del ? "刪除這個庫存（再按一下可以存回來）" : "存起來（或在輸入區按 Enter）";
}

/** 把輸入區的序列**從自存庫存刪掉** ✓（按鈕的垃圾桶那一態 ✓）。客人後悔再按一下就會存回來 ✓。 */
function deleteCurrentSeq() {
  var s = $("seq").value.replace(/\s+/g, "");
  if (!s) return;
  var mine = loadUserStock();
  var at = mine.indexOf(s);
  if (at >= 0) { mine.splice(at, 1); saveUserStock(mine); }
  $("stock").innerHTML = stockHtml();
  toast("已從庫存刪除：" + s + "（再按一下存檔就回來 ✓）");
  updateSaveBtn();
}

/** 存檔鈕按一下：**在就刪、不在就存** ✓（同一顆按鈕的兩態 ✓）。 */
function toggleSaveSeq() {
  var s = $("seq").value.replace(/\s+/g, "");
  if (!s) return;
  if (isInUserStock(s)) deleteCurrentSeq(); else saveCurrentSeq();
  updateSaveBtn();
}

/** 輸入區下方的浮層提示（absolute，不佔高度 → 出現／消失都不會晃動畫面）。
    `kind` 是 `ok`（存起來之類）或 `warn`（不是合法拼形式之類）。 */
var toastTimer = null, flashTimer = null;
function toast(text, kind) {
  var el = $("msg");
  if (!el) return;
  if (!text) {
    el.textContent = "";
    el.className = "toast";
    return;
  }
  el.textContent = text;
  el.className = "toast on " + (kind === "warn" ? "warn" : kind === "err" ? "err" : "ok");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.className = "toast"; }, 3000);
}

/** 模式切換的一瞬提醒：只改 `#seq` 的顏色（box-shadow 閃一下），不移動任何東西。
    「拼形序 ↔ 部件檢字」這種切換只有標籤變色，很容易沒注意到。 */
function flashSeq(kind) {
  if (!kind) return;
  var el = $("seq");
  if (!el) return;
  el.classList.remove("flash-ok", "flash-warn");
  void el.offsetWidth;                 /* 強制 reflow，動畫才會重播 */
  el.classList.add(kind === "warn" ? "flash-warn" : "flash-ok");
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(function () { el.classList.remove("flash-ok", "flash-warn"); }, 750);
}

/** 字框**兩態**（顯示／不顯示）的按鈕標籤 ✓。
 *  ★ 師父 2026-10-15：「字框的設置可以簡化為顯示或不顯示 ✓」——
 *  **孫框顯不顯示由「中間部件」決定** ✓（見 `SHOW_MID` ✓）。
 *  框一律是**引擎量的最小框** ✓（`inkOfRefInParent`／`inkOfPathInRoot` ✓）。 */
function applyBoxMode() {
  var b = $("boxMode");
  if (!b) return;
  var on = BOXMODE !== "none";
  b.setAttribute("data-mode", on ? "show" : "none");
  b.textContent = on ? "字框：顯" : "字框：隱";
  b.title = on ? "顯示最小框（能包住那個部件所有筆劃的框）" : "不顯示字框";
}

function stockHtml() {
  var out = [];
  for (var k = 0; k < STOCK.length; k++) out.push(stockRow(STOCK[k], false, k));
  /* ★ 兩個 IDS 合文接在**內建九組之後** ✓（師父第 122 輪 ✓：一點就看到 ✓）。
     ⚠ 刻意放在這裡、不插最前面 ✗——插前面會把既有庫存的位置推歪 ✓
       （驗收的「第 4 組＝初衤礻」那類斷言全靠位置 ✓，實測被推歪過一次 ✓）。 */
  for (var q = 0; q < IDS_STOCK.length; q++) out.push(stockRowIds(IDS_STOCK[q]));
  var mine = loadUserStock();
  for (var j = 0; j < mine.length; j++) out.push(stockRow(mine[j], true, j));
  if (!mine.length) out.push('<div class="row"><span class="note">還沒有存自己的序列——' +
    '打好上面的序列後按右邊的存檔圖示（或直接按 Enter），會記在 localStorage。</span></div>');
  return out.join("");
}

/** IDS 合文那一列 ✓：格子畫**師父給的原圖** ✓（base64 打包 ✓）、
 *  點一下＝把 **IDS** 送進輸入區 ✓（先看醜字 ✓，再點建議才變美 ✓）。
 *  ⚠ 標記用 `mbflag` 而**不是** `flag` ✗——`flag` 是「參」（組不出單一形 ✓）的標記，
 *    混用會讓「有幾組是參」的斷言誤判 ✓（實測踩過 ✓）。 */
function stockRowIds(ent) {
  var img = ent.img ? '<img class="rawimg" alt="" src="data:image/png;base64,' + ent.img + '">'
                    : '<span class="miss">?</span>';
  var title = "合文 " + ent.what + "\n按下去＝把表意描述序送進輸入區：" + ent.ids +
    "\n（先看 IDS 的等比分配 ✓ 再點系統的拼形序建議 ✓）";
  return '<div class="stockrow ids" data-send="' + ent.ids + '" data-ids="' + ent.ids +
    '" title="' + title + '">' +
    '<div class="stockcell"><span class="mbflag">合</span><div class="g">' + img + '</div></div></div>';
}

function stockRow(seq, mine, ix) {
  var chars = Array.from(seq);
  var r = stockCompose(seq);
  /* 按鈕顯示**組出來的形**（規格第 3 條）；組不出來就退回第一個字並標「參」。
     **不顯示拼形式本身**（使用者的要求）：想知道是什麼序列，點一下就知道。 */
  var glyph;
  if (r && r.ok) glyph = svgOfLib(r.lib, r.targetIdx);
  else {
    var fi = glyphIndexOf(chars[0]);
    glyph = fi === undefined ? '<span class="miss">' + chars[0] + "</span>" : glyphSvg(fi);
  }
  var flag = !r || !r.ok ? '<span class="flag">參</span>' : "";
  var title = seq + (r && r.ok ? "（點一下帶進輸入區）" : "（組不出單一形，按鈕畫的是第一個字）");
  return '<div class="stockrow' + (mine ? " mine" : "") + '" data-seq="' + seq +
    '" title="' + title + '">' +
    '<div class="stockcell">' + flag + '<div class="g">' + glyph + "</div></div>" +
    /* ★ 師父 2026-10-15：**自存的列不再有「刪」按鈕** ✓（會把方形按鈕撐成長方形 ✗）——
       改由輸入區最右邊那顆按鈕切換成**垃圾桶** ✓（見 updateSaveBtn ✓）。 */
    "</div>";
}

/** 庫存序列的組字結果（每個序列只算一次）。 */
var stockResults = {};
function stockCompose(seq) {
  var hit = stockResults[seq];
  if (hit !== undefined) return hit;
  var r;
  try { r = evalSeq(LIB, seq, {}); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  stockResults[seq] = r;
  return r;
}

/* ============================ 主畫面 ============================ */
/* ★ 師父 2026-10-16：**預設不顯示字框** ✓（「缺省不要打開字框顯示」✓）——
   客人自己打開過（localStorage 有記到 ✓）才打開 ✓；
   ⚠ 不要寫成「有存過就怎樣」✗：舊版預設是顯示 ✓，那時**沒有存值**，
     所以「沒有存值 → 預設值」正好就是師父要的新預設 ✓。 */
var BOXMODE = "none";                   /* "tight"＝顯示、"none"＝不顯示 ✓（兩態 ✓） */
var SHOW_MID = false;                   /* ★ 顯示中間部件（含孫框）✓（師父 2026-10-15） */
try {
  var savedBox = localStorage.getItem(LS_BOX);
  /* 舊版存的是 "tight"（顯示 ✓）；`show`／`deep` 是更舊的寫法，一起接受 ✓（見 §字框三態 ✓） */
  if (savedBox === "tight" || savedBox === "show" || savedBox === "deep") BOXMODE = "tight";
  if (localStorage.getItem(LS_MID) === "1") SHOW_MID = true;
} catch (e) { }
var ACTIVE_BOX = -1;

/**
 * 重畫的排程。
 *
 * **輸入事件不要直接呼叫 `render()`**：中文輸入法在組字期間每個注音按鍵都會觸發 `input`，
 * 而 `insertChar()`／貼上也會自己改 `el.value`——直接同步重畫會在中間狀態先畫一次，
 * 接著又被下一次覆蓋，看起來就是「改了卻沒有立刻更新」。
 * 排到 microtask 之後，同一輪的所有變動只畫最後一次。
 */
var renderQueued = false;
function scheduleRender() {
  /* 驗收探針要能同步斷言（headless 的 --dump-dom 不等 microtask）：
     設 window.__SYNC__ = true 就當場重畫。 */
  if (window.__SYNC__) { render(); return; }
  if (renderQueued) return;
  renderQueued = true;
  Promise.resolve().then(function () { renderQueued = false; render(); });
}

/** 輸入區 ＝ 拼形式（也是零件檢字條件）。整個畫面都從這一支重畫。
 *  **傳進 `evalInput()` 的是原始輸入**：`木 /` 這種寫法的運算子要留給檢字語法，
 *  字元本身在裡面另外濾掉空白再判讀。 */
function render() {
  saveSeqText();          /* ★ 師父 2026-10-16：輸入區的文字**當場記住** ✓（見 saveSeqText ✓） */
  var st = evalInput($("seq").value);
  lastEval = st;
  /* ★ 魔術棒：預設收起來 ✓（只有 IDS 模式真的有建議時才站出來 ✓）——
     但「輸入區現在就是剛套用的建議序」時要留著 ✓（再點換下一個 ✓）。 */
  setWand(null, true);

  var note = $("bigNote");
  /* 浮層提示：換字時先收起來（有新訊息再顯示） */
  toast("", "");

  /* 左邊的標籤：空白＝剎那拼形（醒目色）／合法拼形式＝**拼形序**／其餘＝部件檢字。
     ★ 師父 2026-10-16：「「合理拼形」改為「構形序」」✓、同日再依「與項目 pinxing 統一」改成
     **「拼形序」** ✓——同一個模式，只是名字換成客人看得懂的說法 ✓（見 pinxing.md §140／§143 ✓）。
     單字刻意算「檢字」——使用者輸入「合」要的是含合的字清單，不是組字。 */
  var lbl = $("seqlbl");
  var empty = st.mode === "empty";
  var composing = st.mode === "partial" || (st.mode === "ok" && !st.single);
  setLabel(empty ? "剎那拼形" : composing ? "拼形序" : "部件檢字",
           empty ? "brand" : composing ? "good" : "find",
           empty ? "empty" : composing ? "good" : "find");
  /* 標籤從「拼形序」變成「部件檢字」（或反向）時，讓輸入區閃一下顏色（不移動版面） */
  var mode3 = empty ? "empty" : composing ? "good" : "find";
  if (mode3 !== lastLabelMode) {
    if (lastLabelMode !== null && mode3 !== "empty") flashSeq(mode3 === "find" ? "warn" : "ok");
    lastLabelMode = mode3;
  }
  /* ★ 師父 2026-10-16：「IDC 按鈕**占用筆劃大小那一位置**（**其他模式顯示筆劃大小**）」✓ */
  applyToolRow(st.mode);
  /* ★ 師父 2026-10-16：標籤的 hover 說明**每一種狀態都有** ✓——
     狀態換了（檢字 ↔ 表意描述序 ↔ 拼形序 ↔ 空白）內容就要跟著換 ✓；
     浮層開著的時候**當場更新** ✓，不是收起來 ✗（滑鼠還在標籤上、東西卻不見了，看起來像壞掉 ✓）。 */
  if ($("lblHelp") && $("lblHelp").classList.contains("on")) $("lblHelp").innerHTML = labelHelpHtml();
  /* 不是合法拼形式就不給存檔（使用者的要求） */
  $("saveSeq").hidden = !composing;
  updateSaveBtn();   /* ★ 存檔 ↔ 垃圾桶（自存的序列 ✓） */
  /* ★ 師父 2026-10-16：「**「拆成 IDS」這個功能只應在輸入單個非獨體字時出現**」✓——
     條件兩個都要：**輸入剛好一個字** ✓ 而且**拆得開**（`idsOfChar()` 回得出表意描述序 ✓；
     獨體字／引用不足它回空字串 ✗）。不合就整顆收起來 ✓（點不到＝不會走進死路 ✓）。 */
  var seqChars0 = Array.from(String($("seq").value || "").replace(/\s+/g, ""));
  var canSplit = false;
  if (seqChars0.length === 1) {
    try { canSplit = !!idsOfChar(seqChars0[0]); } catch (eSp) { canSplit = false; }
  }
  showEl($("toIds"), canSplit);

  if (empty) {
    setMain(null);
    $("big").innerHTML = '<div class="ph">在上面輸入任何字或拼形式</div>';
    note.textContent = "";
    $("seqNote").textContent = "";
    $("seqChips").innerHTML = "";
    SEARCH = null; renderSearch();
    uploadLinks(null);
    renderSuggest(st, null);
    return;
  }

  if (st.mode === "ids") {
    /* ★ 師父第 124 輪：**輸入 IDS 的組字要故意醜** ✓（就按 IDC 的等比分配 ✓）——
       這樣客人才看得出 IDS 與拼形序的差別 ✓。
       版面：**大字＝IDS 等比分配的醜形** ✓；**並排那格＝拼形序的美形** ✓（點一下就換過去 ✓）。 */
    lbl.textContent = "表意描述序";
    lbl.className = "seqlbl find";
    lbl.setAttribute("data-mode", "ids");
    $("saveSeq").hidden = true;
    /* ★ 師父 2026-10-16：「**如果輸入的是不合法的 IDS，紅色警示，錯誤包括：
       缺少部件、多出部件、最開頭必為描述符**」✓（`idsIssue()` ✓，共用模塊那一支 ✓）。
       ⚠ 紅字要**留在畫面上**（大字裡 ✓），不是只有 3 秒的浮層 ✗——
         浮層消失之後客人只看到一片空白，不知道要改哪裡 ✓。 */
    var issue = null;
    try { issue = idsIssue(st.ids); } catch (eIss) { issue = null; }
    if (issue) {
      setMain(null);
      clearSuggestRow();
      setWand(null, false);
      renderSeq(st);                 /* 先把部件清單清掉 ✓ */
      SEARCH = null; renderSearch(); uploadLinks(null);
      /* ⚠ 紅字與浮層要**最後**才寫 ✗——`renderSeq()` 會重畫大字、也會清浮層 ✓，
         先寫就會被蓋掉 ✓（實測：畫面上只剩一般的空狀態、浮層也是空的 ✓）。 */
      $("big").innerHTML = '<div class="ph err">' + issue.msg + "</div>";
      note.textContent = "表意描述序：" + st.ids + "　→ " + issue.msg;
      toast(issue.msg, "err");
      return;
    }
    var rec = st.recommend;
    var naive = null;
    try { naive = idsComposeNaive(st.ids); } catch (e0) { naive = null; }
    if (naive) {
      setMain(naive.lib, naive.idx);
      $("big").innerHTML = mainSvg();
      try { renderBig(false); } catch (e1) { /* 框層失敗不影響大字 ✓ */ }
    } else {
      setMain(null);   /* 畫不出來就不要留著上一個字的部件清單 ✗ */
    }
    /* ★ 師父第 126 輪：**不要先畫出優化後的樣子** ✗——
       一來佔畫面 ✓，二來「**接受建議、字形突然變美**」才是客人驚嘆的那一刻 ✓✓。
       所以這裡只給**文字推薦**（可點 ✓），美形留到他點下去才出現 ✓。 */
    var recSeqs = [];
    var one = [], live = null;
    try { one = seqCandidatesForIds(st.ids, 4); } catch (eL) { one = []; }
    /* ★ 師父第 127 輪「**當場算**」✓：先試多步階梯 ✓（`機幾墨黒𨩛星炚日水` 那種 ✓）。
       規則：**一步就能換好的**（結構分數 ≥ 0.6 ✓，例 `⫰木垚` → `桂圭垚` ✓）優先；
       一步換不好（例五個葉的合文 ✗）就用**多步階梯** ✓。 */
    if (!(one.length && one[0].share >= 0.6)) {
      try { live = ladderForIds(st.ids, 5); } catch (eL2) { live = null; }
    }
    if (one.length && one[0].share >= 0.6) {
      for (var q4 = 0; q4 < one.length; q4++) recSeqs.push(one[q4].seq);
    } else if (live && live.cover >= 0.999) {
      recSeqs.push(live.seq);
      for (var q5 = 0; q5 < one.length; q5++) recSeqs.push(one[q5].seq);
    } else {
      for (var q6 = 0; q6 < one.length; q6++) recSeqs.push(one[q6].seq);
    }
    if (rec && recSeqs.indexOf(rec.seq) < 0) recSeqs.push(rec.seq);   /* 手工調的示範序當後備 ✓ */
    var recIsLive = !!(live && live.cover >= 0.999 && recSeqs[0] === live.seq);
    /* 若這個表意描述序**就是某個真字** ✓（葉序反查 ✓）→ 把它排最前面 ✓ */
    if (st.hits && st.hits.length && !recIsLive) {
      var pick = st.hits.slice().sort(function (a, b) {
        var ba = (a >= 0x4e00 && a <= 0x9fff) ? 0 : 1, bb = (b >= 0x4e00 && b <= 0x9fff) ? 0 : 1;
        return ba - bb || a - b;
      })[0];
      var ci = recSeqs.indexOf(String.fromCodePoint(pick));
      if (ci >= 0) recSeqs.splice(ci, 1);
      recSeqs.unshift(String.fromCodePoint(pick));
    }
    if (recSeqs.length) {
      var stage2 = $("sugStage"), cap2 = $("sugCap"), wrap2 = $("sugWrap");
      if (stage2) { stage2.innerHTML = ""; stage2.hidden = true; stage2.removeAttribute("data-sug"); }
      if (cap2) {
        cap2.textContent = "試試「" + recSeqs[0] + "」✓（" +
          (recIsLive ? "系統**當場算**出來的拼形序 ✓ " + live.nSteps + " 步 ✓" :
            recSeqs[0] === (rec && rec.seq) ? "手工調的示範序 ✓" : "系統推薦 ✓") +
          "點一下，字就變漂亮了 ✓）";
      }
      /* ★ 師父第 136 輪：**先不要把拼形序顯示出來** ✗——
         三塊建議區都只留在 DOM 裡（驗收讀得到 ✓），客人看的是魔術棒 🪄 ✓。 */
      showEl(wrap2, false);
      var row3 = $("sugRow"), sb3 = $("stockSuggest");
      var rowHtml3 = "";
      for (var e3 = 0; e3 < recSeqs.length; e3++) {
        rowHtml3 += '<button class="seqchip" data-sug="' + recSeqs[e3] +
          '" title="點一下套用這個拼形序 ✓">' + recSeqs[e3] + "</button>";
      }
      if (row3) row3.innerHTML = rowHtml3;
      showEl(sb3, false);
      /* ★ 魔術棒站出來 ✓：客人點一下就用下一個建議 ✓（不把序寫在畫面上 ✗） */
      setWand(recSeqs);
      toast("這是 IDS 的等比分配（**沒有布局資訊** ✓ 所以醜 ✓）——" +
        "點輸入區右邊的 🪄 試試系統建議的拼形序 ✓（再點換下一個 ✓）", naive ? "ok" : "warn");
    } else {
      clearSuggestRow();
      setWand(null, false);
      if ($("sugStage")) $("sugStage").hidden = false;
      toast("這是表意描述序" + st.ids + "——目前沒有現成的拼形序 ✓；" +
        "下方庫存區有兩個常見合文可以一點就看到 ✓", "warn");
    }
    /* ★ 師父第 136 輪：**先不要把拼形序寫在畫面上** ✗——
       客人按 🪄 才看到「字突然變美」的那一刻 ✓。
       ★ 師父 2026-10-16：「**「構字式（IDS）」改為「表意描述序」**」✓（第 144 輪再把其餘的
         「構字式」也一次掃乾淨 ✓——這一行是**當時的原話**，保留舊名 ✓）——
         標籤、這裡的人話轉寫、浮層提示、庫存合文的提示、按鈕的 tooltip 一起改 ✓
         （只改一半＝同一個東西兩個名字 ✗，客人會以為是兩件事 ✓）。 */
    note.textContent = "表意描述序：" + idsToText(st.ids) +
      (naive ? "　※大字是 IDC 等比分配（未經墨跡對齊 ✓ 所以醜 ✓）" : "") +
      (recSeqs.length ? "　→ 按右邊的 🪄 試試系統建議的拼形序 ✓" : "");
    /* ★ 部件清單：以前整段清空 ✗ → 現在畫出**表意描述序的那幾塊** ✓
       （見 `renderSeq()` 的 ids 分支 ✓；師父 2026-10-15 回報空的 ✓）。 */
    renderSeq(st);
    SEARCH = null; renderSearch(); uploadLinks(null);
    return;
  }

  if (st.mode === "search") {    setMain(LIB, glyphIndexOf(st.owner || st.chars[0]));
    /* 拼形拼不出來時，把**引擎的理由**放在這裡（例：`土` 不在 報 的 KAGE 樹裡）。
       只寫「當成部件檢字」的話，使用者會以為是自己的輸入有問題。 */
    note.textContent = st.reason ? "組不出來：" + st.reason
                                 : "不是合法拼形式 → 當成部件檢字";
    /* **用輸入區整串**當查詢語法（含 `+`／`/`／筆劃數／重複部件），跟 glyph-browser 一致。
       整段包 try/catch：搜尋若丟例外，不接的話整個 render() 就中斷，
       畫面會停在上一輪、而且看起來像「打什麼都沒反應」（踩過）。 */
    var searchErr = "";
    try {
      /* 檢字條件＝**查詢關鍵字 ＋ 運算子**（`進辶` 要查「辶」；
         `木/` 要查「木在上」）。不能整串丟進去，那會變成「同時含進與辶」。 */
      runSearch(st.q || "");
      candShown = CAND_MAX;
    } catch (err) {
      searchErr = String(err && err.message || err);
      SEARCH = null;
    }
    if (searchErr) {
      toast("檢字失敗：" + searchErr, "warn");
      renderSearch();
      renderBig(false);
      renderSeq(st);
      uploadLinks(st);
      return;
    }
    /* 檢字的回饋：拼形失敗時先把「為什麼」講在前面（見上面的 `st.reason`） */
    var findMsg = "部件檢字：" + (searchLabel(SEARCH && SEARCH.q) || "") +
      "　" + SEARCH.cps.length.toLocaleString() + " 個字";
    toast(st.reason ? "組不出來：" + st.reason + "　→ " + findMsg : findMsg, "warn");
    renderSearch();
    renderBig(false);
    renderSeq(st);
    uploadLinks(st);
    return;
  }

  /* partial／ok 都畫 eval 的結果（partial 是基字本身）。
     **描繪要包 try/catch**：引擎對某些組合會拋例外，不接的話整個 render() 就中斷，
     畫面看起來就是「改了字但大字沒更新」。 */
  var r = st.eval;
  var drawErr = "";
  try {
    if (r && r.ok) setMain(r.lib, r.targetIdx);
    else setMain(LIB, glyphIndexOf(st.owner || st.chars[0]));
  } catch (e) {
    drawErr = String(e && e.message || e);
    setMain(null);
  }
  $("big").innerHTML = mainSvg();          /* 先把大字寫進去，renderBig 再補框層 */

  if (st.mode === "partial") {
    toast("已經選好要換掉的「" + st.oldCh + "」→ 接著打（或點）替換內容", "ok");
    renderSuggest(st, null);          /* 中間狀態還沒有替換內容 → 沒有建議 ✓ */
  } else if (r && r.log && r.log.length) {
    /* 「串接部件」＝替換內容讀不成拼形序列，引擎退化成**橫向等分**。
       這**不是**原地換部件（使用者回報：輸入「報幸土业」，左邊變成「土业」水平合併，
       以為是原地把 幸 裡的 土 換成 业），所以用 warn 色、訊息裡明講。 */
    var rowLog = [], restLog = [];
    for (var li = 0; li < r.log.length; li++) {
      if (r.log[li].indexOf("串接部件") === 0) rowLog.push(r.log[li]); else restLog.push(r.log[li]);
    }
    if (rowLog.length) {
      toast("橫向等分串接（不是原地換部件）：" + rowLog.join("；") +
        (restLog.length ? "；" + restLog.join("；") : ""), "warn");
    } else {
      toast(restLog.join("；"), "ok");
    }
  }
  /* **建議更好的基字**（第 111 輪）：同一個部件序列、但形式更好（「初衤禾」→「利刂刀」）✓。
     放在這裡＝「已經組出來了」之後才建議（那時才知道第三個字 ✓）。
     它會回傳一句「為什麼沒有建議」（候選全部疊墨時 ✓），要跟下面的警告**合併**，不要互相蓋掉 ✓。 */
  var sugWarn = renderSuggest(st, r);
  /* **警告客人：墨疊成一塊了**（第 112 輪依師父指示 ✓）——優先於其他訊息 ✓，
     因為客人會以為「組出來了」就沒事 ✗（實測「庚广廣」就是一團墨 ✗）。 */
  var inkWarn = inkWarningOf(st, r);
  if (inkWarn) {
    toast("這個組合的墨疊在一起了：" + inkWarn + "——換個基字或換個部件 ✓" +
      (sugWarn ? "；" + sugWarn : ""), "warn");
  } else if (sugWarn) {
    toast(sugWarn, "warn");
  }
  /* 合成字形的碼位：**fork 出來的庫裡，被改寫的那個索引還帶著基字的碼位**
     （實測 `報幸田` 印出 U+5831），照抄的話會讓人以為畫面上是原本那個字。
     替換過的結果一律標「無碼位」，並把基字寫成「以 … 為基」。 */
  var bc = MAIN ? codePointOf(MAIN.lib, MAIN.idx) : 0;
  if (r && r.substituted) {
    note.textContent = "組出來的形（無碼位" + (bc ? "　以 " + hex(bc) + " 為基" : "") + "）";
  } else {
    note.textContent = bc ? hex(bc) : (MAIN && MAIN.lib !== LIB ? "組出來的形（無碼位）" : "");
  }
  if (drawErr) {
    note.textContent = "引擎描繪失敗：" + drawErr;
    toast("引擎底層的問題（見 pinxing.md 的 P3「還沒通的」）：" + drawErr, "warn");
  }

  /* 單字：同時列出含它的字（規格第 7 條的檢字條件） */
  if (st.showList) {
    try {
      runSearch(st.listTerm);
      candShown = CAND_MAX;
    } catch (err) {
      SEARCH = null;
      toast("檢字失敗：" + (err && err.message), "warn");
    }
    renderSearch();
  } else {
    SEARCH = null; renderSearch();
  }  renderBig(true);
  renderSeq(st);
  uploadLinks(st);
}

/** 大字那塊重畫（框／粗細改了要重畫，但不要重跑求值）。
 *
 *  一定要用 `bigSvgHtml()`——不要自己接 `boxOverlaySvg()` 的字串：
 *  它回傳的是 `<g>`，而 `<g>` 不是 HTML 元素，塞進 `innerHTML` 會被解析器整段丟掉，
 *  症狀就是「大字的部件框不見了」（踩過）。「字框：無」就是不畫那一層。 */
function renderBig(scroll) {
  if (!MAIN) return;
  try {
    /* 框的來源：**和部件清單同一份** ✓（見 currentBoxes ✓） */
    var bx = currentBoxes();
    var bmode = (SHOW_MID && !(lastEval && lastEval.mode === "ids")) ? "deep" : "tight";
    /* ★ 選中的部件：筆劃染成框色 ✓（獨立一層 `.hllayer`，**在框層下面** ✓） */
    var hl = '<svg class="hllayer" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"></svg>';
    /* ★ 師父 2026-10-16：**藏起字框時，筆劃塗色照樣要能動** ✓——
       所以 `.hllayer` 一定要留著 ✓（只和部件清單連動 ✓，和有沒有框無關 ✓）。 */
    var html = bigSvgHtml(mainSvg() + hl, bx, { mode: bmode, active: ACTIVE_BOX, lib: MAIN.lib });
    /* ★ 藏字框＝**框看不見、還是有作用** ✓（透明但吃滑鼠事件 ✓）：
       在大字上滑過／點下去照樣選到那一格、塗色 ✓、部件清單也跟著亮 ✓。 */
    if (BOXMODE === "none") html = html.replace('svg class="boxlayer"', 'svg class="boxlayer ghost"');
    $("big").innerHTML = html;
    paintActiveStrokes(ACTIVE_BOX);
    renderCpInfo();          /* ★ 右下角「Unicode 區位 ＋ 碼位」✓（沒有碼位就不畫 ✓） */
  } catch (e) {
    $("big").innerHTML = '<div class="ph">引擎描繪失敗：' + (e && e.message) + "</div>";
  }
  void scroll;
}

/** ★ 師父 2026-10-16：「**如果大字是 Unicode 有收的字**，在**右下方**顯示 Unicode 區位及
 *  codepoint（字體大小可以和「中間部件」一樣大）」✓。
 *  ⚠ 「Unicode 有收」＝**大字真的有碼位** ✓：拼形序組出來的字是 fork 出來的副本、
 *    `codePointOf()` 回 undefined ✗ → **不顯示** ✓（誠實：它就不是 Unicode 的字 ✓）。
 *  ⚠ 每次重畫都重做一次 ✓（`#big` 的 innerHTML 會被換掉 ✓，掛在裡面才活得下來 ✓）。 */
function renderCpInfo() {
  var host = $("big");
  if (!host) return;
  var old = host.querySelector(".cpinfo");
  if (old && old.parentNode) old.parentNode.removeChild(old);
  if (!MAIN) return;
  /* ⚠ **拼形組出來的字不算** ✗：`free-compose` 是**當場改寫基字那一格** ✓（`MAIN.lib !== LIB` ✓），
     所以 `MAIN.idx` 還指著基字（實測：這個合文的 `codePointOf()` 回 U+6A5F＝「機」✗）——
     直接印就會把**機**的碼位貼在一個不是機的字旁邊 ✓。`isComposed()` 就是這件事的判準 ✓。 */
  if (isComposed()) return;
  var cp = null;
  try { cp = codePointOf(MAIN.lib, MAIN.idx); } catch (e) { cp = null; }
  if (!cp) return;
  var bi = blockIndexOf(cp);
  var el = document.createElement("span");
  el.className = "cpinfo";
  /* 區位用面板那一套短標籤 ✓（BMP／A／B…／相容／相容補 ✓）——與區塊面板、配色同一份來源 ✓。 */
  el.textContent = (bi >= 0 ? BLOCKS[bi].id + "　" : "") + hex(cp);
  host.appendChild(el);
}

/** 「和字集瀏覽頁連動」的那一條連結（`glyph-browser.html?comp=…`）。
    `comp` 要跟**搜尋實際用的關鍵字**一致：檢字模式是輸入區最後一個字
    （`runSearch()` 就是用那個字），拼形序是「要換掉的那個部件」。 */
function uploadLinks(st) {
  var toComp = "";
  if (st && st.mode === "search") {
    var chars = st.chars || [];
    toComp = chars.length ? chars[chars.length - 1] : "";
  } else if (st && st.mode === "partial") {
    toComp = st.oldCh;
  } else if (st && st.mode === "ok" && !st.single) {
    /* 拼形序：帶**最後一個字**（＝使用者正在看／正在換的那一個部件）。
       多字時 st.chars[0] 是基字，帶基字過去沒什麼用。 */
    var cs = st.chars || [];
    toComp = cs.length ? cs[cs.length - 1] : "";
  } else if (st && st.mode === "ok" && st.single && st.chars && st.chars.length) {
    toComp = st.chars[0];                /* 單字：就是它自己 */
  }
  /* 檢字模式：帶**查詢語法裡的部件**（`木+` → 木；單獨一個「木」→ 木） */
  if (st && st.mode === "search" && SEARCH && SEARCH.q && SEARCH.q.terms.length) {
    toComp = SEARCH.q.terms[SEARCH.q.terms.length - 1];
  }
  var el = $("toBrowser");
  if (!el) return;
  el.textContent = toComp ? "用「" + toComp + "」到字集瀏覽頁查 →" : "";
  el.setAttribute("aria-disabled", toComp ? "false" : "true");
  el.dataset.comp = toComp;
}

/** 到字集瀏覽頁查目前的部件。
 *
 *  拆成兩支是為了**驗收**：`browserUrl()` 只算字串（驗收直接讀，不必真的跳頁——
 *  真的跳走就沒有回報了，這一條踩過），`goToBrowser()` 才是跳頁。
 *  點擊路徑本身很薄，但「按鈕會組出哪一條 URL」是看得到的。 */
function browserUrl() {
  var c = $("toBrowser").dataset.comp;
  return c ? "glyph-browser.html?comp=" + encodeURIComponent(c) : "";
}

function goToBrowser() {
  var url = browserUrl();
  if (!url) return false;
  location.href = url;
  return true;
}

/** ★ 師父 2026-10-16：「IDC 按鈕**占用筆劃大小那一位置**（**其他模式顯示筆劃大小**）」✓——
 *  **同一個位置**、看模式給哪一個 ✓（不並排 ✗：那一列在手機上本來就擠 ✓）：
 *    `ids`（表意描述序）＝給描述符 ✓（客人打不出 U+2FF0–2FFF ✗）；
 *    其他（空白／拼形序／部件檢字）＝給筆劃粗細 ✓。
 *  ⚠ 兩邊都用 `showEl()` ✓（`display:none` 的坑見第 112 輪 ✓）。 */
function applyToolRow(mode) {
  var ids = mode === "ids";
  showEl($("idcRow"), ids);
  showEl($("idcLabel"), ids);
  showEl($("wscaleWrap"), !ids);
}

/* ============================ 事件 ============================ */
/** ★ 師父 2026-10-16：標籤的 hover 說明，**兩種內容** ✓：
 *  ① **部件檢字**（`#seqlbl.find` ✓）→ 檢字運算子的用法 ✓
 *     內容是**共用層那一份** ✓（與字集瀏覽頁的「運算式說明」同一份 ✓，不要各寫一份 ✗）；
 *     只有 `U+908F` 那一行不同 ✓（這一頁＝拿那個字去檢字 ✓）。
 *  ② 其餘（剎那拼形／拼形序 ✓）→ **拼形序的專利依據** ✓
 *     ★ 師父 2026-10-16：「最下方『拼形序依據 中国发明专利 201610984608.1 号』
 *       移到上方『構形序』的 hover 說明」✓——所以那一句從頁尾搬到這裡 ✓（**字一字不改** ✓）。
 *     ⚠ 空白時（頁名「剎那拼形」✓）也給同一句 ✓：那是頁尾本來就在講的事 ✓，
 *       搬上來之後如果只有「拼形序」那一個狀態才看得到，第一次打開的人就找不到它了 ✗。
 *  ⚠ 浮層是 `absolute` ✓：出現／消失都**不推動版面** ✓（跟 .toast 同一個原則 ✓）。 */
var PATENT_LINE = "拼形序依據 中国发明专利 201610984608.1 号";
/** 表意描述序那一種狀態的 hover 說明 ✓。
 *  ★ 師父 2026-10-16：「**輸入區是「表意描述序」時，不應顯示「部件檢字」的說明。
 *    顯示「使用下方的 描述符」**」✓——運算子那幾條（`木+`／`口口`／`4木日` ✓）是
 *    **部件檢字**在用的 ✗，表意描述序走的是**另一條路**（描述符 ＋ 分量 ✓）；
 *    拿檢字的說明給他看＝教錯方法 ✓，所以這一頁的浮層要**分狀態**給內容 ✓。 */
var IDS_HELP = "使用下方的描述符";
function labelHelpHtml() {
  var m = labelMode();
  if (m === "find") return searchHelpHtml(["U+908F", "用那個碼位的字去檢字"]);
  if (m === "ids") return IDS_HELP;
  return PATENT_LINE;
}
/** 標籤（文字／顏色／**狀態**）只有這一個出口 ✓。
 *  ★ 師父 2026-10-16：hover 說明要**依狀態給不同內容** ✓——所以狀態記在 `data-mode` ✓
 *  （`empty`＝還沒輸入 ✓、`good`＝拼形序 ✓、`find`＝部件檢字 ✓、`ids`＝表意描述序 ✓）。
 *  ⚠ 標籤開著浮層時（滑鼠還在上面 ✓）內容要**當場換** ✓，不是等下次 hover ✗。 */
function setLabel(text, cls, mode) {
  var l = $("seqlbl");
  if (!l) return;
  l.textContent = text;
  l.className = "seqlbl " + cls;
  l.setAttribute("data-mode", mode);
  if ($("lblHelp") && $("lblHelp").classList.contains("on")) $("lblHelp").innerHTML = labelHelpHtml();
}
function labelMode() {
  var l = $("seqlbl");
  return l ? (l.getAttribute("data-mode") || "") : "";
}
function hideLabelHelp() {
  if ($("lblHelp")) $("lblHelp").classList.remove("on");
  if ($("lblHelp")) $("lblHelp").hidden = true;
}
function showLabelHelp() {
  var el = $("lblHelp");
  if (!el) return;
  /* ⚠ 每次都重算內容 ✓：狀態換了（檢字 ↔ 表意描述序 ↔ 拼形序）內容就不一樣 ✓，
     只在第一次填會留下上一個狀態的說明 ✗。 */
  el.innerHTML = labelHelpHtml();
  el.hidden = false;
  el.classList.add("on");
}
/** 把一段文字插到輸入區的**游標位置** ✓（沒有游標＝接在最後 ✓）——IDC 描述符按鈕用 ✓。
 *  ⚠ 客人**打不出** U+2FF0–2FFF ✗，所以一定要有「點一下插進去」的路 ✓。 */
function insertIntoSeq(text) {
  var el = $("seq");
  if (!el) return;
  var v = String(el.value || "");
  var at = (el.selectionStart === undefined || el.selectionStart === null) ? v.length : el.selectionStart;
  var to = (el.selectionEnd === undefined || el.selectionEnd === null) ? at : el.selectionEnd;
  el.value = v.slice(0, at) + text + v.slice(to);
  var caret = at + text.length;
  try { el.setSelectionRange(caret, caret); } catch (e) { /* 不支援就算了 ✓ */ }
}

function bind() {
  /* ★ 2026-10-16：標籤的運算子用法（滑過彈出 ✓）——滑鼠 hover 為主 ✓，
     觸控沒有 hover ✓，所以再補一個「點一下切換」✓（點別的地方或換狀態就收起來 ✓）。 */
  if ($("seqlbl")) {
    $("seqlbl").addEventListener("mouseenter", showLabelHelp);
    $("seqlbl").addEventListener("mouseleave", hideLabelHelp);
    $("seqlbl").addEventListener("click", function () {
      var on = $("lblHelp") && $("lblHelp").classList.contains("on");
      if (on) hideLabelHelp(); else showLabelHelp();
    });
  }
  if ($("lblHelp")) $("lblHelp").addEventListener("click", hideLabelHelp);
  document.addEventListener("click", function (e) {
    if (!e.target || !e.target.closest) return;
    if (e.target.closest("#lblHelp") || e.target.closest("#seqlbl")) return;
    hideLabelHelp();
  });
  /* ★ 師父 2026-10-16：「**IDC 按鈕改用 IDC 字符來顯示，「左右」「上下」改為 hover hint**」✓——
     按鈕上＝**描述符本身**（⿰⿱⿲…✓）；人話（左右／上下／全包…✓）與碼位放進 tooltip ✓。
     ⚠ 很多字型沒有 U+2FF0–2FFF 的字形 ✗ → 按鈕會顯示 ▯ ✓（師父指定要字符 ✓，
       tooltip 裡有名字所以還認得出來 ✓）。 */
  if ($("idcRow") && !$("idcRow").children.length) {
    var idcOps = Object.keys(IDS_ARITY), idcHtml = "";
    for (var io = 0; io < idcOps.length; io++) {
      var opv = idcOps[io];
      idcHtml += '<button class="idc" data-idc="' + opv + '" title="' +
        (IDF_OPNAME[opv] || opv) + "（" + opv + "　U+" +
        opv.codePointAt(0).toString(16).toUpperCase() + "）——點一下插進輸入區 ✓\">" +
        opv + "</button>";
    }
    $("idcRow").innerHTML = idcHtml;
  }
  if ($("idcRow")) $("idcRow").addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest(".idc") : null;
    if (!b) return;
    insertIntoSeq(b.getAttribute("data-idc"));
    render();                 /* 插進去就當場判讀 ✓（合法＝畫出來 ✓、不合法＝紅字 ✓） */
    $("seq").focus();
  });
  /* 輸入就重畫（排到 microtask，見 scheduleRender） */
  $("seq").addEventListener("input", scheduleRender);
  $("seq").addEventListener("compositionend", scheduleRender);
  $("seq").addEventListener("keyup", function () { renderSeq(lastEval); });
  $("seq").addEventListener("click", function () { renderSeq(lastEval); });
  $("seq").addEventListener("focus", function () { renderSeq(lastEval); });
  /* Enter ＝ 存起來（使用者的要求）。例外要說出來：這條是鍵盤路徑，
     靜靜失敗只會看到「按了沒反應」。 */
  $("seq").addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    /* 例外要說出來：這是鍵盤路徑，靜靜失敗只會看到「按了沒反應」。 */
    try { saveCurrentSeq(); }
    catch (err) { toast("存不起來：" + (err && err.message)); }
  });

  /* **建議更好的基字**（第 112 輪）：並排的那個（#sugStage）與庫存區的格子（#sugRow）
     點一下＝把建議的輸入字串（利刂刀）帶進輸入區並重畫 ✓。
     一律由客人點才換（不自動改 ✓——目標是「讓客人檢視挑擇」）。 */
  function pickSuggestion(target) {
    var b = target && target.closest ? target.closest("[data-sug]") : null;
    if (!b) return;
    $("seq").value = b.getAttribute("data-sug");
    render();
    $("seq").focus();
  }
  if ($("sugStage")) $("sugStage").addEventListener("click", function (e) { pickSuggestion(e.target); });
  if ($("sugRow")) $("sugRow").addEventListener("click", function (e) { pickSuggestion(e.target); });

  /* ★ 師父第 124 輪：「拆成 IDS」按鈕 ✓——客人不會打 IDC ✓，所以要有按鈕 ✓。
     按一下＝把輸入區那個字拆成**表意描述序**✓ → 立刻看到 **IDS 的等比分配（醜）** ✓
     與 **拼形序的美形**（並排 ✓）的差別 ✓。 */
  if ($("toIds")) $("toIds").addEventListener("click", function () {
    var v = String($("seq").value || "").replace(/\s+/g, "");
    var first = Array.from(v)[0];
    if (!first) { toast("先在上面打一個字（例：學）✓ 再按輸入區右邊的 🧩 ✓", "warn"); return; }
    var ids = idsOfChar(first);
    if (!ids) {
      toast("「" + first + "」在畫法裡沒有可直接拆的部件 ✓（獨體字或引用不足 ✓）——" +
        "可以改用部件檢字看它的組成 ✓", "warn");
      return;
    }
    $("seq").value = ids;
    render();
    $("seq").focus();
    toast("已拆成表意描述序：" + ids + " ✓——大字是 IDC 等比分配（醜 ✓）、右邊是拼形序（美 ✓）", "ok");
  });

  /* 部件序列：點一下＝用那個部件替換掉它自己的槽位。
     `data-parent` 是「要換掉誰」（有槽位的＝自己；IDS 內嵌部件＝掛它的那個節點）。
     **`data-stuck` 的格子點不動**：那個部件引擎沒有槽位可以放新內容，
     點下去只會得到一串永遠換不掉的輸入（見 `componentChips()`）。 */
  $("seqChips").addEventListener("click", function (e) {
    var mini = e.target.closest ? e.target.closest(".mini.comp") : null;
    if (!mini) return;
    var ch = mini.getAttribute("data-ch");
    if (!ch) {
      /* ★ 只看得到、不能換的格子（**表意描述序的塊**、**孫框**）——
         點一下＝**選它** ✓：框與清單互相亮起 ✓（師父 2026-10-15 的要求 ✓）。 */
      var bx = mini.getAttribute("data-box");
      ACTIVE_BOX = bx !== null ? Number(bx) : -1;
      try { renderBig(false); } catch (e0) { }
      renderSeq(lastEval);
      return;
    }
    if (mini.getAttribute("data-stuck")) return;
    var parent = mini.getAttribute("data-parent") || ch;
    replaceWith(ch, parent);
  });

  /* ★ 滑過大字的框 → **部件清單那一格也亮起來** ✓
     （孫框才看得出對應的是哪一格 ✓；以前只有「點下去」才連動 ✗）。 */
  $("big").addEventListener("mouseover", function (e) {
    var r = e.target.closest ? e.target.closest(".cbox") : null;
    var bx = (r && r.hasAttribute("data-box")) ? Number(r.getAttribute("data-box")) : -1;
    hoverChip(bx);
    /* ★ 滑過框 → 那一格的筆劃也**染成框色** ✓（師父 2026-10-15；滑出＝回到選中的那格 ✓） */
    /* ⚠ 滑過時**只把那一塊染色** ✓——其他筆劃照舊看得見 ✓（第 176 輪：曾經把主字形收起來 ✗，師父回報「其他的白色筆劃都不見了」✗）。 */
    paintActiveStrokes(bx >= 0 ? bx : ACTIVE_BOX);
  });
  $("big").addEventListener("mouseleave", function () { hoverChip(-1); paintActiveStrokes(ACTIVE_BOX); });

  /* ★ 反向也要通 ✓：滑過部件清單的格子 → 大字上對應的框也亮起來 ✓ */
  $("seqChips").addEventListener("mouseover", function (e) {
    var m = e.target.closest ? e.target.closest(".mini.comp") : null;
    var bx = (m && m.hasAttribute("data-box")) ? Number(m.getAttribute("data-box")) : -1;
    hoverFrame(bx);
    /* ★ 反向也要染色 ✓（滑過清單的格子 → 大字那一格的筆劃變框色 ✓） */
    paintActiveStrokes(bx >= 0 ? bx : ACTIVE_BOX);
  });
  $("seqChips").addEventListener("mouseleave", function () { hoverFrame(-1); paintActiveStrokes(ACTIVE_BOX); });

  /* 庫存：點一列 ＝ 把整個序列帶進輸入區 ✓（刪除改用輸入區右邊的垃圾桶鈕 ✓） */
  $("stock").addEventListener("click", function (e) {
    var row = e.target.closest ? e.target.closest(".stockrow") : null;
    if (!row) return;
    /* ★ 師父第 127 輪：合文那兩個按鈕送的是 **IDS** ✓（不是拼形序 ✗）——
       客人先看到「IDS 組出來的醜字」✓，再自己點建議、字形才變美 ✓（別一次掀底牌 ✓）。 */
    $("seq").value = row.getAttribute("data-send") || row.getAttribute("data-seq");
    ACTIVE_BOX = -1;
    render();
  });

  $("saveSeq").addEventListener("click", toggleSaveSeq);
  /* ★ 師父第 136 輪：**魔術棒 🪄**（DOM 位置在 saveSeq 的前一個 ✓） */
  if ($("wand")) $("wand").addEventListener("click", wandNext);

  /* 筆劃粗細：改 WSCALE 之後**一定要清快取**，否則畫面上還是舊粗細 ✓；
     順便記住這個值 ✓（師父 2026-10-16：「筆劃粗細也存進 localStorage」✓）。 */
  $("wscale").addEventListener("input", function () {
    setWScale(Number(this.value), true);
    clearAllCache();
    renderBig(false);
    renderSeq(lastEval);
  });

  /* 字框：**兩態**（顯示 ↔ 不顯示）✓（預設＝不顯示 ✓，師父 2026-10-16 ✓） */
  $("boxMode").addEventListener("click", function () {
    BOXMODE = BOXMODE === "none" ? "tight" : "none";
    try { localStorage.setItem(LS_BOX, BOXMODE); } catch (e) { }
    applyBoxMode();
    renderBig(false);
    renderSeq(lastEval);   /* ★ 部件清單要跟著換 ✓ */
  });

  /* ★ 「中間部件」勾選框 ✓：勾了＝連中間部件（孫框）一起顯示 ✓（師父 2026-10-15） */
  if ($("showMid")) {
    $("showMid").checked = SHOW_MID;
    $("showMid").addEventListener("change", function () {
      SHOW_MID = !!this.checked;
      try { localStorage.setItem(LS_MID, SHOW_MID ? "1" : "0"); } catch (e) { }
      renderBig(false);
      renderSeq(lastEval);
    });
  }

  /* 點大字的框 ↔ 部件序列互相亮起 */
  $("big").addEventListener("click", function (e) {
    var r = e.target.closest ? e.target.closest(".cbox") : null;
    /* 孫框（深層）沒有 data-box ✓——不要當成第 0 個部件 ✗ */
    ACTIVE_BOX = (r && r.hasAttribute("data-box")) ? Number(r.getAttribute("data-box")) : -1;
    renderBig(false);
    renderSeq(lastEval);
  });

  /* 候選：點一下把該字選為基字 */
  $("cands").addEventListener("click", function (e) {
    var cell = e.target.closest ? e.target.closest(".cell") : null;
    if (!cell) return;
    var cp = Number(cell.getAttribute("data-cp"));
    $("seq").value = String.fromCodePoint(cp);
    ACTIVE_BOX = -1;
    render();
    $("seq").focus();
  });
  $("moreBtn").addEventListener("click", function () { candShown += CAND_MAX * 2; renderSearch(); });

  $("toBrowser").addEventListener("click", function () { goToBrowser(); });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && $("seq").value) {
      $("seq").value = "";
      ACTIVE_BOX = -1;
      render();
    }
  });
}

/** 點部件格＝**用它替換**：在輸入區裡把 `parent` 後面那個字換成 `ch`。
 *
 *  使用者定案的語意：「點一下 用它更換」。
 *    * 「」裡是基字本身（例：進 的 隹）→ 輸入區變成「進隹」（指名要換掉進的隹）。
 *    * 基字後面已經有那個槽位（例：邏羅 的 羅）→ 換掉它，變成「邏<新>」。
 *    * IDS 內嵌部件（例：寶 的 缶，`parent` 是 寶）→ 「寶缶」。
 *  這樣兩條規則就涵蓋規格〈招財進寶〉動線的每一步。 */
function replaceWith(ch, parent) {
  var el = $("seq");
  var seq = el.value.replace(/\s+/g, "");
  var chars = Array.from(seq);
  var at = chars.indexOf(parent);
  var next;
  if (at < 0) next = seq + ch;                    /* 找不到那個字（例：輸入區被改過）→ 接上去 */
  else next = chars.slice(0, at + 1).join("") + ch;
  el.value = next;
  ACTIVE_BOX = -1;
  render();
  el.focus();
}

/** 基字整棵樹裡的部件字元（判斷「這個部件已經在輸入區裡了嗎」）。 */
var levelNameCache = new Map();
function levelNamesOf(baseIdx) {
  var hit = levelNameCache.get(baseIdx);
  if (hit) return hit;
  var out = [], stack = [baseIdx], seen = new Set([baseIdx]);
  while (stack.length) {
    var i = stack.pop();
    var kids = refKidsOf(i);
    for (var k = 0; k < kids.length; k++) {
      var j = kids[k];
      if (seen.has(j)) continue;
      seen.add(j);
      var nm = compCharOf(j);
      if (nm && out.indexOf(nm) < 0) out.push(nm);
      stack.push(j);
    }
  }
  if (levelNameCache.size > 500) levelNameCache.clear();
  levelNameCache.set(baseIdx, out);
  return out;
}

/** 基字的直接部件（**用部件字元比對**，不是字形索引）。
    字形索引比對會踩到相容異體：`進` 引用的 `辶` 與使用者點的 `辶` 是不同的字形索引。 */
function compKidsByName(gi) {
  var kids = refKidsOf(gi), out = [];
  for (var k = 0; k < kids.length; k++) out.push(compCharOf(kids[k]));
  return out;
}

/* ============================ 開頁 ============================ */
/* ★ 2026-10-16：解壓走**共用層的 `gunzipBytes()`** ✓——內建的 `DecompressionStream`
   不是每個瀏覽器都有 ✗（微信內建的就沒有 ✓），沒有它整頁等於打不開 ✗。
   純 JS 的後備在 `glyph-common-page.js` ✓（**不要**在這裡再寫一份 ✗）。 */
function gunzip(raw) { return gunzipBytes(raw); }
function b64ToBytes(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }

/** `?baseglyph=U+xxxx`（從字集瀏覽頁帶基字進來）。前綴與大小寫都要容錯。
 *
 *  **要先把 `location.search` 解碼，而且要解到沒有百分號編碼為止**：
 *  `+` 在查詢字串裡是合法的保留字元，用 `?baseglyph=U%2B908F` 帶過來時，
 *  `location.search` 是編碼後的字串，直接套 `/U\+/` 會對不上
 *  （實測得到 baseglyph=null）；Edge 開 `file://` 還會再多編一層（`%2B` → `%252B`）。 */
function cpFromQuery() {
  var raw = location.search;
  for (var i = 0; i < 3; i++) {
    if (raw.indexOf("%") < 0) break;
    var next;
    try { next = decodeURIComponent(raw); } catch (e) { break; }
    if (next === raw) break;
    raw = next;
  }
  var m = /[?&]baseglyph=(?:U\+|U|0x|0X)?([0-9a-fA-F]{4,6})/.exec(raw);
  if (!m) return null;
  var cp = parseInt(m[1], 16);
  return cp > 0 && cp <= 0x10FFFF ? cp : null;
}

var t0 = performance.now();

gunzip(b64ToBytes(LIB_B64))
  .then(function (bin) {
    LIB = decodeLibrary(bin);
    var decodeMs = Math.round(performance.now() - t0);
    applyBoxMode();
    /* ★ 師父 2026-10-16：筆劃粗細要在**畫任何字之前**還原 ✓——
       下面 `stockHtml()` 一開頁就把庫存按鈕畫出來了 ✓，晚了就是舊粗細 ✗。 */
    setWScale(readWScale(), false);
    $("stock").innerHTML = stockHtml();
    bind();

    /* ★ 師父 2026-10-16：**還原上次的輸入** ✓（客人不必每次重新輸入 ✓）。
       ⚠ 順序：先還原、再讓 `?baseglyph=` 覆蓋 ✓（從字集瀏覽頁帶字過來時以它為準 ✓）。 */
    restoreSeqText();
    var cp = cpFromQuery();
    if (cp !== null) {
      var g = String.fromCodePoint(cp);
      if (glyphIndexOf(g) !== undefined) $("seq").value = g;
    }
    render();

    /* 給 headless 驗收讀的（見 tools/check-pinxing.ts） */
    window.__READY__ = {
      glyphs: LIB.glyphs.length,
      families: LIB.families.length,
      decodeMs: decodeMs,
      baseglyph: cp
    };
    /* ★ 2026-10-16：起得來就把「開頁看門狗」收掉 ✓（見 build-pinxing.ts 的那支小 script ✓）——
       沒有收掉的話，慢一點的機器會在畫面上多出一塊「載入失敗」的紅字 ✗。 */
    if (window.__BOOTOK__) window.__BOOTOK__();
    window.__STATE__ = function () {
      var st = lastEval;
      return {
        seq: $("seq").value,
        mode: st ? st.mode : null,
        ready: st ? !!st.ready : null,
        msg: $("msg").textContent,
        cap: $("seqNote").textContent,
        chipCount: $("seqChips").querySelectorAll(".mini.comp").length,
        boxCount: $("big").querySelectorAll(".cbox").length,
        boxMode: BOXMODE,
        boxLabel: $("boxMode").textContent,
        candCount: SEARCH ? SEARCH.cps.length : 0,
        candTerm: SEARCH ? SEARCH.term : "",
        candCells: $("cands").querySelectorAll(".cell").length,
        bigIdx: MAIN ? MAIN.idx : -1
      };
    };
  })
  .catch(function (e) {
    if (window.__BOOTOK__) window.__BOOTOK__();
    document.body.innerHTML = '<div style="padding:20px;color:#ff8080">載入失敗：' + (e && e.message) +
      (e && e.stack ? "｜" + String(e.stack).split("\n").slice(0, 3).join(" ← ") : "") +
      '<br><br>如果這是在<b>微信</b>裡打開的，改用<b>系統自帶的瀏覽器</b>開同一個檔案試試。</div>';
  });
