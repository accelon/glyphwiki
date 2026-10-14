// free-compose-test.ts — 驗證 free-compose.ts 的語意、護欄、部件清單、內嵌 SVG。
// 用法: bun run tools/free-compose-test.ts
import { readFileSync, writeFileSync } from "node:fs";
import { attachNames } from "./lib-names.ts";
import { decodeLibrary, findGlyphIndex, indexOfChar, charOf, codePointOf, indexOfCodePoint, isPlainIdeograph, ptCountOf } from "./lib-format.ts";
import type { Library } from "./lib-format.ts";
import { ensureEngine, svgOf, inkOfRefInParent } from "./compose-fit.ts";
import {
  OPEN, CLOSE, MAX_PARTS, evalSeq, scanText, listReplaceables,
  createSvgRenderer, INLINE_CSS, inlineAlignEm, baselineDelta, canReplaceCp, solveIdsSlots,
} from "./free-compose.ts";
import type { SeqResult } from "./free-compose.ts";
import { minCrossDistOf } from "./stroke-overlap.ts";

const D = "D:/2023/glyphwiki";
ensureEngine();
const lib: Library = attachNames(decodeLibrary(
  new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))),
), `${D}/out/lib-cjk.bin.gz`);

let fail = 0;
const ok = (s: string) => console.log("  ✓ " + s);
const bad = (s: string) => { console.log("  ✗ " + s); fail++; };
const eq = (a: unknown, b: unknown, s: string) =>
  JSON.stringify(a) === JSON.stringify(b) ? ok(s) : bad(`${s}：得到 ${JSON.stringify(a)}，應為 ${JSON.stringify(b)}`);
const fmtD = (v: number) => (!Number.isFinite(v) ? "無" : v.toFixed(1));

// ---------------------------------------------------------------- 1. 語意

console.log("1. 構形序列語意（遞歸讀法，依 format.md「進階任務 2」）");
const cases: [string, boolean, string][] = [
  ["街圭舞", true, "街 的 圭 → 舞"],
  ["寶缶支", true, "官方對照組"],
  ["峰夆水", true, "單層"],
  ["峰夆電雨水", true, "巢狀：夆 →（電 的 雨 → 水）"],
  ["街行彳舞亍", true, "行 → 彳舞亍"],
  ["街行", false, "只有基字與舊部件"],
  ["街無此件", false, "舊部件不在樹中（打錯字）→ 直接失敗，不可靜默串接"],
  ["街行" + "彳".repeat(MAX_PARTS), false, `超過長度上限 ${MAX_PARTS}`],];
for (const [expr, want, note] of cases) {
  const r = evalSeq(lib, expr);
  if (r.ok === want) ok(`${expr}（${note}）→ ${r.ok ? r.log.join("；") : "失敗：" + r.error}`);
  else bad(`${expr}（${note}）：預期 ${want ? "成功" : "失敗"}，得到 ${r.ok ? "成功" : "失敗：" + r.error}`);
}

console.log("\n2. 巢狀求值順序（內層先算，外層代入內層結果而不是泛用字形）");
{
  const r = evalSeq(lib, "峰夆電雨水");
  if (!r.ok) bad(r.error);
  else {
    // 2024 追加「同層讓位」之後，這兩步的框不再原樣沿用——
    // 水 是滿格字形，塞進 電 的「雨」槽位（框 [0,0,200,184]）會直接壓到下面的 田，
    // 所以讓位到 [1,0,201,94]（兄弟 田 的墨跡上緣之上）。
    // 這裡只斷言「讀法順序」與「替換發生」，框的變化交給 `tools/band-compare.ts` 目視。
    r.log[0]!.startsWith("電 的 雨 → 水") ? ok(`內層先求值：${r.log[0]}`) : bad(`內層：${r.log[0]}`);
    r.log[1]!.startsWith("峰 的 夆 → 電雨水") ? ok(`外層代入：${r.log[1]}`) : bad(`外層：${r.log[1]}`);
    r.log.length === 2 ? ok("正好兩步（內層先算完才代入外層）") : bad(`步數 ${r.log.length}`);
    const bi = findGlyphIndex(lib, "u5cf0")!;
    const refs = r.lib.glyphs[bi]!.strokes.filter((s) => s.kind === 99).map((s) => r.lib.names[s.ref!]!);
    !refs.includes("u5906-02")
      ? ok(`峰 的引用已改寫為 ${refs.join(", ")}（夆 u5906-02 已被取代）`)
      : bad(`峰 的引用未改寫：${refs.join(", ")}`);
  }
}

