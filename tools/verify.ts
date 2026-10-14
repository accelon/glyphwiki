#!/usr/bin/env bun
/**
 * verify.ts — **一鍵驗收**：重建 → 驗收 → 指標。
 *
 * 為什麼要有這一支（師父 2026-10-14 的第一梯）：
 *   在這之前要記得 **11 個指令**（3 建 ＋ 8 支 check），而 `progress/技術總結-給AI.md` §8.4 的
 *   第一號坑就是「**改了程式忘了重建**」——忘了重建時頁面與字庫不一致，
 *   而測試**可能還是綠的** ✗。把整條鏈收成一個指令，這個坑就封死了 ✓。
 *
 * 用法：
 *   bun run tools/verify.ts             全套（預設）：建庫 → 重建兩頁 → 8 支檢查 → 指標表
 *   bun run tools/verify.ts --fast      跳過重建，只跑檢查（改測試或查現況時用）
 *   bun run tools/verify.ts --all       含舊消費者 **＋ 重量級步驟**（`check-structure` 152 秒）
 *   ⚠ 重量級步驟**預設不跑**：它們的價值不隨每次改動變動，沒必要每回都查
 *     （師父第 151 輪的指示；實測 `check-structure` 佔整個 verify 的 75%）
 *   bun run tools/verify.ts --lib       只建字庫 ＋ 出貨三套（改 judged 規則時用）
 *   bun run tools/verify.ts --all       加上**舊消費者**（kage-viewer、codemirror-kage）
 *   bun run tools/verify.ts --verbose   每一步的輸出即時串流（卡住時用）
 *   bun run tools/verify.ts --skip check-browser   跳過某一步（可重複；**會印在結論裡**）
 *   bun run tools/verify.ts --list      列出步驟，不執行
 *
 * 三條規矩：
 *   1. **失敗即停**，並且把**那一步的輸出尾巴**印出來（不要只丟一句「失敗」）。
 *   2. 被跳過的步驟（`--skip`／不在本次範圍）**要印出來**，不可以靜默省略 ✗。
 *   3. 指標表與 `progress/20261014計劃.md` §0 的基準**並排**，一眼看出退步。
 *      ⚠ 改基準值要**附原因**（跟測試快照同一條規矩）。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { decodeLibrary } from "./lib-format.ts";
import { synGroups, edgesOfSynMap } from "./syn-graph.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const has = (k: string) => argv.includes(k);
const val = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };
const skips = new Set<string>();
for (let i = 0; i < argv.length; i++) if (argv[i] === "--skip" && argv[i + 1]) skips.add(argv[i + 1]!);

type Phase = "build" | "ship" | "check" | "metric";
interface Step { name: string; args: string[]; phase: Phase; note: string; legacy?: boolean; heavy?: boolean }

/* 步驟表。順序就是執行順序：建 → 出貨（客人吃得到的）→ 檢查 → 指標。
   `legacy`＝**舊消費者**（編輯器、檢視頁），不屬於出貨面，預設不跑（`--all` 才跑）。
   它們的字庫來源是舊世代（`out/lib-cjk.bin.gz`），要一起驗之前先跑各自的 builder ✓。 */
