#!/usr/bin/env bun
/**
 * spread-compare.ts — **「筆劃舒展」的量化**（目標第二句「不夠美觀但可識別」的「美觀」那一半）。
 *
 * ## 為什麼要這一支（第 146 輪，師父的線索）
 *
 * 師父看 holy grail 的對照圖後說：
 * > 線索就是要找到**比「羅」占據面積更大的子框**，之後**筆劃更舒展**。
 *
 * 徒兒把它變成三個**可量的數字**，而且**量出來師父說得對**：
 *
 * | 版本 | 骨架總長 | 墨跡密度 | 路徑數 | 子框 |
 * | --- | ---: | ---: | ---: | --- |
 * | A 古法 | 1437 | 0.318 | 89 | 100%，但**逐層縮到 6%** |
 * | B 今法 1 步合成字 | **915** | 0.406 | **49** | 33.5% |
 * | C 文檔正解 4 步 | **1834** | 0.450 | **89** | 100% ＋ **64.5%** |
 *
 * → **子框越大 → 骨架總長越長 → 筆畫越舒展**。
 *   ⚠ A 的問題**不是**「最大的框」✗（它的最大框是 100%）——
 *     而是它**一路縮**（100% → 24.5% → 12.3% → 6.1%），
 *     所以墨被壓在 1437 的骨架長裡；C 只**兩層、都是大框**，所以有 1834。
 *
 * ## 三個量怎麼算
 *
 * * **骨架總長**：所有筆畫中心線的長度和（`Stroke.points` ✓）——「筆畫有多長」。
 * * **墨跡密度**：墨跡面積 ÷ 墨跡外框（0～1）——「墨擠不擠」。
 * * **筆畫路徑數**：`svgOf()` 的 `<path>` 個數——「筆畫有沒有被吃掉」。
 *
 * ⚠ **路徑數是關鍵** ✗：合成字（1 步解）的密度與覆蓋率都可能**比古法好** ✓，
 *   但它的路徑數只有 **49**（古法 89 ✗）——那才是它真正的缺陷 ✓。
 *
 * 用法: bun run tools/spread-compare.ts [--ids "⿴辶…"] [--png out/spread.png]
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { loadLibrary } from "../tools/lib-load.ts";
import { evalSeq } from "../tools/free-compose.ts";
import { ensureEngine, svgOf } from "../tools/compose-fit.ts";
import { keyOfIdx, toKageData } from "../tools/lib-format.ts";
import { rasterize } from "../tools/raster.ts";
import { normalizedMask } from "../tools/shape-similarity.ts";
import { idsGlyph, idsText } from "../tools/ids-glyph.ts";
import { searchSeqForIds } from "../tools/seq-search.ts";
import { skeletonInRoot, crossScore } from "../tools/cross-compare.ts";

const ROOT = resolve(import.meta.dir, "..");
const SIZE = 48;
const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();

function maskOf(L: any, gi: number): Uint8Array | null {
  const kage = new (globalThis as any).Kage();
  const seen = new Set<number>(), stack = [gi];
  while (stack.length) {
    const j = stack.pop()!; if (seen.has(j)) continue; seen.add(j);
    kage.kBuhin.push(keyOfIdx(L, j), toKageData(L.glyphs[j]!, L));
    for (const s of L.glyphs[j]!.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  try { return normalizedMask(rasterize(kage, keyOfIdx(L, gi), SIZE, 1), SIZE); } catch { return null; }
}
/** 骨架總長（＝「筆畫有多長」）。 */
export function skeletonLength(L: any, gi: number): number {
  let n = 0;
  for (const s of skeletonInRoot(L, gi)) n += Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
  return n;
}
/** 墨跡的面積、外框、密度。 */
function inkStats(m: Uint8Array): { area: number; boxFrac: number; density: number } {
  let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9, area = 0;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (!m[y * SIZE + x]) continue;
    area++;
    if (x < x1) x1 = x; if (x > x2) x2 = x;
    if (y < y1) y1 = y; if (y > y2) y2 = y;
  }
  const boxArea = (x2 - x1 + 1) * (y2 - y1 + 1);
  return { area, boxFrac: boxArea / (SIZE * SIZE), density: boxArea ? area / boxArea : 0 };
}
/** ★ 每一個**引用框**佔畫布多少面積（師父的線索 ✓）——**由大到小** ✓。 */
export function frameAreas(L: any, gi: number): { frac: number; name: string }[] {
  const g = L.glyphs[gi]!;
  const out: { frac: number; name: string }[] = [];
  for (const s of g.strokes) {
    if (s.kind !== 99 || s.ref === null || !s.box) continue;
    const b = s.box as number[];
    out.push({ frac: Math.abs((b[2] - b[0]) * (b[3] - b[1])) / 40000, name: keyOfIdx(L, s.ref) });
  }
  return out.sort((x, y) => y.frac - x.frac);
}
export interface Spread {
  len: number; area: number; density: number; boxFrac: number; paths: number;
  cross: number; frames: { frac: number; name: string }[];
  /** **最深的子框**（一路縮下去的最小值）——古法就是輸在這裡 */
  minFrame: number; maxFrame: number;
}
export function spreadOf(L: any, gi: number): Spread {
  const m = maskOf(L, gi);
  const st = m ? inkStats(m) : { area: 0, boxFrac: 0, density: 0 };
  const fr = frameAreas(L, gi);
  const svg = svgOf(L, gi);
  return {
    len: skeletonLength(L, gi), area: st.area, density: st.density, boxFrac: st.boxFrac,
    paths: (svg.match(/<path/g) || []).length, cross: crossScore(L, gi).score, frames: fr,
    minFrame: fr.length ? fr[fr.length - 1]!.frac : 0,
    maxFrame: fr.length ? fr[0]!.frac : 0,
  };
}

