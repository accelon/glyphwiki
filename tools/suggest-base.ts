/**
 * suggest-base.ts — **建議客人更好的基字**（第 111 輪的目標）。
 *
 * 師父的原話：
 * > 「客人輸入『初衤禾』，推薦『利刂刀』（這兩者的 Unicode 碼位部件序列是相等的，
 * >  只是異形部件差異），讓客人檢視挑擇適當的基字。」
 *
 * 意思：兩條路徑的**結果部件序列一樣**（都是 `禾＋刀`），但起點不同 →
 * 用到的是**不同的位置形**（`初` 的左槽是為 `衤` 準備的；`利` 的左半本來就是左形的 `禾`、
 * 右槽是為 `刂`＝刀的右形準備的）→ 從 `利` 出發的結果好看得多 ✓。
 *
 * 做法（**純序列比對，不猜形狀**）：
 *   1. 目標序列 `T` ＝ 基字的部件序列，把 `old` 換成 `new`（都用碼位）✓
 *   2. 用**形式群**（`form-groups.ts`）把序列正規化：`刂→刀`、`扌→手`… ✓
 *   3. 找出**正規化後序列相同**的字 → 那些字只差「同一部件的不同形式」✓
 *   4. 標出它與目標不同的那一個位置 `i` → 建議就是「用 B 當基字，把 `B.seq[i]` 換成 `T[i]`」
 *      （例：`利` 的 `刂` 換成 `刀` → 就是 `利刂刀` ✓）
 *   5. 排序：被換掉的那個形式**在那個區位被用得多不多**（`刂` 滿×542 ✓ 很好），
 *      再看基字本身常不常見 ✓
 *
 * ⚠ 不變的前提：**答案要真的做得出來**（`canReplaceCp()` 乾跑 ✓）——清單說可以、做卻失敗是地獄 ✗。
 */
import type { Library } from "./lib-format.ts";
import { codePointOf, displayName, indexOfCodePoint } from "./lib-format.ts";
import { canonicalOf, type FormGroups } from "./form-groups.ts";
import { canReplaceCp, drawingIdx, evalSeq, refSlotsOf, slotPosOf } from "./free-compose.ts";
import { inkConflictOf, isInkBlob, inkConflictNote, partStrokeOf, INK_BLOB_LIMIT } from "./ink-conflict.ts";

export interface Suggestion {
  /** 建議的基字（字元；沒有碼位時用字形名） */
  base: string;
  baseCp: number;
  /** 那個基字的部件序列（碼位） */
  seq: number[];
  /** 目標序列（＝客人要的結果，碼位） */
  target: number[];
  /** `exact`＝這個字本來就是那個序列（直接用就好）；`form`＝只差一個位置形（要換一次） */
  kind: "exact" | "form";
  /** `form` 時：要換掉第幾個部件（`exact` 時為 -1） */
  ix: number;
  /** 被換掉的形式（例 `刂`）；`exact` 時為 0 */
  fromCp: number;
  /** 換成什麼（例 `刀`） */
  toCp: number;
  /** 分數（越大越該推薦） */
  score: number;
  /** 給客人看的一句話 */
  reason: string;
  /** **換完之後墨有沒有搞成一塊**（師父第 112 輪的判準 ✓）——有的話不建議 ✗ */
  blob?: boolean;
  /** 墨衝突的說明（可用時才有 ✓） */
  inkNote?: string;
  /** 這個基字在不在**一般漢字區（BMP）**✓——BMP 只影響**排序** ✓，不再是過濾 ✗（第 119 輪 ✓） */
  bmp?: boolean;
}

const key = (seq: number[]) => seq.join(",");
const ch = (cp: number) => { try { return String.fromCodePoint(cp); } catch { return "?" }; };
/** 一般漢字區（BMP）——**只當排序加分，不當過濾** ✓（師父第 119 輪 ✓） */
const isBmpCp = (cp: number) => cp >= 0x4e00 && cp <= 0x9fff;
/** 這個碼位被當部件引用的總次數 ✓（排序用） */
const usageTotalOf = (o: SuggestOptions, cp: number) => {
  const m = o.usageOf?.(cp);
  if (!m) return 0;
  let n = 0;
  for (const v of m.values()) n += v;
  return n;
};

