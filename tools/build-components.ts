#!/usr/bin/env bun
/**
 * build-components.ts — 抽出「部件序列」，供檢字／部件檢索使用。
 *
 * 用法:
 *   bun run tools/build-components.ts [--db db/glyphwiki.db]
 *
 * 動機（與 IDS 的關係）:
 *   KAGE 只為視覺組合方便而設計，遇到複合部件時會「歸併」成單一名字
 *   （例如把「明」寫成 `u660e-03`），此時那個節點**沒有乾淨的子部件**
 *   （實測 `u660e-03` 只有 1 個子部件卻有 5 筆筆畫）。我們要的不是還原 IDS
 *   （IDS 描述力不足以產字形），而是**部件序列**（檢字用），
 *   所以遇到這種「歸併節點」時，用 IDS 取得它的部件，並**停止往下展開 KAGE**。
 *
 * 產出:
 *   glyph_components : level='direct' 該字自己的直接部件；level='leaf' 終端部件
 *   comp_index       : 反查索引（部件 → 字），只收真正的漢字（>= U+3400）
 *
 * 設計要點（踩過的坑）:
 *   1. 節點同時有「乾淨子部件」與筆畫時，KAGE 不完整 → 用 IDS 展開並停止 KAGE 展開，
 *      否則會重複膨脹（盟 的 日月 會出現好幾次）。
 *   2. 名字要取「字形碼位」當 IDS 鍵（`u660e-03` → U+660E），
 *      但 `-j` 形式的 IDS 與 base 不同（u80cc-j=北月、u80cc=北肉），所以先試原名。
 *   3. ids 表的 seq 可能是組件引用表達式而非 IDS（如 `&U-i001+2FF6;放土`，實測 5,089 筆）
 *      → 必須含運算子、不得有殘留 `&`、只接受單層運算子。
 *   4. 名字解析必須整串比對。用寬鬆前綴會把 `&GT-K00059;` 切成 'U','-','6',';' 假碼位。
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const argv = Bun.argv.slice(2);
let dbPath = "db/glyphwiki.db";
for (let i = 0; i < argv.length; i++) if (argv[i] === "--db") dbPath = argv[++i]!;
const DB = resolve(dbPath);
if (!existsSync(DB)) {
  console.error(`db not found: ${DB}\n先執行: bun run tools/build-db.ts`);
  process.exit(1);
}

const db = new Database(DB);
db.exec("PRAGMA synchronous = OFF;");
db.exec("PRAGMA temp_store = MEMORY;");
db.exec("PRAGMA cache_size = -200000;");

const NAME_RE = /^u([0-9a-f]{4,6})((?:-[a-z0-9_.]+)*)(?:@[0-9a-z]+)?$/i;
const canonOf = (name: string): number | null => {
  const m = NAME_RE.exec(name);
  return m ? parseInt(m[1]!, 16) : null;
};
const cdpKeyOf = (s: string): string | null => {
  const t = s.replace(/^&/, "").replace(/;$/, "").trim().toLowerCase();
  const m = /^(cdp|gt|kp|ucs|jef|chise)-?([0-9a-f]{4,6})(?:-\d+)?$/.exec(t);
  return m ? m[1] + ":" + m[2] : null;
};
// 單一筆畫（Unicode 基本筆畫區 U+31C0..U+31E3）不是部件，不可當分解結果
const isStroke = (cp: number | null): boolean => cp != null && cp >= 0x31c0 && cp <= 0x31e3;
// 在漢字區、但功能上就是單一筆畫的字：不可再拆，也不應被拆出來
const STROKE_FN = new Set<number>([0x4e00, 0x4e28, 0x4e36, 0x4e3f, 0x4e59, 0x4e5a, 0x4e85, 0x4e40, 0x4e41]);
const isStrokeFn = (cp: number | null): boolean => cp != null && STROKE_FN.has(cp);
const isCjk = (cp: number | null): boolean =>
  cp != null &&
  ((cp >= 0x3400 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x3ffff));

// ---------------------------------------------------------------- 預載

const partsMap = new Map<string, string[]>();
for (const r of db
  .query("SELECT glyph, comp FROM parts WHERE kind = 99 ORDER BY glyph, idx")
  .all() as any[]) {
  const a = partsMap.get(r.glyph);
  if (a) a.push(r.comp);
  else partsMap.set(r.glyph, [r.comp]);
}
const idsSeq = new Map<number, string>();
for (const r of db.query("SELECT codepoint, seq FROM ids").all() as any[])
  idsSeq.set(r.codepoint, r.seq);
const idsKids = new Map<number, { name: string; cp: number }[]>();
for (const r of db
  .query(
    "SELECT codepoint, ch, comp_cp FROM ids_comp WHERE kind='char' ORDER BY codepoint, pos",
  )
  .all() as any[]) {
  const list = idsKids.get(r.codepoint);
  if (list) list.push({ name: r.ch, cp: r.comp_cp });
  else idsKids.set(r.codepoint, [{ name: r.ch, cp: r.comp_cp }]);
}
const nameToCp = new Map<string, number>();
for (const r of db
  .query("SELECT name, codepoint FROM glyphs WHERE codepoint IS NOT NULL")
  .all() as any[])
  nameToCp.set(r.name, r.codepoint);
console.log(
  `預載: parts ${partsMap.size.toLocaleString()} / ids ${idsSeq.size.toLocaleString()} / 名字碼位 ${nameToCp.size.toLocaleString()}`,
);

db.exec(`
DROP TABLE IF EXISTS glyph_components;
DROP TABLE IF EXISTS comp_index;
CREATE TABLE glyph_components (
  codepoint  INTEGER NOT NULL,
  level      TEXT NOT NULL,
  path       TEXT NOT NULL,
  depth      INTEGER NOT NULL,
  seq_ix     INTEGER NOT NULL,
  parent     TEXT,
  comp_name  TEXT NOT NULL,
  comp_cp    INTEGER,
  comp_cdp   TEXT,
  comp_cjk   INTEGER NOT NULL,
  source     TEXT NOT NULL,
  PRIMARY KEY (codepoint, level, path)
);
CREATE TABLE comp_index (
  comp_cp   INTEGER NOT NULL,
  codepoint INTEGER NOT NULL,
  depth     INTEGER NOT NULL,
  source    TEXT NOT NULL,
  PRIMARY KEY (comp_cp, codepoint)
);
`);
const ins = db.prepare(`
  INSERT OR REPLACE INTO glyph_components
    (codepoint, level, path, depth, seq_ix, parent, comp_name, comp_cp, comp_cdp, comp_cjk, source)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
const insIdx = db.prepare(
  "INSERT OR REPLACE INTO comp_index (comp_cp, codepoint, depth, source) VALUES (?,?,?,?)",
);

// ---------------------------------------------------------------- IDS 展開

/** 取一個**碼位**的 IDS 分量（單層、部件級）。回傳 null 表示不適用。 */
function idsPartsByCp(cp: number): { name: string; cp: number }[] | null {
  const seq = idsSeq.get(cp);
  if (!seq || seq.includes("&")) return null;
  const ops = seq.match(/[\u2FF0-\u2FFB]/g);
  if (!ops || ops.length !== 1) return null;
  const raw = idsKids.get(cp);
  if (!raw) return null;
  const out: { name: string; cp: number }[] = [];
  for (const c of raw) {
    if (c.cp == null) continue;
    if (!isCjk(c.cp)) continue;
    out.push({ name: "u" + c.cp.toString(16).toLowerCase(), cp: c.cp });
  }
  if (out.length < 2 || out.length > 3) return null;
  /* 這裡原本還有一道「分量必須至少兩種」的守衛，會把 `⿰木木`（林）、
     `⿰炎火`（炎）這類**分量全同**的 IDS 判掉，於是林、炎、圭、多、昌、朋
     全部進不了部件表。重複次數是有意義的（林 = 木×2），不能這樣濾。
     真正要防的是「展開後跟原字一樣」的退化，那在下面 bestList 的地方擋。 */
  return out;
}