const STEPS: Step[] = [
  { name: "check-syntax",        phase: "build", args: ["tools/check-syntax.ts"],          note: "先掃全部工具的語法（一秒；抓「template literal 註解裡的反引號」這類錯 ✗）" },
  { name: "build-library",       phase: "build", args: ["tools/build-library.ts", "--out", "out/lib-cjk-all.bin"], note: "字庫 v6：部件拆分（視覺）＋異體＋理據" },
  { name: "build-form-groups",   phase: "build", args: ["tools/build-form-groups.ts"], note: "部件形式群（建議更好的基字要用；頁面會內嵌）——掃語料，約 15 秒" },
  { name: "build-pinxing",       phase: "build", args: ["tools/build-pinxing.ts"],        note: "拼形頁（內嵌字庫 base64 ＋ 形式群）" },
  { name: "build-glyph-browser", phase: "build", args: ["tools/build-glyph-browser.ts"],  note: "字集瀏覽頁（內嵌字庫 base64）" },
  { name: "build-kage-viewer",   phase: "build", args: ["tools/build-kage-viewer.ts"],    note: "舊消費者：KAGE 檢視頁", legacy: true },
  { name: "build-codemirror",    phase: "build", args: ["tools/build-codemirror-kage.ts"], note: "舊消費者：CodeMirror 編輯器", legacy: true },

  { name: "check-pinxing",       phase: "ship",   args: ["tools/check-pinxing.ts"],       note: "出貨①拼形檢視器（headless Edge）" },
  { name: "check-browser",       phase: "ship",   args: ["tools/check-browser.ts"],       note: "出貨②字集瀏覽頁（headless Edge）" },
  { name: "free-compose-test",   phase: "ship",   args: ["tools/free-compose-test.ts"],   note: "出貨③組字引擎" },
  { name: "check-lib-compat",    phase: "check",  args: ["tools/check-lib-compat.ts"],    note: "字庫格式、v1～v6 相容、家族範圍、IDC 不當字" },
  { name: "check-ids-glyph",     phase: "check",  args: ["tools/check-ids-glyph.ts"],     note: "IDS → 字形（分框算術、**框不重疊**、畫得出來、壞 IDS 誠實）——`glyph-by-ids.md` 的主模塊" },
  { name: "check-component-boxes", phase: "check", args: ["tools/check-component-boxes.ts"], note: "部件身分／順序／緊框（點陣當第二意見）" },
  { name: "check-viewer",        phase: "check",  args: ["tools/check-viewer.ts"],        note: "舊消費者：檢視頁", legacy: true },
  { name: "check-codemirror",    phase: "check",  args: ["tools/check-codemirror.ts"],    note: "舊消費者：編輯器", legacy: true },

  { name: "check-parts",         phase: "metric", args: ["tools/check-parts.ts"],         note: "【輸入部件就比對得到】" },
  /* ⚠ 師父第 151 輪的指示：「check-structure 花的時間太長，沒必要就不要每回都查了。」
     實測它一個就佔 **152.7 秒**（整個 verify 203.5 秒的 **75%**）。
     所以標成 `heavy`：**預設不跑**，要看結構成績單時用 `--all`。 */
  { name: "check-structure",     phase: "metric", args: ["tools/check-structure.ts"],     note: "結構成績單（尺規＝新 IDS；算子不是目標）——**重量級，預設不跑**（152 秒）", heavy: true },
];

/* ---------------------------------------------------------------- 基準線
 * 與 `progress/20261014計劃.md` §0 同一組數字。**改這裡要附原因。** */
  /* 基準值。**改這裡要附原因。**
     · `partsHit` 97.80 → 97.51（2026-10-14 上午）：修掉異體表的 `∅` 污染之後重測。
       舊值裡有 **34 個假命中**（木／口 等 397 個部件被 `∅` 串成同一組）。
     · `partsHit` 97.51 → **96.00**（同日，師父裁定之後）：依裁定**推論列一律不歸併**
       （`口≡土`、`一≡八`…），所以「打 IDS 的那個部件就找得到」少了 176 個——
       其中一部分正是**移除假命中** ✓（`口` 不該找到畫成 `土` 的字），
       另一部分是**真的偏旁形被丟掉**（`金/釒`、`示/礻`…），
       要救回哪幾對請看 `out/syn-dropped.tsv`（附代價）→ 抄進 `syn-graph.ts` 的 `SYN_WHITELIST`。
     · `syn` 1,080 → 483（依裁定只收相容字符＋部首形）→ **1,194**（2026-10-14 下午，**來源換成
       Unihan 權威資料**：UnicodeData 正規分解 1,002 ＋ kZVariant 180 ＋ 部首形 12；
       師父的指示「異體＝Unicode 認定的 variants」，見 `tools/unihan-variants.ts`）。 */
