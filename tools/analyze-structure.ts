#!/usr/bin/env bun
/**
 * analyze-structure.ts — **視覺結構 vs 內在結構**的一致比例分析。
 *
 * 使用者的原則（2026-10-13）：
 *   「客人對組字的認知只能從目視而來，看不到內在的結構，他不知道是部件組出來的，
 *     還是一筆一劃出來的。理想的情況，只有獨體字可以用筆劃，其他的字只能用獨體字
 *     或合字來組。所以我們最好讓視覺的結構和內在部件的結構（統一）。」
 *
 * 兩個結構的來源：
 *   **視覺結構（V）**＝`unicode-cjk-ids/All.txt` 的 IDS 標註（人寫的「讀者看到什麼」，
 *                     有算子 ⿰⿱⿴… 與分量）。這是**外部資料**，不是引擎自己算的。
 *   **內在結構（I）**＝字庫的 KAGE 筆劃（`kind 99` 引用＝部件、其餘是原始筆劃），
 *                     看的是 `drawingIdx()` 之後「真的在畫」的那個節點（穿透純指標包裝）。
 *
 * 量測方法（兩個都要）：
 *   1. **資料層**：分量有沒有碼位、在不在字庫、是不是直接引用、引用數對不對、
 *      引擎定不定得到槽位（`canReplaceCp`）。
 *   2. **墨跡層（就地量，不用近似）**：把「每一筆攤平筆劃產生的多邊形」逐一記錄
 *      （`renderPerStroke`），就能拿到每個部件**在這個字裡**的墨。不能把子字形單獨
 *      畫一次——引擎的筆畫調整會看到不同的鄰筆，結果不一樣（實測可差三成的墨）。
 *      於是可算：
 *        `coverage`＝整字的墨有多少比例落在**有名字的部件**（引用或可定址的 IDS 槽位）裡
 *        `overlap` ＝部件的墨有多少比例被**兩個以上**部件同時蓋到
 *
 * 「完美統一」＝ 標註分量都有碼位、都在字庫、**每一個都是 KAGE 直接引用**、引用數與
 * 分量數一致、`coverage ≥ 99%`（沒有無主的墨）、`overlap ≤ 3%`（部件的墨分得開）、
 * 分量順序符合算子。
 *
 * 用法: bun run tools/analyze-structure.ts [--limit N] [--grid 64] [--show 12]
 *        [--cases 字串] [--out out/structure-report.txt]
 *      `--out` 由程式自己寫 UTF-8（**不要用 PowerShell 的 `>`／`Set-Content`**：
 *      那是 UTF-16 而且會把中文弄壞——專案為此吃過虧，見 `progress/pinxing-技術總結.md` §10.2）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { decodeLibrary, codePointOf, indexOfCodePoint, isPlainIdeograph } from "./lib-format.ts";
import type { Library } from "./lib-format.ts";
import { componentBoxes, inkBoundsOfPolys } from "./component-boxes.ts";
import type { Box, InkMeasure } from "./component-boxes.ts";
import { canReplaceCp, solveIdsSlots, drawingIdx } from "./free-compose.ts";

const D = "D:/2023/glyphwiki";
const argv = Bun.argv.slice(2);
const argNum = (k: string, d: number) => {
  const i = argv.indexOf(k);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const LIMIT = argNum("--limit", Infinity);
const GRID = argNum("--grid", 64);
const SHOW = argNum("--show", 10);
const OUT = (() => {
  const i = argv.indexOf("--out");
  return i >= 0 ? argv[i + 1] : null;
})();
const reportLines: string[] = [];
if (OUT) {
  const orig = console.log.bind(console);
  console.log = (...a: unknown[]) => {
    reportLines.push(a.map((x) => String(x)).join(" "));
    orig(...a);
  };
}

/* ---------------------------------------------------------------- 引擎 */
const lib: Library = decodeLibrary(
  new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk-all.bin.gz`))),
);
for (const f of ["2d.js", "buhin.js", "curve.js", "kage.js", "kagecd.js", "kagedf.js", "polygon.js", "polygons.js"]) {
  (0, eval)(readFileSync(`${D}/kage-engine/${f}`, "utf8"));
}
const nameOf = (i: number) => "g" + i;
const kageDataOf = (g: { strokes: { kind: number; width: number; style: number; points: number[]; box?: number[]; stretch?: number[]; ref?: number | null }[] }) =>
  g.strokes.map((s) => s.kind === 99
    ? `99:0:0:${s.box![0]}:${s.box![1]}:${s.box![2]}:${s.box![3]}:${nameOf(s.ref!)}:${s.stretch![0]}:${s.stretch![1]}:${s.stretch![2]}:${s.stretch![3]}`
    : [s.kind, s.width, s.style].concat(s.points).join(":")).join("$");

const kage = new (globalThis as any).Kage();
const filled = new Set<number>();
function fillKage(gi: number) {
  const stack = [gi];
  while (stack.length) {
    const j = stack.pop()!;
    if (filled.has(j)) continue;
    filled.add(j);
    const g = lib.glyphs[j]!;
    kage.kBuhin.push(nameOf(j), kageDataOf(g as never));
    for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
}
const inkCache = new Map<number, Box | null>();
const measure: InkMeasure = (gi: number) => {
  const hit = inkCache.get(gi);
  if (hit !== undefined) return hit;
  fillKage(gi);
  const polys = new (globalThis as any).Polygons();
  kage.makeGlyph(polys, nameOf(gi));
  const b = inkBoundsOfPolys(polys);
  inkCache.set(gi, b);
  return b;
};

/* ------------------------------------------------ 每一筆直接筆劃 ⇄ 攤平筆劃區間 */
function flatRanges(gi: number, depth = 0): { ranges: [number, number][]; total: number } {
  const ranges: [number, number][] = [];
  let at = 0;
  for (const s of lib.glyphs[gi]!.strokes) {
    if (s.kind === 99 && s.ref !== null && depth < 12) {
      const sub = flatRanges(s.ref, depth + 1);
      ranges.push([at, at + sub.total]);
      at += sub.total;
    } else {
      ranges.push([at, at + 1]);
      at += 1;
    }
  }
  return { ranges, total: at };
}
/** 就地畫，並記錄「每一筆攤平筆劃」產生的多邊形區間 */
function renderPerStroke(gi: number) {
  fillKage(gi);
  const polys: { array: unknown[] } = new (globalThis as any).Polygons();
  const data = kage.kBuhin.search(nameOf(gi));
  const strokesArray = kage.adjustStrokes(kage.getEachStrokes(data));
  const ranges: [number, number][] = [];
  for (const s of strokesArray) {
    const before = polys.array.length;
    (globalThis as any).dfDrawFont(kage, polys, s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10]);
    ranges.push([before, polys.array.length]);
  }
  return { polys, ranges };
}

/* ---------------------------------------------------------------- 點陣（nonzero） */
function maskOf(polys: { array: unknown[] }, from: number, to: number, out?: Uint8Array): Uint8Array {
  const m = out ?? new Uint8Array(GRID * GRID);
  const rings: { pts: { x: number; y: number }[]; x1: number; y1: number; x2: number; y2: number }[] = [];
  for (let k = from; k < to; k++) {
    const p = polys.array[k] as { array: { x: number; y: number }[] } | undefined;
    if (!p) continue;
    const pts = p.array.map((q) => ({ x: +q.x, y: +q.y }));
    if (pts.length < 3) continue;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const q of pts) { x1 = Math.min(x1, q.x); x2 = Math.max(x2, q.x); y1 = Math.min(y1, q.y); y2 = Math.max(y2, q.y); }
    rings.push({ pts, x1, y1, x2, y2 });
  }
  const wn = (pts: { x: number; y: number }[], x: number, y: number) => {
    let w = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[j]!, b = pts[i]!;
      if (a.y <= y) { if (b.y > y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) > 0) w++; }
      else if (b.y <= y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) < 0) w--;
    }
    return w;
  };
  for (let py = 0; py < GRID; py++) {
    const y = ((py + 0.5) / GRID) * 200;
    for (let px = 0; px < GRID; px++) {
      const x = ((px + 0.5) / GRID) * 200;
      let w = 0;
      for (const r of rings) {
        if (x < r.x1 || x > r.x2 || y < r.y1 || y > r.y2) continue;
        w += wn(r.pts, x, y);
      }
      if (w !== 0) m[py * GRID + px] = 1;
    }
  }
  return m;
}

/* ---------------------------------------------------------------- IDS 標註 */
const OP_ARITY: Record<string, number> = {
  "⿰": 2, "⿱": 2, "⿲": 3, "⿳": 3, "⿴": 2, "⿵": 2, "⿶": 2, "⿷": 2,
  "⿸": 2, "⿹": 2, "⿺": 2, "⿻": 2,
};
const SPLIT_X = new Set(["⿰", "⿲"]);
const SPLIT_Y = new Set(["⿱", "⿳"]);
type Part = { kind: "cp"; cp: number; ch: string } | { kind: "name"; name: string } | { kind: "op"; op: string; kids: Part[] };
const CP_RE = /^U\+([0-9A-Fa-f]{4,6})$/;
function parseIds(s: string): { op: string | null; parts: Part[] } {
  const toks: string[] = [];
  const arr = Array.from(s);
  for (let i = 0; i < arr.length;) {
    if (arr[i] === "&") {
      let e = i + 1;
      while (e < arr.length && arr[e] !== ";") e++;
      toks.push(arr.slice(i, e + 1).join(""));
      i = e + 1;
      continue;
    }
    toks.push(arr[i]!);
    i++;
  }
  let pos = 0;
  const one = (): Part | null => {
    const t = toks[pos++];
    if (t === undefined) return null;
    if (OP_ARITY[t] !== undefined) {
      const kids: Part[] = [];
      for (let k = 0; k < OP_ARITY[t]!; k++) { const c = one(); if (c) kids.push(c); }
      return { kind: "op", op: t, kids };
    }
    if (t.startsWith("&")) return { kind: "name", name: t };
    return { kind: "cp", cp: t.codePointAt(0)!, ch: t };
  };
  const f = toks[0];
  if (f !== undefined && OP_ARITY[f] !== undefined) {
    const root = one();
    return { op: f, parts: root && root.kind === "op" ? root.kids : [] };
  }
  const only = one();
  return { op: null, parts: only ? [only] : [] };
}
const idsByCp = new Map<number, string>();
for (const line of readFileSync(`${D}/unicode-cjk-ids/All.txt`, "utf8").split("\n")) {
  const t = line.split("\t");
  const m = t[0] ? CP_RE.exec(t[0]) : null;
  if (m && t[2]) idsByCp.set(parseInt(m[1]!, 16), t[2]);
}

/* ---------------------------------------------------------------- 掃描 */
type Row = {
  cp: number; ch: string; op: string | null; parts: string[];
  named: boolean; inLib: boolean; addressable: boolean; isRef: boolean;
  extraRefs: number; refMatch: boolean; orderOk: boolean;
  coverage: number; overlap: number; ink: number;
  nParts: number; nRefs: number;
};
const rows: Row[] = [];
const atomicRefs: string[] = [];
const skip = { noIds: 0, atomic: 0, unparsed: 0, notPlain: 0 };
const orderAxis = (op: string | null) => op && SPLIT_X.has(op) ? 0 : op && SPLIT_Y.has(op) ? 1 : -1;
const blockOf = (cp: number) =>
  cp >= 0x4e00 && cp <= 0x9fff ? "基本區 U+4E00-9FFF" :
  cp >= 0x3400 && cp <= 0x4dbf ? "Ext A U+3400-4DBF" :
  cp >= 0xf900 && cp <= 0xfaff ? "相容 CJK U+F900" :
  cp >= 0x20000 ? "Ext B 以上 U+20000+" : "其他";
/* 墨的總量（含沒有標註／獨體的字，用來算「全庫的墨有多少比例沒有部件名字」） */
const inkTotals = { ink: 0, owned: 0, atomicInk: 0 };
const CASES = (() => {
  const i = argv.indexOf("--cases");
  return i >= 0 ? Array.from(argv[i + 1] ?? "") : [];
})();

let processed = 0;
for (let gi = 0; gi < lib.glyphs.length; gi++) {
  const cp = codePointOf(lib, gi);
  if (!cp) continue;
  if (!isPlainIdeograph(lib, gi)) { skip.notPlain++; continue; }
  if (indexOfCodePoint(lib, cp) !== gi) continue;
  if (processed++ >= LIMIT) break;
  const ch = String.fromCodePoint(cp);
  const ids = idsByCp.get(cp);
  const drawing = drawingIdx(lib, gi);
  const dg = lib.glyphs[drawing]!;
  const refStrokes = dg.strokes.filter((s) => s.kind === 99 && s.ref !== null);

  if (!ids) { skip.noIds++; continue; }
  const parsed = parseIds(ids);
  if (!parsed.parts.length) { skip.unparsed++; continue; }
  if (!parsed.op) {
    skip.atomic++;
    /* 標註是獨體：內在也該是筆劃。它的墨「由它自己擁有」，計入分母。 */
    const { polys: ap } = renderPerStroke(drawing);
    const aw = maskOf(ap, 0, ap.array.length);
    let ai = 0;
    for (let k = 0; k < aw.length; k++) if (aw[k]) ai++;
    inkTotals.ink += ai;
    inkTotals.owned += ai;
    inkTotals.atomicInk += ai;
    if (refStrokes.length) atomicRefs.push(ch);
    continue;
  }

  /* ---- 就地面一次，取每個部件的墨 ---- */
  const { ranges: sRanges } = flatRanges(drawing);
  const { polys, ranges } = renderPerStroke(drawing);
  const whole = maskOf(polys, 0, polys.array.length);

  const cboxes = componentBoxes(lib, drawing, measure);
  const refBoxOfCp = new Map<number, Box>();
  for (const b of cboxes) {
    if (b.idsOnly || !b.tight) continue;
    const c = codePointOf(lib, b.ref);
    if (c && !refBoxOfCp.has(c)) refBoxOfCp.set(c, b.tight);
  }
  const sol = solveIdsSlots(lib, gi);

  const partNames: string[] = [];
  const partBoxes: (Box | null)[] = [];
  const partMasks: { mask: Uint8Array }[] = [];
  let named = true, inLib = true, addressable = true, isRef = true;
  /* 逐**實例**配對，不是逐碼位：`㒭`＝⿰兄兄、`㚘`＝⿰夫夫 這種同一個分量出現兩次，
     用碼位配對會兩格都指到同一筆 → 覆蓋 50%、重疊 100%（第一版就是這樣錯的）。 */
  const refUsed = new Set<number>();
  const slotUsed = new Set<number>();
  const slotList = sol ? sol.slots : [];
  for (const p of parsed.parts) {
    if (p.kind !== "cp") {
      partNames.push(p.kind === "name" ? p.name : p.op);
      named = false; inLib = false; addressable = false; isRef = false; partBoxes.push(null);
      continue;
    }
    partNames.push(p.ch);
    const ci = indexOfCodePoint(lib, p.cp);
    if (ci === undefined) { inLib = false; addressable = false; isRef = false; partBoxes.push(null); continue; }
    /* 直接引用：找下一個「同碼位、還沒被用掉」的引用筆劃 */
    let refIx = -1;
    for (let k = 0; k < refStrokes.length; k++) {
      if (refUsed.has(k)) continue;
      if (codePointOf(lib, refStrokes[k]!.ref!) === p.cp) { refIx = k; break; }
    }
    const isDirect = refIx >= 0;
    if (!isDirect) isRef = false;
    if (!canReplaceCp(lib, gi, p.cp)) addressable = false;
    partBoxes.push(refBoxOfCp.get(p.cp) ?? null);
    if (isDirect) {
      refUsed.add(refIx);
      const k = dg.strokes.indexOf(refStrokes[refIx]!);
      const rr = sRanges[k];
      if (rr) partMasks.push({ mask: maskOf(polys, ranges[rr[0]]![0], ranges[rr[1] - 1]![1]) });
      continue;
    }
    /* IDS 槽位：同樣找下一個「同碼位、還沒用掉」的槽位 */
    for (let k = 0; k < slotList.length; k++) {
      if (slotUsed.has(k)) continue;
      const s = slotList[k]!;
      if (s.index === undefined) continue;
      if (codePointOf(lib, s.index) !== p.cp) continue;
      slotUsed.add(k);
      const m = new Uint8Array(GRID * GRID);
      for (const g of s.group) { const rr = ranges[g]; if (rr) maskOf(polys, rr[0], rr[1], m); }
      partMasks.push({ mask: m });
      break;
    }
  }
  /* 看不到的內部部件：有引用、但沒有被任何標註分量用掉 */
  const extraRefs = refStrokes.length - refUsed.size;
  const refMatch = refStrokes.length === parsed.parts.length && extraRefs === 0;

  let ink = 0, covered = 0, own = 0, multi = 0;
  for (let k = 0; k < whole.length; k++) {
    if (whole[k]) {
      ink++;
      if (partMasks.some((p) => p.mask[k])) covered++;
    }
    let c = 0;
    for (const p of partMasks) if (p.mask[k]) c++;
    if (c) own++;
    if (c > 1) multi++;
  }

  const axis = orderAxis(parsed.op);
  let orderOk = true;
  if (axis >= 0) {
    const cs = partBoxes.filter((b): b is Box => !!b).map((b) => (b[axis]! + b[axis + 2]!) / 2);
    orderOk = cs.every((v, i) => i === 0 || v >= cs[i - 1]! - 2);
  }

  rows.push({
    cp, ch, op: parsed.op, parts: partNames, named, inLib, addressable, isRef,
    extraRefs, refMatch, orderOk,
    coverage: ink ? covered / ink : 1, overlap: own ? multi / own : 0,
    nParts: parsed.parts.length, nRefs: refStrokes.length, ink,
  });
  inkTotals.ink += ink;
  inkTotals.owned += covered;
  if (CASES.includes(ch)) {
    const last = rows[rows.length - 1]!;
    console.log(`  [案例] ${ch} ${parsed.op}${partNames.join("")}　引用 ${refStrokes.length}／分量 ${parsed.parts.length}` +
      `・覆蓋 ${(last.coverage * 100).toFixed(1)}%・重疊 ${(last.overlap * 100).toFixed(1)}%` +
      `・${sol ? "槽位 " + sol.slots.length + " 個（誤差 " + sol.error.toFixed(1) + "）" : "槽位：推不出來"}` +
      `${last.addressable ? "" : "・點不到"}${last.isRef ? "" : "・非引用"}${extraRefs ? "・隱藏引用 " + extraRefs : ""}` +
      `${named ? "" : "・分量無碼位"}${inLib ? "" : "・分量不在庫"}`);
  }
}

/* ---------------------------------------------------------------- 報表 */
const total = rows.length;
const pct = (x: number, d = total) => `${((x / Math.max(1, d)) * 100).toFixed(1)}%`;
const okCov = (r: Row) => r.coverage >= 0.99;
const okOvl = (r: Row) => r.overlap <= 0.03;
const perfect = rows.filter((r) => r.named && r.inLib && r.isRef && r.refMatch && r.orderOk && okCov(r) && okOvl(r));
const usable = rows.filter((r) => r.named && r.inLib && r.addressable && r.orderOk && okCov(r) && okOvl(r));
const perfectSet = new Set(perfect), usableSet = new Set(usable);
console.log(`分析範圍：正規、打得出來、有 IDS 算子標註的字形 ${total.toLocaleString()} 個（點陣 ${GRID}×${GRID}）`);
console.log(`（另有：無 IDS 標註 ${skip.noIds.toLocaleString()}、標註獨體 ${skip.atomic.toLocaleString()}、` +
  `非正規字形 ${skip.notPlain.toLocaleString()}、無法解析 ${skip.unparsed}）`);
console.log(`\n=== 完美統一（引用／覆蓋／分離／資料 全成立）：${perfect.length.toLocaleString()} / ${total.toLocaleString()} = ${pct(perfect.length)} ===`);
console.log(`=== 可用（點得到・墨都有主・分得開；內部可能是筆劃）：${usable.length.toLocaleString()} / ${total.toLocaleString()} = ${pct(usable.length)} ===\n`);

const flag = (name: string, f: (r: Row) => boolean, bad: string) => {
  const okN = rows.filter(f).length;
  console.log(`  ${name.padEnd(24)} 成立 ${pct(okN).padStart(6)}（${okN.toLocaleString().padStart(8)}）　` +
    `不成立 ${pct(total - okN).padStart(6)}（${(total - okN).toLocaleString().padStart(8)}）　${bad}`);
};
console.log("各條件（分母＝全部有算子標註的字形）：");
flag("分量都是 KAGE 引用", (r) => r.isRef, "有分量是筆劃畫的（不是引用）");
flag("沒有看不到的引用", (r) => r.extraRefs === 0, "有引用不在標註的分量裡");
flag("引用數＝分量數", (r) => r.refMatch, "數量不符");
flag("墨都有主（覆蓋 ≥99%）", okCov, "有墨不屬於任何有名字的部件");
flag("部件分得開（重疊 ≤3%）", okOvl, "部件的墨互相重疊");
flag("看得到就點得到", (r) => r.addressable, "有分量引擎定不到槽位");
flag("分量順序符合算子", (r) => r.orderOk, "左右／上下順序與 IDS 相反");
flag("分量都有碼位", (r) => r.named, "有 &NAME; 這種沒有碼位的分量");
flag("分量都在字庫", (r) => r.inLib, "有分量不在字庫裡");

const covs = rows.map((r) => r.coverage).sort((a, b) => a - b);
const q = (p: number) => covs.length ? (covs[Math.floor(covs.length * p)]! * 100).toFixed(1) + "%" : "-";
console.log(`\n覆蓋率分佈（整字的墨有多少落在有名字的部件裡）：` +
  `10% 分位 ${q(0.1)} / 中位 ${q(0.5)} / 90% ${q(0.9)}`);
if (inkTotals.ink) {
  console.log(`墨的總量（含獨體字）：有部件名字的墨 ${(inkTotals.owned / inkTotals.ink * 100).toFixed(1)}%` +
    `、沒有名字的 ${((1 - inkTotals.owned / inkTotals.ink) * 100).toFixed(1)}%` +
    `（墨總量 ${inkTotals.ink.toLocaleString()} 格；獨體字佔 ${(inkTotals.atomicInk / inkTotals.ink * 100).toFixed(0)}%）`);
}
const hist = new Map<string, number>();
for (const r of rows) {
  const b = r.coverage >= 0.999 ? "100%" : r.coverage >= 0.9 ? "90-99%" : r.coverage >= 0.5 ? "50-90%" : r.coverage >= 0.1 ? "10-50%" : "<10%";
  hist.set(b, (hist.get(b) ?? 0) + 1);
}
for (const b of ["100%", "90-99%", "50-90%", "10-50%", "<10%"]) {
  const v = hist.get(b) ?? 0;
  console.log(`  ${b.padStart(7)}  ${String(v).padStart(8)}  ${pct(v).padStart(6)}`);
}

const combo = new Map<string, number>();
for (const r of rows) {
  const bad: string[] = [];
  if (!r.named) bad.push("分量無碼位");
  if (!r.inLib) bad.push("分量不在庫");
  if (!r.isRef) bad.push("非引用");
  if (r.extraRefs) bad.push("有隱藏引用");
  if (!okCov(r)) bad.push("有無主墨");
  if (!okOvl(r)) bad.push("部件墨重疊");
  if (!r.addressable) bad.push("點不到");
  combo.set(bad.length ? bad.join("+") : "（完美）", (combo.get(bad.length ? bad.join("+") : "（完美）") ?? 0) + 1);
}
console.log("\n失敗組合（前 12 名）：");
[...combo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  .forEach(([k, v]) => console.log(`  ${String(v).padStart(8)}  ${pct(v).padStart(6)}  ${k}`));

/* 分流：要讓它「統一」，每一類各自要動什麼 */
{
  const tri = new Map<string, number>();
  for (const r of rows) {
    if (perfectSet.has(r)) continue;
    const k = !r.named ? "① 分量沒有碼位（&NAME;）→ 要先決定怎麼命名"
      : !r.inLib ? "② 分量不在字庫 → 缺字形"
      : (!r.isRef || r.extraRefs) ? "③ 畫法不是引用（把畫法改成引用即可）"
      : !okCov(r) ? "④ 有無主墨（筆劃不屬於任何分量）"
      : !okOvl(r) ? "⑤ 分量的墨重疊"
      : !r.addressable ? "⑥ 引擎定不到槽位"
      : "⑦ 其他";
    tri.set(k, (tri.get(k) ?? 0) + 1);
  }
  console.log("\n要統一的話，各類要動什麼（依上面優先序，不重複計）：");
  [...tri.entries()].sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${String(v).padStart(8)}  ${pct(v).padStart(6)}  ${k}`));
  /* ③（把畫法改成引用）的區段分佈與例子——這是「動畫法就能統一」的那一批 */
  const tri3 = rows.filter((r) => !perfectSet.has(r) && r.named && r.inLib && (!r.isRef || r.extraRefs));
  const b3 = new Map<string, number>();
  for (const r of tri3) b3.set(blockOf(r.cp), (b3.get(blockOf(r.cp)) ?? 0) + 1);
  console.log(`\n③ 的區段分佈：` + [...b3.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toLocaleString()}`).join("　"));
  const rank = (cp: number) => cp >= 0x4e00 && cp <= 0x9fff ? 0 : cp >= 0x3400 && cp <= 0x4dbf ? 1 : 2;
  console.log("③ 的例子（基本區優先，依覆蓋率低到高）：");
  for (const r of tri3.slice().sort((a, b) => rank(a.cp) - rank(b.cp) || a.coverage - b.coverage).slice(0, 20)) {
    console.log(`  ${r.ch} ${r.op}${r.parts.join("")}　引用 ${r.nRefs}／分量 ${r.nParts}・覆蓋 ${(r.coverage * 100).toFixed(0)}%` +
      `${r.extraRefs ? "・隱藏引用 " + r.extraRefs : ""}`);
  }
}

console.log("\n依算子（完美率／可用率）：");
const byOp = new Map<string, { n: number; p: number; u: number }>();
for (const r of rows) {
  const e = byOp.get(r.op!) ?? { n: 0, p: 0, u: 0 };
  e.n++; if (perfectSet.has(r)) e.p++; if (usableSet.has(r)) e.u++;
  byOp.set(r.op!, e);
}
[...byOp.entries()].sort((a, b) => b[1].n - a[1].n)
  .forEach(([op, e]) => console.log(`  ${op}  ${String(e.n).padStart(8)}　完美 ${pct(e.p, e.n).padStart(6)}　可用 ${pct(e.u, e.n).padStart(6)}`));

const show = (title: string, list: Row[], k = SHOW) => {
  console.log(`\n${title}（共 ${list.length.toLocaleString()} 個）`);
  for (const r of list.slice(0, k)) {
    console.log(`  ${r.ch} ${r.op}${r.parts.join("")}　引用 ${r.nRefs}／分量 ${r.nParts}・覆蓋 ${(r.coverage * 100).toFixed(0)}%・重疊 ${(r.overlap * 100).toFixed(0)}%` +
      `${r.addressable ? "" : "・點不到"}${r.isRef ? "" : "・非引用"}${r.extraRefs ? "・隱藏引用 " + r.extraRefs : ""}`);
  }
};
show("完美統一的例子：", perfect);
show("有無主墨（看得到、但沒有部件名字）：", rows.filter((r) => !okCov(r)).sort((a, b) => a.coverage - b.coverage));
show("分量不是引用（內部用筆劃畫）：", rows.filter((r) => !r.isRef && okCov(r)));
show("部件的墨重疊：", rows.filter((r) => !okOvl(r)).sort((a, b) => b.overlap - a.overlap));
show("看得到但點不到：", rows.filter((r) => !r.addressable));

/* 依 Unicode 區段（常用字更重要） */
console.log("\n依 Unicode 區段（完美率／可用率）：");
const byBlock = new Map<string, { n: number; p: number; u: number; ink: number; owned: number }>();
for (const r of rows) {
  const b = blockOf(r.cp);
  const e = byBlock.get(b) ?? { n: 0, p: 0, u: 0, ink: 0, owned: 0 };
  e.n++; if (perfectSet.has(r)) e.p++; if (usableSet.has(r)) e.u++;
  e.ink += r.ink; e.owned += r.ink * r.coverage;
  byBlock.set(b, e);
}
[...byBlock.entries()].sort((a, b) => b[1].n - a[1].n)
  .forEach(([b, e]) => console.log(`  ${b.padEnd(22)} ${String(e.n).padStart(8)}　完美 ${pct(e.p, e.n).padStart(6)}　可用 ${pct(e.u, e.n).padStart(6)}　` +
    `墨有名字 ${(e.owned / Math.max(1, e.ink) * 100).toFixed(1)}%`));

if (atomicRefs.length) {
  console.log(`\n標註獨體、內部卻有引用：${atomicRefs.length.toLocaleString()} 個（${pct(atomicRefs.length, skip.atomic)}）　例：${atomicRefs.slice(0, 20).join("、")}`);
}

if (OUT) {
  writeFileSync(OUT, reportLines.join("\n") + "\n", "utf8");
  console.log(`\n（報告已寫入 ${OUT}）`);
}
