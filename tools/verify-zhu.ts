// verify-zhu.ts — 決定性驗收：注 把「氵」換成「木」後，是否等於「柱」
import { readFileSync, writeFileSync } from "node:fs";
import { decodeLibrary, findGlyphIndex, toKageData } from "./lib-format.ts";
import { composeFit, svgOf, inkIn, inkOfRefInParent } from "./compose-fit.ts";
import type { Library } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

const sz = (b: any) => `${(b.x2 - b.x1).toFixed(0)}×${(b.y2 - b.y1).toFixed(0)}`;

/** 印出一個字樹中所有直接引用的名與槽位 */
function refs(label: string, L: Library, idx: number) {
  const g = L.glyphs[idx]!;
  console.log(`  ${label}（${L.names[idx]}）`);
  g.strokes.forEach((s, i) => {
    if (s.kind !== 99 || s.ref === null) return;
    const ink = inkOfRefInParent(L, idx, i);
    console.log(`    引用 ${L.names[s.ref]!.padEnd(20)} 槽位 ${sz(ink).padStart(9)}` +
      `  框=[${s.box!.join(",")}]`);
  });
}

console.log("=== 真值 ===");
const zhuIdx = findGlyphIndex(lib, "u67f1")!;
refs("柱", lib, zhuIdx);
const zhuInk = inkIn(lib, zhuIdx);
console.log(`    整體墨跡 ${sz(zhuInk)}\n`);

console.log("=== 用 注 組字：把 氵 換成 木 ===");
const r = composeFit(lib, "注", [["氵", "木"]]);
if ("error" in r) {
  console.log(`  失敗：${r.error}`);
} else {
  console.log(`  ${r.log.join("、")}`);
  refs("組字結果", r.lib, r.targetIdx);
  const gotInk = inkIn(r.lib, r.targetIdx);
  console.log(`    整體墨跡 ${sz(gotInk)}`);
  console.log(`    與「柱」整體墨跡差：${Math.abs(gotInk.x1 - zhuInk.x1).toFixed(1)},` +
    `${Math.abs(gotInk.y1 - zhuInk.y1).toFixed(1)},` +
    `${Math.abs(gotInk.x2 - zhuInk.x2).toFixed(1)},` +
    `${Math.abs(gotInk.y2 - zhuInk.y2).toFixed(1)}`);

  // 逐筆比較：同一組座標嗎？
  const A = (toKageData(r.lib.glyphs[r.targetIdx]!, r.lib)).split("$");
  const B = (toKageData(lib.glyphs[zhuIdx]!, lib)).split("$");
  console.log(`\n  結構：組字結果 ${A.length} 筆 vs 柱 ${B.length} 筆`);
  const norm = (x: string) => {
    const c = x.split(":");
    while (c.length < 12) c.push("0");
    return c[0] === "99" ? [...c.slice(0, 7), "NAME", ...c.slice(8)].join(":") : c.slice(0, 11).join(":");
  };
  let same = 0, diff = 0;
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const na = norm(A[i] ?? ""), nb = norm(B[i] ?? "");
    if (na === nb) same++;
    else { diff++; if (diff <= 4) console.log(`    筆 ${i} 不同：\n      組字 ${A[i]}\n      柱   ${B[i]}`); }
  }
  console.log(`  逐筆相同 ${same}、不同 ${diff}`);

  // 產出對照圖
  const cells: string[] = [];
  let x = 0;
  const S = 200;
  for (const [L2, i2, label2] of [[lib, zhuIdx, "柱（KAGE 原字）"], [r.lib, r.targetIdx, "注・氵→木"]] as any[]) {
    const svg = svgOf(L2, i2);
    const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "");
    cells.push(`<g transform="translate(${x},0)">${inner}</g>`);
    cells.push(`<text x="${x + S / 2}" y="${S + 20}" text-anchor="middle" font-size="14" fill="#333" font-family="sans-serif">${label2}</text>`);
    x += S;
  }
  const out = `<svg xmlns="http://www.w3.org/2000/svg" width="${x}" height="${S + 30}" viewBox="0 0 ${x} ${S + 30}"><rect width="100%" height="100%" fill="#fff"/><g fill="#111">${cells.join("")}</g></svg>`;
  writeFileSync(`${D}/out/zhu-compare.svg`, out);
  console.log(`\n  已寫出 zhu-compare.svg`);
}
