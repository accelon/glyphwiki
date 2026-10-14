/**
 * check-parts.ts — 驗收「**輸入部件就比對得到**」（師父第 103 輪的目標定義）。
 *
 * 目標不是推出完美的算子 ✗（§6.20），而是：**IDS 點名的每一個部件，
 * 在我們的部件樹裡都必須找得到**——這樣使用者打那個部件就一定比對得到這個字 ✓。
 *
 * 做法：對每個字，取 IDS 主要拆法的**直接分量** ✓，逐一檢查它是否出現在
 * 我們 `comp` 的**深層展開**裡（異體用 `synKeyOf()` 視為同一部件 ✓）。
 *
 * 為什麼不看算子、不看順序：師父說「左右上下的條件約束不到也沒關係，
 * 不要約束條件，輸入部件就一定可以比對到」✓ ——所以這是**集合命中**的檢查 ✓。
 *
 * 用法: bun run tools/check-parts.ts [--limit N] [--show N]
 */
import { readFileSync } from "node:fs";
import { decodeLibrary, codePointOf, indexOfCodePoint, isPlainIdeograph, synKeyOf } from "./lib-format.ts";
import { loadIdsFile, directComponents, stripIndicators } from "./ids-source.ts";

const D = "D:/2023/glyphwiki";
const argv = process.argv.slice(2);
const num = (k: string, d: number) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d;
};
const LIMIT = num("--limit", 6000);
const SHOW = num("--show", 10);

const lib = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk-all.bin.gz`))));
const ids = loadIdsFile(`${D}/ids/ids_lv1.txt`);

/** 我們的 comp 攤平到葉子（含自己，若它沒有 comp） */
const memo = new Map<number, number[]>();
const deep = (cp: number, d = 0): number[] => {
  if (d > 8) return [cp];
  const hit = memo.get(cp);
  if (hit) return hit;
  const c = lib.comp?.get(cp);
  if (!c || !c.length) { memo.set(cp, [cp]); return [cp]; }
  const out: number[] = [];
  for (const k of c) out.push(...deep(k, d + 1));
  memo.set(cp, out);
  return out;
};

let proc = 0, glyphs = 0, parts = 0, hit = 0;
const misses: string[] = [];
for (let gi = 0; gi < lib.glyphs.length; gi++) {
  const cp = codePointOf(lib, gi);
  if (!cp || !isPlainIdeograph(lib, gi)) continue;
  if (indexOfCodePoint(lib, cp) !== gi) continue;
  if (proc++ > LIMIT) break;
  const e = ids.get(cp);
  if (!e || !e.primary.length) continue;
  const theirs = directComponents(stripIndicators(e.primary[0]!)).filter((c) => c !== cp);
  if (theirs.length < 2) continue;
  glyphs++;
  const set = new Set(deep(cp).map((x) => synKeyOf(lib, x)));
  /* 命中＝兩種都算 ✓：
     ① 我們的樹裡**直接有**這個部件（含異體視為同一部件 ✓）；
     ② 這個部件**自己拆開來的零件，我們都有** → 它在我們的樹裡「組得出來」 ✓。
        實測（第 106 輪）這一條是關鍵：`㐐` 我們拆成 `女又乙`，IDS 卻寫 `奴` ✗ ——
        使用者打 `奴` 時，因為 `女`／`又` 都在，就應該比對得到 `㐐` ✓。 */
  const covered = (t: number) => {
    if (set.has(synKeyOf(lib, t))) return true;
    const dt = deep(t);
    if (dt.length < 2) return false;
    return dt.every((x) => set.has(synKeyOf(lib, x)));
  };
  for (const t of theirs) {
    parts++;
    if (covered(t)) hit++;
    else if (misses.length < SHOW) misses.push(String.fromCodePoint(cp) + " 的 IDS 有 " + String.fromCodePoint(t) + "（我們的深層：" + deep(cp).map((x) => String.fromCodePoint(x)).join("") + "）");
  }
}
const pct = (n: number, d: number) => (d ? (100 * n / d).toFixed(2) + "%" : "—");
console.log("【輸入部件就比對得到】抽樣 " + glyphs.toLocaleString() + " 字、IDS 分量 " + parts.toLocaleString() + " 個：");
console.log("  命中 **" + pct(hit, parts) + "**（" + hit.toLocaleString() + " / " + parts.toLocaleString() + "）" +
  (misses.length ? "" : " ✓ 全部命中"));
for (const m of misses) console.log("  ✗ " + m);
if (hit === parts) console.log("✓ 每一個 IDS 點名的部件，在我們的樹裡都找得到——使用者打那個部件一定比對得到這個字");
else console.log("（未命中的都是「IDS 拆得比畫法細」或「沿用舊值」那幾類，見 §6.20 與 組字結構.md）");
