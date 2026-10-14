#!/usr/bin/env bun
/**
 * load-ids.ts — 把 unicode-cjk-ids 載入 sqlite，並與 KAGE 部件做對接。
 *
 * 用法:
 *   bun run tools/load-ids.ts [--ids unicode-cjk-ids/All.txt] [--db db/glyphwiki.db]
 *
 * 產出四張表:
 *   ids_ops  : 12 個 IDS 算子（U+2FF0..U+2FFB）的字元與名稱
 *   ids      : 每列 IDS 資料（碼位、字元、IDS 序列、最外層算子、分量數、旗標）
 *   ids_comp : IDS 序列中的每個分量（含算子與括號），記錄其在序列中的序號
 *   ids_ref  : 對接表 —「某字的第 i 個直接 KAGE 部件」↔「IDS 的第 j 個分量」
 *
 * 對接策略:
 *   唯一方法是「按碼位做 LCS 序列對齊」。實測發現 KAGE 的子部件順序與 IDS 分量順序
 *   不保證一致（例如 U+3D64「⿰氵翜」的 KAGE 子部件是 翜、氵，順序相反），
 *   所以按位置配對會產生語意錯誤的對接。
 *   輸出依品質分三級（ids_ref.method）:
 *     exact  : 全部 IDS 分量都配對到，且兩側數量相等
 *     prefix : 全部 IDS 分量都配對到，但 KAGE 部件較多（IDS 只寫到某一層）
 *     lcs    : 部分配對
 *   --method 參數保留但已無作用（一律做 LCS）。
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------- args

const argv = Bun.argv.slice(2);
let idsPath = "unicode-cjk-ids/All.txt";
let dbPath = "db/glyphwiki.db";
let method: "prefix" | "exact" | "both" = "both";
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--ids") idsPath = argv[++i]!;
  else if (argv[i] === "--db") dbPath = argv[++i]!;
  else if (argv[i] === "--method") method = argv[++i] as any;
  else if (argv[i] === "-h" || argv[i] === "--help") {
    console.log("usage: bun run tools/load-ids.ts [--ids <path>] [--db <path>] [--method prefix|exact|both]");
    process.exit(0);
  }
}
const IDS = resolve(idsPath);
const DB = resolve(dbPath);
if (!existsSync(IDS)) {
  console.error(`ids file not found: ${IDS}`);
  process.exit(1);
}
if (!existsSync(DB)) {
  console.error(`db not found: ${DB}\n先執行: bun run tools/build-db.ts`);
  process.exit(1);
}

// ---------------------------------------------------------------- IDS 算子表

const OPERATORS: [number, string, string, number][] = [
  // codepoint, 字元, 名稱, 分量數
  [0x2ff0, "⿰", "left-to-right", 2],
  [0x2ff1, "⿱", "above-below", 2],
  [0x2ff2, "⿲", "left-middle-right", 3],
  [0x2ff3, "⿳", "above-middle-below", 3],
  [0x2ff4, "⿴", "full surround", 2],
  [0x2ff5, "⿵", "surround from above", 2],
  [0x2ff6, "⿶", "surround from below", 2],
  [0x2ff7, "⿷", "surround from left", 2],
  [0x2ff8, "⿸", "surround from upper left", 2],
  [0x2ff9, "⿹", "surround from upper right", 2],
  [0x2ffa, "⿺", "surround from lower left", 2],
  [0x2ffb, "⿻", "overlaid", 2],
];
const OP_SET = new Set(OPERATORS.map((o) => o[1]));
const OP_ARITY = new Map(OPERATORS.map((o) => [o[1], o[3]] as [string, number]));
const IDEOGRAPHIC_DESCRIPTION = /^[\u2FF0-\u2FFB]$/;

/** IDS 的 &CDP-88F1; 與 KAGE 的 cdp-88f1-01 正規化成同一個鍵 'cdp:88f1'。
 *  只認得 CDP / GT / KP / UCS 這幾種外部來源前綴，避免把一般字形名誤判。 */
function cdpKeyOf(s: string): string | null {
  const t = s.replace(/^&/, "").replace(/;$/, "").trim().toLowerCase();
  const m = /^(cdp|gt|kp|ucs|jef|chise)-?([0-9a-f]{4,6})(?:-\d+)?$/.exec(t);
  if (!m) return null;
  return m[1] + ":" + m[2];
}

// ---------------------------------------------------------------- schema

const db = new Database(DB);
db.exec("PRAGMA synchronous = OFF;");
db.exec("PRAGMA temp_store = MEMORY;");
db.exec("PRAGMA cache_size = -200000;");