const stat = { idsFill: 0, dangling: 0 };
const LEAF_MODE = false; // 只存直接子部件；終端部件由使用端遞歸算出

// ---------------------------------------------------------------- 抽取
//
// 一個節點的三種情況：
//   (a) IDS 有部件級分解 → 用它，停止 KAGE 展開（KAGE 在此被歸併）
//   (b) 否則 KAGE 有子部件 → 遞歸
//   (c) 否則就是葉

function extract(topCp: number): void {
  const rootName = "u" + topCp.toString(16).toLowerCase();
  if (!partsMap.get(rootName)) return;

  // ---- 不變量 ----
  // 1. 以「部件碼位」為鍵（去重、索引都用碼位）
  // 2. **取最短部件序列**：展開只有在「總部件數不增加」時才採用
  // 3. 單一筆畫（U+31C0..31E3）與單筆畫功能字（一丨丶丿乙亅…）不可再拆
  const include = (cp: number): boolean => isCjk(cp) && !isStroke(cp);
  const stopper = (cp: number): boolean => isStroke(cp) || isStrokeFn(cp);

  // 取某個碼位的「最短部件序列」（記憶化）。回傳碼位陣列。
  const memoShort = new Map<number, number[]>();
  const shortOf = (cp: number, depth: number, seen: Set<number>): number[] => {
    const hit = memoShort.get(cp);
    if (hit) return hit;
    if (depth > 6 || seen.has(cp) || stopper(cp) || !include(cp)) return [cp];

    // 候選：IDS 部件級分解
    const name = "u" + cp.toString(16).toLowerCase();
    const ids = idsPartsByCp(cp);
    const cands: number[][] = [];
    if (ids && ids.length >= 2) cands.push(ids.map((k) => k.cp));
    // 候選：KAGE 直接子部件（去重、排除筆畫）。
    // 先攤平「單一子部件的純指標鏈」：例如 背 → u80cc-j → 北 月，
    // 而 u80cc-j 的碼位等於 背 自己，直接展開會退回自己而誤判為原子。
    let flatName = name;
    for (let hop = 0; hop < 8; hop++) {
      const kidList = partsMap.get(flatName);
      if (!kidList || kidList.length !== 1) break;
      const onlyName = kidList[0]!;
      const onlyCp = canonOf(onlyName);
      if (onlyCp != null && onlyCp !== cp) { flatName = onlyName; continue; }
      const nkKids = partsMap.get(onlyName);
      if (nkKids && nkKids.length > 0) flatName = onlyName;
      break;
    }
    const kk = partsMap.get(flatName);
    if (kk && kk.length >= 2) {
      const arr: number[] = [];
      /* **不去重**：品 = 三個「口」引用，去重會讓它看起來像獨體字而整顆被丟掉。
         重複次數是搜尋要用的資訊（口口 要能找到品、器、哭）。 */
      for (const k of kk) {
        const kcp = canonOf(k);
        if (kcp == null || !include(kcp)) continue;
        arr.push(kcp);
      }
      if (arr.length >= 1) cands.push(arr);
    }
    if (cands.length === 0) { memoShort.set(cp, [cp]); return [cp]; }

    // 對每個候選再遞歸展開；與「原子（就當一個部件）」相比，取較短者。
    // 注意：不能把初始 best 設成 [cp] 就跳過比較 —— 展開成 2~3 個部件仍可能
    // 讓「上層整體」變短（例：盟 → 明 皿 → 日 月 皿），所以一律比較後再定。
    let bestList: number[] | null = null;
    for (const cand of cands) {
      const s2 = new Set(seen);
      s2.add(cp);
      const flat: number[] = [];
      for (const c of cand) for (const t of shortOf(c, depth + 1, s2)) flat.push(t);
      // **保留重複**：林 = ⿰木木 要拿到兩個「木」，去重會讓它退化成獨體字。
      // 只把「跟母字自己一樣」的項去掉（避免自我展開），其餘照順序留著。
      const uniq: number[] = [];
      for (const t of flat) { if (t !== cp) uniq.push(t); }
      if (uniq.length < 1) continue;
      // 展開結果不得含「單筆畫 / 單筆畫功能字」。
      // 否則 白 = ⿱丿日 這類 IDS 會把筆畫帶進來，違反「不拆到筆畫」的原則。
      if (uniq.some((t) => stopper(t))) continue;
      // 防爆：正常一顆字不會有十幾個分量，超過就是展開失控，跳過這個候選
      if (uniq.length > 8) continue;
      if (bestList === null || uniq.length < bestList.length) bestList = uniq;
    }
    // 展開沒有比「原子（長度 1）」短 → 視為原子
    if (bestList === null || bestList.length >= 2 === false) {
      bestList = [cp];
    }
    memoShort.set(cp, bestList);
    return bestList;
  };

  const seq = shortOf(topCp, 0, new Set());
  // 若最終序列就是自己，代表這是獨體字，不寫入
  if (seq.length < 2) return;

  for (let i = 0; i < seq.length; i++) {
    const cp = seq[i]!;
    if (!include(cp)) continue;
    const name = "u" + cp.toString(16).toLowerCase();
    const src = idsPartsByCp(cp) ? "ids" : "kage";
    ins.run(topCp, "direct", String(i), 1, i, rootName, name, cp, null, 1, src);
    if (cp >= 0x3400) insIdx.run(cp, topCp, 1, src);
  }
}

