#!/usr/bin/env bun
/**
 * probe-ids-base.ts — **給定 IDS，找最適合當基字的字**（師父第 115 輪的問題 ✓）。
 *
 * 師父問：「如果我給你 IDS 呢，『⿰木⿳金⿰水火土』你能找到適合的基字嗎？」
 *
 * 這一問把「擬合」變成**精確查詢** ✓：
 *   · 目標的**運算子骨架**（例 `⿰ · ⿳ · ⿰ · ·`）就是槽位結構 ✓
 *   · 部件可以換掉 ✓、**骨架不能變** ✓ → 拿骨架去 `ids/ids_lv1.txt` 精確比對 ✓
 *   · 骨架相同 ⇒ **葉序一一對應** ✓ → 構形序就是把第 i 個葉換成目標的第 i 個葉 ✓
 *     （不必再猜佈局、也不必模板比對 ✓✓——這是本輪最大的收穫 ✓）
 *
 * 用法:
 *   bun run tools/probe-ids-base.ts --ids "⿰木⿳金⿰水火土" [--image out/_mask-elements.txt] [--top 12]
 *   bun run tools/probe-ids-base.ts --ids "⿱⿰臣又土" [--top 5]        # 也可以查別人的骨架 ✓
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as F from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { loadIdsFile } from "./ids-source.ts";
import { ensureEngine, svgOf } from "./compose-fit.ts";
import { drawingIdx, evalSeq } from "./free-compose.ts";
import { rasterize } from "./raster.ts";
import { normalizedMask } from "./shape-similarity.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const IDS = arg("--ids");
if (!IDS) { console.error('用法：bun run tools/probe-ids-base.ts --ids "⿰木⿳金⿰水火土"'); process.exit(1); }
const IMAGE = arg("--image");
/** 原圖檔（用來放在並排圖的左邊 ✓）——**不要從 mask 檔名去猜** ✗（第 115 輪拼錯過一次 ✓） */
const PNG = arg("--png");
const TOP = Number(arg("--top", "12"));
const SIZE = 48;

/* ---------------- IDS 解析（只處理算子／葉，其餘當「非葉」✗） ---------------- */
const ARITY: Record<string, number> = {
  "⿰": 2, "⿱": 2, "⿲": 3, "⿳": 3, "⿴": 2, "⿵": 2, "⿶": 2, "⿷": 2,
  "⿸": 2, "⿹": 2, "⿺": 2, "⿻": 2,
};
type Node = { op: string; kids: Node[] } | { ch: string };
/** 解析一個 IDS 序列；遇到解析不了的東西（`&NAME;`、`{…}`、`#…`）回 null ✓ */
function parse(s: string): Node | null {
  const chars = Array.from(s);
  let i = 0;
  function walk(): Node | null {
    if (i >= chars.length) return null;
    const c = chars[i]!;
    if (c === "&" || c === "{" || c === "[" || c === "#" || c === "(") return null;
    if (ARITY[c] !== undefined) {
      i++;
      const op = c;
      const kids: Node[] = [];
      for (let k = 0; k < ARITY[op]!; k++) {
        const kid = walk();
        if (!kid) return null;
        kids.push(kid);
      }
      return { op, kids };
    }
    i++;
    return { ch: c };
  }
  const root = walk();
  if (!root || i !== chars.length) return null;
  return root;
}
/** 骨架：算子保留、葉換成 `·` ✓（例 `⿰·⿳·⿰··`） */
function skeleton(n: Node): string {
  if ("ch" in n) return "·";
  return n.op + n.kids.map(skeleton).join("");
}
/** 葉（照序 ✓） */
function leaves(n: Node, out: string[] = []): string[] {
  if ("ch" in n) { out.push(n.ch); return out; }
  for (const k of n.kids) leaves(k, out);
  return out;
}

