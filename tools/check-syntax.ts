#!/usr/bin/env bun
/**
 * check-syntax.ts — **先做一次全工具的語法檢查**（`verify` 的第一步 ✓）。
 *
 * 為什麼要（第 111～112 輪的實戰教訓）：
 *   我在 builder 的樣板字串**註解**裡寫了反引號 ✗ → template literal 當場結束 →
 *   得到 `Expected ";" but found "利刂刀"`。這種錯 Bun 一定會抓到 ✓，
 *   但**是在跑完前面幾分鐘的步驟之後**才抓到 ✗（浪費一輪 ✓）。
 *   這一支把「載入所有工具檔」拉到最前面，**一秒內**就把語法錯指出來 ✓。
 *
 * 做兩件事：
 *   ① `tools/**\/*.ts` 用 Bun 的 transpiler 過一次（TypeScript 語法 ✓）
 *   ② `tools/**\/*.js`（頁面端程式碼）用 `new Function()` 過一次（純 JS ✓）
 * ⚠ 這是**語法**檢查，不是型別檢查 ✗（這個專案沒有型別檢查的傳統 ✓）；
 *   標籤不平衡、DOM 結構那種問題它抓不到 ✗（見 `progress/技術總結-給AI.md` §8 第 11c 條 ✓）。
 *
 * 用法: bun run tools/check-syntax.ts   （有語法錯 → exit 1，並印出檔名與行號）
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIRS = ["tools", "kage-engine"].map((d) => resolve(ROOT, d));
const transpiler = new Bun.Transpiler({ loader: "ts" });

interface Bad { file: string; msg: string }
const bad: Bad[] = [];
let nTs = 0, nJs = 0;

function walk(dir: string, out: string[] = []): string[] {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const p = resolve(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") || name.endsWith(".js")) out.push(p);
  }
  return out;
}

for (const dir of DIRS) {
  for (const p of walk(dir)) {
    const src = readFileSync(p, "utf8");
    const rel = p.slice(ROOT.length + 1).replace(/\\/g, "/");
    if (p.endsWith(".ts")) {
      nTs++;
      try { transpiler.transformSync(src); }
      catch (e) { bad.push({ file: rel, msg: (e as Error).message }); }
    } else {
      nJs++;
      try { new Function(src); }
      catch (e) {
        /* 頁面端的 .js 是純 JS ✓；`import`／`export` 會讓 Function 失敗，
           所以只在「錯誤不像模組語法」時才當違規 ✓（避免誤報 ✗）。 */
        const m = (e as Error).message;
        if (!/import|export|await is only valid/.test(m)) bad.push({ file: rel, msg: m });
      }
    }
  }
}

if (bad.length) {
  console.error(`✗ 語法檢查失敗（${bad.length} 個檔案）：`);
  for (const b of bad) console.error(`  ${b.file}：${b.msg.split("\n")[0]}`);
  console.error(`\n最常見的原因：**在 template literal 的註解裡寫了反引號** ✗` +
    `（builder 的 HTML、驗收的探針都是 template literal）——註解要引字請用「」✓。`);
  /* ★ 2026-10-16 補第二個常見原因：這一支的錯誤訊息**沒有行號**時，先看檔頭有沒有 BOM ✗——
     `position.lineText` 會是 `ï»¿#!/usr/bin/env bun` ✓。
     Bun **執行得動**有 BOM 的檔案 ✓，但 transpiler 直接 `Syntax Error` ✗（兩邊不一致，
     很容易誤判成「程式碼有錯」✗）。BOM 是怎麼來的：**PowerShell 的
     `Set-Content -Encoding UTF8` 會加 BOM** ✓（批次改檔要改用
     `[IO.File]::WriteAllText($p, $t, (New-Object Text.UTF8Encoding($false)))` ✓）。
     實際踩過：第 139 輪用 Set-Content 改 builder 的註解 → 兩個 builder 都被加了 BOM ✗。 */
  console.error(`還有一個原因（訊息**沒有行號**時先查這個）：檔頭被加了 **UTF-8 BOM** ✗——\n` +
    `  Bun 執行得動、transpiler 直接 Syntax Error ✓（PowerShell 的 Set-Content -Encoding UTF8 會加 ✓）。`);
  process.exit(1);
}
console.log(`✓ 語法檢查通過（${nTs} 個 .ts、${nJs} 個 .js）`);