// ---------------------------------------------------------------- 主迴圈

const targets = db
  .query(
    "SELECT name, codepoint FROM glyphs WHERE name_type='codepoint' AND codepoint IS NOT NULL ORDER BY codepoint",
  )
  .all() as { name: string; codepoint: number }[];
console.log(`處理 ${targets.length.toLocaleString()} 個純碼位字形…`);
db.exec("BEGIN;");
let n = 0;
for (const t of targets) {
  if (!partsMap.get(t.name)) continue;
  extract(t.codepoint);
  if (++n % 20000 === 0) {
    db.exec("COMMIT;");
    db.exec("BEGIN;");
    process.stderr.write(`\r  ${n.toLocaleString()}`);
  }
}
db.exec("COMMIT;");
process.stderr.write("\r" + " ".repeat(30) + "\r");
db.exec(`
CREATE INDEX idx_gcomp_cp ON glyph_components(comp_cp);
CREATE INDEX idx_cidx_cp  ON comp_index(codepoint);
ANALYZE;`);

// ---------------------------------------------------------------- 報告

const c = (x: any) => (x == null ? "-" : Number(x).toLocaleString());
const all = <T>(s: string): T[] => db.query(s).all() as T[];
const one = <T>(s: string): T => db.query(s).get() as T;

console.log("\n================ 部件序列 ================");
console.log(`IDS 補展開次數 ${c(stat.idsFill)}   丟棄懸空 ${c(stat.dangling)}`);
for (const r of all<any>(
  "SELECT level, source, COUNT(*) n, COUNT(DISTINCT codepoint) g FROM glyph_components GROUP BY level, source ORDER BY level, source",
))
  console.log(`  ${r.level.padEnd(7)} ${r.source.padEnd(5)} ${c(r.n).padStart(9)} 列 / ${c(r.g)} 字`);

