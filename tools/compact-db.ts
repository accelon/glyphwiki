#!/usr/bin/env bun
/**
 * compact-db.ts — 產生精簡版 sqlite：只留分析/建庫真正需要的欄位，量測容量下限。
 *
 * 用法:
 *   bun run tools/compact-db.ts [--src db/glyphwiki.db] [--out db/glyphwiki-lean.db] [--page-size 8192]
 *
 * 保留:
 *   glyphs: name, name_type, codepoint, suffix, base_name, n_parts, n_strokes, n_refs,
 *           pure_pointer, dangling_refs          (丟掉 related / data)
 *   parts : glyph, idx, kind, width, style, 8 個座標, comp, sx..sy2  (丟掉 raw)
 * 索引  : idx_glyph_cp, idx_part_comp, idx_part_glyph
 *
 * 注意: 兩個連線的 schema 都叫 main，所以 INSERT 前先把目標表改名，
 *       讓 SELECT ... FROM glyphs 取自來源連線。
 */

import { Database } from "bun:sqlite";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const argv = Bun.argv.slice(2);
let srcPath = "db/glyphwiki.db";
let outPath = "db/glyphwiki-lean.db";
let pageSize = 8192;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--src") srcPath = argv[++i]!;
  else if (argv[i] === "--out") outPath = argv[++i]!;
  else if (argv[i] === "--page-size") pageSize = Number(argv[++i]);
}
const SRC = resolve(srcPath);
const OUT = resolve(outPath);
if (!existsSync(SRC)) {
  console.error(`source db not found: ${SRC}`);
  process.exit(1);
}
for (const s of ["", "-wal", "-shm", "-journal"]) {
  const p = OUT + s;
  if (existsSync(p)) unlinkSync(p);
}

const t0 = performance.now();
const out = new Database(OUT, { create: true });

out.exec(`PRAGMA page_size = ${pageSize};`);
out.exec("PRAGMA synchronous = OFF;");
out.exec("PRAGMA journal_mode = MEMORY;");
out.exec("PRAGMA temp_store = MEMORY;");
out.exec("PRAGMA cache_size = -100000;");
// 把來源掛成 src schema，之後用 src.glyphs / src.parts 讀取
out.query("ATTACH DATABASE ? AS src").run(SRC);
console.log(
  `來源列數: glyphs=${(out.query("SELECT COUNT(*) c FROM src.glyphs").get() as any).c.toLocaleString()}  parts=${(out.query("SELECT COUNT(*) c FROM src.parts").get() as any).c.toLocaleString()}`,
);

out.exec(`
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE glyphs (
  name          TEXT PRIMARY KEY,
  name_type     TEXT NOT NULL,
  codepoint     INTEGER,
  suffix        TEXT,
  base_name     TEXT,
  n_parts       INTEGER NOT NULL,
  n_strokes     INTEGER NOT NULL,
  n_refs        INTEGER NOT NULL,
  pure_pointer  INTEGER NOT NULL,
  dangling_refs INTEGER NOT NULL
);

CREATE TABLE parts (
  glyph TEXT NOT NULL,
  idx   INTEGER NOT NULL,
  kind  INTEGER NOT NULL,
  width INTEGER,
  style INTEGER,
  p1x INTEGER, p1y INTEGER, p2x INTEGER, p2y INTEGER,
  p3x INTEGER, p3y INTEGER, p4x INTEGER, p4y INTEGER,
  comp TEXT,
  sx INTEGER, sy INTEGER, sx2 INTEGER, sy2 INTEGER,
  PRIMARY KEY (glyph, idx)
) WITHOUT ROWID;
`);

const tSchema = performance.now();
console.log("複製 glyphs…");
out.exec(`
INSERT INTO glyphs
SELECT name, name_type, codepoint, suffix, base_name,
       n_parts, n_strokes, n_refs, pure_pointer, dangling_refs
  FROM src.glyphs;
`);
const tGlyph = performance.now();
console.log(
  `  完成 ${((tGlyph - tSchema) / 1000).toFixed(1)}s  (${(out.query("SELECT COUNT(*) c FROM glyphs").get() as any).c.toLocaleString()} 列)`,
);

