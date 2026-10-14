#!/usr/bin/env bun
/**
 * redraw.ts — **把合體字的畫法改成引用**（筆劃 → 引用），帶墨跡驗收。
 *
 * 為什麼：字庫裡有很多合體字是「一筆一劃畫出來的」（`孚` 9 筆、`林` 0 個引用），
 * 於是「組字結構」只能靠 IDS。把它們改成引用之後，結構就長在畫法裡（IDS 可以退場）。
 *
 * ## 作法（不用 IDS 的算子，全部用自己的墨跡）
 *
 * 1. 分量清單來自字庫的 `lib.comp`（v4 起**保留 IDS 分量順序**）。
 * 2. **版面算子**：把候選算子（⿰⿱⿲⿳⿴⿵⿶⿷⿸⿹⿺）每一個都試一遍，用標準版面框起頭。
 * 3. **EM 式對位**（3 輪）：
 *    ① 每一筆原筆劃指派給「墨框最接近」的那個分量
 *    ② 每個分量依「構件自己的墨框 → 那一組筆劃的墨框」反推框（`fitBox`），
 *       再做區域微調（尺度 ±10%、位移 ±12 單位）取墨跡重疊最大的那一個
 * 4. **驗收**：把新筆劃（每個分量一筆引用）畫出來，與原字算 **IoU**；最好的算子要 ≥ 門檻才採用。
 *
 * 只處理「分量**全部有碼位、且都在字庫**」的字——沒有碼位的分量（`&CDP-…;`）
 * 現在的字庫格式指名不了，那一類要等格式擴充（見 `組字結構.md` §8）。
 *
 * 用法:
 *   bun run tools/redraw.ts [--limit N] [--min-iou 0.95] [--grid 64]
 *        [--list out/structure-worklist.tsv] [--all]
 *        [--patch out/structure-redraw.tsv] [--audit out/redraw-audit.html]
 *   `--all`＝掃全庫（不只工作清單）；預設只掃工作清單。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { decodeLibrary, codePointOf, indexOfCodePoint, isPlainIdeograph, displayName } from "./lib-format.ts";
import type { Library, Stroke } from "./lib-format.ts";
import { drawingIdx } from "./free-compose.ts";
import { attachNames } from "./lib-names.ts";

const D = "D:/2023/glyphwiki";
const argv = Bun.argv.slice(2);
const argNum = (k: string, d: number) => {
  const i = argv.indexOf(k);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const argStr = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const LIMIT = argNum("--limit", Infinity);
const MIN_IOU = argNum("--min-iou", 0.95);
const DEBUG = argStr("--debug");
const CHARS = argStr("--chars");
const GRID = argNum("--grid", 64);
const SCAN_ALL = argv.includes("--all");
const PATCH = argStr("--patch");
const AUDIT = argStr("--audit");
const LIST = argStr("--list") ?? `${D}/out/structure-worklist.tsv`;

const lib: Library = attachNames(decodeLibrary(
  new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk-all.bin.gz`))),
));
for (const f of ["2d.js", "buhin.js", "curve.js", "kage.js", "kagecd.js", "kagedf.js", "polygon.js", "polygons.js"]) {
  (0, eval)(readFileSync(`${D}/kage-engine/${f}`, "utf8"));
}
const kage = new (globalThis as any).Kage();
const gname = (i: number) => "g" + i;
const dataOf = (st: Stroke[]) => st.map((s) => s.kind === 99
  ? `99:0:0:${s.box![0]}:${s.box![1]}:${s.box![2]}:${s.box![3]}:${gname(s.ref!)}:${s.stretch![0]}:${s.stretch![1]}:${s.stretch![2]}:${s.stretch![3]}`
  : [s.kind, s.width, s.style].concat(s.points).join(":")).join("$");

const registered = new Set<string>();
/** 每次試框都要用**不重複的名字**：`ensure()` 是照名字快取的，同名的話第二次起會沿用第一次的資料
    （第一版就是這樣：所有候選算子的 IoU 都一模一樣，因為畫的其實是第一個候選）。 */
let attempt = 0;
function ensure(name: string, data: string) {
  if (registered.has(name)) return;
  registered.add(name);
  kage.kBuhin.push(name, data);
  /* 這一份字庫的引用：把子字形也註冊進去 */
  for (const part of data.split("$")) {
    const f = part.split(":");
    if (Number(f[0]) !== 99) continue;
    const ri = Number(f[7]!.slice(1));
    const g = lib.glyphs[ri];
    if (g) ensure(gname(ri), dataOf(g.strokes));
  }
}

