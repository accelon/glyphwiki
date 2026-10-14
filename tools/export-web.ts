#!/usr/bin/env bun
/**
 * export-web.ts — 產生「離線單一網頁」：把直接部件資料內嵌成單一 HTML。
 *
 * 用法:
 *   bun run tools/export-web.ts [--db db/glyphwiki.db] [--out out/glyphwiki.html]
 *
 * 資料格式（內嵌、gzip+base64）:
 *   以行分筆；每行 `字\t部件,部件,…\t來源`
 *   來源 b = KAGE 直接子部件、i = 由 IDS 補出（該部件被 KAGE 歸併）
 *
 * 網頁端：
 *   - 輸入部件（可混用字元或碼位）→ 找出所有含這些部件的字
 *   - 以「遞歸到底」比對：某字的部件可再展開，展開後的集合被輸入涵蓋就算命中
 *   - 點選任一部件可再查詢（孳乳導覽）
 *   - 無任何外部資源，可離線開啟
 */

import { Database } from "bun:sqlite";
import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const argv = Bun.argv.slice(2);
let dbPath = "db/glyphwiki.db";
let outPath = "out/glyphwiki.html";
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--db") dbPath = argv[++i]!;
  else if (argv[i] === "--out") outPath = argv[++i]!;
}
const DB = resolve(dbPath);
const OUT = resolve(outPath);
if (!existsSync(DB)) {
  console.error(`db not found: ${DB}`);
  process.exit(1);
}

const db = new Database(DB, { readonly: true });

// ---------------------------------------------------------------- 取資料

const hasComponents = (
  db
    .query("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='glyph_components'")
    .get() as any
).n > 0;
if (!hasComponents) {
  console.error("缺少 glyph_components，請先執行: bun run tools/build-components.ts");
  process.exit(1);
}

// 只取 CJK 碼位的字，且有直接部件者
const rows = db
  .query(`
  SELECT g.codepoint, g.comp_cp, g.comp_name, g.source
    FROM glyph_components g
   WHERE g.level = 'direct'
   ORDER BY g.codepoint, g.seq_ix
`)
  .all() as { codepoint: number; comp_cp: number | null; comp_name: string; source: string }[];

// 中間祖先：IDS 的**上一層**（例如 盟 = ⿱明皿，而上層是 明 皿；盟 的最短分解卻是 日 月 皿）。
// 沒有這層，使用者在頁面上輸入「明」就找不到「盟」。
const midsOf = new Map<number, string[]>();
for (const r of db
  .query("SELECT codepoint, ch, kind FROM ids_comp ORDER BY codepoint, pos")
  .all() as any[]) {
  if (r.kind !== "char") continue;
  const a = midsOf.get(r.codepoint);
  if (a) a.push(r.ch);
  else midsOf.set(r.codepoint, [r.ch]);
}
console.log(`中間祖先（IDS 上層）：${midsOf.size.toLocaleString()} 字`);

// 保留 KAGE 原名（不化簡成碼位），因此這裡只以碼位做去重，輸出時用字元本身
const map = new Map<number, { chars: string[]; kage: string[]; cps: Set<number>; src: string }>();
for (const r of rows) {
  if (r.comp_cp == null || r.comp_cp < 0x3400) continue;
  let e = map.get(r.codepoint);
  if (!e) {
    e = { chars: [], kage: [], cps: new Set(), src: r.source === "ids" ? "i" : "b" };
    map.set(r.codepoint, e);
  }
  if (e.cps.has(r.comp_cp)) continue;           // 同碼位變體只留第一個（連同它的 KAGE 原名）
  e.cps.add(r.comp_cp);
  e.chars.push(String.fromCodePoint(r.comp_cp));
  e.kage.push(r.comp_name);
}
console.log(`有直接部件的字: ${map.size.toLocaleString()}`);

// ---------------------------------------------------------------- 內嵌資料

const lines: string[] = [];
for (const [cp, e] of map) {
  // 格式：字碼位(36進位) , 部件(以 . 分隔，直接放字元) , 來源
  lines.push(`${cp.toString(36)},${e.chars.join(".")},${e.src},${e.kage.join(".")},${(midsOf.get(cp) ?? []).join(".")}`);
}
const raw = lines.join("\n");
const gz = gzipSync(Buffer.from(raw, "utf8"), { level: 9 });
const b64 = Buffer.from(gz).toString("base64");
console.log(
  `原始 ${(raw.length / 1048576).toFixed(2)} MB → gzip ${(gz.length / 1024).toFixed(0)} KB → base64 ${(b64.length / 1024).toFixed(0)} KB`,
);

