/**
 * lib-names.ts — 把側檔的名字表接回字庫。
 *
 * v4 起字庫檔案**不再存名字**（名字很長，只有除錯／回寫 dump 要用），
 * 建庫時另外寫一份 `out/lib-cjk-all.gnames.tsv.gz`（每列 `索引\tGlyphWiki 名字`）。
 * 命令列工具若要用 `L.names`，在 `decodeLibrary()` 之後呼叫這個。
 *
 * ⚠ 這一支只能在命令列用（讀檔案），不要被網頁模組匯入。
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { Library } from "./lib-format.ts";

/** 讀 `.gnames.tsv.gz`，回傳索引 → 名字 */
export function readGnames(gzPath: string): string[] {
  const text = gunzipSync(readFileSync(gzPath)).toString("utf8");
  const names: string[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    names[Number(line.slice(0, tab))] = line.slice(tab + 1);
  }
  return names;
}

/** 接上名字（回傳同一個 lib，方便串接）。`libPath` 給 `.bin.gz`，自動換算側檔名。 */
export function attachNames(L: Library, libPath = "D:/2023/glyphwiki/out/lib-cjk-all.bin.gz"): Library {
  const gz = libPath.replace(/\.bin(\.gz)?$/, "") + ".gnames.tsv.gz";
  L.names = readGnames(gz);
  L.gwiki = L.names;
  return L;
}
