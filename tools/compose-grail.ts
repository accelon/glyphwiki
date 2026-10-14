// compose-grail.ts — 挑戰「招財進寶」的 holy grail：邏羅寶貝𩀨從䞃致招
//
// 前置事實（已量測）：
//   * `𩀨`（U+29028）**不在字庫裡** → 這是唯一擋住整條序列的原因。
//   * `unicode-cjk-ids` 給出：U+29028 𩀨 ⿰隹從
//   * `composeFit` 只能**替換既有槽位**，不能新建槽位；
//     而庫裡找不到「左＝隹、右＝從」的現成字可以拿來換。
//
// 所以缺的是一個新動作：**「把某個位置的部件換成一個現造的組合」**。
// 做法沿用本專案的既有資產——**借用一個結構相近的模板字，換掉其中一個引用**，
// 這樣引用框（人工手調的版面資產）自然被沿用，不必自己重新發明版面。
//
// 序列的求值順序（由內而外）：
//   1. `致招`        ＝ 致 的 夂 → 招                    （側枝）
//   2. `邏羅寶`      ＝ 邏 的 羅 → 寶
//   3. `𩀨`          ＝ ⿰隹從（模板：用結構相近的字換件造出來）
//   4. `邏羅寶貝𩀨`  ＝ 上面的結果 的 貝 → 𩀨
//   5. `…從䞃致招`   ＝ 上面的結果 的 從 → (1) 的結果
//
// 用法: bun run tools/compose-grail.ts
import { readFileSync } from "node:fs";
import { decodeLibrary, findGlyphIndex, toKageData, isVariantOf } from "./lib-format.ts";
import type { Library, Glyph, Stroke } from "./lib-format.ts";
import { ensureEngine, inkIn, inkOfRefInParent, svgOf, composeFit } from "./compose-fit.ts";
import { evalSeq, refSlotsOf, listReplaceables } from "./free-compose.ts";
import { minCrossDistOf } from "./stroke-overlap.ts";

const D = "D:/2023/glyphwiki";
ensureEngine();
const lib: Library = decodeLibrary(
  new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))),
);
const idxOf = (c: string) => findGlyphIndex(lib, "u" + c.codePointAt(0)!.toString(16));
const fmtD = (v: number) => (!Number.isFinite(v) ? "無" : v.toFixed(1));

// ---------------------------------------------------------------- 核心新動作

type Box = [number, number, number, number];

function fork(L: Library): { lib: Library; names: string[]; glyphs: Glyph[] } {
  const names = L.names.slice();
  const glyphs: Glyph[] = L.glyphs.map((g) => ({ tight: g.tight, strokes: g.strokes }));
  return { lib: { names, suffix: L.suffix, glyphs }, names, glyphs };
}

function childrenOf(L: Library, idx: number): { strokeIx: number; ref: number; box: Box }[] {
  const g = L.glyphs[idx];
  if (!g) return [];
  const out: { strokeIx: number; ref: number; box: Box }[] = [];
  g.strokes.forEach((s, i) => {
    if (s.kind === 99 && s.ref !== null && s.box) {
      out.push({ strokeIx: i, ref: s.ref, box: s.box as Box });
    }
  });
  return out;
}

/**
 * **在座標 p 筆位置放「左 co / 右 jiong」**（或者你要的兩件），用模板換件。
 *
 * 借用 `template` 這個既有字：把它的兩個引用依序換成 co/jiong，
 * 沿用模板原本的引用框（＝沿用人工調好的版面）。
 *
 * 這是 composeFit 缺的那一半：composeFit 是「同一位置換材料」，
 * 這支是「借一個位置的版面，放全新的材料」。
 */
function twoPartViaTemplate(
  L: Library, template: number, co: string, jiong: string,
): { ok: true; lib: Library; idx: number; log: string } | { ok: false; error: string } {
  const kids = childrenOf(L, template);
  if (kids.length < 2) {
    return { ok: false, error: `模板 ${L.names[template]} 只有 ${kids.length} 個引用，需要兩個` };
  }
  const a = idxOf(co), b = idxOf(jiong);
  if (a === undefined) return { ok: false, error: `部件「${co}」不在庫中` };
  if (b === undefined) return { ok: false, error: `部件「${jiong}」不在庫中` };
  const { lib, names, glyphs } = fork(L);
  // 依引用框的 x 中心排序，左邊的放 co、右邊的放 jiong
  const sorted = [...kids].sort((p, q) =>
    (p.box[0] + p.box[2]) - (q.box[0] + q.box[2]));
  const assign = [[sorted[0]!, a], [sorted[1]!, b]] as const;
  const g = glyphs[template]!;
  const strokes = g.strokes.slice();
  for (const [kid, ref] of assign) {
    strokes[kid.strokeIx] = { ...strokes[kid.strokeIx]!, ref };
  }
  glyphs[template] = { tight: g.tight, strokes };
  return {
    ok: true, lib, idx: template,
    log: `借模板 ${L.names[template]} 的版面：左→${co}、右→${jiong}`,
  };
}