const BASE = {
  date: "2026-10-14",
  lib: { glyphs: 191727, families: 98701, comp: 97079, syn: 1194, phil: 6460 },
  pct: { partsHit: 96.00, replace: 97.2 },
  synWarnGroup: 20,         /* 異體圖最大連通分量：超過＝⚠ 待裁定（見 out/syn-edge-classes.tsv） */
  synHardGroup: 150,        /* 超過＝✗ 明顯污染（實例：∅ 佔位符造成的 397 人群） */
  pctTol: 0.05,             /* 比率低於基準這麼多（百分點）＝退步 */
};

const fast = has("--fast");
const all = has("--all");
const verbose = has("--verbose");
const quiet = has("--quiet");

function selected(): Step[] {
  return STEPS.filter((s) => {
    if (skips.has(s.name)) return false;
    if (s.legacy && !all) return false;
    /* ★ 第 151 輪：**重量級步驟預設不跑** ✓（`--all` 才跑 ✓）——它們的價值不隨每次改動變動 ✓ */
    if (s.heavy && !all) return false;
    /* --lib：只重建字庫（改了 judge 規則／獨體表時用）＋ 出貨三套 */
    if (has("--lib")) return s.phase === "ship" || s.name === "build-library";
    if (fast && s.phase === "build") return false;
    return true;
  });
}

if (has("--help") || has("-h")) {
  const src = readFileSync(import.meta.path, "utf8").split("\n").slice(1, 29).map((l) => l.replace(/^ \* ?/, ""));
  console.log(src.join("\n"));
  process.exit(0);
}
if (has("--list")) {
  console.log("步驟（依執行順序）：");
  for (const s of STEPS) {
    const mark = skips.has(s.name) ? "－" : (s.legacy || s.heavy) && !all ? "○" : "·";
    console.log(`  ${mark} ${s.phase.padEnd(6)} ${s.name.padEnd(22)} bun run ${s.args.join(" ")}`);
    console.log(`      ${s.note}${s.legacy ? "（舊消費者：預設不跑，--all 才跑）" : s.heavy ? "（重量級：預設不跑，--all 才跑）" : ""}`);
  }
  process.exit(0);
}

/* ---------------------------------------------------------------- 跑一步 */
interface Ran { step: Step; code: number; text: string; ms: number }
const NL = "\n";
function tail(text: string, n: number): string[] {
  const lines = text.replace(/\r/g, "").split(NL);
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines.slice(-n);
}

async function runStep(s: Step): Promise<Ran> {
  const t0 = Date.now();
  const proc = Bun.spawn([process.execPath, ...s.args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const parts: string[] = [];
  const drain = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!stream) return;
    const dec = new TextDecoder();
    for await (const chunk of stream) {
      const t = dec.decode(chunk, { stream: true });
      parts.push(t);
      if (verbose) await Bun.write(Bun.stdout, t);
    }
  };
  await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  const code = await proc.exited;
  return { step: s, code, text: parts.join(""), ms: Date.now() - t0 };
}

const secs = (ms: number) => (ms / 1000).toFixed(1) + "s";

/* ---------------------------------------------------------------- 主流程 */
const todo = selected();
const ran: Ran[] = [];
let failed: Ran | null = null;

console.log(`驗收 ${todo.length} 步（${fast ? "跳過重建" : "含重建"}${all ? "，含舊消費者" : ""}）`);
console.log("─".repeat(72));

for (const s of todo) {
  process.stdout.write(`  ${s.name.padEnd(22)} `);
  const r = await runStep(s);
  ran.push(r);
  if (r.code !== 0) {
    console.log(`✗   ${secs(r.ms)}`);
    failed = r;
    break;
  }
  const t = tail(r.text, 1)[0] ?? "";
  console.log(`✓ ${secs(r.ms).padStart(7)}   ${t.trim().slice(0, 60)}`);
  if (!quiet && s.phase !== "metric" && !verbose) {
    for (const l of tail(r.text, 2)) console.log(`      ${l.trim().slice(0, 100)}`);
  }
}

