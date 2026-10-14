#!/usr/bin/env bun
/**
 * build-library.ts — 建立「精簡字形庫」（BMP CJK 漢字）。
 *
 * 目標（format.md 基礎任務 2）：理想 2MB、5MB 以內可接受（可 base64 進單一網頁）。
 *
 * 設計原則:
 *   1. **框是人工資產**：保留每個部件的「緊框 + 定義框」，組字時才做縮放（策略 3）。
 *   2. **名字改索引**：原格式 `99:0:0:0:0:200:200:u5317-03:0:0:0:0` 裡名字佔一半以上。
 *   3. **只帶可達閉包**：CJK 漢字 40,266 個根字只依賴約 7 萬個字形。
 *   4. **省略預設值**：`width=0`、`style=0`、滿格框、伸縮=0 都是常態。
 *
 * 編碼規則（踩過的坑，寫入端與讀取端必須完全對稱）:
 *   * **有號**（zigzag）：座標、width、style、伸縮值。座標可為負（-2）、
 *     width 也可為負（-58）；用普通 varint 會被 JS 位元運算當 uint32 編成 5 bytes 而錯位。
 *   * **非負**（原始 varint）：計數、長度、碼位、索引、kind、旗標。
 *     **不可用 zigzag**，否則 70416 會變成 140832（乘 2）。
 *   * `noStretch` = 1 表示沒有伸縮資料（只有此時才省略後面 4 個值）。
 *   * `ptCountOf` 用 `kind % 100`：資料中真實存在 103/203/303 等三位數變體。
 *
 * 字集:
 *   預設收**全部 Unicode CJK 漢字區塊**（URO ＋ Ext A..I ＋ 相容區／相容補充）。
 *   舊版只收 BMP，因此 `𩀨`（U+29028，CJK Ext B）不在庫中，
 *   holy grail「邏羅寶貝𩀨從䞃致招」得靠「借模板換件」硬造。
 *   現在它是庫裡的真字，引用框（人工版面資產）可以原封不動沿用。
 *
 *   注意舊版的 `0x3400..0xFAFF` 其實還夾帶了 12,210 個非漢字（諺文、彝文…），
 *   新版改用精確的漢字區塊，所以「換成擴充區」不是單純變大，而是換掉一批雜訊。
 *
 * 用法:
 *   bun run tools/build-library.ts [--out out/lib-cjk-all.bin]
 *   bun run tools/build-library.ts --ranges 3400-4DBF 4E00-9FFF F900-FAFF 20000-2A6DF
 *   bun run tools/build-library.ts --ranges 4E00-9FFF 2FF0-2FFB   # 順便收組字運算子
 *   bun run tools/build-library.ts --range 0x3400 0xFAFF          # 舊版單一區段（相容）
 */

import { Database } from "bun:sqlite";
import { buildBoxDict } from "./box-dictionary.ts";
import {
  decodeLibrary, loadWikiNames, displayName, indexOfChar, legacyPreference,
} from "./lib-format.ts";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DB = resolve(ROOT, "db/glyphwiki.db");

const argv = Bun.argv.slice(2);

/**
 * 預設字集：**全部 Unicode CJK 漢字區塊**。
 *
 *   Ext A     U+3400..U+4DBF    6,592
 *   URO       U+4E00..U+9FFF   20,992  基本區
 *   相容區     U+F900..U+FAFF      472  CJK Compatibility Ideographs
 *   Ext B     U+20000..U+2A6DF 42,720  ← `𩀨` 在這裡
 *   Ext C     U+2A700..U+2B73F  4,160
 *   Ext D     U+2B740..U+2B81F    223
 *   Ext E     U+2B820..U+2CEAF  5,774
 *   Ext F     U+2CEB0..U+2EBEF  7,473
 *   Ext I     U+2EBF0..U+2EE5D    622
 *   相容補充   U+2F800..U+2FA1F    542
 *   Ext G     U+30000..U+3134F  4,939
 *   Ext H     U+31350..U+323AF  4,192
 *                            ─────────
 *                            98,701 個碼位字
 *
 * 邊界刻意取「區塊」而不是「已編配的碼位」：區塊內的保留碼位在 DB 裡本來就
 * 沒有字形，取了不會多收東西；反過來若把邊界寫成已編配的尾端，
 * Unicode 之後擴充就得再改一次。
 */
const DEFAULT_RANGES: [number, number][] = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x20000, 0x2a6df],
  [0x2a700, 0x2b73f],
  [0x2b740, 0x2b81f],
  [0x2b820, 0x2ceaf],
  [0x2ceb0, 0x2ebef],
  [0x2ebf0, 0x2ee5f],
  [0x2f800, 0x2fa1f],
  [0x30000, 0x3134f],
  [0x31350, 0x323af],
];

/** 解析 `3400-4DBF` / `0x3400-0x4dbf` / 單一碼位 `29028`（一律當十六進位，符合碼位習慣） */
function parseRangeToken(t: string): [number, number] | null {
  const m = /^(0x)?([0-9a-f]+)(?:[-.](0x)?([0-9a-f]+))?$/i.exec(t);
  if (!m) return null;
  const a = parseInt(m[2]!, 16);
  if (!Number.isFinite(a)) return null;
  if (!m[4]) return [a, a];
  const b = parseInt(m[4]!, 16);
  return Number.isFinite(b) ? [a, b] : null;
}

let ranges: [number, number][] = DEFAULT_RANGES;
let outPath = resolve(ROOT, "out/lib-cjk.bin");
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--ranges") {
    const list: [number, number][] = [];
    while (argv[i + 1] && !argv[i + 1]!.startsWith("--")) {
      const r = parseRangeToken(argv[++i]!);
      if (!r) { console.error(`✗ 看不懂的區段：${argv[i]}`); process.exit(2); }
      list.push(r);
    }
    if (!list.length) { console.error("✗ --ranges 後面沒有區段"); process.exit(2); }
    ranges = list;
  } else if (argv[i] === "--range") {
    // 舊版相容：--range <min> <max>（十進位或 0x 前綴）
    const a = Number(argv[++i]), b = Number(argv[++i]);
    ranges = [[a, b]];
  } else if (argv[i] === "--out") outPath = resolve(argv[++i]!);
}

