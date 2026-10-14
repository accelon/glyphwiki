/**
 * ink-conflict.ts — **「墨都搞一塊」的判準**（師父第 112 輪指出的問題 ✗）。
 *
 * 師父原話：
 * > 「警告客人，不能組「庚广廣」，**墨都搞一塊去了**。「庚广厂」是可行的。」
 *
 * 我原本的建議只驗「引擎換得動」（`canReplaceCp` ✓）——**沒驗換完能不能看** ✗。
 *
 * ## 判準：遮蓋率
 *
 * **新部件的墨，蓋掉「其餘筆劃」的墨多少**（用點陣的墨格數算 ✓）：
 *
 * | 案例 | 遮蓋率 | 師父的判 |
 * |---|---|---|
 * | `庚广廣` | **38.0%** | 不行 ✗（廣壓在庚的內筆劃上） |
 * | `庚广艹` | **27.6%** | 目前還組不好 ✗ |
 * | `唐广廣` | **44.4%** | 不行 ✗ |
 * | `庚广厂` | 0.2% | 可行 ✓ |
 * | `利刂刀` | 0.0% | 目標答案 ✓ |
 * | `打丁白`→`拍` | 1.9% | ✓ |
 * | `盟皿月` | 0.6% | ✓ |
 * | `漢氵木` | 0.1% | ✓ |
 *
 * **門檻 20%**：兩邊差了一個數量級 ✓（✗ 27.6～44.4%／✓ 0～1.9%），所以門檻不敏感 ✓。
 *
 * ## 為什麼不用「墨量比」或「縮放」
 *
 * 都試過、**分不開** ✗（見 `progress/技術總結-給AI.md` §8）：`庚广厂` ✓ 0.76× 與 `庚广艹` ✗ 0.56×
 * 幾乎一樣；`利刂刀` ✓ 的刀也被縮到 42% ✗——「縮小」本身很正常（左右結構的分量本來就該小），
 * 會壞掉的是「**疊上去**」✓。
 *
 * ⚠ 這一支要用**點陣**（`raster.ts`），所以頁面內嵌時兩個模組都要在 `MODULES` 裡 ✓。
 */
import type { Library } from "./lib-format.ts";
import { codePointOf, keyOfIdx, toKageData } from "./lib-format.ts";
import { rasterize, type Raster } from "./raster.ts";

export interface InkConflict {
  /** 新部件的墨 蓋掉「其餘筆劃」的比率（0–1）✓——**這就是判準** */
  coverRatio: number;
  partPx: number;
  restPx: number;
  interPx: number;
}

/** 「墨都搞一塊」的門檻（實測：✗ 27.6% 以上／✓ 1.9% 以下 ✓） */
export const INK_BLOB_LIMIT = 0.2;

/**
 * 只畫某個字形的**一部分筆劃**（KAGE 的字形資料是「一筆一項、用 `$` 分隔」，過濾即可 ✓）。
 * 這樣才能把「新部件的墨」與「其餘筆劃的墨」分開量 ✓（`siblingInkOf` 只認子部件 ✗，
 * 手畫的筆劃抓不到 ✗）。
 */
function rasterSubset(L: Library, idx: number, keep: (i: number) => boolean): Raster | null {
  const g = L.glyphs[idx]!;
  const parts = toKageData(g, L).split("$");
  const kept = parts.filter((_, i) => keep(i));
  if (!kept.length) return null;
  const kage = new Kage();
  const stack: number[] = [];
  g.strokes.forEach((s, i) => { if (keep(i) && s.kind === 99 && s.ref !== null) stack.push(s.ref!); });
  const seen = new Set<number>();
  while (stack.length) {
    const j = stack.pop()!;
    if (seen.has(j)) continue;
    seen.add(j);
    kage.kBuhin.push(keyOfIdx(L, j), toKageData(L.glyphs[j]!, L));
    for (const s of L.glyphs[j]!.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref!);
  }
  const name = "__ink_subset";
  kage.kBuhin.push(name, kept.join("$"));
  try { return rasterize(kage, name, 64, 2); } catch { return null; }
}

const hasInk = (r: Raster | null, i: number): boolean => !!r && r.cov[i]! > 0.35;

/** 量「新部件（第 `partStrokeIx` 筆）的墨 蓋掉其餘筆劃多少」✓ */
export function inkConflictOf(L: Library, idx: number, partStrokeIx: number): InkConflict {
  const part = rasterSubset(L, idx, (i) => i === partStrokeIx);
  const rest = rasterSubset(L, idx, (i) => i !== partStrokeIx);
  let partPx = 0, restPx = 0, interPx = 0;
  const n = (part ?? rest)?.cov.length ?? 0;
  for (let i = 0; i < n; i++) {
    const a = hasInk(part, i), b = hasInk(rest, i);
    if (a) partPx++;
    if (b) restPx++;
    if (a && b) interPx++;
  }
  return { coverRatio: restPx > 0 ? interPx / restPx : 0, partPx, restPx, interPx };
}

/** 結果字形裡「引用著某個碼位」的那一筆是第幾筆（找不到回 -1）✓
 *  ——「新放進去的部件」就是這樣找出來的 ✓（頁面與 CLI 共用，不要各寫一份 ✗） */
export function partStrokeOf(L: Library, idx: number, cp: number): number {
  const g = L.glyphs[idx];
  if (!g) return -1;
  for (let i = 0; i < g.strokes.length; i++) {
    const s = g.strokes[i]!;
    if (s.kind !== 99 || s.ref === null) continue;
    if (codePointOf(L, s.ref) === cp) return i;
  }
  return -1;
}

/** 是不是「一團墨」（不可用）✓ */
export function isInkBlob(c: InkConflict, limit: number = INK_BLOB_LIMIT): boolean {
  return c.coverRatio >= limit;
}

/** 給客人看的一句話 ✓（簡短：百分比 ＋ 重疊格數） */
export function inkConflictNote(c: InkConflict): string {
  return `${(c.coverRatio * 100).toFixed(0)}%（重疊 ${c.interPx} 格／其餘 ${c.restPx} 格）`;
}
