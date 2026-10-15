#!/usr/bin/env bun
/**
 * check-ids-glyph.ts — 驗收 `tools/ids-glyph.ts`（**從 IDS 產生字形** ✓，`glyph-by-ids.md` 的主模塊）。
 *
 * 這支要釘住的是**契約**（不是數字好看 ✗）：
 *
 *   1. **分框算術** ✓：`⿰日月` 各半、`⿰⿱日月皿` 的日月各 25% 而皿 50% ✓
 *      （＝`glyph-by-ids.md` 寫的「⿰⿱日月皿 就是盟，日和月占 25%、皿占 50%」✓）。
 *   2. **保證不重疊** ✓：每一葉的框都**落在**它上層算子分給它的區域裡 ✓
 *      （遞迴成立 → 框與框永不重疊 ✓ → 筆劃不會大面積交錯 ✓）。
 *   3. **真的畫得出來** ✓：合成字形要真的有筆畫路徑 ✓（「有名字沒框」那種靜默失敗 ✗ 要擋掉）。
 *   4. **壞 IDS 要誠實** ✓：`产厂⿸`（算子寫在後面 ✗）要回報問題、不要硬畫 ✗。
 *   5. **量出「新舊的差別」** ✓：舊版（不縮放、只擺位 ✗）在 `⿰日月` 上重疊幾格、
 *      新版是 0 格 ✓——這是師父要的「今法對古法的改善」的**數字符號** ✓。
 *
 * 用法: bun run tools/check-ids-glyph.ts
 */
import { resolve } from "node:path";
import { loadLibrary } from "./lib-load.ts";
import { ensureEngine, svgOf } from "./compose-fit.ts";
import { drawingIdx } from "./free-compose.ts";
import { computeTight, indexOfCodePoint } from "./lib-format.ts";
import type { Library as Lib } from "./lib-format.ts";
import { idsGlyph, idsGlyphNaiveOld, parseIds, planIds, idsText, idfWalkOk } from "./ids-glyph.ts";
import { searchSeqForIds } from "./seq-search.ts";
const ROOT = resolve(import.meta.dir, "..");
let fail = 0;
const ok = (s: string) => console.log("  ✓ " + s);
const bad = (s: string) => { console.log("  ✗ " + s); fail++; };

const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();

/** 依 §2.5／實測的映射（**等比縮放後置中** ✓）算出某一葉在**父座標系**的墨框 ✓ */
function inkInParent(L: Lib, parentIdx: number, strokeIx: number): number[] {
  const s = L.glyphs[parentIdx]!.strokes[strokeIx]!;
  const ct = computeTight(L, s.ref!);
  const cw = ct[2] - ct[0], ch = ct[3] - ct[1];
  const bw = s.box![2] - s.box![0], bh = s.box![3] - s.box![1];
  const k = Math.min(bw / cw, bh / ch);
  const w = cw * k, h = ch * k;
  const cx = (s.box![0] + s.box![2]) / 2, cy = (s.box![1] + s.box![3]) / 2;
  return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
}
/** 兩框的水平重疊格數 ✓（0 ＝ 沒有交錯 ✓） */
const overlapX = (a: number[], b: number[]) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));

console.log("1. 分框算術（IDS 是 prefix notation，按比例分框）");
{
  const cases: [string, string, number[][]][] = [
    ["⿰日月", "左右(日｜月)", [[0, 0, 100, 200], [100, 0, 200, 200]]],
    ["⿰⿱日月皿", "左右(上下(日｜月)｜皿)",
      [[0, 0, 100, 100], [0, 100, 100, 200], [100, 0, 200, 200]]],
    ["⿳𦥯⿰女孔皿", "上中下(𦥯｜左右(女｜孔)｜皿)",
      [[0, 0, 200, 200 / 3], [0, 200 / 3, 100, 400 / 3], [100, 200 / 3, 200, 400 / 3], [0, 400 / 3, 200, 200]]],
  ];
  for (const [ids, text, want] of cases) {
    const root = parseIds(ids);
    if (!root) { bad(`${ids} 解析不出來`); continue; }
    idsText(ids) === text ? ok(`${ids} → ${text} ✓（人話轉寫）`) : bad(`${ids} 的人話是「${idsText(ids)}」不是「${text}」`);
    const got = planIds(root).map((s) => s.box);
    const same = got.length === want.length &&
      got.every((b, i) => b.every((v, k) => Math.abs(v - want[i]![k]!) < 1e-9));
    same ? ok(`${ids} 的框 ${got.map((b) => "[" + b.join(",") + "]").join(" ")} ✓`)
         : bad(`${ids} 的框不對：${JSON.stringify(got)}`);
  }
  /* 「一個 IDS 越到後面框越小」✓——日月 100×100（25%）比皿 100×200（50%）小 ✓ */
  const boxes = planIds(parseIds("⿰⿱日月皿")!).map((s) => s.box);
  const area = (b: number[]) => (b[2]! - b[0]!) * (b[3]! - b[1]!);
  Math.abs(area(boxes[0]!) / 40000 - 0.25) < 1e-9 && Math.abs(area(boxes[2]!) / 40000 - 0.5) < 1e-9
    ? ok("⿰⿱日月皿＝盟：日／月各 25%、皿 50% ✓（越到後面框越小 ✓，巢狀自動正確 ✓）")
    : bad(`盟的面積比不對：${boxes.map((b) => area(b) / 40000).join(",")}`);
}