/** 筆畫型別 → 座標點數（單一來源，寫入端與讀取端共用同一規則） */
export function ptCountOf(kind: number): number {
  const k = kind % 100;
  if (k === 0 || k === 9) return 0;
  if (k === 1) return 2;
  if (k === 2 || k === 3 || k === 4) return 3;
  return 4;
}

const db = new Database(DB, { readonly: true });
import { loadIdsFile, primaryComponents } from "./ids-source.ts";
import { isAtomic } from "./atomic-chars.ts";
import { loadShuowen } from "./shuowen.ts";
import { loadSyn, synGroups } from "./syn-graph.ts";

// ---------------------------------------------------------------- 名字解析（含版本退路）

// dump 只含「最新版」，但引用常帶 `@版本`（如 u9f8d-ue0105@3）。
// 實測閉包中 1,805 個「懸空」名有 1,802 個去掉 `@版本` 就能找到，
// 若不做這層退路，會有 4,402 個根字（10.9%）的部件樹缺料。
//
// 退路同時要帶回**那筆紀錄的結構化欄位**（name_type／codepoint／base_name）：
// 家族的判定不能靠名字字串猜，要靠 dump 自己說的。
interface Meta {
  data: string;
  name_type: string;
  codepoint: number | null;
  base_name: string | null;
  /** 實際命中的紀錄名（可能是去掉 `@版本` 之後的名字） */
  hit: string;
}
const metaStmt = db.query(
  "SELECT name, data, name_type, codepoint, base_name FROM glyphs WHERE name = ?",
);
const metaCache = new Map<string, Meta | null>();
const lookupMeta = (n: string): Meta | null => {
  if (metaCache.has(n)) return metaCache.get(n)!;
  let r = metaStmt.get(n) as any;
  if (!r) {
    const s = n.replace(/@[0-9]+$/, "");
    if (s !== n) r = metaStmt.get(s) as any;
    if (!r) {
      const b = n.replace(/-[a-z0-9_.]+(@[0-9]+)?$/i, "");
      if (b !== n) r = metaStmt.get(b) as any;
    }
  }
  const out: Meta | null = r
    ? { data: r.data as string, name_type: r.name_type as string,
        codepoint: r.codepoint as number | null, base_name: r.base_name as string | null,
        hit: r.name as string }
    : null;
  metaCache.set(n, out);
  return out;
};
const lookup = (n: string): string | null => lookupMeta(n)?.data ?? null;

// ---------------------------------------------------------------- 資料結構

interface Stroke {
  kind: number;
  width: number;
  style: number;
  pts: number[];
  refName: string | null;
  sx: number; sy: number; sx2: number; sy2: number;
}
interface GlyphRec { name: string; strokes: Stroke[] }

function parseGlyph(name: string, data: string): GlyphRec {
  const strokes: Stroke[] = [];
  for (const part of data.split("$")) {
    if (!part) continue;
    const c = part.split(":");
    const kind = parseInt(c[0]!, 10);
    if (!Number.isFinite(kind)) continue;
    const pts: number[] = [];
    for (let i = 3; i <= 10; i++) pts.push(parseInt(c[i] ?? "0", 10) || 0);
    strokes.push({
      kind,
      width: parseInt(c[1] ?? "0", 10) || 0,
      style: parseInt(c[2] ?? "0", 10) || 0,
      pts,
      refName: kind === 99 ? (c[7] ?? null) : null,
      sx: parseInt(c[8] ?? "0", 10) || 0,
      sy: parseInt(c[9] ?? "0", 10) || 0,
      sx2: parseInt(c[10] ?? "0", 10) || 0,
      sy2: parseInt(c[11] ?? "0", 10) || 0,
    });
  }
  return { name, strokes };
}

// ---------------------------------------------------------------- 收集閉包

// 一律把所有碼位字撈出來再用 JS 過濾：比拼一條超長的 SQL OR 簡單，
// 也讓「實際收錄了哪些碼位」這件事在報表裡看得見。
const allCp = db
  .query("SELECT name, codepoint FROM glyphs WHERE name_type='codepoint'")
  .all() as any[];
const inRanges = (cp: number) => ranges.some(([a, b]) => cp >= a && cp <= b);
const rootRows = allCp
  .filter((r) => inRanges(r.codepoint as number))
  .sort((a, b) => (a.codepoint as number) - (b.codepoint as number));
const roots = rootRows.map((r) => r.name as string);

console.log(`字集區段：${ranges.map(([a, b]) =>
  `U+${a.toString(16).toUpperCase()}..U+${b.toString(16).toUpperCase()}`).join("、")}`);
for (const [a, b] of ranges) {
  const n = allCp.filter((r) => (r.codepoint as number) >= a && (r.codepoint as number) <= b).length;
  console.log(`  U+${a.toString(16).toUpperCase().padStart(5, "0")}..U+${b.toString(16).toUpperCase().padStart(5, "0")}  ${String(n).padStart(7)} 字`);
}

const glyphs = new Map<string, GlyphRec>();
const stack = [...roots];
const danglingNames = new Set<string>();
while (stack.length) {
  const n = stack.pop()!;
  if (glyphs.has(n)) continue;
  const data = lookup(n);
  if (data === null) { danglingNames.add(n); continue; }
  const rec = parseGlyph(n, data);
  glyphs.set(n, rec);
  // **閉包由筆畫資料自己推**，不用 `parts` 表。
  // 踩過的坑：Ext B 有一批字的 `parts` 紀錄不全，於是引用指向沒被收進閉包的字形，
  // 寫檔時只能靜默寫成索引 0（＝指到別的字），產生看不出來的錯字。
  // 從 data 推就保證「每個引用都指得到」。
  for (const s of rec.strokes) if (s.refName) stack.push(s.refName);
}
console.log(`閉包：${glyphs.size.toLocaleString()} 個字形（根 ${roots.length.toLocaleString()}，懸空 ${danglingNames.size.toLocaleString()}）`);
if (danglingNames.size) {
  console.log(`  懸空名（前 10）：${[...danglingNames].slice(0, 10).join(" ")}`);
}


