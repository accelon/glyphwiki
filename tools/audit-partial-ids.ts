#!/usr/bin/env bun
/**
 * audit-partial-ids.ts — 稽核**部分 IDS** 的槽位推斷（用眼睛看，不只看數字）。
 *
 * 「部分 IDS」＝字庫的 IDS 區段只存得到有碼位的構件（`麥` 的真 IDS 是
 * `⿱來&GT-K00207;`，只留下 `[來]`）。引擎會把「多出來的筆畫」當成那個沒有碼位的構件，
 * 只推有碼位那個構件的槽位——所以**推錯的話會拔掉錯的筆畫**，光看誤差數字不夠。
 * 這一支把每個案例畫成三格：
 *
 *   [原字] [推出來的那組筆畫（紅色折線）疊在淡掉的原字上] [把該構件換成「支」的結果]
 *
 * 用法: bun run tools/audit-partial-ids.ts        → out/partial-audit.html
 *       （再看 out/partial-audit.png；截圖指令見 `pinxing.md` 的驗收章節）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const D = "D:/2023/glyphwiki";
const html = readFileSync(resolve(D, "out/pinxing.html"), "utf8");
const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
const engineSrc = script.slice(0, script.indexOf("/* ============ 解碼 + 量測"));
const head = script.slice(0, script.indexOf("/* ============================ 字庫與索引"));
const b64 = /var LIB_B64 = "([^"]*)"/.exec(script)![1]!;
(0, eval)(engineSrc);
const api = new Function(head + `
return { decodeLibrary, indexOfCodePoint, codePointOf, displayName, charOf, flattenStrokes,
  drawingIdx, solveIdsSlots, svgOf, evalSeq, normalizeSvg, ptCountOf, isPlainIdeograph };`)();
const lib = api.decodeLibrary(new Uint8Array(Bun.gunzipSync(Buffer.from(b64, "base64"))));
const idxOf = (ch: string) => api.indexOfCodePoint(lib, ch.codePointAt(0)!);

type Row = { base: string; comp: string; node: number; nodeCh: string; err: number; group: number[]; n: number; contig: boolean; altErr: number; src: string };

/** 找出一個字（含它的引用樹）裡所有「部分 IDS」推出來的槽位 */
function rowsOf(base: string): Row[] {
  const out: Row[] = [];
  const seen = new Set<number>();
  const stack = [idxOf(base)];
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const g = lib.glyphs[i];
    if (!g) continue;
    const sol = api.solveIdsSlots(lib, i);
    if (sol && sol.partial) {
      for (const s of sol.slots) {
        if (s.index === undefined) continue;
        const ch = api.charOf(lib, s.index);
        if (!ch) continue;
        const sorted = s.group.slice().sort((a: number, b: number) => a - b);
        out.push({ base, comp: ch, node: i, nodeCh: api.charOf(lib, api.drawingIdx(lib, i)) || "?", err: sol.error,
          group: s.group, n: s.group.length, contig: sorted.every((v, k) => k === 0 || v === sorted[k - 1] + 1),
          altErr: NaN, src: "tree" });
      }
    }
    for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  return out;
}

/* ---- 選案例 ---- */
const cases: Row[] = [];
for (const b of ["䴺", "麥", "合", "報", "進", "寶", "從", "電", "颰", "峰"]) cases.push(...rowsOf(b));

/* 全庫掃一遍，取誤差最大的幾個（最可疑的）＋ 均勻抽樣。
   **只取「打得出來的那個字形」**（`indexOfCodePoint` 回傳的那個）——同一家族的其他成員
   打不出來，算了也沒用（第一版沒濾，畫面上兩列「失敗」就是這樣來的）。 */
const all: { ch: string; row: Row }[] = [];
let nonCanon = 0;
for (let i = 0; i < lib.glyphs.length; i++) {
  const cp = api.codePointOf(lib, i);
  if (!cp) continue;
  if (api.indexOfCodePoint(lib, cp) !== i) { nonCanon++; continue; }
  const sol = api.solveIdsSlots(lib, i);
  if (!sol || !sol.partial) continue;
  const ch = api.charOf(lib, sol.drawing);
  if (!ch) continue;
  for (const s of sol.slots) {
    if (s.index === undefined) continue;
    const comp = api.charOf(lib, s.index);
    if (!comp) continue;
    const sorted = s.group.slice().sort((a: number, b: number) => a - b);
    all.push({ ch, row: { base: ch, comp, node: i, nodeCh: ch, err: sol.error, group: s.group, n: s.group.length,
      contig: sorted.every((v, k: number) => k === 0 || v === sorted[k - 1] + 1), altErr: NaN, src: "all" } });
  }
}
all.sort((a, b) => b.row.err - a.row.err);
const worst = all.slice(0, 12).map((x) => x.row);
const mid = all.filter((x) => x.row.err < 10).filter((_, k) => k % Math.max(1, Math.floor(all.length / 12)) === 0).slice(0, 12).map((x) => x.row);

const pick: Row[] = [];
const seenKey = new Set<string>();
/* 預設只畫「邊緣案例」＋題目裡的那幾個：
   - 誤差 > 20 的（放寬門檻才收進來的最可疑）
   - 手動指定的（䴺／麥／合／報／進／寶…）
   註：`worst`／`mid` 是給 console 統計用的，畫面上不必全列（一頁看得到才好判）。 */
