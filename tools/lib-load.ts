// lib-load.ts — Node 端載入字庫的單一入口（含可選的 GlyphWiki 名字對照表）。
//
// 為什麼要有這一支：字庫檔（v2）裡**沒有名字字串**，名字放在旁邊的
// `<lib>.gnames.tsv.gz` 對照表。前端不需要它，但命令列工具要印出
// `u908f-j` 這種可讀名字時就得載進來。把這段邏輯收在一處，
// 才不會每個工具各寫一份路徑拼接。
//
// **這個檔案只能在 Node/Bun 用**（用到 fs）；不要被網頁內嵌。
import { readFileSync, existsSync } from "node:fs";
import { decodeLibrary, loadWikiNames, displayName, type Library } from "./lib-format.ts";

/** 預設字庫：全部 Unicode CJK 漢字區塊（URO ＋ Ext A..I ＋ 相容區） */
export const DEFAULT_LIB = "out/lib-cjk-all.bin.gz";

/** 由字庫路徑推出對照表路徑：`x.bin.gz` → `x.gnames.tsv.gz` */
export function gnamesPathOf(libPath: string): string {
  return libPath.replace(/\.bin(\.gz)?$/, "") + ".gnames.tsv.gz";
}

export interface Loaded {
  lib: Library;
  /** 對照表載入了幾筆（0 ＝ 沒有對照表，名字會顯示成內部 key） */
  names: number;
}

/**
 * 載入字庫。若旁邊有對照表就一併載入，讓 `displayName()` 印得出
 * GlyphWiki 的名字；沒有也不會壞，只是名字變成內部 key。
 */
export function loadLibrary(libPath: string, opts: { withNames?: boolean } = {}): Loaded {
  const lib = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(libPath))));
  let names = 0;
  const gp = gnamesPathOf(libPath);
  if (opts.withNames !== false && existsSync(gp)) {
    names = loadWikiNames(lib, Buffer.from(Bun.gunzipSync(readFileSync(gp))).toString("utf8"));
  }
  return { lib, names };
}

export { displayName };
