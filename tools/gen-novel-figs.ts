#!/usr/bin/env bun
/**
 * gen-novel-figs.ts — 產《構形記》插圖（SVG）。
 *
 * 用法:
 *   bun run tools/gen-novel-figs.ts                 # 產全部
 *   bun run tools/gen-novel-figs.ts --only 1-1,1-3  # 只產指定幾張
 *   bun run tools/gen-novel-figs.ts --list          # 列出圖號與標題
 *   bun run tools/gen-novel-figs.ts --out <dir>     # 換輸出目錄（預設 novel/figs）
 *
 * 原則（見 novel/插圖計畫.md）：
 *   · 字形一律用自家字庫的 KAGE 外框（svgOf），不用系統字型——罕用字會變豆腐。
 *   · 只用 currentColor 與 opacity，四套主題自動適用；不畫白底。
 *   · 圖號由檔名決定；正文與圖說不手寫號碼。
 *   · 圖上不出現技術細節；示意的地方標「示意」。
 */
import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadLibrary } from "./lib-load.ts";
import { findGlyphIndex } from "./lib-format.ts";
import { ensureEngine, svgOf } from "./compose-fit.ts";

const ROOT = resolve(import.meta.dir, "..");
const { lib } = loadLibrary(join(ROOT, "out/lib-cjk-all.bin.gz"));
ensureEngine();

const FONT = `'Songti SC','SimSun','Noto Serif CJK TC','Source Han Serif TC',serif`;
const MONO = `'Cascadia Mono','Consolas','Courier New',monospace`;

// ─────────────────────────────────────────────────────────── 基本工具

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 字寬估算：全形 1em、半形 0.55em */
function tw(s: string, size: number): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w += c > 0x2e80 ? size : size * 0.55;
  }
  return w;
}

let FIG = "";
const gid = (k: string) => `${k}-${FIG}`;

function glyphInner(ch: string): string {
  const cp = ch.codePointAt(0)!;
  const idx = findGlyphIndex(lib, "u" + cp.toString(16));
  if (idx === undefined) throw new Error(`字庫沒有「${ch}」U+${cp.toString(16).toUpperCase()}`);
  const s = svgOf(lib, idx);
  return s
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>[\s\S]*$/, "")
    .replace(/fill="black"/g, 'fill="currentColor"');
}

/** 置字：x,y 為左上角，size 為邊長 */
function g(ch: string, x: number, y: number, size: number, op = 1): string {
  const o = op < 1 ? ` opacity="${op}"` : "";
  return `<g transform="translate(${x},${y}) scale(${size / 200})"${o}>${glyphInner(ch)}</g>`;
}

type T = {
  size?: number;
  anchor?: "start" | "middle" | "end";
  weight?: number;
  op?: number;
  mono?: boolean;
  lh?: number;
  italic?: boolean;
};

function txt(s: string, x: number, y: number, o: T = {}): string {
  const size = o.size ?? 13;
  const anchor = o.anchor ?? "start";
  const op = o.op ?? 1;
  const weight = o.weight ?? 400;
  const fam = o.mono ? MONO : FONT;
  const lines = s.split("\n");
  const lh = o.lh ?? size * 1.45;
  const body = lines
    .map(
      (ln, i) =>
        `<text x="${x}" y="${y + i * lh}" font-size="${size}" font-family="${fam}" ` +
        `text-anchor="${anchor}" fill="currentColor" stroke="none" font-weight="${weight}"` +
        `${op < 1 ? ` opacity="${op}"` : ""}${o.italic ? ` font-style="italic"` : ""}>${esc(ln)}</text>`,
    )
    .join("");
  return body;
}

type L = { w?: number; op?: number; dash?: string; cap?: string };

function line(x1: number, y1: number, x2: number, y2: number, o: L = {}): string {
  return (
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" fill="none" stroke="currentColor" ` +
    `stroke-width="${o.w ?? 1.2}" opacity="${o.op ?? 1}"` +
    `${o.dash ? ` stroke-dasharray="${o.dash}"` : ""} stroke-linecap="${o.cap ?? "round"}"/>`
  );
}