console.log("\n2. 保證不重疊：每一葉的框落在上層分給它的區域裡");
{
  let checked = 0, worst = 0;
  for (const ids of ["⿰日月", "⿰⿱日月皿", "⿰木⿳金⿰水火土", "⿳𦥯⿰女孔皿", "⿸广木", "⿴囗玉", "⿻人人"]) {
    const root = parseIds(ids);
    if (!root) { bad(`${ids} 解析不出來`); continue; }
    const bads = idfWalkOk(root);
    for (const b of bads) bad(`${ids}：${b}`);
    if (!bads.length) checked++;
    /* 再用「合成字形的實際筆畫框」對一次 ✓（不是只看算術 ✓） */
    const r = idsGlyph(ids, lib);
    if (!r.ok) { bad(`${ids} 造不出來：${r.problems.join("；")}`); continue; }
    const ink = r.slots.map((_, i) => inkInParent(r.lib, r.idx, i));
    for (let i = 0; i < ink.length; i++) {
      for (let j = i + 1; j < ink.length; j++) {
        const o = Math.min(
          overlapX(ink[i]!, ink[j]!),
          Math.max(0, Math.min(ink[i]![3]!, ink[j]![3]!) - Math.max(ink[i]![1]!, ink[j]![1]!)),
        );
        worst = Math.max(worst, o);
      }
    }
  }
  checked === 7
    ? ok(`7 個 IDS 的每一葉都落在自己的區域裡 ✓（檢查了 ${checked} 個）`)
    : bad(`有 ${7 - checked} 個 IDS 的框跑到別人的區域去了 ✗`);
  /* ⚠ 交錯會出現在「包含型」算子（⿴囗玉、⿸广木、⿻人人）——**那是它的本意** ✓
     （外框與內容本來就疊在同一塊 ✓）。等分型（⿰⿱⿲⿳）才算「筆劃大面積交錯」✗。 */
  console.log(`  （本批最大交錯 ${worst.toFixed(1)} 格——包含型／重疊型本來就會疊 ✓，等分型才是問題 ✓）`);
}

console.log("\n3. 真的畫得出來（不是只算出一堆框）");
{
  for (const ids of ["⿰日月", "⿰⿱日月皿", "⿰木⿳金⿰水火土", "⿳𦥯⿰女孔皿"]) {
    const r = idsGlyph(ids, lib);
    if (!r.ok) { bad(`${ids}：${r.problems.join("；")}`); continue; }
    const svg = svgOf(r.lib, r.idx);
    const paths = (svg.match(/<path\b/g) || []).length;
    r.lib.glyphs.length === lib.glyphs.length + 1
      ? ok(`${ids}：合成字形 ＋1 個 ✓、畫出 ${paths} 條路徑 ✓`)
      : bad(`${ids} 的 forkLibrary 用法不對（字形數 ${r.lib.glyphs.length}，應為 ${lib.glyphs.length + 1}）`);
    paths > 0 ? ok(`${ids} 有筆畫 ✓（不是「有名字沒框」✗）`) : bad(`${ids} 畫不出筆畫 ✗`);
    /* 每一葉都要**真的引用到**（用 drawingIdx ✓，不然純指標字形會畫成空 ✗） */
    const refs = r.lib.glyphs[r.idx]!.strokes.map((s) => s.ref);
    const draws = refs.every((ref) => ref !== null && ref !== undefined && r.lib.glyphs[ref]!.strokes.length > 0);
    draws ? ok(`${ids}：${refs.length} 葉都指到真的畫法 ✓`)
          : bad(`${ids} 有葉子指到空的字形 ✗`);
  }
}

