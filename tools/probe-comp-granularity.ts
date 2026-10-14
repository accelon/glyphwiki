#!/usr/bin/env bun
/**
 * probe-comp-granularity.ts — `LIB.comp` 是**直接分量**還是**攤平的葉**？（決定「找序」怎麼比 ✓）
 *
 * 為什麼要問：師父第 125 輪的例子「`⿰木垚` → 建議 `桂圭垚`」✓ 靠的是
 * 「找一個字，它的分量序列與目標**只差一個位置**」✓——
 * 如果 `comp` 是**攤平**的（桂 ＝ 木,土,土 ✗），那 `⿰木垚` 就比不到 `桂` ✗；
 * 如果是**直接分量**（桂 ＝ 木,圭 ✓）就可以 ✓。
 *
 * 用法: bun run tools/probe-comp-granularity.ts
 */
import { resolve } from "node:path";
import * as F from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { loadIdsFile } from "./ids-source.ts";

const ROOT = resolve(import.meta.dir, "..");
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
const ch = (cp: number) => { try { return String.fromCodePoint(cp); } catch { return "?" }; };

const tab = loadIdsFile(resolve(ROOT, "ids/ids_lv1.txt"));
console.log("字　|　LIB.comp（字庫）　|　ids_lv1 的主要拆法（來源）");
for (const c of ["好", "學", "桂", "杜", "林", "想", "垚", "木", "𰻞"]) {
  const cp = c.codePointAt(0)!;
  const comps = lib.comp?.get(cp) ?? [];
  const e = tab.get(cp);
  console.log(`${c}\t| ${comps.length} 個：${comps.map((x: number) => ch(x)).join("＋") || "（無）"}` +
    `\t| ${e ? e.primary[0] ?? "（無）" : "（來源沒有）"}`);
}

/* 關鍵測試：`⿰木垚` 的目標葉是 [木, 垚] ✓——有沒有字的分量序列與它**只差一個位置**？ ✓ */
const target = [0x6728, 0x579a];                 /* 木, 垚 */
console.log(`\n目標葉：${target.map(ch).join("＋")}（⿰木垚）`);
const hits: { cp: number; comps: number[]; diff: number }[] = [];
for (const [cp, comps] of lib.comp ?? []) {
  if (comps.length !== target.length) continue;
  let diff = -1, n = 0;
  for (let i = 0; i < comps.length; i++) if (comps[i] !== target[i]) { diff = i; n++; }
  if (n !== 1) continue;
  hits.push({ cp, comps, diff });
}
console.log(`只差一個位置的字：${hits.length.toLocaleString()} 個`);
const bmp = hits.filter((h) => h.cp >= 0x4e00 && h.cp <= 0x9fff);
console.log(`其中一般漢字 ${bmp.length} 個，前 12 個（依碼位 ✓）：`);
for (const h of bmp.slice(0, 12)) {
  const old = h.comps[h.diff]!;
  console.log(`  ${ch(h.cp)}（U+${h.cp.toString(16).toUpperCase()}）＝${h.comps.map(ch).join("＋")}` +
    `　→ 序：${ch(h.cp)}${ch(old)}${ch(target[h.diff]!)}`);
}
console.log(`\n師父的例子「桂」在不在裡面：${bmp.some((h) => h.cp === 0x6842) ? "**在 ✓**" : "不在 ✗"}`);