function rect(
  x: number, y: number, w: number, h: number,
  o: { fill?: number; stroke?: number; dash?: string; r?: number; sw?: number } = {},
): string {
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.r ?? 3}" ` +
    `fill="currentColor" fill-opacity="${o.fill ?? 0}" ` +
    `stroke="currentColor" stroke-opacity="${o.stroke ?? 1}" stroke-width="${o.sw ?? 1.2}"` +
    `${o.dash ? ` stroke-dasharray="${o.dash}"` : ""}/>`
  );
}

function path(d: string, o: { fill?: number; w?: number; op?: number; dash?: string; stroke?: number } = {}): string {
  return (
    `<path d="${d}" fill="currentColor" fill-opacity="${o.fill ?? 0}" ` +
    `stroke="currentColor" stroke-width="${o.w ?? 1.3}" stroke-opacity="${o.stroke ?? 1}" opacity="${o.op ?? 1}"` +
    `${o.dash ? ` stroke-dasharray="${o.dash}"` : ""} stroke-linejoin="round" stroke-linecap="round"/>`
  );
}

function circle(cx: number, cy: number, r: number, o: { fill?: number; w?: number; op?: number; dash?: string } = {}): string {
  return (
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" fill-opacity="${o.fill ?? 0}" ` +
    `stroke="currentColor" stroke-width="${o.w ?? 1.2}" opacity="${o.op ?? 1}"` +
    `${o.dash ? ` stroke-dasharray="${o.dash}"` : ""}/>`
  );
}

/** 箭頭（終點帶箭頭記號） */
function arrow(x1: number, y1: number, x2: number, y2: number, o: L = {}): string {
  return (
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" fill="none" stroke="currentColor" ` +
    `stroke-width="${o.w ?? 1.2}" opacity="${o.op ?? 1}"` +
    `${o.dash ? ` stroke-dasharray="${o.dash}"` : ""} stroke-linecap="round" marker-end="url(#ah-${FIG})"/>`
  );
}

/** 折線箭頭（先水平再垂直，畫樹用） */
function elbow(x1: number, y1: number, x2: number, y2: number, o: L = {}): string {
  const mx = x1 + (x2 - x1) / 2;
  return path(`M${x1},${y1} H${mx} V${y2} H${x2}`, { w: o.w ?? 1, op: o.op ?? 1, dash: o.dash });
}

const defs = () => `<defs>
  <marker id="ah-${FIG}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M0,0 L8,4 L0,8 z" fill="currentColor"/>
  </marker>
</defs>`;

// ─────────────────────────────────────────────────────────── 圖 1-1 山與路