/**
 * 把某個（可能剛造出來的）字形塞進一個替換序列：base 的 old → newIdx。
 * 這是 free-compose 的 applyReplace 的公開版（它只吃「字元」，這裡吃「索引」）。
 */
function replaceWithIdx(
  L: Library, base: number, oldRefBase: string, newIdx: number,
): { ok: true; lib: Library; log: string } | { ok: false; error: string } {
  const stack = [base];
  const seen = new Set<number>();
  let found: { parent: number; strokeIx: number } | null = null;
  while (stack.length && !found) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const g = L.glyphs[i];
    if (!g) continue;
    for (let si = 0; si < g.strokes.length; si++) {
      const s = g.strokes[si]!;
      if (s.kind === 99 && s.ref !== null && isVariantOf(L, s.ref, oldRefBase)) {
        found = { parent: i, strokeIx: si };
        break;
      }
    }
    if (!found) for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  if (!found) {
    // 失敗時把走過的節點列出來，方便定位（先前只有一句「找不到」，查不出原因）
    const walked = [...seen].slice(0, 20).map((i) => L.names[i]).join(" ");
    return { ok: false, error: `找不到部件 ${oldRefBase}（走過 ${seen.size} 個節點：${walked}）` };
  }
  const { lib, glyphs } = fork(L);
  const p0 = glyphs[found.parent]!;
  const strokes = p0.strokes.slice();
  strokes[found.strokeIx] = { ...strokes[found.strokeIx]!, ref: newIdx };
  glyphs[found.parent] = { tight: p0.tight, strokes };
  return { ok: true, lib, log: `${L.names[found.parent]} 的 ${oldRefBase} → ${L.names[newIdx] ?? "#" + newIdx}` };
}

// ---------------------------------------------------------------- 逐步施工

console.log("=== 「招財進寶」holy grail：邏羅寶貝𩀨從䞃致招 ===\n");

let cur: Library = lib;
let root = idxOf("邏")!;
const steps: string[] = [];
console.log(`步驟 0：基字 邏（${lib.names[root]}）`);

// ---- 步驟 1：邏 的 羅 → 寶 ----
{
  const r = composeFit(cur, "邏", [["羅", "寶"]]);
  if ("error" in r) { console.log("✗ 步驟 1：" + r.error); process.exit(1); }
  cur = r.lib; root = r.targetIdx;
  steps.push("邏 的 羅 → 寶");
  console.log(`步驟 1：邏 的 羅 → 寶　（${r.log[0]}）`);
}

// ---- 步驟 2：找「左＝隹、右＝某件」的模板，造出 𩀨 ＝ ⿰隹從 ----
//
// 模板候選：庫中「左邊是隹」的字（tools/search-slot.ts 找出來的）。
// 我們要的是「左右結構且右邊夠寬」的，因為 從 比 隹大。
// 𩀨 的右件 從 是寬件，所以優先找「右件也是寬件」的模板。
console.log("\n步驟 2：造 𩀨 ＝ ⿰隹從（字庫沒有這個字）");
let jiongIdx: number | null = null;
{
  // 用「隹在左」的既有字當模板。實測這幾個是左右結構：
  //   u4ce1-j、u9840-j、u96d4-j、u4a07-j、u96e6-j、u622a-j
  const templates = ["u4ce1-j", "u9840-j", "u96e6-j", "u4a07-j", "u96d4-j"];
  for (const tn of templates) {
    const ti = findGlyphIndex(lib, tn);
    if (ti === undefined) continue;
    const kids = childrenOf(lib, ti);
    const co = kids.find((k) => /^u96b9/.test(lib.names[k.ref]!));
    if (!co) continue;
    const other = kids.find((k) => k.strokeIx !== co.strokeIx);
    if (!other) continue;
    console.log(`  試模板 ${tn}（左＝${lib.names[co.ref]}　右＝${lib.names[other.ref]}）`);
    // **一定要從 cur 分叉，不能從 lib**：
    // 先前從原始 lib 分叉，把步驟 1（邏 的 羅 → 寶）的修改整個丟掉，
    // 後面才會「找不到 貝」——因為樹上還是 羅，不是 寶。
    const made = twoPartViaTemplate(cur, ti, "隹", "從");
    if (!made.ok) { console.log("    ✗ " + made.error); continue; }
    // 量一下結果的墨跡是否合理（有沒有溢出離譜）
    try {
      const ink = inkIn(made.lib, made.idx);
      const w = ink.x2 - ink.x1, h = ink.y2 - ink.y1;
      console.log(`    ✓ ${made.log}　墨跡 ${w.toFixed(0)}×${h.toFixed(0)}`);
      jiongIdx = made.idx;
      cur = made.lib;
      steps.push(`𩀨 ＝ 借 ${tn} 的版面放 隹＋從`);
      break;
    } catch (e) {
      console.log("    ✗ 算圖失敗：" + (e as Error).message);
    }
  }
  if (jiongIdx === null) { console.log("✗ 造不出 𩀨"); process.exit(1); }
}

