/* tools/tour/player.js — 操作導覽的**頁面端播放器**（手寫 ES5；由 build-pinxing.ts 內嵌）
 *
 * 來源：`D:\2026\agent-norms\self-explaining-tour\player.ts`（上游模組，2026-10-25 搬入）。
 * 為什麼是「**照著上游改寫成 ES5**」而不是把那份 TS 內嵌進來？
 *   ① **手寫的那一層一律是 ES5** ✓（`pinxing-page.js` 與 `glyph-common-page.js` 沒有一個
 *      箭頭函式、沒有一個 let／const ✓）。這一頁的客人包含微信內建瀏覽器，
 *      多一種語法就是多一個「舊引擎整支 script 掛掉、畫面全白」的機會 ✗
 *      （見 build-pinxing.ts 最後那支「開頁看門狗」的註解 ✓）。
 *      ⚠ 誠實記一筆：內嵌的 `tools/*.ts`（經 Bun transpile）**已經**帶了箭頭函式與 async，
 *        所以整頁並不是嚴格的 ES5 ✓——這一條守的是**手寫層**的一致性，
 *        不是「整頁只吃 ES5」的保證 ✓。要真的回到 ES5，得先處理那一批 TS 模組。
 *   ② 上游的 `format.ts`／`compiler.ts` 是 TS ＋ node 模組，只有**建置期**能用 ✓；
 *      頁面端只需要「解巨集 ＋ 演每一步」這一小塊 ✓（4 KB 的資料 ＋ 這支播放器）。
 *   ③ 產出頁是**單一檔案、零相依** ✓：播放器必須看得懂、改得動（客人會拿到這一份檔案 ✓）。
 * 行為照上游（暫停／重播／上一個場景、`停`、`等頁面`、`你來`、進度存 localStorage、
 * 有彈窗時不搶 Esc、`state()` 給驗收讀）✓，只把語言降級、把介面縮到這一頁用得到的。
 *
 * 介面（掛在 window.SelfTour，頁面端只用到這幾個）：
 *   init(app, data, options)   掛 DOM、綁按鈕——**只呼叫一次**，而且要在外殼進了 DOM 之後
 *   start()                    入口：一份劇本直接播、多份開選單
 *   play(id, from)             從第 from 個場景播（省略＝接上次看到的地方）
 *   stop()／openMenu()／closeMenu()
 *   state()                    驗收用的診斷（欄位同上游的 tourState()）
 *   evalCond(cond)             條件語法（測試用）
 *
 * `app` 是頁面注入的轉接層，五個方法都可有可無：tab／side／set／call／state。
 * 這一頁只實作 set（box／wscale／mid）、call（mark／restore）與 state ✓。
 * ⚠ `set` **一定要**在認不得的鍵回傳 false ✓——否則客人只會看到「按了沒反應」✗。
 */