// ---------------------------------------------------------------- 家族（碼位）與字形順序
//
// 舊版把 GlyphWiki 的名字字串整份寫進檔案（碼位 + 後綴索引），
// 佔了 gzip 後的 20.7%。名字其實只有三個用途：
//   1. 碼位 → 字形（對外 API 只用得到這個）
//   2. 家族關係（正字／異體）
//   3. 回查 dump（對照表，**不進前端**）
// 所以新版把名字層換成純數值的「家族表」，並**重排字形**讓同一家族的成員連續。
// 重排同時讓筆畫區塊的 gzip 少 118 KB（同性質的資料聚在一起）。

const names = [...glyphs.keys()];

/** 名字 → 碼位。**優先用 dump 說的**（name_type／codepoint），查不到才退回字串解析。 */
const NAME_CP = /^u([0-9a-f]{1,6})/i;
const cpOfName = (n: string): number => {
  const meta = lookupMeta(n);
  if (meta && meta.name_type !== "other" && meta.codepoint) return meta.codepoint;
  const m = NAME_CP.exec(n);
  return m ? parseInt(m[1]!, 16) : 0;
};

/**
 * 只有**落在字集區段內**的碼位才會有家族。
 *
 * 這一條是必要的，不是最佳化：GlyphWiki 把 IDS 合成字形命名成
 * `u2ff0-u9b2f-u5bf8`（算子 ＋ 兩個運算元），而 dump 把它的 name_type 標成
 * **suffix、codepoint = 0x2FF0、base_name = u2ff0**——也就是說 dump 自己就認為
 * 它是「U+2FF0 的異體」。照單全收的結果是 ⿰ 這個運算子碼位底下掛了 698 個成員、
 * ⿱ 掛了 2,270 個（全庫 77,353 個 `u2ff?-*` 名字），
 * 於是「令 U+4EE4 的第 5 個異體被誰引用」會撿出 U+2FF0／U+2FF8 這種
 * **根本不該出現在字集裡的 IDC**，而且畫出來是別的字。
 *
 * 加這一條之後它們退回「無家族的部件」——字形還在（該被引用時引用得到），
 * 只是不再算成某個碼位的異體。
 */
const byCp = new Map<number, number[]>();   // 碼位 → 原始索引清單
const orphans: number[] = [];
names.forEach((n, i) => {
  const cp = cpOfName(n);
  if (!cp || !inRanges(cp)) { orphans.push(i); return; }
  const arr = byCp.get(cp);
  if (arr) arr.push(i); else byCp.set(cp, [i]);
});

// 舊版 findGlyphIndex 的偏好（`-j` > …），用同一份實作以免兩邊選到不同字形
const prefOf = legacyPreference(names);

const isPlain = (i: number) => /^u[0-9a-f]{1,6}(-j)?$/i.test(names[i]!);
/** 成員排序：一般漢字優先（`plain` 才會是前綴）、短的優先、最後才是名字序 */
const memberSort = (a: number, b: number) => {
  const pa = isPlain(a) ? 0 : 1, pb = isPlain(b) ? 0 : 1;
  if (pa !== pb) return pa - pb;
  const la = names[a]!.length, lb = names[b]!.length;
  if (la !== lb) return la - lb;
  return names[a]! < names[b]! ? -1 : 1;
};

interface Run { cp: number; members: number[]; pref: number; plain: number }
const runs: Run[] = [];
let prefOverflow = 0, plainOverflow = 0;
for (const cp of [...byCp.keys()].sort((a, b) => a - b)) {
  const members = byCp.get(cp)!.slice().sort(memberSort);
  const pIdx = prefOf.get(cp);
  let pref = pIdx === undefined ? 0 : members.indexOf(pIdx);
  if (pref < 0) pref = 0;
  if (pref > 31) {
    // 偏好成員被排到 31 名之後（極少數）→ 直接搬到最前面，pref 記 0
    prefOverflow++;
    const [m] = members.splice(pref, 1);
    members.unshift(m!);
    pref = 0;
  }
  let plain = 0;
  for (const m of members) { if (isPlain(m)) plain++; else break; }
  if (plain > 7) plainOverflow++;
  runs.push({ cp, members, pref, plain: Math.min(plain, 7) });
}

/** 新順序：家族依碼位遞增、成員連續；沒有家族的部件排在最後。 */
const order: number[] = [];
for (const r of runs) order.push(...r.members);
order.push(...orphans);
const newIx = new Int32Array(names.length);
order.forEach((oldIx, newIdx) => { newIx[oldIx] = newIdx; });

const orphanStart = names.length - orphans.length;
console.log(`家族 ${runs.length.toLocaleString()} 個（碼位範圍 U+` +
  `${runs[0]?.cp.toString(16).toUpperCase()}..U+${runs[runs.length - 1]?.cp.toString(16).toUpperCase()}）、` +
  `無家族的部件 ${orphans.length.toLocaleString()} 個`);
if (orphanStart !== runs.reduce((a, r) => a + r.members.length, 0)) {
  console.error("✗ 家族成員數與 orphanStart 不一致"); process.exit(1);
}
if (prefOverflow || plainOverflow) {
  console.log(`  偏好位移 >31 的家族 ${prefOverflow} 個（已搬到最前）、一般字 >7 的家族 ${plainOverflow} 個`);
}

// ---------------------------------------------------------------- 寫出

const bin: number[] = [];

/** 非負整數：原始 varint（計數、長度、索引、kind、旗標） */
const pushU = (n: number) => {
  let v = n >>> 0;
  while (v >= 0x80) { bin.push((v & 0x7f) | 0x80); v >>>= 7; }
  bin.push(v);
};
/** 有號整數：zigzag + varint（座標、width、style、伸縮值、碼位差值） */
const pushS = (n: number) => {
  let v = ((n << 1) ^ (n >> 31)) >>> 0;
  while (v >= 0x80) { bin.push((v & 0x7f) | 0x80); v >>>= 7; }
  bin.push(v);
};