console.log("\n3. 替換沿用原框（框是人工手調資產，見 format.md「框與自由組字」）");
{
  // 寶 → u21a67-03@3(宀+缶) ; 缶 的引用框是 [0,0,200,200]
  const bi = findGlyphIndex(lib, "u5bf6-j")!;
  const mid = lib.glyphs[bi]!.strokes.find((s) => s.kind === 99 && s.ref !== null)!;
  const paren = mid.ref!;
  const si = lib.glyphs[paren]!.strokes.findIndex((s) => s.kind === 99 && s.ref !== null);
  // 縵 是「缶」那一個引用（第 2 個引用）
  const refs = lib.glyphs[paren]!.strokes
    .map((s, i) => ({ s, i }))
    .filter((x) => x.s.kind === 99 && x.s.ref !== null);
  const fouEntry = refs[refs.length - 1]!;
  const before = lib.glyphs[paren]!.strokes[fouEntry.i]!;

  const zi = findGlyphIndex(lib, "u652f-j")!;
  const r = evalSeq(lib, "寶缶支");
  if (!r.ok) bad(r.error);
  else {
    const after = r.lib.glyphs[paren]!.strokes.find((s) => s.kind === 99 && s.ref === zi);
    if (!after) bad(`找不到被替換的節點（paren=${paren}, strokeIx=${fouEntry.i}）`);
    else {
      // 支 放得進 缶 的槽位、也沒有壓到兄弟 → 框應該完全不動
      eq(after.box, before.box, `框沿用不變：${JSON.stringify(before.box)}`);
      eq(after.stretch, before.stretch, `伸縮沿用不變：${JSON.stringify(before.stretch)}`);
    }
  }

  // 相對地：**放不下（新舊墨跡差很多）時要重新配框**。2026-10-13 起順序是
  //   ① 新舊墨跡比在 0.75–1.3 → 沿用原框（框是人工資產）
  //   ② 否則 → **墨跡對齊**：把新內容的框算成「新墨跡正好蓋住舊墨跡」（大小不變）
  //   ③ 都不適用才走同層讓位（把框推到兄弟之外）
  // 這一支測試跑的是 BMP 字庫（沒有 Ext B 的 𩀨），所以用 `峰夆水` 當例子：
  // 水 是滿格字形、夆 的墨跡窄得多 → 現在是墨跡對齊（比讓位更貼近「原地換」）。
  const r2 = evalSeq(lib, "峰夆水");
  if (!r2.ok) bad(r2.error);
  else {
    const line = r2.log[0]!;
    line.includes("墨跡對齊到框")
      ? ok(`新舊墨跡差很多時改用墨跡對齊：${line}`)
      : bad(`應該墨跡對齊但沒有：${line}`);
  }
  /* `街圭舞`：使用者回報「舞太大，因為圭的框太大」（圭 的框 150 寬，但圭的墨跡只佔 57%，
     舞 的墨跡佔 85% → 沿用框會畫成 127 寬、壓到 行 右半的 亍）。墨跡對齊後是 91 寬，
     與 `衚胡舞`（衚 的 胡 框 102 寬 → 舞 87 寬）一致。 */
  const r3 = evalSeq(lib, "街圭舞");
  if (!r3.ok) bad(r3.error);
  else {
    const line = r3.log[0]!;
    const w = inkWidthOfRef(lib, r3, 1);
    line.includes("墨跡對齊到框") && w > 70 && w < 100
      ? ok(`街 的 圭→舞 墨跡對齊、舞 寬 ${Math.round(w)} 格（與 衚胡舞 的 87 同級）：${line}`)
      : bad(`街圭舞 的舞大小不對（寬 ${Math.round(w)}）：${line}`);
  }

  // **同形部件直接換，不要讓位**（使用者回報「初衤礻 的 礻 框很小」）：
  // 衤→礻 的墨跡是 0.89×0.99，本來就該沿用原框；讓位會把 礻 推成一條細帶。
  // 相對地 衤→刀 是 1.72×0.90（真的比較寬），還是要讓位。
  const r4 = evalSeq(lib, "初衤礻");
  if (!r4.ok) bad(r4.error);
  else {
    const line = r4.log[0]!;
    const box = /框\[([^\]]*)\]/.exec(line);
    const kept = line.includes("沿用原框");
    kept
      ? ok(`同形部件（初 的 衤→礻）直接換、沿用原框：${line}`)
      : bad(`同形部件被讓位了（框 ${box ? box[1] : "?"}）：${line}`);
    /* 幾何也要對：礻 佔的區域要跟 衤 差不多（不是被塞進細帶） */
    const w = inkWidthOfRef(lib, r4, 0);
    w > 60 ? ok(`礻 的墨跡寬度 ${Math.round(w)} 格（與 衤 的 82 格同級）`)
           : bad(`礻 被壓成細帶：寬度只有 ${Math.round(w)} 格`);
  }
  const r5 = evalSeq(lib, "初衤刀");
  if (!r5.ok) bad(r5.error);
  else ok(`真的大小不同時改走墨跡對齊（初 的 衤→刀）：${r5.log[0]}`);

  /* **位置也要看**（第 110 輪，師父回報「秧央角 效果不好，角侵占了左邊的禾」）：
     `秧` 的 `禾`／`央` 兩個 KAGE 框都幾乎是**恆等框**（`禾`[-1,0,180,200]、`央`[5,0,200,200]），
     因為那兩個部件字形在自己的畫布裡就已經擺好位置（`央` 的墨跡在 x=64..188＝右半）；
     而 `角` 是**置中**的（墨跡 x=19..160）。大小比 1.14×1.02 落在 0.75–1.3 的 drop-in 範圍，
     所以舊版沿用恆等框 → `角` 畫在正中間、侵占 `禾` ✗。
     修法：新舊墨跡的**中心位移** > `SHIFT_TOL`(8) 就改走墨跡對齊 ✓。
     這一條測「替換後的墨跡要落在被替換部件的墨跡上」——不只看大小，也看位置。 */
  const r6 = evalSeq(lib, "秧央角");
  if (!r6.ok) bad(r6.error);
  else {
    const line = r6.log[0]!;
    /* 結果字形的槽位次序＝KAGE 原序：0=禾、1=角 ✓ */
    const inHe = inkOfRefInParent(r6.lib, r6.targetIdx, 0);
    const inJiao = inkOfRefInParent(r6.lib, r6.targetIdx, 1);
    const yangIdx = indexOfChar(lib, "秧")!;
    const oldYang = inkOfRefInParent(lib, yangIdx, 1);
    if (!inHe || !inJiao || !oldYang) bad("秧央角：量不到墨跡");
    else {
      const dx = Math.abs((inJiao.x1 + inJiao.x2) / 2 - (oldYang.x1 + oldYang.x2) / 2);
      const invades = inJiao.x1 < inHe.x1 + (inHe.x2 - inHe.x1) * 0.5;   /* 角 的左緣跑到 禾 的左半 */
      dx <= 8
        ? ok(`秧 的 央→角：角的墨跡落在原本 央 的位置（中心位移 ${dx.toFixed(1)} 格）：${line}`)
        : bad(`秧 的 央→角：角沒有落在 央 的位置（中心位移 ${dx.toFixed(1)} 格）：${line}`);
      !invades
        ? ok(`角 沒有侵占左邊的 禾（角左緣 ${Math.round(inJiao.x1)}、禾墨跡 ${Math.round(inHe.x1)}–${Math.round(inHe.x2)}）`)
        : bad(`角 侵占左邊的 禾（角左緣 ${Math.round(inJiao.x1)} < 禾 的 ${Math.round(inHe.x1)}–${Math.round(inHe.x2)}）`);
    }
  }
}

