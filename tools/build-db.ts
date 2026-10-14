#!/usr/bin/env bun
/**
 * build-db.ts — 把 GlyphWiki dump 載入 SQLite。
 *
 * 用法:
 *   bun run tools/build-db.ts [--dump <path>] [--db <path>] [--quiet]
 *
 * 設計原則:
 *   - 一次掃描、分批 transaction、prepared statement。
 *   - 忠實保留 dump 的結構：解析結果存成欄位，原始欄位字串存進 parts.raw 以備稽核。
 *   - 可重複執行（每次重建）。
 *
 * 已知 dump 特性（實測）:
 *   - 第 1 行是標題列、第 2 行是分隔線，需跳過。
 *   - 三欄以 '|' 分隔、皆以空白補齊，需 trim。
 *   - 只有極少數畸形行（實測 2,126,474 行中 < 10 行）。
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------- args

interface Args {
  dump: string;
  db: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    dump: "dump/dump_newest_only.txt",
    db: "db/glyphwiki.db",
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "--dump") a.dump = argv[++i]!;
    else if (t === "--db") a.db = argv[++i]!;
    else if (t === "--quiet") a.quiet = true;
    else if (t === "-h" || t === "--help") {
      console.log(
        "usage: bun run tools/build-db.ts [--dump <path>] [--db <path>] [--quiet]",
      );
      process.exit(0);
    } else {
      console.error(`unknown arg: ${t}`);
      process.exit(2);
    }
  }
  return a;
}

const args = parseArgs(Bun.argv.slice(2));
const DUMP = resolve(args.dump);
const DB = resolve(args.db);
const log = (...m: unknown[]) => {
  if (!args.quiet) console.log(...m);
};

if (!existsSync(DUMP)) {
  console.error(`dump file not found: ${DUMP}`);
  process.exit(1);
}
mkdirSync(dirname(DB), { recursive: true });
for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  const p = DB + suffix;
  if (existsSync(p)) unlinkSync(p);
}

// ---------------------------------------------------------------- schema

const SCHEMA = `
PRAGMA page_size = 4096;

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE glyphs (
  name          TEXT PRIMARY KEY,
  related       TEXT,
  data          TEXT NOT NULL,
  name_type     TEXT NOT NULL,     -- 'codepoint' | 'suffix' | 'other'
  codepoint     INTEGER,           -- 'u80cc-j' -> 0x80CC
  suffix        TEXT,              -- 'u80cc-j' -> '-j' ; 無後綴 -> ''
  base_name     TEXT,              -- 'u80cc-j' -> 'u80cc' ; 'u80cc' -> 'u80cc'
  n_parts       INTEGER NOT NULL,
  n_strokes     INTEGER NOT NULL,
  n_refs        INTEGER NOT NULL,
  n_dollar      INTEGER NOT NULL,  -- data 中 '$' 的個數
  pure_pointer  INTEGER NOT NULL,  -- 內容只有單一 99:0:0:0:0:200:200:<name>（建表後回填）
  dangling_refs INTEGER NOT NULL,  -- 引用了 dump 中不存在的名字（建表後回填）
  self_ref      INTEGER NOT NULL
);

CREATE TABLE parts (
  glyph   TEXT    NOT NULL,
  idx     INTEGER NOT NULL,
  kind    INTEGER NOT NULL,
  width   INTEGER,
  style   INTEGER,
  p1x     INTEGER, p1y INTEGER,
  p2x     INTEGER, p2y INTEGER,
  p3x     INTEGER, p3y INTEGER,
  p4x     INTEGER, p4y INTEGER,
  comp    TEXT,                    -- kind=99: 被引用的字形名
  sx      INTEGER, sy INTEGER, sx2 INTEGER, sy2 INTEGER,
  raw     TEXT,
  PRIMARY KEY (glyph, idx)
) WITHOUT ROWID;

CREATE TABLE suffix_stats (
  suffix TEXT PRIMARY KEY,
  n      INTEGER NOT NULL
);
`;

const INSERT_GLYPH = `
INSERT INTO glyphs
 (name, related, data, name_type, codepoint, suffix, base_name,
  n_parts, n_strokes, n_refs, n_dollar, pure_pointer, dangling_refs, self_ref)
VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,0)
`;

const INSERT_PART = `
INSERT INTO parts
 (glyph, idx, kind, width, style,
  p1x, p1y, p2x, p2y, p3x, p3y, p4x, p4y,
  comp, sx, sy, sx2, sy2, raw)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`;

function toInt(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// ---------------------------------------------------------------- open

const db = new Database(DB, { create: true });
db.exec("PRAGMA synchronous = OFF;");
db.exec("PRAGMA journal_mode = MEMORY;");
db.exec("PRAGMA temp_store = MEMORY;");
db.exec("PRAGMA cache_size = -200000;");
db.exec(SCHEMA);

const insGlyph = db.prepare(INSERT_GLYPH);
const insPart = db.prepare(INSERT_PART);

// ---------------------------------------------------------------- scan

const t0 = performance.now();
const file = Bun.file(DUMP);
const sizeBytes = file.size;

let lineNo = 0;
let skipped = 0;
let nGlyph = 0;
let nPart = 0;
let sumDataLen = 0;
let maxDataLen = 0;

const suffixCount = new Map<string, number>();

const BATCH_GLYPH = 20_000;
const BATCH_PART = 200_000;
let bGlyph = 0;
let bPart = 0;

function commitBatch() {
  db.exec("COMMIT;");
  db.exec("BEGIN;");
  bGlyph = 0;
  bPart = 0;
}

const decoder = new TextDecoder();
let carry = "";

db.exec("BEGIN;");

for await (const chunk of file.stream()) {
  const text =
    carry + (typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
  carry = "";
  let start = 0;

  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      carry = text.slice(start);
      break;
    }
    const rawLine = text.slice(start, nl);
    start = nl + 1;

    lineNo++;
    if (lineNo <= 2) continue; // 標題列 + 分隔線
    if (rawLine.length < 3) continue;

    const b1 = rawLine.indexOf("|");
    const b2 = b1 < 0 ? -1 : rawLine.indexOf("|", b1 + 1);
    if (b1 < 0 || b2 < 0) {
      skipped++;
      continue;
    }

    const name = rawLine.slice(0, b1).trim();
    const related = rawLine.slice(b1 + 1, b2).trim();
    const data = rawLine.slice(b2 + 1).trim();
    if (name.length === 0 || data.length === 0) {
      skipped++;
      continue;
    }

    // ---- 名稱分類
    let nameType: "codepoint" | "suffix" | "other" = "other";
    let codepoint: number | null = null;
    let suffix = "";
    let baseName: string | null = null;
    const m = /^u([0-9a-f]{4,6})(-[a-z0-9_.\-]*)?$/i.exec(name);
    if (m) {
      codepoint = parseInt(m[1]!, 16);
      baseName = "u" + m[1]!.toLowerCase();
      if (m[2] === undefined) {
        nameType = "codepoint";
      } else {
        nameType = "suffix";
        suffix = m[2]!.toLowerCase();
        suffixCount.set(suffix, (suffixCount.get(suffix) ?? 0) + 1);
      }
    }

    // ---- 逐部件解析
    const fields = data.split("$");
    let nStrokes = 0;
    let nRefs = 0;
    let nDollar = 0;
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]!.split(":");
      const kind = Number(f[0]);
      if (!Number.isFinite(kind)) {
        skipped++;
        continue;
      }
      if (kind === 99) {
        nRefs++;
        insPart.run(
          name, i, kind, null, null,
          toInt(f[3]), toInt(f[4]), toInt(f[5]), toInt(f[6]),
          null, null, null, null,
          f[7] ?? null, toInt(f[8]), toInt(f[9]), toInt(f[10]), toInt(f[11]),
          fields[i]!,
        );
      } else {
        nStrokes++;
        insPart.run(
          name, i, kind, toInt(f[1]), toInt(f[2]),
          toInt(f[3]), toInt(f[4]), toInt(f[5]), toInt(f[6]),
          toInt(f[7]), toInt(f[8]), toInt(f[9]), toInt(f[10]),
          null, null, null, null, null,
          fields[i]!,
        );
      }
      nPart++;
      bPart++;
      if (bPart >= BATCH_PART) commitBatch();
    }

    insGlyph.run(
      name, related, data, nameType, codepoint, suffix, baseName,
      fields.length, nStrokes, nRefs, nDollar,
    );
    nGlyph++;
    sumDataLen += data.length;
    if (data.length > maxDataLen) maxDataLen = data.length;
    bGlyph++;
    if (bGlyph >= BATCH_GLYPH) {
      bGlyph = 0;
      if (!args.quiet) {
        const secs = (performance.now() - t0) / 1000;
        process.stderr.write(
          `\r  line ${lineNo.toLocaleString()}  glyph ${nGlyph.toLocaleString()}  part ${nPart.toLocaleString()}  ${secs.toFixed(0)}s   `,
        );
      }
    }
  }
}
// 檔尾若無換行
if (carry.trim().length > 0) {
  // 實測 dump 結尾有換行，這裡僅防禦
  skipped++;
}
db.exec("COMMIT;");
if (!args.quiet) process.stderr.write("\r" + " ".repeat(90) + "\r");

const tScan = performance.now();
log(
  `掃描: ${nGlyph.toLocaleString()} 字形 / ${nPart.toLocaleString()} 部件列  ${((tScan - t0) / 1000).toFixed(1)}s`,
);
log("建立索引…");

db.exec(`
CREATE INDEX idx_glyph_cp    ON glyphs(codepoint) WHERE codepoint IS NOT NULL;
CREATE INDEX idx_glyph_type  ON glyphs(name_type);
CREATE INDEX idx_part_kind   ON parts(kind);
CREATE INDEX idx_part_glyph  ON parts(glyph);
`);
const tIdx = performance.now();
log(`  完成  ${((tIdx - tScan) / 1000).toFixed(1)}s`);
log("建立 parts.comp 索引…");
db.exec(`CREATE INDEX idx_part_comp ON parts(comp) WHERE comp IS NOT NULL;`);
const tIdx2 = performance.now();
log(`  完成  ${((tIdx2 - tIdx) / 1000).toFixed(1)}s`);

log("回填 pure_pointer / dangling_refs / self_ref…");
db.exec("BEGIN;");
// 純指標：整個 data 就是一個滿格 99 引用（名稱是自己的、非其他命名空間）。
// 條件放寬為前綴比對即可：n_parts=1 已保證整個 data 只有這一個欄位。
db.exec(`
UPDATE glyphs SET pure_pointer = 1
 WHERE n_parts = 1
   AND data LIKE '99:0:0:0:0:200:200:%'
   AND name_type <> 'other';
`);
// 含 $ 的例外（極少）：最後一段是滿格 99 引用
db.exec(`
UPDATE glyphs SET self_ref = 1
 WHERE EXISTS (SELECT 1 FROM parts p WHERE p.glyph = glyphs.name AND p.kind = 99 AND p.comp = glyphs.name);
`);
db.exec("COMMIT;");
const tUpd = performance.now();
log(`  完成  ${((tUpd - tIdx2) / 1000).toFixed(1)}s`);

log("回填 dangling_refs（掃 2.9M 引用，較慢）…");
db.exec("BEGIN;");
db.exec(`
UPDATE glyphs SET dangling_refs = (
  SELECT COUNT(*) FROM parts p
   WHERE p.glyph = glyphs.name AND p.kind = 99
     AND NOT EXISTS (SELECT 1 FROM glyphs g WHERE g.name = p.comp)
);
`);
db.exec("COMMIT;");
const tDang = performance.now();
log(`  完成  ${((tDang - tUpd) / 1000).toFixed(1)}s`);

const insSuffix = db.prepare("INSERT INTO suffix_stats (suffix, n) VALUES (?, ?)");
db.exec("BEGIN;");
for (const [s, n] of suffixCount) insSuffix.run(s, n);
db.exec("COMMIT;");

const addMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
db.exec("BEGIN;");
addMeta.run("source_file", DUMP);
addMeta.run("source_bytes", String(sizeBytes));
addMeta.run("built_at", new Date().toISOString());
addMeta.run("glyph_count", String(nGlyph));
addMeta.run("part_count", String(nPart));
addMeta.run("schema_version", "2");
addMeta.run("builder", "tools/build-db.ts");
db.exec("COMMIT;");

db.exec("ANALYZE;");
db.exec("PRAGMA optimize;");
db.close();

// ---------------------------------------------------------------- report

const tEnd = performance.now();
const dbBytes = statSync(DB).size;
const mb = (n: number) => (n / 1024 / 1024).toFixed(1) + " MB";
const c = (n: number | bigint) => Number(n).toLocaleString();

const rdb = new Database(DB, { readonly: true });
const one = <T>(sql: string): T => rdb.query(sql).get() as T;
const all = <T>(sql: string): T[] => rdb.query(sql).all() as T[];

log("");
log("================ dump -> sqlite 報告 ================");
log(`來源    : ${DUMP}  (${mb(sizeBytes)})`);
log(`輸出    : ${DB}  (${mb(dbBytes)})`);
log(`總耗時  : ${((tEnd - t0) / 1000).toFixed(1)}s`);
log(`資料行  : ${c(lineNo)}   跳過/畸形: ${c(skipped)}`);
log(
  `字形    : ${c(nGlyph)}   部件列: ${c(nPart)}   平均 data 長度 ${(sumDataLen / Math.max(1, nGlyph)).toFixed(1)}   最長 ${maxDataLen}`,
);

log("\n-- 名稱類型 --");
for (const r of all<any>(
  "SELECT name_type, COUNT(*) n FROM glyphs GROUP BY name_type ORDER BY n DESC",
))
  log(`  ${r.name_type.padEnd(10)} ${c(r.n)}`);

log("\n-- 純指標（內容只有單一滿格 99 引用，可摺疊）--");
const pp = one<{ n: number }>("SELECT COUNT(*) n FROM glyphs WHERE pure_pointer=1");
log(`  合計 ${c(pp.n)}`);
for (const r of all<any>(
  "SELECT name_type, COUNT(*) n FROM glyphs WHERE pure_pointer=1 GROUP BY name_type ORDER BY n DESC",
))
  log(`    ${r.name_type.padEnd(10)} ${c(r.n)}`);

log("\n-- 懸空引用 / 自我引用 --");
const dg = one<{ n: number }>("SELECT COUNT(*) n FROM glyphs WHERE dangling_refs>0");
const dt = one<{ n: number }>("SELECT COALESCE(SUM(dangling_refs),0) n FROM glyphs");
const sg = one<{ n: number }>("SELECT COUNT(*) n FROM glyphs WHERE self_ref=1");
const rt = one<{ n: number }>("SELECT COALESCE(SUM(n_refs),0) n FROM glyphs");
log(`  有懸空引用的字形 ${c(dg.n)}   懸空引用 ${c(dt.n)} / 全部引用 ${c(rt.n)}`);
log(`  自我引用的字形   ${c(sg.n)}`);

log("\n-- 部件欄位類型分佈 --");
for (const r of all<any>(
  "SELECT kind, COUNT(*) n FROM parts GROUP BY kind ORDER BY n DESC",
))
  log(`  kind ${String(r.kind).padStart(4)}  ${c(r.n)}`);

log("\n-- 部件引用框（kind=99）--");
const box = one<any>(`
  SELECT COUNT(*) n,
         SUM(CASE WHEN p1x=0 AND p1y=0 AND p2x=200 AND p2y=200 THEN 1 ELSE 0 END) full200,
         SUM(CASE WHEN p1x IS NULL OR p2x IS NULL THEN 1 ELSE 0 END) nonum,
         SUM(CASE WHEN p2x < p1x OR p2y < p1y THEN 1 ELSE 0 END) inverted
    FROM parts WHERE kind=99`);
log(
  `  引用 ${c(box.n)}   滿格 0,0,200,200: ${c(box.full200)} (${((box.full200 / box.n) * 100).toFixed(1)}%)   缺座標 ${c(box.nonum)}   反向/退化框 ${c(box.inverted)}`,
);
const stretch = one<any>(
  "SELECT SUM(CASE WHEN COALESCE(sx,0)<>0 OR COALESCE(sy,0)<>0 THEN 1 ELSE 0 END) n FROM parts WHERE kind=99",
);
log(`  含非零 sx/sy 的引用: ${c(stretch.n)}`);

log("\n-- 最常見後綴 top 20 --");
for (const r of all<any>(
  "SELECT suffix, n FROM suffix_stats ORDER BY n DESC LIMIT 20",
))
  log(`  ${r.suffix.padEnd(16)} ${c(r.n)}`);

log("\n-- 樣本 --");
for (const nm of ["u80cc", "u80cc-j", "u5728", "u5728-j", "u2ff0"]) {
  const gRow = rdb
    .query(
      "SELECT name, name_type, n_parts, n_strokes, n_refs, pure_pointer, dangling_refs, data FROM glyphs WHERE name = ?",
    )
    .get(nm) as any;
  if (gRow)
    log(
      `  ${gRow.name.padEnd(10)} parts=${gRow.n_parts} strokes=${gRow.n_strokes} refs=${gRow.n_refs} pointer=${gRow.pure_pointer} dangling=${gRow.dangling_refs}\n      ${gRow.data.slice(0, 140)}`,
    );
  else log(`  ${nm}: 不存在`);
}

rdb.close();
log("=====================================================");