function fig11(): string {
  const b: string[] = [];
  const W = 544;

  // 天空的說明：自然的坡
  b.push(txt("自然長成的坡：什麼坡長什麼草", 26, 34, { size: 13 }));
  b.push(line(150, 42, 258, 108, { op: 0.3, dash: "2 4", w: 1 }));

  // 山形
  b.push(
    path(
      "M26,332 L94,244 L152,272 L232,100 L290,148 L358,56 L416,182 L436,332 Z",
      { fill: 0.05, w: 1.4 },
    ),
  );

  // 自然的坡紋（右側山腰）
  const slope: [number, number, number, number][] = [
    [318, 118, 332, 130], [334, 148, 348, 160], [350, 176, 364, 188],
    [366, 204, 380, 216], [382, 230, 396, 242], [398, 254, 412, 266],
    [300, 186, 312, 196], [312, 216, 324, 226], [330, 244, 342, 254],
  ];
  for (const [x1, y1, x2, y2] of slope) b.push(line(x1, y1, x2, y2, { op: 0.45, w: 1 }));

  // 前人開墾的殘缺方格（沒有界樁）
  for (const [x, y] of [[112, 282], [146, 282], [112, 308], [180, 308]] as const) {
    b.push(rect(x, y, 28, 24, { stroke: 0.55, dash: "3 3", r: 1, sw: 1 }));
  }

  // 荒草與亂石
  const rocks: [number, number, number][] = [
    [248, 306, 7], [264, 318, 5], [280, 300, 8], [298, 320, 5], [314, 306, 6],
  ];
  for (const [x, y, r] of rocks) b.push(path(`M${x - r},${y} L${x},${y - r * 1.4} L${x + r},${y} Z`, { fill: 0.18, w: 0.9 }));
  for (let i = 0; i < 5; i++) b.push(line(238 + i * 20, 330, 242 + i * 20, 320, { op: 0.4, w: 0.9 }));

  // 那條路（帶記號）——貼著山腳往裡走
  const pts: [number, number][] = [[50, 326], [74, 302], [64, 288], [96, 270], [128, 276], [166, 258], [200, 270], [238, 248]];
  b.push(path(`M${pts.map(([x, y]) => `${x},${y}`).join(" L")}`, { w: 2, fill: 0 }));
  for (const i of [2, 4, 7]) {
    const [x, y] = pts[i];
    b.push(circle(x, y, 3.4, { fill: 1 }));
  }
  b.push(txt("這條路，往後一直用到今天", 46, 360, { size: 11.5, op: 0.75 }));
  b.push(line(348, 38, 366, 56, { w: 1.4, op: 0.55 }), line(366, 38, 348, 56, { w: 1.4, op: 0.55 }));

  // 圖例
  const ly = 392;
  b.push(line(26, ly - 4, 56, ly - 4, { w: 1.8 }));
  b.push(txt("能反覆走的路", 64, ly, { size: 12 }));
  b.push(rect(292, ly - 14, 12, 11, { stroke: 0.6, dash: "2 2", sw: 1, r: 1 }));
  b.push(rect(308, ly - 14, 12, 11, { stroke: 0.6, dash: "2 2", sw: 1, r: 1 }));
  b.push(txt("前人開墾，沒有界樁", 328, ly, { size: 12 }));
  for (let i = 0; i < 3; i++) b.push(circle(30 + i * 9, ly + 18, 1.8, { fill: 0.5 }));
  b.push(txt("荒草與亂石", 64, ly + 22, { size: 12 }));
  b.push(line(298, ly + 14, 310, ly + 26, { w: 1.3 }), line(310, ly + 14, 298, ly + 26, { w: 1.3 }));
  b.push(txt("山頂：走不完", 328, ly + 22, { size: 12 }));

  return b.join("\n");
}

// ─────────────────────────────────────────────────────────── 圖 1-3 木的五種身姿

function fig13(): string {
  const b: string[] = [];
  const cells: [string, string, string][] = [
    ["木", "獨體", "高而正"],
    ["柱", "左", "窄，捺→點"],
    ["架", "上", "壓扁"],
    ["閑", "門內", "縮小"],
    ["注", "左", "與柱同"],
  ];
  const S = 88;
  cells.forEach(([ch, pos, shape], i) => {
    const x = 16 + i * 104;
    b.push(g(ch, x, 16, S));
    b.push(txt(pos, x + S / 2, 126, { size: 13, anchor: "middle" }));
    b.push(txt(shape, x + S / 2, 146, { size: 11, anchor: "middle", op: 0.7 }));
  });
  b.push(line(16, 162, 528, 162, { op: 0.2, w: 1 }));

  // 注 與 柱：右半同一個「主」
  b.push(g("注", 56, 178, 150));
  b.push(g("柱", 300, 178, 150));
  b.push(txt("左半：氵", 56, 348, { size: 11.5 }));
  b.push(txt("左半：木（窄，捺→點）", 300, 348, { size: 11.5 }));
  b.push(txt("同一個位置：左半換成木，右半都是同一個「主」（示意）", 56, 368, { size: 11, op: 0.65 }));
  return b.join("\n");
}

// ─────────────────────────────────────────────────────────── 圖 2-4 假戶長

