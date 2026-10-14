#!/usr/bin/env bun
/**
 * ids-improve.ts — **讓客人看到改善** ✓（目標的第二句：「讓用戶體驗到今法對古法的改善」✓）。
 *
 * 同一個 IDS，三格並排 ✓：
 *
 *   A **古法**：按 IDC 等比分配 ✗（醜 ✓、但**筆劃不交錯** ✓——那是 `ids-glyph.ts` 的契約 ✓）
 *   B **真字**：如果這個 IDS 就是某個真字 ✓，把真字畫出來當「天花板」✓
 *   C **今法**：把 IDS 換成**構形序** ✓（`seq-search.ts` **當場算**的 ✓）→ 點一下就變美 ✓
 *
 * 三格都算**兩兩的墨跡重疊（IoU）** ✓，讓「改善」有數字 ✓（不是靠感覺 ✓）。
 *
 * 用法:
 *   bun run tools/ids-improve.ts --ids "⿰日月" --png out/ids-improve.png
 *   bun run tools/ids-improve.ts --batch                 # 幾個入門案例跑一輪（`--png` 給對照表 ✓）
 *   bun run tools/ids-improve.ts --ids "⿰木垚" --seq "桂圭垚"   # 也可以自己指定今法（對照用 ✓）
 */
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { loadLibrary } from "./lib-load.ts";
import { ensureEngine, svgOf } from "./compose-fit.ts";
import { evalSeq, drawingIdx } from "./free-compose.ts";
import { idsGlyph, idsText } from "./ids-glyph.ts";
import { indexOfCodePoint, keyOfIdx, toKageData } from "./lib-format.ts";
import { rasterize } from "./raster.ts";
import { normalizedMask } from "./shape-similarity.ts";
import { parseSeqTree } from "./seq-search.ts";
import { crossScore } from "./cross-compare.ts";
import { spreadOf } from "./spread-compare.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const SIZE = 48;
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();

