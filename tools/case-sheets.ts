// case-sheets.ts — 把候選替換排成聯絡表，**給人眼挑**。
//
// 為什麼不靠自動評分：試過三種啟發式都不成立——
//   * 長寬比：CJK 部件幾乎都是滿格（日 0.76、木 0.99、水 1.02），分不出好壞
//   * 多邊形周長：滿格部件周長幾乎一樣，全部得到 1.00
//   * 墨跡覆蓋率：`風` 是 0.22、`日` 是 0.80，差的是**筆畫粗細與字的密度**，
//     不是「換上去好不好看」
// 唯一客觀的訊號是 `composeFit` 回報的 **scale**（要不要縮、縮多少），
// 其餘交給眼睛。所以這支工具只做「排版＋標數字」，不做評分。
//
// 用法: bun run tools/case-sheets.ts [--bases 街,寶,漢] [--sheet out/sheet.html]
import { readFileSync, writeFileSync } from "node:fs";
import { decodeLibrary, findGlyphIndex, toKageData } from "./lib-format.ts";
import type { Library } from "./lib-format.ts";
import { ensureEngine, composeFit, svgOf } from "./compose-fit.ts";
import { listReplaceables } from "./free-compose.ts";

const D = "D:/2023/glyphwiki";
ensureEngine();
const lib: Library = decodeLibrary(
  new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))),
);
const partIdx = (c: string) => findGlyphIndex(lib, "u" + c.codePointAt(0)!.toString(16));

const POOL = [
  "日","月","口","木","水","火","土","金","人","大","小","山","川","石","田",
  "力","刀","手","心","目","耳","白","玉","禾","虫","貝","車","門","雨","風",
  "一","二","三","十","干","工","中","方","文","王","主","生","立","丁",
  "天","夫","太","犬","本","未","末","米","女","子","又","寸","夕","丸","凡",
];

const bi0 = (c: string) => partIdx(c);

function replaceableParts(base: string, baseIdx: number) {
  const self = "u" + base.codePointAt(0)!.toString(16);
  return listReplaceables(lib, baseIdx)
    .filter((r) => r.level === 1)
    .filter((r) => !(r.name === self || r.name.startsWith(self + "-")));
}

const bi = Bun.argv.indexOf("--bases");
const BASES = (bi >= 0 ? Bun.argv[bi + 1]! : "街,寶,峰,明,盟,漢,字,國,樹,湖,朝,期,清,請,城,地,場,話,時,唱,媽,林,森,品,磊,炎,淼,众").split(",");

const parts: string[] = [];
const CELL = 92;
const PAD = 6;
let y = 0;

for (const base of BASES) {
  const bIdx = bi0(base);
  if (bIdx === undefined) continue;
  const olds = replaceableParts(base, bIdx);
  if (!olds.length) continue;

  // 標題：原字
  const baseInner = svgOf(lib, bIdx).replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "");
  parts.push(`<g transform="translate(4,${y + 4})"><g transform="scale(${CELL / 200})">${baseInner}</g></g>`);
  parts.push(`<text x="${CELL + 14}" y="${y + 40}" font-size="20" font-family="sans-serif" fill="#111">${base}</text>`);
  parts.push(`<text x="${CELL + 14}" y="${y + 62}" font-size="12" font-family="monospace" fill="#888">${lib.names[bIdx]}　L1 可換：${olds.map((o) => o.ch).join(" ")}</text>`);
  y += CELL + PAD;

  for (const o of olds) {
    // 每一列：原部件（以 base 為底、不替換）→ 各候選
    let x = 0;
    const rowY = y;
    // 原部件那一格
    const srcInner = svgOf(lib, bIdx).replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "");
    parts.push(`<g transform="translate(4,${rowY})"><g transform="scale(${CELL / 200})">${srcInner}</g></g>`);
    parts.push(`<text x="6" y="${rowY + CELL + 12}" font-size="11" font-family="monospace" fill="#c00">原（舊＝${o.ch}）</text>`);
    x = CELL + PAD + 4;

    for (const nw of POOL) {
      if (nw === o.ch) continue;
      const r = composeFit(lib, base, [[o.ch, nw]]);
      if ("error" in r) continue;
      const st = r.steps[0]!;
      const inner = svgOf(r.lib, r.targetIdx).replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "");
      const good = st.scale >= 0.95;
      const color = good ? "#111" : "#c00";
      parts.push(`<g transform="translate(${x},${rowY})"><g transform="scale(${CELL / 200})" fill="${color}">${inner}</g></g>`);
      parts.push(`<text x="${x + CELL / 2}" y="${rowY + CELL + 12}" text-anchor="middle" font-size="11" font-family="monospace" fill="${good ? "#060" : "#c00"}">${o.ch}→${nw} ${(st.scale * 100).toFixed(0)}%</text>`);
      x += CELL + PAD;
      if (x > 1400) break;
    }
    y += CELL + 20;
  }
  y += 14;
}

const W = 1460, H = y + 10;
const si = Bun.argv.indexOf("--sheet");
const sheet = si >= 0 ? Bun.argv[si + 1]! : `${D}/out/case-sheets.html`;
const html = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><title>候選替換聯絡表</title>
<style>body{margin:0;background:#fff}svg{display:block}</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="100%" height="100%" fill="#fff"/>
<text x="6" y="0" font-size="1" fill="#fff">.</text>
${parts.join("")}
</svg></body></html>`;
writeFileSync(sheet, html);
console.log(`已寫出 ${sheet}（${W}×${H}）`);
console.log(`每一列：原字（左，紅標）→ 各候選；綠色百分比＝沿用原框，紅色＝被縮小`);
