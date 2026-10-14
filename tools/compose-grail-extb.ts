#!/usr/bin/env bun
/**
 * compose-grail-extb.ts — 用「含 Ext B」的字庫跑 holy grail：邏羅寶貝𩀨從䞃致招
 *
 * ---------------------------------------------------------------------------
 * 為什麼加了 Ext B 就變簡單
 * ---------------------------------------------------------------------------
 * 舊字庫只收 BMP，所以 `𩀨`（U+29028，CJK Ext B）不在庫裡，
 * 得靠 `twoPartViaTemplate`「借一個隹在左的字、把右件換成從」硬造一個假的 𩀨
 * ——借來的版面終究不是 𩀨 自己的版面。
 *
 * 現在 Ext B 進庫了，`𩀨` 就是庫裡的真字（`u29028-j`），
 * 它的引用框是人工調好的資產，可以原封不動沿用。
 * 於是整條序列**直接用既有的 `evalSeq` 就跑得完**，不需要任何特殊動作：
 *
 *   evalSeq("邏羅寶貝𩀨從䞃致招")
 *     邏 的 羅 → 寶貝𩀨從䞃致招          ← 遞歸
 *       寶 的 貝 → 𩀨從䞃致招            ← 遞歸
 *         𩀨 的 從 → 䞃致招              ← 遞歸
 *           䞃 的 致 → 招                ← 葉：單一部件
 *
 * 括號讀法（由內而外）：
 *   (䞃 的 致 → 招) → 代入 𩀨 的 從 → 代入 寶 的 貝 → 代入 邏 的 羅
 *
 * 附帶驗收：`隹 在左` 的位置搜尋現在會找到 `𩀨` 自己
 * （舊字庫搜不到，因為它根本不在庫裡）——這證明「一套數據」同時滿足組字與查字。
 *
 * 用法:
 *   bun run tools/compose-grail-extb.ts
 *   bun run tools/compose-grail-extb.ts --lib out/lib-cjk-all.bin.gz
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import {
  toKageData, indexOfChar, charOf, displayName, keyOfIdx, codePointOf, isVariantOfCp,
} from "./lib-format.ts";
import type { Library } from "./lib-format.ts";
import { loadLibrary, DEFAULT_LIB } from "./lib-load.ts";
import { ensureEngine, inkIn, svgOf, inkOfRefInParent } from "./compose-fit.ts";
import { evalSeq, searchByComponent } from "./free-compose.ts";
import { minCrossDistOf } from "./stroke-overlap.ts";
import { rasterize, diffAscii } from "./raster.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = Bun.argv.slice(2);
const valOf = (f: string, d: string) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};

const SEQ = "邏羅寶貝𩀨從䞃致招";
const libPath = resolve(ROOT, valOf("--lib", DEFAULT_LIB));

ensureEngine();
const t0 = Date.now();
const { lib, names: nNames } = loadLibrary(libPath);
console.log(`字庫 ${libPath}`);
console.log(`  ${lib.glyphs.length.toLocaleString()} 個字形、` +
  `家族 ${lib.families.length.toLocaleString()} 個、` +
  `解碼＋算緊框 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  對照表 ${nNames.toLocaleString()} 筆` +
  (nNames ? "（顯示用 GlyphWiki 名字）" : "（沒有對照表，名字顯示成內部 key）") + "\n");

const cp = (c: string) => "U+" + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
const idxOf = (c: string) => indexOfChar(lib, c);
const refBox = (b: { x1: number; y1: number; x2: number; y2: number }) =>
  `[${[b.x1, b.y1, b.x2, b.y2].map((v) => v.toFixed(0)).join(",")}]`;

// ---------------------------------------------------------------- 1. 逐字檢查

console.log(`=== 1. 序列 ${SEQ}（${Array.from(SEQ).length} 字）逐字檢查 ===`);
const missing: string[] = [];
for (const c of Array.from(SEQ)) {
  const i = idxOf(c);
  if (i === undefined) { missing.push(c); console.log(`  ${c}  ${cp(c)}  ✗ 不在字庫`); continue; }
  const g = lib.glyphs[i]!;
  const refs = g.strokes.filter((s) => s.kind === 99).length;
  console.log(
    `  ${c}  ${cp(c).padEnd(8)}  ${displayName(lib, i).padEnd(10)} ` +
    `緊框[${g.tight!.join(",")}]  ${refs ? `引用 ${refs}` : `筆畫 ${g.strokes.length}`}`,
  );
}
if (missing.length) {
  console.log(`\n✗ 仍有 ${missing.length} 個字不在庫中：${missing.join("")}——後面會失敗`);
} else {
  console.log(`\n✓ 九個字全部在庫中（含 Ext B 的 𩀨 U+29028）`);
}

// ---------------------------------------------------------------- 2. 求值

console.log(`\n=== 2. 用既有的 evalSeq 求值（不需要任何特殊動作）===`);
const t1 = Date.now();
const r = evalSeq(lib, SEQ);
console.log(`  求值 ${Date.now() - t1} ms`);
if (!r.ok) {
  console.error(`✗ ${r.error}`);
  process.exit(1);
}
console.log(`  substituted=${r.substituted}（true ＝ 真的是遞歸替換，不是退化成串接）`);
for (const [i, line] of r.log.entries()) console.log(`  ${i + 1}. ${line}`);

const root = r.targetIdx;
const outLib = r.lib;

// ---------------------------------------------------------------- 3. 量測

console.log(`\n=== 3. 量測 ===`);
const ink = inkIn(outLib, root);
console.log(`  最終墨跡 ${refBox(ink)}　（${(ink.x2 - ink.x1).toFixed(0)}×${(ink.y2 - ink.y1).toFixed(0)}）`);
const baseIdx = idxOf("邏")!;
const baseInk = inkIn(lib, baseIdx);
console.log(`  原字 邏 墨跡 ${refBox(baseInk)}`);
try {
  const d = minCrossDistOf(outLib, root);
  const baseD = minCrossDistOf(lib, baseIdx);
  console.log(`  跨部件最短距離 ${Number.isFinite(d) ? d.toFixed(1) : "無"}` +
    `（原字 邏 ${Number.isFinite(baseD) ? baseD.toFixed(1) : "無"}）`);
} catch (e) { console.log("  跨部件距離：算不出來（" + (e as Error).message + "）"); }

// 每個關鍵部件最終佔多大——直接回答「招 有沒有被縮爛」。
//
// 注意**不能**只用 `inkOfRefInParent`：那量的是「在**直接父字**座標系裡」的大小，
// 不是成品裡的大小。巢狀替換會一層一層再縮，所以必須把整條路徑的仿射疊起來。
// kage.js 的引用映射是 x' = bx1 + x*(bx2-bx1)/200、y' = by1 + y*(by2-by1)/200
// （x、y 各自縮放，可非等比），沿路相乘即可。
console.log(`\n  關鍵部件在成品裡的大小（沿整條引用鏈疊起來的實際墨跡，不是量框）：`);
for (const c of ["隹", "貝", "招", "致", "從", "羅"]) {
  const ci = idxOf(c);
  if (ci === undefined) continue;
  const own = inkIn(lib, ci);
  const ownW = own.x2 - own.x1, ownH = own.y2 - own.y1;
  let best: { w: number; h: number } | null = null;
  // 仿射：x' = ax*x + ex，y' = ay*y + ey（kage 的框映射是對角線性的）
  const walk = (i: number, ax: number, ex: number, ay: number, ey: number, seen: Set<number>) => {
    if (seen.has(i)) return;
    const next = new Set(seen);
    next.add(i);
    const g = outLib.glyphs[i]!;
    for (const s of g.strokes) {
      if (s.kind !== 99 || s.ref === null || !s.box) continue;
      const b = s.box;
      const bx2 = ax * (b[2]! - b[0]!) / 200, bex = ex + ax * b[0]!;
      const by2 = ay * (b[3]! - b[1]!) / 200, bey = ey + ay * b[1]!;
      if (isVariantOfCp(outLib, s.ref, c.codePointAt(0)!)) {
        const child = inkIn(outLib, s.ref);
        const w = Math.abs((child.x2 - child.x1) * bx2);
        const h = Math.abs((child.y2 - child.y1) * by2);
        if (!best || w * h > best.w * best.h) best = { w, h };
      }
      walk(s.ref, bx2, bex, by2, bey, next);
    }
  };
  walk(root, 1, 0, 1, 0, new Set());
  const got = best
    ? `　成品中 ${best.w.toFixed(0)}×${best.h.toFixed(0)}　` +
      `（寬 ${(100 * best.w / Math.max(1, ownW)).toFixed(0)}%、高 ${(100 * best.h / Math.max(1, ownH)).toFixed(0)}%）`
    : "　（成品中已不存在——被換掉了）";
  console.log(`    ${c}  自身墨跡 ${ownW.toFixed(0)}×${ownH.toFixed(0)}${got}`);
}

// ---------------------------------------------------------------- 4. 查字（同一套數據）

console.log(`\n=== 4. 查字：位置搜尋（同一套數據）===`);
{
  const t = Date.now();
  const hits = searchByComponent(lib, {
    ch: "隹", pos: "左", level: 1, limit: 40, inkOfRef: inkOfRefInParent,
  });
  console.log(`  「隹 在左」→ ${hits.length} 筆（${Date.now() - t} ms）`);
  for (const h of hits.slice(0, 12)) {
    const mark = /^u29028/.test(h.refName) ? "  ← 𩀨（Ext B，本次新增）" : "";
    console.log(`    ${h.ch}  ${h.refName.padEnd(10)} 父字 ${h.parentName.padEnd(10)} 區位 ${h.zone}${mark}`);
  }
}

// ---------------------------------------------------------------- 5. 輸出

console.log(`\n=== 5. 輸出 ===`);
const svgPath = resolve(ROOT, "out/grail-extb.svg");
writeFileSync(svgPath, svgOf(outLib, root));
console.log(`  已寫出 ${svgPath}`);

// ---- 自帶 PNG 編碼器（不依賴任何外部工具）----
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
/** 8-bit 灰階 PNG（每列前面一個 filter byte 0）
 *
 *  踩過的坑：`Bun.deflateSync` 產出的是**原始 deflate**（開頭 `63 60…`），
 *  而 PNG 的 IDAT 要的是 **zlib 包裝**（開頭 `78 9c…`）。
 *  用 Bun 的版本會得到一個「看起來像 PNG、其實資料流壞掉」的檔案，
 *  讀圖時才報 broken data stream。所以這裡用 node:zlib 的 deflateSync。 */
