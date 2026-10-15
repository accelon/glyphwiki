#!/usr/bin/env bun
/**
 * embed-common.ts — 產生「離線單頁」時，各頁**共用**的內嵌內容。
 *
 * `glyph-browser.html` 與 `pinxing.html` 要同一組 kage-engine 與同一批 tools 模組。
 * 這一支就是那份「同一組」——**不要兩份各自複製**：這個專案已經吃過
 * 「同一個東西兩份來源各說各話」的虧（見 `format.md` 的 IDS 章節），
 * 而且兩份 bundling 規則只要有一邊漏改，就會出現「A 頁可以、B 頁不行」的鬼故事。
 *
 * 內嵌時有兩個必須做對的地方（都在這裡處理掉）：
 *
 *   1. **各模組的 `export` 要拿掉、全部擠進同一個作用域。** 兩個檔案若有同名
 *      的 `const`／`let`／`class`，就是 SyntaxError，而且是**整個 script 都不執行**
 *      ——頁面完全空白、連錯誤訊息都沒有。所以合併後一定要先做一次整段語法檢查。
 *   2. **模組尾端的 `if (import.meta.main)` CLI 區塊要切掉**，`import` 也要拿掉；
 *      `ensureEngine()` 改成 no-op（引擎已經內嵌在頁面上方了）。
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
export const LIB_GZ = resolve(ROOT, "out/lib-cjk-all.bin.gz");
const ENGINE_DIR = resolve(ROOT, "kage-engine");

/** kage-engine 的載入順序（依上游 sample.js） */
export const ENGINE_FILES = [
  "2d.js", "buhin.js", "curve.js", "kage.js", "kagecd.js",
  "kagedf.js", "polygon.js", "polygons.js",
];

/**
 * 內嵌的 tools 模組。**順序有意義**：後面可以呼叫前面，反之不行（同一作用域）。
 *
 *   lib-format      解碼／Unicode API
 *   lib-measure     墨跡量測
 *   box-dictionary  框字典
 *   compose-fit     引擎封裝、墨跡、讓位、normalizeSvg
 *   free-compose    引用樹（refSlotsOf）、拼形序列、位置搜尋
 *   component-boxes 部件框（componentBoxes／inkBoundsOfPolys）——兩頁都要
 *   stroke-overlap  跨部件距離（編輯器與 pinxing 用）
 *   ids-glyph       **從 IDS 產生字形**（`glyph-by-ids.md` 的主模塊 ✓）——
 *                   框按算子等比分配 ✓、巢狀自動正確 ✓、**保證框不重疊** ✓
 *                   （＝筆劃不交錯 ✓）。放在 `free-compose` 前面沒關係 ✓（它是獨立的 ✓）。
 */
export const MODULES = [
  "tools/lib-format.ts",
  "tools/lib-measure.ts",
  "tools/box-dictionary.ts",
  "tools/compose-fit.ts",
  "tools/free-compose.ts",
  "tools/ids-glyph.ts",
  "tools/component-boxes.ts",
  "tools/stroke-overlap.ts",
  /* 點陣（「墨有沒有搞成一塊」的判準要用 ✓）＋ 判準本身
     ——建議基字要**先驗換完能不能看** ✗（第 112 輪師父的警告 ✓） */
  "tools/raster.ts",
  "tools/ink-conflict.ts",
];

export const engineSrc: string = ENGINE_FILES
  .map((f) => readFileSync(resolve(ENGINE_DIR, f), "utf8"))
  .join("\n");

const transpiler = new Bun.Transpiler({ loader: "ts" });
const stripExports = (s: string) => s.replace(/\bexport\s+/g, "");
/** 各模組尾端的 `if (import.meta.main) { … }` 是 CLI 專用，瀏覽器不能有 import.meta */
const stripCli = (s: string) => {
  const i = s.indexOf("if (import.meta.main)");
  return i >= 0 ? s.slice(0, i) : s;
};

export const bundleSrc: string = MODULES
  .map((rel) => stripCli(stripExports(transpiler.transformSync(readFileSync(resolve(ROOT, rel), "utf8")))))
  .map((s) => s
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/function ensureEngine\([^)]*\)\s*\{[\s\S]*?\n\}/, "function ensureEngine() {}"))
  .join("\n");

/** 內嵌前先檢查「引擎 ＋ 模組」合併後是不是合法 script（見檔頭第 1 點） */
try {
  new Function(engineSrc + "\n" + bundleSrc + "\n;return 1;");
} catch (e) {
  console.error("合併後的 script 語法錯誤（內嵌會讓整頁空白）：" + (e as Error).message);
  process.exit(1);
}

/** 要塞進頁面 `<script>` 的內容：引擎 ＋ 模組 */
export function commonScript(): string {
  return `/* ============================ kage-engine（內嵌） ============================ */\n` +
    engineSrc +
    `\n\n/* ============ 解碼 + 量測 + 組字 + 引用樹（內嵌 tools/*.ts 原文） ============ */\n` +
    bundleSrc + "\n";
}

/**
 * 共用的**頁面端**程式碼（`tools/glyph-common-page.js`）。
 * 放在引擎與模組之後、各頁自己的程式碼之前。純 .js，不經 transpiler。
 */
export const commonPageJs: string = readFileSync(resolve(ROOT, "tools/glyph-common-page.js"), "utf8");

/** 字形庫的 base64（各頁都內嵌同一份） */
export const libB64: string = readFileSync(LIB_GZ).toString("base64");
/**
 * **部件形式群**的壓縮表（`out/form-groups.json`，由 `tools/build-form-groups.ts` 產生 ✓）。
 * 頁面要用它回答「`刂` 與 `刀` 是不是同一個部件的形式」✓（第 111 輪的「建議更好的基字」）。
 * ⚠ 沒有這個檔就先拒絕建頁面——**不要**讓頁面默默少一個功能 ✗。
 */
export const formGroupsJson: string = (() => {
  const p = resolve(ROOT, "out/form-groups.json");
  if (!existsSync(p)) {
    console.error("找不到 out/form-groups.json（部件形式群）——先跑：bun run tools/build-form-groups.ts");
    process.exit(1);
  }
  return readFileSync(p, "utf8");
})();

/**
 * 產出後、寫檔前，檢查整頁的 `<script>` 是不是合法。
 *
 * 這一關擋的是**頁面自己**的程式碼（上面那次檢查只涵蓋引擎與模組）。
 * 實際踩過：`"...class=\"minis\">"` 寫在樣板字串裡，`\"` 被吃掉之後輸出變成
 * `"...class="minis">"`，整頁 SyntaxError 而空白——那次是等到驗收腳本才發現。
 */
export function assertPageScript(html: string): void {
  const sm = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!sm) {
    console.error("產出的頁面裡找不到 <script> 區塊");
    process.exit(1);
  }
  try {
    new Function(sm[1]!);
  } catch (e) {
    console.error("產出頁面的 script 語法錯誤（開頁會整頁空白）：" + (e as Error).message);
    process.exit(1);
  }
}
void dirname;
