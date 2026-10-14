// check-viewer.ts — 驗收 `out/kage-viewer.html`（單純的字形檢視頁）。
//
// 這一頁**故意只做字形檢視**，不含編輯器功能。
// 編輯器是另一頁：`out/codemirror-kage.html`，由 `tools/check-codemirror.ts` 驗收。
//
// 這一頁內嵌的是**全部 Unicode CJK 漢字區塊**的字庫（`out/lib-cjk-all.bin.gz`），
// 所以 `𩀨`（U+29028，Ext B）在，holy grail `邏羅寶貝𩀨從䞃致招` 也組得出來。
//
// 用法: bun run tools/check-viewer.ts
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const D = "D:/2023/glyphwiki";
const LIB = "lib-cjk-all";   // 這一頁內嵌的字庫（改這裡就要一起改 build-kage-viewer.ts）
let fail = 0;
const ok = (s: string) => console.log("  ✓ " + s);
const bad = (s: string) => { console.log("  ✗ " + s); fail++; };

// 1) .bin 與 .gz 是否一致（先前不同步，害網頁解碼錯位且無錯誤訊息）
console.log(`1. 字形庫兩檔一致（${LIB}）`);
const raw = readFileSync(`${D}/out/${LIB}.bin`);
const un = Bun.gunzipSync(readFileSync(`${D}/out/${LIB}.bin.gz`));
if (raw.length !== un.length) bad(`.bin=${raw.length} ≠ .gz 解壓=${un.length}`);
else {
  let same = true;
  for (let i = 0; i < raw.length; i++) if (raw[i] !== un[i]) { same = false; break; }
  same ? ok(`.bin 與 .gz 解壓完全相同（${raw.length.toLocaleString()} bytes）`)
       : bad("大小相同但內容不同");
}