db.exec(`
DROP TABLE IF EXISTS ids_ops;
DROP TABLE IF EXISTS ids;
DROP TABLE IF EXISTS ids_comp;
DROP TABLE IF EXISTS ids_ref;
DROP TABLE IF EXISTS ids_tree_align;

CREATE TABLE ids_ops (
  op        TEXT PRIMARY KEY,   -- '⿰'
  codepoint INTEGER NOT NULL,   -- 0x2FF0
  name      TEXT NOT NULL,
  n_comp    INTEGER NOT NULL
);

CREATE TABLE ids (
  codepoint   INTEGER PRIMARY KEY,   -- U+4E00 -> 0x4E00
  name        TEXT NOT NULL,         -- 'u4e00'
  ch          TEXT NOT NULL,         -- '一'
  seq         TEXT NOT NULL,         -- IDS 序列（可能為空）
  outer_op    TEXT,                  -- 最外層算子；無則 NULL
  outer_op_cp INTEGER,
  n_comp      INTEGER NOT NULL,      -- 序列中的分量總數（含所有層級）
  n_op        INTEGER NOT NULL,      -- 序列中的算子總數
  depth       INTEGER NOT NULL,      -- 最大嵌套深度
  atomic      INTEGER NOT NULL,      -- 1 = 序列就是字本身（沒有分解）
  is_variant  INTEGER NOT NULL,      -- 序列以 '&' 開頭（異體）
  is_doubtful INTEGER NOT NULL,      -- 序列以 '?' 開頭（存疑）
  has_nontrivial INTEGER NOT NULL    -- 分量中含有非單一碼位的項（少見）
);

CREATE TABLE ids_comp (
  codepoint INTEGER NOT NULL,   -- 這個 IDS 屬於哪個字
  pos       INTEGER NOT NULL,   -- 在整個序列中的出現序號（由 0 起）
  ch        TEXT NOT NULL,      -- 分量的字元（可能是 &CDP-88F1; 這種整串）
  comp_cp   INTEGER,            -- 單一碼位分量時為其碼位；否則 NULL
  cdp_key   TEXT,               -- &CDP-88F1; / cdp-88f1-01 → 'cdp:88f1'
  kind      TEXT NOT NULL,      -- 'op' 算子 | 'char' 分量字
  depth     INTEGER NOT NULL,   -- 巢狀深度（最外層算子 = 0）
  group_ix  INTEGER NOT NULL,   -- 同一層的第幾個分量（0 起）
  PRIMARY KEY (codepoint, pos)
) WITHOUT ROWID;

CREATE TABLE ids_ref (
  codepoint INTEGER NOT NULL,   -- 這個字
  ids_pos   INTEGER NOT NULL,   -- IDS 分量的出現序號（對應 ids_comp.pos）
  part_idx  INTEGER NOT NULL,   -- KAGE parts.idx
  part_idx2 INTEGER,            -- 合併規則下的第二個 parts.idx，否則 NULL
  part_name TEXT NOT NULL,      -- KAGE 中被引用的名字（如 u5317-03）
  part_cp   INTEGER,            -- 解析出的碼位（由名字的 uXXXX 取得）
  part_cdp  TEXT,               -- 由名字取得的 CDP 鍵（如 cdp:88f1）
  part_cp_verified INTEGER NOT NULL, -- 1 = 名字含可解析的 uXXXX
  part_suffixed INTEGER NOT NULL, -- 1 = 名字帶後綴（用到異體部件）
  group_ix  INTEGER NOT NULL,
  depth     INTEGER NOT NULL,
  p1x INTEGER, p1y INTEGER, p2x INTEGER, p2y INTEGER,
  method    TEXT NOT NULL,      -- 'exact' | 'prefix' | 'lcs'（對接品質分級）
  merged    INTEGER NOT NULL,   -- 1 = 這一組由多個 KAGE 部件合併
  PRIMARY KEY (codepoint, ids_pos, part_idx)
) WITHOUT ROWID;

CREATE TABLE ids_tree_align (
  codepoint     INTEGER NOT NULL,   -- 頂層字
  ids_path      TEXT NOT NULL,      -- IDS 樹中的位置路徑（如 "1/1"）：真正唯一的識別
  ids_pos       INTEGER NOT NULL,   -- IDS 分量的出現序號（同字內不同子樹會重複）
  ids_ch        TEXT,               -- IDS 分量的字元
  ids_depth     INTEGER NOT NULL,   -- 該分量在 IDS 樹中的深度
  slot          TEXT,               -- 槽位：'算子:同層序號'，如 '⿰:0'、'⿱:1'
  part_name     TEXT,               -- 對到的 KAGE 節點名（NULL = 找不到）
  kage_parent   TEXT,               -- 該 KAGE 節點的父節點名
  part_cp       INTEGER,
  part_cdp      TEXT,
  part_suffixed INTEGER NOT NULL,
  kage_depth    INTEGER NOT NULL,   -- 對到的節點在本字 KAGE 樹中的深度
  part_path     TEXT,               -- 由頂層子部件往下的路徑
  p1x INTEGER, p1y INTEGER, p2x INTEGER, p2y INTEGER,
  kage_leaf     INTEGER NOT NULL,   -- 1 = 對到的 KAGE 節點沒有子部件
  quality       INTEGER NOT NULL,   -- 3 嚴格 / 2 -j別名 / 1 子樹搜尋 / 0 找不到
  searched      INTEGER NOT NULL,   -- 1 = 這一列是子樹搜尋來的
  PRIMARY KEY (codepoint, ids_path)
);
CREATE INDEX idx_talign_cp   ON ids_tree_align(codepoint);
CREATE INDEX idx_talign_part ON ids_tree_align(part_cp);
`);

// ---------------------------------------------------------------- 讀 IDS

