#!/usr/bin/env bun
/**
 * q.ts — glyphwiki sqlite 查詢工具（取代每次重掃 292MB dump）。
 *
 * 用法:
 *   bun run tools/q.ts stat
 *   bun run tools/q.ts show   <name|u+XXXX> [...]      # 詳細資料 + 部件 + ASCII 框圖
 *   bun run tools/q.ts tree   <name> [--depth N]       # 遞歸展開組字樹
 *   bun run tools/q.ts refs   <name>                   # 誰引用了我
 *   bun run tools/q.ts uses   <name>                   # 我引用了誰（直接子部件）
 *   bun run tools/q.ts find   --kind 99 --limit 20     # 條件查詢
 *   bun run tools/q.ts sql    "SELECT ..."             # 任意 SQL
 *
 * 全域選項: --db <path>
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_DB = "db/glyphwiki.db";

// ---------------------------------------------------------------- args

const argv = Bun.argv.slice(2);
let dbPath = DEFAULT_DB;
const rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--db") dbPath = argv[++i]!;
  else rest.push(argv[i]!);
}
const DB = resolve(dbPath);
if (!existsSync(DB)) {
  console.error(`db not found: ${DB}\n先執行: bun run tools/build-db.ts`);
  process.exit(1);
}
const db = new Database(DB, { readonly: true });

/** 精簡庫沒有 parts.raw / glyphs.data，查詢語句要能自動適應 */
const hasRaw = (
  db
    .query("SELECT COUNT(*) n FROM pragma_table_info('parts') WHERE name = 'raw'")
    .get() as any
).n > 0;
const hasData = (
  db
    .query("SELECT COUNT(*) n FROM pragma_table_info('glyphs') WHERE name = 'data'")
    .get() as any
).n > 0;
const hasIds =
  (db
    .query("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='ids'")
    .get() as any).n > 0;
const PART_COLS = hasRaw
  ? "glyph, idx, kind, width, style, p1x, p1y, p2x, p2y, p3x, p3y, p4x, p4y, comp, sx, sy, sx2, sy2, raw"
  : "glyph, idx, kind, width, style, p1x, p1y, p2x, p2y, p3x, p3y, p4x, p4y, comp, sx, sy, sx2, sy2, NULL AS raw";
const hasRelated = (
  db
    .query("SELECT COUNT(*) n FROM pragma_table_info('glyphs') WHERE name = 'related'")
    .get() as any
).n > 0;
const GLYPH_COLS = hasData
  ? "*"
  : `name, ${hasRelated ? "related" : "NULL AS related"}, NULL AS data, name_type, codepoint, suffix, base_name,
     n_parts, n_strokes, n_refs, 0 AS n_dollar, pure_pointer, dangling_refs, 0 AS self_ref`;

// ---------------------------------------------------------------- helpers

const c = (n: unknown) =>
  n === null || n === undefined ? "-" : Number(n).toLocaleString();

/** 'u80cc' | 'U+80CC' | '80CC' -> 'u80cc' */
function normalizeName(input: string): string {
  const s = input.trim();
  const m = /^(?:u\+|U\+|u|U)?([0-9a-fA-F]{4,6})$/.exec(s);
  if (m && /^(u\+|U\+|u|U)/.test(s)) return "u" + m[1]!.toLowerCase();
  if (/^[0-9a-fA-F]{4,6}$/.test(s)) return "u" + s.toLowerCase();
  return s;
}

interface GlyphRow {
  name: string;
  related: string | null;
  data: string;
  name_type: string;
  codepoint: number | null;
  suffix: string | null;
  base_name: string | null;
  n_parts: number;
  n_strokes: number;
  n_refs: number;
  n_dollar: number;
  pure_pointer: number;
  dangling_refs: number;
  self_ref: number;
}

interface PartRow {
  glyph: string;
  idx: number;
  kind: number;
  width: number | null;
  style: number | null;
  p1x: number | null;
  p1y: number | null;
  p2x: number | null;
  p2y: number | null;
  p3x: number | null;
  p3y: number | null;
  p4x: number | null;
  p4y: number | null;
  comp: string | null;
  sx: number | null;
  sy: number | null;
  sx2: number | null;
  sy2: number | null;
  raw: string | null;
}