function fig24(): string {
  const b: string[] = [];
  const card = (y: number, title: string, rows: [string, string][]) => {
    b.push(rect(18, y, 232, 100, { fill: 0.035, stroke: 0.5, r: 4 }));
    b.push(txt(title, 30, y + 22, { size: 12, weight: 600 }));
    rows.forEach(([k, v], i) => {
      b.push(txt(k, 30, y + 46 + i * 18, { size: 11, mono: true, op: 0.75 }));
      b.push(txt(v, 128, y + 46 + i * 18, { size: 11, mono: true }));
    });
  };
  card(28, "合成字的名字", [
    ["name_type", "suffix"],
    ["codepoint", "0x2FF0"],
    ["base_name", "u2ff0"],
  ]);
  card(176, "真正的異體", [
    ["name_type", "suffix"],
    ["codepoint", "0x4EE4"],
    ["base_name", "u4ee4"],
  ]);
  b.push(txt("欄位一模一樣", 30, 156, { size: 11.5, op: 0.85 }));

  // 家譜：一個符號當戶長
  const node = (x: number, y: number, w: number, h: number, kind: "lr" | "tb") => {
    b.push(rect(x, y, w, h, { fill: 0.05, stroke: 0.8, r: 3, sw: 1.2 }));
    if (kind === "lr") b.push(line(x + w / 2, y, x + w / 2, y + h, { w: 1 }));
    else b.push(line(x, y + h / 2, x + w, y + h / 2, { w: 1 }));
  };
  node(286, 30, 64, 46, "lr");
  b.push(txt("左右", 318, 94, { size: 11, anchor: "middle", op: 0.8 }));
  // 扇形：一個戶長，一大群孩子
  for (let i = 0; i < 11; i++) {
    const a = -0.55 + (1.1 * i) / 10;
    const x = 350 + Math.cos(a) * 86;
    const y = 53 + Math.sin(a) * 86;
    b.push(line(350, 53, x, y, { op: 0.32, w: 0.8 }));
    b.push(circle(x, y, 1.7, { fill: 0.45 }));
  }
  b.push(txt("698 個孩子", 392, 124, { size: 12 }));

  node(286, 214, 64, 46, "tb");
  b.push(txt("上下", 318, 278, { size: 11, anchor: "middle", op: 0.8 }));
  for (let i = 0; i < 11; i++) {
    const a = -0.55 + (1.1 * i) / 10;
    const x = 350 + Math.cos(a) * 86;
    const y = 237 + Math.sin(a) * 86;
    b.push(line(350, 237, x, y, { op: 0.32, w: 0.8 }));
    b.push(circle(x, y, 1.7, { fill: 0.45 }));
  }
  b.push(txt("2,270 個", 392, 326, { size: 12 }));

  b.push(txt("全山這樣的名字：77,353", 18, 330, { size: 12.5 }));
  b.push(txt("一個符號報了戶口，後面的字都跟著它姓", 18, 350, { size: 11, op: 0.65 }));
  return b.join("\n");
}

// ─────────────────────────────────────────────────────────── 圖 5-1 桌子不能動

function fig51(): string {
  const b: string[] = [];
  const win = (x: number, tag: string) => {
    b.push(rect(x, 34, 252, 300, { fill: 0.02, stroke: 0.55, r: 5 }));
    b.push(line(x, 58, x + 252, 58, { op: 0.25, w: 1 }));
    for (let i = 0; i < 3; i++) b.push(circle(x + 14 + i * 9, 46, 2, { fill: 0.3 }));
    b.push(txt(tag, x + 48, 50, { size: 11, op: 0.6 }));
  };
  win(12, "原本");
  win(280, "改成：貼在碗邊");

  // 共用的位置基準線：大字原本的上緣
  b.push(line(30, 138, 526, 138, { op: 0.3, dash: "4 4", w: 1 }));


  // 左：提示在版面內，換行把下面的東西往下推
  b.push(rect(24, 72, 228, 28, { stroke: 0.5, r: 3 }));
  b.push(txt("輸入", 34, 91, { size: 11, op: 0.55 }));
  b.push(rect(24, 100, 228, 32, { stroke: 0.45, dash: "3 3", r: 3 }));
  b.push(txt("這一行提示", 34, 113, { size: 10.5, op: 0.85 }));
  b.push(txt("換行了", 34, 127, { size: 10.5, op: 0.85 }));
  b.push(g("杏", 56, 182, 84));
  b.push(txt("大字往下掉一格", 56, 284, { size: 10.5, op: 0.7 }));
  for (let i = 0; i < 3; i++) b.push(rect(168, 240 + i * 18, 74, 7, { fill: 0.18, r: 2 }));

  // 右：提示浮起，佔位 0
  b.push(rect(292, 78, 228, 26, { fill: 0.07, stroke: 0.5, r: 13 }));
  b.push(txt("提示浮在最上層，佔位 0", 300, 95, { size: 10.5, op: 0.8 }));
  b.push(rect(292, 96, 228, 28, { stroke: 0.5, r: 3 }));
  b.push(txt("輸入", 302, 115, { size: 11, op: 0.55 }));
  b.push(g("杏", 324, 146, 84));
  b.push(txt("大字不動", 324, 248, { size: 10.5, op: 0.7 }));
  for (let i = 0; i < 3; i++) b.push(rect(436, 200 + i * 18, 74, 7, { fill: 0.18, r: 2 }));

  b.push(txt("示意：實際座標由樣式表決定", 12, 352, { size: 10.5, op: 0.5 }));
  return b.join("\n");
}