// ---------------------------------------------------------------- HTML

const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>部件檢字（離線）</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.6 system-ui,"Segoe UI","Noto Sans CJK TC",sans-serif; }
  header { padding:14px 18px; border-bottom:1px solid #8884; position:sticky; top:0; background:canvas; z-index:5; }
  h1 { font-size:16px; margin:0 0 8px; font-weight:600; }
  #q { width:100%; font-size:20px; padding:10px 12px; border:1px solid #8886; border-radius:8px; background:field; color:fieldtext; }
  #hint { font-size:12px; color:#888; margin-top:6px; }
  main { display:grid; grid-template-columns: 1fr 340px; gap:0; height:calc(100vh - 118px); }
  #list { overflow:auto; padding:12px 18px; }
  #detail { overflow:auto; border-left:1px solid #8884; padding:14px 16px; font-size:14px; }
  .row { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px; padding:4px 0; border-bottom:1px solid #8882; }
  .row b { font-size:30px; font-weight:400; line-height:1.2; }
  .row .cp { font-size:11px; color:#888; font-family:ui-monospace,monospace; }
  .row .ps { font-size:20px; color:#666; }
  .part { cursor:pointer; border-bottom:1px dotted #888; }
  .part:hover { background:#8882; }
  .lbl { font-size:11px; color:#888; text-transform:uppercase; letter-spacing:.05em; }
  .count { color:#888; font-size:13px; margin:4px 0 10px; }
  code { font-family:ui-monospace,monospace; font-size:12px; }
  .tag { font-size:10px; padding:1px 5px; border-radius:4px; background:#8882; color:#666; }
</style>
</head>
<body>
<header>
  <h1>部件檢字（離線單頁）</h1>
  <input id="q" placeholder="輸入部件，如 日月皿 或 日 月 皿 或 U+65E5" autocomplete="off" autofocus>
  <div id="hint">支援直接子部件與終端部件（會自動遞歸展開）· 點選任一部件可再查</div>
</header>
<main>
  <div id="list"></div>
  <div id="detail"><div class="lbl">說明</div>
    <p>左側輸入部件後，列出「含有這些部件」的字。</p>
    <p>比對方式是「<b>子樹包含</b>」：查詢的部件出現在該字展開樹的<b>任一層</b>就算命中。</p>
    <p>所以輸入 <code>日月皿</code> 找得到 <span style="font-size:22px">盟</span>（盟 → 明 皿 → 日 月 皿）；
       輸入 <code>明</code> 也找得到（明 是盟的中間部件）。</p>
    <p>點選結果列中的任一部件，即可查「含有該部件的字」。</p>
  </div>
</main>
<script>
const B64 = "${b64}";

// ---- 解壓（DecompressionStream 為瀏覽器內建，無外部資源）
async function loadData() {
  const bin = Uint8Array.from(atob(B64), c => c.charCodeAt(0));
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([bin]).stream().pipeThrough(ds);
  const text = await new Response(stream).text();
  const parts = new Map();      // 字碼位 -> [部件字元,...]（保留 KAGE 原名）
  const src = new Map();        // 字碼位 -> "b" | "i"
  const kage = new Map();       // 字碼位 -> [KAGE 原名,...]（可看出用了哪個變體，如 u660e-03）
  const mids = new Map();       // 字碼位 -> [中間祖先,...]（IDS 上層，如 盟 的 明 皿）
  for (const line of text.split("\\n")) {
    if (!line) continue;
    const [a, b, s, k, mid] = line.split(",");
    const cp = parseInt(a, 36);
    const list = b ? b.split(".").filter(Boolean) : [];
    if (list.length) {
      parts.set(cp, list);
      src.set(cp, s);
      kage.set(cp, k ? k.split(".") : []);
      mids.set(cp, mid ? mid.split(".").filter(Boolean) : []);
    }
  }
  return { parts, src, kage, mids };
}

let DATA = null;
const memo = new Map();

/**
 * 把一個字展開成「可用於檢索的部件集合」＝
 *   自己的直接部件 ∪ 中間祖先（IDS 上層）∪ 所有後代的展開。
 *
 * 為什麼要含中間祖先：盟 的最短分解是 日 月 皿（明 被攤平掉了），
 * 但使用者輸入「明」時期待找到盟（盟 = ⿱明皿）。用 IDS 的層級把 明 補回來。
 */
function allParts(ch, seen = new Set(), depth = 0) {
  if (memo.has(ch)) return memo.get(ch);
  if (depth > 6 || seen.has(ch)) return new Set([ch]);
  const cp = ch.codePointAt(0);
  const kids = DATA.parts.get(cp);
  const mid = DATA.mids.get(cp) ?? [];
  if ((!kids || kids.length === 0) && mid.length === 0) {
    memo.set(ch, new Set([ch]));
    return new Set([ch]);
  }
  const s2 = new Set(seen); s2.add(ch);
  const out = new Set();
  for (const m of mid) { out.add(m); for (const t of allParts(m, s2, depth + 1)) out.add(t); }
  if (kids) for (const k of kids) { out.add(k); for (const t of allParts(k, s2, depth + 1)) out.add(t); }
  memo.set(ch, out);
  return out;
}

/** 僅終端部件（給需要「只比葉」的場合備用） */
function terminals(ch, seen = new Set(), depth = 0) {
  if (depth > 6 || seen.has(ch)) return new Set([ch]);
  const cp = ch.codePointAt(0);
  const kids = DATA.parts.get(cp);
  if (!kids || kids.length === 0) return new Set([ch]);
  const s2 = new Set(seen); s2.add(ch);
  const out = new Set();
  for (const k of kids) for (const t of terminals(k, s2, depth + 1)) out.add(t);
  return out;
}

/** 解析輸入：中文字元（含 U+XXXX）。回傳部件字元集合。 */
function parseQuery(str) {
  const out = new Set();
  const cleaned = str.replace(/U\\+/gi, " ").trim();
  for (const ch of cleaned) {
    if (/\\s|,|、|\\+|\\//.test(ch)) continue;
    out.add(ch);
  }
  // 只輸入十六進位碼位時也接受
  if (out.size === 0) {
    for (const t of cleaned.split(/[\\s,、+\\/]+/)) {
      if (/^[0-9a-f]{4,6}$/i.test(t)) out.add(String.fromCodePoint(parseInt(t, 16)));
    }
  }
  return out;
}

function glyph(cp) { return String.fromCodePoint(cp); }
function hex(cp) { return "U+" + cp.toString(16).toUpperCase(); }

function render() {
  const q = document.getElementById("q").value;
  const want = parseQuery(q);
  const list = document.getElementById("list");
  if (want.size === 0) { list.innerHTML = '<p class="count">請輸入部件。</p>'; return; }

  const hits = [];
  for (const cp of DATA.parts.keys()) {
    const self = glyph(cp);
    if (want.has(self)) continue;          // 不要把自己列出來
    const t = allParts(self);              // 含中間節點：查「明」也能找到「盟」
    let ok = true;
    for (const w of want) if (!t.has(w)) { ok = false; break; }
    if (ok) hits.push(cp);
  }
  hits.sort((a, b) => a - b);
  const shown = hits.slice(0, 300);
  list.innerHTML =
    '<div class="count">輸入 ' + [...want].join(" ") +
    '　命中 ' + hits.length.toLocaleString() + ' 字' +
    (hits.length > shown.length ? '（僅顯示前 300）' : '') + '</div>' +
    shown.map(cp => {
      const kids = DATA.parts.get(cp) || [];
      const kn = DATA.kage.get(cp) || [];
      const tag = DATA.src.get(cp) === "i" ? '<span class="tag">IDS 補</span>' : "";
      return '<div class="row"><b>' + glyph(cp) + '</b>' +
        '<span class="cp">' + hex(cp) + '</span> ' + tag +
        '<span class="ps">' + kids.map((k, i) =>
          '<span class="part" data-ch="' + k + '" title="' + (kn[i] || "") + '">' + k +
          (kn[i] && !/^u[0-9a-f]+$/i.test(kn[i])
            ? '<span class="cp">' + kn[i] + '</span>' : '') + '</span>').join(" ") +
        '</span></div>';
    }).join("");
  list.querySelectorAll(".part").forEach(el => {
    el.onclick = () => { document.getElementById("q").value = el.dataset.ch; render(); };
  });
}

document.getElementById("q").addEventListener("input", render);
loadData().then(d => {
  DATA = d;
  document.getElementById("hint").textContent += "　已載入 " + d.parts.size.toLocaleString() + " 字";
  render();
});
</script>
</body>
</html>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html, "utf8");
const size = Buffer.byteLength(html, "utf8");
console.log(`輸出: ${OUT}  ${(size / 1024).toFixed(0)} KB`);
db.close();