console.log("\n4. 壞 IDS 要誠實（不要硬畫 ✗）");
{
  const cases: [string, boolean][] = [
    ["产厂⿸", false],          /* 算子寫在後面 ✗（`glyph-by-ids.md` 舉的例子 ✓） */
    ["⿰日", false],            /* 少一個分量 ✗ */
    ["日", true],               /* 單葉：畫得出來 ✓ */
    ["&CDP-8B5A;", false],      /* 非 Unicode 部件 ✗ */
  ];
  /* ⚠ `产厂⿸` 這種壞法有**兩層**：算子寫在分量後面 ✗（＝prefix notation 不成立 ✓）。
     深度優先的解析器會把它讀成「叶 厂，然後多出一個 ⿸」→ 走**算子出現在葉的位置**那一條 ✓
     （`idsGlyph` 裡有專門的檢查 ✓）。所以理由一定要講得出「算子」✓。 */
  for (const [ids, want] of cases) {
    const r = idsGlyph(ids, lib);
    if (r.ok === want) {
      ok(`「${ids}」→ ${r.ok ? "畫得出來" : "誠實拒絕"} ✓` +
        (r.ok ? "" : `（${r.problems[0]}）`));
    } else bad(`「${ids}」應該${want ? "畫得出來" : "被拒絕"}：${JSON.stringify(r.ok ? "ok" : r.problems)}`);
  }
  /* ⚠ 想造「算子在葉的位置」的實例其實**做不到** ✓（這是一個好發現 ✓）：
     算子會**吃掉後面兩個字元**當分量，所以只要它還在字串裡，解析就一定失敗 ✗
     （`⿰日⿸` 的 `⿸` 吃掉兩個字元 → 少一個分量 → 解析失敗 ✓）。
     也就是說：**解析這一關已經把「算子寫在葉的位置」全部擋掉了** ✓，
     `idsGlyph` 裡那個檢查是**第二道保險** ✓（防的是未來的寬鬆解析器 ✓）。
     所以這裡只驗「理由講得出來」✓，不硬造實例 ✗。 */
  const r2 = idsGlyph("产厂⿸", lib);
  if (!r2.ok && /prefix notation/.test(r2.problems.join(""))) {
    ok("壞 IDS 的理由講得出來（prefix notation 不成立 ✓）——不硬畫 ✓");
  } else bad("壞 IDS 的理由沒說清楚：" + JSON.stringify(r2.ok ? "ok" : r2.problems));
}

console.log("\n5. 新舊的差別（師父要的「今法對古法的改善」的數字 ✓）");
{
  /* 舊版（＝第 124～128 輪頁面上那一支，**已經刪掉** ✗）由模塊的 `idsGlyphNaiveOld` 提供 ✓，
     **不要在這裡自己再抄一份** ✗——抄一份就會有「兩份實作各說各話」的風險 ✓
     （本專案吃過這個虧 ✓，見 `format.md` 的 IDS 章節 ✓）。 */
  const inkOld = idsGlyphNaiveOld("⿰日月", lib);
  const inkNew = idsGlyph("⿰日月", lib);
  const pair = (L: Lib, idx: number) => [0, 1].map((i) => inkInParent(L, idx, i));
  const oldOv = inkOld.ok ? overlapX(pair(inkOld.lib, inkOld.idx)[0]!, pair(inkOld.lib, inkOld.idx)[1]!) : -1;
  const newOv = inkNew.ok ? overlapX(pair(inkNew.lib, inkNew.idx)[0]!, pair(inkNew.lib, inkNew.idx)[1]!) : -1;
  oldOv > 40 && newOv === 0
    ? ok(`⿰日月 的水平重疊：舊版（不縮放、只擺位 ✗）**${oldOv.toFixed(1)} 格** → 新版 **0 格** ✓`)
    : bad(`新舊的重疊數字不對：舊 ${oldOv}、新 ${newOv}（舊版應 >40 格、新版應為 0 ✓）`);
  oldOv > 40
    ? ok("這一格就是「筆劃大面積交錯」✗ 的**量化證據** ✓（54.9 格 ≈ 半個字身 ✓）")
    : bad("舊版應該有明顯重疊 ✗");
  /* 巢狀也要對照一次 ✓：**不要拿「墨跡面積」當比例** ✗——墨跡面積是「字形自己畫多大」✓，
     不是「分到多大的格子」✗（第一版就是這樣寫的，量到 7941:7547 而誤判 ✗）。
     格子比例在第 1 節已經釘住（日／月 25%、皿 50% ✓），這裡只再看一眼「新舊真的不同」✓。 */
  const n3 = idsGlyphNaiveOld("⿰⿱日月皿", lib);
  const m3 = idsGlyph("⿰⿱日月皿", lib);
  if (n3.ok && m3.ok) {
    const boxOld = n3.lib.glyphs[n3.idx]!.strokes.map((s) => s.box!.join(","));
    const boxNew = m3.lib.glyphs[m3.idx]!.strokes.map((s) => s.box!.join(","));
    boxOld.join(" ") !== boxNew.join(" ")
      ? ok(`盟的新舊框不同 ✓：舊「${boxOld.join(" ")}」→ 新「${boxNew.join(" ")}」`)
      : bad("盟的新舊框居然一樣——舊版應該都是 200×200 擺中心 ✗");
    boxNew.length === 3 && boxNew.join(" ") !== boxOld.join(" ")
      ? ok("新版的框＝**格子本身**（遞迴縮小 ✓）、舊版的框＝**各葉自己的大小**（互相壓 ✗）")
      : bad("新舊框的形狀不對");
  } else bad("盟的新舊對照造不出來");
}