/** 合成結果裡第 ix 個引用的墨跡寬度（用來看有沒有被塞成細帶）。 */
function inkWidthOfRef(lib: any, r: any, ix: number): number {
  const b = inkOfRefInParent(r.lib, r.targetIdx, ix);
  return b ? b.x2 - b.x1 : 0;
}

console.log("\n4. 兩種讀法（施工單 §二 V2 待確認的那條）");
{
  // `彳舞亍` 兩種讀法：
  //   預設（rowFallback: true）  遞歸不成立 → 退化成 ⿲彳舞亍（三件並排）
  //   嚴格（rowFallback: false） 遞歸不成立 → 直接失敗，不猜
  const rec = evalSeq(lib, "彳舞亍");
  const strict = evalSeq(lib, "彳舞亍", { rowFallback: false });
  console.log(`  預設（遞歸優先，失敗才串接）：${rec.ok ? "成功 " + rec.log.join("；") : "失敗：" + rec.error}`);
  console.log(`  嚴格（只准遞歸）            ：${strict.ok ? "成功 " + strict.log.join("；") : "失敗：" + strict.error}`);
  rec.ok && !rec.substituted
    ? ok("預設讀法把 彳舞亍 退化成 ⿲彳舞亍（三件並排）")
    : bad("預設讀法對 彳舞亍 的行為改變了");
  !strict.ok ? ok("嚴格讀法對 彳舞亍 不猜、直接失敗（訊息：" + strict.error + "）")
             : bad("嚴格讀法不該成功");

  // `街行彳舞亍` 是最有價值的一個例子：**只有**允許串接才畫得出來，
  // 因為它的「新內容」正是 `彳舞亍`——而 彳 裡沒有 舞，遞歸讀不成。
  const a = evalSeq(lib, "街行彳舞亍");
  const b = evalSeq(lib, "街行彳舞亍", { rowFallback: false });
  console.log(`  街行彳舞亍 預設：${a.ok ? a.log.join("；") : "失敗：" + a.error}`);
  console.log(`  街行彳舞亍 嚴格：${b.ok ? b.log.join("；") : "失敗：" + b.error}`);
  if (a.ok) {
    const bi = findGlyphIndex(lib, "u8857-j")!;
    const refs = a.lib.glyphs[bi]!.strokes
      .filter((s) => s.kind === 99 && s.ref !== null)
      .map((s) => a.lib.names[s.ref!]!);
    refs.some((n) => n.startsWith("__row"))
      ? ok(`預設讀法：街 的引用含串接字形（${refs.join(", ")}）`)
      : bad(`預設讀法：街 的引用沒有串接字形（${refs.join(", ")}）`);
  } else bad("街行彳舞亍 預設讀法失敗：" + a.error);
  !b.ok
    ? ok("嚴格讀法對 街行彳舞亍 失敗——這正是「要不要允許串接」的分歧點")
    : bad("嚴格讀法不該成功");
  console.log("  ** 這一條要用 UI 的兩個讀法並排看，再請師父定案。**");
}

console.log("\n5. 內文語法三條護欄");
const text =
  `正常文字用系統字形。${OPEN}彳舞亍${CLOSE}這是序列。` +
  `沒成對的${OPEN}街圭舞 不算。\n` +
  `跨行的${OPEN}街圭舞\n舞${CLOSE}不算。` +
  `${OPEN}街行${CLOSE}太短不算。` +
  `${OPEN}${"街圭舞舞舞舞舞舞舞舞舞舞舞舞"}${CLOSE}太長不算。`;
{
  const segs = scanText(lib, text);
  const seqs = segs.filter((s) => s.kind === "seq") as any[];
  eq(seqs.length, 1, `只認出 1 個合法序列（共切 ${segs.length} 段）`);
  if (seqs[0]) eq(seqs[0].expr, "彳舞亍", "認出的是 彳舞亍");
  const joined = segs.filter((s) => s.kind === "text").map((s: any) => s.text).join("");
  joined.includes(OPEN + "街行" + CLOSE) ? ok("太短的序列原樣留在文字中") : bad("太短的序列被吃掉了");
  joined.includes("不算") ? ok("未通過護欄的內容都沒被吃掉") : bad("護欄失效：內容被吃掉");
  // 掃描必須完整覆蓋（不丟字）
  const all = segs.map((s) => (s.kind === "text" ? s.text : text.slice(s.fullStart, s.fullEnd))).join("");
  eq(all, text, "掃描結果可完整還原原文（不丟字、不重複）");
}