/* ---------------------------------------------------------------- 遮罩工具 */
const rings = (polys: { array: unknown[] }, from: number, to: number) => {
  const out: { pts: { x: number; y: number }[]; x1: number; y1: number; x2: number; y2: number }[] = [];
  for (let k = from; k < to; k++) {
    const p = polys.array[k] as { array: { x: number; y: number }[] } | undefined;
    if (!p) continue;
    const pts = p.array.map((q) => ({ x: +q.x, y: +q.y }));
    if (pts.length < 3) continue;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const q of pts) { x1 = Math.min(x1, q.x); x2 = Math.max(x2, q.x); y1 = Math.min(y1, q.y); y2 = Math.max(y2, q.y); }
    out.push({ pts, x1, y1, x2, y2 });
  }
  return out;
};
const wn = (pts: { x: number; y: number }[], x: number, y: number) => {
  let w = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j]!, b = pts[i]!;
    if (a.y <= y) { if (b.y > y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) > 0) w++; }
    else if (b.y <= y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) < 0) w--;
  }
  return w;
};
/** 點陣遮罩（nonzero winding）＋墨框 */
function maskOf(polys: { array: unknown[] }, from: number, to: number, bbox: [number, number, number, number] | null) {
  const rs = rings(polys, from, to);
  const m = new Uint8Array(GRID * GRID);
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, ink = 0;
  const bx = bbox ?? [0, 0, 200, 200];
  for (let py = 0; py < GRID; py++) {
    const y = bx[1] + ((py + 0.5) / GRID) * (bx[3] - bx[1]);
    for (let px = 0; px < GRID; px++) {
      const x = bx[0] + ((px + 0.5) / GRID) * (bx[2] - bx[0]);
      let w = 0;
      for (const r of rs) { if (x < r.x1 || x > r.x2 || y < r.y1 || y > r.y2) continue; w += wn(r.pts, x, y); }
      if (w !== 0) {
        m[py * GRID + px] = 1; ink++;
        if (x < x1) x1 = x; if (x > x2) x2 = x;
        if (y < y1) y1 = y; if (y > y2) y2 = y;
      }
    }
  }
  return { mask: m, ink, box: ink ? [x1, y1, x2, y2] as [number, number, number, number] : null };
}
const iouOf = (a: Uint8Array, b: Uint8Array) => {
  let inter = 0, uni = 0;
  for (let k = 0; k < a.length; k++) {
    const p = a[k], q = b[k];
    if (p && q) inter++;
    if (p || q) uni++;
  }
  return uni ? inter / uni : 1;
};
/** 畫一個字形資料字串，取遮罩（用固定畫布 [0,0,200,200]，方便互比） */
function renderMask(name: string, data: string, bbox: [number, number, number, number] | null = null) {
  ensure(name, data);
  const p: { array: unknown[] } = new (globalThis as any).Polygons();
  try { kage.makeGlyph(p, name); } catch { return null; }
  return maskOf(p, 0, p.array.length, bbox);
}
/**
 * 逐筆畫（**就地**量）。
 * ⚠ 不可以把單一筆畫單獨畫一次——引擎的筆畫調整（tani/hane/kakato）會看到不同的鄰筆，
 * 實測可以差到三成的墨（見 `pinzhing-技術總結` §10 的實測）。要用 `getEachStrokes()`
 * 拿到整字的攤平筆劃、再一筆一筆 `dfDrawFont()` 畫出來記錄。
 */
function strokeMasksInPlace(name: string, data: string) {
  ensure(name, data);
  const strokesArray = kage.adjustStrokes(kage.getEachStrokes(kage.kBuhin.search(name)));
  const out: { mask: Uint8Array; box: Box }[] = [];
  for (const s of strokesArray) {
    const p: { array: unknown[] } = new (globalThis as any).Polygons();
    (globalThis as any).dfDrawFont(kage, p, s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10]);
    const m = maskOf(p, 0, p.array.length, null);
    if (m.box) out.push({ mask: m.mask, box: m.box });
  }
  return out;
}