const Q = {
  glyph: db.query<GlyphRow, [string]>(
    `SELECT ${GLYPH_COLS} FROM glyphs WHERE name = ?`,
  ),
  parts: db.query<PartRow, [string]>(
    `SELECT ${PART_COLS} FROM parts WHERE glyph = ? ORDER BY idx`,
  ),
  parts99: db.query<PartRow, [string]>(
    `SELECT ${PART_COLS} FROM parts WHERE glyph = ? AND kind = 99 ORDER BY idx`,
  ),
  children: db.query<{ comp: string; n: number }, [string]>(
    "SELECT comp, COUNT(*) n FROM parts WHERE glyph = ? AND kind = 99 GROUP BY comp ORDER BY MIN(idx)",
  ),
  parents: db.query<{ glyph: string; box: string; n: number }, [string]>(
    `SELECT glyph, COUNT(*) n,
            GROUP_CONCAT(p1x || ',' || p1y || ',' || p2x || ',' || p2y, ' | ') box
       FROM parts WHERE kind = 99 AND comp = ? GROUP BY glyph ORDER BY glyph LIMIT ?`,
  ),
};

/** 沿純指標鏈解析到真正含筆畫的字形 */
function resolvePointer(name: string, maxDepth = 24): { chain: string[]; row: GlyphRow | null } {
  const chain: string[] = [];
  let cur: string | null = name;
  const seen = new Set<string>();
  while (cur && chain.length < maxDepth) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const g: GlyphRow | undefined = Q.glyph.get(cur) ?? undefined;
    if (!g) return { chain, row: null };
    chain.push(cur);
    if (g.pure_pointer !== 1) return { chain, row: g };
    const kids = Q.children.all(cur);
    cur = kids.length > 0 ? kids[0]!.comp : null;
  }
  return { chain, row: null };
}

/** 用 parts 的框畫 ASCII 框圖（橫向 60 欄、縱向 30 列） */
function boxDiagram(parts: PartRow[], cols = 72, rows = 30): string {
  const grid: string[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => " "),
  );
  const chars = "123456789abcdefghijklmnopqrstuvwxyz";
  let ci = 0;
  const legend: string[] = [];
  for (const p of parts) {
    if (p.kind !== 99 || p.p1x === null) continue;
    const ch = chars[ci % chars.length]!;
    ci++;
    const x1 = p.p1x, y1 = p.p1y!, x2 = p.p2x!, y2 = p.p2y!;
    const c1 = Math.max(0, Math.floor((x1 / 200) * cols));
    const c2 = Math.min(cols - 1, Math.ceil((x2 / 200) * cols) - 1);
    const r1 = Math.max(0, Math.floor((y1 / 200) * rows));
    const r2 = Math.min(rows - 1, Math.ceil((y2 / 200) * rows) - 1);
    for (let r = r1; r <= r2; r++) {
      for (let cc = c1; cc <= c2; cc++) {
        const onEdge = r === r1 || r === r2 || cc === c1 || cc === c2;
        const cell = grid[r]![cc]!;
        if (onEdge) grid[r]![cc] = ch;
        else if (cell === " " || cell === ".") grid[r]![cc] = ".";
      }
    }
    const w = ((x2 - x1) / 200).toFixed(2);
    const h = ((y2 - y1) / 200).toFixed(2);
    legend.push(
      `   ${ch} = ${p.comp}  box ${x1},${y1}..${x2},${y2}  (w=${w} h=${h})`,
    );
  }
  const out = grid.map((r) => "  |" + r.join("") + "|");
  return out.join("\n") + (legend.length ? "\n" + legend.join("\n") : "");
}