if (failed) {
  console.log("─".repeat(72));
  console.log(`✗ ${failed.step.name} 失敗（exit ${failed.code}，${secs(failed.ms)}）`);
  console.log(`  指令：bun run ${failed.step.args.join(" ")}`);
  console.log(`  ── 輸出尾巴（最後 40 行）${"─".repeat(24)}`);
  for (const l of tail(failed.text, 40)) console.log("  " + l);
  console.log("  " + "─".repeat(60));
  const skipped = todo.slice(ran.length);
  if (skipped.length) {
    console.log(`  （失敗即停：以下 ${skipped.length} 步沒跑——` + skipped.map((s) => s.name).join("、") + "）");
  }
  const notSelected = STEPS.filter((s) => !todo.includes(s));
  if (notSelected.length) console.log(`  （本次未納入：` + notSelected.map((s) => s.name).join("、") + `）`);
  process.exit(1);
}

/* ---------------------------------------------------------------- 指標表 */
interface Metric { name: string; base: string; now: string; ok: boolean; hard?: boolean; info?: boolean; note?: string }
const metrics: Metric[] = [];
const byName = new Map(ran.map((r) => [r.step.name, r]));

function libCounts() {
  const file = resolve(ROOT, "out/lib-cjk-all.bin.gz");
  if (!existsSync(file)) return null;
  const raw = Bun.gunzipSync(readFileSync(file));
  const L = decodeLibrary(new Uint8Array(raw));
  /* 異體圖：用 `syn-graph.ts` 的同一支（建庫、稽核表、驗收共用，不各寫一份） */
  const edges = edgesOfSynMap(L.syn);
  const maxGroup = synGroups(edges).groups[0]?.length ?? 0;
  const pairs = edges.length;
  return { glyphs: L.glyphs.length, families: L.families.length, comp: L.comp?.size ?? 0, pairs, codepoints: L.syn?.size ?? 0, phil: L.phil?.size ?? 0, maxGroup, bytes: statSync(file).size };
}

const n = (v: number) => v.toLocaleString();
const num = (v: number, base: number, name: string, note = "") => {
  const ok = v === base;
  metrics.push({ name, base: n(base), now: n(v), ok, note: ok ? note : `Δ ${v - base > 0 ? "+" : ""}${n(v - base)}` });
};
const pctLine = (text: string, re: RegExp) => { const m = text.match(re); return m ? Number(m[1]) : null; };

const L = libCounts();
if (L) {
  num(L.glyphs, BASE.lib.glyphs, "字形");
  num(L.families, BASE.lib.families, "家族");
  num(L.comp, BASE.lib.comp, "部件拆分（comp 碼位）");
  num(L.pairs, BASE.lib.syn, "異體（syn 對）", `${n(L.codepoints)} 碼位`);
  num(L.phil, BASE.lib.phil, "理據（phil 條）");
  /* 異體圖最大連通分量：任何「佔位符被當成碼位」的污染都會讓它暴衝
     （2026-10-14 實例：`∅ U+2205` 把 397 個部件串成一組 ✗）。
     兩級：>150＝**硬性失敗**；>20＝**警告待裁定**（推論來的等價，見稽核表）。 */
  metrics.push({
    name: "syn 最大連通群",
    base: `≤ ${BASE.synWarnGroup}`,
    now: n(L.maxGroup),
    ok: L.maxGroup <= BASE.synWarnGroup,
    hard: L.maxGroup > BASE.synHardGroup,
    note: L.maxGroup <= BASE.synWarnGroup ? ""
      : L.maxGroup > BASE.synHardGroup ? `✗ 超過硬上限 ${BASE.synHardGroup}：異體表有污染`
      : "⚠ 待裁定：多半是「IDS 版本差異推論」來的等價，稽核表 out/syn-edge-classes.tsv",
  });
} else {
  console.log("⚠ 找不到 out/lib-cjk-all.bin.gz，指標表略過");
}

