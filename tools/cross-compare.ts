#!/usr/bin/env bun
/**
 * 交錯對照表：**目標第一句**「筆劃不能大面積交錯」的量化證明。
 *
 * 為什麼要這一支：徒兒到第 142 輪為止只量過「像不像真字」，
 * **從來沒量過交錯**——而那是目標的**第一句**。師父看 `out/zcjb.png` 時
 * 一眼指出「古法那格的辶跟底下疊在一起」，徒兒把它變成數字。
 *
 * ## 交錯怎麼量（可數、可重現）
 *
 * 一個字形的每個**引用部件**都有一個 KAGE 引用框（`stroke.box`，幾何事實）。
 * 兩個部件的框相交面積 ÷ 較小框面積 ＝ 這一對的重疊率；
 * 把所有配對中超過 5% 的**加總** ＝ **交錯分數**（越大越交錯）。
 *
 * ⚠ 已知限制：換上去的字若是**單一引用包裝**（例如 `明`），
 *   它的兩個子部件框會**完全互相覆蓋** → 分數偏高（1.00）。
 *   所以這是一個**篩子**，不是唯一目標。
 *
 * 用法: bun run tools/cross-compare.ts [--png out/cross.png]
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { loadLibrary } from "../tools/lib-load.ts";
import { evalSeq } from "../tools/free-compose.ts";
import { ensureEngine, svgOf } from "../tools/compose-fit.ts";
import { idsGlyph, idsText } from "../tools/ids-glyph.ts";
import { searchSeqForIds } from "../tools/seq-search.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();

/** 交錯分數 ✓（越小越好 ✓）。 */
function crossScore(L: any, gi: number): { score: number; pairs: number; worst: number } {
  const g = L.glyphs[gi]!;
  const boxes: number[][] = [];
  for (const s of g.strokes) if (s.kind === 99 && s.ref !== null && s.box) boxes.push(s.box as number[]);
  let score = 0, pairs = 0, worst = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const A = boxes[i]!, B = boxes[j]!;
    const w = Math.min(A[2]!, B[2]!) - Math.max(A[0]!, B[0]!);
    const h = Math.min(A[3]!, B[3]!) - Math.max(A[1]!, B[1]!);
    if (w <= 0 || h <= 0) continue;
    const aA = (A[2]! - A[0]!) * (A[3]! - A[1]!), aB = (B[2]! - B[0]!) * (B[3]! - B[1]!);
    const ratio = (w * h) / Math.max(1, Math.min(aA, aB));
    if (ratio > 0.05) { score += ratio; pairs++; if (ratio > worst) worst = ratio; }
  }
  return { score: score, pairs: pairs, worst: worst };
}

/** 五個案例（IDS 一律從 `glyph-by-ids.md` 讀 ✓，不手打 ✓）。 */
const opSet = "\u2FF0\u2FF1\u2FF2\u2FF3\u2FF4\u2FF5\u2FF6\u2FF7\u2FF8\u2FF9\u2FFA\u2FFB";
const re = /[\u2FF0-\u2FFB][\u2FF0-\u2FFB\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2FFFF}]+/u;
const seen = new Set<string>();
const cases: string[] = [];
for (const line of readFileSync(resolve(ROOT, "glyph-by-ids.md"), "utf8").split(/\r?\n/)) {
  const m = re.exec(line);
  if (!m) continue;
  const s = m[0];
  if (seen.has(s)) continue;
  seen.add(s);
  if (Array.from(s).filter((c) => !opSet.includes(c)).length >= 2) cases.push(s);
  if (cases.length >= 5) break;
}

interface Row { ids: string; seq: string; a: ReturnType<typeof crossScore> | null; c: ReturnType<typeof crossScore> | null; aSvg: string; cSvg: string }
const rows: Row[] = [];
for (const IDS of cases) {
  const g = idsGlyph(IDS, lib);
  const r = searchSeqForIds(lib, IDS, { judgeMax: 400 });
  const seq = r.ok && r.candidates.length ? r.candidates[0]!.seq : "";
  const q = seq ? evalSeq(lib, seq, {}) : null;
  rows.push({
    ids: IDS, seq: seq,
    a: g.ok ? crossScore(g.lib, g.idx) : null,
    c: q && q.ok ? crossScore(q.lib, q.targetIdx) : null,
    aSvg: g.ok ? svgOf(g.lib, g.idx) : "",
    cSvg: q && q.ok ? svgOf(q.lib, q.targetIdx) : "",
  });
}

console.log("=== 交錯分數（引用框兩兩重疊總和；越小越好）===");
for (const r of rows) {
  const f = (x: Row["a"]) => x ? x.score.toFixed(2) + "（" + x.pairs + " 對、最大 " + x.worst.toFixed(2) + "）" : "—";
  console.log(r.ids.padEnd(22) + " 古法 " + f(r.a).padEnd(26) + " 今法 " + f(r.c));
}

/* 出圖 */
const cell = (t: string, sub: string, svg: string, bad: boolean) =>
  '<div class="c' + (bad ? " bad" : "") + '"><div class="g">' + svg + '</div><div class="t">' + t + '</div><div class="s">' + sub + "</div></div>";
const body = rows.map((r) => {
  const f = (x: Row["a"]) => x ? x.score.toFixed(2) + "（" + x.pairs + " 對）" : "—";
  return '<div class="case"><div class="ids">' + r.ids + "　<small>" + idsText(r.ids) + "</small></div>" +
    '<div class="row">' +
    cell("A 古法", "交錯 " + f(r.a), r.aSvg, (r.a?.score ?? 0) > 1) +
    cell("B 今法", "交錯 " + f(r.c) + (r.seq ? "<br>" + r.seq : ""), r.cSvg, (r.c?.score ?? 0) > 1) +
    "</div></div>";
}).join("");
const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
  'body{margin:0;background:#0b0c0e;color:#e8ecf4;font:13px system-ui,"Microsoft JhengHei",sans-serif}' +
  'h1{font-size:17px;padding:12px 14px 2px;margin:0}h1 small{font-size:12px;color:#8a93a3;font-weight:400}' +
  '.case{border-bottom:1px solid #23262c;padding:2px 0 6px}.ids{font-size:15px;padding:6px 14px 2px;color:#8fd}' +
  '.ids small{font-size:11px;color:#8a93a3}.row{display:flex;gap:10px;padding:2px 12px}' +
  '.c{background:#15171b;border:1px solid #2a2e35;border-radius:9px;padding:7px;text-align:center;width:160px}' +
  '.c.bad{border-color:#7a3b3b}.g{width:146px;height:146px}.g svg{width:100%;height:100%;display:block;color:#e8ecf4}' +
  '.t{font-weight:600;margin-top:4px;font-size:12px}.s{color:#8a93a3;font-size:11px;min-height:26px;word-break:break-all}' +
  '</style></head><body><h1>交錯對照　<small>目標第一句：「筆劃不能大面積交錯」——引用框兩兩重疊的總和</small></h1>' +
  body + "</body></html>";
const page = resolve(ROOT, "out/_cross.html");
writeFileSync(page, html, "utf8");
const shot = resolve(ROOT, arg("--png", "out/cross.png")!);
if (existsSync(shot)) unlinkSync(shot);
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
Bun.spawnSync([EDGE, "--headless", "--disable-gpu", "--screenshot=" + shot, "--window-size=400,1300",
  "--hide-scrollbars", "--virtual-time-budget=9000", "file:///" + page.replace(/\\/g, "/")],
  { stdout: "ignore", stderr: "ignore" });
console.log(existsSync(shot) ? "圖：" + shot : "截圖失敗 ✗");
