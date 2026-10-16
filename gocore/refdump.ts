#!/usr/bin/env bun
/**
 * refdump.ts — 產生 **Go 版解碼器的差分測試參考**（golden 檔）。
 *
 * 這一支是 `gocore/lib` 差分測試的「JS 那一半」：用 `tools/lib-format.ts`
 * （**唯一的**解碼實作）把字庫解開，dump 出足以證明「Go 解出一模一樣的東西」的欄位。
 *
 * ---------------------------------------------------------------------------
 * 為什麼選這些欄位
 * ---------------------------------------------------------------------------
 *   1. **`kageHashAll`（每個字形的 `toKageData` 之 FNV-1a 32）** —— **全庫覆蓋**，
 *      等於把整個位元流逐筆驗一遍（kind／width／style／8 個座標／ref／box／stretch）。
 *      只存 hash 不存原文：原文加起來比字庫大數倍，而測試只需要「一樣」。
 *   2. **`tightAll`（每個字形的緊框）** —— **全庫覆蓋**，驗 `computeTight()`
 *      （它會遞迴走完整棵引用樹，所以同時驗到 ref 與框映射，以及 `Math.round` 的語意）。
 *   3. **`families`** —— 逐筆驗家族表（cp／start／count／pref／plain）。
 *   4. **`comp`／`syn`／`phil`** —— 逐筆驗三個尾端區段。
 *      ⚠ `comp` 的**分量順序**也要一樣（v4 之後那是有意義的：誰左誰右）。
 *   5. **`lookup`** —— 抽樣驗查詢層（`indexOfCodePoint`／`familyMembers`／
 *      `componentKids`／`isPlainIdeograph`／`keyOfIdx`）。
 *      抽樣刻意包含**每個家族的 `pref` 成員**——那正是 `indexOfCodePoint` 會回傳的
 *      那一個，也是最容易寫錯的地方。
 *
 * ---------------------------------------------------------------------------
 * 沙箱注意（DSH）：為什麼要複製 `lib-format.ts`
 * ---------------------------------------------------------------------------
 * DSH 的檔案沙箱對**子行程**封鎖 `tools/`、`out/`、`db/`、`kage-engine/` 等目錄的**寫入**。
 * 而 **bun 的模組載入器是用 `r+`（讀寫）開啟檔案的** —— 所以 `import "../tools/lib-format.ts"`
 * 在沙箱下會拿到 `EPERM`，但你用 `fs.readFileSync` 讀同一支檔案卻完全正常。
 *
 * 這個模組是自足的（**沒有任何 import**，見它的檔頭），所以複製一份到可寫的
 * `gocore/_gen/` 再載入即可。程式碼**先試直接載入**（正常環境不會留任何東西），
 * 真的被擋才走複製那條路，而且會把來源的 sha256 印出來以示「這是同一份」。
 *
 * ---------------------------------------------------------------------------
 * 用法
 * ---------------------------------------------------------------------------
 *   bun run gocore/refdump.ts
 *   bun run gocore/refdump.ts --lib out/lib-cjk-all.bin --out gocore/testdata/ref.json.gz
 *
 * 輸出到 `gocore/testdata/`（**不入版控**）——它是從 `out/lib-cjk-all.bin` 衍生的，
 * 字庫一重建就該重跑。順帶把字庫複本一起寫進去，讓 Go 的測試**不需要**再碰 `out/`
 * （也順手避開 `.bin` 與 `.gz` 不同步那個歷史坑）。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dir, "..");

function arg(name: string, def: string): string {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

const LIB_PATH = resolve(ROOT, arg("lib", "out/lib-cjk-all.bin"));
const TESTDATA = resolve(ROOT, arg("out", "gocore/testdata/ref.json.gz"));
const GEN_DIR = resolve(ROOT, "gocore/_gen");

/** 載入唯一的解碼實作；被沙箱擋住時改用暫存複本（見檔頭）。 */
async function loadLibFormat(): Promise<typeof import("../tools/lib-format.ts")> {
  const src = resolve(ROOT, "tools/lib-format.ts");
  try {
    return await import(pathToFileURL(src).href);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    const gen = resolve(GEN_DIR, "lib-format.ts");
    mkdirSync(dirname(gen), { recursive: true });
    const srcBytes = readFileSync(src);
    writeFileSync(gen, srcBytes);
    const sha = createHash("sha256").update(srcBytes).digest("hex").slice(0, 16);
    console.error(`[refdump] 直接載入 tools/lib-format.ts 失敗：${msg}`);
    console.error(`[refdump] 已複製到 gocore/_gen/lib-format.ts（sha256:${sha}）——同一份位元組，只是換一個可寫的路徑`);
    return await import(pathToFileURL(gen).href);
  }
}