console.log("複製 parts…");
out.exec(`
INSERT INTO parts
SELECT glyph, idx, kind, width, style,
       p1x, p1y, p2x, p2y, p3x, p3y, p4x, p4y,
       comp, sx, sy, sx2, sy2
  FROM src.parts;
`);
const tParts = performance.now();
console.log(
  `  完成 ${((tParts - tGlyph) / 1000).toFixed(1)}s  (${(out.query("SELECT COUNT(*) c FROM parts").get() as any).c.toLocaleString()} 列)`,
);

console.log("建立索引…");
out.exec(`
CREATE INDEX idx_glyph_cp   ON glyphs(codepoint) WHERE codepoint IS NOT NULL;
CREATE INDEX idx_part_comp  ON parts(comp) WHERE comp IS NOT NULL;
CREATE INDEX idx_part_glyph ON parts(glyph);
`);
const tIdx = performance.now();
console.log(`  完成 ${((tIdx - tParts) / 1000).toFixed(1)}s`);

const add = out.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
out.exec("BEGIN;");
for (const r of out.query("SELECT key, value FROM src.meta").all() as any[])
  add.run(r.key, r.value);
add.run("derived_from", SRC);
add.run("compact_at", new Date().toISOString());
add.run("page_size", String(pageSize));
out.exec("COMMIT;");

// ---- IDS 相關的表（若來源有）
const hasIds = (
  out
    .query("SELECT COUNT(*) n FROM src.sqlite_master WHERE type='table' AND name='ids'")
    .get() as any
).n > 0;

