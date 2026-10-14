#!/usr/bin/env bun
/**
 * cross-compare.ts — 目標第一句「**筆劃不能大面積交錯**」的量化。
 *
 * ## 方法（第 144 輪換成**骨架** ✓，師父提議的 ✓）
 *
 * **骨架**＝KAGE 的 `Stroke.points` ✓（`kind` 0＝曲線、1＝折線 ✓）——
 * 那是引擎**畫筆寬之前**的中心線 ✓，也就是「筆畫本身」✓。
 *
 * ⚠ 為什麼不用**引用框**（徒兒第 143 輪的做法 ✗）：
 *   引用框是**矩形** ✗，兩個框重疊**不代表裡面的筆畫真的碰到** ✗。
 *   實測就有 **假陽性 0.87** ✗（`明` 的兩個子部件框完全覆蓋 ✗，但筆畫沒有交錯 ✓）。
 *
 * ✅ 骨架好在**每一段都知道自己屬於哪一個引用** ✓（`ref` ✓），所以：
 *   * **同一引用內**的段相交 → **不算**交錯 ✓（那本來就是同一個部件 ✓）
 *   * **不同引用**的段相交 → **算**交錯 ✓（這才是「部件互相穿插」✓）
 * 分數 ＝ 相交的段對 ÷ 不同引用的段對總數 ✓（歸一化 ✓，可以跨字比較 ✓）。
 *
 * ⚠ 已知性質 ✗：線段**真的相交**是罕見事件 ✓，所以這個分數天生就小 ✓
 *   （實測 0.000～0.19 ✓）。它適合**比大小** ✓，不適合當「絕對好壞」✗。
 *   ⚠ 它**不能取代**墨跡 IoU ✓——骨架沒有筆寬 ✗（實測墨跡面積只有 polygon 的
 *   **38%～109%** ✗），所以「像不像」還是要用 `ids-improve.ts` 的墨跡 IoU ✓。
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

/** 一段骨架 ✓（座標已在**根座標系** ✓）。 */
interface Seg { a: [number, number]; b: [number, number]; ref: number }

/** 把子座標經父層的 `box` 映到父座標 ✓（＝引擎的等比縮放後置中 ✓）。 */
function project(inner: number[] | null, raw: number[], x: number, y: number): [number, number] {
  if (!inner || !raw) return [x, y];
  const cw = inner[2] - inner[0], ch = inner[3] - inner[1];
  const bw = raw[2] - raw[0], bh = raw[3] - raw[1];
  const k = (cw > 0 && ch > 0) ? Math.min(bw / cw, bh / ch) : 1;
  const w = cw * k, h = ch * k;
  const ox = raw[0] + (bw - w) / 2, oy = raw[1] + (bh - h) / 2;
  return [ox + (x - inner[0]) * k, oy + (y - inner[1]) * k];
}

/** 收一個字形的骨架 ✓（座標投影回根 ✓，`ref` 記**最上層**引用 ✓）。 */
export function skeletonInRoot(L: any, gi: number): Seg[] {
  const out: Seg[] = [];
  const tight = new Map<number, number[] | null>();
  const tightOf = (j: number): number[] | null => {
    if (tight.has(j)) return tight.get(j)!;
    const g = L.glyphs[j];
    if (!g) { tight.set(j, null); return null; }
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const s of g.strokes) {
      if (s.kind === 99 && s.ref !== null) {
        const p = project(tightOf(s.ref), s.box as number[], 0, 0);
        const inner = tightOf(s.ref);
        if (!inner) continue;
        const q = project(inner, s.box as number[], inner[0], inner[1]);
        const q2 = project(inner, s.box as number[], inner[2], inner[3]);
        void p;
        x1 = Math.min(x1, q[0]); y1 = Math.min(y1, q[1]);
        x2 = Math.max(x2, q2[0]); y2 = Math.max(y2, q2[1]);
      } else if (s.kind !== 0) {
        for (let i = 0; i + 1 < s.points.length; i += 2) {
          const x = s.points[i]!, y = s.points[i + 1]!;
          if (!x && !y) continue;
          x1 = Math.min(x1, x); y1 = Math.min(y1, y);
          x2 = Math.max(x2, x); y2 = Math.max(y2, y);
        }
      }
    }
    const r = x1 > x2 ? null : [x1, y1, x2, y2];
    tight.set(j, r);
    return r;
  };
  const walk = (j: number, tx: (x: number, y: number) => [number, number], owner: number, depth: number) => {
    if (depth > 20) return;
    const g = L.glyphs[j]; if (!g) return;
    for (const s of g.strokes) {
      if (s.kind === 99) {
        if (s.ref === null || !s.box) continue;
        if (!L.glyphs[s.ref]) continue;
        const inner = tightOf(s.ref);
        const ntx = (x: number, y: number): [number, number] => {
          const g2 = project(inner, s.box as number[], x, y);
          return tx(g2[0], g2[1]);
        };
        walk(s.ref, ntx, owner === -1 ? s.ref : owner, depth + 1);
        continue;
      }
      if (s.kind === 0 || !s.points || s.points.length < 4) continue;
      const pts: [number, number][] = [];
      for (let i = 0; i + 1 < s.points.length; i += 2) {
        const x = s.points[i]!, y = s.points[i + 1]!;
        if (!x && !y) continue;
        pts.push(tx(x, y));
      }
      for (let k = 0; k + 1 < pts.length; k++) out.push({ a: pts[k]!, b: pts[k + 1]!, ref: owner === -1 ? gi : owner });
    }
  };
  walk(gi, (x, y) => [x, y], -1, 0);
  return out;
}