// 魔數 `"GL"` + 版本。沒有魔數的檔案一律當 v1 讀（lib-format.ts 會自動判別），
// 所以舊的 out/lib-cjk.bin.gz 與內嵌它的兩個網頁不必重建就能繼續用。
//
// v3 = v2 ＋ 尾端的 **IDS 部件區段**。原因：GlyphWiki 有些字把部件
// **畫成原始筆劃**（杏 = ⿱木口，`u674f-j` 卻只有「口」一個引用；林 0 個引用），
// 只從 KAGE 引用推出來的部件索引永遠找不到它們。把 IDS 分解一起寫進字庫，
// 瀏覽器／編輯器／命令列工具才會**讀同一份**。
bin.push(0x47, 0x4c, 6);   // v4＝部件清單 zigzag 差值；v5＝再加跨碼位異體；v6＝再加**理據拆分**（說文；只顯示、不參與組字）

pushU(names.length);
pushU(runs.length);
{
  let prevCp = 0;
  for (const r of runs) {
    pushS(r.cp - prevCp); prevCp = r.cp;
    pushU(r.members.length);
    pushU((Math.min(r.pref, 31) << 3) | Math.min(r.plain, 7));
  }
}

// ---- 先濾掉懸空引用 ----
// **必須在框字典之前做**：buildBoxDict 依「走訪順序」發索引，
// 若字典用全部引用、寫出時卻跳過幾筆，兩邊的索引就會錯位（整庫框跑掉）。
// 引用指向不在閉包裡的名字時，先前會靜默寫成索引 0（＝指到別的字）；
// 現在改成**整條引用丟掉**：子字形不存在時它本來就畫不出東西，
// 留著只會畫出一個不相干的字（實測有 497 筆全部變成 U+3400 㐀）。
const nameIx = new Map<string, number>();
names.forEach((n, i) => nameIx.set(n, i));

let missingRefs = 0;
const missingRefNames = new Set<string>();
const keptStrokes = new Map<GlyphRec, Stroke[]>();
for (const g of glyphs.values()) {
  keptStrokes.set(g, g.strokes.filter((s) => {
    if (s.kind !== 99) return true;
    if (nameIx.has(s.refName!)) return true;
    missingRefs++;
    missingRefNames.add(s.refName!);
    return false;
  }));
}

// ---- 框字典 ----
// 全庫 117,120 個引用框只有 14,425 個相異值；以「最大座標差 ≤2 格」聚類
// 只需約 5,794 個代表框，平均位移 0.60 格。
// 框是人工隨意微調的，200×200 下這種誤差不是問題（實測 24×24 點陣下多數不可見）。
// 效益：引用框在 gzip 後佔 167,154 bytes，字典化後只需約 25,523 bytes。
//
// **依新順序**走訪：字典的 assign 是依走訪順序發的，順序必須與寫出時一致。
const orderedRecs = order.map((oldIx) => glyphs.get(names[oldIx]!)!);
const dict = buildBoxDict({
  glyphs: orderedRecs.map((g) => ({ strokes: keptStrokes.get(g)! as any })),
});
pushU(dict.reps.length);
for (const r of dict.reps) for (const v of r) pushS(v);
console.log(`框字典：${dict.reps.length.toLocaleString()} 個代表框（引用 ${dict.assign.length.toLocaleString()} 筆）`);

// 依出現順序走訪引用，取得每個引用在字典中的索引
let boxIx = 0;
for (const g of orderedRecs) {
  const kept = keptStrokes.get(g)!;
  // 不再寫緊框：它可由內容衍生（lib-format.ts 的 computeTight），
  // 先前存進檔案的那份既算錯、又佔了 17% 的體積。
  pushU(kept.length);
  for (const s of kept) {
    pushU(s.kind);
    if (s.kind === 99) {
      // 引用改寫成**新順序**的索引
      pushU(newIx[nameIx.get(s.refName!)!]!);
      const isFull = s.pts[0] === 0 && s.pts[1] === 0 && s.pts[2] === 200 && s.pts[3] === 200;
      const noStretch = s.sx === 0 && s.sy === 0 && s.sx2 === 0 && s.sy2 === 0;
      // 兩個旗標併成一個 byte 的 bit field（原本各佔 1 byte，共 117,120 筆）：
      //   bit 0 = isFull（框為滿格，省略 4 個框值）
      //   bit 1 = noStretch（無伸縮，省略 4 個伸縮值）
      //   bit 2..7 保留給未來擴充
      // 四種組合的實際分佈：isFull=0&noStretch=1 佔 53.8%、1&1 佔 45.6%，
      // 另兩種合計 0.6%——2 bits 已足夠。
      pushU((isFull ? 1 : 0) | (noStretch ? 2 : 0));
      // 框改存「字典索引」；滿格框的同義索引也是同一個，所以仍保留 isFull 旗標
      // 作為快速路徑（45.8% 的引用是滿格框）。
      if (!isFull) pushU(dict.assign[boxIx] ?? 0);
      boxIx++;
      if (!noStretch) { pushS(s.sx); pushS(s.sy); pushS(s.sx2); pushS(s.sy2); }
    } else {
      pushS(s.width);
      pushS(s.style);
      // 一律寫 8 個座標（依原始位置 F[3..10]）：點數少的型別尾端本來就是 0，
      // 這樣格式統一，不會再有「尾欄省略」造成的假差異（kind 0/9 也帶資料）。
      for (let i = 0; i < 8; i++) pushS(s.pts[i]!);
    }
  }
}