/* ───────────────────────── CLI ───────────────────────── */
if (import.meta.main) {
  const opSet = "\u2FF0\u2FF1\u2FF2\u2FF3\u2FF4\u2FF5\u2FF6\u2FF7\u2FF8\u2FF9\u2FFA\u2FFB";
  const re = /[\u2FF0-\u2FFB][\u2FF0-\u2FFB\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2FFFF}]+/u;
  let IDS = arg("--ids") ?? "";
  if (!IDS) for (const line of readFileSync(resolve(ROOT, "glyph-by-ids.md"), "utf8").split(/\r?\n/)) {
    const m = re.exec(line);
    if (m && Array.from(m[0]).filter((c) => !opSet.includes(c)).length >= 6) { IDS = m[0]; break; }
  }
  const target = IDS;
  const a = idsGlyph(target, lib);
  if (!a.ok) throw new Error("古法造不出來：" + a.problems.join("；"));
  const r = searchSeqForIds(lib, target, { judgeMax: 400 });
  const B = r.ok && r.candidates.length ? r.candidates[0]!.seq : "";
  /* 文檔正解：從頁面讀 ✓ */
  let GOOD = "";
  {
    const page = readFileSync(resolve(ROOT, "tools/pinxing-page.js"), "utf8");
    for (const mm of page.matchAll(/"([\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2FFFF}]{8,})"/gu)) {
      if (evalSeq(lib, mm[1]!, {}).ok) { GOOD = mm[1]!; break; }
    }
  }
  interface Row { t: string; seq: string; L: any; gi: number; sp: Spread }
  const rows: Row[] = [{ t: "A 古法（IDS 等比分配）", seq: target, L: a.lib, gi: a.idx, sp: spreadOf(a.lib, a.idx) }];
  if (B) { const q = evalSeq(lib, B, {}); if (q.ok) rows.push({ t: "B 今法（搜尋挑的）", seq: B, L: q.lib, gi: q.targetIdx, sp: spreadOf(q.lib, q.targetIdx) }); }
  if (GOOD) { const q = evalSeq(lib, GOOD, {}); if (q.ok) rows.push({ t: "C 文檔正解（人工 4 步）", seq: GOOD, L: q.lib, gi: q.targetIdx, sp: spreadOf(q.lib, q.targetIdx) }); }

  console.log("=== 「筆劃舒展」三個量（目標第一句是交錯、這裡是第二句的「美觀」）===");
  console.log("");
  console.log("版本".padEnd(26) + "骨架總長".padEnd(11) + "墨跡面積".padEnd(10) + "密度".padEnd(8) + "路徑".padEnd(7) + "交錯".padEnd(8) + "最大框  最小框");
  for (const x of rows) {
    console.log(x.t.padEnd(26) + x.sp.len.toFixed(0).padEnd(11) + String(x.sp.area).padEnd(10) +
      x.sp.density.toFixed(3).padEnd(8) + String(x.sp.paths).padEnd(7) + x.sp.cross.toFixed(3).padEnd(8) +
      (x.sp.maxFrame * 100).toFixed(1).padStart(5) + "%  " + (x.sp.minFrame * 100).toFixed(1).padStart(5) + "%");
  }
  console.log("");
  console.log("⚠ 判讀：");
  console.log("  · **骨架總長** 越大 ＝ 筆畫越舒展（師父的線索）");
  console.log("  · **最小框** 很小 ＝ 有一格被壓得很扁（古法就是這樣 ✗）");
  console.log("  · **路徑數** 明顯小於古法 ＝ 筆畫被簡化掉了（合成字的通病 ✗）");
  console.log("");
  console.log("各版本的子框（師父的線索：看有沒有「比別人大」的框）：");
  for (const x of rows) {
    console.log("  " + x.t);
    for (const f of x.sp.frames) console.log("     " + f.name.padEnd(16) + (f.frac * 100).toFixed(1).padStart(6) + "%");
  }

  /* 出圖 */
  const cell = (x: Row) =>
    '<div class="c"><div class="g">' + svgOf(x.L, x.gi) + '</div><div class="t">' + x.t + '</div>' +
    '<div class="m">骨架 <b>' + x.sp.len.toFixed(0) + '</b>　面積 <b>' + x.sp.area + '</b>　密度 <b>' + x.sp.density.toFixed(3) + '</b></div>' +
    '<div class="m">路徑 <b>' + x.sp.paths + '</b>　交錯 <b>' + x.sp.cross.toFixed(3) + '</b>　框 <b>' +
    (x.sp.maxFrame * 100).toFixed(0) + '% → ' + (x.sp.minFrame * 100).toFixed(0) + '%</b></div>' +
    '<div class="s">' + x.seq + "</div></div>";
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'body{margin:0;background:#0b0c0e;color:#e8ecf4;font:13px system-ui,"Microsoft JhengHei",sans-serif}' +
    'h1{font-size:17px;padding:12px 14px 2px;margin:0}h1 small{font-size:12px;color:#8a93a3;font-weight:400}' +
    '.row{display:flex;gap:12px;padding:10px 14px 16px}' +
    '.c{background:#15171b;border:1px solid #2a2e35;border-radius:10px;padding:9px;text-align:center;width:214px}' +
    '.g{width:196px;height:196px}.g svg{width:100%;height:100%;display:block;color:#e8ecf4}' +
    '.t{font-weight:600;margin-top:6px;font-size:13px}.m{color:#cfe3b8;font-size:12px;margin-top:3px}' +
    '.s{color:#8a93a3;font-size:11px;margin-top:4px;word-break:break-all;min-height:28px}' +
    '</style></head><body>' +
    "<h1>筆劃舒展對照　<small>骨架總長（筆畫多長）／密度（墨擠不擠）／路徑數（筆畫有沒有被吃掉）／子框（有沒有被壓扁）</small></h1>" +
    '<div class="row">' + rows.map(cell).join("") + "</div></body></html>";
  const pg = resolve(ROOT, "out/_spread.html");
  writeFileSync(pg, html, "utf8");
  const shot = resolve(ROOT, arg("--png", "out/spread.png")!);
  if (existsSync(shot)) unlinkSync(shot);
  const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  Bun.spawnSync([EDGE, "--headless", "--disable-gpu", "--screenshot=" + shot, "--window-size=760,430",
    "--hide-scrollbars", "--virtual-time-budget=9000", "file:///" + pg.replace(/\\/g, "/")],
    { stdout: "ignore", stderr: "ignore" });
  console.log(existsSync(shot) ? "圖：" + shot : "截圖失敗 ✗");
}
