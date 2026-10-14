/**
 * form-groups.ts — **部件形式群**：哪些字形是「同一個部件的不同形式」（位置形）。
 *
 * 用途（`部件形式.md`）：組字時建議客人用**位置合適的形式**，
 * 以及本輪的目標——**建議更好的基字**（`初衤禾` → 建議 `利刂刀`）。
 *
 * 三個來源，**依可靠度排序**（⚠ 不用「IDS 版本差異推論」✗，那是第 110 輪的教訓）：
 *   ① **Unihan 的異體關係**（`syn` 圖：相容字符／`kZVariant`；`kSemanticVariant` 等選項層）
 *      ——權威 ✓（`金/釒`、`示/礻`、`言/訁`、`食/飠`）
 *   ② **`kRSUnicode` 同部首 ＋ 筆劃相近 ＋ 字形相似**——覆蓋 Unihan 沒收的常用偏旁形
 *      （`刀/刂` 同部首 18 ✓、`手/扌` 同 64 ✓、`水/氵` 同 85 ✓、`心/忄` 同 61 ✓、
 *        `示/礻` 同 113 ✓、`衣/衤` 同 145 ✓、`食/飠` 同 184 ✓）
 *      ⚠ 同部首**不等於**同部件（`江`／`河` 同部首 85 ✗）→ 所以要**筆劃相近 ＋ 字形相似**把關 ✓
 *   ③ **師父的表**（`FORM_CORE`，草稿；師父會刪修——見 `部件形式.md` §5 第 3 點）
 *
 * ⚠ 這一層只影響「建議」與「已知形式的沿用」；**不進 `syn`** ✗（`syn` 只收 Unicode 認定的同一個字）。
 */
import { readFileSync } from "node:fs";

export interface RadicalStroke { radical: number; residual: number }

/** 讀 `Unihan_RadicalStrokeCounts.txt` 的 `kRSUnicode`
 *  （值形如 `C+3163+18.2.0`＝「C 來源、3163 筆順序、部首 18、殘筆 2」）。 */
export function loadRadicalStroke(path: string): Map<number, RadicalStroke> {
  const out = new Map<number, RadicalStroke>();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const c = line.split("\t");
    if (c.length < 3 || c[1] !== "kRSUnicode") continue;
    const cp = parseInt(c[0]!.replace("U+", ""), 16);
    const m = /\+(\d+)\.(\d+)\./.exec(c[2]!);
    if (!Number.isFinite(cp) || !m) continue;
    if (!out.has(cp)) out.set(cp, { radical: Number(m[1]), residual: Number(m[2]) });
  }
  return out;
}

/** 讀 `Unihan_IRGSources.txt` 的 `kTotalStrokes`（權威筆劃數；用來挑「本形」與擋同部首的假碰撞）。
 *  ⚠ 不要用字庫自己數的筆劃——KAGE 的 `釒` 比 `金` 多一筆 ✗，會讓本形挑錯（實測踩過）。 */
export function loadTotalStrokes(path: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const c = line.split("\t");
    if (c.length < 3 || c[1] !== "kTotalStrokes") continue;
    const cp = parseInt(c[0]!.replace("U+", ""), 16);
    const n = Number(c[2]!.split(/\s+/)[0]);
    if (Number.isFinite(cp) && Number.isFinite(n) && !out.has(cp)) out.set(cp, n);
  }
  return out;
}

/**
 * ★ 常見位置形的**草稿**（第 ③ 來源）——師父會刪修 ✓。
 * 為什麼要這一份：有些偏旁形在 Unihan 與 `kRSUnicode` 都沒有（例如 `釒` 沒有部首編號 ✗），
 * 而它們是**構字常識**（部首變形）。每一條都附理由；**有疑義的就不要放** ✓。
 */
export const FORM_CORE: [number, number, string][] = [
  [0x5200, 0x5202, "刀／刂：刂 是右偏旁的刀（用於右側）"],
  [0x624b, 0x624c, "手／扌：扌 是左偏旁的手"],
  [0x6c34, 0x6c35, "水／氵：氵 是左偏旁的水"],
  [0x5fc3, 0x5fc4, "心／忄：忄 是左偏旁的心"],
  [0x793a, 0x793b, "示／礻：礻 是左偏旁的示"],
  [0x8863, 0x8864, "衣／衤：衤 是左偏旁的衣"],
  [0x98df, 0x98e0, "食／飠：飠 是左偏旁的食"],
  [0x72ac, 0x72ad, "犬／犭：犭 是左偏旁的犬"],
  [0x8a00, 0x8a01, "言／訁：訁 是左偏旁的言"],
  [0x91d1, 0x91d2, "金／釒：釒 是左偏旁的金"],
  [0x7cf8, 0x7cf9, "糸／糹：糹 是左偏旁的糸"],
  [0x7cf8, 0x7e9f, "糸／纟：纟 是簡化字的糸（⚠ Unihan 的繁簡對應沒收這一對，實測漏掉 ✗，所以手列）"],
  [0x8fb6, 0x2ecc, "辵／辶：辶（⻌）是走之底"],
  [0x7389, 0x738b, "玉／王：王 是左偏旁的玉（斜玉旁）"],
  [0x7f51, 0x7f52, "网／罒：罒 是網字頭"],
  [0x722a, 0x722b, "爪／爫：爫 是爪字頭"],
  [0x7af9, 0x25ad7, "竹／𥫗：𥫗 是竹字頭"],
  [0x8089, 0x2ebc, "肉／⺼：⺼ 是左偏旁的肉（月）"],
  [0x9091, 0x2ecf, "邑／⻏：⻏ 是右耳旁（邑）"],
  [0x961c, 0x2ed6, "阜／⻖：⻖ 是左耳旁（阜）"],
  [0x8279, 0x2ebe, "艸／艹：艹 是草字頭"],
  [0x8278, 0x8279, "艸／艹：同一部首的全形與簡形（筆劃差 2，規則擋不住，所以要手列）"],
  [0x96e8, 0x2ed8, "雨／⻗：⻗ 是雨字頭"],
];