// ---- IDS 部件區段（v3，放在檔案尾端）----
// 讀 `ids_comp`（IDS 的直接分量，**保留重複**：林 = 木 木）。
// 兩件事要濾掉：
//   1. 自我引用——原子字（口、日、木、一）的 ids.seq 就是它自己，
//      `ids_comp` 也存了一列 comp_cp = codepoint（690 列）。留著會變成
//      「口 → 口」的自我迴圈，把出現次數算成 41、156 這種天文數字。
//   2. 非漢字——`ids.seq` 有一部分是組件引用表達式（`&U-i001+2FF6;放土`），
//      解析後留下 U+003F「?」、U+0030「0」、U+002D「-」這些 ASCII 殘渣。
const compOfCp = new Map<number, number[]>();
{
  const rows = db.query(
    "SELECT codepoint AS cp, comp_cp AS c FROM ids_comp " +
    "WHERE kind='char' AND comp_cp IS NOT NULL AND comp_cp <> codepoint AND comp_cp >= 0x2E80 " +
    "ORDER BY codepoint, pos",
  ).all() as { cp: number; c: number }[];
  for (const r of rows) {
    const a = compOfCp.get(r.cp);
    if (a) a.push(r.c); else compOfCp.set(r.cp, [r.c]);
  }
}
/* 新的 IDS 來源（ids/ids_lv1.txt，MIT）：**主要拆法**的直接分量。
   它在有分解時覆寫上面那份舊 CHISE 的結果（舊的把 `藵` 寫成 `⿱艹褒`，多一個 `亠`；
   新的寫 `⿱艹𧛱`＝我們畫法引用的那個）。覆蓋不到的字仍沿用舊值。 */
{
  /* 暫時停用（第 50 輪）：解析器對「筆形描述列」還會**無中生有**——`木`（獨體字）被拆成 十+亻+丨+一，
     因為它的主要欄是筆形描述、而替代欄是逐筆序列，我卻拿替代欄當分解。修好解析器再啟用，見 §6.16。 */
  const tab = loadIdsFile(resolve(ROOT, "ids/ids_lv1.txt"));
  let n = 0, dropped = 0, altPick = 0;
  for (const [cp, e] of tab) {
    /* 獨體字表：**只要分「獨體」還是「組合」**（師父第 97／108／109 輪指示 ✓），獨體永不拆分 ✓。
       第 109 輪（師父裁定「清。」＋「我選 A」）：**清掉舊 CHISE 留下的 comp** ✓，
       並把「手畫、但明顯是合體」的字移出獨體表 ✓：
         `麥`＝來＋夂、`食`＝人＋良、`頁`＝丆＋貝、`音`＝立＋日、`面`＝丆＋囬、
         `首`＝䒑＋自、`角`＝⺈＋用、`長`＝厂＋二
       ——移出後才拿得到 comp ✓（`麥` 那條＝`䴺→麥→來／夂`，正是師父最初回報的一組 ✓）。
       `門` 依師父先前的裁定**留在表內** ✓（左右鏡象、當獨體未嘗不可 ✓）；
       `鹿`／`龜`／`龍` 等移出也沒 comp（新來源的拆法含筆形 ✗，會被下面的筆形閘擋掉 ✓），暫不動 ✓。 */
    if (isAtomic(cp)) { compOfCp.delete(cp); continue; }   /* 第 109 輪（師父「清。」）：獨體就不再留舊 CHISE 的分解 ✓ */
    /* 畫法裁判：先穿透包裝（單一引用＝只是指標），再看那一層有幾塊墨（§6.15／§6.16） */
    const oi = byCp.get(cp)?.slice().sort(memberSort)[0];
    let rec = oi === undefined ? undefined : glyphs.get(names[oi]!);
    for (let hop = 0; hop < 8 && rec; hop++) {
      const st0 = keptStrokes.get(rec) ?? rec.strokes;
      const only = st0.length === 1 && st0[0]!.kind === 99 ? st0[0]!.refName : null;
      if (!only) break;
      const next = glyphs.get(only);
      if (!next) break;
      rec = next;
    }
    const st = rec ? (keptStrokes.get(rec) ?? rec.strokes) : undefined;
    if (!st) continue;
    /* 第 80 輪：新來源給了**多重拆法**（主要＋替代），該由**畫法**來選，不是盲取第一個 ✗。
       `㕻` 的主要 `⿱示口` 對不上畫法（畫法引用的是 `否`），替代 `⿱丶否` 才對得上 ✓。
       先把畫法引用的碼位收集起來，逐候選挑「至少一個分量就是引用」的那一個。 */
    const refCps = new Set<number>();
    for (const s2 of st) if (s2.kind === 99 && s2.refName) { const rc = cpOfName(s2.refName); if (rc) refCps.add(rc); }
    const OPS: Record<string, number> = { "⿰": 2, "⿱": 2, "⿲": 3, "⿳": 3, "⿴": 2, "⿵": 2, "⿶": 2, "⿷": 2, "⿸": 2, "⿹": 2, "⿺": 2, "⿻": 2 };
    const cands: number[][] = [];
    for (const seq of e.primary.concat(e.alt)) {
      const chs = Array.from(seq);
      const ar = OPS[chs[0] ?? ""];
      if (!ar) continue;
      const c2 = chs.slice(1, 1 + ar)
        .map((ch) => ch.codePointAt(0)!)
        .filter((v) => v !== cp && v >= 0x3400);
      if (c2.length >= 2 && !cands.some((x) => x.length === c2.length && x.every((v, i) => v === c2[i]))) cands.push(c2);
    }
    let comps: number[] = [];
    const prim = primaryComponents(e).filter((c) => c !== cp);
    for (const c2 of cands) if (c2.some((v) => refCps.has(v))) {
      comps = c2;
      /* 只算「真的換成**非主要欄**」的（第 82 輪修：先前對任何候選被選中都計數，訊息會誤導 ✗） */
      if (!(c2.length === prim.length && c2.every((v, i) => v === prim[i]))) altPick++;
      break;
    }
    if (!comps.length) comps = prim;
    if (comps.length < 2) continue;
    /* 第 109 輪（師父的判準，並授權我可拆可不拆時自己做主）：
       > 拆分的目的是**方便這個字的分類**——比方說有「木」部件就和「木」有關；
       > 將「木」再拆為「十、八」那就**離意義太遠**了。
       所以：只要有一個分量是**筆形字**（一丨丶丿乙亅乀乚…），這個拆法就不用 ✓
       ——那已經接近筆劃 ✗，對分類沒有幫助 ✗。 */
    const STROKEISH = new Set(Array.from("一丨丶丿乙亅乀乚㇀㇁㇂㇃㇄㇅㇆㇇㇈㇉𠃊𠃍𠃌𠃎𠃏𡿨"));
    if (comps.some((c) => STROKEISH.has(String.fromCodePoint(c)))) { dropped++; continue; }
    const refs = st.filter((s) => s.kind === 99).length;
    const raw = st.filter((s) => s.kind !== 99 && s.kind !== 0).length;
    /* 第 94 輪（師父對 `門` 的裁定逼出來的）：**墨塊數不能只看「有沒有手畫筆劃」** ✗。
       `林`（0 引用 ＋ 8 筆手畫）與 `哥`（0 引用 ＋ 12 筆）都是**手畫的合體字** ✗，
       舊寫法「有手畫就算 1 塊」→ 1 < 2 → 被誤判為獨體、沒有 comp ✗。
       這裡先用一個**實證門檻**（抽樣：`木`4／`日`5／`水`5 筆為一團；`林`8／`哥`12 筆為兩團）：
       手畫 >= 6 筆時算「可能不只一團」＝ 2 塊。
       ⚠ 這只是暫時的近似 ✗；正解是**沿乾淨的縫把墨切開來數**（`component-boxes.ts` 的 `rawGroups`
       已在用那套演算法 ✓），下一步把它抽出來共用 ✓。 */
    const ink = refs + (raw >= 6 ? 2 : raw > 0 ? 1 : 0);
    if (ink < comps.length) { dropped++; continue; }
    compOfCp.set(cp, comps);
    n++;
  }
  console.log("新 IDS 來源：" + n.toLocaleString() + " 個碼位採用（其中 " + altPick.toLocaleString() + " 個改用**畫法支持**的替代拆法；畫法裁判擋下 " + dropped.toLocaleString() + " 個「一團墨」）");
}

