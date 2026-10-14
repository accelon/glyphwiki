#!/usr/bin/env bun
/**
 * name-cost.ts — 字形庫的成本分析：名字層佔多少、v2 省了多少。
 *
 * 這次改格式的起因：舊版（v1）把 GlyphWiki 的名字字串整份寫進檔案
 * （每個字形存「碼位 + 後綴索引」，外加一張後綴表），
 * 佔了 gzip 之後的 **20.7%**。
 *
 * v2 把名字層換成純數值的家族表，並重排字形讓同家族成員連續。
 * 這支工具把兩邊的帳算出來，順便列出對照表（.gnames.tsv.gz）的成本——
 * 那份表**不進前端**，只有除錯／回寫 dump 的工具才載。
 *
 * 用法:
 *   bun run tools/name-cost.ts                     # 對照 v1 與 v2
 *   bun run tools/name-cost.ts --lib out/x.bin.gz  # 只看某一份
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { decodeLibrary } from "./lib-format.ts";
import type { Library } from "./lib-format.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = Bun.argv.slice(2);
const li = argv.indexOf("--lib");
const only = li >= 0 && argv[li + 1] ? resolve(ROOT, argv[li + 1]!) : null;

const gzLen = (b: ArrayBufferView | number[]) => Bun.gzipSync(Buffer.from(b as any), { level: 9 }).length;
const mb = (n: number) => (n / 1048576).toFixed(2);

function readLib(p: string): { lib: Library; raw: number; gz: number; version: 1 | 2 } {
  const rawBytes = readFileSync(p);
  const un = new Uint8Array(Bun.gunzipSync(rawBytes));
  return {
    lib: decodeLibrary(un),
    raw: un.length,
    gz: rawBytes.length,
    version: un[0] === 0x47 && un[1] === 0x4c ? 2 : 1,
  };
}

/** 家族表（v2）／名字表（v1）實際佔的位元組：直接從檔案開頭切出來 */
function nameBlockSize(p: string, version: 1 | 2): number {
  const un = new Uint8Array(Bun.gunzipSync(readFileSync(p)));
  let q = version === 2 ? 3 : 0;
  const rdU = () => { let v = 0, s = 0; for (;;) { const x = un[q++]!; v |= (x & 0x7f) << s; if ((x & 0x80) === 0) return v >>> 0; s += 7; } };
  const rdS = () => { const u = rdU(); return (u >>> 1) ^ -(u & 1); };
  const n = rdU();
  if (version === 2) {
    const nFams = rdU();
    for (let i = 0; i < nFams; i++) { rdS(); rdU(); rdU(); }
  } else {
    const ns = rdU();
    for (let i = 0; i < ns; i++) { const len = rdU(); for (let j = 0; j < len; j++) rdU(); }
    for (let i = 0; i < n; i++) {
      const cp = rdU();
      if (cp !== 0) rdU();
      else { const len = rdU(); for (let j = 0; j < len; j++) rdU(); }
    }
  }
  void n;
  return q - (version === 2 ? 3 : 0);
}

const V1 = resolve(ROOT, "out/lib-cjk.bin.gz");
const V2 = resolve(ROOT, "out/lib-cjk-all.bin.gz");
const targets = only ? [only] : [V1, V2].filter((p) => existsSync(p));

for (const p of targets) {
  const { lib, raw, gz, version } = readLib(p);
  const nb = nameBlockSize(p, version);
  const nbz = gzLen(new Uint8Array(Bun.gunzipSync(readFileSync(p))).subarray(0, nb));
  const rel = p.slice(ROOT.length + 1).replace(/\\/g, "/");
  console.log(`\n=== ${rel}（v${version}）===`);
  console.log(`  字形 ${lib.glyphs.length.toLocaleString()}` +
    (version === 2 ? `、家族 ${lib.families.length.toLocaleString()}、無家族部件 ${(lib.glyphs.length - lib.orphanStart).toLocaleString()}`
                   : `、後綴 ${(lib.suffix?.length ?? 0).toLocaleString()}`));
  console.log(`  檔案 raw ${raw.toLocaleString()} bytes（${mb(raw)} MB）　gzip ${gz.toLocaleString()} bytes（${mb(gz)} MB）`);
  console.log(`  名字／家族區塊 raw ${nb.toLocaleString()}　gzip ${nbz.toLocaleString()}` +
    `　→ 佔全檔 gzip 的 ${(100 * nbz / gz).toFixed(1)}%`);
  const gp = p.replace(/\.bin(\.gz)?$/, "") + ".gnames.tsv.gz";
  if (existsSync(gp)) {
    const sraw = Bun.gunzipSync(readFileSync(gp));
    console.log(`  名字對照表（不進前端）raw ${sraw.length.toLocaleString()}（${mb(sraw.length)} MB）` +
      `　gzip ${readFileSync(gp).length.toLocaleString()}（${mb(readFileSync(gp).length)} MB）`);
  } else {
    console.log(`  名字對照表：無（這份是 v1，名字就在檔案裡）`);
  }
}

if (!only && existsSync(V1) && existsSync(V2)) {
  const a = readLib(V1), b = readLib(V2);
  const an = nameBlockSize(V1, 1), bn = nameBlockSize(V2, 2);
  const ang = gzLen(new Uint8Array(Bun.gunzipSync(readFileSync(V1))).subarray(0, an));
  const bng = gzLen(new Uint8Array(Bun.gunzipSync(readFileSync(V2))).subarray(0, bn));
  console.log(`\n=== 名字層：v1（BMP 字庫）→ v2（全 CJK 字庫）===`);
  console.log(`  字形數 ${a.lib.glyphs.length.toLocaleString()} → ${b.lib.glyphs.length.toLocaleString()}` +
    `（×${(b.lib.glyphs.length / a.lib.glyphs.length).toFixed(2)}）`);
  console.log(`  名字／家族區塊 raw  ${an.toLocaleString()} → ${bn.toLocaleString()}`);
  console.log(`  名字／家族區塊 gzip ${ang.toLocaleString()} → ${bng.toLocaleString()}`);
  console.log(`  佔全檔 gzip        ${(100 * ang / a.gz).toFixed(1)}% → ${(100 * bng / b.gz).toFixed(1)}%`);
  console.log(`  攤到每個字形：      ${(ang / a.lib.glyphs.length).toFixed(2)} → ` +
    `${(bng / b.lib.glyphs.length).toFixed(2)} bytes／字`);
  console.log(`  全檔 gzip          ${mb(a.gz)} MB → ${mb(b.gz)} MB` +
    `（字形多了 ${(100 * (b.lib.glyphs.length / a.lib.glyphs.length - 1)).toFixed(0)}%，` +
    `檔案只多 ${(100 * (b.gz / a.gz - 1)).toFixed(0)}%）`);
}