export interface FormGroupOptions {
  radicalStrokePath: string;
  /** 字形相似度（0–1）；由呼叫端注入。
   *  ⚠ **實測這不是好判準**（`刀/刂` 正規化後只有 0.17 ✗）——位置形不是「同一個形的變換」，
   *  而是**筆劃更少的專用寫法**。保留參數只為了報告與實驗，預設**不參與**形式判定 ✓。 */
  similarity?: (a: number, b: number) => number | null;
  minSimilarity?: number;
  /** Unihan 的異體對（`syn` 的 pairs），直接當成形式對 ✓（Unicode 正規等價，不必再看形狀） */
  variantPairs?: [number, number][];
  /** `kSemanticVariant` 等**語意對**：⚠ 目前**不用於形式群**（它屬於 A5 的查字選項層 ✗），
   *  需要形狀把關時才傳進來 ✓ */
  gatedVariantPairs?: [number, number][];
  /** **繁簡對應而生的偏旁形**（師父第 111 輪的指點）✓：
   *  「會有『訁』是因為有『讠』。簡化版的『言』偏旁，就得補繁體版的『訁』即便筆劃完全相同。」
   *  Unihan 的鍵是 `讠 ↔ 訁`（`kTraditionalVariant`／`kSimplifiedVariant`），**本字「言」沒有連到它們** ✗。
   *  ⚠ 只收**兩端都被當部件用**的（`usageCount ≥ minUsage`）——這樣才擋掉整字的簡繁對
   *  （`並/併`、`幹/乾` 那一類屬於 A5 的查字選項層 ✗），留下的是真正的偏旁形 ✓。 */
  simpTradPairs?: [number, number][];
  /** 筆劃數（權威：`kTotalStrokes`）。用來挑「本形」與過濾假碰撞 ✓ */
  strokeCount?: (cp: number) => number | null;
  /** **語料用法**：這個碼位被當部件引用幾次 ✓——「形式」的關鍵判準
   *  （`氵` 用上千次 ✓；`江` 幾乎不被當部件 ✗ → 不會被誤收進水部形式群 ✓） */
  usageCount?: (cp: number) => number;
  /** 同部首 ＋ 筆劃相近之外，兩者都要有這個用量才收 ✓ */
  minUsage?: number;
  /** **是不是「單純的形」**（自己沒有部件分解）✓——位置形都是簡單形
   *  （`氵`、`扌`、`刂` ✓）；`光`、`江`、`打` 是合體字 ✗ → 這一步把它們擋在外面 ✓ */
  simpleShape?: (cp: number) => boolean;
  /** 挑「本形」時的分區排序：小的優先（用 `inLib` 讓**一般漢字區**勝過**部首補充區** ✓，
   *  否則 `手` 群的本形會變成 `⺘` ✗——實測踩過） */
  blockRank?: (cp: number) => number;
  /** 只收這一組字集裡的碼位 */
  inRange?: (cp: number) => boolean;
}

export interface FormGroups {
  /** 碼位 → 群代表碼位（本形） */
  canonical: Map<number, number>;
  /** 群代表 → 成員（含代表自己，依碼位排序） */
  members: Map<number, number[]>;
  /** 「a-b」→ 這一對的來源（稽核用） */
  pairSource: Map<string, string>;
}