const insOp = db.prepare("INSERT INTO ids_ops (op, codepoint, name, n_comp) VALUES (?,?,?,?)");
const insIds = db.prepare(`
  INSERT INTO ids (codepoint, name, ch, seq, outer_op, outer_op_cp, n_comp, n_op, depth,
                   atomic, is_variant, is_doubtful, has_nontrivial)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
const insComp = db.prepare(
  "INSERT INTO ids_comp (codepoint, pos, ch, comp_cp, cdp_key, kind, depth, group_ix) VALUES (?,?,?,?,?,?,?,?)",
);

db.exec("BEGIN;");
for (const [cp, ch, name, nComp] of OPERATORS)
  insOp.run(ch, cp, name, nComp);

interface ParsedIds {
  seq: string;
  outerOp: string | null;
  nComp: number;
  nOps: number;
  depth: number;
  hasNonTrivial: boolean;
  comps: { ch: string; compCp: number | null; cdpKey: string | null; kind: string; depth: number; groupIx: number }[];
}

function parseIds(seq: string): ParsedIds {
  let s = seq;
  let isVariant = false;
  let isDoubtful = false;
  if (s.startsWith("&")) {
    isVariant = true;
    s = s.slice(1);
  }
  if (s.startsWith("?")) {
    isDoubtful = true;
    s = s.slice(1);
  }

  // 先切成 token：&CDP-88F1; 這種整串是一個分量，其餘逐碼位
  const tokens: string[] = [];
  {
    let k = 0;
    const arr = Array.from(s);
    while (k < arr.length) {
      if (arr[k] === "&") {
        let e = k + 1;
        while (e < arr.length && arr[e] !== ";") e++;
        if (e < arr.length) {
          tokens.push(arr.slice(k, e + 1).join(""));
          k = e + 1;
          continue;
        }
      }
      tokens.push(arr[k]!);
      k++;
    }
  }

  const comps: ParsedIds["comps"] = [];
  let nOps = 0;
  let maxDepth = 0;
  let pos = 0;
  const stack: number[] = []; // 每一層已收分量數

  let i = 0;
  while (i < tokens.length) {
    const ch = tokens[i]!;
    const depth = stack.length;
    if (ch === "(" || ch === ")") {
      i++;
      continue;
    }
    if (OP_SET.has(ch)) {
      nOps++;
      stack.push(0);
      comps.push({ ch, compCp: ch.codePointAt(0)!, cdpKey: null, kind: "op", depth, groupIx: -1 });
      pos++;
      if (stack.length > maxDepth) maxDepth = stack.length;
      i++;
      continue;
    }
    // 一般分量：單一碼位，或是 &CDP-XXXX; 這種整串描述
    const isSingle = Array.from(ch).length === 1;
    const cp = isSingle ? ch.codePointAt(0)! : null;
    const cdpKey = isSingle ? null : cdpKeyOf(ch);
    const gi = stack.length > 0 ? stack[stack.length - 1]! : 0;
    if (stack.length > 0) stack[stack.length - 1] = gi + 1;
    comps.push({ ch, compCp: cp, cdpKey, kind: "char", depth, groupIx: gi });
    pos++;
    i++;
  }

  let nComp = 0;
  for (const c of comps) if (c.kind === "char") nComp++;

  return {
    seq: s,
    outerOp: comps.length > 0 && comps[0]!.kind === "op" ? comps[0]!.ch : null,
    nComp,
    nOps,
    depth: maxDepth,
    hasNonTrivial: false,
    comps,
  };
}

let nRow = 0;
let nAtomic = 0;
let nVariant = 0;
let nDoubtful = 0;
let nNoSeq = 0;
const decoder = new TextDecoder();
let carry = "";

const insIdsRun = (cp: number, ch: string, p: ParsedIds) => {
  insIds.run(
    cp,
    "u" + cp.toString(16).toLowerCase().padStart(4, "0"),
    ch,
    p.seq,
    p.outerOp,
    p.outerOp ? p.outerOp.codePointAt(0)! : null,
    p.nComp,
    p.nOps,
    p.depth,
    p.comps.length > 0 && p.comps[0]!.kind !== "op" ? 1 : 0,
    p.seq.startsWith("&") ? 1 : 0,
    p.seq.startsWith("?") ? 1 : 0,
    0,
  );
  for (let k = 0; k < p.comps.length; k++) {
    const c = p.comps[k]!;
    insComp.run(cp, k, c.ch, c.compCp, c.cdpKey, c.kind, c.depth, c.groupIx);
  }
};

const file = Bun.file(IDS);
for await (const chunk of file.stream()) {
  const text = carry + (typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
  carry = "";
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      carry = text.slice(start);
      break;
    }
    const line = text.slice(start, nl);
    start = nl + 1;
    if (line.trim() === "") continue;
    const f = line.split("\t");
    if (f.length < 3) continue;
    const m = /^U\+([0-9A-Fa-f]+)$/.exec(f[0]!.trim());
    if (!m) continue;
    const cp = parseInt(m[1]!, 16);
    const ch = f[1]!;
    const seqRaw = f[2]!.trim();
    const p = parseIds(seqRaw);
    insIdsRun(cp, ch, p);
    nRow++;
    if (p.seq.startsWith("&")) nVariant++;
    if (p.seq.startsWith("?")) nDoubtful++;
    if (p.seq === "") nNoSeq++;
    if (p.comps.length > 0 && p.comps[0]!.kind !== "op") nAtomic++;
  }
}
db.exec("COMMIT;");

const tLoaded = performance.now();
console.log(
  `IDS 載入: ${nRow.toLocaleString()} 列（原子 ${nAtomic.toLocaleString()}、異體 &${nVariant.toLocaleString()}、存疑 ?${nDoubtful.toLocaleString()}、空序列 ${nNoSeq.toLocaleString()}）`,
);

// ---------------------------------------------------------------- 對接
//
// 重要教訓（實測）：KAGE 的子部件順序與 IDS 分量順序**不保證一致**，
// 例如 U+3D64「⿰氵翜」的 KAGE 子部件是 u7fdc-j(翜)、u6c35-01(氵)，順序相反。
// 因此「按位置配對」的做法會產生語意錯誤的對接（實測僅 1.1% 碼位相符）。
// 唯一可靠的做法是**按碼位做序列對齊（LCS）**。
//
// 對接品質分級（欄位 method）：
//   'exact'  : LCS 配對了全部 IDS 分量，且兩側數量相等（最強）
//   'prefix' : LCS 配對了全部 IDS 分量，但 KAGE 部件較多（IDS 只寫到某一層）
//   'lcs'    : 部分配對（有的分量在 KAGE 中找不到對應）

const buildRefs = (tier: "all" = "all") => {
  void tier;
  const rows = db
    .query(`SELECT i.codepoint, i.name, i.seq FROM ids i WHERE i.outer_op IS NOT NULL`)
    .all() as { codepoint: number; name: string; seq: string }[];

  const insRef = db.prepare(`
    INSERT OR REPLACE INTO ids_ref
      (codepoint, ids_pos, part_idx, part_idx2, part_name, part_cp, part_cdp, part_cp_verified,
       part_suffixed, group_ix, depth, p1x, p1y, p2x, p2y, method, merged)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const getComps = db.query(
    "SELECT pos, ch, comp_cp, cdp_key, kind, depth, group_ix FROM ids_comp WHERE codepoint = ? AND kind = 'char' ORDER BY pos",
  );
  const getParts = db.query(
    `SELECT idx, comp, p1x, p1y, p2x, p2y FROM parts WHERE glyph = ? AND kind = 99 ORDER BY idx`,
  );

  // 名字形式：uXXXX、uXXXX-後綴、uXXXX-後綴@版本、cdp-XXXX-…。後綴與 @ 版本都算「帶後綴」。
  const CP_RE = /^u([0-9a-f]{4,6})/i;
  // IDS 用 &CDP-88F1; 形式，KAGE 用 cdp-88f1-01 形式 → 正規化成 'cdp:88f1'
  const CDP_RE = /^(?:&)?(?:cdp|gt|kp|ue|u)-?([0-9a-f]{4,6})/i;
  const getPartsAll = (glyphName: string) => {
    const own = getParts.all(glyphName) as any[];
    for (const r of own) {
      // 部件身分一律取名字裡的 uXXXX（不是被引用字形自身的碼位）
      const m = CP_RE.exec(r.comp ?? "");
      r.name_cp = m ? parseInt(m[1]!, 16) : null;
      r.suffixed = m && m[2] ? 1 : 0;
      r.comp_cp = r.name_cp;
      r.cdp_key = m ? null : cdpKeyOf(r.comp ?? "");
      // 相容別名：u7fdc-j 之於 U+7FDC
      const alt = /^u([0-9a-f]{4,6})-j$/i.exec(r.comp ?? "");
      r.alt_cp = alt ? parseInt(alt[1]!, 16) : null;
    }
    return own;
  };

  const eq = (c: any, p: any) =>
    (c.comp_cp != null && p.comp_cp != null && c.comp_cp === p.comp_cp) ||
    (c.cdp_key != null && p.cdp_key != null && c.cdp_key === p.cdp_key);

  /** 寬鬆相符：允許 KAGE 部件是該碼位的日標別名（base 或 -j） */
  const eqLoose = (c: any, p: any) =>
    eq(c, p) || (c.comp_cp != null && p.alt_cp != null && c.comp_cp === p.alt_cp);

  let nRef = 0;
  let nGlyph = 0;
  let nNoChild = 0;
  let nUnmatched = 0;
  let nMerged = 0;
  let nTierExact = 0;
  let nTierPrefix = 0;
  let nTierLcs = 0;

  const emit = (cp: number, c: any, ps: any[], tier: string) => {
    const p0 = ps[0]!;
    insRef.run(
      cp,
      c.pos,
      p0.idx,
      ps.length > 1 ? ps[1]!.idx : null,
      ps.map((x) => x.comp).join("+"),
      p0.comp_cp,
      p0.cdp_key,
      p0.name_cp != null ? 1 : 0,
      ps.some((x) => x.suffixed) ? 1 : 0,
      c.group_ix,
      c.depth,
      p0.p1x,
      p0.p1y,
      p0.p2x,
      p0.p2y,
      tier,
      ps.length > 1 ? 1 : 0,
    );
    nRef++;
    if (ps.length > 1) nMerged++;
  };

  for (const row of rows) {
    const comps = getComps.all(row.codepoint) as any[];
    const parts = getPartsAll(row.name);
    if (comps.length === 0 || parts.length === 0) {
      nNoChild++;
      continue;
    }
    const n = comps.length;
    const m = parts.length;

    // ---- LCS（按碼位）
    const dp: number[][] = Array.from({ length: n + 1 }, () =>
      new Array<number>(m + 1).fill(0),
    );
    for (let i = 1; i <= n; i++)
      for (let j = 1; j <= m; j++)
        dp[i]![j] = eq(comps[i - 1], parts[j - 1])
          ? dp[i - 1]![j - 1]! + 1
          : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);

    const pairs: [number, number][] = [];
    let i = n;
    let j = m;
    while (i > 0 && j > 0) {
      if (eq(comps[i - 1], parts[j - 1]) && dp[i]![j] === dp[i - 1]![j - 1]! + 1) {
        pairs.push([i - 1, j - 1]);
        i--;
        j--;
      } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) i--;
      else j--;
    }
    pairs.reverse();

    if (pairs.length === 0) {
      nUnmatched++;
      continue;
    }

    // 品質分級：全部 IDS 分量都配對到才算 exact/prefix
    //   exact  = 數量相等，且每一組都是嚴格相符（含 -j 別名者降為 prefix）
    //   prefix = 分量全配對到，但 KAGE 部件較多、或部分用了 -j 別名
    //   lcs    = 只配對到一部分
    const allCompsMatched = pairs.length === n;
    const allStrict = pairs.every(([ci, pj]) => eq(comps[ci], parts[pj]));
    const tier = !allCompsMatched ? "lcs" : n === m && allStrict ? "exact" : "prefix";
    if (tier === "exact") nTierExact++;
    else if (tier === "prefix") nTierPrefix++;
    else nTierLcs++;

    const usedParts = new Set(pairs.map(([, pj]) => pj));
    const unmatchedComps = [];
    for (let x = 0; x < n; x++) if (!pairs.some(([ci]) => ci === x)) unmatchedComps.push(x);
    const leftoverParts = [];
    for (let y = 0; y < m; y++) if (!usedParts.has(y)) leftoverParts.push(y);

    // 規則 A：兩側剩餘數量相同 → 依位置合併配對（KAGE 常把一個 IDS 分量拆成多筆）
    if (
      unmatchedComps.length === leftoverParts.length &&
      unmatchedComps.length > 0 &&
      tier === "exact"
    ) {
      for (let k = 0; k < unmatchedComps.length; k++) {
        const ci = unmatchedComps[k]!;
        emit(row.codepoint, comps[ci]!, [parts[leftoverParts[k]!]!], tier);
      }
    } else {
      // 規則 B：其餘未配對的分量，各與一個未使用的部件配對（依位置）
      const rest = Math.min(unmatchedComps.length, leftoverParts.length);
      for (let k = 0; k < rest; k++) {
        const ci = unmatchedComps[k]!;
        emit(row.codepoint, comps[ci]!, [parts[leftoverParts[k]!]!], tier);
      }
    }
    for (const [ci, pj] of pairs) emit(row.codepoint, comps[ci]!, [parts[pj]!], tier);
    nGlyph++;
  }
  return {
    nRef, nGlyph, nNoChild, nMismatch: nUnmatched, nMerged,
    nTierExact, nTierPrefix, nTierLcs, nRows: rows.length,
  };
};

