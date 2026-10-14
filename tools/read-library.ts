#!/usr/bin/env bun
/**
 * read-library.ts — 精簡字形庫的 Node 端 CLI（往返驗證用）。
 *
 * 解碼實作在 `tools/lib-format.ts`（單一來源，網頁端也用同一份），
 * 這裡只負責：讀檔、對資料庫做逐筆比對。
 *
 * 用法:
 *   bun run tools/read-library.ts --stats
 *   bun run tools/read-library.ts u4e00 u76df ...    # 與資料庫原值逐筆比對
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { decodeLibrary, toKageData, findGlyphIndex } from "./lib-format.ts";

const ROOT = resolve(import.meta.dir, "..");
const LIB = resolve(ROOT, "out/lib-cjk.bin");
const DB = resolve(ROOT, "db/glyphwiki.db");

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  if (!existsSync(LIB)) { console.error(`找不到 ${LIB}`); process.exit(1); }

  const t0 = performance.now();
  const lib = decodeLibrary(readFileSync(LIB));
  console.log(
    `讀取庫: ${lib.names.length.toLocaleString()} 字形、` +
    `${lib.suffix.length.toLocaleString()} 種後綴，${(performance.now() - t0).toFixed(0)}ms`,
  );

  if (argv[0] === "--stats") {
    let withStrokes = 0, totalStrokes = 0;
    for (const g of lib.glyphs) {
      if (g.strokes.length) { withStrokes++; totalStrokes += g.strokes.length; }
    }
    console.log(`有筆畫的字形: ${withStrokes.toLocaleString()}／${lib.names.length.toLocaleString()}`);
    console.log(`筆畫總數: ${totalStrokes.toLocaleString()}`);
    process.exit(0);
  }

  const db = new Database(DB, { readonly: true });
  const getData = db.query("SELECT data FROM glyphs WHERE name = ?");
  /** 查原始資料；帶「去 @版本 → 去 -後綴」退路，與建庫時一致 */
  const lookupOriginal = (n: string): string | null => {
    const r = getData.get(n) as any;
    if (r) return r.data as string;
    const s = n.replace(/@[0-9]+$/, "");
    if (s !== n) { const r2 = getData.get(s) as any; if (r2) return r2.data as string; }
    const b = n.replace(/-[a-z0-9_.]+(@[0-9]+)?$/i, "");
    if (b !== n) { const r3 = getData.get(b) as any; if (r3) return r3.data as string; }
    return null;
  };

  /** 正規化：原始 KAGE 會省略值為 0 的尾欄，補齊後再比對；引用名以 NAME 取代 */
  const norm = (x: string | undefined): string => {
    if (x === undefined) return "(缺)";
    const c = x.split(":");
    const padded = [...c];
    while (padded.length < 12) padded.push("0");
    if (parseInt(c[0]!, 10) !== 99) return padded.slice(0, 11).join(":");
    return [...padded.slice(0, 7), "NAME", ...padded.slice(8, 12)].join(":");
  };

  const targets = argv.filter((a) => !a.startsWith("--"));
  let ok = 0, bad = 0, missing = 0;
  for (const t of targets) {
    const m = /^(?:u\+|U\+|u|U)?([0-9a-fA-F]{4,6})$/.exec(t);
    const base = m ? "u" + m[1]!.toLowerCase() : "";
    const idx = base ? findGlyphIndex(lib, base) : undefined;
    if (idx === undefined) { console.log(`  ${t}: 不在庫中`); missing++; continue; }
    const g = lib.glyphs[idx]!;
    const rebuilt = toKageData(g, lib);
    const orig = lookupOriginal(lib.names[idx]!);
    if (orig === null) { console.log(`  ${t} (${lib.names[idx]}): 資料庫查不到`); missing++; continue; }
    if (orig === rebuilt) { console.log(`  ${t} (${lib.names[idx]}): 完全一致`); ok++; continue; }
    const A = orig.split("$"), B = rebuilt.split("$");
    const diffs: string[] = [];
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
      if (norm(A[i]) !== norm(B[i])) {
        diffs.push(`      筆 ${i}: 原 ${A[i]}\n             新 ${B[i]}`);
      }
    }
    if (diffs.length === 0) {
      console.log(`  ${t} (${lib.names[idx]}): 數值一致（僅引用名經版本退路對應）`);
      ok++;
    } else {
      console.log(`  ${t} (${lib.names[idx]}): 不一致（${diffs.length} 筆）\n${diffs.slice(0, 2).join("\n")}`);
      bad++;
    }
  }
  if (targets.length) console.log(`\n往返驗證: 一致 ${ok} / 不一致 ${bad} / 不在庫 ${missing}`);
  db.close();
}