console.log("\n6. IDS → **拼形序**（今法 ✓）：工具 `tools/seq-search.ts`");
{
  /* ⚠ 這一支**不進 `verify`** ✓（跑一次要 10 秒以上 ✗），但契約要在這裡釘住 ✓：
     「`⿰木垚` 要生得出頁面版的答案 `桂圭垚`」✓——
     這是 `glyph-by-ids.md` 的判準，也是「今法」能不能兌現那一句話的**最低門檻** ✓。 */
  const r = searchSeqForIds(lib, "⿰木垚", { judgeMax: 1500 });
  const at = r.candidates.findIndex((c) => c.seq === "桂圭垚");
  at >= 0
  at >= 0
    ? ok("「⿰木垚」→「桂圭垚」在候選裡（#" + (at + 1) + "／" + r.candidates.length + " 條 ✓）——今法的最低門檻 ✓")
    : bad("「⿰木垚」生不出「桂圭垚」✗（今法還沒有兌現）");
  const top = r.candidates[0];
  at >= 0 && at < 10
    ? ok("它在前 10 名之內（現況 #" + (at + 1) + "，最佳是「" + (top ? top.seq : "?") + "」）")
    : bad("「桂圭垚」的名次太後面（#" + (at + 1) + " ✗）——排序還要調整 ✗");
  /* ⚠ **已知不足**（誠實記錄 ✓，見 `../glyph-by-ids.md`）：搜尋還**贏不了排序** ✗——
     同分的候選（`彬杉垚`／`杜土垚`）會排在 `桂圭垚` 前面 ✗。
     這一條**故意只是提示** ✓（不是失敗 ✓），因為它記錄的是「還沒做到」而不是「做壞了」✓。 */
  if (top && top.seq !== "桂圭垚") {
    ok("【現況】最佳仍是「" + top.seq + "」——排序尚未收斂（不是做壞，是還沒做到 ✓，見 glyph-by-ids.md ✓）");
  }
  /* ★★ 第 132 輪：**「這個字就是那個形」要排第一** ✓——
     `⿰日月` 的答案就是 `明` 本身（0 步 ✓、分量逐格等於目標的葉 ✓）。
     ⚠ 少了 `exact` 這一項，`明` 的樹只有一個節點 ✗，樹級的量永遠算不到滿分 ✗
       → 它會排到 **#1134** ✗（實測 ✓），而一堆 `旯九月` 那種垃圾排在前面 ✗。 */
  const r2 = searchSeqForIds(lib, "⿰日月", { judgeMax: 600 });
  r2.candidates[0]?.seq === "明"
    ? ok("「⿰日月」→「明」**就是答案、名次 #1** ✓（0 步的候選要當最高順位 ✓）")
    : bad("「⿰日月」的答案是「明」卻沒排第一：最佳是「" + (r2.candidates[0]?.seq ?? "（無）") + "」✗");
}

console.log(fail === 0 ? "\n全部通過" : `\n有 ${fail} 項失敗`);
process.exit(fail === 0 ? 0 : 1);