// ─────────────────────────────────────────────────────────── 圖 5-2 祈斤角快取

function fig52(): string {
  const b: string[] = [];
  const panel = (x: number, w: number, title: string) => {
    b.push(rect(x, 28, w, 280, { fill: 0.02, stroke: 0.5, r: 5 }));
    b.push(txt(title, x + 14, 52, { size: 12.5, weight: 600 }));
  };
  panel(12, 256, "帳上記：這只碗在第幾個位置");
  panel(276, 256, "改成：記碗裡裝了什麼");

  const order = (x: number, y: number, chs: string[]) => {
    b.push(rect(x, y, 116, 46, { stroke: 0.5, r: 3 }));
    chs.forEach((ch, i) => b.push(g(ch, x + 8 + i * 32, y + 7, 32)));
  };
  order(26, 66, ["祈", "斤", "角"]);
  order(26, 146, ["祈", "斤", "刀"]);
  b.push(txt("點單", 26, 128, { size: 10.5, op: 0.55 }));

  // 鍵：位置 + 數量
  b.push(rect(158, 96, 96, 54, { fill: 0.06, stroke: 0.55, r: 3 }));
  b.push(txt("鍵", 168, 114, { size: 10.5, op: 0.6 }));
  b.push(txt("位置 2", 168, 130, { size: 11 }));
  b.push(txt("數量 3", 168, 145, { size: 11 }));
  b.push(arrow(142, 88, 156, 108, { w: 1 }));
  b.push(arrow(142, 168, 156, 138, { w: 1 }));

  // 端出來
  b.push(arrow(206, 150, 206, 186, { w: 1 }));
  b.push(rect(152, 190, 108, 44, { stroke: 0.55, r: 3 }));
  b.push(g("祈", 158, 196, 32), g("斤", 190, 196, 32), g("角", 222, 196, 32));
  b.push(txt("兩次都端出同一碗", 26, 206, { size: 10.5, op: 0.75 }));
  b.push(txt("→ 錯", 26, 224, { size: 11, weight: 600 }));

  // 右：筆畫簽名
  order(290, 66, ["祈", "斤", "角"]);
  order(290, 146, ["祈", "斤", "刀"]);
  const sig = (x: number, y: number, shape: number[][]) => {
    b.push(rect(x, y, 64, 30, { stroke: 0.5, r: 3 }));
    for (const [dx, dy, len] of shape) b.push(line(x + 8 + dx, y + 8 + dy, x + 8 + dx + len, y + 8 + dy + 6, { w: 1 }));
  };
  sig(414, 74, [[0, 0, 14], [6, 10, 16], [14, 18, 10]]);
  sig(414, 154, [[2, 2, 16], [10, 8, 12], [4, 16, 14]]);
  b.push(arrow(406, 88, 414, 88, { w: 1 }));
  b.push(arrow(406, 168, 414, 168, { w: 1 }));
  b.push(txt("鍵 = 筆畫", 414, 122, { size: 10.5, op: 0.6 }));
  b.push(txt("兩把不同的鑰匙", 384, 206, { size: 10.5, op: 0.75 }));
  b.push(txt("→ 各端各的", 384, 224, { size: 11, weight: 600 }));
  b.push(txt("示意：快取鍵的組成", 12, 324, { size: 10.5, op: 0.5 }));
  return b.join("\n");
}

// ─────────────────────────────────────────────────────────── 圖 6-1 藥會換臉

