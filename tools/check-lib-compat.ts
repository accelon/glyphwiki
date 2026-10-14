#!/usr/bin/env bun
/**
 * check-lib-compat.ts — 新舊 `findGlyphIndex` 的逐碼位對照。
 *
 * 這是這次改格式最重要的回歸測試：`lib-format.ts` 從「名字當介面」改成
 * 「碼位當介面」之後，**舊字庫（v1）選出來的字形必須一個都不差**，
 * 否則內嵌舊字庫的兩個網頁（kage-viewer／codemirror-kage）行為會變。
 *
 * 做法：把舊版 `findGlyphIndex` 的演算法原封不動抄一份在這裡當基準，
 * 跟新的 `indexOfCodePoint` 對全部碼位逐一比對。
 *
 * 用法: bun run tools/check-lib-compat.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  decodeLibrary, indexOfCodePoint, codePointOf, keyOfIdx, displayName, loadWikiNames,
} from "./lib-format.ts";
import type { Library } from "./lib-format.ts";

const ROOT = resolve(import.meta.dir, "..");

/** 舊版 findGlyphIndex（照抄，當作黃金標準） */
function oldFindGlyphIndex(lib: Library, base: string): number | undefined {
  const names = lib.names ?? [];
  let best: number | undefined;
  for (let i = 0; i < names.length; i++) {
    const nm = names[i]!;
    if (nm === base + "-j") return i;
    if (nm === base) {
      if (best === undefined) best = i;
      continue;
    }
    if (nm.startsWith(base + "-") && !/@/.test(nm)) {
      if (best === undefined || nm.length < names[best]!.length) best = i;
    }
  }
  return best;
}

const argv = Bun.argv.slice(2);
const files = argv.length ? argv : ["out/lib-cjk.bin.gz", "out/lib-cjk-all.bin.gz"];
let bad = 0;
for (const rel of files) {
  const p = resolve(ROOT, rel);
  let lib: Library;
  try {
    lib = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(p))));
  } catch (e) {
    console.log(`✗ ${rel}：${(e as Error).message}`);
    bad++;
    continue;
  }
  const isV1 = !!lib.names;
  console.log(`\n=== ${rel}（${isV1 ? "v1" : "v2"}，${lib.glyphs.length.toLocaleString()} 字形）===`);

  if (!isV1) {
    console.log("  v2 沒有名字可比；改檢查「家族覆蓋率」與「代表成員的自我一致性」");
    let famGlyphs = 0, orphan = 0, badPref = 0;
    for (let i = 0; i < lib.glyphs.length; i++) {
      const cp = codePointOf(lib, i);
      if (cp) famGlyphs++; else orphan++;
      if (cp) {
        const rep = indexOfCodePoint(lib, cp);
        if (rep === undefined || codePointOf(lib, rep) !== cp) badPref++;
      }
    }
    console.log(`  有碼位的字形 ${famGlyphs.toLocaleString()}、無碼位 ${orphan.toLocaleString()}；代表成員異常 ${badPref}`);
    if (badPref) bad++;
    continue;
  }

  // v1：所有出現過的碼位，逐一比對
  const cps = new Set<number>();
  for (const nm of lib.names!) {
    const m = /^u([0-9a-f]{4,6})/i.exec(nm);
    if (m) cps.add(parseInt(m[1]!, 16));
  }
  let diff = 0, same = 0;
  const samples: string[] = [];
  for (const cp of cps) {
    const base = "u" + cp.toString(16);
    const a = oldFindGlyphIndex(lib, base);
    const b = indexOfCodePoint(lib, cp);
    if (a === b) same++;
    else {
      diff++;
      if (samples.length < 6) {
        samples.push(`    U+${cp.toString(16).toUpperCase()}　舊=${a === undefined ? "(無)" : lib.names![a]}　新=${b === undefined ? "(無)" : keyOfIdx(lib, b)}`);
      }
    }
  }
  console.log(`  碼位 ${cps.size.toLocaleString()} 個：一致 ${same.toLocaleString()}、不一致 ${diff}`);
  for (const s of samples) console.log(s);
  if (diff) bad++;
}

// ---------------------------------------------------------------- 跨字庫
//
// 舊庫（BMP）與新庫（BMP+ExtB）是**不同的閉包**，所以同一個碼位可能挑到
// 不同的異體——這不是 bug，而是「Ext B 把更多 `-j` 變體拉進閉包」的必然結果。
// 這裡要求的是：**挑到的字形必須真的屬於那個碼位**（同一家族），
// 變體不同只記錄不判錯。

