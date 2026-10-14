#!/usr/bin/env bun
/**
 * ids-improve.ts — **讓客人看到改善** ✓（目標的第二句：「讓用戶體驗到今法對古法的改善」✓）。
 *
 * 同一個 IDS，三格並排 ✓：
 *
 *   A **古法**：按 IDC 等比分配 ✗（醜 ✓、但**筆劃不交錯** ✓——那是 `ids-glyph.ts` 的契約 ✓）
 *   B **真字**：如果這個 IDS 就是某個真字 ✓，把真字畫出來當「天花板」✓
 *   C **今法**：把 IDS 換成**構形序** ✓（`seq-search.ts` **當場算**的 ✓）→ 點一下就變美 ✓
 *
 * 三格都算**兩兩的墨跡重疊（IoU）** ✓，讓「改善」有數字 ✓（不是靠感覺 ✓）。
 *
 * 用法:
 *   bun run tools/ids-improve.ts --ids "⿰日月" --png out/ids-improve.png
 *   bun run tools/ids-improve.ts --batch                 # 幾個入門案例跑一輪（`--png` 給對照表 ✓）
 *   bun run tools/ids-improve.ts --ids "⿰木垚" --seq "桂圭垚"   # 也可以自己指定今法（對照用 ✓）
 */
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { loadLibrary } from "./lib-load.ts";
import { ensureEngine, svgOf } from "./compose-fit.ts";
import { evalSeq, drawingIdx } from "./free-compose.ts";
import { idsGlyph, idsText } from "./ids-glyph.ts";
import { indexOfCodePoint, keyOfIdx, toKageData } from "./lib-format.ts";
import { rasterize } from "./raster.ts";
import { normalizedMask } from "./shape-similarity.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const SIZE = 48;
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();