/** 建立形式群。規則：Unihan 異體 ✓ ∪ 師父的表 ✓ ∪（同 kRSUnicode 部首 ＋ 筆劃差 ≤1 ＋ 字形相似）✓ */
export function buildFormGroups(o: FormGroupOptions): FormGroups {
  const rs = loadRadicalStroke(o.radicalStrokePath);
  const strokes = o.strokeCount ?? (() => null);
  const usage = o.usageCount ?? (() => 0);
  const simple = o.simpleShape ?? (() => true);
  const blockRank = o.blockRank ?? (() => 0);
  const minUsage = o.minUsage ?? 5;
  const inRange = o.inRange ?? (() => true);

  const pairs: [number, number, string][] = [];
  for (const [a, b] of o.variantPairs ?? []) {
    if (inRange(a) && inRange(b)) pairs.push([a, b, "Unihan 異體"]);
  }
  /* 語意對：**筆劃數相近**才收 ✓（不用形狀——形狀對形式判定無效，見 shape-similarity.ts 的說明） */
  for (const [a, b] of o.gatedVariantPairs ?? []) {
    if (!inRange(a) || !inRange(b)) continue;
    const sa = strokes(a), sb = strokes(b);
    if (sa !== null && sb !== null && Math.abs(sa - sb) > 1) continue;
    pairs.push([a, b, `Unihan 語意對（筆劃 ${sa ?? "?"}/${sb ?? "?"}）`]);
  }
  /* **繁簡對應的偏旁形** ✓（`讠↔訁`、`钅↔釒`、`饣↔飠`）：兩端都要真的被當部件用 ✓ */
  for (const [a, b] of o.simpTradPairs ?? []) {
    if (a === b || !inRange(a) || !inRange(b)) continue;
    if (usage(a) < minUsage || usage(b) < minUsage) continue;
    pairs.push([a, b, `繁簡對應的偏旁形（用量 ${usage(a)}/${usage(b)}）`]);
  }
  for (const [a, b, why] of FORM_CORE) {
    if (inRange(a) && inRange(b)) pairs.push([a, b, "師父的表：" + why]);
  }
  /* 同部首 ＋ 筆劃相近 ＋ **兩者都真的被當部件用**（這一步才擋得掉 `江`／`打` 這種同部首的字 ✗） */
  const byRadical = new Map<number, number[]>();
  for (const [cp, r] of rs) {
    if (!inRange(cp)) continue;
    const list = byRadical.get(r.radical);
    if (list) list.push(cp); else byRadical.set(r.radical, [cp]);
  }
  let geomPairs = 0;
  for (const list of byRadical.values()) {
    if (list.length < 2 || list.length > 24) continue;   /* 太大的部首群不做兩兩比對 */
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!, b = list[j]!;
        const sa = strokes(a), sb = strokes(b);
        if (sa !== null && sb !== null && Math.abs(sa - sb) > 1) continue;   /* 筆劃差太多 → 不是同一個形 */
        if (usage(a) < minUsage || usage(b) < minUsage) continue;            /* 不是「被當部件用的形」✗ */
        if (!simple(a) || !simple(b)) continue;                              /* 合體字不是位置形 ✗ */
        pairs.push([a, b, `同部首 ${rs.get(a)!.radical} ＋ 筆劃 ${sa ?? "?"}/${sb ?? "?"} ＋ 用量 ${usage(a)}/${usage(b)}`]);
        geomPairs++;
      }
    }
  }

  /* union-find → 群；代表＝筆劃最多、再取最小碼位（＝本形：`手` 勝 `扌`、`刀` 勝 `刂`） */
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r)!;
    while ((parent.get(x) ?? x) !== r) { const nx = parent.get(x)!; parent.set(x, r); x = nx; }
    return r;
  };
  const pairSource = new Map<string, string>();
  const uni = (a: number, b: number, why: string) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
    pairSource.set(a + "-" + b, why);
  };
  for (const [a, b, why] of pairs) uni(a, b, why);

  const groups = new Map<number, number[]>();
  for (const x of parent.keys()) {
    const r = find(x);
    const g = groups.get(r);
    if (g) g.push(x); else groups.set(r, [x]);
  }
  const canonical = new Map<number, number>();
  const members = new Map<number, number[]>();
  for (const g of groups.values()) {
    /* **本形**：先分區（一般漢字區 0 ＜ 部首補充區 1），再取碼位最小 ✓
       理由：Unicode 先編部首本字再編偏旁形（`刀`5200<`刂`5202、`手`624B<`扌`624C、
       `水`6C34<`氵`6C35、`金`91D1<`釒`91D2），而部首補充區（`⺘`2E98…）碼位更小 ✗
       → 所以一定要先分區，否則本形會變成 `⺘`／`⺡` ✗（實測踩過）。
       ⚠ 也不要用「筆劃最多」——那會挑到 `光` 而不是 `水` ✗。 */
    g.sort((a, b) => blockRank(a) - blockRank(b) || a - b);
    const canon = g[0]!;
    members.set(canon, g);
    for (const cp of g) canonical.set(cp, canon);
  }
  return { canonical, members, pairSource };
}

/** `cp` 的本形（不在任何群裡就回自己） */
export function canonicalOf(fg: FormGroups, cp: number): number {
  return fg.canonical.get(cp) ?? cp;
}

/** 兩個碼位是不是同一個部件的不同形式（同群） */
export function sameForm(fg: FormGroups, a: number, b: number): boolean {
  return canonicalOf(fg, a) === canonicalOf(fg, b);
}