// 2) 內嵌在網頁裡的程式碼能否解碼整份字形庫
console.log("\n2. 網頁內嵌程式碼可解碼");
const html = readFileSync(`${D}/out/kage-viewer.html`, "utf8");
const sm = /<script>([\s\S]*?)<\/script>/.exec(html);
const ENGINE_END = "/* ============ 精簡庫解碼";
const MAIN_START = "/* ============================ 主流程";
const script = sm ? sm[1]! : "";
const engEnd = script.indexOf(ENGINE_END);
const mainStart = script.indexOf(MAIN_START);
const engineSrc = engEnd > 0 ? script.slice(0, engEnd) : "";
const head = mainStart > 0 ? script.slice(0, mainStart) : null;
const b64m = sm ? /const LIB_B64 = "([^"]*)"/.exec(sm[1]!) : null;
let holyGrailLib: any = null;
if (!sm) bad("找不到 script 區塊");
else if (engEnd < 0) bad("找不到引擎分隔註解");
else if (!head) bad("找不到主流程分隔註解");
else if (!b64m) bad("找不到 LIB_B64");
else {
  try {
    // 先把 kage-engine 放進全域（瀏覽器裡它是頂層 script，本來就是全域）；
    // Node 的 new Function 作用域不是全域，所以要在這裡先 eval 一次。
    (0, eval)(engineSrc);
    const api = new Function(
      head + "\nreturn { decodeLibrary: decodeLibrary, indexOfCodePoint: indexOfCodePoint," +
      " keyOfIdx: keyOfIdx, displayName: displayName, charOf: charOf," +
      " composeFit: composeFit, normalizeSvg: normalizeSvg };",
    )();
    const lib = api.decodeLibrary(new Uint8Array(Bun.gunzipSync(Buffer.from(b64m[1]!, "base64"))));
    ok(`解碼成功：${lib.glyphs.length.toLocaleString()} 字形、` +
       `${lib.families.length.toLocaleString()} 個家族、${lib.glyphs.length.toLocaleString()} 筆畫記錄`);
    lib.families.length > 0 ? ok("是 v2 格式（有家族表）") : bad("沒有家族表，可能還是 v1");

    // 緊框是衍生值（不在檔案裡），解碼時由 computeTight 算出。
    // u571f-j 的正確緊框是 [14,17,186,169]，由三條直線的端點決定。
    const gi = api.indexOfCodePoint(lib, 0x571f);
    const g = lib.glyphs[gi];
    JSON.stringify(g.tight) === "[14,17,186,169]"
      ? ok(`土（${api.displayName(lib, gi)}）緊框正確 [14,17,186,169]（衍生計算）、${g.strokes.length} 筆`)
      : bad(`土 緊框錯誤：${JSON.stringify(g.tight)}`);
    g.strokes.every((s: any) => s.kind === 1)
      ? ok("土 三筆皆為直線（kind=1）")
      : bad("土 筆畫型別錯誤");

    // 再驗一個「純引用」的字：其緊框完全來自子部件。
    // **刻意不寫死數字**：庫一旦重建（筆畫資料更新）就會差 1——原本寫死 [14,23,186,178]，
    // 但現在這份庫把第一個子部件的緊框 y1=20 經框 [0,2,200,202] 映射成 2+20=22，
    // 存的是 22。這裡驗的是「映射算得對不對」，所以在檢查端自己重算一次再比對
    //（同一條公式：b1 + c*(b3-b1)/200），庫換了也不會誤報。
    const mi = api.indexOfCodePoint(lib, 0x76df);
    const mg = lib.glyphs[mi];
    const mapX = (b: number[], cx: number) => b[0]! + (cx * (b[2]! - b[0]!)) / 200;
    const mapY = (b: number[], cy: number) => b[1]! + (cy * (b[3]! - b[1]!)) / 200;
    let ex1 = Infinity, ey1 = Infinity, ex2 = -Infinity, ey2 = -Infinity;
    for (const s of mg.strokes) {
      if (s.kind !== 99 || s.ref === null || !s.box) continue;
      const cb = lib.glyphs[s.ref]!.tight!;
      for (const [mx, my] of [
        [mapX(s.box, cb[0]), mapY(s.box, cb[1])],
        [mapX(s.box, cb[2]), mapY(s.box, cb[3])],
      ]) {
        if (mx < ex1) ex1 = mx;
        if (mx > ex2) ex2 = mx;
        if (my < ey1) ey1 = my;
        if (my > ey2) ey2 = my;
      }
    }
    {
      const t = mg.tight as number[];
      const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
      const mine = [ex1, ey1, ex2, ey2];
      near(t[0]!, mine[0]!) && near(t[1]!, mine[1]!) && near(t[2]!, mine[2]!) && near(t[3]!, mine[3]!)
        ? ok(`盟（${api.displayName(lib, mi)}）緊框 ${JSON.stringify(t)} ＝ 子部件緊框映射後的外框（自行重算 ${JSON.stringify(mine)}）`)
        : bad(`盟 緊框 ${JSON.stringify(t)} 與自行映射的 ${JSON.stringify(mine)} 不符`);
    }

    // **Ext B 必須在庫裡**——這一頁改用 Ext B 庫就是為了這個字
    const jiong = api.indexOfCodePoint(lib, 0x29028);
    jiong !== undefined
      ? ok(`𩀨 U+29028 在庫中（${api.displayName(lib, jiong)}）`)
      : bad("𩀨 U+29028 不在庫中——內嵌的還是 BMP-only 字庫");

    // 內部命名不外流：v2 沒有名字字串，key 由索引導出
    lib.names === undefined
      ? ok("v2 沒有內建名字字串（對外一律用碼位；名字在 .gnames.tsv.gz）")
      : bad("字庫裡還有名字字串陣列");

    // 組字（這一頁的輸入規則就是「第 1 字為主字，其餘成對替換」）
    const r = api.composeFit(lib, "寶", [["缶", "支"]]);
    "error" in r ? bad("composeFit 失敗：" + r.error) : ok(`組字可用：${r.log.join("；")}`);

    // holy grail：開頁預設的那一串，九個字都要在庫、而且要組得出來
    const SEQ = "邏羅寶貝𩀨從䞃致招";
    const chars = Array.from(SEQ);
    const missing = chars.filter((c: string) => api.indexOfCodePoint(lib, c.codePointAt(0)) === undefined);
    missing.length === 0
      ? ok(`holy grail 九個字全在庫：${SEQ}`)
      : bad(`holy grail 有字不在庫：${missing.join("")}`);
    const pairs: [string, string][] = [];
    for (let i = 1; i + 1 < chars.length; i += 2) pairs.push([chars[i]!, chars[i + 1]!]);
    const hg = api.composeFit(lib, chars[0]!, pairs);
    if ("error" in hg) bad("holy grail 組字失敗：" + hg.error);
    else {
      ok(`holy grail 組字成功（${hg.log.length} 步）：${SEQ}`);
      hg.log.length === 4 ? ok("  四步替換都成立") : bad(`  步數應為 4，實際 ${hg.log.length}`);
      holyGrailLib = hg.lib;
    }

    // 內嵌用的 SVG 正規化：移除寬高、確保有 viewBox
    const norm = api.normalizeSvg('<svg width="200" height="200"><path d="M0,0"/></svg>');
    !/\swidth=/.test(norm) && !/\sheight=/.test(norm) && /viewBox="0 0 200 200"/.test(norm)
      ? ok("normalizeSvg 會移除寬高並補上 viewBox")
      : bad("normalizeSvg 不正確：" + norm);

    // ---- 真的把「主流程」跑一次 ----
    // 上面只驗了模組；`svgFor` 是頁面自己的程式碼，寫錯（例如用到不存在的作用域）
    // 只有真的執行才會發現。這裡把主流程切到 `function render()` 之前，
    // 連同模組一起編譯，然後直接呼叫 `svgFor`——跟瀏覽器走同一條路。
    const renderIdx = script.indexOf("function render()");
    const mainFlow = script.slice(mainStart, renderIdx > 0 ? renderIdx : script.length);
    const page = new Function(
      head + "\n" + mainFlow + "\nreturn { svgFor: svgFor, parseToken: parseToken };",
    )();
    const svgJiong = page.svgFor(0x29028, lib);
    svgJiong && /<path/.test(svgJiong.svg)
      ? ok(`svgFor(𩀨) 產出 SVG：${(svgJiong.svg.length / 1024).toFixed(1)} KB`)
      : bad("svgFor(𩀨) 沒有產出 SVG");
    // 前端沒有名字對照表，所以顯示名會是內部 key（`g<base36>`）——
    // 那只是方便認人，不是身分。真實名字在 .gnames.tsv.gz，不進前端。
    svgJiong && /^g[0-9a-z]+$/.test(svgJiong.name)
      ? ok(`前端顯示名是內部 key「${svgJiong.name}」（對照表不進前端）`)
      : bad("前端顯示名不是內部 key：" + svgJiong?.name);
    if (holyGrailLib) {
      const svgGrail = page.svgFor(0x908f, holyGrailLib);
      svgGrail && /<path/.test(svgGrail.svg)
        ? ok(`svgFor(招財進寶 holy grail) 產出 SVG：${(svgGrail.svg.length / 1024).toFixed(1)} KB`)
        : bad("svgFor(holy grail) 沒有產出 SVG");
    }
  } catch (e) {
    bad("解碼失敗：" + (e as Error).message);
  }
}