const LF = await loadLibFormat();

/** FNV-1a 32（**與 Go 端手寫的那一份必須逐位元相同**；刻意不用任何函式庫） */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  const bytes = new TextEncoder().encode(s);
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const raw = readFileSync(LIB_PATH);
const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
const version = bytes[0] === 0x47 && bytes[1] === 0x4c ? bytes[2]! : 1;

const t0 = performance.now();
const lib = LF.decodeLibrary(bytes);
const ms = performance.now() - t0;
const n = lib.glyphs.length;

// ---- 1. 每個字形的 KAGE 資料 hash（全庫）----
const kageHashAll = new Array<number>(n);
for (let i = 0; i < n; i++) kageHashAll[i] = fnv1a32(LF.toKageData(lib.glyphs[i]!, lib));

// ---- 2. 每個字形的緊框（全庫，攤平成 4n）----
const tightAll = new Array<number>(n * 4);
for (let i = 0; i < n; i++) {
  const t = lib.glyphs[i]!.tight ?? [0, 0, 0, 0];
  tightAll[i * 4] = t[0]!; tightAll[i * 4 + 1] = t[1]!;
  tightAll[i * 4 + 2] = t[2]!; tightAll[i * 4 + 3] = t[3]!;
}

// ---- 3. 家族表（攤平成 5 筆）----
const families = new Array<number>(lib.families.length * 5);
lib.families.forEach((f, i) => {
  families[i * 5] = f.cp; families[i * 5 + 1] = f.start; families[i * 5 + 2] = f.count;
  families[i * 5 + 3] = f.pref; families[i * 5 + 4] = f.plain;
});

// ---- 4. 三個尾端區段（攤平：key, 長度, 值…）----
const flat = (m: Map<number, number[]> | undefined): number[] => {
  const out: number[] = [];
  if (m) for (const [k, arr] of m) out.push(k, arr.length, ...arr);
  return out;
};
const comp = flat(lib.comp);
const syn = flat(lib.syn);
const phil = flat(lib.phil);

// ---- 5. 查詢抽樣 ----
const giSample = new Set<number>();
for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 4000))) giSample.add(i);
lib.families.forEach((f, fi) => {
  if (fi % Math.max(1, Math.floor(lib.families.length / 2000)) !== 0) return;
  giSample.add(f.start);
  giSample.add(f.start + f.count - 1);
  giSample.add(f.start + Math.min(f.pref, f.count - 1)); // indexOfCodePoint 真正會回傳的那一個
});
const sortedGi = [...giSample].sort((a, b) => a - b);

const indexOfCp: number[] = [];
const plain: number[] = [];
const keys: string[] = [];
for (const gi of sortedGi) {
  const cp = LF.codePointOf(lib, gi);
  indexOfCp.push(cp, LF.indexOfCodePoint(lib, cp) ?? -1);
  plain.push(gi, LF.isPlainIdeograph(lib, gi) ? 1 : 0);
  keys.push(LF.keyOfIdx(lib, gi));
}

const familyMembers: number[] = [];
const famStep = Math.max(1, Math.floor(lib.families.length / 300));
lib.families.forEach((f, fi) => {
  if (fi % famStep !== 0) return;
  const m = LF.familyMembers(lib, f.cp);
  familyMembers.push(f.cp, m.length, ...m);
});

const componentKids: number[] = [];
for (const gi of sortedGi) {
  const k = LF.componentKids(lib, gi);
  componentKids.push(gi, k.length, ...k);
}