const edgeOnly = (all.filter((x) => x.row.err > 20).map((x) => x.row)).slice(0, 14);
for (const r of [...cases.filter((c) => c.err > 5), ...edgeOnly]) {
  const k = r.base + r.comp + r.group.join(",");
  if (seenKey.has(k)) continue;
  seenKey.add(k);
  pick.push(r);
}
/* AUDIT_ALL=1：連誤差小的也畫（一頁很長，要分段截圖） */
if (process.env.AUDIT_ALL === "1") {
  for (const r of [...worst, ...mid]) {
    const k = r.base + r.comp + r.group.join(",");
    if (seenKey.has(k)) continue;
    seenKey.add(k);
    pick.push(r);
  }
}

/* ---- 畫 ---- */
function strokesSvg(flat: any[], color: string, width: number, opacity = 1): string {
  let s = "";
  for (const st of flat) {
    const pts: string[] = [];
    for (let k = 0; k < st.pts.length / 2; k++) pts.push(st.pts[k * 2].toFixed(1) + "," + st.pts[k * 2 + 1].toFixed(1));
    /* KAGE 的曲線控制點不是折線端點，但輪廓用折線看已經足夠判斷「挑到哪幾筆」 */
    s += `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="${width}" stroke-opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return s;
}
function cell(svg: string, w = 150): string {
  return `<div class="c"><svg viewBox="0 0 200 200" width="${w}" height="${w}">${svg}</svg></div>`;
}
let body = "";
let shown = 0, failed = 0;
for (const r of pick) {
  let before = "";
  try { before = api.normalizeSvg(api.svgOf(lib, r.node)).replace(/fill="black"/g, 'fill="#eee"').replace(/<svg\b/, '<svg viewBox="0 0 200 200"'); } catch { before = ""; }
  const flat = api.flattenStrokes(lib, api.drawingIdx(lib, r.node));
  const hi = r.group.map((i: number) => flat[i]).filter(Boolean);
  let after = "", log = "";
  try {
    const res = api.evalSeq(lib, r.base + r.comp + "支");
    if (res.ok) { after = api.normalizeSvg(api.svgOf(res.lib, res.targetIdx)).replace(/fill="black"/g, 'fill="#eee"').replace(/<svg\b/, '<svg viewBox="0 0 200 200"'); log = (res.log || []).join("；"); }
    else { failed++; log = "替換失敗：" + res.error; }
  } catch (e) { failed++; log = "EXC " + (e as Error).message; }
  const inner1 = before.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  const inner3 = after ? after.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "") : '<text x="100" y="100" fill="#f88" font-size="18" text-anchor="middle">失敗</text>';
  body += `<div class="row">
    ${cell(inner1)}
    ${cell(`<g opacity="0.22">${inner1}</g>${strokesSvg(hi, "#ff5a5a", 7, 0.95)}`)}
    ${cell(inner3)}
    <div class="t"><b>${r.base}</b> 的 <b>${r.comp}</b> → 支<br>節點 ${r.nodeCh}　誤差 ${r.err.toFixed(1)}　組 ${r.n} 筆${r.contig ? "（連續）" : "（<span style='color:#f88'>不連續</span>）"}<br><span class="g">${log.slice(0, 90)}</span></div>
  </div>`;
  shown++;
}
const out = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{background:#111;color:#ddd;font:13px/1.5 system-ui,"Microsoft JhengHei";margin:10px}
.row{display:flex;align-items:center;gap:10px;border-bottom:1px solid #333;padding:6px 0}
.c{border:1px dashed #444;border-radius:4px}
.t{width:330px}
.g{color:#8b93a0} b{color:#fff}
h1{font-size:16px}
</style></head><body>
<h1>部分 IDS 稽核（共 ${shown} 列）：左＝原字、中＝推出來的那組筆畫（紅）、右＝把該構件換成「支」</h1>
${body}
</body></html>`;
writeFileSync(resolve(D, "out/partial-audit.html"), out);

console.log(`列出 ${shown} 列（失敗 ${failed}） → out/partial-audit.html`);
console.log(`全庫 partial 解出的槽位數：${all.length}（不同字 ${new Set(all.map((x) => x.ch)).size}；非正規字形略過 ${nonCanon}）`);
/* 使用者要的那一條 */
for (const q of ["䴺來去", "麥來支", "合口支", "報又支", "進隹支", "寶𡪓支", "奚大支"]) {
  const r = api.evalSeq(lib, q);
  console.log(`  ${q}: ${r.ok ? "成功 → " + (r.log || []).join("；") : "失敗：" + r.error}`);
}
console.log(`誤差最大的 12 個：` + worst.map((r) => `${r.base}/${r.comp}=${r.err.toFixed(1)}${r.contig ? "" : "(不連續)"}`).join(" "));
console.log(`連續比例：${all.filter((x) => x.row.contig).length}/${all.length}`);
const byErr = all.map((x) => x.row.err).sort((a, b) => a - b);
const q = (p: number) => byErr[Math.floor(byErr.length * p)]?.toFixed(1);
console.log(`誤差 中位 ${q(0.5)} / 90% ${q(0.9)} / 最大 ${byErr[byErr.length - 1]?.toFixed(1)}`);
console.log(`分組筆數分佈：` + Object.entries(all.reduce((m: any, x) => { m[x.row.n] = (m[x.row.n] || 0) + 1; return m; }, {})).map(([k, v]) => `${k}筆:${v}`).join(" "));