/* ---------------------------------------------------------------- 版面候選 */
type Box = [number, number, number, number];
const BOX: Record<string, (n: number) => Box[]> = {
  "⿰": (n) => (n === 2 ? [[0, 0, 100, 200], [100, 0, 200, 200]] : thirdsX(n)),
  "⿱": (n) => (n === 2 ? [[0, 0, 200, 100], [0, 100, 200, 200]] : thirdsY(n)),
  "⿲": (n) => thirdsX(n),
  "⿳": (n) => thirdsY(n),
  "⿴": () => [[0, 0, 200, 200], [35, 35, 165, 165]],
  "⿵": () => [[0, 0, 200, 200], [30, 55, 170, 180]],
  "⿶": () => [[0, 0, 200, 200], [30, 20, 170, 145]],
  "⿷": () => [[0, 0, 200, 200], [55, 30, 180, 170]],
  "⿸": () => [[0, 0, 200, 200], [50, 50, 190, 190]],
  "⿹": () => [[0, 0, 200, 200], [10, 50, 150, 190]],
  "⿺": () => [[0, 0, 200, 200], [50, 10, 190, 150]],
};
const thirdsX = (n: number): Box[] => Array.from({ length: n }, (_, i) =>
  [(200 * i) / n, 0, (200 * (i + 1)) / n, 200] as Box);
const thirdsY = (n: number): Box[] => Array.from({ length: n }, (_, i) =>
  [0, (200 * i) / n, 200, (200 * (i + 1)) / n] as Box);

const inBox = (b: Box, x: number, y: number) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
const centerOf = (b: Box): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

/** 由「構件自己的墨框 → 目標墨框」反推引用框（與 deriveSlot 同一條式子，但用**區域墨**不是筆畫組） */
function fitBox(compBox: Box, targetBox: Box): Box {
  const cw = Math.max(1e-6, compBox[2] - compBox[0]), ch = Math.max(1e-6, compBox[3] - compBox[1]);
  const tw = targetBox[2] - targetBox[0], th = targetBox[3] - targetBox[1];
  const sx = Math.min(400, Math.max(40, (200 * tw) / cw));
  const sy = Math.min(400, Math.max(40, (200 * th) / ch));
  const bx = targetBox[0] - (compBox[0] * sx) / 200;
  const by = targetBox[1] - (compBox[1] * sy) / 200;
  return [bx, by, bx + sx, by + sy];
}