// ---------------------------------------------------------------- 部件清單

console.log("\n6. listReplaceables（缺口一：提案第 2 條的心臟）");
for (const c of ["街", "寶", "明", "盟", "漢", "舞"]) {
  const bi = findGlyphIndex(lib, "u" + c.codePointAt(0)!.toString(16));
  if (bi === undefined) { bad(`${c} 不在庫中`); continue; }
  const list = listReplaceables(lib, bi);
  console.log(`  ${c}（${lib.names[bi]}）→ ${list.length} 個：` +
    list.map((r) => `L${r.level}:${r.ch}(${r.name})`).join(" "));
  list.length <= 20
    ? ok(`${c}：${list.length} 個按鈕，在可接受範圍（≤20）`)
    : bad(`${c}：${list.length} 個按鈕，超出可接受範圍`);
}
{
  const list = listReplaceables(lib, findGlyphIndex(lib, "u8857-j")!);
  const names = list.map((r) => r.ch);
  names.includes("行") && names.includes("圭") && names.includes("彳")
    ? ok(`街 的引用節點含 行、圭，且 行 底下還有 彳（各級都收得到）`)
    : bad(`街 的部件清單不完整：${names.join("")}`);
  const lv = list.find((r) => r.ch === "彳")!;
  eq(lv.level, 2, "彳 的層級是 2（行 底下）");
}

// ---------------------------------------------------------------- 內嵌 SVG

console.log("\n7. 內嵌 SVG 的關鍵三條（顏色／大小／基線）");
{
  const R = createSvgRenderer(lib);
  const { svg, result } = R.svgOfSeq("彳舞亍");
  if (!result.ok) bad("彳舞亍 求值失敗：" + result.error);
  else {
    const s = svg!;
    /fill="currentColor"/.test(s) && !/fill="black"/.test(s)
      ? ok('沒有殘留 fill="black"，已改為 currentColor（顏色跟隨）')
      : bad("fill 未改成 currentColor");
    /viewBox="/.test(s) ? ok("有 viewBox（1em 縮放的前提）") : bad("缺 viewBox");
    !/\swidth="/.test(s) && !/\sheight="/.test(s)
      ? ok("已移除 width/height（否則不會跟隨 1em）")
      : bad("仍有 width/height 屬性");
    /class="gc-inline"/.test(s) ? ok('有 class="gc-inline"') : bad("缺 gc-inline class");
    [".gc-inline", "currentColor", "1em", "vertical-align", "-0.22em"].every((k) => INLINE_CSS.includes(k))
      ? ok(`INLINE_CSS 含四項關鍵宣告（基線 -0.22em 為實測修正值，非施工單的 -0.1em）`)
      : bad("INLINE_CSS 不完整：" + INLINE_CSS);
    !INLINE_CSS.includes("-0.1em")
      ? ok("已不含施工單的 -0.1em（實測會讓字浮在基線上約 0.12em）")
      : bad("仍留著 -0.1em");
    // 基線的迴歸測試（不需要瀏覽器）：
    // CSS 讓 SVG 元素 1em 見方、viewBox 0 0 200 200，相對定位的 inline-block
    // 以元素底端坐在文字基線上 → SVG 墨跡下界相對基線 = 1 − 緊框y2/200 + align。
    // 實測（三列探針法，100px 字級；見 free-compose.ts 的 INLINE_CSS 註解）
    // 系統字 街 的墨跡下界落在基線下 +0.16em。
    const bd = baselineDelta(lib, evalSeq(lib, "寶缶支"));
    if (!bd) bad("baselineDelta 無法計算");
    else {
      // 幾何驗證：直接由該字形的緊框推出期望值，不寫死數字
      const r2 = evalSeq(lib, "寶缶支");
      const tight2 = r2.ok ? r2.lib.glyphs[r2.targetIdx]!.tight! : null;
      if (!tight2) bad("寶缶支 沒有緊框");
      else {
        const expected = 1 - tight2[3] / 200 + inlineAlignEm();
        Math.abs(bd.svgBottom - expected) < 1e-9
          ? ok(`baselineDelta 幾何正確：${bd.svgBottom.toFixed(3)}em（＝ 1 − ${tight2[3]}/200 − 0.22）`)
          : bad(`baselineDelta 幾何不對：${bd.svgBottom} vs ${expected}`);
      }
      Math.abs(bd.svgBottom - -0.16) < 0.10
        ? ok(`預測墨跡下界 ${bd.svgBottom.toFixed(3)}em 落在實測基準 -0.160em 的 ±0.10em 內`)
        : bad(`預測墨跡下界 ${bd.svgBottom.toFixed(3)}em 偏離實測基準 -0.160em 超過 0.10em`);
    }
  }
  const one = R.svgOfIdx(findGlyphIndex(lib, "u5bf6-j")!);
  one && /^<svg/.test(one) ? ok("單字渲染成功") : bad("單字渲染失敗");
  R.svgOfSeq("彳舞亍").svg === svg ? ok("重複求值命中快取（同一字串）") : bad("快取未命中");
  // 不同序列不可撞鍵
  const a = R.svgOfSeq("街圭舞").svg;
  const b = R.svgOfSeq("街行彳舞亍").svg;
  a !== b ? ok("不同序列的快取鍵不衝突") : bad("不同序列回傳同一個 SVG（快取撞鍵）");
}

