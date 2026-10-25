#!/usr/bin/env bun
/**
 * build-tours.ts — 操作導覽的**劇本編譯 ＋ 陳舊檢查**。
 *
 * 用法（在 repo 根目錄）：
 *   bun run tools/tour/build-tours.ts            # 編譯，印出每一份劇本的場景／步數／位元組數（不寫檔）
 *   bun run tools/tour/build-tours.ts --check    # 比對「產出頁裡的內嵌資料」是不是現在的劇本
 *
 * 為什麼需要 `--check`（這一段是這個模組存在的主要理由）：
 *   劇本（`.tour`）與頁面（`out/pinxing.html`）之間隔著一次編譯。改了劇本卻忘了重建，
 *   頁面還是舊的，而**所有測試都可能是綠的** ✗——這正是「改了程式忘了重建」那個坑的兄弟 ✓
 *   （見 `progress/技術總結-給AI.md` §8.4）。所以 `verify` 把它排成一步 ✓。
 *
 * 為什麼**沒有** `tour-data.ts`：
 *   本專案的頁面是**單一檔案**，資料一定要內嵌；再多一份中間檔只會多一個走鐘的地方 ✗。
 *   所以編譯結果由 `build-pinxing.ts` 直接寫進頁面，`--check` 再從**產出物**讀回來比對 ✓
 *   （比對產出物＝比對客人真正拿到的東西 ✓）。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import config from "./tour.config.ts";
import { compileTours } from "./compiler.ts";
import { readTourData, TOUR_BLOBS_MARK, TOUR_INDEX_MARK } from "./embed.ts";

const ROOT = resolve(import.meta.dir, "../..");
const CHECK = process.argv.includes("--check");
const PAGES = ["out/pinxing.html", "pinxing-app/frontend/index.html"];

const res = compileTours(config);
if (res.errors.length) {
  console.error("✗ 劇本有錯（建置器也會擋，這裡先指出來）：");
  for (const e of res.errors) console.error("  " + e);
  process.exit(1);
}

const wantIndex = JSON.stringify(res.index);
const wantBlobs = JSON.stringify(res.blobs);

console.log(`✓ 編譯 ${res.tours.length} 份劇本（${res.index.reduce((a, t) => a + t.scenes, 0)} 個場景、` +
  `${res.index.reduce((a, t) => a + t.steps, 0)} 步、共 ${(wantBlobs.length / 1024).toFixed(1)} KB base64）`);
for (const t of res.index) {
  console.log(`  · ${t.id.padEnd(8)} ${t.title}　${t.scenes} 場景 / ${t.steps} 步 / 巨集 ${t.bytes} bytes`);
}
if (!CHECK) {
  console.log("\n（這一步不寫檔：資料由 `bun run tools/build-pinxing.ts` 直接內嵌進產出頁 ✓）");
  process.exit(0);
}

/* ---------------------------------------------------------------- --check */
let fail = 0;
let sawPage = false;
for (const rel of PAGES) {
  const page = resolve(ROOT, rel);
  if (!existsSync(page)) {
    console.log(`  － ${rel} 不存在（跳過；這是正常的：Wails 版可以沒建）`);
    continue;
  }
  sawPage = true;
  const html = readFileSync(page, "utf8");
  const got = readTourData(html);
  if (!got) {
    console.error(`  ✗ ${rel} 裡找不到 ${TOUR_INDEX_MARK}／${TOUR_BLOBS_MARK}——頁面不是用這支建置器產生的？`);
    fail++;
    continue;
  }
  if (got.index !== wantIndex || got.blobs !== wantBlobs) {
    const why = got.index !== wantIndex ? "劇本清單（標題／場景數／步數）" : "巨集內容";
    console.error(`  ✗ ${rel} 的內嵌導覽資料**不是現在的劇本**（${why}不同）`);
    console.error(`     → 先跑：bun run tools/build-pinxing.ts` +
      (rel.indexOf("pinxing-app") === 0 ? " --hosted" : ""));
    fail++;
    continue;
  }
  console.log(`  ✓ ${rel} 的內嵌導覽資料與現在的劇本一致（${res.index.length} 份）`);
}
if (!sawPage) {
  console.error("✗ 找不到任何產出頁可比對——先跑 bun run tools/build-pinxing.ts");
  fail++;
}

if (fail) {
  console.error(`\n✗ ${fail} 項沒過`);
  process.exit(1);
}
console.log("\n✓ 導覽資料沒有過期");