const targetTree = parse(IDS);
if (!targetTree) { console.error(`解析不了這個 IDS ✗：${IDS}`); process.exit(1); }
const targetSkel = skeleton(targetTree);
const targetLeaves = leaves(targetTree);
console.log(`目標 IDS：${IDS}`);
console.log(`  骨架：${targetSkel}`);
console.log(`  葉序：${targetLeaves.join(" ")}（${targetLeaves.length} 個 ✓）`);

const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();
const ch = (cp: number) => { try { return String.fromCodePoint(cp); } catch { return "?" }; };
const hex = (cp: number) => "U+" + cp.toString(16).toUpperCase();

/* ---------------- 依骨架反查（只比結構，不比部件 ✓） ---------------- */
const tab = loadIdsFile(resolve(ROOT, "ids/ids_lv1.txt"));
console.log(`\nIDS 來源：ids/ids_lv1.txt（${tab.size.toLocaleString()} 個字有分解 ✓）`);

interface Cand { cp: number; skel: string; leaves: string[]; strokes: number }
const cands: Cand[] = [];
let sameSkel = 0;
for (const [cp, entry] of tab) {
  if (!entry.primary.length) continue;
  const t = parse(entry.primary[0]!);
  if (!t) continue;
  const sk = skeleton(t);
  if (sk !== targetSkel) continue;
  sameSkel++;
  const gi = F.indexOfCodePoint(lib, cp);
  if (gi === undefined) continue;                       /* 要畫得出來才當得了基字 ✓ */
  const di = drawingIdx(lib, gi);
  const g = lib.glyphs[di]!;
  cands.push({ cp, skel: sk, leaves: leaves(t), strokes: g.strokes.filter((s: any) => s.kind !== 0).length });
}
/* 排序：筆劃少（簡單）✓、一般漢字區優先 ✓、碼位小 ✓ */
const isBmp = (cp: number) => cp >= 0x4e00 && cp <= 0x9fff;
cands.sort((a, b) => a.strokes - b.strokes ||
  (isBmp(b.cp) ? 1 : 0) - (isBmp(a.cp) ? 1 : 0) || a.cp - b.cp);
console.log(`骨架相同（${targetSkel}）的字：**${sameSkel} 個** ✓（其中字庫畫得出來的 ${cands.length} 個）`);

/* ---------------- 產構形序：第 i 個葉 → 目標第 i 個葉 ✓ ---------------- */
interface Fit { cp: number; seq: string; v: number; svg: string; pairs: string }
const fits: Fit[] = [];
let img: Uint8Array | null = null;
function iou(a: Uint8Array, b: Uint8Array, shift = 1): number {
  let best = 0;
  for (let dy = -shift; dy <= shift; dy++) for (let dx = -shift; dx <= shift; dx++) {
    let inter = 0, uni = 0;
    for (let y = 0; y < SIZE; y++) {
      const sy = y + dy; if (sy < 0 || sy >= SIZE) continue;
      for (let x = 0; x < SIZE; x++) {
        const sx = x + dx; if (sx < 0 || sx >= SIZE) continue;
        const A = a[sy * SIZE + sx]!, B = b[y * SIZE + x]!;
        if (A && B) inter++;
        if (A || B) uni++;
      }
    }
    const v = uni ? inter / uni : 0;
    if (v > best) best = v;
  }
  return best;
}
if (IMAGE) {
  const lines = readFileSync(resolve(ROOT, IMAGE), "utf8").trim().split(/\r?\n/);
  img = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) img[y * SIZE + x] = (lines[y] ?? "")[x] === "1" ? 1 : 0;
}