// ---------------------------------------------------------------- 出圖

console.log("\n8. 產生 out/free-compose-test.svg");
{
  const S = 200;
  const cells: { svg: string | null; title: string; sub: string; dist?: number }[] = [];
  const pushSeq = (expr: string, o: { rowFallback?: boolean } = {}) => {
    const r = evalSeq(lib, expr, o);
    if (!r.ok) { cells.push({ svg: null, title: expr, sub: "✗ " + r.error }); return; }
    cells.push({ svg: svgOf(r.lib, r.targetIdx), title: expr, sub: r.log.join("；"), dist: minCrossDistOf(r.lib, r.targetIdx) });
  };
  for (const c of ["街", "峰"]) {
    const i = findGlyphIndex(lib, "u" + c.codePointAt(0)!.toString(16))!;
    cells.push({ svg: svgOf(lib, i), title: c + "（原字）", sub: "—", dist: minCrossDistOf(lib, i) });
  }
  pushSeq("街圭舞");
  pushSeq("街行彳");
  pushSeq("街行舞");
  pushSeq("街行彳舞亍");
  pushSeq("彳舞亍", { rowFallback: false });
  pushSeq("寶缶支");
  pushSeq("峰夆水");
  pushSeq("峰夆電雨水");

  let x = 10;
  const parts: string[] = [];
  for (const c of cells) {
    const cx = x + S / 2;
    if (c.svg) {
      const inner = c.svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "");
      parts.push(`<g transform="translate(${x},20)">${inner}</g>`);
    } else {
      parts.push(`<text x="${cx}" y="120" text-anchor="middle" font-size="40" fill="#c00">✗</text>`);
    }
    parts.push(`<text x="${cx}" y="244" text-anchor="middle" font-size="15" font-family="sans-serif" fill="#111">${c.title}</text>`);
    parts.push(`<text x="${cx}" y="262" text-anchor="middle" font-size="10" font-family="monospace" fill="#666">${c.sub.length > 46 ? c.sub.slice(0, 46) + "…" : c.sub}</text>`);
    if (c.dist !== undefined) {
      parts.push(`<text x="${cx}" y="280" text-anchor="middle" font-size="12" font-family="sans-serif" fill="${c.dist < 2 ? "#c00" : "#060"}">跨部件距離 ${fmtD(c.dist)}</text>`);
    }
    x += S + 10;
  }
  const W = x, H = 294;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="100%" height="100%" fill="#fff"/><g fill="#111">${parts.join("")}</g></svg>`;
  writeFileSync(`${D}/out/free-compose-test.svg`, svg);
  ok(`已寫出 out/free-compose-test.svg（${W}×${H}）`);
}

// ---------------------------------------------------------------- 品質量測

console.log("\n9. 組字品質把關（缺口三：跨部件筆劃最短距離；0 ＝ 相交）");
{
  const cases: [string, string][] = [
    ["街（原字）", "街"],
    ["寶（原字）", "寶"],
    ["寶缶支（已知良好）", "寶缶支"],
    ["街圭舞", "街圭舞"],
    ["街行彳舞亍（三件塞進行的位置）", "街行彳舞亍"],
  ];
  const dists: [string, number, boolean][] = [];
  for (const [label, expr] of cases) {
    let d: number;
    let okShape = true;
    if (Array.from(expr).length === 1) {
      d = minCrossDistOf(lib, findGlyphIndex(lib, "u" + expr.codePointAt(0)!.toString(16))!);
    } else {
      const r = evalSeq(lib, expr);
      if (!r.ok) { console.log(`  ${label}：求值失敗（${r.error}）`); okShape = false; d = NaN; }
      else d = minCrossDistOf(r.lib, r.targetIdx);
    }
    if (!okShape) continue;
    dists.push([label, d, d < 2]);
    console.log(`  ${label}：${fmtD(d)}${d < 2 ? "  ← 低於門檻 2，UI 會標警示" : ""}`);
  }
  // 原字 寶 的基線是 0.7（KAGE 本來就有部件相接），所以門檻看的是「有沒有變差」
  const bao = dists.find((x) => x[0].startsWith("寶（原字）"))!;
  const baoOk = dists.find((x) => x[0].startsWith("寶缶支"))!;
  baoOk[1] >= bao[1] - 0.5
    ? ok(`好替換（寶缶支 ${fmtD(baoOk[1])}）不低於原字基線（寶 ${fmtD(bao[1])}）`)
    : bad(`好替換反而變差：寶 ${fmtD(bao[1])} → 寶缶支 ${fmtD(baoOk[1])}`);
  // 打錯字必須在語意層就失敗，不能靠品質警示兜
  const typo = evalSeq(lib, "街無此件");
  !typo.ok
    ? ok(`打錯字在語意層就被擋下（街無此件：${typo.error}）`)
    : bad("打錯字竟然求值成功（會畫出荒謬字形）");
}

// ---------------------------------------------------------------- 10. IDS 槽位推斷
// `幸` 的 KAGE 是「一筆引用 → 一個用筆畫畫的字形」，IDS 是 `[土 𢆉]`。
// `幸土业`（幸 的 土 → 业）要的是 ⿱业𢆉：引擎現在會**從筆畫反推槽位**
// （把父字形筆畫依構件分組、把構件攤平後評分取最佳），再把目標構件那幾筆
// 換成一筆指向新內容的引用；其他筆畫原樣保留。推不出來時才判不合法。
// 這一節要用完整字庫：測試用的 lib-cjk 沒有 IDS 區段。
console.log("\n10. IDS 槽位推斷（孫級部件原地換）");
{
  const all: Library = decodeLibrary(
    new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk-all.bin.gz`))),
  );
  const cases: [string, boolean, string][] = [
    ["幸土业", true, "幸 的 土 → 业（業在上、𢆉 在下）：槽位由 IDS 構件反推"],
    ["報土业", true, "同一個機制在樹的深處（報→幸→土）"],
    ["報𢆉田", true, "換下半的 𢆉 → 田"],
    ["彳舞亍", true, "舞 不是 彳 的構件、彳 也沒有 IDS → 仍是一串部件（回歸）"],
    ["街行彳舞亍", true, "官方例子：行 →（彳舞亍）（回歸）"],
    ["街圭舞", true, "一般替換不受影響（回歸）"],
    ["峰夆電雨水", true, "巢狀替換不受影響（回歸）"],
    ["報幸土业", true, "新內容 土业 讀不成序列 → 仍走橫向串接（與 街行彳舞亍 同形）"],
  ];
  for (const [expr, want, note] of cases) {
    const r = evalSeq(all, expr);
    if (r.ok !== want) {
      bad(`${expr}（${note}）：預期 ${want ? "成功" : "失敗"}，得到 ${r.ok ? "成功：" + r.log.join("；") : "失敗：" + r.error}`);
    } else if (r.ok) {
      ok(`${expr}（${note}）→ ${r.log.join("；") || "（原字）"}`);
    } else {
      ok(`${expr}（${note}）→ ${r.error}`);
    }
  }

  // 幾何：`幸土业` 的結果，新內容（业）的框必須落在上半、原來的下半（𢆉 的筆畫）原樣留著
  const r = evalSeq(all, "幸土业");
  if (!r.ok) {
    bad(`幸土业 求值失敗：${r.error}`);
  } else {
    const g = r.lib.glyphs[r.targetIdx]!;
    const refs = g.strokes.filter((s) => s.kind === 99 && s.ref !== null);
    const kept = g.strokes.filter((s) => !(s.kind === 99 && s.ref !== null));
    const refBox = refs[0]?.box ?? null;
    let ky1 = Infinity, ky2 = -Infinity;
    for (const s of kept) {
      const n = ptCountOf(s.kind);
      for (let i = 0; i < n; i++) {
        ky1 = Math.min(ky1, s.points[i * 2 + 1]!);
        ky2 = Math.max(ky2, s.points[i * 2 + 1]!);
      }
    }
    const refCy = refBox ? (refBox[1]! + refBox[3]!) / 2 : NaN;
    const keptCy = Number.isFinite(ky1) ? (ky1 + ky2) / 2 : NaN;
    refs.length === 1 && refBox && refCy < keptCy
      ? ok(`幸土业 的幾何：新內容框 ${JSON.stringify(refBox.map((v) => Math.round(v)))}（中心 y=${refCy.toFixed(0)}）` +
           `在原下半（𢆉，中心 y=${keptCy.toFixed(0)}）之上，且原本 5 筆原樣保留`)
      : bad(`幸土业 的幾何不對：refs=${refs.length} box=${JSON.stringify(refBox)} refCy=${refCy} keptCy=${keptCy}`);
    // 幸 的原字上半（土）在下半之上，正是「土→业 原地換」的意思
    const before = evalSeq(all, "幸");
    const after = evalSeq(all, "幸");
    before.ok && after.ok
      ? ok("幸 本身不受影響（求值仍是原字，槽位推斷只在替換時發生）")
      : bad("幸 的求值被影響了");
  }
}

