// search-slot.ts — 「找哪個字裡有這個部件、而且在那個位置」。
//
// 師父要的情境：
//   想組「招財進寶」的 holy grail，序列裡有個 𩀨（U+29028）不在字庫裡。
//   𩀨 ＝ ⿰隹從（`unicode-cjk-ids` 查得到），所以只要能「造出 ⿰隹從」就行。
//   但使用者不會知道要打「隹」——**他只知道「隹在左邊」**。
//   所以介面要能用「部件 ＋ 位置」搜尋。
//
// 用法:
//   bun run tools/search-slot.ts 隹 左
//   bun run tools/search-slot.ts 隹 左 --level 1 --limit 30
//   bun run tools/search-slot.ts --stats 隹          # 這個部件在各位置的統計
//   bun run tools/search-slot.ts --index --top 40    # 最常當部件的字
//
// 字庫：預設 `out/lib-cjk.bin.gz`（BMP）。加上 `--lib out/lib-cjk-all.bin.gz`
// 就會改用含 Ext B 的字庫——**同一份資料同時餵組字與查字**：
//   bun run tools/search-slot.ts 隹 左 --lib out/lib-cjk-all.bin.gz
//   （加了 Ext B 之後，這條查詢才會找到 `𩀨` 自己，因為它終於在庫裡了。）
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Library } from "./lib-format.ts";
import { loadLibrary, DEFAULT_LIB } from "./lib-load.ts";
import { ensureEngine, inkOfRefInParent, svgOf } from "./compose-fit.ts";
import { searchByComponent, componentIndex } from "./free-compose.ts";
import type { SlotPos, SlotZone } from "./free-compose.ts";

const D = "D:/2023/glyphwiki";
ensureEngine();

const argv = Bun.argv.slice(2);
const has = (f: string) => argv.includes(f);
const valOf = (f: string, dflt: string) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};
/** 位置參數要排除 `--lib` 的值，否則它會被當成「部件」 */
const positional = argv.filter((a, i) =>
  !a.startsWith("--") && argv[i - 1] !== "--lib");

const libPath = resolve(D, valOf("--lib", DEFAULT_LIB));
const { lib, names: nWikiNames } = loadLibrary(libPath, { withNames: true });
if (has("--lib") || has("--verbose")) {
  console.log(`字庫 ${libPath}（${lib.glyphs.length.toLocaleString()} 個字形、` +
    `家族 ${lib.families.length.toLocaleString()} 個、名字對照 ${nWikiNames.toLocaleString()} 筆）`);
}

// ---------------------------------------------------------------- 索引模式

if (has("--index")) {
  const top = Number(valOf("--top", "40")) || 40;
  const t0 = Date.now();
  const idx = componentIndex(lib);
  console.log(`部件索引：${idx.size.toLocaleString()} 個不同部件、` +
    `共 ${[...idx.values()].reduce((a, b) => a + b.count, 0).toLocaleString()} 次引用` +
    `（${Date.now() - t0} ms）\n`);
  const sorted = [...idx.values()].sort((a, b) => b.count - a.count);
  console.log(`最常當部件的前 ${top} 個：`);
  for (const s of sorted.slice(0, top)) {
    const ps = (Object.entries(s.positions) as [SlotZone, number][])
      .sort((a, b) => b[1] - a[1])
      .map(([p, n]) => `${p}${n}`).join(" ");
    console.log(`  ${s.ch}  ${s.name.padEnd(16)} 共 ${String(s.count).padStart(5)}　${ps}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- 統計模式

if (has("--stats")) {
  const ch = positional[0];
  if (!ch) { console.error("用法: search-slot.ts --stats <部件>"); process.exit(2); }
  const t0 = Date.now();
  const idx = componentIndex(lib);
  const st = idx.get(ch);
  if (!st) { console.log(`「${ch}」沒有出現在任何字的直接部件位置（${Date.now() - t0} ms）`); process.exit(0); }
  console.log(`「${ch}」${st.name}：共 ${st.count} 次引用（直接部件層）`);
  for (const [p, n] of (Object.entries(st.positions) as [SlotPos, number][])
    .sort((a, b) => b[1] - a[1])) {
    console.log(`  ${p}：${n} 次`);
  }
  console.log(`（掃描 ${lib.glyphs.length.toLocaleString()} 字形，${Date.now() - t0} ms）`);
  process.exit(0);
}

// ---------------------------------------------------------------- 搜尋模式

const ch = positional[0];
const pos = positional[1] as SlotPos | undefined;
const level = Number(valOf("--level", "1")) || 1;
const limit = Number(valOf("--limit", "200")) || 200;
const wantSvg = has("--svg");

if (!ch) {
  console.log(`用法：
  bun run tools/search-slot.ts <部件> [位置] [--level N] [--limit N] [--svg]
  bun run tools/search-slot.ts --stats <部件>      # 這個部件在各位置的統計
  bun run tools/search-slot.ts --index --top 40    # 最常當部件的字

位置可為：左 右 上 下 中 滿（省略＝不限；查左也會找到上左／下左）`);
  process.exit(2);
}

const t0 = Date.now();
const hits = searchByComponent(lib, { ch, pos, level, limit, inkOfRef: inkOfRefInParent });
const ms = Date.now() - t0;

console.log(`搜尋「${ch}」${pos ? "在" + pos + "邊" : ""}（層級 ≤ ${level}）` +
  `→ ${hits.length} 筆，${ms} ms\n`);

for (const h of hits.slice(0, limit)) {
  console.log(`  ${h.ch}（${h.parentName} 的 ${h.zone}${h.level > 1 ? " L" + h.level : ""}）` +
    `  父字 ${h.parentName}  框[${h.box.join(",")}]  佔比 ${(h.area * 100).toFixed(0)}%`);
  if (wantSvg) {
    const out = `${D}/out/slot-${h.parentName}.svg`;
    Bun.write(out, svgOf(lib, h.parent));
    console.log(`      → ${out}`);
  }
}

// 附帶：把結果排成一張圖，方便用眼睛確認位置判定對不對
if (hits.length && has("--sheet")) {
  const S = 150, TOP = 10;
  let x = 10;
  const parts: string[] = [];
  const seen = new Set<number>();
  for (const h of hits) {
    if (seen.has(h.parent) || seen.size >= 24) continue;
    seen.add(h.parent);
    const inner = svgOf(lib, h.parent).replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "");
    parts.push(`<g transform="translate(${x},${TOP}) scale(${S / 200})">${inner}</g>`);
    parts.push(`<text x="${x + S / 2}" y="${TOP + S + 16}" text-anchor="middle" font-size="13" font-family="sans-serif" fill="#111">${h.parentName}</text>`);
    parts.push(`<text x="${x + S / 2}" y="${TOP + S + 32}" text-anchor="middle" font-size="11" font-family="sans-serif" fill="#060">${h.ch} 在${h.zone}</text>`);
    x += S + 8;
    if (x > 1500) break;
  }
  const W = x, H = TOP + S + 44;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="100%" height="100%" fill="#fff"/><g fill="#111">${parts.join("")}</g></svg>`;
  const out = `${D}/out/slot-search.svg`;
  Bun.write(out, svg);
  console.log(`\n已寫出 ${out}（${W}×${H}）`);
}