{
  const pA = resolve(ROOT, "out/lib-cjk.bin.gz");
  const pB = resolve(ROOT, "out/lib-cjk-all.bin.gz");
  if (existsSync(pA) && existsSync(pB)) {
    console.log("\n=== 跨字庫：同一個碼位在兩份庫裡指到哪個字形 ===");
    const A = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(pA))));
    const B = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(pB))));
    const gpB = resolve(ROOT, "out/lib-cjk-all.gnames.tsv.gz");
    if (existsSync(gpB)) loadWikiNames(B, Buffer.from(Bun.gunzipSync(readFileSync(gpB))).toString("utf8"));

    let sameName = 0, diffVariant = 0, wrongFamily = 0, onlyB = 0;
    const samples: string[] = [];
    // 掃到 Ext H 的尾端（U+323AF），不要只掃到 Ext B
    for (let cp = 0; cp <= 0x323af; cp++) {
      const ia = indexOfCodePoint(A, cp);
      const ib = indexOfCodePoint(B, cp);
      if (ia === undefined && ib === undefined) continue;
      if (ib !== undefined && codePointOf(B, ib) !== cp) {
        wrongFamily++;
        if (samples.length < 6) samples.push(`    ✗ U+${cp.toString(16).toUpperCase()} 新庫指到 ${displayName(B, ib)}（碼位不符）`);
      }
      if (ia === undefined) { onlyB++; continue; }
      if (ib === undefined) continue;
      if (codePointOf(A, ia) !== cp) { wrongFamily++; continue; }
      const na = A.names?.[ia] ?? keyOfIdx(A, ia);
      const nb = displayName(B, ib);
      if (na === nb) sameName++;
      else {
        diffVariant++;
        if (samples.length < 6) samples.push(`    U+${cp.toString(16).toUpperCase()}　BMP 庫 ${na}　→　全字庫 ${nb}`);
      }
    }
    console.log(`  BMP 庫也有的碼位：指名相同 ${sameName.toLocaleString()}、指名不同異體 ${diffVariant.toLocaleString()}`);
    console.log(`  只有全字庫才有的碼位：${onlyB.toLocaleString()}`);
    console.log(`  指到錯的碼位（＝真的壞了）：${wrongFamily}`);
    for (const s of samples) console.log(s);
    if (wrongFamily) bad++;
    else console.log("  ✓ 跨字庫：每個碼位都指到屬於自己的字形（異體差異不判錯）");

    // ---- 區塊覆蓋率 ----
    // 「收了全部 CJK 擴充區」這句話要用數字證明，不能靠印象。
    console.log("\n=== 全字庫的 CJK 區塊覆蓋率 ===");
    const BLOCKS: [string, number, number][] = [
      ["Ext A", 0x3400, 0x4dbf], ["URO", 0x4e00, 0x9fff],
      ["相容區", 0xf900, 0xfaff],
      ["Ext B", 0x20000, 0x2a6df], ["Ext C", 0x2a700, 0x2b73f],
      ["Ext D", 0x2b740, 0x2b81f], ["Ext E", 0x2b820, 0x2ceaf],
      ["Ext F", 0x2ceb0, 0x2ebef], ["Ext I", 0x2ebf0, 0x2ee5f],
      ["相容補充", 0x2f800, 0x2fa1f],
      ["Ext G", 0x30000, 0x3134f], ["Ext H", 0x31350, 0x323af],
    ];
    let total = 0, empty: string[] = [];
    for (const [name, a, b] of BLOCKS) {
      let n = 0;
      for (let cp = a; cp <= b; cp++) if (indexOfCodePoint(B, cp) !== undefined) n++;
      total += n;
      if (n === 0) empty.push(name);
      console.log(`  ${name.padEnd(9)} U+${a.toString(16).toUpperCase().padStart(5, "0")}..U+${b.toString(16).toUpperCase().padStart(5, "0")}  ${String(n).padStart(6)}`);
    }
    console.log(`  ${"合計".padEnd(8)} ${total.toLocaleString().padStart(32)}`);
    if (empty.length) bad(`空的區塊：${empty.join("、")}`);
    else console.log("  ✓ 12 個 CJK 區塊全部有字");
  }
}

/* ---- 只有落在字集區段內的碼位才可以有家族 ----
   GlyphWiki 把 IDS 合成字形命名成 `u2ff0-u9b2f-u5bf8`，而 dump 把它的 name_type
   標成 suffix、codepoint = 0x2FF0（＝「⿰ 的異體」）。照單全收的話
   ⿰ 底下會掛 698 個成員、⿱ 掛 2,270 個，於是「某個異體被誰引用」會撈出
   U+2FF0 這種根本不該出現在字集裡的 IDC，畫出來還是別的字。
   這一條把那種情況鎖死。 */
{
  const RANGES: [number, number][] = [
    [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff],
    [0x20000, 0x2a6df], [0x2a700, 0x2b73f], [0x2b740, 0x2b81f],
    [0x2b820, 0x2ceaf], [0x2ceb0, 0x2ebef], [0x2ebf0, 0x2ee5f],
    [0x2f800, 0x2fa1f], [0x30000, 0x3134f], [0x31350, 0x323af],
  ];
  const inR = (cp: number) => RANGES.some(([a, b]) => cp >= a && cp <= b);

  const L = decodeLibrary(new Uint8Array(Bun.gunzipSync(
    readFileSync(resolve(ROOT, "out/lib-cjk-all.bin.gz")))));
  const outside = L.families.filter((f) => !inR(f.cp));
  outside.length === 0
    ? console.log(`\n  ✓ 家族全部落在 12 個 CJK 區塊內（${L.families.length.toLocaleString()} 個）`)
    : bad(`有 ${outside.length} 個家族落在區段外，前幾個：` +
        outside.slice(0, 6).map((f) => "U+" + f.cp.toString(16).toUpperCase()).join(" "));

  const idc: string[] = [];
  for (let cp = 0x2ff0; cp <= 0x2ffb; cp++) {
    if (indexOfCodePoint(L, cp) !== undefined) idc.push("U+" + cp.toString(16).toUpperCase());
  }
  idc.length === 0
    ? console.log("  ✓ IDC 組字運算子 U+2FF0–U+2FFB 沒有被當成字（不會出現在搜尋結果裡）")
    : bad(`IDC 被當成字了：${idc.join(" ")}`);
}

console.log(bad ? `\n✗ 有 ${bad} 項不通過` : `\n✓ 全部通過`);
process.exit(bad ? 1 : 0);