function fmtGlyph(g: GlyphRow) {
  console.log(`name        : ${g.name}`);
  console.log(
    `type        : ${g.name_type}${g.suffix ? ` (suffix ${g.suffix}, base ${g.base_name})` : ""}${g.codepoint !== null ? `  U+${g.codepoint.toString(16).toUpperCase().padStart(4, "0")}` : ""}`,
  );
  console.log(`related     : ${g.related}`);
  console.log(
    `parts       : ${g.n_parts}  (筆畫 ${g.n_strokes} / 引用 ${g.n_refs})  pure_pointer=${g.pure_pointer}  dangling=${g.dangling_refs}  self_ref=${g.self_ref}`,
  );
  if (g.data == null) {
    console.log(`data        : (精簡庫未保留)`);
  } else {
    console.log(`data        : ${g.data.length} bytes`);
    console.log(`  ${g.data.length > 400 ? g.data.slice(0, 400) + " …" : g.data}`);
  }
}

// ---------------------------------------------------------------- commands

const cmd = rest[0];

switch (cmd) {
  case "stat": {
    const row = db
      .query(
        `SELECT (SELECT COUNT(*) FROM glyphs) glyphs,
                (SELECT COUNT(*) FROM parts) parts,
                (SELECT COUNT(*) FROM glyphs WHERE pure_pointer=1) pointers,
                (SELECT COUNT(*) FROM glyphs WHERE dangling_refs>0) dangling_glyphs,
                (SELECT COALESCE(SUM(dangling_refs),0) FROM glyphs) dangling_refs,
                (SELECT COUNT(*) FROM glyphs WHERE name_type='other') other,
                (SELECT COUNT(*) FROM glyphs WHERE name_type='codepoint') codepoints,
                (SELECT COUNT(*) FROM glyphs WHERE name_type='suffix') suffixed`,
      )
      .get() as any;
    for (const [k, v] of Object.entries(row)) console.log(`${k.padEnd(16)} ${c(v)}`);
    console.log("\n-- kind 分佈 --");
    for (const r of db
      .query("SELECT kind, COUNT(*) n FROM parts GROUP BY kind ORDER BY n DESC")
      .all() as any[])
      console.log(`  ${String(r.kind).padStart(4)}  ${c(r.n)}`);
    console.log("\n-- meta --");
    for (const r of db.query("SELECT key, value FROM meta").all() as any[])
      console.log(`  ${String(r.key).padEnd(16)} ${r.value}`);
    break;
  }

  case "show": {
    const names = rest.slice(1);
    if (names.length === 0) {
      console.error("usage: q.ts show <name|u+XXXX> [...]");
      process.exit(2);
    }
    for (const raw of names) {
      const name = normalizeName(raw);
      const g = Q.glyph.get(name) ?? undefined;
      if (!g) {
        console.log(`### ${name}: 不存在`);
        continue;
      }
      console.log(`### ${name}`);
      fmtGlyph(g);
      const parts = Q.parts.all(name);
      const { chain, row } = resolvePointer(name);
      if (g.n_refs > 0 && g.pure_pointer !== 1) {
        console.log(`\n  部件框圖（只顯示 kind=99）:`);
        console.log(boxDiagram(parts));
      }
      if (chain.length > 1) {
        console.log(`\n  指標鏈: ${chain.join(" -> ")}`);
        if (row) {
          console.log(
            `  已解析到 ${row.name}（${row.n_strokes} 筆 / ${row.n_refs} 個子部件），其框圖:`,
          );
          if (row.n_refs > 0) console.log(boxDiagram(Q.parts.all(row.name)));
          else
            console.log(
              `    純筆畫，無子部件。data: ${row.data.slice(0, 160)}${row.data.length > 160 ? " …" : ""}`,
            );
        } else {
          console.log(`  （無法解析到含筆畫的字形）`);
        }
      }
      console.log("");
    }
    break;
  }

  case "place": {
    // 某部件被當成子部件引用時的框分佈，依「父字形的首個 99 引用」分組
    const comp = normalizeName(rest[1] ?? "");
    const li = rest.indexOf("--limit");
    const limit = li >= 0 ? Number(rest[li + 1]) : 30;
    if (!comp) {
      console.error("usage: q.ts place <name> [--limit N]");
      process.exit(2);
    }
    const rows = db
      .query(
        `WITH child AS (
           SELECT glyph, p1x, p1y, p2x, p2y FROM parts WHERE kind = 99 AND comp = ?
         ),
         lead AS (
           SELECT glyph, comp AS op, MIN(idx) AS mi FROM parts WHERE kind = 99 GROUP BY glyph
         )
         SELECT c.glyph,
                (c.p2x - c.p1x) / 200.0 AS w,
                (c.p2y - c.p1y) / 200.0 AS h,
                c.p1x / 200.0 AS x1,
                c.p1y / 200.0 AS y1,
                l.op
           FROM child c LEFT JOIN lead l ON l.glyph = c.glyph AND l.mi = (
             SELECT MIN(idx) FROM parts WHERE kind = 99 AND glyph = c.glyph
           )`,
      )
      .all(comp) as any[];
    if (rows.length === 0) {
      console.log(`${comp}: 沒有任何引用`);
      break;
    }
    const stat = (arr: number[]) => {
      const s = [...arr].sort((a, b) => a - b);
      const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))]!.toFixed(2);
      const mean = s.reduce((a, b) => a + b, 0) / s.length;
      return `min=${q(0)} p25=${q(0.25)} p50=${q(0.5)} p75=${q(0.75)} max=${s[s.length - 1]!.toFixed(2)} mean=${mean.toFixed(2)}`;
    };
    console.log(`${comp}: 被引用 ${rows.length} 次`);
    console.log(`  框寬 w : ${stat(rows.map((r) => r.w))}`);
    console.log(`  框高 h : ${stat(rows.map((r) => r.h))}`);
    console.log(`  左界 x1: ${stat(rows.map((r) => r.x1))}`);
    console.log(`  上界 y1: ${stat(rows.map((r) => r.y1))}`);
    const byLead = new Map<string, any[]>();
    for (const r of rows) {
      const k: string = r.op ?? "(?)";
      const arr = byLead.get(k);
      if (arr) arr.push(r);
      else byLead.set(k, [r]);
    }
    console.log(`  依父字形的首個子部件分組（前 ${limit} 組）:`);
    for (const [op, arr] of [...byLead.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, limit)) {
      console.log(`    ${op.padEnd(18)} n=${String(arr.length).padEnd(5)} ${stat(arr.map((r) => r.w))}`);
    }
    break;
  }

  case "tree": {
    let depth = 3;
    const di = rest.indexOf("--depth");
    if (di >= 0) depth = Number(rest[di + 1] ?? 3);
    const name = normalizeName(rest[1] ?? "");
    if (!name) {
      console.error("usage: q.ts tree <name> [--depth N]");
      process.exit(2);
    }
    const seenPath = new Set<string>();
    const walk = (n: string, d: number): void => {
      const pad = "  ".repeat(d);
      const g = Q.glyph.get(n) ?? undefined;
      if (!g) {
        console.log(`${pad}${n}  <不存在> (懸空引用)`);
        return;
      }
      console.log(
        `${pad}${n}${g.pure_pointer ? " [pointer]" : ""} parts=${g.n_parts} refs=${g.n_refs} strokes=${g.n_strokes}`,
      );
      if (d >= depth) return;
      if (seenPath.has(n)) {
        console.log(`${pad}  ... 循環`);
        return;
      }
      seenPath.add(n);
      for (const k of Q.children.all(n)) walk(k.comp, d + 1);
      seenPath.delete(n);
    };
    walk(name, 0);
    break;
  }

  case "refs": {
    const name = normalizeName(rest[1] ?? "");
    const limit = Number(rest[2] ?? 50);
    const rows = Q.parents.all(name, limit);
    console.log(`${name} 被 ${rows.length >= limit ? `${limit}+` : rows.length} 個字形引用（上限 ${limit}）:`);
    for (const r of rows) console.log(`  ${r.glyph.padEnd(24)} x${r.n}  box=${r.box}`);
    break;
  }

  case "uses": {
    const name = normalizeName(rest[1] ?? "");
    const g = Q.glyph.get(name) ?? undefined;
    if (!g) {
      console.log(`${name}: 不存在`);
      break;
    }
    console.log(`${name}: ${g.n_refs} 個直接引用`);
    for (const p of Q.parts99.all(name)) {
      const child = Q.glyph.get(p.comp!) as any;
      const exists = child ? "" : "  <不存在>";
      const w = p.p2x !== null && p.p1x !== null ? ((p.p2x - p.p1x) / 200).toFixed(2) : "?";
      const h = p.p2y !== null && p.p1y !== null ? ((p.p2y - p.p1y) / 200).toFixed(2) : "?";
      console.log(
        `  [${p.idx}] ${String(p.comp).padEnd(22)} box ${p.p1x},${p.p1y}..${p.p2x},${p.p2y} (w=${w} h=${h})${exists}`,
      );
    }
    break;
  }

  case "ids": {
    if (!hasIds) {
      console.log("此資料庫沒有 IDS 表，請先執行: bun run tools/load-ids.ts");
      break;
    }
    const names = rest.slice(1);
    if (names.length === 0) {
      console.error("usage: q.ts ids <name|u+XXXX> [...]");
      process.exit(2);
    }
    for (const raw of names) {
      const name = normalizeName(raw);
      const ch = /^u([0-9a-f]{4,6})$/.exec(name);
      if (!ch) {
        console.log(`### ${name}: 不是純碼位名稱`);
        continue;
      }
      const cp = parseInt(ch[1]!, 16);
      const row = db
        .query("SELECT * FROM ids WHERE codepoint = ?")
        .get(cp) as any;
      if (!row) {
        console.log(`### ${name}: IDS 表中沒有`);
        continue;
      }
      console.log(`### ${row.name} ${row.ch}   IDS: ${row.seq}`);
      console.log(
        `    最外層算子 ${row.outer_op ?? "(無)"}   分量 ${row.n_comp}   算子 ${row.n_op}   深度 ${row.depth}   ${row.atomic ? "原子字" : ""}`,
      );
      const comps = db
        .query(
          `SELECT pos, ch, comp_cp, cdp_key, kind, depth, group_ix FROM ids_comp WHERE codepoint=? ORDER BY pos`,
        )
        .all(cp) as any[];
      console.log(`    分量序列:`);
      for (const k of comps)
        console.log(
          `      pos${String(k.pos).padStart(2)} d${k.depth} g${String(k.group_ix).padStart(2)} ${k.kind === "op" ? "[算子]" : "      "} ${k.ch}${k.comp_cp ? `  U+${k.comp_cp.toString(16).toUpperCase()}` : ""}${k.cdp_key ? `  ${k.cdp_key}` : ""}`,
        );
      const align = db
        .query(
          `SELECT ids_pos, ids_ch, part_name, part_cp, part_cdp, kage_depth, part_path, confidence
             FROM ids_align WHERE codepoint=? ORDER BY ids_pos, kage_depth`,
        )
        .all(cp) as any[];
      if (align.length === 0) console.log(`    對接: (無)`);
      else {
        console.log(`    對接表 (ids_align):`);
        for (const a of align)
          console.log(
            `      IDS「${a.ids_ch ?? "?"}」-> ${String(a.part_name).padEnd(24)} ${a.part_cp ? "U+" + a.part_cp.toString(16).toUpperCase() : (a.part_cdp ?? "-")}  KAGE深度${a.kage_depth}  可信度${a.confidence}`,
          );
      }
      console.log("");
    }
    break;
  }

  case "align": {
    if (!hasIds) {
      console.log("此資料庫沒有 IDS 表，請先執行: bun run tools/load-ids.ts");
      break;
    }
    const limit = Number(rest[1] ?? 20);
    const conf = rest[2] ?? "3";
    console.log(`IDS 對接樣本（可信度 ${conf}，文化）:`);
    for (const r of db
      .query(
        `SELECT ch, seq, ids_ch, part_name, part_cp, part_cdp, kage_depth
           FROM ids_align WHERE confidence >= ? AND ids_ch IS NOT NULL AND ids_ch NOT LIKE '&%'
           ORDER BY codepoint LIMIT ?`,
      )
      .all(Number(conf), limit) as any[])
      console.log(
        `  ${r.ch} ${r.seq}  IDS「${r.ids_ch}」-> ${String(r.part_name).padEnd(20)} ${r.part_cp ? "U+" + r.part_cp.toString(16).toUpperCase() : "-"} (深度${r.kage_depth})`,
      );
    console.log("\n各可信度統計:");
    for (const r of db
      .query(
        `SELECT confidence, COUNT(*) n, COUNT(DISTINCT codepoint) g FROM ids_align GROUP BY confidence ORDER BY confidence DESC`,
      )
      .all() as any[])
      console.log(`  可信度 ${r.confidence}: ${Number(r.n).toLocaleString()} 組 / ${Number(r.g).toLocaleString()} 字`);
    break;
  }

  case "find": {
    let sql = "SELECT name, name_type, n_strokes, n_refs, dangling_refs, data FROM glyphs WHERE 1=1";
    const params: any[] = [];
    for (let i = 1; i < rest.length; i++) {
      const t = rest[i]!;
      if (t === "--kind") {
        sql += " AND name IN (SELECT glyph FROM parts WHERE kind = ?)";
        params.push(Number(rest[++i]));
      } else if (t === "--suffix") {
        sql += " AND suffix = ?";
        params.push(rest[++i]);
      } else if (t === "--like") {
        sql += " AND name LIKE ?";
        params.push(rest[++i]);
      } else if (t === "--min-refs") {
        sql += " AND n_refs >= ?";
        params.push(Number(rest[++i]));
      } else if (t === "--dangling") {
        sql += " AND dangling_refs > 0";
      } else if (t === "--limit") {
        sql += " LIMIT ?";
        params.push(Number(rest[++i]));
      }
    }
    if (!sql.includes("LIMIT")) sql += " LIMIT 20";
    for (const r of db.query(sql).all(...params) as any[])
      console.log(
        `  ${r.name.padEnd(24)} ${r.name_type.padEnd(10)} strokes=${c(r.n_strokes)} refs=${c(r.n_refs)} dangling=${c(r.dangling_refs)}`,
      );
    break;
  }

  case "sql": {
    const sql = rest.slice(1).join(" ");
    if (!sql) {
      console.error("usage: q.ts sql \"SELECT ...\"");
      process.exit(2);
    }
    const stmt = db.query(sql);
    const rows = stmt.all() as any[];
    if (rows.length === 0) {
      console.log("(0 rows)");
      break;
    }
    const cols = Object.keys(rows[0]!);
    console.log(cols.join("\t"));
    for (const r of rows.slice(0, 200))
      console.log(cols.map((k) => String(r[k] ?? "")).join("\t"));
    console.log(`(${rows.length} rows)`);
    break;
  }

  default:
    console.log(`q.ts — glyphwiki sqlite 查詢工具

  stat                              資料庫總覽
  show  <name|u+XXXX> [...]         詳細資料 + 部件框圖（自動沿指標鏈顯示真正的框）
  tree  <name> [--depth N]          遞歸展開組字樹
  refs  <name> [limit]              誰引用了我
  uses  <name>                      我引用了誰
  place <name> [--limit N]          我被引用時的框分佈（依父字形分組）
  ids   <name|u+XXXX> [...]         IDS 序列 + 分量 + 與 KAGE 的對接
  align [limit] [confidence]        IDS↔KAGE 對接樣本與統計（需先跑 load-ids）
  find  [--kind N] [--suffix S] [--like P] [--min-refs N] [--dangling] [--limit N]
  sql   "SELECT ..."                任意 SQL

全域: --db <path>   預設 ${DEFAULT_DB}`);
}

db.close();