// 3) 網頁 script 語法
console.log("\n3. 網頁語法");
try {
  new Function(sm![1]!);
  ok("script 區塊語法正確");
} catch (e) {
  bad("語法錯誤：" + (e as Error).message);
}

// 4) base64 完整性
// 注意：長度為 3 的倍數時不會有 '=' 補齊字元，所以不能要求結尾必須是 '='。
// 真正該驗的是「字元集合法」且「長度 mod 4 正確」且「能還原成 gzip」。
const b64 = /const LIB_B64 = "([^"]*)"/.exec(html)![1]!;
const b64ok = /^[A-Za-z0-9+/]+={0,2}$/.test(b64) && b64.length % 4 === 0;
if (!b64ok) bad(`base64 格式有問題（長度 ${b64.length}）`);
else {
  try {
    const gz = Buffer.from(b64, "base64");
    // gzip 魔數 1f 8b
    if (gz[0] !== 0x1f || gz[1] !== 0x8b) bad("base64 還原後不是 gzip");
    else ok(`base64 合法、還原為 gzip（${(gz.length / 1048576).toFixed(2)} MB）`);
  } catch (e) {
    bad("base64 無法還原：" + (e as Error).message);
  }
}

// 5) 這一頁不該有編輯器功能（避免又把它弄複雜）
console.log("\n5. 這一頁只做字形檢視");
!/[Cc]ode[Mm]irror/.test(html) ? ok("沒有 CodeMirror（編輯器在 codemirror-kage.html）")
                               : bad("混入了 CodeMirror");
!/gc-inline/.test(html) ? ok("沒有內嵌 SVG 的編輯器 CSS")
                        : bad("混入了編輯器用的 CSS");