(function (global) {
  "use strict";

  /* ============================ 巨集格式 ============================
   * 與 tools/tour/format.ts **同一份位元組格式**（魔數、版號、CRC、字串長度）。
   * 兩邊各寫一份是無奈（建置期是 TS、頁面端是 ES5），所以兩邊都要有：
   *   魔數不符／版號不符／CRC 不符 → 丟出看得懂的中文錯誤 ✓（不是安靜地播一半 ✗）。
   */
  var OP = {
    text: 1, point: 2, unpoint: 3, click: 4, type: 5, key: 6, wait: 7, waitFor: 8,
    tab: 9, side: 10, set: 11, call: 12, user: 13, require: 14, skipIf: 15, tap: 16
  };
  var OP_NAME = {};
  for (var opk in OP) if (OP.hasOwnProperty(opk)) OP_NAME[OP[opk]] = opk;

  var MAGIC = "TOUR1";
  var FMT = 1;
  var LEGACY = { AC26T: 1 };            /* 舊版 App 可能還帶著它；解碼時一起認 ✓ */

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(b) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function fromBase64(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** UTF-8 解碼：優先用 TextDecoder（Chrome 38／Safari 10.1 以前就有 ✓），
   *  沒有就用手工後備 ✓（CJK Ext B 的字是代理對，手工那條也要正確 ✓）。 */
  var UTF8 = (typeof TextDecoder !== "undefined") ? new TextDecoder("utf-8") : null;

  function utf8Decode(b) {
    if (UTF8) {
      try { return UTF8.decode(b); } catch (e) { /* 落到手工那條 */ }
    }
    var out = "", i = 0, c, cp;
    while (i < b.length) {
      c = b[i++];
      if (c < 0x80) out += String.fromCharCode(c);
      else if (c < 0xE0) out += String.fromCharCode(((c & 0x1F) << 6) | (b[i++] & 0x3F));
      else if (c < 0xF0) {
        out += String.fromCharCode(((c & 0x0F) << 12) | ((b[i++] & 0x3F) << 6) | (b[i++] & 0x3F));
      } else {
        cp = ((c & 0x07) << 18) | ((b[i++] & 0x3F) << 12) | ((b[i++] & 0x3F) << 6) | (b[i++] & 0x3F);
        cp -= 0x10000;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      }
    }
    return out;
  }

  function Reader(d) { this.d = d; this.i = 0; }

  Reader.prototype.u8 = function () {
    var v = this.d[this.i];
    this.i += 1;
    return v === undefined ? 0 : v;
  };
  Reader.prototype.u16 = function () {
    var a = this.u8(), b = this.u8();
    return a | (b << 8);
  };
  Reader.prototype.u32 = function () {
    var a = this.u8(), b = this.u8(), c = this.u8(), d = this.u8();
    return (a | (b << 8) | (c << 16) | (d << 24)) >>> 0;
  };
  Reader.prototype.raw = function (n) {
    var r = this.d.subarray(this.i, this.i + n);
    this.i += n;
    return r;
  };
  Reader.prototype.str = function () { return utf8Decode(this.raw(this.u16())); };
  Reader.prototype.ascii = function (n) {
    var r = this.raw(n), s = "";
    for (var i = 0; i < r.length; i++) s += String.fromCharCode(r[i]);
    return s;
  };

  /** 巨集 → 劇本。任何一項對不上都丟出看得懂的中文錯誤 ✓（不是安靜播一半 ✗）。 */
  function decodeTour(bytes, magic) {
    var r = new Reader(bytes);
    var got = r.ascii(5);
    if (got !== magic && got !== MAGIC && !LEGACY[got]) {
      throw new Error("這不是導覽的巨集（魔數 " + JSON.stringify(got) + "）");
    }
    var fmt = r.u8();
    if (fmt !== FMT) throw new Error("巨集格式 " + fmt + "，這個播放器只認得 " + FMT + "（要重建頁面）");
    r.u8();                                  /* flags（保留） */
    var want = r.u32();
    var payloadAt = r.i;
    var got2 = crc32(bytes.subarray(payloadAt));
    if (want !== got2) {
      throw new Error("巨集壞了（CRC " + got2.toString(16) + " ≠ " + want.toString(16) + "）");
    }
    var tour = { id: r.str(), title: r.str(), intro: r.str(), require: r.str(), scenes: [] };
    var n = r.u16();
    for (var i = 0; i < n; i++) {
      var sc = { title: r.str(), body: r.str(), steps: [] };
      var m = r.u16();
      for (var j = 0; j < m; j++) {
        var op = r.u8(), argc = r.u8(), args = [];
        for (var k = 0; k < argc; k++) args.push(r.str());
        if (!OP_NAME[op]) throw new Error("場景 " + (i + 1) + " 第 " + (j + 1) + " 步：不認得的指令 " + op);
        sc.steps.push({ op: op, args: args });
      }
      tour.scenes.push(sc);
    }
    if (r.i !== bytes.length) throw new Error("巨集尾端多了 " + (bytes.length - r.i) + " 個位元組");
    return tour;
  }

  /* ============================ 播放器的狀態 ============================ */
  var data = { index: [], blobs: {} };
  var prefix = "tour";
  var appName = "這個頁面";
  var modalIds = [];
  var finishHtml = "";
  var magic = MAGIC;
  var app = null;

  /* 播放中的那一份：{ id, tour, scene, step } */
  var cur = null;
  /* 換場景／重播／結束都用這個號碼把「上一輪還在跑的 promise 鏈」作廢 ✓
     （上游用 async/await；ES5 改用號碼＋每一段都先比對，行為相同 ✓）。 */
  var seq = 0;
  var phase = "idle";        /* idle／running／waiting／done */
  var waitKind = "none";     /* none／next／user／cond／pause／tap */
  var note = "";
  var pointSel = null;
  var failed = [];
  var pending = null;        /* 「等你決定」的 promise resolve */
  var userDone = false;
  var skipReq = false;
  var tapped = false;
  var raf = 0;
  var cache = {};

  function pkey(id) { return prefix + "." + id; }

  function el(id) { return document.getElementById(id); }

  /** querySelector 的安全版：選擇器寫錯不該讓整場導覽炸掉 ✓（回傳 null，後面會顯示「找不到」）。 */
  function q(sel) {
    try { return document.querySelector(sel); } catch (e) { return null; }
  }

  /** 元素「看得到」嗎：有面積、不是 visibility:hidden（在收起的欄／分頁裡就是 false ✓）。 */
  function visible(e) {
    if (!e) return false;
    var r = e.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    try { return getComputedStyle(e).visibility !== "hidden"; } catch (e2) { return true; }
  }

  function sleep(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  }

  function now() { return (global.performance && performance.now) ? performance.now() : Date.now(); }

  /* ============================ 條件語法 ============================
   * 三種前綴（與上游同一套，見 pinxing.md〈操作導覽〉的表）：
   *   #id／.class      元素存在而且是看得見的
   *   count:選擇器 >= N  數量比較
   *   api:鍵=值         頁面的 state() 快照
   *   text:選擇器=文字   文字內容包含
   * 前置 `!` ＝否定 ✓；選擇器寫壞當「還沒成立」✓（不要讓整份導覽掛掉 ✗）。
   */
  function evalCond(cond) {
    var c = String(cond).replace(/^\s+|\s+$/g, ""), neg = false;
    if (c.charAt(0) === "!") { neg = true; c = c.slice(1).replace(/^\s+|\s+$/g, ""); }
    var yes = false;
    try { yes = atom(c); } catch (e) { yes = false; }
    return neg ? !yes : yes;
  }

  function atom(c) {
    if (c.indexOf("api:") === 0) {
      var body = c.slice(4);
      var eq = body.indexOf("=");
      var path = (eq < 0 ? body : body.slice(0, eq)).replace(/^\s+|\s+$/g, "");
      var want = eq < 0 ? null : body.slice(eq + 1).replace(/^\s+|\s+$/g, "");
      var v;
      try {
        var snap = (app && app.state) ? app.state() : {};
        v = snap;
        var parts = path.split(".");
        for (var i = 0; i < parts.length; i++) v = (v == null) ? undefined : v[parts[i]];
      } catch (e2) { v = undefined; }
      return want === null ? !!v : String(v) === want;
    }
    if (c.indexOf("count:") === 0) {
      var m = /^(.*?)\s*(>=|<=|==|!=|>|<)\s*(\d+)$/.exec(c.slice(6).replace(/^\s+|\s+$/g, ""));
      if (m) {
        var n = document.querySelectorAll(m[1]).length;
        var k = Number(m[3]);
        if (m[2] === ">=") return n >= k;
        if (m[2] === "<=") return n <= k;
        if (m[2] === "==") return n === k;
        if (m[2] === "!=") return n !== k;
        if (m[2] === ">") return n > k;
        return n < k;
      }
      try { return document.querySelectorAll(c.slice(6).replace(/^\s+|\s+$/g, "")).length > 0; }
      catch (e3) { return false; }
    }
    if (c.indexOf("text:") === 0) {
      var tb = c.slice(5);
      var te = tb.indexOf("=");
      if (te < 0) return false;
      var teEl = q(tb.slice(0, te).replace(/^\s+|\s+$/g, ""));
      return !!teEl && (teEl.textContent || "").indexOf(tb.slice(te + 1).replace(/^\s+|\s+$/g, "")) >= 0;
    }
    return visible(q(c));
  }

  /* ============================ 載入與進度 ============================ */
  function load(id) {
    var t = cache[id];
    if (t) return t;
    var b64 = data.blobs[id];
    if (!b64) return null;
    try {
      t = decodeTour(fromBase64(b64), magic);
      cache[id] = t;
      return t;
    } catch (e) {
      console.error("[導覽] 巨集解不開：" + (e && e.message));
      return null;
    }
  }

  /** 上次看到第幾個場景（0 起算；沒有記錄＝0）。 */
  function tourProgress(id) {
    try {
      var v = Number(localStorage.getItem(pkey(id)) || "0");
      return v > 0 ? Math.floor(v) : 0;
    } catch (e) { return 0; }
  }

  function saveProgress(scene) {
    if (!cur) return;
    try { localStorage.setItem(pkey(cur.id), String(scene)); } catch (e) { /* 無痕模式 */ }
  }

  /* ============================ 氣泡／聚光燈 ============================ */
  /* Markdown 只支援 **粗體** 與 `等寬`（與上游相同 ✓）。
     ⚠ 反引號**不可以**直接寫在這一支檔案裡 ✗——它會被塞進 build-pinxing.ts 的樣板字串，
       寫一個反引號就會把樣板字串提早結束（第 111～112 輪的教訓 ✓，check-syntax 會抓 ✓）。 */
  var TICK = String.fromCharCode(96);
  var CODE_RE = new RegExp(TICK + "([^" + TICK + "]+)" + TICK, "g");

  function mdLite(src) {
    return String(src)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .split(/\n{2,}/)
      .map(function (p) {
        return "<p>" + p.replace(/\n/g, "<br>")
          .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
          .replace(CODE_RE, "<code>$1</code>") + "</p>";
      })
      .join("");
  }

  function setText(md) {
    var e = el("tourText");
    if (e) e.innerHTML = mdLite(md);
  }

  function setNote(msg) {
    note = msg;
    var e = el("tourNote");
    if (e) {
      e.textContent = msg;
      e.hidden = !msg;
    }
  }

  function pointAt(sel) {
    pointSel = sel;
    layout();
  }

  /** 每一步都重算：目標可能會動（捲動、清單延遲掛載、字級改變）✓——
   *  所以氣泡開著的時候每一幀都重畫（rAF ✓），不是只在指過去的那一下算一次 ✗。 */
  function layout() {
    var spot = el("tourSpot"), bubble = el("tourBubble");
    if (!spot || !bubble || bubble.hidden) return;
    var target = pointSel ? q(pointSel) : null;
    var r = target ? target.getBoundingClientRect() : null;
    var has = !!r && r.width > 0 && r.height > 0;
    spot.hidden = !has;
    if (has) {
      var pad = 4;
      spot.style.left = Math.round(r.left - pad) + "px";
      spot.style.top = Math.round(r.top - pad) + "px";
      spot.style.width = Math.round(r.width + pad * 2) + "px";
      spot.style.height = Math.round(r.height + pad * 2) + "px";
      /* 目標在下半部 → 氣泡翻到上緣，免得蓋住它 ✓ */
      var lower = r.top + r.height / 2 > window.innerHeight / 2;
      bubble.style.top = lower ? "18px" : "";
      bubble.style.bottom = lower ? "" : "18px";
    } else {
      bubble.style.top = "";
      bubble.style.bottom = "18px";
      if (pointSel && note.indexOf("⚠ 找不到") < 0) {
        setNote("⚠ 找不到「" + pointSel + "」，或它目前看不到");
      }
    }
    /* 目標找到了就把「找不到」收掉（它可能只是慢一步掛上來 ✓） */
    if (has && note.indexOf("⚠ 找不到") === 0) setNote("");
  }

  function startRaf() {
    if (raf) return;
    var tick = function () { raf = requestAnimationFrame(tick); layout(); };
    raf = requestAnimationFrame(tick);
  }

  function stopRaf() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function showBubble(on) {
    var b = el("tourBubble");
    if (b) b.hidden = !on;
    if (!on) {
      var s = el("tourSpot");
      if (s) s.hidden = true;
      stopRaf();
      return;
    }
    startRaf();
  }

  /* ============================ 按鈕 ============================ */
  function show(id, on, label) {
    var b = el(id);
    if (!b) return;
    b.hidden = !on;
    if (on && label) b.textContent = label;
  }

  function updateUi() {
    if (!cur) return;
    var sc = cur.tour.scenes[cur.scene];
    if (!sc) return;
    var where = el("tourWhere");
    if (where) where.textContent = "場景 " + (cur.scene + 1) + " / " + cur.tour.scenes.length;
    var title = el("tourTitle");
    if (title) title.textContent = sc.title;
    var prog = el("tourProg");
    if (prog) prog.textContent = Math.min(cur.step, sc.steps.length) + " / " + sc.steps.length;
    var last = cur.scene >= cur.tour.scenes.length - 1;
    show("tourNext", waitKind === "next", last ? "完成 ✓" : "下一個場景 →");
    show("tourDone", waitKind === "user");
    show("tourSkip", waitKind === "user" || waitKind === "cond" || waitKind === "pause",
      waitKind === "cond" ? "略過等待" : "略過這步");
    show("tourReplay", waitKind !== "none");
    /* 「上一個場景」永遠在（第一個場景只是不能按）✓——讓客人隨時可以回頭看 ✓ */
    var prev = el("tourPrev");
    if (prev) { prev.hidden = false; prev.disabled = cur.scene === 0; }
    var bubble = el("tourBubble");
    if (bubble) bubble.className = waitKind === "pause" ? "paused" : "";
  }

  function beginScene(sc) {
    setText(sc.body);
    var title = el("tourTitle");
    if (title) title.textContent = sc.title;
    setNote("");
    pointSel = null;
    waitKind = "none";
    phase = "running";
    updateUi();
    layout();
  }

  /** 中斷目前掛著的等待（換場景／結束時叫）。 */
  function interrupt() {
    var p = pending;
    pending = null;
    if (p) p("stop");
    userDone = false;
    skipReq = false;
    tapped = false;
  }

  function ask(kind) {
    waitKind = kind;
    phase = kind === "next" ? "waiting" : "running";
    updateUi();
    return new Promise(function (res) {
      pending = function (v) { pending = null; res(v); };
    });
  }

  function fail(msg) {
    note = msg;
    if (cur) failed.push({ scene: cur.scene, step: cur.step, msg: msg });
    setNote(msg);
    return "pause";
  }

  /* ============================ 執行一步 ============================ */
  /* 回傳 Promise<"ok"|"skip"|"pause"> ✓（上游的 async function 改成 promise 鏈 ✓）。 */
  function exec(st, my) {
    var a = st.args;
    switch (st.op) {
      case OP.text:
        setText(a[0]);
        return Promise.resolve("ok");
      case OP.point:
        pointAt(a[0]);
        return Promise.resolve("ok");
      case OP.unpoint:
        pointAt(null);
        return Promise.resolve("ok");
      case OP.click: {
        var e = q(a[0]);
        if (!visible(e)) return Promise.resolve(fail("找不到「" + a[0] + "」（或它目前看不到）"));
        try { e.click(); } catch (e1) { return Promise.resolve(fail("點「" + a[0] + "」失敗：" + (e1 && e1.message))); }
        return sleep(60).then(function () { return "ok"; });
      }
      case OP.type: {
        var inp = q(a[0]);
        if (!inp) return Promise.resolve(fail("找不到輸入框「" + a[0] + "」"));
        try { inp.focus(); } catch (e2) { }
        inp.value = a[1] === undefined ? "" : a[1];
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        return sleep(60).then(function () { return "ok"; });
      }
      case OP.key: {
        var kt = a[1] ? q(a[1]) : document.activeElement;
        if (!kt) return Promise.resolve(fail("找不到「" + (a[1] || "目前焦點") + "」"));
        kt.dispatchEvent(new KeyboardEvent("keydown", { key: a[0], bubbles: true, cancelable: true }));
        return sleep(60).then(function () { return "ok"; });
      }
      case OP.wait:
        return sleep(Number(a[0]) || 0).then(function () { return "ok"; });
      case OP.waitFor:
        return waitCond(a[0], Number(a[1]) || 5000, my, "");
      case OP.tab:
        if (app && app.tab) app.tab(a[0], a[1]);
        return sleep(120).then(function () { return "ok"; });
      case OP.side:
        if (app && app.side) app.side(a[0], a[1] === "on");
        return sleep(120).then(function () { return "ok"; });
      case OP.set:
        if (!app || !app.set || !app.set(a[0], a[1] === undefined ? "" : a[1])) {
          return Promise.resolve(fail("不認得的設定「" + a[0] + "」"));
        }
        return sleep(120).then(function () { return "ok"; });
      case OP.call:
        try {
          if (app && app.call) app.call(a[0], a[1] === undefined ? "" : a[1]);
        } catch (e3) {
          return Promise.resolve(fail(a[0] + " 失敗：" + ((e3 && e3.message) || e3)));
        }
        return Promise.resolve("ok");
      case OP.user:
        return waitUser(a[0], a[1] || "", my);
      case OP.tap:
        return waitTap(a[0] || "", my);
      case OP.require:
        return waitCond(a[0], 120000, my, "需要：" + a[0]);
      case OP.skipIf:
        if (evalCond(a[0])) { note = "（本場景不適用：" + a[0] + "）"; return Promise.resolve("skip"); }
        return Promise.resolve("ok");
      default:
        return Promise.resolve(fail("未知指令 " + st.op));
    }
  }

  /** 輪詢到條件成立；客人可以按「略過等待」✓（**不要**用固定 sleep 等資料 ✗）。 */
  function waitCond(cond, timeout, my, hint) {
    if (evalCond(cond)) return Promise.resolve("ok");
    waitKind = "cond";
    updateUi();
    var t0 = now();
    return new Promise(function (res) {
      function tick() {
        if (my !== seq) return res("ok");
        if (skipReq) { skipReq = false; setNote("（跳過等待：" + cond + "）"); return res("ok"); }
        if (evalCond(cond)) { setNote(""); return res("ok"); }
        if (now() - t0 > timeout) return res(fail("等不到「" + cond + "」（" + Math.round(timeout) + " ms）"));
        setNote((hint || "等") + "：" + cond + "…");
        setTimeout(tick, 100);
      }
      tick();
    });
  }

  /** 等客人自己做完（或條件先成立）✓。 */
  function waitUser(text, cond, my) {
    setText(text);
    if (cond && evalCond(cond)) return Promise.resolve("ok");
    waitKind = "user";
    updateUi();
    return new Promise(function (res) {
      function tick() {
        if (my !== seq) return res("ok");
        if (userDone) { userDone = false; return res("ok"); }
        if (skipReq) { skipReq = false; return res("ok"); }
        if (cond && evalCond(cond)) return res("ok");
        setTimeout(tick, 120);
      }
      tick();
    });
  }

  /** 停在這裡，等客人在畫面任何地方點一下（或按空白／→／Enter）✓。
   *  為什麼要有這一步：介紹介面的場景如果自動跑完，客人根本來不及看第二眼 ✓。 */
  function waitTap(hint, my) {
    tapped = false;
    waitKind = "tap";
    setNote(hint || "（點畫面任何地方，或按空白鍵，繼續）");
    updateUi();
    return new Promise(function (res) {
      function tick() {
        if (my !== seq) return res("ok");
        if (tapped) { tapped = false; setNote(""); return res("ok"); }
        setTimeout(tick, 80);
      }
      tick();
    });
  }

  /* ============================ 主流程 ============================ */
  function play(id, from) {
    if (!app) return;
    var tour = load(id);
    if (!tour) { openMenu(); return; }
    interrupt();
    seq++;
    var my = seq;
    var start = (from === undefined || from === null) ? tourProgress(id) : from;
    start = Math.max(0, Math.min(start, tour.scenes.length - 1));
    cur = { id: id, tour: tour, scene: start, step: 0 };
    failed = [];
    note = "";
    closeMenu();
    showBubble(true);
    /* 播放器自己理論上不會丟（每一種失敗都在 exec 裡接住 ✓），但真的丟了也要看得到 ✓，
       不能變成一個沒人處理的 rejected promise ✗。 */
    runScene(my);
  }

  /** 播完「現在這一個場景」：先跑步驟，再把畫面停住等客人決定 ✓。 */
  function runScene(my) {
    if (my !== seq || !cur) return;
    var sc = cur.tour.scenes[cur.scene];
    if (!sc) { finish(); return; }
    beginScene(sc);
    nextStep(my, sc);
  }

  function nextStep(my, sc) {
    if (my !== seq || !cur) return;
    if (cur.step >= sc.steps.length) { endScene(my, sc); return; }
    var myStep = cur.step;
    exec(sc.steps[myStep], my).then(function (r) {
      if (my !== seq || !cur) return;
      if (r === "skip") { cur.scene++; cur.step = 0; runScene(my); return; }
      if (r === "pause") {
        ask("pause").then(function (act) {
          if (my !== seq || !cur) return;
          if (act === "stop") { stop(); return; }
          if (act === "replay") { cur.step = 0; beginScene(sc); updateUi(); nextStep(my, sc); return; }
          /* act === "next"（＝略過這一步） */
          cur.step++;
          updateUi();
          nextStep(my, sc);
        });
        return;
      }
      cur.step++;
      updateUi();
      nextStep(my, sc);
    }).then(null, function (e) {
      if (my !== seq) return;
      fail("導覽中斷：" + ((e && e.message) || e));
      phase = "paused";
      waitKind = "pause";
      updateUi();
    });
  }

  /** 一個場景做完：停住，等客人決定要不要往下 ✓（進度在這裡存 ✓）。 */
  function endScene(my, sc) {
    phase = "waiting";
    waitKind = "next";
    setText(sc.body);
    setNote("");
    saveProgress(cur.scene);
    updateUi();
    ask("next").then(function (act) {
      if (my !== seq || !cur) return;
      if (act === "stop") { stop(); return; }
      if (act === "replay") { play(cur.id, cur.scene); return; }
      if (act === "prev") { play(cur.id, Math.max(0, cur.scene - 1)); return; }
      cur.scene++;
      cur.step = 0;
      runScene(my);
    });
  }

  function finish() {
    phase = "done";
    waitKind = "next";
    pointSel = null;
    layout();
    var title = el("tourTitle");
    if (title) title.textContent = "導覽結束";
    setText(finishHtml || ("這些都可以在 " + appName + " 的設定裡隨時改回來。" +
      "想再看一次：按「操作導覽」再開一次 ✓。"));
    setNote("");
    if (cur) saveProgress(cur.tour.scenes.length - 1);
    var next = el("tourNext");
    if (next) { next.hidden = false; next.textContent = "再看一次"; }
    show("tourDone", false);
    show("tourSkip", false);
    show("tourReplay", false);
    var prev = el("tourPrev");
    if (prev) prev.hidden = true;
    var prog = el("tourProg");
    if (prog) prog.textContent = "";
    pending = null;
  }

  function stop() {
    interrupt();
    seq++;
    cur = null;
    phase = "idle";
    waitKind = "none";
    note = "";
    pointSel = null;
    showBubble(false);
  }

  /* ============================ 選單 ============================ */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function renderMenu() {
    var list = el("tourList");
    if (!list) return;
    var html = "";
    for (var i = 0; i < data.index.length; i++) {
      var t = data.index[i];
      var done = tourProgress(t.id);
      var label = (done > 0 && done < t.scenes) ? ("繼續（" + (done + 1) + " / " + t.scenes + "）") : "開始";
      html += '<div class="tourRow" data-id="' + escapeHtml(t.id) + '">' +
        '<div class="tourName">' + escapeHtml(t.title) + "</div>" +
        '<div class="tourIntro">' + escapeHtml(t.intro) + "</div>" +
        '<div class="tourMeta">' + t.scenes + " 個場景 · " + t.steps + " 步" +
        (t.require ? " · 需要 " + escapeHtml(t.require) : "") + "</div>" +
        '<div class="tourActs"><button type="button" class="primary" data-play="1">' + label + "</button>" +
        (done > 0 ? '<button type="button" data-restart="1">從頭</button>' : "") +
        "</div></div>";
    }
    list.innerHTML = html;
    var rows = list.querySelectorAll(".tourRow");
    for (var r = 0; r < rows.length; r++) {
      (function (row) {
        var id = row.getAttribute("data-id") || "";
        var bPlay = row.querySelector("[data-play]");
        var bAgain = row.querySelector("[data-restart]");
        if (bPlay) bPlay.addEventListener("click", function () { play(id); });
        if (bAgain) bAgain.addEventListener("click", function () { play(id, 0); });
      })(rows[r]);
    }
  }

  function openMenu() {
    if (cur) stop();                 /* 播放中再開選單 ＝ 先收掉導覽，再挑一份 ✓ */
    var box = el("tourBox"), back = el("tourBackdrop");
    if (box) box.hidden = false;
    if (back) back.hidden = false;
    renderMenu();
  }

  function closeMenu() {
    var box = el("tourBox"), back = el("tourBackdrop");
    if (box) box.hidden = true;
    if (back) back.hidden = true;
  }

  function menuOpen() {
    var box = el("tourBox");
    return !!box && box.hidden === false;
  }

  /** 入口：**只有一份劇本就直接播**、多份才開選單讓客人挑 ✓。 */
  function start() {
    if (!data.index.length) return;
    if (data.index.length === 1) play(data.index[0].id);
    else openMenu();
  }

  /* ============================ 鍵盤 ============================ */
  function modalOpen() {
    for (var i = 0; i < modalIds.length; i++) {
      var m = el(modalIds[i]);
      if (m && m.hidden === false) return true;
    }
    return false;
  }

  function onKey(ev) {
    /* 有彈窗時讓彈窗自己處理 Esc（導覽不搶）✓ */
    if (ev.key === "Escape") {
      if (modalOpen()) return;
      if (menuOpen()) { ev.preventDefault(); ev.stopPropagation(); closeMenu(); return; }
      if (cur) { ev.preventDefault(); ev.stopPropagation(); stop(); }
      return;
    }
    if (!cur) return;
    if (ev.key === "ArrowRight" || ev.key === " " || ev.key === "Enter") {
      /* `停` 那一步：空白／→／Enter 也算「點了一下畫面」✓ */
      if (waitKind === "tap") { ev.preventDefault(); ev.stopPropagation(); tapped = true; return; }
      if (waitKind !== "next") return;
      ev.preventDefault();
      ev.stopPropagation();
      if (phase === "done") play(cur.id, 0);
      else if (pending) pending("next");
      return;
    }
    if (ev.key === "ArrowLeft" && cur.scene > 0) {
      ev.preventDefault();
      ev.stopPropagation();
      play(cur.id, Math.max(0, cur.scene - 1));
    }
  }

  /* ============================ 接線 ============================ */
  function init(a, d, options) {
    if (app) return;                 /* 只綁一次（重複 init 會讓每一顆按鈕都點兩次 ✗） */
    app = a;
    data = d || { index: [], blobs: {} };
    options = options || {};
    prefix = options.storagePrefix || "tour";
    appName = options.appName || "這個頁面";
    modalIds = options.modalIds || [];
    finishHtml = options.finishHtml || "";
    magic = options.magic || MAGIC;

    var x = el("tourClose");
    if (x) x.addEventListener("click", closeMenu);
    var back = el("tourBackdrop");
    if (back) back.addEventListener("click", closeMenu);
    var tX = el("tourX");
    if (tX) tX.addEventListener("click", stop);
    var next = el("tourNext");
    if (next) next.addEventListener("click", function () {
      if (phase === "done" && cur) { play(cur.id, 0); return; }
      if (pending) pending("next");
    });
    var prev = el("tourPrev");
    if (prev) prev.addEventListener("click", function () { if (cur) play(cur.id, Math.max(0, cur.scene - 1)); });
    var replay = el("tourReplay");
    if (replay) replay.addEventListener("click", function () { if (cur) play(cur.id, cur.scene); });
    var done = el("tourDone");
    if (done) done.addEventListener("click", function () { userDone = true; });
    var skip = el("tourSkip");
    if (skip) skip.addEventListener("click", function () {
      if (waitKind === "pause") { if (pending) pending("next"); return; }
      skipReq = true;
    });
    /* `停` 那一步：點畫面任何地方就往下走（導覽自己的按鈕不算，它們各有各的意思 ✓） */
    document.addEventListener("click", function (ev) {
      if (waitKind !== "tap") return;
      var t = ev.target;
      if (t && t.closest && t.closest("#tourBubble, #tourBox, #tourBackdrop")) return;
      tapped = true;
    }, true);
    /* window 的 capture 比 document 的 capture 先收到 ✓：導覽的鍵盤優先於頁面自己的 Esc ✓ */
    window.addEventListener("keydown", onKey, true);
    renderMenu();
  }

  /* ============================ 診斷（驗收用） ============================ */
  function state() {
    var bubble = el("tourBubble"), spot = el("tourSpot");
    var target = pointSel ? q(pointSel) : null;
    var br = bubble ? bubble.getBoundingClientRect() : null;
    var sr = (spot && !spot.hidden) ? spot.getBoundingClientRect() : null;
    var tr = target ? target.getBoundingClientRect() : null;
    var btns = ["tourNext", "tourPrev", "tourReplay", "tourDone", "tourSkip"];
    var shown = [];
    for (var i = 0; i < btns.length; i++) {
      var b = el(btns[i]);
      if (b && b.hidden === false) shown.push(btns[i]);
    }
    return {
      id: cur ? cur.id : null,
      scene: cur ? cur.scene : -1,
      scenes: cur ? cur.tour.scenes.length : 0,
      step: cur ? cur.step : -1,
      steps: cur ? (cur.tour.scenes[cur.scene] ? cur.tour.scenes[cur.scene].steps.length : 0) : 0,
      phase: phase,
      waitKind: waitKind,
      note: note,
      point: pointSel,
      failed: failed.slice(),
      progress: cur ? tourProgress(cur.id) : 0,
      bubble: {
        visible: !!bubble && !bubble.hidden,
        rect: (br && br.width) ? { x: Math.round(br.x), y: Math.round(br.y), w: Math.round(br.width), h: Math.round(br.height) } : null,
        text: el("tourText") ? (el("tourText").textContent || "").slice(0, 120) : "",
        title: el("tourTitle") ? (el("tourTitle").textContent || "") : "",
        where: el("tourWhere") ? (el("tourWhere").textContent || "") : "",
        buttons: shown
      },
      spot: {
        visible: !!sr,
        rect: sr ? { x: Math.round(sr.x), y: Math.round(sr.y), w: Math.round(sr.width), h: Math.round(sr.height) } : null,
        target: tr ? { x: Math.round(tr.x), y: Math.round(tr.y), w: Math.round(tr.width), h: Math.round(tr.height) } : null,
        overlapTarget: !!(sr && tr) &&
          !(sr.right < tr.left || sr.left > tr.right || sr.bottom < tr.top || sr.top > tr.bottom)
      },
      tours: (function () {
        var out = [];
        for (var k = 0; k < data.index.length; k++) {
          var t = data.index[k];
          out.push({ id: t.id, title: t.title, scenes: t.scenes, steps: t.steps });
        }
        return out;
      })()
    };
  }

  global.SelfTour = {
    init: init,
    start: start,
    play: play,
    stop: stop,
    openMenu: openMenu,
    closeMenu: closeMenu,
    state: state,
    evalCond: evalCond
  };
})(window);