function encodeGrayPng(w: number, h: number, gray: Uint8Array): Uint8Array {
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    raw.set(gray.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

/** 8-bit RGB PNG（每列前面一個 filter byte 0） */
function encodeRgbPng(w: number, h: number, rgb: Uint8Array): Uint8Array {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolour
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

// 光柵化：把組出來的字形畫成 200×200
function kageOf(L: Library, idx: number): any {
  const kage = new (globalThis as any).Kage();
  const seen = new Set<number>();
  const stack = [idx];
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const g = L.glyphs[i]!;
    kage.kBuhin.push(keyOfIdx(L, i), toKageData(g, L));
    for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  return kage;
}

const SIZE = 200;
const tR = Date.now();
const raster = rasterize(kageOf(outLib, root), keyOfIdx(outLib, root), SIZE, 1);
console.log(`  光柵化 ${SIZE}×${SIZE} 用 ${Date.now() - tR} ms`);
const gray = new Uint8Array(SIZE * SIZE);
for (let i = 0; i < gray.length; i++) {
  gray[i] = Math.round(255 * (1 - Math.min(1, raster.cov[i]!)));
}
const pngPath = resolve(ROOT, "out/grail-extb.png");
writeFileSync(pngPath, encodeGrayPng(SIZE, SIZE, gray));
console.log(`  已寫出 ${pngPath}`);

// ------------------------------------------------ 與參考圖比對（檢驗成效）

const refPgm = resolve(ROOT, "out/ref/flat.pgm");
try {
  const pgm = readFileSync(refPgm);
  // 解析 P5 標頭（註解以 # 開頭）
  let p = 0;
  const tok = () => {
    while (p < pgm.length) {
      if (pgm[p] === 0x23) { while (p < pgm.length && pgm[p] !== 0x0a) p++; }
      else if (pgm[p]! <= 0x20) p++;
      else break;
    }
    const s = p;
    while (p < pgm.length && pgm[p]! > 0x20) p++;
    return Buffer.from(pgm.subarray(s, p)).toString("latin1");
  };
  if (tok() !== "P5") throw new Error("不是 P5 PGM");
  const w = Number(tok()), h = Number(tok());
  tok(); // maxval
  p++;   // 單一空白
  const px = pgm.subarray(p, p + w * h);
  const refCov = new Float32Array(w * h);
  for (let i = 0; i < refCov.length; i++) refCov[i] = 1 - px[i]! / 255;

  let inter = 0, uni = 0;
  for (let i = 0; i < refCov.length; i++) {
    inter += Math.min(refCov[i]!, raster.cov[i]!);
    uni += Math.max(refCov[i]!, raster.cov[i]!);
  }
  console.log(`\n  與參考圖的 IoU = ${(inter / uni).toFixed(4)}（原始、未對齊）`);

  // **容許位移的 IoU**：筆畫只有 2~3 格寬，差 1 格就會讓原始 IoU 崩掉，
  // 那個數字反映的是「對齊」不是「像不像」。所以再算一組「各自膨脹 r 格再比」。
  const dilate = (cov: Float32Array, r: number) => {
    const out = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      let m = 0;
      for (let dy = -r; dy <= r && m < 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= SIZE) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= SIZE) continue;
          const v = cov[yy * SIZE + xx]!;
          if (v > m) m = v;
        }
      }
      out[y * SIZE + x] = m;
    }
    return out;
  };
  const dilIou = (r: number) => {
    const a = dilate(refCov, r), b = dilate(raster.cov, r);
    let i = 0, u = 0;
    for (let k = 0; k < a.length; k++) { i += Math.min(a[k]!, b[k]!); u += Math.max(a[k]!, b[k]!); }
    return u > 0 ? i / u : 1;
  };
  console.log(`  容許位移的 IoU：±1 格 ${dilIou(1).toFixed(4)}　±2 格 ${dilIou(2).toFixed(4)}　±3 格 ${dilIou(3).toFixed(4)}`);
  console.log(`  （參考圖墨跡 [15,16,191,185]，本成品 [${ink.x1.toFixed(0)},${ink.y1.toFixed(0)},${ink.x2.toFixed(0)},${ink.y2.toFixed(0)}]）`);

  // 對照表：參考圖 ／ 本成品 ／ 差異（紅＝只有參考、綠＝只有成品、黑＝兩者）
  const PW = 210, pad = 10;
  const sheetW = PW * 3 + pad * 4, sheetH = 240;
  const sheet = new Uint8Array(sheetW * sheetH * 3).fill(255);
  const setPx = (x: number, y: number, rgb: [number, number, number]) => {
    const i = (y * sheetW + x) * 3;
    sheet[i] = rgb[0]; sheet[i + 1] = rgb[1]; sheet[i + 2] = rgb[2];
  };
  const putGray = (x0: number, y0: number, cov: Float32Array) => {
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const v = Math.round(255 * (1 - Math.min(1, cov[y * SIZE + x]!)));
      setPx(x0 + x, y0 + y, [v, v, v]);
    }
  };
  putGray(pad, 25, refCov);
  putGray(pad * 2 + PW, 25, raster.cov);
  // 差異圖：用「離最近墨跡的距離」上色太貴，改用 ±1 格容忍：
  //   兩者都有（含 1 格內）→ 黑；只有參考 → 紅；只有成品 → 綠
  const refD = dilate(refCov, 1), mineD = dilate(raster.cov, 1);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const k = y * SIZE + x;
    const inR = refCov[k]! > 0.5, inM = raster.cov[k]! > 0.5;
    const nearR = refD[k]! > 0.5, nearM = mineD[k]! > 0.5;
    let rgb: [number, number, number] = [255, 255, 255];
    if (inR && inM) rgb = [0, 0, 0];
    else if (inR && nearM) rgb = [130, 130, 130];
    else if (inM && nearR) rgb = [130, 130, 130];
    else if (inR) rgb = [220, 40, 40];
    else if (inM) rgb = [30, 150, 30];
    setPx(pad * 3 + PW * 2 + x, 25 + y, rgb);
  }
  for (const i of [0, 1, 2]) {
    const x0 = pad + i * (PW + pad);
    for (let y = 0; y < SIZE; y++) { setPx(x0 - 1, 25 + y, [150, 150, 150]); setPx(x0 + SIZE, 25 + y, [150, 150, 150]); }
    for (let x = 0; x < SIZE; x++) { setPx(x0 + x, 24, [150, 150, 150]); setPx(x0 + x, 25 + SIZE, [150, 150, 150]); }
  }
  const cmpPath = resolve(ROOT, "out/grail-extb-compare.png");
  writeFileSync(cmpPath, encodeRgbPng(sheetW, sheetH, sheet));
  console.log(`  已寫出 ${cmpPath}（左：參考圖　中：本成品　右：差異圖；紅＝只有參考、綠＝只有成品、灰＝1 格內）`);

  console.log(`\n  ASCII 差異圖（# 兩者都有、+ 只有我們、- 只有參考）：`);
  console.log(diffAscii({ size: SIZE, cov: raster.cov }, { size: SIZE, cov: refCov }, 0.5));
} catch (e) {
  console.log(`  （沒有 ${refPgm}，跳過與參考圖的比對：${(e as Error).message}）`);
}