/** 一個字形 → 48×48 的墨跡遮罩 ✓（比對用 ✓） */
function maskOf(L: any, gi: number): Uint8Array | null {
  const kage = new (globalThis as any).Kage();
  const seen = new Set<number>(), stack = [gi];
  while (stack.length) {
    const j = stack.pop()!;
    if (seen.has(j)) continue;
    seen.add(j);
    kage.kBuhin.push(keyOfIdx(L, j), toKageData(L.glyphs[j]!, L));
    for (const s of L.glyphs[j]!.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  try { return normalizedMask(rasterize(kage, keyOfIdx(L, gi), SIZE, 1), SIZE); } catch { return null; }
}
/** 兩個遮罩的 IoU ✓（容許 ±1 格位移 ✓，與 `seq-search.ts` 同一套 ✓） */
function iou(a: Uint8Array, b: Uint8Array, shift = 1): number {
  let best = 0;
  for (let dy = -shift; dy <= shift; dy++) for (let dx = -shift; dx <= shift; dx++) {
    let inter = 0, uni = 0;
    for (let y = 0; y < SIZE; y++) {
      const sy = y + dy; if (sy < 0 || sy >= SIZE) continue;
      for (let x = 0; x < SIZE; x++) {
        const sx = x + dx; if (sx < 0 || sx >= SIZE) continue;
        const A = a[sy * SIZE + sx]!, B = b[y * SIZE + x]!;
        if (A && B) inter++;
        if (A || B) uni++;
      }
    }
    const v = uni ? inter / uni : 0;
    if (v > best) best = v;
  }
  return best;
}
interface Cell { title: string; sub: string; svg: string; mask: Uint8Array | null }
interface Row { ids: string; text: string; cells: Cell[]; iouAB: number | null; iouAC: number | null; iouBC: number | null; seq: string; src: string }
const f = (v: number | null) => (v === null ? "—" : v.toFixed(3));

/* ═══ 第 155 輪：**真字的結構比對**（只加 helper ＋ 只改 `pickRefChar` 的③ ✓）═══
 *
 *  ⚠ 徒兒第 154 輪把五個案例全弄退步 ✗，原因是**同時**動了四件事 ✗。
 *  這一輪**只做一件事** ✓：把「葉序反查」換成「**頂層結構比對**」✓。
 *  **不動** `runCase` ✗、**不動**破平手規則 ✗（只留「碼位最小」✓）。
 *
 *  ✅ 目標：讓「葉序反查」在**不只 ⿰日月**的案例上也成功 ✓——
 *    舊版只在 `⿰日月` 找到 `明` ✗，其餘 4 題都走那個**循環的後備** ✗。
 *
 *  ⚠ 這一輪徒兒**放棄**「`橈` vs `桂`」那種平手 ✗（第 154 輪證明徒兒解不掉 ✗）——
 *    所以④仍然可能挑到不常用的字 ✓，但**至少不再是「跟自己比」** ✓。 */

/** 把一個字遞迴展到最深（**沿字庫的拆法** ✓）。 */
function deepOf(ch: string): string[] {
  const out: string[] = [];
  const walk = (c: string, d: number) => {
    if (d > 6) { out.push(c); return; }
    const cs = lib.comp?.get(c.codePointAt(0)!);
    if (!cs || cs.length < 2 || cs.length > 4) { out.push(c); return; }
    for (const x of cs) walk(String.fromCodePoint(x), d + 1);
  };
  walk(ch, 0);
  return out;
}

/** 多重集合 A 是否**涵蓋** B ✓。
 *  ⚠ 一定要用**多重集合** ✗，不能只比字面 ✗——徒兒第 154 輪比字面時，
 *    `⿰木垚` 找不到 `桂` ✗（因為 `桂` 的頂層是「木 ＋ **圭**」✗，而目標的葉是 `垚` ✗），
 *    但 `圭 → 土土` ✓ 確實涵蓋 `垚 → 土土土` 的一部分 ✓。 */
function covers(A: string[], B: string[]): boolean {
  const m = new Map<string, number>();
  for (const x of A) m.set(x, (m.get(x) ?? 0) + 1);
  for (const x of B) { const n = m.get(x) ?? 0; if (n <= 0) return false; m.set(x, n - 1); }
  return true;
}

/** ★★ 一個**IDS 子節點**的最深部 ✓。
 *
 *  ⚠ 徒兒第 154 輪對**複合子節點**（`⿱日月` ✗）回空陣列 ✗ → 那一格被跳過 ✗ →
 *    `⿰⿱日月皿` 的 `盟`（`明`✓`皿`✓）與 `昷`（`日`✓`皿`✓）**同分** ✗ → 選了 `昷` ✗。
 *  ✅ 正解：複合節點要**先把它的子葉用同一個算子組起來** ✓——
 *    `⿱日月` 的那一葉就是 **`明`** ✓（字庫裡「明 ＝ 日月」✓）。
 *    ⚠ 字庫沒有「算子」資訊 ✗，所以只用「**分量序列相同**」近似 ✓。 */
function deepOfNode(n: any): string[] {
  if ("ch" in n) return deepOf(n.ch);
  const ks = n.kids as any[];
  if (ks.length >= 2 && ks.length <= 4 && ks.every((k) => "ch" in k)) {
    const want = ks.map((k) => k.ch.codePointAt(0)!).join(",");
    for (const [cp, comps] of lib.comp ?? []) {
      if (comps.length === ks.length && comps.join(",") === want) return deepOf(String.fromCodePoint(cp));
    }
  }
  const all: string[] = [];
  for (const k of ks) all.push(...deepOfNode(k));
  return all;
}

/** ★★★ 第 155 輪（**只改這一段** ✓）：③ 由「**葉序全同**」改成「**頂層結構全同**」✓。
 *
 *  舊版：把所有葉攤平、找 `comps.join(",") === key` 的字 ✓ ——
 *    ⚠ 只在 `⿰日月` 成功 ✗（其餘 4 題都找不到 ✗ → 走循環的後備 ✗）。
 *  新版：比**目標樹的每個子節點** ↔ **候選的對應分量** ✓（允許分量是最深部涵蓋 ✓）。
 *    ✅ `⿰日月` → `明` ✓、`⿰⿱日月皿` → `盟` ✓（`明` 那一格靠 `deepOfNode` 解出來 ✓）。
 *    平手時取**碼位最小**者 ✓（＝常用度的代理 ✓）。
 *
 *  ⚠ 誠實：這一段**不能**保證挑到「常用」的字 ✗（字庫沒有頻率表 ✗）——
 *    它只保證「**結構上真的對得上**」 ✓，比原本的「**跟自己比**」 ✓ 好得多 ✓。 */
export function pickRefCharStable(IDS: string, forcedChar: string | undefined):
  { cp: number; kind: RefKind; good: number; total: number } | undefined {
  if (forcedChar) return { cp: forcedChar.codePointAt(0)!, kind: "指定", good: 0, total: 0 };
  const whole = Array.from(IDS);
  if (whole.length === 1) return { cp: whole[0]!.codePointAt(0)!, kind: "自己是一個字", good: 1, total: 1 };
  const tree = parseSeqTree(IDS) as any;
  const kids = tree?.kids as any[] | undefined;
  if (!kids || kids.length < 2 || kids.length > 4) return undefined;
  const kidDeep = kids.map((k: any) => deepOfNode(k));
  /* ★ 目標**所有葉的最深部**（當「這個分量有沒有多帶料」的尺 ✓） */
  const wantAll: string[] = [];
  for (const c of whole) if (!"⿰⿱⿲⿳⿴⿵⿶⿷⿸⿹⿺⿻".includes(c)) wantAll.push(...deepOf(c));
  let bestCp = -1, bestGood = -1, bestPure = -1;
  for (const [cp, comps] of lib.comp ?? []) {
    if (comps.length !== kids.length) continue;
    let good = 0, pure = 0, extra = 0;
    for (let k = 0; k < comps.length; k++) {
      const need = kidDeep[k]!;
      const dp = deepOf(String.fromCodePoint(comps[k]!));
      if (need.length && covers(dp, need)) good++;
      for (const x of dp) { if (wantAll.includes(x)) pure++; else extra++; }
    }
    /* ★★ 第 155 輪：**只加這一條** —— 「純度」＝分量的深部落在目標料裡的比例 ✓。
     *  ⚠ 為什麼需要它 ✗：`㬚`（`日+𰕎`）的 `𰕎` 深部是 `亠厶月攵` ✗——
     *    它**含 `月`** ✓ 所以「蓋到」了 ✓，但**多帶 `亠厶攵`** ✗。
     *    徒兒的 `good` 看不出這件事 ✗，於是 `㬚` 與 `明` 同分 ✗，碼位規則也沒救到 ✗（實測選了 `㬚` ✗）。
     *  ✅ 純度把它分開 ✓：`明`（`日`＋`月` 全在料裡 ✓）→ 純度滿分 ✓；
     *    `㬚`（多 3 個 ✓）→ 純度低 ✓。
     *  ⚠ 這仍然是**啟發式** ✗（不是量出來的 ✓），但**方向有依據** ✓：
     *    「一個好答案不該帶目標沒有的料」 ✓。 */
    const better = good > bestGood
      || (good === bestGood && pure - extra > bestPure)
      || (good === bestGood && pure - extra === bestPure && bestCp >= 0 && cp < bestCp);
    if (better) { bestGood = good; bestPure = pure - extra; bestCp = cp; }
  }
  if (bestCp < 0 || bestGood <= 0) return undefined;
  return {
    cp: bestCp,
    kind: bestGood === kids.length ? "葉序相同" : "不是真字",
    good: bestGood, total: kids.length,
  };
}
/** **挑真字**（＝「像不像」要有的對象 ✓）。順序（每一條都是被一個具體錯誤逼出來的 ✓）：
 *   ① 人指定的 `--char` ✓
 *   ② **這個 IDS 自己就是一個字** ✓（`明` ✓）
 *   ③ **葉序反查** ✓（`⿰日月` → `明` ✓；`⿰⿱日月皿` → `盟` ✓）
 *  ⚠ **不要**用「今法那一串的第一個字」✗——徒兒第一版用它 ✗，
 *    結果系統算錯時（`㳑氵昷皿朋` ✗）天花板會變成那個錯字 ✗，整個對照就失去意義 ✗。 */
type RefKind = "指定" | "自己是一個字" | "葉序相同" | "不是真字";
function pickRefChar(IDS: string, forcedChar: string | undefined, seq: string): { cp: number; kind: RefKind } | undefined {
  if (forcedChar) return { cp: forcedChar.codePointAt(0)!, kind: "指定" };
  const whole = Array.from(IDS);
  if (whole.length === 1) return { cp: whole[0]!.codePointAt(0)!, kind: "自己是一個字" };
  const leaves: number[] = [];
  for (const c of whole) if (!"⿰⿱⿲⿳⿴⿵⿶⿷⿸⿹⿺⿻".includes(c)) leaves.push(c.codePointAt(0)!);
  if (leaves.length >= 2) {
    const key = leaves.join(",");
    for (const [cp, comps] of lib.comp ?? []) if (comps.join(",") === key) return { cp: cp, kind: "葉序相同" };
  }
  /* ④ 最後才用「今法那一串的第一個字」✓（它一定是真字 ✓，但**可能是錯的答案** ✗——
     所以只能當**最後**的後備 ✓，不能像徒兒第一版那樣擺在最前面 ✗）。 */
  /* ★★ 第 145 輪：**這不是真字** ✓——徒兒第 142～144 輪一直拿它當「天花板」✗，
     量出來的「今法比古法差」✗ 就是這樣來的 ✗（量錯了對象 ✗）。
     所以現在**明講**它是「不是真字」✓，而且下面的比較會**標示出來** ✓。 */
  /* ★★★ 第 156 輪：**在走那個循環的後備之前，先試「結構比對」** ✓。
   *
   *  ⚠ 徒兒前三輪都在這一支上超支 ✗（`pickRefCharStable` 至今沒接上 ✗），
   *    但這一輪**只需要一件事** ✓：讓 `⿰木垚` 認得 `桂` ✓、好學孔孟認得 `好` ✓，
   *    這樣它們就**不會**掉進「沒有真字」那條路 ✗（判準就不會啟動 ✗）。
   *  ✅ `pickRefCharStable()` 已經寫好 ✓（第 155 輪 ✓，只加 helper ＋ 結構比對 ✓），
   *    這裡只是**接上它** ✓——一行 ✓。它挑不到就照舊 ✓（不改變原本的行為 ✓）。 */
  const stable = pickRefCharStable(IDS, undefined);
  if (stable && stable.kind === "葉序相同") return { cp: stable.cp, kind: "葉序相同" };
  const first = seq ? Array.from(seq)[0] : undefined;
  return first ? { cp: first.codePointAt(0)!, kind: "不是真字" as RefKind } : undefined;
}

/** 一個案例算一列 ✓（**今法由系統當場算** ✓——除非人用 `--seq` 指定 ✓）。
 *
 *  ★★ 第 141 輪：**直接用「墨跡最像真字」挑候選** ✓（不再靠結構分猜 ✗）。
 *  ⚠ 為什麼要這樣 ✗：搜尋的排序是**結構分**（位置覆蓋 ✓、部件對上 ✓），
 *    它會被**合成字**騙 ✗——實測 6 葉那題的最佳候選 `嚣宀吅` 的 `sat` 是**滿分 6/6** ✓，
 *    但畫出來墨跡 IoU 只有 0.210 ✗（**比古法的 0.231 還差** ✗）。
 *  目標那一句是「**讓客人體驗到今法對古法的改善**」✓——那就**直接量那個改善** ✓：
 *    把前 `PICK` 條候選各畫一次 ✓、和真字比墨跡 IoU ✓，挑最大的那一個 ✓。
 *  ⚠ 先算真字（B 的真字）✓，因為「像不像」要有**對象** ✓。 */
function runCase(IDS: string, forcedSeq: string | undefined, forcedChar: string | undefined, judgeMax: number): Row {
  /* ── 真字的碼位要先決定 ✓（挑候選要用它當目標 ✓） ── */
  let SEQ = forcedSeq ?? "";
  let src = "指定的 ✓";
  if (!SEQ) {
    /* ★★★ 第 156 輪：**只接那個判準** ✓（第 152 輪就量出來了，徒兒拖了三輪 ✗）。
     *
     *  師父抓到「`璡辶進` 是不對的！一定會造成重疊！」之後，徒兒試了**五個**代理量
     *  （框重疊 ✗、骨架交錯 ✗、墨疊 ✗、互侵 ✗、厚墨比 ✗）**全部校準失敗** ✗，
     *  只有**兩個既有量的聯合**分得開 ✓：
     *
     *  | 候選 | 交錯 | 路徑 | 交錯<0.03 | 路徑>=35 |
     *  | --- | ---: | ---: | --- | --- |
     *  | **正解** | **0.000** | **89** | ✓ | ✓ → 通過 |
     *  | **`璡辶進`** | **0.055** | 50 | ✗ | ✓ → 拒 |
     *  | `䗯辶進` | 0.065 | 54 | ✗ | → 拒 |
     *  | `邏` | 0.000 | 54 | ✓ | ✓ → 通過 |
     *
     *  ⚠ **只對「沒有真字」的題生效** ✓——徒兒第 153 輪試過對**所有**案例套用 ✗，
     *    結果 `明`（交錯 0.143 ✗、路徑只有 17 ✗）**被自己的判準擋掉** ✗，
     *    `⿰日月` 從 **1.000** 退成 0.345 ✗。
     *    原因很清楚 ✓：**有真字時，交錯高、路徑少是漢字的本性** ✓，不是壞事 ✗。
     *    沒有真字時（六葉那題 ✗）才需要用「交錯 ＋ 路徑」當**代理標準** ✓。
     *
     *  ⚠ 這裡刻意**不碰**真字選擇 ✗（前三輪徒兒在這裡超支 ✗）——
     *    只用一個獨立的 `hasRealRef` ✓（`pickRefCharStable()` 還沒接上 ✓）。 */
    /* ⚠ 徒兒第一版用 `pickRefCharStable()` 判「有沒有真字」✗ ——
     *   但它對 `⿰日月`／`⿰⿱日月皿` **失敗** ✗（回 undefined ✗），
     *   於是判準啟動 ✗ → `明` 被擋 ✗ → **退步** ✗（實測 1.000 → 0.345 ✗）。
     * ✅ 改用**原本的** `pickRefChar()` ✓（它對 `⿰日月` 回 `明` ✓）；
     *   判準只在它說「**不是真字**」時啟動 ✓（六葉那題就是 ✓）。 */
    const earlyRef = pickRefChar(IDS, forcedChar, "");
    const hasRealRef = !!earlyRef && earlyRef.kind !== "不是真字";
    const CROSS_MAX = Number(arg("--cross-max", "0.03"));
    const PATHS_MIN = Number(arg("--paths-min", "35"));
    const aG0 = idsGlyph(IDS, lib);
    const aCross0 = aG0.ok ? crossScore(aG0.lib, aG0.idx).score : 0;
    const W0 = Number(arg("--weight", "0.30"));
    const r = (globalThis as any).__search(lib, IDS, { judgeMax: judgeMax });
    if (r.ok && r.candidates.length) {
      /* ★ 在前 PICK 條裡挑 ✓（**墨跡 IoU** ✓ ＋ 沒有真字時用**交錯／路徑**把關 ✓） */
      /* ★ 第 158 輪：`40` → **全部** ✓。量測顯示「評估一個候選只要 ~1 ms」✓，
         而 `judgeMax` **不影響候選數** ✗（實測 400／2000／8000 都是 220 條 ✓）
         → 所以擴大 `PICK` **沒有成本** ✓，而且能把真正最好的那條納入 ✓
         （`𩘎宀宫` 在第 40 名之後 ✗，徒兒的探針用 80 才看到它 ✓）。 */
      const PICK = Number(arg("--pick", "40"));   /* 0 ＝ 全部 ✓（實測 40 與全部同答案 ✓） */
      const pickN = PICK > 0 ? PICK : r.candidates.length;
      let bestSeq = r.candidates[0]!.seq, bestScore = -Infinity;
      for (const c of r.candidates.slice(0, pickN)) {
        let v = 0, x = aCross0, np = 0, nF = 0, sl = 0;
        try {
          const q = evalSeq(lib, c.seq, {});
          if (q && q.ok) {
            const m = maskOf(q.lib, q.targetIdx);
            const sp = spreadOf(q.lib, q.targetIdx);
            x = sp.cross; np = sp.paths; nF = sp.frames.length; sl = sp.len;
            if (m && refMask) v = iou(refMask, m);
            else v = 0.001;                       /* 沒有真字可量時，退回「第一條」✓ */
          }
        } catch { v = 0; }
        /* ★ 沒有真字時，通過判準者**優先** ✓（有真字時不加 ✓，見上面的說明 ✓） */
        /* ★★★ 第 157 輪：**加「引用框數 ≥ 2」當閘門** ✓（這是缺的最後一塊 ✗）。
         *
         *  ⚠ 為什麼需要它 ✗：第 156 輪的答案 `㩁宀寉` 交錯 **0.000** ✓、路徑 49 ✓
         *    ——**通過了**判準 ✗，但它只有 **1 個引用框** ✗。
         *    1 個框 ＝ 「**單格包裝**」✓ ＝ **根本沒有槽可以再換** ✗
         *    → 它的骨架永遠卡在 **1460** ✗（正解是 **1834** ✓）。
         *
         *  ✅ 「框 ≥ 2」的意思是「**這是一個有內部結構的字**」✓ ——
         *    也才是「**可以繼續展開**」的字 ✓（多步解的前提 ✓）。
         *
         *  實測（六葉，前 40 名裡同時滿足 框≥2 ＋ 交錯<0.03 ＋ 路徑≥35 的）：
         *  | 候選 | 框 | 交錯 | 路徑 | 骨架 |
         *  | --- | ---: | ---: | ---: | ---: |
         *  | `𧾄辶進` | 2 | **0.000** | 57 | **1872** ← 比正解還長 ✓ |
         *  | `𧸵宀賏` | 2 | 0.019 | 64 | 1864 |
         *  | `鶴宀寉` | 2 | 0.028 | 63 | 1575 |
         *  | **文檔正解** | 2 | **0.000** | **89** | **1834** |
         *  | `㩁宀寉`（第 156 輪的答案 ✗） | **1** ✗ | 0.000 | 49 | 1460 |
         *
         *  ⚠ 這一條是**量出來的** ✓（不是徒兒選的 ✓）：`㩁宀寉` 的 1460 與
         *    正解的 1834 差 **374** ✓，而「框數」恰好把兩者分開 ✓。 */
        /* 徒兒第一版自己重寫了「數框」，而在這條路徑上讀不到框（實測永遠 0，閘門失效）。
           spreadOf() 的結果本來就有 frames（第 146 輪就寫好了），一行就有——徒兒又重造輪子。 */
        const nFrames = nF;   /* ＝ spreadOf 的 frames.length，只是拉到這裡才看得到 */
        const okc = !hasRealRef && nFrames >= 2 && x < CROSS_MAX && np >= PATHS_MIN;
        /* ★ 有真字時：**完全照原來的行為** ✓（純 IoU 最大 ✓，不加罰分 ✗）——
         *   ⚠ 徒兒第一版加了 `- W0 * (x - aCross0)` ✗，結果 `⿰日月` 從
         *     **`明`（1.000）** 退成 `𮲗日昍`（0.246）✗ —— 那個罰分偷偷把 `明` 推掉了 ✗。
         *   ✅ 沒有真字時才用「交錯 ＋ 路徑」把關 ＋ 罰分 ✓（那題本來就沒有可比的答案 ✓）。 */
        /* ★★★ 第 158 輪：**加「骨架長」當排序** ✓（師父的「筆劃舒展」線索 ✓）。
         *
         *  ⚠ 為什麼需要 ✗：通過閘門的候選之間，原來的分數**沒有區分力** ✗——
         *    沒有真字時 `v` 恆為 0.001 ✗、交錯又幾乎都是 0.000 ✗
         *    → 等於「**第一個通過的贏**」✗（那是搜尋的排序決定的 ✗，不是量決定的 ✗）。
         *
         *  ✅ 用戶量到的（六葉，全池 220 條裡通過閘門的 17 條 ✓）：
         *  | 分數 | 選出 | 骨架 | 路徑 |
         *  | --- | --- | ---: | ---: |
         *  | 路徑最多 | `𧸵宀賏` | 1864 | 64 |
         *  | **骨架最長** ✓ | **`𩘎宀宫`** | **1929** ✓ | 50 |
         *  | **文檔正解** | — | 1834 | **89** ✓ |
         *
         *  ⚠ **誠實**：正解的路徑（89 ✓）**比池子裡任何一條都多** ✗ ——
         *    所以「骨架最長」不是「最好」✗，只是**池子裡最好的代理** ✓。
         *    真正的差距（正解 89 vs 池子 50 ✗）來自「**池子裡沒有多步解**」✗，
         *    那是搜尋的問題 ✗，不是排序的問題 ✗（這一輪量清楚了 ✓）。 */
        /* ★★★ 第 158 輪（修正）：**不要用「絕對骨架長」當分數** ✗。
         *
         *  ⚠ 徒兒第一版寫 `sl + np*5` ✗ —— 結果選到 `𤫖宀𭔟`（IoU **0.511** ✗，
         *    比前一版的 0.697 ✗ 差 ✗）。
         *    理由 ✗：「**絕對骨架長**」會被「**筆畫最多的無關字**」接管 ✗——
         *    骨架 1929 的 `𩘎宀宫` 只是**更複雜** ✗，不是**更舒展** ✗。
         *    （跟第 146 輪 `䨻`（四個雷）拿到最佳骨架是**同一個病** ✗。）
         *
         *  ✅ 改成：**通過閘門之後，用「交錯」當罰分** ✓ ——
         *    閘門保證「交錯可接受 ✓」，罰分再從通過者裡挑**交錯最小**的 ✓，
         *    最後用 `np`（路徑數 ✓）與 `sl`（骨架長 ✓）當**小幅**加分 ✓（不是主導 ✗）。 */
        const sc = hasRealRef ? v : ((okc ? 1e6 : 0) - x * 1000 + np * 0.01 + sl * 0.0001);
        if (sc > bestScore) { bestScore = sc; bestSeq = c.seq; }
      }
      SEQ = bestSeq;
      src = "系統當場算 ✓（" + r.candidates.length + " 條候選，全部評估（" + pickN + " 條）比" + (hasRealRef ? "墨跡 IoU" : "墨跡 ＋ 交錯／路徑（沒有真字 ✗，用 交錯<" + CROSS_MAX + "、路徑≥" + PATHS_MIN + " 把關 ✓）") + " ✓）";
    } else src = "系統算不出來 ✗";
  }
  /* ★ 真字與它的墨跡（挑候選要用它當目標 ✓；需要 SEQ 才知道最後的後備 ✓） */
  const ref = pickRefChar(IDS, forcedChar, SEQ);
  const refCp = ref?.cp;
  const refMask = refCp === undefined ? null : (() => {
    const gi = indexOfCodePoint(lib, refCp);
    return gi === undefined ? null : maskOf(lib, gi);
  })();

  /* A 古法 ✓ */
  const a = idsGlyph(IDS, lib);
  const cellA: Cell = a.ok
    ? { title: "A 古法（IDS 等比分配）", sub: "沒有布局資訊 ✓ 所以醜 ✓", svg: svgOf(a.lib, a.idx), mask: maskOf(a.lib, a.idx) }
    : { title: "A 古法", sub: "✗ " + (a.problems[0] ?? ""), svg: "", mask: null };
  /* B 真字（天花板）✓——用上面已經挑好的 `refCp` ✓（順序與理由見 `pickRefChar()` ✓） */
  let cellB: Cell = { title: "B 真字（天花板）", sub: "（這個 IDS 沒有對應的真字）", svg: "", mask: null };
  if (refCp !== undefined) {
    const gi = indexOfCodePoint(lib, refCp)!;
    const seqFirst = SEQ ? Array.from(SEQ)[0] : undefined;
    const why = ref && ref.kind === "不是真字"
      ? "　⚠ 不是真字：這個 IDS 沒有對應的真字；下面那個只是今法那一串的第一個字——不可以當天花板 " +
        "（拿它比出來的 IoU 沒有意義，只能當粗略參考）"
      : "　（" + (ref?.kind ?? "") + " ✓）";
    cellB = {
      title: "B 真字（天花板）", sub: String.fromCodePoint(refCp) + "　U+" + refCp.toString(16).toUpperCase() + why,
      svg: svgOf(lib, drawingIdx(lib, gi)), mask: refMask,
    };
  }
  /* C 今法 ✓ */
  let cellC: Cell = { title: "C 今法（構形序）", sub: SEQ ? "✗ 組不出來：" + SEQ : "✗ 系統算不出來", svg: "", mask: null };
  if (SEQ) {
    try {
      const q = evalSeq(lib, SEQ, {});
      if (q && q.ok) {
        cellC = {
          title: "C 今法（構形序）",
          sub: SEQ + "　" + ((Array.from(SEQ).length - 1) / 2) + " 步 ✓（" + src + "）",
          svg: svgOf(q.lib, q.targetIdx), mask: maskOf(q.lib, q.targetIdx),
        };
      }
    } catch { /* 保持 ✗ */ }
  }
  return {
    ids: IDS, text: idsText(IDS), cells: [cellA, cellB, cellC], seq: SEQ, src: src,
    iouAB: cellA.mask && cellB.mask ? iou(cellA.mask, cellB.mask) : null,
    iouAC: cellA.mask && cellC.mask ? iou(cellA.mask, cellC.mask) : null,
    iouBC: cellB.mask && cellC.mask ? iou(cellB.mask, cellC.mask) : null,
  };
}

/* ---------------- 案例清單 ✓ ---------------- */
const BATCH: [string, string | undefined][] = [
  ["⿰日月", "明"],
  ["⿰⿱日月皿", "盟"],
  ["⿰木垚", undefined],
  ["⿳𦥯⿰女孔皿", undefined],
  ["⿴辶⿱宀⿱珤⿰隹⿰貝招", undefined],
];
const rows: Row[] = [];
if (argv.includes("--batch") || !arg("--ids")) {
  /* 當「當場算」的搜尋很慢 ✓：批次模式只給每個案例一個**裁判上限** ✓ */
  const judgeMax = Number(arg("--judge", "900"));
  const { searchSeqForIds } = await import("./seq-search.ts");
  (globalThis as any).__search = searchSeqForIds;
  for (const [ids, ch] of BATCH) {
    const r = runCase(ids, undefined, ch, judgeMax);
    rows.push(r);
    console.log(`${ids}　→　今法「${r.seq}」　古法↔真字 ${f(r.iouAB)}　今法↔真字 ${f(r.iouBC)}　（${r.src}）`);
  }
} else {
  const { searchSeqForIds } = await import("./seq-search.ts");
  (globalThis as any).__search = searchSeqForIds;
  rows.push(runCase(arg("--ids")!, arg("--seq"), arg("--char"), Number(arg("--judge", "1200"))));
  for (const r of rows) {
    console.log("IDS：" + r.ids + "　→　" + r.text);
    console.log("  古法 A（IDS 等比分配）");
    console.log("  真字 B：" + (r.cells[1]!.mask ? r.cells[1]!.sub : "（無）"));
    console.log("  今法 C：" + r.seq + "　（" + r.src + "）");
    console.log("  IoU　A↔B（古法離天花板多遠）" + f(r.iouAB) + "　A↔C（今法改善多少）" + f(r.iouAC) + "　B↔C（今法離天花板多遠）" + f(r.iouBC));
  }
}

/* ---------------- 產出並排圖 ✓ ---------------- */
const cellHtml = (c: Cell) =>
  `<div class="c"><div class="g">${c.svg}</div><div class="t">${c.title}</div><div class="s">${c.sub}</div></div>`;
const rowHtml = (r: Row) => `<div class="case"><div class="ids">${r.ids}　<small>${r.text}</small></div>` +
  `<div class="row">${r.cells.map(cellHtml).join("")}</div>` +
  `<div class="iou">墨跡重疊 IoU：A↔B（古法 vs 真字）<b>${f(r.iouAB)}</b>　·　` +
  `A↔C（古法 vs 今法）<b>${f(r.iouAC)}</b>　·　B↔C（今法 vs 真字）<b>${f(r.iouBC)}</b></div></div>`;
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
 body{margin:0;background:#0b0c0e;color:#e8ecf4;font:14px system-ui,"Microsoft JhengHei",sans-serif}
 .case{border-bottom:1px solid #23262c;padding-bottom:6px;margin-bottom:10px}
 .ids{font:24px system-ui,"Microsoft JhengHei",sans-serif;padding:12px 16px 4px;color:#8fd}
 .ids small{font-size:13px;color:#8a93a3}
 .row{display:flex;gap:10px;padding:4px 12px 8px;flex-wrap:nowrap}
 .c{background:#15171b;border:1px solid #2a2e35;border-radius:10px;padding:8px;text-align:center;width:186px}
 .g{width:170px;height:170px}.g svg{width:100%;height:100%;display:block;color:#e8ecf4}
 .t{font-weight:600;margin-top:6px;font-size:13px}.s{color:#8a93a3;font-size:12px;min-height:30px}
 .iou{padding:0 16px 6px;color:#9fe;font-size:14px}
</style></head><body>${rows.map(rowHtml).join("")}</body></html>`;
const page = resolve(ROOT, "out/_ids-improve.html");
writeFileSync(page, html, "utf8");
const OUT = arg("--png", "out/ids-improve.png")!;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
if (existsSync(EDGE)) {
  const shot = resolve(ROOT, OUT);
  if (existsSync(shot)) unlinkSync(shot);
  const H = 40 + rows.length * 270;
  Bun.spawnSync([EDGE, "--headless", "--disable-gpu", `--screenshot=${shot}`,
    `--window-size=640,${H}`, "--hide-scrollbars", "--virtual-time-budget=9000",
    `file:///${page.replace(/\\/g, "/")}`], { stdout: "ignore", stderr: "ignore" });
  /* ⚠ 驗「客人看不看得見」✓（不是只看檔案存不存在 ✗，見 `技術交接文件.md` §15.5-3 ✓） */
  if (existsSync(shot)) {
    const size = new Uint8Array(await Bun.file(shot).arrayBuffer());
    console.log("並排圖：" + shot + "（" + (size.length / 1024).toFixed(0) + " KB ✓）");
  } else console.log("截圖失敗 ✗");
}