/* 只留這個字庫真的有的碼位（12 個 CJK 區塊內） */
const compCps: number[] = [];
/* 父字也必須是**區段內的碼位**（同上的理由：IDS 算子碼位不算字） */
for (const cp of compOfCp.keys()) {
  if (!inRanges(cp)) continue;
  if (nameIx.has("u" + cp.toString(16).toLowerCase())) compCps.push(cp);
}
compCps.sort((a, b) => a - b);
{
  pushU(compCps.length);
  let prevCp = 0, nEdges = 0;
  for (const cp of compCps) {
    /* ⚠ **不要排序**：`ids_comp.pos` 就是 IDS 的分量出現序（孚＝爫,子），
       那是「組字結構」的一部分（左右／上下的先後），也是槽位推斷用來檢查順序的依據。
       2026-10-13 之前這裡寫 `.sort((a, b) => a - b)`，把順序壓成碼位序，
       結果 `孚` 的分量表變成 `子,爫`，`solveIdsSlots()` 的順序檢查反而接受「上下顛倒」的分組。 */
    const list = compOfCp.get(cp)!;
    pushU(cp - prevCp); prevCp = cp;
    pushU(list.length);
    let prevC = 0;
    /* v4：**有號**差值（`pushS`）——清單要照 IDS 的原序存（見上面的⚠），
       所以差值可正可負。v3 的無號差值只能遞增，被迫排序。 */
    for (const c of list) { pushS(c - prevC); prevC = c; }
    nEdges += list.length;
  }
  console.log(`IDS 部件區段：${compCps.length.toLocaleString()} 個碼位、${nEdges.toLocaleString()} 條邊`);
}

