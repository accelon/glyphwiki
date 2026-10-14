#!/usr/bin/env bun
/**
 * probe-ids-gap.ts — 把 IDS 的部件關係接進 KAGE 索引，能多找到多少、要多花多少 bytes？
 *
 * 背景：`build-components.ts` 建 `glyph_components` 時，遇到
 * 「KAGE 把複合部件歸併、只留原始筆劃」的節點會改用 IDS 展開
 * （杏 = ⿱木口，KAGE 的 u674f-j 卻只有「口」一個 ref）。
 * 瀏覽器目前是自己從 KAGE ref 現推索引，所以看不到這些 IDS 才有的關係。
 *
 * 這支把兩邊接起來算**閉包**，才知道真正的差額：
 *   A = 只用 KAGE ref 的閉包          （＝瀏覽器現在的效果）
 *   B = KAGE ref ∪ IDS 直接部件的閉包  （接上 IDS 之後）
 *
 * 用法: bun run tools/probe-ids-gap.ts
 */
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { indexOfCodePoint, codePointOf, isPlainIdeograph, displayName, keyOfIdx } from "./lib-format.ts";
import { refSlotsOf } from "./free-compose.ts";
import type { Library } from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";

const ROOT = resolve(import.meta.dir, "..");
const db = new Database(resolve(ROOT, "db/glyphwiki.db"), { readonly: true });
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"));
const L: Library = lib;

/* ---- KAGE 的直接子節點（字形索引） ---- */
function kageKids(i: number): number[] {
  const out: number[] = [];
  for (const s of L.glyphs[i]!.strokes) if (s.kind === 99 && s.ref !== null) out.push(s.ref);
  return out;
}

/* ---- IDS 直接部件（碼位），按碼位查 ---- */
const idsDirect = new Map<number, number[]>();
for (const r of db.query("SELECT codepoint, comp_cp FROM glyph_components WHERE level='direct'").all() as
  { codepoint: number; comp_cp: number }[]) {
  const a = idsDirect.get(r.codepoint);
  if (a) a.push(r.comp_cp); else idsDirect.set(r.codepoint, [r.comp_cp]);
}

/** 閉包（碼位集合）。useIds=true 時，每到一個節點就把它碼位的 IDS 直接部件也展開。 */
function closure(startIdx: number, useIds: boolean): Set<number> {
  const out = new Set<number>();
  const seenIdx = new Set<number>();
  const stack = [startIdx];
  while (stack.length) {
    const i = stack.pop()!;
    if (seenIdx.has(i)) continue;
    seenIdx.add(i);
    const cp = codePointOf(L, i);
    if (cp != null && cp !== codePointOf(L, startIdx)) out.add(cp);
    for (const k of kageKids(i)) stack.push(k);
    if (useIds && cp != null) {
      for (const c of idsDirect.get(cp) ?? []) {
        const ci = indexOfCodePoint(L, c);
        if (ci !== undefined) stack.push(ci);
        else out.add(c);          /* 庫裡沒有的部件也記，才看得出差額 */
      }
    }
  }
  return out;
}

type Delta = { glyphs: number; pairs: number; examples: string[] };
function compare(): { a: Delta; b: Delta } {
  const a: Delta = { glyphs: 0, pairs: 0, examples: [] };
  const b: Delta = { glyphs: 0, pairs: 0, examples: [] };
  for (let i = 0; i < L.glyphs.length; i++) {
    if (!isPlainIdeograph(L, i)) continue;
    const cp = codePointOf(L, i);
    if (cp == null) continue;
    const ka = closure(i, false);
    const kb = closure(i, true);
    let da = 0, dbb = 0;
    for (const c of ka) if (!kb.has(c)) da++;      /* 加了 IDS 反而少的（不該有） */
    for (const c of kb) if (!ka.has(c)) dbb++;
    if (dbb) { b.glyphs++; b.pairs += dbb; if (b.examples.length < 14) b.examples.push(`  ${String.fromCodePoint(cp)} U+${cp.toString(16).toUpperCase()}：+${[...kb].filter((c) => !ka.has(c)).map((c) => String.fromCodePoint(c)).join("")}`); }
    if (da) { a.glyphs++; a.pairs += da; }
  }
  return { a, b };
}

const t = performance.now();
const { a, b } = compare();
console.log(`掃完 ${((performance.now() - t) / 1000).toFixed(1)} 秒\n`);
console.log("=== 接上 IDS 之後，索引會多出多少 ===");
console.log(`  多出：${b.glyphs.toLocaleString()} 個字、${b.pairs.toLocaleString()} 條邊`);
console.log(`  變少：${a.glyphs.toLocaleString()} 個字、${a.pairs.toLocaleString()} 條邊（應該接近 0）`);
console.log("\n=== 例子 ===");
for (const e of b.examples) console.log(e);

console.log("\n=== 打包這 81k 條邊要多少 ===");
{
  /* 邊 = (字形索引 delta, 部件碼位 delta)，兩者都單調 → varint delta 編碼 */
  const rows: [number, number][] = [];
  for (let i = 0; i < L.glyphs.length; i++) {
    if (!isPlainIdeograph(L, i)) continue;
    const cp = codePointOf(L, i);
    if (cp == null) continue;
    const ka = closure(i, false), kb = closure(i, true);
    for (const c of kb) if (!ka.has(c)) rows.push([i, c]);
  }
  rows.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const buf: number[] = [];
  const vint = (n: number) => { while (n >= 128) { buf.push((n & 127) | 128); n >>>= 7; } buf.push(n); };
  let pi = 0, pc = 0;
  vint(rows.length);
  for (const [i, c] of rows) { vint(i - pi); vint(c - pc); pi = i; pc = c; }
  const raw = new Uint8Array(buf);
  const gz = Bun.gzipSync(raw, { level: 9 });
  console.log(`  ${rows.length.toLocaleString()} 條邊：raw ${(raw.length / 1024).toFixed(0)} KB、` +
    `gzip ${(gz.length / 1024).toFixed(0)} KB、base64(v2) ${(Math.ceil(gz.length / 3) * 4 / 1024).toFixed(0)} KB`);
}

console.log("\n=== 杏／林／杉 ===");
for (const cp of [0x674F, 0x6797, 0x6749]) {
  const i = indexOfCodePoint(L, cp);
  const k = i !== undefined ? closure(i, false) : new Set<number>();
  const j = i !== undefined ? closure(i, true) : new Set<number>();
  const s = (x: Set<number>) => [...x].sort((p, q) => p - q).map((c) => String.fromCodePoint(c)).join("") || "（空）";
  console.log(`  ${String.fromCodePoint(cp)} U+${cp.toString(16).toUpperCase()}` +
    (i === undefined ? "（不在庫）" : `　代表字形 ${displayName(L, i)}`));
  console.log(`     KAGE 閉包：${s(k)}`);
  console.log(`     ＋IDS 後：${s(j)}`);
  if (i !== undefined) console.log(`     直接 ref：` + (refSlotsOf(L, i).map((x) => {
    const c = codePointOf(L, x.ref); return c ? String.fromCodePoint(c) : displayName(L, x.ref);
  }).join(" ") || "（無）"));
}
void keyOfIdx;