function fig61(): string {
  const b: string[] = [];
  const pairs: [string, string, string][] = [
    ["火", "灬", "字底"],
    ["水", "氵", "左邊"],
    ["手", "扌", "左邊"],
    ["爪", "爫", "上面"],
    ["网", "罒", "上面"],
    ["衣", "衤", "左邊"],
  ];
  pairs.forEach(([a, z, where], i) => {
    const col = i % 3;
    const row = i < 3 ? 0 : 1;
    const cx = 104 + col * 176;
    const y = 40 + row * 168;
    b.push(g(a, cx - 92, y, 58));
    b.push(arrow(cx - 26, y + 29, cx + 2, y + 29, { w: 1 }));
    b.push(g(z, cx + 10, y, 58));
    b.push(txt(`（${where}）`, cx - 92, y + 84, { size: 11, op: 0.7 }));
  });
  b.push(line(24, 316, 520, 316, { op: 0.18, w: 1 }));
  b.push(txt("左邊是原本的字，右邊是它換了位置之後的身姿", 24, 338, { size: 11, op: 0.75 }));
  b.push(txt("示意", 24, 358, { size: 10.5, op: 0.45 }));
  return b.join("\n");
}

// ─────────────────────────────────────────────────────────── 圖 7-1 五條路

function fig71(): string {
  const b: string[] = [];
  const roads: [string, string, number][] = [
    ["字型", "最快；字型是死的", 246],
    ["輸入法", "裝得上；最後還是回到字型", 310],
    ["網頁／擴充", "最省事；出不了那個盒子", 366],
    ["專業工具", "走得通；走不遠", 444],
    ["系統底座", "要改天下人都在用的標準", 518],
  ];
  roads.forEach(([name, note, end], i) => {
    const y = 42 + i * 60;
    b.push(txt(name, 52, y + 5, { size: 13.5, weight: 600 }));
    b.push(line(140, y, end, y, { w: 1.5 }));
    b.push(circle(end, y, 3.2, { fill: 1 }));
    if (i === 4) {
      b.push(rect(end - 20, y - 28, 12, 9, { stroke: 0.9, w: 1, r: 1 }));
      b.push(path(`M${end - 18},${y - 28} v-3 a3.5,3.5 0 0 1 7,0 v3`, { w: 1 }));
    }
    b.push(txt(note, 140, y + 20, { size: 10.5, op: 0.65 }));
  });
  b.push(txt("五條都要人；而寫得動的人，只剩徒弟", 52, 336, { size: 11, op: 0.6 }));
  return b.join("\n");
}
// ─────────────────────────────────────────────────────────── 圖 8-1 打不開的門

function fig81(): string {
  const b: string[] = [];
  const room = (x: number, y: number, label: string, withShelf: boolean) => {
    b.push(rect(x, y, 126, 104, { stroke: 0.55, dash: "4 4", r: 4 }));
    if (!withShelf) {
      b.push(txt(label, x + 63, y + 58, { size: 12, anchor: "middle", op: 0.6 }));
    } else {
      b.push(line(x + 14, y + 74, x + 112, y + 74, { w: 1.2 }));
      ["木", "水", "火"].forEach((ch, i) => b.push(g(ch, x + 18 + i * 34, y + 26, 30)));
      b.push(txt(label, x + 63, y + 94, { size: 10.5, anchor: "middle", op: 0.6 }));
    }
  };
  const box = (x: number, y: number) => {
    b.push(rect(x, y, 96, 96, { fill: 0.05, stroke: 0.8, r: 5 }));
    b.push(txt("gzip", x + 12, y + 40, { size: 13, mono: true }));
    b.push(txt("3.5 MB", x + 12, y + 58, { size: 11, mono: true, op: 0.7 }));
    b.push(txt("98,700 味藥", x + 12, y + 76, { size: 9.5, op: 0.55 }));
  };
  const door = (x: number, y: number, open: boolean) => {
    b.push(rect(x - 7, y - 7, 78, 118, { stroke: 0.3, r: 1, sw: 1 }));
    b.push(rect(x, y, 64, 104, { stroke: 0.9, r: 1 }));
    if (open) {
      b.push(path(`M${x + 64},${y + 4} Q${x + 88},${y + 52} ${x + 64},${y + 100}`, { w: 1, op: 0.45, dash: "4 4", fill: 0 }));
      b.push(line(x + 64, y + 100, x + 86, y + 70, { w: 1.6 }));
    }
    b.push(circle(x + 50, y + 54, 2.4, { fill: 0.8 }));
  };

  b.push(txt("只帶匣子", 16, 30, { size: 11, op: 0.7 }));
  box(40, 46);
  door(244, 42, false);
  room(392, 42, "空的", false);
  b.push(arrow(138, 94, 240, 94, { w: 1 }));
  b.push(arrow(310, 94, 388, 94, { w: 1 }));
  b.push(txt("✕ 沒有解壓能力", 318, 112, { size: 9.5, op: 0.75 }));
  b.push(txt("壓得再緊也拿不出來", 40, 162, { size: 10.5, op: 0.6 }));

  b.push(txt("鑰匙隨匣走", 16, 202, { size: 11, op: 0.7 }));
  box(40, 216);
  // 鑰匙
  b.push(circle(160, 248, 7, { w: 1.4 }));
  b.push(line(167, 248, 186, 248, { w: 1.6 }));
  b.push(line(180, 248, 180, 256, { w: 1.4 }), line(186, 248, 186, 258, { w: 1.4 }));
  b.push(txt("純 JS", 156, 278, { size: 10, op: 0.6 }));
  door(244, 212, true);
  room(392, 212, "架上有丹", true);
  b.push(arrow(190, 264, 240, 264, { w: 1 }));
  b.push(arrow(310, 264, 388, 264, { w: 1 }));
  b.push(txt("匣底刻：微信看不到，就用系統瀏覽器", 40, 336, { size: 10, op: 0.55 }));
  return b.join("\n");
}