export interface SeqIndex {
  /** 正規化序列 → 碼位清單（只收有 IDS 分解、而且在字集裡的字） */
  bySeq: Map<string, number[]>;
}

/** 建索引：正規化（形式群）之後的部件序列 → 有哪些字 ✓ */
export function buildSeqIndex(L: Library, fg: FormGroups): SeqIndex {
  const bySeq = new Map<string, number[]>();
  if (!L.comp) return { bySeq };
  for (const [cp, comps] of L.comp) {
    if (!comps.length || comps.length > 8) continue;          /* 太長的組合不當建議（版面會亂） */
    const k = key(comps.map((c) => canonicalOf(fg, c)));
    const list = bySeq.get(k);
    if (list) list.push(cp); else bySeq.set(k, [cp]);
  }
  return { bySeq };
}

export interface SuggestOptions {
  baseCp: number;
  oldCp: number;
  newCp: number;
  /** 語料用法：碼位 →（區位 → 次數）✓（用來排序與寫說明） */
  usageOf?: (cp: number) => Map<string, number> | undefined;
  limit?: number;
}

/**
 * 找出「同樣的部件序列、但形式更好」的基字。
 * 回傳依分數遞減排序的建議（**已經過 `canReplaceCp()` 乾跑**，確保真的換得動 ✓）。
 */