const rp = byName.get("check-parts");
if (rp) {
  const v = pctLine(rp.text, /命中 \*\*([\d.]+)%\*\*/);
  if (v !== null) metrics.push({ name: "【輸入部件就比對得到】", base: BASE.pct.partsHit.toFixed(2) + "%", now: v.toFixed(2) + "%", ok: v >= BASE.pct.partsHit - BASE.pctTol, hard: true, note: v < BASE.pct.partsHit - BASE.pctTol ? "低於基準＝退步" : "" });
}
const rs = byName.get("check-structure");
if (rs) {
  const v = pctLine(rs.text, /【IDS 替代進度】[^\n]*?（([\d.]+)%）/);
  if (v !== null) metrics.push({ name: "IDS 替代進度", base: BASE.pct.replace.toFixed(2) + "%", now: v.toFixed(2) + "%", ok: v >= BASE.pct.replace - BASE.pctTol, hard: true, note: v < BASE.pct.replace - BASE.pctTol ? "低於基準＝退步" : "" });
  const c = pctLine(rs.text, /收縮等價（容相容字符）([\d.]+)%/);
  if (c !== null) metrics.push({ name: "收縮等價（容相容字符）", base: "—", now: c.toFixed(2) + "%", ok: true, info: true, note: "僅供參考：刻意與 IDS 不同" });
  const cd = pctLine(rs.text, /葉子「身分」與 IDS 不同 ([\d.]+)%/);
  if (cd !== null) metrics.push({ name: "葉子身分與 IDS 不同", base: "—", now: cd.toFixed(2) + "%", ok: true, info: true, note: "大部分是刻意的（獨體、粒度）" });
}
if (L) {
  const pages = ["pinxing.html", "glyph-browser.html"].map((f) => {
    const p = resolve(ROOT, "out", f);
    return existsSync(p) ? `${f.replace(".html", "")} ${(statSync(p).size / 1048576).toFixed(2)}MB` : "";
  }).filter(Boolean);
  console.log("");
  console.log("檔案：" + `字庫 gz ${(L.bytes / 1048576).toFixed(2)}MB　` + pages.join("　"));
}

console.log("");
console.log("═".repeat(72));
console.log("指標（基準 vs 本次）　基準日 " + BASE.date);
for (const m of metrics) {
  const mark = m.info ? "○" : m.ok ? "✓" : (m.hard ? "✗" : "⚠");
  console.log(`  ${mark} ${m.name.padEnd(24)} ${m.base.padStart(12)}  →  ${m.now.padStart(12)}   ${m.note ?? ""}`);
}
console.log("═".repeat(72));

const hardBad = metrics.filter((m) => !m.ok && m.hard);
const totalMs = ran.reduce((a, r) => a + r.ms, 0);
const counts = (p: Phase) => todo.filter((s) => s.phase === p).length;
console.log(`${hardBad.length ? "✗" : "✓"} ${ran.length}/${todo.length} 步通過（建 ${counts("build")}、出貨 ${counts("ship")}、檢查 ${counts("check")}、指標 ${counts("metric")}），共 ${secs(totalMs)}`);
if (hardBad.length) {
  console.log(`✗ 指標退步：` + hardBad.map((m) => `${m.name} ${m.base} → ${m.now}`).join("；"));
}
const skipped = STEPS.filter((s) => !todo.includes(s));
if (skipped.length) console.log(`（本次未跑：` + skipped.map((s) => s.name + (s.legacy && !all ? "(舊消費者)" : "")).join("、") + `）`);
process.exit(hardBad.length ? 1 : 0);