// ─────────────────────────────────────────────────────────── 圖 9-1 沒有檯面

function fig91(): string {
  const b: string[] = [];
  // 江：一條直的水道，把兩岸分開
  b.push(line(252, 24, 252, 336, { op: 0.45, w: 1.2 }));
  b.push(line(300, 24, 300, 336, { op: 0.45, w: 1.2 }));
  for (let y = 56; y < 320; y += 44) {
    b.push(path(`M258,${y} q8,-4 16,0 t16,0`, { w: 1, op: 0.45 }));
    b.push(path(`M260,${y + 10} q8,-4 16,0 t16,0`, { w: 1, op: 0.3 }));
  }
  b.push(txt("江", 276, 330, { size: 11, anchor: "middle", op: 0.55 }));

  // 左岸：籬笆、桌子、喊話的人
  b.push(line(16, 292, 252, 292, { w: 1.4 }));
  b.push(line(96, 262, 168, 262, { w: 1.8 }));
  b.push(line(102, 262, 102, 292, { w: 1.2 }), line(162, 262, 162, 292, { w: 1.2 }));
  b.push(txt("檯面", 110, 256, { size: 10.5, op: 0.6 }));
  b.push(circle(206, 236, 7, { fill: 0.9 }));
  b.push(path("M206,243 C198,250 196,264 196,292 M206,243 C214,250 216,264 216,292", { w: 1.4, fill: 0 }));
  for (let i = 0; i < 3; i++) {
    const r = 12 + i * 7;
    b.push(path(`M222,${246 - r} a${r},${r} 0 0 1 0,${2 * r}`, { w: 1, op: 0.55 - i * 0.12, fill: 0 }));
  }
  b.push(txt("院子裡", 16, 306, { size: 10.5, op: 0.6 }));
  b.push(txt("有檯面：話喊得出去", 16, 56, { size: 12.5 }));
  b.push(txt("桌子讓人站著看東西", 16, 74, { size: 10.5, op: 0.6 }));

  // 右岸：牆、窗縫裡的一閃、空手的人
  b.push(line(300, 292, 528, 292, { w: 1.4 }));
  b.push(rect(330, 150, 176, 142, { fill: 0.04, stroke: 0.7 }));
  // 牆上的一扇小窗，光從窗縫漏出來
  b.push(rect(378, 176, 42, 34, { fill: 0.08, stroke: 0.55, r: 1 }));
  b.push(line(399, 176, 399, 210, { w: 0.9, op: 0.55 }), line(378, 193, 420, 193, { w: 0.9, op: 0.55 }));
  b.push(line(372, 170, 360, 158, { w: 0.9, op: 0.35 }));
  b.push(line(426, 170, 438, 158, { w: 0.9, op: 0.35 }));
  b.push(line(372, 216, 360, 228, { w: 0.9, op: 0.35 }));
  b.push(line(426, 216, 438, 228, { w: 0.9, op: 0.35 }));
  b.push(txt("一閃", 426, 174, { size: 10.5, op: 0.6 }));
  b.push(circle(476, 246, 7, { fill: 0.9 }));
  b.push(path("M476,253 C468,260 466,274 466,292 M476,253 C484,260 486,274 486,292", { w: 1.4, fill: 0 }));
  b.push(path("M470,262 L458,276 M482,262 L494,276", { w: 1.2 }));
  b.push(txt("沒有檯面：一閃就等於沒有", 330, 120, { size: 12.5 }));
  b.push(txt("客人兩手空空", 330, 312, { size: 10.5, op: 0.6 }));

  return b.join("\n");
}
// ─────────────────────────────────────────────────────────── 註冊表