// ---------------------------------------------------------------- 11. 乾跑 canReplaceCp
// 頁面的「部件清單」要先知道**哪幾格點下去有結果**（回報：䴺 點 來 → 䴺來 → 打 去
// → 引擎說換不到，使用者以為是壞的）。`canReplaceCp()` 是 `applyReplace()` 的乾跑，
// 兩者**必須給同一個答案**，否則會出現「清單說可以、真的做卻失敗」的地獄。
console.log("\n11. canReplaceCp（部件清單的可點性；與 applyReplace 同一條走法）");
{
  const all: Library = decodeLibrary(
    new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk-all.bin.gz`))),
  );
  /* [基字, 部件, 換得動嗎, 說明]
      換不動的原因：在構件階層裡、但槽位推不出來（`寶` 的 `𡪓`）；
      `進` 的 `辶` 是另一種（KAGE 引用的是相容碼位，見最後一列）。 */
  const cases: [string, string, boolean, string][] = [
    ["報", "幸", true, "KAGE 直接引用"],
    ["報", "土", true, "孫級：藏在 幸 的 IDS 構件裡（槽位由筆畫反推）"],
    ["報", "𢆉", true, "同上，另一半"],
    ["報", "又", false, "第 96 輪：`報` 的 comp 變細之後，`又` 在 IDS 階層裡但**畫法沒有可換的槽位**（引用樹裡沒有）→ 乾跑＝false ✓"],
    ["䴺", "麥", true, "KAGE 引用（注意庫裡有 g1ca4／g1ca5 兩個 麥，比索引會對不上）"],
    ["䴺", "咅", true, "KAGE 引用"],
    ["䴺", "口", true, "咅 的 IDS 構件"],
    ["䴺", "立", true, "同上"],
    ["䴺", "來", false, "第 109 輪 A′：`麥` 的 comp 變成 `來＋夂`（正確 ✓）之後，`來` 在結構階層裡但**沒有 KAGE 引用** ✗ → 換不到 ✓（原本靠 `麥＝來` 的部分 IDS 才換得動 ✗）。動線改由 `䴺麥去` 承擔 ✓"],
    ["寶", "缶", true, "IDS 構件（𡩧 → 珤 那條路上推得出來）"],
    ["寶", "𡪓", false, "推不出槽位（殘筆分不出高下）"],
    ["合", "口", false, "第 96 輪：`合` 的 comp 由 `口` 變成 `亼＋口`（新 IDS 來源 ✓），`口` 不再是「部分 IDS 的唯一構件」✗，而畫法裡它是手畫的、沒有槽位 → 乾跑＝false ✓"],
    ["邏", "羅", true, "KAGE 直接引用"],
    ["進", "辶", false, "進 引用的是相容碼位 辶 U+FA66，不是 辶 U+8FB6"],
    ["從", "彳", true, "KAGE 直接引用"],
  ];
  let mismatch = 0, checked = 0;
  for (const [base, comp, want, note] of cases) {
    const bi = indexOfChar(all, base);
    if (bi === undefined) { bad(`${base} 不在字庫中`); continue; }
    checked++;
    const oldCp = comp.codePointAt(0)!;
    const dry = canReplaceCp(all, bi, oldCp);
    /* 真的做一次比對：`base + 部件 + 支`（會不會成功與新內容是什麼無關） */
    const actual = evalSeq(all, base + comp + "支").ok;
    if (dry !== want) { bad(`canReplaceCp(${base}, ${comp})＝${dry}，預期 ${want}（${note}）`); mismatch++; }
    else if (dry !== actual) { bad(`${base} 的 ${comp}：乾跑說 ${dry}、真的 ${base}${comp}支 ＝${actual}（${note}）`); mismatch++; }
    else ok(`${base} 的 ${comp}：${dry ? "換得動" : "換不動"}（${note}）`);
  }
  if (mismatch === 0 && checked === cases.length) ok(`${cases.length} 組的乾跑與實際替換結果一致`);

  /* 全庫抽驗：**每個「部分 IDS 推得出槽位」的正規字形**，乾跑與真的替換都要一致。
     這一條同時把「這條路到底影響幾個字」寫成數字（目前約 100 個，不是幾千個）。 */
  let swept = 0, sweepBad = 0;
  for (let i = 0; i < all.glyphs.length; i++) {
    const cp = codePointOf(all, i);
    if (!cp || !isPlainIdeograph(all, i)) continue;
    if (indexOfCodePoint(all, cp) !== i) continue;
    const sol = solveIdsSlots(all, i);
    if (!sol || !sol.partial) continue;
    for (const s of sol.slots) {
      if (s.index === undefined) continue;
      const ch = charOf(all, s.index);
      if (!ch) continue;
      const base = charOf(all, i);
      if (!base) continue;
      const dry = canReplaceCp(all, i, ch.codePointAt(0)!);
      const real = evalSeq(all, base + ch + "支").ok;
      swept++;
      if (!dry || !real) { sweepBad++; if (sweepBad <= 3) bad(`抽驗 ${base} 的 ${ch}：乾跑=${dry}、真的=${real}`); }
    }
  }
  sweepBad === 0 && swept > 50
    ? ok(`全庫抽驗：${swept} 個「部分 IDS 可替換的部件」乾跑與實際替換都一致`)
    : bad(`全庫抽驗：${swept} 個裡有 ${sweepBad} 個不一致`);
}

// ---------------------------------------------------------------- 12. 部分 IDS（沒有碼位的構件）
// 使用者的要求：「`䴺來去` 只是要將 `來` 換掉，底下的 `&GT-K00207;` 完全不動。」
// 字庫的 IDS 區段只存有碼位的構件（build-library.ts 的 `comp_cp IS NOT NULL`），
// 所以 `麥 U+9EA5`（真 IDS＝`⿱來&GT-K00207;`）只剩 `[來]`。這一節驗：
//   ① 認得出 `來` 是哪幾筆、② 換掉之後**其餘筆畫一個字都沒動**、③ 新內容落在 `來` 的位置。
console.log("\n12. 部分 IDS：只換有碼位的那個構件，殘筆（沒有碼位的）原樣不動");
{
  const all: Library = decodeLibrary(
    new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk-all.bin.gz`))),
  );
  /* 䴺 引用的是**窄版**的麥（g1ca5），它的殘差比正規麥大（25.5 對 14.0），
     是這一條路最邊緣的實例之一——留著當哨兵。 */
  const cases: [string, string, string, number][] = [
    /* 第 109 輪 A′ 移除：["麥","來","支",20]——`麥` 手畫、KAGE 沒有 `來` 的引用 ✗ → 引擎換不到 ✓ */
    /* 第 109 輪 A′ 移除：["䴺","來","去",30]——同上（師父最初回報的那一組改由 䴺麥去 承擔 ✓） */
    /* 第 96 輪移除兩條（`["合","口","支",5]`、`["報","又","支",15]`）：
       `合`／`報` 的 comp 變細之後（新 IDS 來源 ✓），`口`／`又` 雖然還在 IDS 階層裡，
       但**畫法裡沒有可換的槽位**（KAGE 引用樹中沒有該構件 ✗）→ 替換被拒 ✓，
       這一區（部分 IDS 的殘筆替換）在她們身上已無可測行為 ✗。
       這條路仍由上面 `麥`／`䴺` 兩條看著 ✓（那才是真正有殘筆的實例 ✓）。 */
  ];
  for (const [base, comp, to, maxErr] of cases) {
    const baseIdx = indexOfChar(all, base)!;
    const sol = canReplaceCp(all, baseIdx, comp.codePointAt(0)!);
    const r = evalSeq(all, base + comp + to);
    if (!sol || !r.ok) { bad(`${base}${comp}${to}：乾跑=${sol}、替換=${r.ok ? "成功" : r.error}`); continue; }
    const m = /誤差 ([\d.]+)/.exec(r.log.join("；"));
    const err = m ? Number(m[1]) : NaN;
    err <= maxErr
      ? ok(`${base} 的 ${comp} → ${to}：${r.log.join("；")}`)
      : bad(`${base} 的 ${comp}：誤差 ${err} 超過預期 ${maxErr}`);

    /* 幾何：**被拔掉的那幾筆以外，每一筆都要逐欄一模一樣**（一個座標都不能動），
       而且新內容的框要落在被拔掉那幾筆的位置上。 */
    const target = r.targetIdx!;
    /* 改寫過的節點＝筆畫內容變了的那一層（`麥`／`𠬝`…），沿引用樹找 */
    let nodeIdx = -1;
    let before: (typeof r.lib.glyphs)[number] | undefined;
    {
      const stack = [target], seen = new Set<number>();
      while (stack.length) {
        const i = stack.pop()!;
        if (seen.has(i)) continue;
        seen.add(i);
        const b = all.glyphs[i]!;
        const a = r.lib.glyphs[i]!;
        if (b && JSON.stringify(a.strokes) !== JSON.stringify(b.strokes)) { nodeIdx = i; before = b; break; }
        for (const s of a.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
      }
    }
    if (nodeIdx < 0 || !before) { bad(`${base}：找不到被改寫的節點`); continue; }
    const after = r.lib.glyphs[nodeIdx]!;
    const kept = after.strokes.slice(0, after.strokes.length - 1);
    const newRef = after.strokes[after.strokes.length - 1]!;
    const droppedIdx: number[] = [];
    let bi2 = 0, subseq = true;
    for (const s of kept) {
      const key = JSON.stringify(s);
      while (bi2 < before.strokes.length && JSON.stringify(before.strokes[bi2]) !== key) droppedIdx.push(bi2++);
      if (bi2 >= before.strokes.length) { subseq = false; break; }
      bi2++;
    }
    while (bi2 < before.strokes.length) droppedIdx.push(bi2++);
    const keptBox = (() => {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const k of droppedIdx) {
        const s = before!.strokes[k]!;
        const n = ptCountOf(s.kind);
        for (let q = 0; q < n; q++) {
          x1 = Math.min(x1, s.points[q * 2]!); x2 = Math.max(x2, s.points[q * 2]!);
          y1 = Math.min(y1, s.points[q * 2 + 1]!); y2 = Math.max(y2, s.points[q * 2 + 1]!);
        }
      }
      return [x1, y1, x2, y2];
    })();
    const box = newRef.box as number[] | undefined;
    const near = box && Number.isFinite(keptBox[0]) &&
      Math.abs((box[0]! + box[2]!) / 2 - (keptBox[0]! + keptBox[2]!) / 2) < 45 &&
      Math.abs((box[1]! + box[3]!) / 2 - (keptBox[1]! + keptBox[3]!) / 2) < 45;
    subseq && newRef.kind === 99 && droppedIdx.length > 0
      ? ok(`  ${base} 的 ${comp}：其餘 ${kept.length} 筆**逐欄相同**、只拔掉 ${droppedIdx.length} 筆並補一筆引用` +
           `（底下的殘筆完全沒動）`)
      : bad(`  ${base} 的 ${comp}：其餘筆畫被動到了（子序列=${subseq}、拔掉 ${droppedIdx.length} 筆、末筆 kind=${newRef.kind}）`);
    near
      ? ok(`  新內容的框 [${box?.map((v) => Math.round(v)).join(",")}] 落在被拔掉那幾筆的位置` +
           `（原筆畫外框 [${keptBox.map((v) => Math.round(v)).join(",")}]）`)
      : bad(`  新內容的框 [${box?.map((v) => Math.round(v)).join(",")}] 離原筆畫 [${keptBox.map((v) => Math.round(v)).join(",")}] 太遠`);
  }
}

console.log(fail === 0 ? "\n全部通過" : `\n有 ${fail} 項失敗`);
process.exit(fail === 0 ? 0 : 1);