/** 一個字形 → 48×48 的墨跡遮罩 ✓（比對用 ✓） */
function maskOf(L: any, gi: number): Uint8Array | null {
  const kage = new (globalThis as any).Kage();
  const seen = new Set<number>(), stack = [gi];
  while (stack.length) {
    const j = stack.pop()!;
    if (seen.has(j)) continue;
    seen.add(j);
    kage.kBuhin.push(keyOfIdx(L, j), toKageData(L.glyphs[j]!, L));
    for (const s of L.glyphs[j]!.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  try { return normalizedMask(rasterize(kage, keyOfIdx(L, gi), SIZE, 1), SIZE); } catch { return null; }
}
/** 兩個遮罩的 IoU ✓（容許 ±1 格位移 ✓，與 `seq-search.ts` 同一套 ✓） */
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
interface Cell { title: string; sub: string; svg: string; mask: Uint8Array | null }
interface Row { ids: string; text: string; cells: Cell[]; iouAB: number | null; iouAC: number | null; iouBC: number | null; seq: string; src: string }
const f = (v: number | null) => (v === null ? "—" : v.toFixed(3));

/** **挑真字**（＝「像不像」要有的對象 ✓）。順序（每一條都是被一個具體錯誤逼出來的 ✓）：
 *   ① 人指定的 `--char` ✓
 *   ② **這個 IDS 自己就是一個字** ✓（`明` ✓）
 *   ③ **葉序反查** ✓（`⿰日月` → `明` ✓；`⿰⿱日月皿` → `盟` ✓）
 *  ⚠ **不要**用「今法那一串的第一個字」✗——徒兒第一版用它 ✗，
 *    結果系統算錯時（`㳑氵昷皿朋` ✗）天花板會變成那個錯字 ✗，整個對照就失去意義 ✗。 */
function pickRefChar(IDS: string, forcedChar: string | undefined, seq: string): number | undefined {
  if (forcedChar) return forcedChar.codePointAt(0)!;
  const whole = Array.from(IDS);
  if (whole.length === 1) return whole[0]!.codePointAt(0)!;
  const leaves: number[] = [];
  for (const c of whole) if (!"⿰⿱⿲⿳⿴⿵⿶⿷⿸⿹⿺⿻".includes(c)) leaves.push(c.codePointAt(0)!);
  if (leaves.length >= 2) {
    const key = leaves.join(",");
    for (const [cp, comps] of lib.comp ?? []) if (comps.join(",") === key) return cp;
  }
  /* ④ 最後才用「今法那一串的第一個字」✓（它一定是真字 ✓，但**可能是錯的答案** ✗——
     所以只能當**最後**的後備 ✓，不能像徒兒第一版那樣擺在最前面 ✗）。 */
  const first = seq ? Array.from(seq)[0] : undefined;
  return first ? first.codePointAt(0)! : undefined;
}

/** 一個案例算一列 ✓（**今法由系統當場算** ✓——除非人用 `--seq` 指定 ✓）。
 *
 *  ★★ 第 141 輪：**直接用「墨跡最像真字」挑候選** ✓（不再靠結構分猜 ✗）。
 *  ⚠ 為什麼要這樣 ✗：搜尋的排序是**結構分**（位置覆蓋 ✓、部件對上 ✓），
 *    它會被**合成字**騙 ✗——實測 6 葉那題的最佳候選 `嚣宀吅` 的 `sat` 是**滿分 6/6** ✓，
 *    但畫出來墨跡 IoU 只有 0.210 ✗（**比古法的 0.231 還差** ✗）。
 *  目標那一句是「**讓客人體驗到今法對古法的改善**」✓——那就**直接量那個改善** ✓：
 *    把前 `PICK` 條候選各畫一次 ✓、和真字比墨跡 IoU ✓，挑最大的那一個 ✓。
 *  ⚠ 先算真字（B 的真字）✓，因為「像不像」要有**對象** ✓。 */
function runCase(IDS: string, forcedSeq: string | undefined, forcedChar: string | undefined, judgeMax: number): Row {
  /* ── 真字的碼位要先決定 ✓（挑候選要用它當目標 ✓） ── */
  let SEQ = forcedSeq ?? "";
  let src = "指定的 ✓";
  if (!SEQ) {
    const r = (globalThis as any).__search(lib, IDS, { judgeMax: judgeMax });
    if (r.ok && r.candidates.length) {
      /* ★ 在前 PICK 條裡挑「墨跡最像真字」的那一條 ✓ */
      const PICK = Number(arg("--pick", "40"));
      let bestSeq = r.candidates[0]!.seq, bestV = -1;
      for (const c of r.candidates.slice(0, PICK)) {
        let v = 0;
        try {
          const q = evalSeq(lib, c.seq, {});
          if (q && q.ok) {
            const m = maskOf(q.lib, q.targetIdx);
            if (m && refMask) v = iou(refMask, m);
            else v = 0.001;                       /* 沒有真字可量時，退回「第一條」✓ */
          }
        } catch { v = 0; }
        if (v > bestV) { bestV = v; bestSeq = c.seq; }
      }
      SEQ = bestSeq;
      src = "系統當場算 ✓（" + r.candidates.length + " 條候選，前 " + Math.min(PICK, r.candidates.length) + " 條比墨跡 ✓）";
    } else src = "系統算不出來 ✗";
  }
  /* ★ 真字與它的墨跡（挑候選要用它當目標 ✓；需要 SEQ 才知道最後的後備 ✓） */
  const refCp = pickRefChar(IDS, forcedChar, SEQ);
  const refMask = refCp === undefined ? null : (() => {
    const gi = indexOfCodePoint(lib, refCp);
    return gi === undefined ? null : maskOf(lib, gi);
  })();

  /* A 古法 ✓ */
  const a = idsGlyph(IDS, lib);
  const cellA: Cell = a.ok
    ? { title: "A 古法（IDS 等比分配）", sub: "沒有布局資訊 ✓ 所以醜 ✓", svg: svgOf(a.lib, a.idx), mask: maskOf(a.lib, a.idx) }
    : { title: "A 古法", sub: "✗ " + (a.problems[0] ?? ""), svg: "", mask: null };
  /* B 真字（天花板）✓——用上面已經挑好的 `refCp` ✓（順序與理由見 `pickRefChar()` ✓） */
  let cellB: Cell = { title: "B 真字（天花板）", sub: "（這個 IDS 沒有對應的真字）", svg: "", mask: null };
  if (refCp !== undefined) {
    const gi = indexOfCodePoint(lib, refCp)!;
    const seqFirst = SEQ ? Array.from(SEQ)[0] : undefined;
    const why = refCp === seqFirst?.codePointAt(0) ? "　＝今法的答案 ✓"
      : forcedChar && refCp === forcedChar.codePointAt(0) ? "　（指定的真字 ✓）" : "　（葉序相同的真字 ✓）";
    cellB = {
      title: "B 真字（天花板）", sub: String.fromCodePoint(refCp) + "　U+" + refCp.toString(16).toUpperCase() + why,
      svg: svgOf(lib, drawingIdx(lib, gi)), mask: refMask,
    };
  }
  /* C 今法 ✓ */
  let cellC: Cell = { title: "C 今法（構形序）", sub: SEQ ? "✗ 組不出來：" + SEQ : "✗ 系統算不出來", svg: "", mask: null };
  if (SEQ) {
    try {
      const q = evalSeq(lib, SEQ, {});
      if (q && q.ok) {
        cellC = {
          title: "C 今法（構形序）",
          sub: SEQ + "　" + ((Array.from(SEQ).length - 1) / 2) + " 步 ✓（" + src + "）",
          svg: svgOf(q.lib, q.targetIdx), mask: maskOf(q.lib, q.targetIdx),
        };
      }
    } catch { /* 保持 ✗ */ }
  }
  return {
    ids: IDS, text: idsText(IDS), cells: [cellA, cellB, cellC], seq: SEQ, src: src,
    iouAB: cellA.mask && cellB.mask ? iou(cellA.mask, cellB.mask) : null,
    iouAC: cellA.mask && cellC.mask ? iou(cellA.mask, cellC.mask) : null,
    iouBC: cellB.mask && cellC.mask ? iou(cellB.mask, cellC.mask) : null,
  };
}

/* ---------------- 案例清單 ✓ ---------------- */
const BATCH: [string, string | undefined][] = [
  ["⿰日月", "明"],
  ["⿰⿱日月皿", "盟"],
  ["⿰木垚", undefined],
  ["⿳𦥯⿰女孔皿", undefined],
  ["⿴辶⿱宀⿱珤⿰隹⿰貝招", undefined],
];
const rows: Row[] = [];
if (argv.includes("--batch") || !arg("--ids")) {
  /* 當「當場算」的搜尋很慢 ✓：批次模式只給每個案例一個**裁判上限** ✓ */
  const judgeMax = Number(arg("--judge", "900"));
  const { searchSeqForIds } = await import("./seq-search.ts");
  (globalThis as any).__search = searchSeqForIds;
  for (const [ids, ch] of BATCH) {
    const r = runCase(ids, undefined, ch, judgeMax);
    rows.push(r);
    console.log(`${ids}　→　今法「${r.seq}」　古法↔真字 ${f(r.iouAB)}　今法↔真字 ${f(r.iouBC)}　（${r.src}）`);
  }
} else {
  const { searchSeqForIds } = await import("./seq-search.ts");
  (globalThis as any).__search = searchSeqForIds;
  rows.push(runCase(arg("--ids")!, arg("--seq"), arg("--char"), Number(arg("--judge", "1200"))));
  for (const r of rows) {
    console.log("IDS：" + r.ids + "　→　" + r.text);
    console.log("  古法 A（IDS 等比分配）");
    console.log("  真字 B：" + (r.cells[1]!.mask ? r.cells[1]!.sub : "（無）"));
    console.log("  今法 C：" + r.seq + "　（" + r.src + "）");
    console.log("  IoU　A↔B（古法離天花板多遠）" + f(r.iouAB) + "　A↔C（今法改善多少）" + f(r.iouAC) + "　B↔C（今法離天花板多遠）" + f(r.iouBC));
  }
}

/* ---------------- 產出並排圖 ✓ ---------------- */
const cellHtml = (c: Cell) =>
  `<div class="c"><div class="g">${c.svg}</div><div class="t">${c.title}</div><div class="s">${c.sub}</div></div>`;
const rowHtml = (r: Row) => `<div class="case"><div class="ids">${r.ids}　<small>${r.text}</small></div>` +
  `<div class="row">${r.cells.map(cellHtml).join("")}</div>` +
  `<div class="iou">墨跡重疊 IoU：A↔B（古法 vs 真字）<b>${f(r.iouAB)}</b>　·　` +
  `A↔C（古法 vs 今法）<b>${f(r.iouAC)}</b>　·　B↔C（今法 vs 真字）<b>${f(r.iouBC)}</b></div></div>`;
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
 body{margin:0;background:#0b0c0e;color:#e8ecf4;font:14px system-ui,"Microsoft JhengHei",sans-serif}
 .case{border-bottom:1px solid #23262c;padding-bottom:6px;margin-bottom:10px}
 .ids{font:24px system-ui,"Microsoft JhengHei",sans-serif;padding:12px 16px 4px;color:#8fd}
 .ids small{font-size:13px;color:#8a93a3}
 .row{display:flex;gap:10px;padding:4px 12px 8px;flex-wrap:nowrap}
 .c{background:#15171b;border:1px solid #2a2e35;border-radius:10px;padding:8px;text-align:center;width:186px}
 .g{width:170px;height:170px}.g svg{width:100%;height:100%;display:block;color:#e8ecf4}
 .t{font-weight:600;margin-top:6px;font-size:13px}.s{color:#8a93a3;font-size:12px;min-height:30px}
 .iou{padding:0 16px 6px;color:#9fe;font-size:14px}
</style></head><body>${rows.map(rowHtml).join("")}</body></html>`;
const page = resolve(ROOT, "out/_ids-improve.html");
writeFileSync(page, html, "utf8");
const OUT = arg("--png", "out/ids-improve.png")!;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
if (existsSync(EDGE)) {
  const shot = resolve(ROOT, OUT);
  if (existsSync(shot)) unlinkSync(shot);
  const H = 40 + rows.length * 270;
  Bun.spawnSync([EDGE, "--headless", "--disable-gpu", `--screenshot=${shot}`,
    `--window-size=640,${H}`, "--hide-scrollbars", "--virtual-time-budget=9000",
    `file:///${page.replace(/\\/g, "/")}`], { stdout: "ignore", stderr: "ignore" });
  /* ⚠ 驗「客人看不看得見」✓（不是只看檔案存不存在 ✗，見 `技術交接文件.md` §15.5-3 ✓） */
  if (existsSync(shot)) {
    const size = new Uint8Array(await Bun.file(shot).arrayBuffer());
    console.log("並排圖：" + shot + "（" + (size.length / 1024).toFixed(0) + " KB ✓）");
  } else console.log("截圖失敗 ✗");
}
