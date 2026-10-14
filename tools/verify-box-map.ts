#!/usr/bin/env bun
/**
 * verify-box-map.ts — 量測 KAGE 引用框（元素 99）真正的映射規則。
 *
 * 為什麼要量：`compose-fit.ts` 的檔頭寫「框會把子字形的**緊框等比縮放置中**到該框」，
 * 但 `kage-engine/kage.js` 的 `getEachStrokesOfBuhin` 實際做的是：
 *
 *     x' = x1 + x * (x2 - x1) / 200
 *     y' = y1 + y * (y2 - y1) / 200
 *
 * 也就是**把子字形整個 200×200 畫布仿射映射到框**，而且 x、y **各自縮放**（可非等比）。
 * 兩者對「緊框剛好等於 [0,0,200,200]」的字一樣，對其他字就差很多。
 * 這一條決定了組字時「放不放得下」的判斷，所以必須用引擎實測確認。
 *
 * 用法: bun run tools/verify-box-map.ts [--lib out/lib-cjk-all.bin.gz]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { displayName, indexOfChar } from "./lib-format.ts";
import type { Library } from "./lib-format.ts";
import { loadLibrary, DEFAULT_LIB } from "./lib-load.ts";
import { ensureEngine, inkIn, inkOfRefInParent, svgOf } from "./compose-fit.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = Bun.argv.slice(2);
const li = argv.indexOf("--lib");
const { lib } = loadLibrary(resolve(ROOT, li >= 0 && argv[li + 1] ? argv[li + 1]! : DEFAULT_LIB));

ensureEngine();
const idxOf = (c: string) => indexOfChar(lib, c);
const f = (v: number) => v.toFixed(1).padStart(7, " ");

for (const ch of ["邏", "集", "難", "寶", "𩀨", "䞃", "招", "從", "隹"]) {
  const pi = idxOf(ch);
  if (pi === undefined) { console.log(`${ch}：不在庫`); continue; }
  const parent = lib.glyphs[pi]!;
  console.log(`\n===== ${ch} ${displayName(lib, pi)}  緊框[${parent.tight!.join(",")}] =====`);
  parent.strokes.forEach((s, si) => {
    if (s.kind !== 99 || s.ref === null) return;
    const b = s.box!;
    const childInk = inkIn(lib, s.ref);                    // 子字形自己的墨跡（子座標系）
    const real = inkOfRefInParent(lib, pi, si);            // 引擎實測：該引用在父座標系的墨跡
    // 依 kage.js 的公式預測
    const px = (cx: number) => b[0]! + (cx * (b[2]! - b[0]!)) / 200;
    const py = (cy: number) => b[1]! + (cy * (b[3]! - b[1]!)) / 200;
    const pred = [px(childInk.x1), py(childInk.y1), px(childInk.x2), py(childInk.y2)];
    const err = Math.max(
      Math.abs(pred[0]! - real.x1), Math.abs(pred[1]! - real.y1),
      Math.abs(pred[2]! - real.x2), Math.abs(pred[3]! - real.y2),
    );
    console.log(`  → ${displayName(lib, s.ref).padEnd(16)} 框[${b.join(",")}]`);
    console.log(`      子自身墨跡 [${[childInk.x1, childInk.y1, childInk.x2, childInk.y2].map(f).join(",")}]`);
    console.log(`      引擎實測   [${[real.x1, real.y1, real.x2, real.y2].map(f).join(",")}]` +
      `　${(real.x2 - real.x1).toFixed(0)}×${(real.y2 - real.y1).toFixed(0)}`);
    console.log(`      公式預測   [${pred.map(f).join(",")}]　最大誤差 ${err.toFixed(2)}` +
      `${err < 0.6 ? " ✓ 公式正確" : " ✗ 公式不符"}`);
  });
}

// 順手把 邏 與 𩀨 的原字 SVG 寫出來，人工確認參考
for (const ch of ["邏", "𩀨", "䞃"]) {
  const i = idxOf(ch);
  if (i !== undefined) Bun.write(resolve(ROOT, `out/ref-${ch}.svg`), svgOf(lib, i));
}
console.log(`\n已寫出 out/ref-邏.svg、out/ref-𩀨.svg、out/ref-䞃.svg`);