const tRefStart = performance.now();
console.log("建立對接表（碼位對齊）…");
db.exec("DELETE FROM ids_ref;");
const res = buildRefs();
console.log(
  `  對接 ${res.nRef.toLocaleString()} 組，涵蓋 ${res.nGlyph.toLocaleString()} 字` +
    `（無子部件 ${res.nNoChild.toLocaleString()}，完全對不上 ${res.nMismatch.toLocaleString()}，多部件合併 ${res.nMerged.toLocaleString()}）` +
    `  ${((performance.now() - tRefStart) / 1000).toFixed(1)}s`,
);
console.log(
  `  品質分級: exact ${res.nTierExact.toLocaleString()} 字 / prefix ${res.nTierPrefix.toLocaleString()} 字 / lcs(部分) ${res.nTierLcs.toLocaleString()} 字`,
);

// ---------------------------------------------------------------- 樹對樹遞歸對齊
//
// 目的：把 IDS 樹與 KAGE 樹做**真正的遞歸對齊**，找出兩棵樹的結構差異。
//
// 例如「盟 ⿱明皿、明 ⿰日月」：
//   盟 KAGE → u76df-j → u660e-03(明) + u76bf-04(皿)      → 對齊：明/皿 在第一層
//   明 KAGE → u660e-j → u65e5-01(日) + u6708-02(月)      → 再遞歸：日/月 在第二層
// 若某字的 KAGE 把「日 月 皿」攤平在同一層，這裡就會顯示成
//   ids 的 日 對到 KAGE 深度 1 的節點，而不是深度 2 → 結構被攤平的證據。
//
// 品質等級（ids_tree_align.quality）:
//   3 = LCS 直接對到，且碼位嚴格相同
//   2 = LCS 直接對到，但只是 -j 別名相符
//   1 = 不在 LCS 配對中，是在子樹裡搜尋到的（結構位置不吻合）
//   0 = 找不到對應（例如 KAGE 側那個節點根本沒有子部件）

interface IdsTreeNode {
  pos: number;
  ch: string;
  cp: number | null;
  cdpKey: string | null;
  idsDepth: number;
  groupIx: number;
  isOp: boolean;
  children: IdsTreeNode[];
}

/** 由 ids_comp 的扁平表還原 IDS 樹。
 *  解析器已為每個 token 記下 depth 與 group_ix（同層序號），所以樹是明確的：
 *    一個分量的兒子，就是「所有 depth+1、且落在它所涵蓋 token 範圍內」的 token。
 *  這裡不用算子 arity 做推斷（先前用 arity 推斷會在多碼位分量上出錯），
 *  改為先走一遍算出「每個 token 涵蓋的結束位置」，再遞迴組樹。 */
function buildIdsTree(db: Database, np: number): { root: IdsTreeNode | null; leaves: number; mismatch: number } {
  const rows = db
    .query(
      `SELECT pos, ch, comp_cp, cdp_key, kind, depth, group_ix
         FROM ids_comp WHERE codepoint = ? ORDER BY pos`,
    )
    .all(np) as any[];
  if (rows.length === 0) return { root: null, leaves: 0, mismatch: 0 };
  const origChars = rows.filter((r) => r.kind === "char").length;

  const mk = (r: any): IdsTreeNode => ({
    pos: r.pos,
    ch: r.ch,
    cp: r.comp_cp,
    cdpKey: r.cdp_key,
    idsDepth: r.depth,
    groupIx: r.group_ix,
    isOp: r.kind === "op",
    children: [],
  });

  // span(i) = 以 i 為根的整棵子樹結束位置（含）
  const span = new Array<number>(rows.length).fill(0);
  for (let i = rows.length - 1; i >= 0; i--) {
    const d = rows[i]!.depth;
    let e = i;
    for (let k = i + 1; k < rows.length; k++) {
      if (rows[k]!.depth > d) e = k;
      else break;
    }
    span[i] = e;
  }

  let treeLeaves = 0;
  const build = (i: number): IdsTreeNode => {
    const node = mk(rows[i]!);
    const d = rows[i]!.depth;
    let k = i + 1;
    while (k < rows.length && rows[k]!.depth > d) {
      const child = build(k);
      node.children.push(child);
      k = span[k]! + 1;
    }
    if (!node.isOp) treeLeaves++;
    return node;
  };

  const root = build(0);
  return {
    root,
    leaves: treeLeaves,
    mismatch: treeLeaves === origChars ? 0 : 1,
  };
}

