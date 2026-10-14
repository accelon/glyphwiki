#!/usr/bin/env bun
/**
 * probe-ids-glyphs.ts — 問兩件事（師父第 124 輪的三個要求要先探路 ✓）：
 *
 *  ① **字庫裡有沒有「IDS 命名」的合成字形** ✓（`u2ff0-u5973-u5b50` ＝ ⿰女子 ✓）？
 *     如果有的話，「輸入 IDS → 故意按 IDC 等比分配組得醜一點」就**現成可用** ✓✓
 *     （GlyphWiki 的合成字正是等比分配畫的 ✓）。
 *  ② **cp → IDS 表**多大（要內嵌頁面 ✓）——raw／gzip／base64 各多少 ✓。
 *
 * 用法: bun run tools/probe-ids-glyphs.ts
 */
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import * as F from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { loadIdsFile } from "./ids-source.ts";

const ROOT = resolve(import.meta.dir, "..");
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });

/* ① 找 IDS 命名的字形 */
const names: string[] = [];
for (let i = 0; i < lib.glyphs.length; i++) {
  const n = F.displayName(lib, i);
  if (n && n.indexOf("u2ff") === 0) names.push(n);
}
console.log(`① 字庫裡「以 IDS 算子命名」的字形：**${names.length.toLocaleString()} 個** ✓`);
console.log(`   例：${names.slice(0, 8).join("、")}`);

/** IDS 字串 → GlyphWiki 的 IDS 命名 ✓（`⿰女子` → `u2ff0-u5973-u5b50` ✓） */
const OPS: Record<string, string> = {
  "⿰": "2ff0", "⿱": "2ff1", "⿲": "2ff2", "⿳": "2ff3", "⿴": "2ff4", "⿵": "2ff5",
  "⿶": "2ff6", "⿷": "2ff7", "⿸": "2ff8", "⿹": "2ff9", "⿺": "2ffa", "⿻": "2ffb",
};
const ARITY: Record<string, number> = {
  "⿰": 2, "⿱": 2, "⿲": 3, "⿳": 3, "⿴": 2, "⿵": 2, "⿶": 2, "⿷": 2, "⿸": 2, "⿹": 2, "⿺": 2, "⿻": 2,
};
function idsToName(s: string): string | null {
  const cs = Array.from(s);
  let i = 0;
  const walk = (): string | null => {
    if (i >= cs.length) return null;
    const c = cs[i]!;
    if (ARITY[c] !== undefined) {
      i++;
      const kids: string[] = [];
      for (let k = 0; k < ARITY[c]!; k++) { const kid = walk(); if (!kid) return null; kids.push(kid); }
      return "u" + OPS[c] + "-" + kids.join("-");
    }
    i++;
    return "u" + c.codePointAt(0)!.toString(16);
  };
  const root = walk();
  return root && i === cs.length ? root : null;
}
const nameSet = new Set(names);
for (const ids of ["⿰女子", "⿰木木", "⿰木⿳金⿰水火土", "⿳𦥯⿰女孔皿", "⿰氵木"]) {
  const n = idsToName(ids);
  console.log(`   ${ids} → ${n}　${n && nameSet.has(n) ? "**庫裡有 ✓**" : "庫裡沒有 ✗"}`);
}

/* ② cp → IDS 表的大小 */
const tab = loadIdsFile(resolve(ROOT, "ids/ids_lv1.txt"));
const rows: string[] = [];
for (const [cp, e] of tab) {
  if (!e.primary.length) continue;
  rows.push(cp.toString(16) + "\t" + e.primary[0]!);
}
const raw = rows.join("\n");
const gz = gzipSync(Buffer.from(raw, "utf8"), { level: 9 });
console.log(`\n② cp → IDS（主要拆法 ✓）：${rows.length.toLocaleString()} 列`);
console.log(`   raw ${(raw.length / 1024 / 1024).toFixed(2)} MB` +
  `｜gzip ${(gz.length / 1024).toFixed(0)} KB` +
  `｜base64(gzip) ${(gz.toString("base64").length / 1024).toFixed(0)} KB ✓` +
  `（頁面現在 3.28 MB → 約 +${(gz.toString("base64").length / 1024 / 1024 / 3.28 * 100).toFixed(0)}% ✓）`);

/* ③ 只存「算子骨架」✓：葉子用字庫既有的 `comp`（本來就來自同一個主要拆法 ✓）→ 表會小很多 ✓ */
function skeletonOf(s: string): string | null {
  const cs = Array.from(s);
  let i = 0, out = "";
  const walk = (): boolean => {
    if (i >= cs.length) return false;
    const c = cs[i]!;
    if (ARITY[c] !== undefined) {
      i++;
      out += c;
      for (let k = 0; k < ARITY[c]!; k++) if (!walk()) return false;
      return true;
    }
    i++;
    return true;
  };
  while (i < cs.length) if (!walk()) return null;
  return out;
}
const skRows: string[] = [];
let skOk = 0;
for (const [cp, e] of tab) {
  if (!e.primary.length) continue;
  const sk = skeletonOf(e.primary[0]!);
  if (!sk) continue;
  skOk++;
  skRows.push(cp.toString(16) + "\t" + sk);
}
const skRaw = skRows.join("\n");
const skGz = gzipSync(Buffer.from(skRaw, "utf8"), { level: 9 });
console.log(`\n③ 只存**算子骨架** ✓（葉子用字庫的「comp」✓）：${skOk.toLocaleString()} 列`);
console.log(`   raw ${(skRaw.length / 1024).toFixed(0)} KB｜gzip ${(skGz.length / 1024).toFixed(0)} KB` +
  `｜base64(gzip) ${(skGz.toString("base64").length / 1024).toFixed(0)} KB ✓` +
  `（頁面 +${(skGz.toString("base64").length / 1024 / 1024 / 3.28 * 100).toFixed(1)}% ✓）`);