/** 兩線段是否相交 ✓。 */
function segCross(p: [number, number], p2: [number, number], q: [number, number], q2: [number, number]): boolean {
  const d1x = p2[0] - p[0], d1y = p2[1] - p[1];
  const d2x = q2[0] - q[0], d2y = q2[1] - q[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return false;
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const t = (dx * d2y - dy * d2x) / den;
  const u = (dx * d1y - dy * d1x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

export interface CrossResult { score: number; hits: number; pairs: number; segs: number }

/** ★ 交錯分數 ✓（骨架版 ✓）：**只算不同引用**的段相交 ✓，除以段對總數 ✓。 */
export function crossScore(L: any, gi: number): CrossResult {
  const segs = skeletonInRoot(L, gi);
  let hits = 0, pairs = 0;
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    if (segs[i]!.ref === segs[j]!.ref) continue;
    pairs++;
    if (segCross(segs[i]!.a, segs[i]!.b, segs[j]!.a, segs[j]!.b)) hits++;
  }
  return { score: pairs ? hits / pairs : 0, hits: hits, pairs: pairs, segs: segs.length };
}

/* ───────────────────────── CLI：五個案例的對照表 ＋ 圖 ───────────────────────── */
if (import.meta.main) {
  const opSet = "\u2FF0\u2FF1\u2FF2\u2FF3\u2FF4\u2FF5\u2FF6\u2FF7\u2FF8\u2FF9\u2FFA\u2FFB";
  const re = /[\u2FF0-\u2FFB][\u2FF0-\u2FFB\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2FFFF}]+/u;
  const seen = new Set<string>();
  const cases: string[] = [];
  for (const line of readFileSync(resolve(ROOT, "glyph-by-ids.md"), "utf8").split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m || seen.has(m[0])) continue;
    seen.add(m[0]);
    if (Array.from(m[0]).filter((c) => !opSet.includes(c)).length >= 2) cases.push(m[0]);
    if (cases.length >= 5) break;
  }
  interface Row { ids: string; seq: string; a: CrossResult | null; c: CrossResult | null; aSvg: string; cSvg: string }
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
  console.log("=== 骨架交錯（不同引用的段對中，真的相交的比例；越小越好）===");
  for (const r of rows) {
    const f = (x: CrossResult | null) => x ? x.score.toFixed(3) + "（" + x.hits + "/" + x.pairs + " 對）" : "—";
    console.log("  " + r.ids.padEnd(22) + " 古法 " + f(r.a).padEnd(24) + " 今法 " + f(r.c));
  }
  const cell = (t: string, sub: string, svg: string, bad: boolean) =>
    '<div class="c' + (bad ? " bad" : "") + '"><div class="g">' + svg + '</div><div class="t">' + t + '</div><div class="s">' + sub + "</div></div>";
  const body = rows.map((r) => {
    const f = (x: CrossResult | null) => x ? x.score.toFixed(3) + "（" + x.hits + "/" + x.pairs + " 對）" : "—";
    const worse = (r.c?.score ?? 0) > (r.a?.score ?? 0) * 1.5 && (r.c?.score ?? 0) > 0.02;
    return '<div class="case"><div class="ids">' + r.ids + "　<small>" + idsText(r.ids) + "</small></div>" +
      '<div class="row">' +
      cell("A 古法", "交錯 " + f(r.a), r.aSvg, false) +
      cell("B 今法", "交錯 " + f(r.c) + (r.seq ? "<br>" + r.seq : ""), r.cSvg, worse) +
      "</div></div>";
  }).join("");
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'body{margin:0;background:#0b0c0e;color:#e8ecf4;font:13px system-ui,"Microsoft JhengHei",sans-serif}' +
    'h1{font-size:17px;padding:12px 14px 2px;margin:0}h1 small{font-size:12px;color:#8a93a3;font-weight:400}' +
    '.case{border-bottom:1px solid #23262c;padding:2px 0 6px}.ids{font-size:15px;padding:6px 14px 2px;color:#8fd}' +
    '.ids small{font-size:11px;color:#8a93a3}.row{display:flex;gap:10px;padding:2px 12px}' +
    '.c{background:#15171b;border:1px solid #2a2e35;border-radius:9px;padding:7px;text-align:center;width:168px}' +
    '.c.bad{border-color:#7a3b3b}.g{width:154px;height:154px}.g svg{width:100%;height:100%;display:block;color:#e8ecf4}' +
    '.t{font-weight:600;margin-top:4px;font-size:12px}.s{color:#8a93a3;font-size:11px;min-height:28px;word-break:break-all}' +
    '</style></head><body><h1>骨架交錯　<small>目標第一句：「筆劃不能大面積交錯」——不同引用的骨架線段真的相交的比例</small></h1>' +
    body + "</body></html>";
  const page = resolve(ROOT, "out/_cross.html");
  writeFileSync(page, html, "utf8");
  const shot = resolve(ROOT, arg("--png", "out/cross.png")!);
  if (existsSync(shot)) unlinkSync(shot);
  const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  Bun.spawnSync([EDGE, "--headless", "--disable-gpu", "--screenshot=" + shot, "--window-size=410,1320",
    "--hide-scrollbars", "--virtual-time-budget=9000", "file:///" + page.replace(/\\/g, "/")],
    { stdout: "ignore", stderr: "ignore" });
  console.log(existsSync(shot) ? "圖：" + shot : "截圖失敗 ✗");
}