const buildTreeAlign = () => {
  const getPartsOf = db.query(
    `SELECT idx, comp, p1x, p1y, p2x, p2y FROM parts WHERE glyph = ? AND kind = 99 ORDER BY idx`,
  );
  // 名字形式：uXXXX、uXXXX-後綴、uXXXX-後綴@版本、cdp-XXXX-…。後綴與 @ 版本都算「帶後綴」。
  const CP_RE = /^u([0-9a-f]{4,6})/i;
  const keyOfName = (n: string): string | null => {
    const m = CP_RE.exec(n);
    if (m) return "u" + m[1]!.toLowerCase();
    const c = cdpKeyOf(n);
    return c;
  };
  const suffixedOf = (n: string): number => {
    const m = /^(?:u[0-9a-f]{4,6}|cdp-[0-9a-f]{4,6})(-.*)?$/i.exec(n);
    return m && m[1] ? 1 : 0;
  };
  const keyOfNode = (t: IdsTreeNode): string | null =>
    t.cp != null ? "u" + t.cp.toString(16) : t.cdpKey;

  const ins = db.prepare(`
    INSERT INTO ids_tree_align
      (codepoint, ids_path, ids_pos, ids_ch, ids_depth, slot, part_name, kage_parent, part_cp, part_cdp,
       part_suffixed, kage_depth, part_path, p1x, p1y, p2x, p2y,
       kage_leaf, quality, searched)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  db.exec("DELETE FROM ids_tree_align;");
  db.exec("BEGIN;");

  let nRow = 0;
  const stat = { q3: 0, q2: 0, q1: 0, q0: 0 };
  let nGlyph = 0;
  let nSearchCalls = 0;
  let nTreeMismatch = 0;
  const SEARCH_BUDGET = 250_000;
  let searchExhausted = false;

  /** 在子樹中搜尋符合 key 的節點（廣度優先，回傳第一個） */
  const searchSubtree = (
    key: string,
    candidates: any[],
    depth: number,
    path: string,
  ): { node: any; depth: number; path: string } | null => {
    if (searchExhausted) return null;
    if (++nSearchCalls > SEARCH_BUDGET) {
      searchExhausted = true;
      return null;
    }
    const queue: { n: any; d: number; p: string }[] = candidates.map((c) => ({
      n: c,
      d: depth,
      p: path ? path + "/" + c.comp : c.comp,
    }));
    let head = 0;
    while (head < queue.length && queue.length < 400) {
      const cur = queue[head++]!;
      if (keyOfName(cur.n.comp) === key) return { node: cur.n, depth: cur.d, path: cur.p };
      const kids = getPartsOf.all(cur.n.comp) as any[];
      if (kids.length === 0) continue;
      for (const k of kids)
        queue.push({
          n: k,
          d: cur.d + 1,
          p: cur.p + "/" + k.comp,
        });
    }
    return null;
  };

  /** 收集子樹的所有節點（給 LCS 用） */
  const collectNodes = (
    node: IdsTreeNode,
    cands: any[],
    depth: number,
    path: string,
    out: { node: any; depth: number; path: string }[],
    seen: Set<string>,
  ) => {
    if (seen.size > 64) return;
    for (const c of cands) {
      out.push({ node: c, depth, path: path ? path + "/" + c.comp : c.comp });
      const kids = getPartsOf.all(c.comp) as any[];
      if (kids.length === 0) continue;
      if (seen.has(c.comp)) continue;
      const s2 = new Set(seen);
      s2.add(c.comp);
      collectNodes(node, kids, depth + 1, path ? path + "/" + c.comp : c.comp, out, s2);
    }
  };

  let curGlyph = -1;
  const treeCache = new Map<number, { root: IdsTreeNode | null; leaves: number; mismatch: number }>();
  // 除錯用：偵測同一 (codepoint, ids_pos) 被 emit 兩次
  const seenEmit = new Set<string>();
  const dupExamples: string[] = [];
  let nDup = 0;
  const DUMP = process.env.DEBUG_TREE === "1";

  /** node 底下已存在的 KAGE 節點（不含 node 自己） */
  const candidatesUnder = (rootName: string) => {
    const out: { node: any; depth: number; path: string; parent: string | null }[] = [];
    const walk = (n: string, d: number, p: string, seen: Set<string>) => {
      if (out.length > 300) return;
      const kids = getPartsOf.all(n) as any[];
      for (const k of kids) {
        out.push({
          node: k,
          depth: d,
          path: p ? p + "/" + k.comp : k.comp,
          parent: n,
        });
        if (seen.has(k.comp)) continue;
        const s2 = new Set(seen);
        s2.add(k.comp);
        walk(k.comp, d + 1, p ? p + "/" + k.comp : k.comp, s2);
      }
    };
    walk(rootName, 1, "", new Set([rootName]));
    return out;
  };

  const rowsToDo = db
    .query(
      `SELECT i.codepoint, i.name FROM ids i
        WHERE i.outer_op IS NOT NULL
          AND EXISTS (SELECT 1 FROM parts p WHERE p.glyph = i.name AND p.kind = 99)`,
    )
    .all() as { codepoint: number; name: string }[];

  for (const g of rowsToDo) {
    let cached = treeCache.get(g.codepoint);
    if (!cached) {
      cached = buildIdsTree(db, g.codepoint);
      treeCache.set(g.codepoint, cached);
    }
    const root = cached.root;
    if (cached.mismatch) nTreeMismatch++;
    if (!root || !root.isOp) continue;
    curGlyph = g.codepoint;
    seenEmit.clear(); // 逐字重置

    // 傳入的是某棵 IDS 子樹的根（算子節點），實際配對的是它的字元子節點。
    // prefix = 這棵子樹在頂層字中的位置路徑（如 "1/1"）；去重必須用它，
    // 不能只用 ids_pos —— 不同子樹的 pos 會重疊（盟的皿 與 明的月 都是 pos=2）。
    const alignNode = (
      node: IdsTreeNode,
      cands: { node: any; depth: number; path: string; parent?: string | null }[],
      prefix: string,
    ) => {
      const kids = node.children.filter((c) => !c.isOp);
      const opChar = node.ch;
      if (kids.length === 0) return;

      const m = cands.length;
      const n = kids.length;
      const dp: number[][] = Array.from({ length: n + 1 }, () =>
        new Array<number>(m + 1).fill(0),
      );
      const eqIdx = (a: number, b: number) => {
        const kk = keyOfNode(kids[a]!);
        return kk != null && keyOfName(cands[b]!.node.comp) === kk;
      };
      for (let i = 1; i <= n; i++)
        for (let j = 1; j <= m; j++)
          dp[i]![j] = eqIdx(i - 1, j - 1)
            ? dp[i - 1]![j - 1]! + 1
            : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);

      const used = new Set<number>();
      const pairs: [number, number][] = [];
      let i = n;
      let j = m;
      while (i > 0 && j > 0) {
        if (eqIdx(i - 1, j - 1) && dp[i]![j] === dp[i - 1]![j - 1]! + 1) {
          pairs.push([i - 1, j - 1]);
          used.add(j - 1);
          i--;
          j--;
        } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) i--;
        else j--;
      }
      pairs.reverse();

      const emit = (
        kid: IdsTreeNode,
        part: any | null,
        kageDepth: number,
        partPath: string,
        quality: number,
        searched: number,
        kageParent: string | null,
      ) => {
        const strict = part ? keyOfName(part.comp) === keyOfNode(kid) : false;
        const q = part == null ? 0 : quality === 1 ? 1 : strict ? 3 : 2;
        const cpM = part ? CP_RE.exec(part.comp) : null;
        const seenKey = curGlyph + "|" + prefix + "|" + kid.pos;
        if (seenEmit.has(seenKey)) {
          nDup++;
          if (dupExamples.length < 20)
            dupExamples.push(
              `U+${curGlyph.toString(16).toUpperCase()} pos=${kid.pos} ch=${kid.ch} d=${kid.idsDepth} part=${part?.comp ?? "null"}`,
            );
          return; // 同一 IDS 節點只寫一次
        }
        seenEmit.add(seenKey);
        ins.run(
          curGlyph,
          prefix + "/" + kid.pos,
          kid.pos,
          kid.ch,
          kid.idsDepth,
          opChar + ":" + (kid.groupIx >= 0 ? kid.groupIx : 0),
          part ? part.comp : null,
          kageParent,
          cpM && cpM[1] ? parseInt(cpM[1]!, 16) : null,
          part && !cpM ? cdpKeyOf(part.comp) : null,
          part ? suffixedOf(part.comp) : 0,
          kageDepth,
          partPath,
          part ? part.p1x : null,
          part ? part.p1y : null,
          part ? part.p2x : null,
          part ? part.p2y : null,
          part ? (getPartsOf.all(part.comp).length > 0 ? 0 : 1) : 0,
          q,
          searched,
        );
        nRow++;
        if (q === 3) stat.q3++;
        else if (q === 2) stat.q2++;
        else if (q === 1) stat.q1++;
        else stat.q0++;
      };

      // LCS 配對到的 → emit + 往該節點的子樹遞歸
      for (const [ki, cj] of pairs) {
        const kid = kids[ki]!;
        const cand = cands[cj]!;
        emit(kid, cand.node, cand.depth, cand.path, 3, 0, cand.parent ?? null, prefix + "/" + ki);
        if (kid.cp == null) continue;
        const sub = treeCache.get(kid.cp) ?? buildIdsTree(db, kid.cp);
        // 這個分量自己也有分解 → 把它的子樹根交給 alignNode。
        // 重點：子樹根是子分解的算子（如 明 = ⿰日月 的 ⿰），alignNode 會取其字元子節點。
        if (sub.root && sub.root.children.some((c) => !c.isOp)) {
          const lower = candidatesUnder(cand.node.comp).map((x) => ({
            ...x,
            parent: cand.node.comp,
          }));
          alignNode(sub.root!, lower, prefix + "/" + ki);
        }
      }
      // 沒配對到的：先在剩餘子樹裡搜尋，找不到才記為 quality 0
      const free = cands.filter((_, idx) => !used.has(idx));
      for (let ki = 0; ki < n; ki++) {
        if (pairs.some(([a]) => a === ki)) continue;
        const kid = kids[ki]!;
        const key = keyOfNode(kid);
        const hit = key
          ? searchSubtree(key, free.map((f) => f.node), 1, "")
          : null;
        if (hit) {
          const cand = free.find((f) => f.node === hit.node);
          emit(
            kid,
            hit.node,
            cand ? cand.depth + hit.depth - 1 : hit.depth,
            hit.path,
            1,
            1,
            cand?.parent ?? null,
            prefix + "/" + ki,
          );
        } else {
          emit(kid, null, 0, "", 0, 0, null, prefix + "/" + ki);
        }
      }
    };

    // 起點：IDS 樹根對到本字 KAGE 樹的第一層
    const top = candidatesUnder(g.name);
    alignNode(root, top, "");
    nGlyph++;
  }

  db.exec("COMMIT;");
  return { nRow, nGlyph, ...stat, nSearchCalls, searchExhausted, nDup, dupExamples, nTreeMismatch };
};

const tDeep = performance.now();
console.log("建立樹對樹遞歸對齊…");
const deep = buildTreeAlign();
console.log(
  `  對齊 ${deep.nRow.toLocaleString()} 列，涵蓋 ${deep.nGlyph.toLocaleString()} 字  ${((performance.now() - tDeep) / 1000).toFixed(1)}s`,
);
console.log(
  `  品質: 嚴格 ${deep.q3.toLocaleString()} / -j別名 ${deep.q2.toLocaleString()} / 子樹搜尋 ${deep.q1.toLocaleString()} / 找不到 ${deep.q0.toLocaleString()}`,
);
if (deep.nTreeMismatch > 0) console.log(`  注意: ${deep.nTreeMismatch.toLocaleString()} 個字的 IDS 樹重建後字元數與解析不符`);
if (deep.nDup > 0) {
  console.log(`  警告: 有 ${deep.nDup.toLocaleString()} 次同一 IDS 節點重複 emit（樹建構不一致）`);
  for (const d of deep.dupExamples) console.log(`    ${d}`);
}
if (deep.searchExhausted)
  console.log(`  （子樹搜尋達預算上限 ${deep.nSearchCalls.toLocaleString()} 次，後續未搜尋）`);

// ---------------------------------------------------------------- 統一檢視表
//
// 上層 KAGE 節點與 IDS 分量的對應（quantity）：
//   3 = 淺層對接，碼位/CDP 完全相同（最可信）
//   2 = 淺層對接，部分相符
//   1 = 深層對接（IDS 分量對到更深的 KAGE 節點）
db.exec(`
DROP VIEW IF EXISTS ids_align;
CREATE VIEW ids_align AS
  SELECT r.codepoint, i.ch, i.seq, i.outer_op,
         r.ids_pos, c.ch AS ids_ch,
         r.part_name, r.part_cp, r.part_cdp, r.part_suffixed,
         r.p1x, r.p1y, r.p2x, r.p2y,
         1 AS kage_depth, r.part_name AS part_path,
         CASE r.method WHEN 'exact' THEN 3 WHEN 'prefix' THEN 3 ELSE 2 END AS confidence
    FROM ids_ref r
    JOIN ids i ON i.codepoint = r.codepoint
    LEFT JOIN ids_comp c ON c.codepoint = r.codepoint AND c.pos = r.ids_pos
  UNION ALL
  -- 深層：ids_ch 直接取自 ids_tree_align，不可再 join ids_comp.pos
  --（同一 ids_pos 在不同子樹會重複，join 會產生錯誤的錯位標籤）
  SELECT d.codepoint, i.ch, i.seq, i.outer_op,
         d.ids_pos, d.ids_ch,
         d.part_name, d.part_cp, d.part_cdp, d.part_suffixed,
         d.p1x, d.p1y, d.p2x, d.p2y,
         d.kage_depth, d.part_path,
         CASE d.quality WHEN 3 THEN 3 WHEN 2 THEN 3 WHEN 1 THEN 1 ELSE 0 END AS confidence
    FROM ids_tree_align d
    JOIN ids i ON i.codepoint = d.codepoint
   WHERE d.part_name IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM ids_ref r2
        WHERE r2.codepoint = d.codepoint AND r2.ids_pos = d.ids_pos);
`);



const tRef = performance.now();
console.log(`建立索引…`);
db.exec(`
CREATE INDEX IF NOT EXISTS idx_ids_comp_cp  ON ids_comp(comp_cp) WHERE comp_cp IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ids_outer    ON ids(outer_op_cp);
CREATE INDEX IF NOT EXISTS idx_idsref_cp    ON ids_ref(codepoint, method);
CREATE INDEX IF NOT EXISTS idx_idsref_part  ON ids_ref(part_cp);
`);
const tIdx = performance.now();
console.log(`  完成 ${((tIdx - tRef) / 1000).toFixed(1)}s`);

db.exec("ANALYZE;");
db.exec("PRAGMA optimize;");

// ---------------------------------------------------------------- 報告

const c = (n: any) => (n == null ? "-" : Number(n).toLocaleString());
const one = <T>(sql: string): T => db.query(sql).get() as T;
const all = <T>(sql: string): T[] => db.query(sql).all() as T[];

console.log("\n================ IDS 對接報告 ================");
console.log(
  `IDS 列數 ${c(one<any>("SELECT COUNT(*) n FROM ids").n)}  分量列 ${c(one<any>("SELECT COUNT(*) n FROM ids_comp").n)}  對接列 ${c(one<any>("SELECT COUNT(*) n FROM ids_ref").n)}`,
);

console.log("\n-- IDS 最外層算子分佈 --");
for (const r of all<any>(`
  SELECT i.outer_op op, o.name, COUNT(*) n
    FROM ids i LEFT JOIN ids_ops o ON o.op = i.outer_op
   WHERE i.outer_op IS NOT NULL GROUP BY i.outer_op ORDER BY n DESC`))
  console.log(`  ${r.op}  ${String(r.name).padEnd(24)} ${c(r.n)}`);

console.log("\n-- 對接品質分佈 --");
for (const m of ["exact", "prefix", "lcs"]) {
  const row = db
    .query(
      `SELECT COUNT(DISTINCT codepoint) g, COUNT(*) n FROM ids_ref WHERE method = ?`,
    )
    .get(m) as any;
  if (!row || !row.n) {
    console.log(`  ${m.padEnd(7)} 0`);
    continue;
  }
  console.log(`  ${m.padEnd(7)} 字 ${c(row.g)}  組 ${c(row.n)}`);
}

console.log("\n-- 有 IDS 且有直接子部件的字：對接情形 --");
const stat = one<any>(`
  WITH base AS (
    SELECT i.codepoint,
           (SELECT COUNT(*) FROM ids_comp c WHERE c.codepoint = i.codepoint AND c.kind='char') nc,
           (SELECT COUNT(*) FROM parts p WHERE p.glyph = i.name AND p.kind = 99) np
      FROM ids i WHERE i.outer_op IS NOT NULL
  )
  SELECT COUNT(*) total,
         SUM(CASE WHEN nc = np THEN 1 ELSE 0 END) equal,
         SUM(CASE WHEN nc > np THEN 1 ELSE 0 END) ids_more,
         SUM(CASE WHEN nc < np THEN 1 ELSE 0 END) kage_more
    FROM base WHERE np > 0`);
console.log(
  `  共 ${c(stat.total)}：分量數 == 部件數 ${c(stat.equal)}（${((stat.equal / stat.total) * 100).toFixed(1)}%）、IDS 較多 ${c(stat.ids_more)}、KAGE 較多 ${c(stat.kage_more)}`,
);

console.log("\n-- 用到帶後綴（異體）部件的對接比例 --");
for (const m of ["exact", "prefix", "lcs"]) {
  const row = db
    .query(
      `SELECT COUNT(*) n, SUM(part_suffixed) s, SUM(merged) mg, SUM(part_cp_verified) v
         FROM ids_ref WHERE method = ?`,
    )
    .get(m) as any;
  if (!row || !row.n) continue;
  console.log(
    `  ${m.padEnd(7)} 帶後綴 ${((row.s / row.n) * 100).toFixed(1)}%   碼位已驗證 ${((row.v / row.n) * 100).toFixed(1)}%   多部件合併 ${c(row.mg)}`,
  );
}

console.log("\n-- 對接樣本（exact 品質，⿰ 類，前 10）--");
for (const r of all<any>(`
  SELECT i.ch, i.seq, r.ids_pos, r.part_name, r.part_cp,
         (SELECT ch FROM ids_comp c WHERE c.codepoint = r.codepoint AND c.pos = r.ids_pos) ids_ch
    FROM ids_ref r JOIN ids i ON i.codepoint = r.codepoint
   WHERE r.method='exact' AND i.outer_op = '⿰'
   ORDER BY r.codepoint, r.ids_pos LIMIT 10`))
  console.log(
    `  ${r.ch} ${r.seq}  IDS「${r.ids_ch}」-> ${String(r.part_name).padEnd(16)} cp=${r.part_cp ? "U+" + r.part_cp.toString(16).toUpperCase() : "-"}`,
  );

console.log("\n-- 順序相反的例子（證明必須用 LCS）--");
for (const r of all<any>(`
  SELECT i.ch, i.seq,
         (SELECT GROUP_CONCAT(p.comp, ' , ') FROM parts p WHERE p.glyph = i.name AND p.kind = 99) kage_parts,
         (SELECT GROUP_CONCAT(c.ch, ' , ') FROM ids_comp c WHERE c.codepoint = i.codepoint AND c.kind='char') ids_comps
    FROM ids i
   WHERE i.codepoint IN (0x3D64, 0x3D79, 0x404A, 0x420A)`))
  console.log(`  ${r.ch} ${r.seq}\n      IDS 分量: ${r.ids_comps}\n      KAGE部件: ${r.kage_parts}`);

console.log("\n-- 語意相符率（對接的部件碼位 vs IDS 分量碼位）--");
for (const m of ["exact", "prefix", "lcs"]) {
  const row = db
    .query(
      `SELECT COUNT(*) n,
              SUM(CASE WHEN r.part_cp = c.comp_cp THEN 1 ELSE 0 END) same
         FROM ids_ref r JOIN ids_comp c ON c.codepoint = r.codepoint AND c.pos = r.ids_pos
        WHERE r.method = ? AND c.comp_cp IS NOT NULL AND r.part_cp IS NOT NULL`,
    )
    .get(m) as any;
  if (!row || !row.n) continue;
  console.log(
    `  ${m.padEnd(7)} ${c(row.same)} / ${c(row.n)} = ${((row.same / row.n) * 100).toFixed(1)}% 碼位相同`,
  );
}

console.log("\n-- 找不到對應子部件的 IDS 字（前 8 個）--");
for (const r of all<any>(`
  SELECT i.ch, i.seq, i.name FROM ids i
   WHERE i.outer_op IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM parts p WHERE p.glyph = i.name AND p.kind = 99)
   LIMIT 8`))
  console.log(`  ${r.ch} ${r.seq}  (${r.name})`);

console.log("\n-- 深層對接（遞歸展開到葉節點）--");
console.log(
  `  對接列 ${c(one<any>("SELECT COUNT(*) n FROM ids_tree_align").n)}   涵蓋字 ${c(one<any>("SELECT COUNT(DISTINCT codepoint) n FROM ids_tree_align").n)}`,
);
const covSplit = one<any>(`
  WITH need AS (
    SELECT i.codepoint, i.name,
           (SELECT COUNT(*) FROM ids_comp c WHERE c.codepoint=i.codepoint AND c.kind='char') nc
      FROM ids i WHERE i.outer_op IS NOT NULL
     AND EXISTS (SELECT 1 FROM parts p WHERE p.glyph=i.name AND p.kind=99)
  ),
  sh AS (SELECT codepoint, COUNT(DISTINCT ids_pos) g FROM ids_ref GROUP BY codepoint),
  dp AS (SELECT codepoint, COUNT(DISTINCT ids_pos) g FROM ids_tree_align GROUP BY codepoint)
  SELECT COUNT(*) total,
         SUM(CASE WHEN COALESCE(sh.g,0) >= need.nc THEN 1 ELSE 0 END) shallow_only,
         SUM(CASE WHEN COALESCE(sh.g,0) < need.nc AND COALESCE(dp.g,0) >= need.nc THEN 1 ELSE 0 END) deep_rescued,
         SUM(CASE WHEN COALESCE(dp.g,0) > 0 AND COALESCE(dp.g,0) < need.nc THEN 1 ELSE 0 END) partial,
         SUM(CASE WHEN COALESCE(dp.g,0) = 0 THEN 1 ELSE 0 END) none
    FROM need LEFT JOIN sh ON sh.codepoint=need.codepoint LEFT JOIN dp ON dp.codepoint=need.codepoint`);
console.log(`  覆蓋率拆解（共 ${c(covSplit.total)} 個有 IDS 且有 KAGE 子部件的字）:`);
console.log(`    淺層就全部對上:          ${c(covSplit.shallow_only)}`);
console.log(`    靠深層遞歸才全部對上:    ${c(covSplit.deep_rescued)}`);
console.log(`    只對上一部分:            ${c(covSplit.partial)}`);
console.log(`    KAGE 側無結構可取:       ${c(covSplit.none)}`);
console.log("  KAGE 樹深度分佈:");
for (const r of all<any>(
  `SELECT kage_depth, COUNT(*) n, COUNT(DISTINCT codepoint) g FROM ids_tree_align GROUP BY kage_depth ORDER BY kage_depth`,
))
  console.log(`    深度 ${r.kage_depth}: ${c(r.n)} 組 / ${c(r.g)} 字`);
console.log("  深層對接樣本（IDS 分量數 > 直接部件數者）:");
for (const r of all<any>(`
  SELECT i.ch, i.seq, d.ids_pos, d.ids_depth, d.kage_depth, d.part_path, d.part_cp,
         (SELECT ch FROM ids_comp c WHERE c.codepoint = d.codepoint AND c.pos = d.ids_pos) ids_ch
    FROM ids_tree_align d JOIN ids i ON i.codepoint = d.codepoint
   WHERE i.codepoint = 0x3D64 OR i.codepoint = 0x420A
   ORDER BY i.codepoint, d.ids_pos LIMIT 14`))
  console.log(
    `    ${r.ch} ${r.seq}  IDS「${r.ids_ch}」(深度${r.ids_depth}) -> ${String(r.part_path).padEnd(22)} [KAGE深度${r.kage_depth}] cp=${r.part_cp ? "U+" + r.part_cp.toString(16).toUpperCase() : "-"}`,
  );

console.log("\n-- 統一檢視表 ids_align（ids_ref ∪ ids_deep）--");
console.log(
  `  對接列 ${c(one<any>("SELECT COUNT(*) n FROM ids_align").n)}   涵蓋字 ${c(one<any>("SELECT COUNT(DISTINCT codepoint) n FROM ids_align").n)}`,
);
console.log("  可信度分佈（3=淺層完全相符, 2=淺層部分, 1=深層）:");
for (const r of all<any>(
  `SELECT confidence, COUNT(*) n, COUNT(DISTINCT codepoint) g FROM ids_align GROUP BY confidence ORDER BY confidence DESC`,
))
  console.log(`    ${r.confidence}: ${c(r.n)} 組 / ${c(r.g)} 字`);

const cov2 = one<any>(`
  WITH need AS (
    SELECT i.codepoint, i.name,
           (SELECT COUNT(*) FROM ids_comp c WHERE c.codepoint=i.codepoint AND c.kind='char') nc
      FROM ids i WHERE i.outer_op IS NOT NULL
     AND EXISTS (SELECT 1 FROM parts p WHERE p.glyph=i.name AND p.kind=99)
  ),
  got AS (SELECT codepoint, COUNT(*) g FROM ids_tree_align WHERE part_name IS NOT NULL GROUP BY codepoint)
  SELECT COUNT(*) glyphs,
         SUM(CASE WHEN COALESCE(got.g,0) >= need.nc THEN 1 ELSE 0 END) n_full,
         SUM(CASE WHEN COALESCE(got.g,0) > 0 AND got.g < need.nc THEN 1 ELSE 0 END) n_partial,
         SUM(CASE WHEN COALESCE(got.g,0) = 0 THEN 1 ELSE 0 END) n_none
    FROM need LEFT JOIN got ON got.codepoint = need.codepoint`);
console.log(
  `  最終覆蓋率: IDS 分量全對上 ${c(cov2.n_full)} 字 / 部分 ${c(cov2.n_partial)} / 完全沒有 ${c(cov2.n_none)}（共 ${c(cov2.glyphs)}）`,
);
console.log("  實際對到的節點，IDS 深度 vs KAGE 深度（只計已對上者）:");
for (const r of all<any>(`
  SELECT d.ids_depth, d.kage_depth, COUNT(*) n FROM ids_tree_align d
   WHERE d.part_name IS NOT NULL
   GROUP BY d.ids_depth, d.kage_depth ORDER BY n DESC LIMIT 8`))
  console.log(`    IDS深度 ${r.ids_depth} / KAGE深度 ${r.kage_depth}: ${c(r.n)} 組`);

db.close();
console.log("==============================================");