/* ---------------------------------------------------------------- 主流程 */
type Target = { gi: number; cp: number; ch: string; name: string };
const targets: Target[] = [];
{
  const wanted = new Set<string>();
  if (!SCAN_ALL) {
    try {
      for (const line of readFileSync(LIST, "utf8").split("\n").slice(1)) {
        const c = line.split("\t");
        if (c[0]) wanted.add(c[0]!);
      }
    } catch { /* 沒有清單就掃全庫 */ }
  }
  let processed = 0;
  const force = CHARS ? new Set(Array.from(CHARS).map((c) => indexOfCodePoint(lib, c.codePointAt(0)!)).filter((i): i is number => i !== undefined)) : null;
  for (let gi = 0; gi < lib.glyphs.length; gi++) {
    if (processed >= LIMIT) break;
    if (force && !force.has(gi)) continue;
    if (!force && !SCAN_ALL && wanted.size && !wanted.has(String(gi))) continue;
    const cp = codePointOf(lib, gi);
    if (!cp || !isPlainIdeograph(lib, gi)) continue;
    if (indexOfCodePoint(lib, cp) !== gi) continue;
    processed++;
    const drawing = drawingIdx(lib, gi);
    const g = lib.glyphs[drawing]!;
    if (g.strokes.some((s) => s.kind === 99)) continue;          /* 已經是引用 */
    const comp = lib.comp?.get(cp);
    if (!comp || comp.length < 2 || comp.length > 4) continue;   /* 沒有分解／太多分量 */
    if (comp.some((c) => indexOfCodePoint(lib, c) === undefined)) continue;  /* 有分量不在字庫 */
    targets.push({ gi: drawing, cp, ch: String.fromCodePoint(cp), name: displayName(lib, drawing) });
  }
}
const why = new Map<string, number>();
{
  let processed2 = 0;
  for (let gi = 0; gi < lib.glyphs.length; gi++) {
    if (processed2 >= LIMIT) break;
    const cp = codePointOf(lib, gi);
    if (!cp || !isPlainIdeograph(lib, gi)) continue;
    if (indexOfCodePoint(lib, cp) !== gi) continue;
    processed2++;
    const drawing = drawingIdx(lib, gi);
    const g = lib.glyphs[drawing]!;
    const hasRef = g.strokes.some((s) => s.kind === 99);
    const comp = lib.comp?.get(cp);
    const k = hasRef ? "已經是引用"
      : !comp || comp.length < 2 ? "沒有分解或是獨體"
      : comp.length > 4 ? "分量超過 4 個"
      : comp.some((c) => indexOfCodePoint(lib, c) === undefined) ? "有分量不在字庫"
      : "可轉";
    why.set(k, (why.get(k) ?? 0) + 1);
  }
}
console.log(`全庫分類（掃 ${[...why.values()].reduce((a, b) => a + b, 0).toLocaleString()} 個字）：` +
  [...why.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toLocaleString()}`).join("　"));
console.log(`候選（合體字、畫成筆劃、分量都有碼位且在庫）：${targets.length.toLocaleString()} 個`);
if (argv.includes("--count-only")) process.exit(0);

type Result = { t: Target; op: string; iou: number; parts: string[]; strokes: Stroke[]; st: number[] };
const results: Result[] = [];
const skip = new Map<string, number>();
const t0 = performance.now();

for (const t of targets) {
  const g = lib.glyphs[t.gi]!;
  const data = dataOf(g.strokes);
  ensure(gname(t.gi), data);
  /* 原字墨跡 ＋ 逐筆墨框（用單獨一筆的資料字串畫，才知道每一筆在哪） */
  const whole = renderMask("whole" + t.gi, data);
  if (!whole || !whole.box) { skip.set("畫不出來", (skip.get("畫不出來") ?? 0) + 1); continue; }
  const strokeInk = strokeMasksInPlace(gname(t.gi), data);
  const comps = lib.comp!.get(t.cp)!;
  const compBoxes: Box[] = [];
  let okComps = true;
  for (const c of comps) {
    const ci = indexOfCodePoint(lib, c)!;
    const cm = renderMask("c" + ci, dataOf(lib.glyphs[drawingIdx(lib, ci)]!.strokes));
    if (!cm || !cm.box) { okComps = false; break; }
    compBoxes.push(cm.box);
  }
  if (!okComps) { skip.set("分量畫不出來", (skip.get("分量畫不出來") ?? 0) + 1); continue; }

  let best: { op: string; iou: number; boxes: Box[]; assign: number[]; st: number[] } | null = null;
  const dbg: string[] = [];
  for (const op of Object.keys(BOX)) {
    if (comps.length > 2 && !"⿲⿳".includes(op)) continue;
    if (comps.length === 2 && "⿲⿳".includes(op)) continue;
    let boxes = BOX[op]!(comps.length);
    let assign = new Array(g.strokes.length).fill(0);
    for (let iter = 0; iter < 3; iter++) {
      /* ① 指派：每一筆給「中心最接近」的分量 */
      assign = g.strokes.map((_, ix) => {
        const b = strokeInk[ix]?.box;
        if (!b) return 0;
        const c = centerOf(b);
        let bi = 0, bd = Infinity;
        boxes.forEach((bb, k) => {
          const cc = centerOf(bb);
          const d = (c[0] - cc[0]) ** 2 + (c[1] - cc[1]) ** 2;
          if (d < bd) { bd = d; bi = k; }
        });
        return bi;
      });
      /* ② 每個分量依它那一組筆劃的墨框重算框 */
      boxes = comps.map((_, k) => {
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        g.strokes.forEach((_, ix) => {
          if (assign[ix] !== k) return;
          const b = strokeInk[ix]?.box;
          if (!b) return;
          x1 = Math.min(x1, b[0]); y1 = Math.min(y1, b[1]);
          x2 = Math.max(x2, b[2]); y2 = Math.max(y2, b[3]);
        });
        if (x1 === Infinity) return boxes[k]!;
        return fitBox(compBoxes[k]!, [x1, y1, x2, y2]);
      });
    }
    /* ③ 微調：尺度 ±10%、位移 ±12 單位，取墨跡重疊最大 */
    let bestLocal = { iou: -1, boxes: boxes.map((b) => [...b] as Box), st: [0, 0, 0, 0] as number[] };
    const tryBoxes = (bs: Box[], st: number[] = [0, 0, 0, 0]) => {
      const strokes: Stroke[] = bs.map((b, k) => ({
        kind: 99, width: 0, style: 0, points: [], ref: indexOfCodePoint(lib, comps[k]!)!, box: [...b], stretch: [...st],
      }));
      const m = renderMask(`try${t.gi}_${++attempt}`, dataOf(strokes));
      if (!m) return;
      const v = iouOf(whole.mask, m.mask);
      if (v > bestLocal.iou) bestLocal = { iou: v, boxes: bs, st: [...st] };
    };
    tryBoxes(boxes);
    for (const ds of [0.9, 0.95, 1.05, 1.1]) {
      for (const dx of [-12, -6, 6, 12]) {
        for (const dy of [-12, -6, 6, 12]) {
          tryBoxes(boxes.map((b) => {
            const c = centerOf(b);
            const w = (b[2] - b[0]) * ds / 2, h = (b[3] - b[1]) * ds / 2;
            const cx = c[0] + dx, cy = c[1] + dy;
            return [cx - w, cy - h, cx + w, cy + h] as Box;
          }));
        }
      }
    }
    /* ④ `stretch` 擬合：x／y 兩軸各自獨立（座標在**子字形的 0..200 空間**先被
       兩段折線扭曲，再進框）。因為獨立，可以逐軸座標下降：
       dp＞0 時引擎會把 sx2 歸零，所以要用到 sp 就必須讓 dp＜0（存檔時寫 200＋dp）。 */
    const XCAND: [number, number][] = [[0, 0], [-20, 0], [-40, 0], [-15, -40], [-15, 40], [-30, -40], [-30, 40]];
    const YCAND: [number, number][] = [[0, 0], [-20, 0], [-40, 0], [-15, -40], [-15, 40], [-30, -40], [-30, 40]];
    const enc = (dp: number, sp: number): number => (sp !== 0 ? dp + 200 : dp);
    let bx = bestLocal.boxes;
    let st = [...bestLocal.st];
    let gain = true;
    for (let pass = 0; pass < 2 && gain; pass++) {
      gain = false;
      for (const [dp, sp] of XCAND) {
        const cand = [enc(dp, sp), st[1]!, sp, st[3]!];
        const before = bestLocal.iou;
        tryBoxes(bx, cand);
        if (bestLocal.iou > before) { bx = bestLocal.boxes; st = [...bestLocal.st]; gain = true; }
      }
      for (const [dp, sp] of YCAND) {
        const cand = [st[0]!, enc(dp, sp), st[2]!, sp];
        const before = bestLocal.iou;
        tryBoxes(bx, cand);
        if (bestLocal.iou > before) { bx = bestLocal.boxes; st = [...bestLocal.st]; gain = true; }
      }
    }
    if (!best || bestLocal.iou > best.iou) best = { op, iou: bestLocal.iou, boxes: bestLocal.boxes, assign, st: bestLocal.st };
    if (DEBUG) dbg.push(`   ${op} → IoU ${(bestLocal.iou * 100).toFixed(1)}%　框 ${bestLocal.boxes.map((b) => "[" + b.map((v) => Math.round(v)).join(",") + "]").join(" ")}`);
  }
  if (DEBUG && DEBUG.includes(t.ch)) {
    console.log(`\n=== ${t.ch} U+${t.cp.toString(16)} ${t.name}　分量 ${comps.map((c) => String.fromCodePoint(c)).join("")} ===`);
    console.log(`   分量墨框：` + compBoxes.map((b) => `[${b.map((v) => Math.round(v)).join(",")}]`).join(" "));
    console.log(`   原字墨框：[${whole.box.map((v) => Math.round(v)).join(",")}] 墨 ${whole.ink}`);
    console.log(`   每一筆墨框：` + strokeInk.map((s, i) => `${i}:[${s.box.map((v) => Math.round(v)).join(",")}]`).join(" "));
    for (const d of dbg) console.log(d);
    if (best) {
      const ascii = (m: Uint8Array, tag: string) => {
        let out = "   " + tag + "\n";
        for (let y = 0; y < GRID; y += 2) {
          let row = "   ";
          for (let x = 0; x < GRID; x++) row += m[y * GRID + x] ? "#" : ".";
          out += row + "\n";
        }
        console.log(out);
      };
      ascii(whole.mask, "原字");
      const ms = renderMask("dbg" + t.gi + "_" + (++attempt), dataOf(best.boxes.map((b, k) => ({
        kind: 99, width: 0, style: 0, points: [], ref: indexOfCodePoint(lib, comps[k]!)!, box: [...b], stretch: [0, 0, 0, 0],
      } as Stroke))));
      if (ms) ascii(ms.mask, `改引用（${best.op}，IoU ${(best.iou * 100).toFixed(1)}%）`);
    }
  }
  if (!best) { skip.set("沒有可用版面", (skip.get("沒有可用版面") ?? 0) + 1); continue; }
  if (best.iou < MIN_IOU) { skip.set(`IoU < ${MIN_IOU}`, (skip.get(`IoU < ${MIN_IOU}`) ?? 0) + 1); continue; }
  results.push({
    t, op: best.op, iou: best.iou, st: best.st,
    parts: comps.map((c) => String.fromCodePoint(c)),
  });
}

/* ---------------------------------------------------------------- 報表 */
const secs = ((performance.now() - t0) / 1000).toFixed(0);
const n = results.length;
console.log(`轉成功（IoU ≥ ${MIN_IOU}）：${n.toLocaleString()} / ${targets.length.toLocaleString()}` +
  `（${((n / Math.max(1, targets.length)) * 100).toFixed(1)}%，${secs}s）`);
const byOp = new Map<string, number>();
for (const r of results) byOp.set(r.op, (byOp.get(r.op) ?? 0) + 1);
console.log(`版面分佈：` + [...byOp.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("　"));
console.log(`沒過的：` + [...skip.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("　"));
const ios = results.map((r) => r.iou).sort((a, b) => a - b);
if (ios.length) console.log(`IoU：最差 ${(ios[0]! * 100).toFixed(1)}%、中位 ${(ios[Math.floor(ios.length / 2)]! * 100).toFixed(1)}%、最好 ${(ios[ios.length - 1]! * 100).toFixed(1)}%`);
console.log(`例子：` + results.slice(0, 10).map((r) => `${r.t.ch}(${r.op}${r.parts.join("")} ${(r.iou * 100).toFixed(0)}%)`).join("　"));

if (PATCH) {
  const lines = ["name\tchar\tcodepoint\top\tIoU\t分量\t新筆劃"];
  for (const r of results) {
    lines.push(`${r.t.name}\t${r.t.ch}\tU+${r.t.cp.toString(16).toUpperCase()}\t${r.op}\t${r.iou.toFixed(4)}\t` +
      `${r.parts.join("")}\t${dataOf(r.strokes)}`);
  }
  writeFileSync(PATCH, lines.join("\n") + "\n", "utf8");
  console.log(`（patch 已寫入 ${PATCH}：${n} 列，用 build-library.ts --redraw 套用）`);
}

if (AUDIT) {
  const pick = [...results.slice(0, 6), ...results.slice(-6)];
  const svg = (label: string, name: string, data: string) => {
    ensure(name, data);
    const p: { array: unknown[] } = new (globalThis as any).Polygons();
    try { kage.makeGlyph(p, name); } catch { return `<div class="c"><div class="lb">${label}</div>（畫不出來）</div>`; }
    let path = "";
    for (const poly of p.array as { array: { x: number; y: number }[] }[]) {
      if (!poly) continue;
      path += "M" + poly.array.map((q) => `${(+q.x).toFixed(1)},${(+q.y).toFixed(1)}`).join("L") + "Z";
    }
    return `<div class="c"><div class="lb">${label}</div>` +
      `<svg viewBox="0 0 200 200" width="110" height="110"><path d="${path}" fill="#111"/></svg></div>`;
  };
  let html = `<!doctype html><meta charset="utf-8"><title>重畫對照</title>` +
    `<style>body{font:14px/1.5 system-ui,sans-serif;margin:16px}h2{font-size:15px;margin:18px 0 4px}` +
    `.row{display:flex;gap:8px}.c{text-align:center}.lb{font-size:12px;color:#666}code{background:#f4f4f4;padding:1px 4px}</style>` +
    `<h1>把畫法改成引用：對照</h1><p>左＝原字（筆劃）、右＝改成引用後。IoU＝兩者墨跡重疊率。</p>`;
  for (const r of pick) {
    html += `<h2>${r.t.ch} <code>${r.t.name}</code>　${r.op}${r.parts.join("")}　IoU ${(r.iou * 100).toFixed(1)}%</h2><div class="row">` +
      svg("原字", gname(r.t.gi), dataOf(lib.glyphs[r.t.gi]!.strokes)) +
      svg("改引用", "rd" + r.t.gi, dataOf(r.strokes)) + `</div>`;
  }
  writeFileSync(AUDIT, html, "utf8");
  console.log(`（對照表已寫入 ${AUDIT}）`);
}