if (hasIds) {
  console.log("複製 IDS 表…");
  out.exec(`
    CREATE TABLE ids_ops (
      op TEXT PRIMARY KEY, codepoint INTEGER NOT NULL, name TEXT NOT NULL, n_comp INTEGER NOT NULL);
    CREATE TABLE ids (
      codepoint INTEGER PRIMARY KEY, name TEXT NOT NULL, ch TEXT NOT NULL, seq TEXT NOT NULL,
      outer_op TEXT, outer_op_cp INTEGER, n_comp INTEGER NOT NULL, n_op INTEGER NOT NULL,
      depth INTEGER NOT NULL, atomic INTEGER NOT NULL, is_variant INTEGER NOT NULL,
      is_doubtful INTEGER NOT NULL, has_nontrivial INTEGER NOT NULL);
    CREATE TABLE ids_comp (
      codepoint INTEGER NOT NULL, pos INTEGER NOT NULL, ch TEXT NOT NULL, comp_cp INTEGER,
      cdp_key TEXT, kind TEXT NOT NULL, depth INTEGER NOT NULL, group_ix INTEGER NOT NULL,
      PRIMARY KEY (codepoint, pos)) WITHOUT ROWID;
    CREATE TABLE ids_ref (
      codepoint INTEGER NOT NULL, ids_pos INTEGER NOT NULL, part_idx INTEGER NOT NULL,
      part_idx2 INTEGER, part_name TEXT NOT NULL, part_cp INTEGER, part_cdp TEXT,
      part_cp_verified INTEGER NOT NULL, part_suffixed INTEGER NOT NULL, group_ix INTEGER NOT NULL,
      depth INTEGER NOT NULL, p1x INTEGER, p1y INTEGER, p2x INTEGER, p2y INTEGER,
      method TEXT NOT NULL, merged INTEGER NOT NULL,
      PRIMARY KEY (codepoint, ids_pos, part_idx)) WITHOUT ROWID;
    CREATE TABLE ids_tree_align (
      codepoint INTEGER NOT NULL, ids_path TEXT NOT NULL, ids_pos INTEGER NOT NULL,
      ids_ch TEXT, ids_depth INTEGER NOT NULL, part_name TEXT, kage_parent TEXT,
      part_cp INTEGER, part_cdp TEXT, part_suffixed INTEGER NOT NULL,
      kage_depth INTEGER NOT NULL, part_path TEXT,
      p1x INTEGER, p1y INTEGER, p2x INTEGER, p2y INTEGER,
      kage_leaf INTEGER NOT NULL, quality INTEGER NOT NULL, searched INTEGER NOT NULL,
      PRIMARY KEY (codepoint, ids_path));
  `);
  out.exec(`INSERT INTO ids_ops SELECT * FROM src.ids_ops;`);
  out.exec(`INSERT INTO ids SELECT * FROM src.ids;`);
  out.exec(`INSERT INTO ids_comp SELECT * FROM src.ids_comp;`);
  out.exec(`INSERT INTO ids_ref SELECT * FROM src.ids_ref;`);
  out.exec(`INSERT INTO ids_tree_align SELECT * FROM src.ids_tree_align;`);
  out.exec(`
    CREATE INDEX idx_ids_comp_cp  ON ids_comp(comp_cp) WHERE comp_cp IS NOT NULL;
    CREATE INDEX idx_ids_outer    ON ids(outer_op_cp);
    CREATE INDEX idx_idsref_cp    ON ids_ref(codepoint, method);
    CREATE INDEX idx_idsref_part  ON ids_ref(part_cp);
    CREATE INDEX idx_talign_cp    ON ids_tree_align(codepoint);
    CREATE INDEX idx_talign_part  ON ids_tree_align(part_cp);
  `);
  // 統一檢視表（與 load-ids.ts 一致）
  out.exec(`
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
           SELECT 1 FROM ids_ref r2 WHERE r2.codepoint = d.codepoint AND r2.ids_pos = d.ids_pos);
  `);
  console.log(
    `  ids=${(out.query("SELECT COUNT(*) n FROM ids").get() as any).n.toLocaleString()}  ids_comp=${(out.query("SELECT COUNT(*) n FROM ids_comp").get() as any).n.toLocaleString()}  ids_align=${(out.query("SELECT COUNT(*) n FROM ids_align").get() as any).n.toLocaleString()}`,
  );
} else {
  console.log("來源沒有 IDS 表，略過（可先跑 tools/load-ids.ts）");
}

out.exec("ANALYZE;");
out.exec("PRAGMA optimize;");
const counts = {
  glyphs: (out.query("SELECT COUNT(*) c FROM glyphs").get() as any).c,
  parts: (out.query("SELECT COUNT(*) c FROM parts").get() as any).c,
  srcGlyphs: (out.query("SELECT COUNT(*) c FROM src.glyphs").get() as any).c,
  srcParts: (out.query("SELECT COUNT(*) c FROM src.parts").get() as any).c,
};
out.exec("DETACH DATABASE src;");
out.close();

const mb = (n: number) => (n / 1048576).toFixed(1) + " MB";
console.log("\n============ 精簡資料庫 ============");
console.log(`來源 : ${SRC}  ${mb(statSync(SRC).size)}`);
console.log(`輸出 : ${OUT}  ${mb(statSync(OUT).size)}`);
console.log(
  `縮減 : ${(100 - (statSync(OUT).size / statSync(SRC).size) * 100).toFixed(1)}%   耗時 ${((performance.now() - t0) / 1000).toFixed(1)}s`,
);
console.log(
  `列數 : glyphs ${counts.glyphs.toLocaleString()} / ${counts.srcGlyphs.toLocaleString()}   parts ${counts.parts.toLocaleString()} / ${counts.srcParts.toLocaleString()}`,
);
if (counts.glyphs !== counts.srcGlyphs || counts.parts !== counts.srcParts) {
  console.error("!! 列數不符，複製失敗");
  process.exit(1);
}
console.log("====================================");