for (const c of cands.slice(0, Math.max(TOP, 12))) {
  /* 葉序一一對應 ✓（骨架相同 ⇒ 位置也相同 ✓） */
  const pairs: [number, number][] = [];
  let ok = true;
  for (let i = 0; i < targetLeaves.length; i++) {
    const oldCh = c.leaves[i], newCh = targetLeaves[i];
    if (!oldCh || !newCh) { ok = false; break; }
    const o = oldCh.codePointAt(0)!, n = newCh.codePointAt(0)!;
    if (o === n) continue;                       /* 同一個部件就不必換 ✓ */
    pairs.push([o, n]);
  }
  if (!ok) continue;
  let seq = ch(c.cp);
  for (const [o, n] of pairs) seq += ch(o) + ch(n);
  let v = 0, svg = "";
  try {
    const r = evalSeq(lib, seq, {});
    if (r && r.ok) {
      svg = svgOf(r.lib, r.targetIdx);
      if (img) {
        const di = r.targetIdx;
        const kage = new Kage();
        const seen = new Set<number>(), stack = [di];
        while (stack.length) {
          const j = stack.pop()!;
          if (seen.has(j)) continue;
          seen.add(j);
          kage.kBuhin.push(F.keyOfIdx(r.lib, j), F.toKageData(r.lib.glyphs[j]!, r.lib));
          for (const s of r.lib.glyphs[j]!.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
        }
        const rast = rasterize(kage, F.keyOfIdx(r.lib, di), SIZE, 1);
        const m = normalizedMask(rast, SIZE);
        if (m) v = iou(img, m);
      }
    }
  } catch { /* 組不出來就當 0 ✓ */ }
  fits.push({ cp: c.cp, seq, v, svg,
    pairs: pairs.map(([o, n]) => `${ch(o)}→${ch(n)}`).join("　") || "（完全一樣，不必換 ✓）" });
}
fits.sort((a, b) => b.v - a.v || a.cp - b.cp);
console.log(`\n擬合（葉序一一對應 ✓${IMAGE ? "、和原圖算 IoU ✓" : ""}）：`);
for (const f of fits.slice(0, TOP)) {
  console.log(`  ${f.v.toFixed(3)}　${hex(f.cp)} ${ch(f.cp)}　序：${f.seq}` +
    `\n         換：${f.pairs}`);
}
if (fits.length) {
  console.log(`\n★ 最佳基字：${hex(fits[0]!.cp)} ${ch(fits[0]!.cp)}　構形序：${fits[0]!.seq}` +
    (img ? `　IoU ${fits[0]!.v.toFixed(3)}` : ""));
  /* 並排圖（原圖 ＋ 前三名 ✓） */
  const cells = fits.slice(0, 3).map((f) => `<div class="c"><div class="g">${f.svg}</div><div>${hex(f.cp)} ${ch(f.cp)}（IoU ${f.v.toFixed(3)}）</div></div>`).join("");
  const imgCell = PNG
    ? `<div class="c"><img src="file:///${resolve(ROOT, PNG).replace(/\\/g, "/")}" style="width:220px;height:220px;filter:invert(1)"><div>原圖 ${PNG}</div></div>`
    : "";
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#0b0c0e;color:#e8ecf4;font:13px system-ui,"Microsoft JhengHei",sans-serif}
    .row{display:flex;gap:10px;padding:10px}.c{background:#15171b;border:1px solid #2a2e35;border-radius:10px;padding:6px;text-align:center}
    .g{width:220px;height:220px}.g svg{width:100%;height:100%;display:block}
  </style></head><body><div class="row">${imgCell}${cells}</div></body></html>`;
  const page = resolve(ROOT, "out/_ids-base-probe.html");
  const fs = await import("node:fs");
  fs.writeFileSync(page, html, "utf8");
  const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const shot = resolve(ROOT, "out/ids-base-fit.png");
  if (fs.existsSync(EDGE)) {
    if (fs.existsSync(shot)) fs.unlinkSync(shot);
    Bun.spawnSync([EDGE, "--headless", "--disable-gpu", `--screenshot=${shot}`, "--window-size=1000,300",
      "--hide-scrollbars", `file:///${page.replace(/\\/g, "/")}`], { stdout: "ignore", stderr: "ignore" });
    console.log(`並排圖：${shot}`);
  }
}