// 6) 真的用 headless 瀏覽器開這一頁
//
// 前面幾步只證明「內嵌的程式碼沒問題」，不證明「頁面打開來真的畫得出來」。
// 這裡把頁面加上一支探針，用 Edge headless 跑一次，順便截圖當證據。
console.log("\n6. headless 瀏覽器實跑");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
if (!existsSync(EDGE)) {
  console.log("  ！找不到 Edge，跳過瀏覽器實跑");
} else {
  const probe = `
<script>
(function () {
  function report(s) { document.title = "PROBE|" + s; }
  setTimeout(function () {
    try {
      var out = [];
      out.push("status=" + encodeURIComponent((document.getElementById("status").textContent || "").slice(0, 50)));
      out.push("q=" + encodeURIComponent(document.getElementById("q").value));
      var cards = document.querySelectorAll("#out .card");
      out.push("cards=" + cards.length);
      var svg = document.querySelector("#out svg");
      out.push("hasSvg=" + (!!svg));
      out.push("paths=" + (svg ? svg.querySelectorAll("path").length : 0));
      out.push("svgW=" + (svg ? svg.getAttribute("width") : "-"));
      out.push("meta=" + encodeURIComponent((document.querySelector("#out .meta") || {}).textContent || ""));
      out.push("err=" + document.querySelectorAll("#out .meta.err").length);
      report(out.join(" "));
    } catch (e) { report("EXC:" + e.message); }
  }, 3000);
})();
<\/script>`;
  const diagPath = resolve(D, "out/_viewer-probe.html");
  const shotPath = resolve(D, "out/kage-viewer-shot.png");
  writeFileSync(diagPath, html.replace("</body>", probe + "</body>"));
  const proc = Bun.spawnSync([
    EDGE, "--headless=new", "--disable-gpu", "--virtual-time-budget=60000",
    "--window-size=900,760", "--screenshot=" + shotPath,
    "--dump-dom", "file:///" + diagPath.replace(/\\/g, "/"),
  ], { stdout: "pipe", stderr: "ignore" });
  const dom = new TextDecoder().decode(proc.stdout);
  const m = /<title>PROBE\|([^<]*)<\/title>/.exec(dom);
  if (!m) bad("瀏覽器沒有回報結果（title 找不到 PROBE）");
  else {
    const r = m[1]!;
    console.log("  瀏覽器回報：" + r);
    const num = (k: string) => Number(new RegExp("(?:^| )" + k + "=(-?\\d+)").exec(r)?.[1] ?? "NaN");
    const dec = (k: string) => {
      const mm = new RegExp("(?:^| )" + k + "=([^ ]*)").exec(r);
      return mm ? decodeURIComponent(mm[1]!) : "";
    };
    const status = dec("status");
    /解碼|就緒|顯示/.test(status) && !/失敗/.test(status)
      ? ok(`狀態列：${status}`)
      : bad("狀態列不對：" + status);
    dec("q") === "邏羅寶貝𩀨從䞃致招"
      ? ok("輸入框預設就是 holy grail 序列")
      : bad("輸入框預設值不對：" + dec("q"));
    num("cards") === 1 ? ok("畫出 1 張卡片") : bad(`卡片數 ${num("cards")}，預期 1`);
    /hasSvg=true/.test(r) && num("paths") > 0
      ? ok(`卡片裡有 SVG（${num("paths")} 條 path）、寬 ${num("svgW")}px`)
      : bad("卡片裡沒有 SVG：" + r);
    num("err") === 0 ? ok("沒有錯誤卡片") : bad(`有 ${num("err")} 張錯誤卡片`);
    /邏羅寶貝𩀨從䞃致招（羅 → 寶/.test(dec("meta"))
      ? ok("卡片描述就是「邏 的 羅 → 寶 …」四步替換")
      : bad("卡片描述不對：" + dec("meta").slice(0, 40));
    existsSync(shotPath)
      ? ok(`截圖已寫出 ${shotPath}（${(readFileSync(shotPath).length / 1024).toFixed(0)} KB）`)
      : bad("沒有截圖");
  }
  try { unlinkSync(diagPath); } catch {}
}

console.log(fail === 0 ? "\n全部通過" : `\n有 ${fail} 項失敗`);
process.exit(fail === 0 ? 0 : 1);