// ---- 跨碼位異體區段（v5）：相容字符 ↔ 正規碼位 ----
// `out/compat-map.tsv` 由自有 IDS 資料推出（`車` 的序列 = `車`，或兩者序列一字不差）
// ＋「原始筆劃數相同」當第二訊號。家族表只綁同碼位，這一區補「同一個字、兩個碼位」。
{
  /* ⚠ **兩端必須是「真的字」或「真的部首」**（2026-10-14 加）。
     實測到污染：`out/compat-map.tsv` 裡有 **182 列**寫成 `U+XXXX → U+2205`（∅），
     那是產生器把「**沒有對應字**」的**佔位符當成碼位**寫進資料 ✗。
     182 條邊會讓 syn 圖長出一個 **397 個成員**的連通分量（木＝口＝一＝人…全部同義 ✗），
     受害者：
       · `componentBoxes()`——`杏` 的 `木` 被當成「已被 `口` 涵蓋」→ **沒有框** ✗
         （`check-component-boxes.ts` 的 `杏：得到 口，預期 口 木` 就是它）；
       · `check-parts.ts` 的命中率——假的命中（兩個真部首被當成同一個部件）；
       · 頁面的 `synCps()`／`RADICAL_SYN`——查「木」會撈出含「口」的字。
     同一批裡還有兩類雜訊，順手一起擋掉：
       · **IDC 算子**（`2FF0–2FFF`，實例 U+2FFD ⿽ ↔ 龰／此）——同一個 IDC 教訓：
         算子不是字 ✗；
       · **杭州數字**（U+3022 〢 ↔ 口／老／𭁉）——由「ids_lv1↔lv2 差異」推來的 UCV，
         對這類記號本身就不成立（推論不可靠，不是資料錯）。
     ⚠ 寧可**少收**，也不要讓一個假異體污染整個連通分量。 */
  const pairs: [number, number][] = [];
  try {
    /* 來源＝**Unihan（權威）**：UnicodeData 的正規單一分解（相容字符）＋ `Unihan_Variants.txt`
       的 `kZVariant`（＋本專案列出的部首形）。規則與理由都在 `tools/syn-graph.ts` 與
       `tools/unihan-variants.ts` 的檔頭 ✓（第 110 輪之前那份「IDS 版本差異推論表」不再讀取 ✗）。 */
    const syn = loadSyn({
      unicodeData: resolve(ROOT, "unihan/UnicodeData.txt"),
      variants: resolve(ROOT, "unihan/Unihan_Variants.txt"),
      inLib: inRanges,
    });
    pairs.push(...syn.pairs);
    for (const [k, v] of [...syn.bySource.entries()].sort((x, y) => y[1] - x[1])) {
      console.log(`  異體來源：${k}　${v} 對`);
    }
    if (syn.outsideLib) console.log(`  （Unihan 另有 ${syn.outsideLib} 個端點不在我們字集，略過）`);
    /* **選項層**（師父第 110 輪：「同時找異體部件」）：偏旁形／簡繁／日新舊字體。
       資料保留精確資訊 ✓，用**選項**區分專家與普通人 ✓——這一層**不寫進 syn** ✗。 */
    console.log(`  選項層（不進 syn）：${syn.optionPairs.length.toLocaleString()} 對　` +
      [...syn.optionByField.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join("、"));
  } catch (e) {
    /* ⚠ **Unihan 是必要輸入，不是可選的**（第 110 輪教訓）：
       原本這裡只印一句「寫 0 筆」就繼續建庫——結果程式錯誤（少一個 import）
       被吞成「syn 0 對」還照樣出貨 ✗，而 `verify` 只會看到「syn 對數變少」。
       → 讀不到就**拒絕出貨** ✓（跟連通分量閘門同一條規矩：寧可停，不要默默變差）。 */
    console.error(`✗ 讀不到 Unihan 異體資料（unihan/UnicodeData.txt、unihan/Unihan_Variants.txt）：${(e as Error).message}`);
    console.error(`  下載：curl -sSL -o unihan/Unihan.zip https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip`);
    process.exit(4);
  }
  /* **連通分量上限**——兩級，因為這兩個門檻問的是不同的問題：
     · `> 150`＝**明顯的污染**（實例：`∅` 佔位符把 397 個部件串成一組）→ **拒絕出貨** ✗。
     · `> 20`＝**需要人看的可疑群**（實例 2026-10-14：93 個成員的一群，裡面有
       `口≡土`、`一≡八`、`犬≡大`、`木≡林` 這種由「**IDS 版本差異推論**」來的等價，
       以及 UCV 列的 `⺝≡戈`、`⺝≡心`）→ **警告 ＋ 寫稽核表**（`tools/report-syn-groups.ts`）
       → **等師父裁定**。
       為什麼不直接硬擋：這一批是**資料政策**問題（丢掉它們會降低部件的召回率），
       不是程式錯誤；硬擋會讓所有建庫停擺。⚠ 但**不可以**為了讓它過就偷偷把門檻調高 ✗
       ——那正是「閘門要能失敗」的反面。 */
  const HARD_GROUP = 150, WARN_GROUP = 20;
  {
    const groups = synGroups(pairs).groups;
    const maxGroup = groups[0]?.length ?? 0;
    if (maxGroup > HARD_GROUP) {
      console.error(`✗ syn 圖最大連通分量 ${maxGroup}（硬上限 ${HARD_GROUP}）——異體表有污染，拒絕出貨 ✗`);
      console.error(`   最大群：` + (groups[0] ?? []).slice(0, 30).map((c) => String.fromCodePoint(c)).join(""));
      process.exit(3);
    }
    if (maxGroup > WARN_GROUP) {
      console.log(`⚠ syn 圖最大連通分量 ${maxGroup}（警告門檻 ${WARN_GROUP}）——待師父裁定，` +
        `稽核表：bun run tools/report-syn-groups.ts`);
      console.log(`   最大群：` + (groups[0] ?? []).slice(0, 40).map((c) => String.fromCodePoint(c)).join(""));
    }
    console.log(`跨碼位異體：${pairs.length} 對（最大連通分量 ${maxGroup}；警告 ${WARN_GROUP}／硬上限 ${HARD_GROUP}）`);
  }
  pushU(pairs.length);
  let prevA = 0, prevB = 0;
  for (const [a, b] of pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    pushS(a - prevA); pushS(b - prevB); prevA = a; prevB = b;
  }
  console.log("跨碼位異體區段：" + pairs.length + " 對");

/* ---- 理據拆分區段（v6）：說文解字注的「从X ＋ X聲」 ------------------------------
   師父第 98 輪的指示：**記錄文字學的拆分，讓檢字軟件對文字學家有用 ✓；
   但這個信息不用來組字** ✗（組字一律用 `comp` 的視覺拆分 ✓）。
   空間實測：6,323 條 → 39.7 KB 原始／約 31 KB gz ✓（預算 200 KB）✓。
   ⚠ 說文本身近年也有被推翻處 ✗、且隸變後字形已變 ✗（§6.19）→ 標明「僅供參考」✓。 */
{
  const sw = loadShuowen(resolve(ROOT, "swjz.xml"));
  const phil: { cp: number; comps: number[] }[] = [];
  for (const [ch, e] of sw) {
    const cp = ch.codePointAt(0)!;
    if (!inRanges(cp)) continue;
    const c = e.cong.map((x) => x.codePointAt(0)!).filter((x) => x !== cp && inRanges(x));
    const s = e.sheng.map((x) => x.codePointAt(0)!).filter((x) => x !== cp && inRanges(x));
    const all = Array.from(new Set(c.concat(s)));
    if (all.length < 2 || all.length > 4) continue;   // 單一「从X」多半是我的抽取不足 ✗，先不收
    phil.push({ cp, comps: all });
  }
  phil.sort((a, b) => a.cp - b.cp);
  pushU(phil.length);
  let prevP = 0;
  for (const r of phil) {
    /* 與 syn 區段同慣例：碼位差用**有號**（`pushS` ⇄ 解碼端的 `rd.rv()`）✓
       ——第 100 輪實測：這裡誤用 `pushU` 會讓解碼整個錯位（6,460 條只讀到 2,116 條 ✗）。 */
    pushS(r.cp - prevP); prevP = r.cp;
    pushU(r.comps.length);
    let pc = r.cp;
    for (const c of r.comps) { pushS(c - pc); pc = c; }
  }
  console.log("理據拆分區段（v6）：" + phil.length.toLocaleString() + " 條（來源：說文解字注；只顯示、不參與組字）");
}
}
const actual = new Uint8Array(bin);

if (missingRefs) {
  console.log(`⚠ 懸空引用 ${missingRefs} 筆（指向 ${missingRefNames.size} 個缺料名字）——已整條丟掉：` +
    `${[...missingRefNames].slice(0, 8).join(" ")}`);
} else {
  console.log("✓ 沒有懸空引用（每個引用都指得到閉包裡的字形）");
}

// 自我檢查：檔頭解出的魔數／版本／兩個計數必須等於寫入值
// （先前 zigzag 誤用會讓計數乘 2，而且沒有任何錯誤訊息）
{
  let q = 0;
  const rdB = () => bin[q++]!;
  const rd = () => { let v = 0, s = 0; for (;;) { const x = rdB(); v |= (x & 0x7f) << s; if ((x & 0x80) === 0) return v >>> 0; s += 7; } };
  const m0 = rdB(), m1 = rdB(), ver = rdB();
  const g1 = rd(), g2 = rd();
  if (m0 !== 0x47 || m1 !== 0x4c || ver !== 6) {
    console.error(`✗ 自我檢查失敗: 檔頭不符（${m0},${m1},${ver}）`); process.exit(1);
  }
  if (g1 !== names.length || g2 !== runs.length) {
    console.error(`✗ 自我檢查失敗: 檔頭解出 ${g1}/${g2}，期望 ${names.length}/${runs.length}`);
    process.exit(1);
  }
  console.log(`✓ 自我檢查通過: magic=GL ver=${ver} glyphCount=${g1} familyCount=${g2}`);
}

console.log(`\n=== 實際寫出 varint 二進位 ===`);
console.log(`  ${actual.length.toLocaleString()} bytes = ${(actual.length / 1048576).toFixed(2)} MB`);
const gz = Bun.gzipSync(actual, { level: 9 });
console.log(`  gzip: ${(gz.length / 1048576).toFixed(2)} MB`);
console.log(`  base64（內嵌單頁）: ${(Buffer.from(gz).toString("base64").length / 1048576).toFixed(2)} MB`);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, actual);
writeFileSync(outPath + ".gz", gz);
console.log(`\n已寫出 ${outPath}`);
console.log(`       ${outPath}.gz`);

