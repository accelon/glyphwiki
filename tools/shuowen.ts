/**
 * shuowen.ts — 解析《說文解字注》（`swjz.xml`，段玉裁注本）成「構形表」。
 *
 * 為什麼要它：目標是讓**組字結構**取代 IDS，而「部件拆分」的權威不是 IDS ✗（日本團隊主導、
 * 文字學功底不足，例：`木`＝`⿻十人` ✗、`貝`＝`目八` ✗）。真正的權威是**說文** ✓：
 *
 *   * `木` ：「冒也。…从屮。**下象其根**。」→ 象形（不是 十＋人）
 *   * `貝` ：「海介蟲也。…**象形**。象其背穹隆而腹下岐。」
 *   * `雖` ：「佀蜥易而大。…**从虫。唯聲**。」→ 虫＋唯（不是 虽＋隹）
 *   * `林` ：「…**從二木**。」→ 木＋木
 *
 * 檔案結構（實測）：`<wordhead>字</wordhead>` 逐字開頭，其後 `<explanation>`（說文正文）、
 * `<shuowen>`、`<duan_note>`（段注）、`<seal_script>`（小篆）等；11,246 個字頭、9,426 條說文。
 *
 * **這支只做「忠實抽取」**，不做判斷：抽出「从 X」「X 聲」「象形」等訊號與**原文**，
 * 由人（師父）或後續規則決定怎麼用 ✓。說文本身也有自己的體例與時代限制，不是演算法能全自動化的。
 */
import { readFileSync } from "node:fs";

const HAN = "\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u{20000}-\\u{2EBEF}";

export interface ShuowenEntry {
  /** 字頭 */
  head: string;
  /** 說文正文（explanation／shuowen 兩者的合併） */
  text: string;
  /** 段注 */
  duan: string;
  /** 「从 X」「從 X」抽出的構件（依出現順序；「從二木」會展開成 木,木） */
  cong: string[];
  /** 「X 聲」抽出的聲符 */
  sheng: string[];
  /** 有沒有「象形／象某／下象」這類象形描述 */
  xiang: boolean;
  /** 有沒有「从／從」（＝說文認為是合體） */
  hasCong: boolean;
}

const strip = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

/** 解析整份檔案 → 字頭 → 條目（同一字頭重複出現時，後面覆蓋前面） */
export function loadShuowen(path: string): Map<string, ShuowenEntry> {
  const xml = readFileSync(path, "utf8");
  const heads = [...xml.matchAll(/<wordhead[^>]*>([\s\S]*?)<\/wordhead>/g)];
  const out = new Map<string, ShuowenEntry>();
  for (let i = 0; i < heads.length; i++) {
    const head = strip(heads[i]![1] ?? "");
    if (!head || Array.from(head).length !== 1) continue;
    const from = heads[i]!.index! + heads[i]![0]!.length;
    const to = i + 1 < heads.length ? heads[i + 1]!.index! : xml.length;
    const chunk = xml.slice(from, to);
    const text = [strip(chunk), strip(chunk.match(/<shuowen[^>]*>([\s\S]*?)<\/shuowen>/)?.[1] ?? "")]
      .filter(Boolean)
      .join(" ");
    const duan = strip(chunk.match(/<duan_note[^>]*>([\s\S]*?)<\/duan_note>/)?.[1] ?? "");
    const entry = analyze(head, text, duan);
    if (!out.has(head)) out.set(head, entry);
  }
  return out;
}

/** 從一段說文文字抽出構形訊號 */
export function analyze(head: string, text: string, duan: string): ShuowenEntry {
  /* 去掉說文的**部首套語**「凡X之屬皆从X」——那不是這個字的構形 ✗
     （第 76 輪實測：`木` 會被抽成 从[屮木]、`貝` 成 从[貝]、`齊` 成 从[二齊二]）。 */
  const body = text.replace(/凡[^。]*?之屬皆[从從][^。]*?。/g, "");
  /* 構形只能從**說文正文**抽 ✗ 不能碰段注：段注裡段玉裁大量引**別的字**的「从某」來比較，
     那會讓 `丈` 變成 从[又又又]、`大` 變成 从[一古籒]、`魚` 變成 从[火火]（第 77 輪實測的災難）。
     段注仍保留在 `duan` 欄位，供人閱讀 ✓。
     第 77 輪再加一道：只取**短句**（說文的構形句都很短：「从屮」「從二木」「从虫」「唯聲」）——
     段注的比較句都長，靠這道可以再濾掉一批 ✗。 */
  /* 第 85 輪：說文的**構形句**＝那個「以 从／從／象 開頭」的句子 ✓，不是每句都撈 ✗。
     例 `禮`：「履也。所以事神致福也。从示从豊。豊亦聲。」→ 構形句＝`从示从豊` ✓
     （先前把所有句子一起掃，會多撈到後面的「示」✗，變成 示豐示 ✗）。
     聲符則看構形句與它緊接的下一句（「X亦聲」常自成一句 ✓）。 */
  const sents = body.split("。").map((x) => x.replace(/^[\s，、；]+/, "").trim()).filter(Boolean);
  const form = sents.find((x) => /^[从從象]/.test(x)) ?? "";
  const fi = sents.indexOf(form);
  const shengScope = fi >= 0 ? sents.slice(fi, fi + 2).join("。") : form;
  const all = form;
  const cong: string[] = [];
  const re = new RegExp("(?:从|從)\\s*([\\u4e00-\\u9fff])", "gu");
  for (const m of all.matchAll(re)) {
    let ch = m[1]!;
    /* 「從二木」：matched 到的是數字，真正的構件在下一個字，且要重複 N 次 ✓ */
    const num = { 二: 2, 三: 3, 四: 4, 五: 5 }[ch];
    if (num) {
      const nxt = Array.from(all.slice(m.index! + m[0]!.length))[0];
      if (!nxt) continue;
      for (let k = 0; k < num; k++) cong.push(nxt);
      continue;
    }
    if (ch === head) continue;        // 「从木」出現在木的條目＝套語殘留 ✗
    cong.push(ch);
  }
  const sheng: string[] = [];
  for (const m of shengScope.matchAll(new RegExp("([\\u4e00-\\u9fff])\\s*聲", "gu"))) {
    if (m[1] !== head) sheng.push(m[1]!);
  }
  /* 第 86 輪：象形描述常跨到**下一句**（`木`：「从屮。**下象其根**。」✗ 只看構形句會漏 ✗），
     所以「象」與「聲」用同一個窗口（構形句 ＋ 緊接的下一句），只有「从」嚴格限定在構形句內 ✓。 */
  const xiang = /象形|象其|下象|上象|象人|象器/.test(shengScope);
  return { head, text, duan, cong, sheng, xiang, hasCong: cong.length > 0 };
}

/** 便利：碼位查詢 */
export function swOf(tab: Map<string, ShuowenEntry>, cp: number): ShuowenEntry | undefined {
  return tab.get(String.fromCodePoint(cp));
}

/** 統計（供報告） */
export function shuowenStats(tab: Map<string, ShuowenEntry>) {
  let xiang = 0, cong = 0, sheng = 0, atomicish = 0;
  for (const e of tab.values()) {
    if (e.xiang) xiang++;
    if (e.cong.length) cong++;
    if (e.sheng.length) sheng++;
    if (e.xiang && !e.hasCong) atomicish++;   // 象形且沒有「从」→ 最可能是獨體
  }
  return { total: tab.size, xiang, cong, sheng, atomicish };
}

export const _HAN = HAN;