export function suggestBases(L: Library, fg: FormGroups, index: SeqIndex, o: SuggestOptions): Suggestion[] {
  const comps = L.comp?.get(o.baseCp);
  if (!comps || !comps.length) return [];
  /* 1. 目標序列：把 old 換成 new */
  const target = comps.map((c) => (c === o.oldCp ? o.newCp : c));
  if (key(target) === key(comps)) return [];                 /* old 不在序列裡 → 沒有目標可言 */
  const targetKey = key(target.map((c) => canonicalOf(fg, c)));
  const out: Suggestion[] = [];
  for (const cp of index.bySeq.get(targetKey) ?? []) {
    if (cp === o.baseCp) continue;                           /* 自己不必建議 ✓ */
    const seq = L.comp!.get(cp)!;
    /* ⚠ 差異要在**原始碼位**上比對 ✗ 不能在正規化之後比——正規化之後它們本來就同桶（差異必為空）✓ */
    const diff: number[] = [];
    for (let i = 0; i < seq.length; i++) if (seq[i] !== target[i]) diff.push(i);
    /* ① **完全相同的序列** → 那個字本來就是這個結果 ✓
       （例：`打丁白` → `拍` 就是 `扌＋白`）
       ★ 師父第 119 輪的架構指示（**這裡本來寫錯過 ✗**）：
         「客人會先用 BMP 輸入（拼音會把罕用字排後面、很多字客人不會念），
           **但系統明白客人的意圖之後，可以建議 extension 的字呀，兩者並不衝突無須取捨。**」
         → 所以**不可以**把非 BMP 的建議濾掉 ✗（那些是**可以點的**，不必客人打出來 ✓）；
           BMP 只當**排序加分** ✓，並在 `bmp` 欄位標出來讓 UI 講清楚 ✓。 */
    if (diff.length === 0) {
      out.push({
        base: ch(cp), baseCp: cp, seq, target, kind: "exact", ix: -1, fromCp: 0, toCp: 0,
        score: 1e6 + usageTotalOf(o, cp) + (isBmpCp(cp) ? 500 : 0),
        bmp: isBmpCp(cp),
        reason: `${ch(cp)} 本來就是 ${target.map(ch).join("＋")}（同一個部件序列，直接用它就好）` +
          (isBmpCp(cp) ? "" : "——非 BMP ✓ 但可以直接點，不必打出來"),
      });
      continue;
    }
    if (diff.length !== 1) continue;                         /* 差兩個以上不是同一個結果 ✗ */
    const ix = diff[0]!;
    const fromCp = seq[ix]!, toCp = target[ix]!;
    /* 只差的那一個位置必須是**同一個部件的不同形式** ✓（＝師父說的「只是異形部件差異」） */
    if (canonicalOf(fg, fromCp) !== canonicalOf(fg, toCp)) continue;
    /* 被換掉的那個形式，必須在**對應的區位**真的有人用（＝這個槽位本來就是為它準備的 ✓） */
    const gi0 = indexOfCodePoint(L, cp);
    if (gi0 === undefined) continue;
    const gi = drawingIdx(L, gi0);
    const slots = refSlotsOf(L, gi);
    const boxes = slots.map((s) => s.box);
    let slotIx = -1;
    for (let k = 0; k < slots.length; k++) {
      const rc = codePointOf(L, slots[k]!.ref);
      if (rc !== null && canonicalOf(fg, rc) === canonicalOf(fg, fromCp)) { slotIx = k; break; }
    }
    if (slotIx < 0) continue;
    if (!canReplaceCp(L, gi0, fromCp)) continue;             /* 引擎真的換得動 ✓ */
    const totalUse = usageTotalOf(o, fromCp);
    /* 分數：①**這個形式本身被用得多不多**（`刂` 810 ✓ 比 `手` 340 更像「專用偏旁形」）
       ②一般漢字區（BMP）加分 ✓——**只是加分，不是過濾** ✓（第 119 輪：非 BMP 也可以建議 ✓，
         因為那是**點一下**就用的，不必客人打出來 ✓）。 */
    const bmp = isBmpCp(cp);
    const score = totalUse + (bmp ? 200 : 0);
    /* 說明：優先用**師父的表**裡的理由（人話 ✓）；沒有的話用「用了幾次」 ✓。
       ⚠ 不要寫區位（`中形` ✗）——位置形的框常是**恆等框**（自己就畫在該位置），
       算出來的區位會是「滿／中」而不是「右」，講出來會錯 ✓。 */
    const why = fg.pairSource.get(canonicalOf(fg, toCp) + "-" + fromCp) ?? fg.pairSource.get(fromCp + "-" + canonicalOf(fg, toCp));
    const human = why && why.startsWith("師父的表：") ? why.replace("師父的表：", "") : "";
    /* ② 換完之後**墨會不會搞成一塊**（師父第 112 輪的判準 ✓）：
       先真的組一次，量「新部件的墨蓋掉其餘筆劃多少」——太多就不建議 ✗
       （實測：「庚广廣」38% ✗、「庚广艹」27.6% ✗；可行的一律 ≤ 2% ✓）。 */
    let blob = false, inkNote = "";
    try {
      const rr = evalSeq(L, ch(cp) + ch(fromCp) + ch(toCp), {});
      if (rr && rr.ok) {
        const si = partStrokeOf(rr.lib, rr.targetIdx, toCp);
        if (si >= 0) {
          const c = inkConflictOf(rr.lib, rr.targetIdx, si);
          blob = isInkBlob(c);
          inkNote = inkConflictNote(c);
        }
      }
    } catch { /* 量不出來就保守當作可用 ✓（寧可多給一個，也不要漏掉 ✓） */ }
    if (blob) continue;
    out.push({
      base: ch(cp), baseCp: cp, seq, target, kind: "form", ix, fromCp, toCp, score,
      blob, inkNote, bmp,
      reason: human
        ? `${ch(cp)} 的 ${ch(fromCp)}→${ch(toCp)}：${human}` + (bmp ? "" : "——非 BMP ✓ 可以直接點")
        : `${ch(cp)} 的 ${ch(fromCp)}→${ch(toCp)}：${ch(fromCp)} 與 ${ch(toCp)} 是同一個部件的不同形式（${ch(fromCp)} 被當部件用了 ${totalUse.toLocaleString()} 次）` +
          (bmp ? "" : "——非 BMP ✓ 可以直接點"),
    });
  }
  out.sort((a, b) => b.score - a.score || a.baseCp - b.baseCp);
  return o.limit ? out.slice(0, o.limit) : out;
}