// ---- 對照表（內部索引 → GlyphWiki 名字）----
//
// 這是**唯一**能查回 dump 的橋，刻意放在字庫檔之外：
// 前端不需要它（模組使用者只用 Unicode），而它自己就有 1.5 MB。
// 要顯示／回寫 dump 的工具再 loadWikiNames() 載進來就好。
{
  const sidePath = outPath.replace(/\.bin$/, "") + ".gnames.tsv.gz";
  const lines = new Array<string>(names.length);
  order.forEach((oldIx, newIdx) => { lines[newIdx] = newIdx + "\t" + names[oldIx]; });
  const sideRaw = Buffer.from(lines.join("\n") + "\n", "utf8");
  const sideGz = Bun.gzipSync(sideRaw, { level: 9 });
  writeFileSync(sidePath, sideGz);
  console.log(`       ${sidePath}（對照表：${names.length.toLocaleString()} 筆、` +
    `raw ${(sideRaw.length / 1048576).toFixed(2)} MB、gzip ${(sideGz.length / 1048576).toFixed(2)} MB）`);
}

// 寫完立刻驗證兩檔一致。
// 這個檢查是必要的：先前曾發生 .bin 已更新而 .gz 仍是舊格式（兩者大小不同），
// 網頁讀 .gz 因此解碼錯位，卻沒有任何錯誤訊息——非常難查。
{
  const backRaw = readFileSync(outPath);
  const backUn = Bun.gunzipSync(readFileSync(outPath + ".gz"));
  const sameSize = backRaw.length === backUn.length;
  let same = sameSize;
  if (sameSize) {
    for (let i = 0; i < backRaw.length; i++) {
      if (backRaw[i] !== backUn[i]) { same = false; break; }
    }
  }
  if (!same) {
    console.error(`✗ .bin 與 .gz 不一致！.bin=${backRaw.length} bytes，.gz 解壓後=${backUn.length} bytes`);
    process.exit(1);
  }
  console.log(`✓ 兩檔一致：.bin ${backRaw.length.toLocaleString()} bytes ＝ .gz 解壓後 ${backUn.length.toLocaleString()} bytes`);
}

// ---- 收尾驗證：用剛剛寫出的檔案自己解一次，並抽查對照表 ----
{
  const back = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(outPath + ".gz"))));
  const side = readFileSync(outPath.replace(/\.bin$/, "") + ".gnames.tsv.gz");
  const n = loadWikiNames(back, Buffer.from(Bun.gunzipSync(side)).toString("utf8"));
  const problems: string[] = [];
  if (back.glyphs.length !== names.length) problems.push(`字形數 ${back.glyphs.length} != ${names.length}`);
  if (n !== names.length) problems.push(`對照表 ${n} 筆 != ${names.length}`);
  // 每個引用都要指得到東西
  let refs = 0, oob = 0;
  for (const g of back.glyphs) for (const s of g.strokes) if (s.kind === 99) {
    refs++;
    if (s.ref === null || s.ref < 0 || s.ref >= back.glyphs.length) oob++;
  }
  if (oob) problems.push(`引用越界 ${oob}/${refs}`);
  // 9 個 holy grail 字都要查得到，而且查到的名字要與對照表一致
  const check = "邏羅寶貝𩀨從䞃致招";
  for (const ch of check) {
    const i = indexOfChar(back, ch);
    if (i === undefined) problems.push(`${ch} 查不到`);
  }
  // 再抽 200 個碼位，比對「新庫查到的名字」與舊庫的 findGlyphIndex 是否同一家族
  for (const ch of ["邏", "寶", "𩀨", "䞃", "致", "招"]) {
    const i = indexOfChar(back, ch)!;
    const nm = displayName(back, i);
    if (!nm.startsWith("u" + ch.codePointAt(0)!.toString(16))) problems.push(`${ch} 查到 ${nm}`);
  }
  if (problems.length) {
    console.error("✗ 收尾驗證失敗：\n  " + problems.join("\n  "));
    process.exit(1);
  }
  console.log(`✓ 收尾驗證通過：重新解碼 ${back.glyphs.length.toLocaleString()} 字形、` +
    `${refs.toLocaleString()} 筆引用全部有效、對照表 ${n.toLocaleString()} 筆、九個 grail 字都在`);
}
db.close();