type Fig = { id: string; w: number; h: number; title: string; desc: string; draw: () => string };

const FIGS: Fig[] = [
  { id: "1-1", w: 544, h: 430, title: "山與路", desc: "山分三層：自然坡、沒有界樁的墾地、荒草與亂石；一條帶記號的路從山腳往上。", draw: fig11 },
  { id: "1-3", w: 544, h: 384, title: "木的五種身姿", desc: "同一個木：獨體、柱左、架上、閑內、注左；左邊那株的捺收成了點。", draw: fig13 },
  { id: "2-4", w: 544, h: 372, title: "假戶長", desc: "⿰ 名下 698 個孩子、⿱ 名下 2,270 個；戶籍欄位與真異體一模一樣。", draw: fig24 },
  { id: "5-1", w: 544, h: 364, title: "桌子不能動", desc: "左：提示換行把大字往下推；右：提示浮在最上層，佔位為零。", draw: fig51 },
  { id: "5-2", w: 544, h: 344, title: "同一只碗", desc: "記位置與數量會撞鍵；改記筆畫簽名，兩碗湯才分得開。", draw: fig52 },
  { id: "6-1", w: 544, h: 372, title: "藥會換臉", desc: "火灬、水氵、手扌、爪爫、网罒、衣衤：同一個部件的位置變體。", draw: fig61 },
  { id: "7-1", w: 544, h: 352, title: "五條路", desc: "字型、輸入法、網頁擴充、專業工具、系統底座：各自通到哪裡、卡在哪裡。", draw: fig71 },
  { id: "8-1", w: 544, h: 352, title: "打不開的門", desc: "匣子壓得緊，門不會解；鑰匙隨匣走，門後才有東西。", draw: fig81 },
  { id: "9-1", w: 544, h: 336, title: "沒有檯面", desc: "左邊有檯面，話喊得出去；右邊沒有，丹只亮一下。", draw: fig91 },
];

export function renderFigure(f: Fig): string {
  FIG = f.id;
  const body = f.draw();
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f.w} ${f.h}" width="${f.w}" height="${f.h}" ` +
    `font-family="${FONT}" color="currentColor">` +
    `<title>圖 ${f.id}　${esc(f.title)}</title><desc>${esc(f.desc)}</desc>` +
    defs() +
    `<g fill="none" stroke="currentColor" stroke-width="1.2">${body}</g>` +
    `</svg>\n`
  );
}

// ─────────────────────────────────────────────────────────── CLI

function main(): void {
  const argv = Bun.argv.slice(2);
  const val = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes("--list")) {
    for (const f of FIGS) console.log(`${f.id}\t${f.title}`);
    return;
  }
  const only = val("--only")?.split(",").map((s) => s.trim()).filter(Boolean);
  const outDir = resolve(ROOT, val("--out") ?? "novel/figs");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const todo = only ? FIGS.filter((f) => only.includes(f.id)) : FIGS;
  if (!todo.length) {
    console.error("沒有符合的圖號，--list 看有哪些");
    process.exit(1);
  }
  let bytes = 0;
  for (const f of todo) {
    const svg = renderFigure(f);
    Bun.write(join(outDir, `${f.id}.svg`), svg);
    bytes += svg.length;
    console.log(`圖 ${f.id}　${f.title}　${(svg.length / 1024).toFixed(1)} KB`);
  }
  console.log(`\n${todo.length} 張 → ${outDir}（共 ${(bytes / 1024).toFixed(1)} KB）`);
}

if (import.meta.main) main();