// ---- 6. 點名抽查 ----
//
// 差分測試保證「Go 與 JS 一致」，但**不保證「與事實一致」**——萬一兩邊一起錯呢？
// 這一組是文件上真的拿來當案例的字（`pinxing.md`／`glyph-by-ids.md`／`format.md`），
// 把「人看得懂的中間結果」也 dump 出來，讓 Go 端可以斷言已知事實
// （例如「盟 ＝ 日 月 皿」），而不只是「兩邊一樣」。
const SPOT = [
  "寶", "邏", "盟", "幸", "報", "街", "峰", "䴺", "麥", "𩀨", "進", "合",
  "一", "土", "士", "干", "木", "林", "杏",
];
const spot = SPOT.map((ch) => {
  const cp = ch.codePointAt(0)!;
  const gi = LF.indexOfCodePoint(lib, cp) ?? -1;
  if (gi < 0) return { ch, cp, idx: -1, tight: [] as number[], kageHash: 0, kids: [] as number[] };
  const g = lib.glyphs[gi]!;
  return {
    ch,
    cp,
    idx: gi,
    tight: (g.tight ?? [0, 0, 0, 0]) as number[],
    kageHash: fnv1a32(LF.toKageData(g, lib)),
    // 部件的**碼位**（0 ＝ 純部件、沒有碼位）；這樣不必靠名字表就能人眼核對
    kids: LF.componentKids(lib, gi).map((k) => LF.codePointOf(lib, k)),
  };
});

/** 數一個「攤平」陣列裡有幾筆（格式：key, 長度, 值…） */
const flatCount = (a: number[]): number => {
  let i = 0, c = 0;
  while (i < a.length) { i += 2 + a[i + 1]!; c++; }
  return c;
};

const payload = {
  meta: {
    libFile: LIB_PATH.replace(/\\/g, "/").replace(ROOT.replace(/\\/g, "/") + "/", ""),
    libBytes: bytes.length,
    libSha256: createHash("sha256").update(raw).digest("hex"),
    version,
    decodedMs: Math.round(ms),
    // 格式細節：點數的判讀表（Go 端 PtCountOf 要一致）
    ptCounts: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 99, 103].map((k) => LF.ptCountOf(k)),
  },
  counts: {
    glyphs: n,
    families: lib.families.length,
    orphanStart: lib.orphanStart,
    comp: lib.comp?.size ?? 0,
    syn: lib.syn?.size ?? 0,
    phil: lib.phil?.size ?? 0,
  },
  kageHashAll,
  tightAll,
  families,
  comp,
  syn,
  phil,
  lookup: { gis: sortedGi, indexOfCp, plain, keys, familyMembers, componentKids },
  spot,
};

const json = JSON.stringify(payload);
const gz = gzipSync(Buffer.from(json, "utf8"));
mkdirSync(dirname(TESTDATA), { recursive: true });
writeFileSync(TESTDATA, gz);
// 字庫複本：讓 Go 的測試**不需要**碰 out/（也讓兩者保證同步）
writeFileSync(resolve(dirname(TESTDATA), "lib-cjk-all.bin"), raw);

console.log("=== gocore/refdump.ts ===");
console.log(`字庫      ${payload.meta.libFile}  ${bytes.length} bytes  v${version}`);
console.log(`解碼      ${ms.toFixed(0)} ms`);
console.log(`字形      ${n}`);
console.log(`家族      ${lib.families.length}（orphanStart=${lib.orphanStart}）`);
console.log(`IDS 分量  ${payload.counts.comp}　syn ${payload.counts.syn}　phil ${payload.counts.phil}`);
console.log(`抽樣      查詢 ${indexOfCp.length / 2} 筆、家族 ${flatCount(familyMembers)} 筆、部件圖 ${flatCount(componentKids)} 筆`);
console.log(`輸出      ${TESTDATA}  ${(gz.length / 1024 / 1024).toFixed(2)} MB（未壓 ${(json.length / 1024 / 1024).toFixed(2)} MB）`);
console.log("點名抽查：");
for (const s of spot) {
  const kd = s.kids.map((k) => (k ? "U+" + k.toString(16).toUpperCase() : "（純部件）")).join(" ");
  console.log(`  ${s.ch}  U+${s.cp.toString(16).toUpperCase().padStart(4, "0")}  idx=${s.idx}  tight=[${s.tight.join(",")}]  部件: ${kd}`);
}