// ---- 步驟 3：把 貝 換成剛才造的 𩀨 ----
console.log("\n步驟 3：貝 → 𩀨");
{
  const r = replaceWithIdx(cur, root, "u8c9d", jiongIdx!);
  if (!r.ok) { console.log("✗ " + r.error); process.exit(1); }
  cur = r.lib;
  steps.push("貝 → 𩀨");
  console.log(`  ✓ ${r.log}`);
}

// ---- 步驟 4：致招（側枝）＝ 致 的 夂 → 招 ----
console.log("\n步驟 4：造側枝 致招 ＝ 致 的 夂 → 招");
let zhaoIdx: number | null = null;
{
  console.log(`  致的直接部件：` +
    refSlotsOf(lib, idxOf("致")!).map((s) => `${s.ch}(${s.zone})`).join(" "));
  const r = composeFit(cur, "致", [["夂", "招"]]);
  if ("error" in r) {
    console.log("  ✗ 夂 換不成，改用「致 的 至 → 招」？");
    const r2 = composeFit(cur, "致", [["至", "招"]]);
    if ("error" in r2) { console.log("  ✗ " + r2.error); }
    else { zhaoIdx = r2.targetIdx; cur = r2.lib; steps.push("致 的 至 → 招"); console.log("  ✓ " + r2.log[0]); }
  } else {
    zhaoIdx = r.targetIdx;
    cur = r.lib;
    steps.push("致 的 夂 → 招");
    console.log("  ✓ " + r.log[0]);
  }
  if (zhaoIdx === null) console.log("  ！側枝造不出來，後面會少一層");
}

// ---- 步驟 5：從 → 側枝 ----
console.log("\n步驟 5：從 → (致招)");
if (zhaoIdx !== null) {
  const r = replaceWithIdx(cur, root, "u5f9e", zhaoIdx);
  if (!r.ok) console.log("  ✗ " + r.error);
  else { cur = r.lib; steps.push("從 → 致招"); console.log("  ✓ " + r.log); }
}

// ---------------------------------------------------------------- 結果

console.log("\n=== 結果 ===");
for (const [i, s] of steps.entries()) console.log(`  ${i + 1}. ${s}`);
try {
  const ink = inkIn(cur, root);
  console.log(`\n最終字形墨跡 [${[ink.x1, ink.y1, ink.x2, ink.y2].map((v) => Math.round(v)).join(",")}]`);
} catch (e) { console.log("量墨跡失敗：" + (e as Error).message); }
try {
  console.log(`跨部件最短距離 ${fmtD(minCrossDistOf(cur, root))}`);
} catch (e) { /* 略 */ }

const outSvg = `${D}/out/grail.svg`;
Bun.write(outSvg, svgOf(cur, root));
console.log(`已寫出 ${outSvg}`);

// 對照圖：原字 邏 ／ 中間結果 ／ 最終
const S = 240;
let x = 10;
const cells: string[] = [];
const addCell = (L: Library, idx: number, label: string, note: string) => {
  try {
    const inner = svgOf(L, idx).replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "");
    cells.push(`<g transform="translate(${x},20)">${inner}</g>`);
  } catch { cells.push(`<text x="${x + S / 2}" y="${S / 2}" text-anchor="middle" font-size="40" fill="#c00">✗</text>`); }
  cells.push(`<text x="${x + S / 2}" y="${S + 44}" text-anchor="middle" font-size="15" font-family="sans-serif" fill="#111">${label}</text>`);
  cells.push(`<text x="${x + S / 2}" y="${S + 62}" text-anchor="middle" font-size="11" font-family="monospace" fill="#666">${note}</text>`);
  x += S + 10;
};
addCell(lib, idxOf("邏")!, "邏（原字）", "基字");
addCell(lib, idxOf("羅")!, "羅", "要被換掉的");
addCell(lib, idxOf("寶")!, "寶", "換上去");
addCell(cur, root, "最終", "邏羅寶貝𩀨從䞃致招");

const W = x, H = S + 74;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
  `<rect width="100%" height="100%" fill="#fff"/><g fill="#111">${cells.join("")}</g></svg>`;
Bun.write(`${D}/out/grail-compare.svg`, svg);
console.log(`已寫出 ${D}/out/grail-compare.svg`);

