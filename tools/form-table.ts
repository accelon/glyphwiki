/**
 * form-table.ts — **形式表**：`部件 × 區位 → 有哪些形式（用量、實測框）`。
 *
 * 為什麼要這一張（師父第 111 輪的指點）：
 * > 「Unicode 有『釒』『金』（還有『钅』），但『木』作偏旁雖沒有獨立的碼位
 * >  （Unicode 委員們覺得捺筆轉點，不足以差成『字符』級的差異，Unicode 的原則是
 * >  只為抽象的 Char 編碼，而不對具象的 Glyph 編碼……虛虛實實，不容易分得清的。）」
 *
 * 所以「位置形」有**兩層**，這一張把兩層放在一起 ✓：
 *   · **碼位層（Char）**：`釒`／`刂`／`扌`／`氵`… 有自己的碼位（→ `form-groups.ts` 的形式群 ✓）
 *   · **字形層（Glyph）**：`木` 的左偏旁形（捺轉點）**沒有**碼位，是 GlyphWiki 的**同碼 var** ✓
 *
 * 兩層都由**語料**回答「該用在哪個區位」與「框多大」✓（不猜 ✗）：
 *   例：`木` 的 `u6728-04` 下×262（木字底 ✓）；`月` 的 `u6708-01` 左×820 ✓；`金` 的 `釒` 左×904 ✓。
 *
 * ⚠ 這一張是**建議**用的（A6 選形式、A7 建議基字）；**不進 `syn`** ✗（那是 Unicode 認定的同一個字）。
 */
import type { Library } from "./lib-format.ts";
import { codePointOf, displayName } from "./lib-format.ts";
import { canonicalOf, type FormGroups } from "./form-groups.ts";
import { refSlotsOf, slotPosOf } from "./free-compose.ts";

export interface FormEntry {
  /** 形式的字形索引（一定有 ✓——碼位層的形式也是字形） */
  glyphIx: number;
  /** 字形名（`u6728-04`、`u5202-02`…） */
  name: string;
  /** 形式的碼位（同碼 var 時＝部件的碼位；沒有碼位回 null） */
  cp: number | null;
  /** 這一層的分類 */
  layer: "char" | "glyph";
  /** 被引用的次數 */
  n: number;
  /** 實測框的平均（四捨五入） */
  box: [number, number, number, number];
}

/** 部件（正規化碼位）→ 區位 → 形式（依用量遞減） */
export type FormTable = Map<number, Map<string, FormEntry[]>>;

export interface FormTableOptions {
  /** 只收這一組字集裡的碼位（預設全收） */
  inRange?: (cp: number) => boolean;
  /** 至少被引用幾次才收（預設 1） */
  minCount?: number;
}

/** 掃一次語料，建形式表 ✓（`木` 這一類同碼 var 與 `刂` 這一類跨碼位形都收進來） */
export function buildFormTable(L: Library, fg: FormGroups, o: FormTableOptions = {}): FormTable {
  const inRange = o.inRange ?? (() => true);
  const minCount = o.minCount ?? 1;
  /* (部件, 區位) → 字形索引 → {n, 框和} */
  const acc = new Map<number, Map<string, Map<number, { n: number; sx: number; sy: number; ex: number; ey: number }>>>();
  for (let gi = 0; gi < L.glyphs.length; gi++) {
    const g = L.glyphs[gi];
    if (!g) continue;
    const slots = refSlotsOf(L, gi);
    if (slots.length < 2) continue;                      /* 只有多部件的字才看得出區位 ✓ */
    const boxes = slots.map((s) => s.box);
    for (const s of slots) {
      const raw = codePointOf(L, s.ref);
      if (raw === null) continue;
      const cp = canonicalOf(fg, raw);                   /* 部件（本形）✓ */
      if (!inRange(cp)) continue;
      const zone = slotPosOf(s.box, boxes);
      let byZone = acc.get(cp);
      if (!byZone) { byZone = new Map(); acc.set(cp, byZone); }
      let byGlyph = byZone.get(zone);
      if (!byGlyph) { byGlyph = new Map(); byZone.set(zone, byGlyph); }
      const rec = byGlyph.get(s.ref) ?? { n: 0, sx: 0, sy: 0, ex: 0, ey: 0 };
      rec.n++;
      rec.sx += s.box[0]!; rec.sy += s.box[1]!; rec.ex += s.box[2]!; rec.ey += s.box[3]!;
      byGlyph.set(s.ref, rec);
    }
  }
  const out: FormTable = new Map();
  for (const [cp, byZone] of acc) {
    const zones = new Map<string, FormEntry[]>();
    for (const [zone, byGlyph] of byZone) {
      const list: FormEntry[] = [];
      for (const [glyphIx, rec] of byGlyph) {
        if (rec.n < minCount) continue;
        const gcp = codePointOf(L, glyphIx);
        list.push({
          glyphIx, name: displayName(L, glyphIx),
          cp: gcp === 0 ? null : gcp,
          /* 「碼位層」＝它的碼位與部件不同（`刂` 之於 `刀`）✓；「字形層」＝同一個碼位 ✓ */
          layer: gcp !== 0 && gcp !== null && gcp !== cp ? "char" : "glyph",
          n: rec.n,
          box: [
            Math.round(rec.sx / rec.n), Math.round(rec.sy / rec.n),
            Math.round(rec.ex / rec.n), Math.round(rec.ey / rec.n),
          ],
        });
      }
      list.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
      if (list.length) zones.set(zone, list);
    }
    if (zones.size) out.set(cp, zones);
  }
  return out;
}

/** 某個部件在某個區位最該用的形式（沒有專用形就回 null ✓——**不要**硬挑一個 ✗） */
export function bestFormFor(table: FormTable, cp: number, zone: string): FormEntry | null {
  const z = table.get(cp)?.get(zone);
  return z && z.length ? z[0]! : null;
}

/** 這個形式在語料裡的「專用程度」：該區位用量 ÷ 全部用量（1.00＝只在這個區位用 ✓） */
export function zoneSpecialty(table: FormTable, cp: number, glyphIx: number): { zone: string; n: number; share: number } | null {
  const byZone = table.get(cp);
  if (!byZone) return null;
  let total = 0, bestZone = "", bestN = 0;
  for (const [zone, list] of byZone) {
    for (const e of list) {
      if (e.glyphIx !== glyphIx) continue;
      total += e.n;
      if (e.n > bestN) { bestN = e.n; bestZone = zone; }
    }
  }
  if (!total) return null;
  return { zone: bestZone, n: bestN, share: bestN / total };
}