console.log("\n-- 每字葉節點數分佈 --");
for (const r of all<any>(`
  WITH t AS (SELECT codepoint, COUNT(*) n, COUNT(DISTINCT comp_cp) d FROM glyph_components WHERE level='leaf' GROUP BY codepoint)
  SELECT n, COUNT(*) g, SUM(CASE WHEN n=d THEN 1 ELSE 0 END) nodup FROM t GROUP BY n ORDER BY n LIMIT 8`))
  console.log(`  ${String(r.n).padStart(3)} 個葉: ${c(r.g).padStart(7)} 字（其中無重複 ${c(r.nodup)}）`);

console.log(`\n-- comp_index: ${c(one<any>("SELECT COUNT(*) n FROM comp_index").n)} 列，${c(one<any>("SELECT COUNT(DISTINCT comp_cp) n FROM comp_index").n)} 個部件`);

console.log("\n-- 抽樣 --");
const show = (cp: number) => {
  const i = db.query("SELECT ch, seq FROM ids WHERE codepoint = ?").get(cp) as any;
  const leaf = db
    .query("SELECT comp_name, comp_cp, source FROM glyph_components WHERE codepoint=? AND level='leaf' ORDER BY path")
    .all(cp) as any[];
  const dir = db
    .query("SELECT comp_name FROM glyph_components WHERE codepoint=? AND level='direct' ORDER BY seq_ix")
    .all(cp) as any[];
  console.log(`  ${i?.ch ?? "?"}  IDS=${i?.seq ?? "-"}`);
  console.log(`     direct: ${dir.map((x) => x.comp_name).join(" ")}`);
  console.log(`     leaf  : ${leaf.map((x) => `${x.comp_name}[${x.source}]`).join(" ")}`);
};
for (const cp of [0x76df, 0x660e, 0x80cc, 0x3d64, 0x5728]) show(cp);

console.log("\n-- 檢字示範：含「日月皿」全部 --");
for (const r of all<any>(`
  SELECT i.ch FROM (
    SELECT codepoint FROM comp_index WHERE comp_cp IN (0x65E5,0x6708,0x76BF)
     GROUP BY codepoint HAVING COUNT(DISTINCT comp_cp)=3
  ) c JOIN ids i ON i.codepoint=c.codepoint ORDER BY c.codepoint LIMIT 8`))
  console.log(`  ${r.ch}`);
db.close();
console.log("==========================================");
