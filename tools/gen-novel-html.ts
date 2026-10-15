#!/usr/bin/env bun
/**
 * gen-novel-html.ts — 把 novel/ 的小說 Markdown 合成單一網頁電子書。
 *
 * 輸入
 *   novel/index.md   章序來源（「電子書篇章順序」表：篇名／檔案／一句話）
 *   novel/ebook.md   樣式與功能設定（書名、主題、字級、版式、功能開關）
 *   novel/*.md       正文各篇
 * 輸出
 *   novel/gouxingji.html  單一網頁、無外部資源、手機優先（檔名用拼音，全 ASCII）
 *
 * 用法
 *   bun run tools/gen-novel-html.ts
 *   bun run tools/gen-novel-html.ts --check         只報告，不寫檔
 *   bun run tools/gen-novel-html.ts --out novel/x.html
 *
 * 版面：單欄。頂欄固定，左為目次鈕，中為書名／篇次，右為字級與設定。
 * 目次只列「篇」。正文一篇一頁，換篇即可。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const NOVEL = join(ROOT, "novel");
const CN_NUM = "〇一二三四五六七八九十";

// ─────────────────────────────────────────────────────────── 小工具

function fatal(msg: string): never {
  console.error("✗ " + msg);
  process.exit(1);
}

function read(path: string, label = path): string {
  if (!existsSync(path)) fatal(`找不到 ${label}：${path}`);
  return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function jsonForScript(v: unknown): string {
  return JSON.stringify(v)
    .replace(/<\//g, "<\\/")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function slug(s: string, fallback = "x"): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out || fallback;
}

/** 1→一、10→十、11→十一、20→二十 */
function cn(n: number): string {
  if (n <= 0) return String(n);
  if (n < 10) return CN_NUM[n];
  if (n === 10) return "十";
  if (n < 20) return "十" + CN_NUM[n - 10];
  const t = Math.floor(n / 10), o = n % 10;
  return CN_NUM[t] + "十" + (o ? CN_NUM[o] : "");
}

// ─────────────────────────────────────────────────────────── Markdown 表格

type Table = { header: string[]; rows: string[][]; aligns: string[] };

function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isTableSep(line: string): boolean {
  const t = line.trim();
  if (!t.includes("-") || !t.includes("|")) return false;
  return cells(t).every((c) => /^:?-{1,}:?$/.test(c));
}

function parseTables(md: string): Table[] {
  const lines = md.split(/\r?\n/);
  const tables: Table[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith("|") || !isTableSep(lines[i + 1])) continue;
    const header = cells(lines[i]);
    const aligns = cells(lines[i + 1]).map((c) =>
      c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"
    );
    const rows: string[][] = [];
    let j = i + 2;
    while (j < lines.length && lines[j].trim().startsWith("|")) rows.push(cells(lines[j++]));
    tables.push({ header, rows, aligns });
    i = j - 1;
  }
  return tables;
}

function findRow(t: Table, ...names: string[]): string | undefined {
  for (const r of t.rows) {
    const key = (r[0] ?? "").replace(/\s/g, "");
    if (names.some((n) => key === n.replace(/\s/g, ""))) return (r[1] ?? "").trim();
  }
  return undefined;
}

function findTable(tables: Table[], ...headerNames: string[]): Table | undefined {
  return tables.find((t) => headerNames.every((h) => t.header.includes(h)));
}

function bare(s: string | undefined): string {
  return (s ?? "").trim().replace(/^`|`$/g, "").trim();
}

function bool(v: string | undefined, dflt = true): boolean {
  if (v == null || v === "") return dflt;
  return /^(是|開|on|true|yes|1)$/i.test(v.trim());
}

function num(v: string | undefined, dflt: number): number {
  if (v == null) return dflt;
  const n = Number(String(v).replace(/[^\d.+-]/g, ""));
  return Number.isFinite(n) ? n : dflt;
}

function numList(v: string | undefined): number[] {
  if (!v) return [];
  return v.split(/[,，、\s]+/).map(Number).filter(Number.isFinite);
}

// ─────────────────────────────────────────────────────────── Markdown → HTML

type Ctx = { listStack: string[] };

function inline(s: string): string {
  let t = esc(s);
  const codes: string[] = [];
  t = t.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt: string, href: string) => {
    const safe = /^(https?:|mailto:|#|\/|\.\/)/i.test(href) ? href : "#";
    return `<a href="${safe}">${txt}</a>`;
  });
  t = t.replace(/(^|[\s（(、，。；：「『])__([^_]+)__(?=$|[\s）)、，。；：」』])/g, "$1<strong>$2</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)]}</code>`);
  return t;
}

function closeLists(ctx: Ctx, out: string[]): void {
  while (ctx.listStack.length) out.push(`</${ctx.listStack.pop()}>`);
}

function renderTable(t: Table): string {
  const h = `<tr>${t.header
    .map((c, i) => `<th class="a-${t.aligns[i] ?? "left"}">${inline(c)}</th>`)
    .join("")}</tr>`;
  const b = t.rows
    .map((r) => `<tr>${r.map((c, i) => `<td class="a-${t.aligns[i] ?? "left"}">${inline(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="tw"><table><thead>${h}</thead><tbody>${b}</tbody></table></div>`;
}

/** Markdown 子集 → HTML */
function mdToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const ctx: Ctx = { listStack: [] };
  let para: string[] = [];

  const flush = () => {
    if (!para.length) return;
    closeLists(ctx, out);
    out.push(`<p>${para.map(inline).join("<br/>")}</p>`);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { flush(); continue; }

    const fence = trimmed.match(/^```(\w*)/);
    if (fence) {
      flush();
      closeLists(ctx, out);
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) buf.push(lines[i++]);
      const cls = fence[1] ? ` class="lang-${esc(fence[1])}"` : "";
      out.push(`<pre><code${cls}>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flush(); closeLists(ctx, out);
      out.push('<hr class="sep"/>');
      continue;
    }

    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush(); closeLists(ctx, out);
      const lv = h[1].length;
      out.push(`<h${lv}>${inline(h[2].trim())}</h${lv}>`);
      continue;
    }

    if (trimmed.startsWith("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush(); closeLists(ctx, out);
      const header = cells(trimmed);
      const aligns = cells(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"
      );
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      i--;
      out.push(renderTable({ header, rows, aligns }));
      continue;
    }

    if (trimmed.startsWith(">")) {
      flush(); closeLists(ctx, out);
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) buf.push(lines[i++].trim().replace(/^>\s?/, ""));
      i--;
      out.push(`<blockquote>${mdToHtml(buf.join("\n"))}</blockquote>`);
      continue;
    }

    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flush();
      const depth = Math.min(3, Math.floor(li[1].replace(/\t/g, "  ").length / 2));
      const kind = /^\d/.test(li[2]) ? "ol" : "ul";
      while (ctx.listStack.length > depth + 1) out.push(`</${ctx.listStack.pop()}>`);
      if (ctx.listStack.length === depth + 1 && ctx.listStack[depth] !== kind) out.push(`</${ctx.listStack.pop()}>`);
      if (ctx.listStack.length < depth + 1) { ctx.listStack.push(kind); out.push(`<${kind}>`); }
      out.push(`<li>${inline(li[3].trim())}</li>`);
      continue;
    }

    para.push(trimmed);
  }

  flush();
  closeLists(ctx, out);
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────── index.md 解析

type Entry = { label: string; file: string; span: string; when: string; blurb: string };

function parseSlot(cell: string): { file: string; span: string } {
  const code = cell.match(/`([^`]+\.md)`/);
  const file = code ? code[1].trim() : cell.replace(/\.md.*$/, "").trim() + ".md";
  const span = cell.replace(/`[^`]*`/g, "").trim().replace(/^[（(]|[）)]$/g, "").trim();
  return { file: file === ".md" ? "" : file, span };
}

function parseIndex(md: string): Entry[] {
  const tables = parseTables(md);
  const list =
    findTable(tables, "篇名", "檔案") ??
    findTable(tables, "#", "篇名") ??
    fatal("index.md 找不到「電子書篇章順序」表（需有「篇名」「檔案」欄）");

  const hdr = list.header;
  const col = (name: string) => hdr.findIndex((h) => h.includes(name));
  const iLabel = col("篇名"), iFile = col("檔案"), iWhen = col("時間定位"), iBlurb = col("一句話");
  if (iLabel < 0 || iFile < 0) fatal("index.md 篇章表缺少「篇名」或「檔案」欄");

  return list.rows
    .filter((r) => (r[iFile] ?? "").trim())
    .map((r) => {
      const { file, span } = parseSlot(r[iFile] ?? "");
      return {
        label: (r[iLabel] ?? "").trim(),
        file, span,
        when: (iWhen >= 0 ? r[iWhen] : "").trim(),
        blurb: (iBlurb >= 0 ? bare(r[iBlurb]) : "").trim(),
      };
    });
}

/** `一～九` → [1,9] */
function parseSpan(span: string): [number, number] | null {
  if (!span) return null;
  const idx = (ch: string) => CN_NUM.indexOf(ch);
  const m = span.match(new RegExp(`^([${CN_NUM}]+)\\s*[～~\\-—]\\s*([${CN_NUM}]+)$`));
  if (!m) return null;
  const val = (s: string): number => {
    if (s === "十") return 10;
    if (s.startsWith("十")) return 10 + (idx(s[1]) || 0);
    if (s.length === 1) return idx(s);
    if (s.length === 2 && s[1] === "十") return idx(s[0]) * 10;
    if (s.length === 3 && s[1] === "十") return idx(s[0]) * 10 + idx(s[2]);
    return NaN;
  };
  const a = val(m[1]), b = val(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a) return null;
  return [a, b];
}

// ─────────────────────────────────────────────────────────── ebook.md 設定

type Theme = {
  key: string; name: string; bg: string; paper: string; fg: string;
  fg2: string; fg3: string; accent: string; line: string; scheme: string;
};

type AppendixItem = { heading: string; label: string; note: string };

type Config = {
  title: string; subtitle: string; author: string; out: string; pageTitle: string;
  epigraph: string; tocTitle: string; tocHint: string; footer: string;
  themes: Theme[];
  fontDefault: number; fontMin: number; fontMax: number; fontStep: number; fontPresets: number[];
  familyDefault: string; families: { key: string; name: string; stack: string }[];
  lhDefault: number; lhPresets: number[];
  psDefault: number; measure: number; indent: boolean;
  appendixLabel: string; appendixTitle: string; appendix: AppendixItem[];
  features: Record<string, boolean>;
};

const HEX = /^#[0-9a-fA-F]{3,8}$/;

function parseEbook(md: string): Config {
  const tables = parseTables(md);
  const meta = findTable(tables, "鍵", "值") ?? fatal("ebook.md 找不到書目表");
  const get = (k: string, d = "") => findRow(meta, k) ?? d;

  const themeT = findTable(tables, "底色", "紙色", "正文");
  if (!themeT) fatal("ebook.md 找不到主題表（需有「底色」「紙色」「正文」欄）");
  const themes: Theme[] = themeT.rows.map((r) => {
    const key = bare(r[0]), name = bare(r[1]);
    const bg = bare(r[2]), paper = bare(r[3]), fg = bare(r[4]);
    for (const [label, v] of [["底色", bg], ["紙色", paper], ["正文", fg]] as const) {
      if (!HEX.test(v)) fatal(`主題「${name || key}」的${label}不是色碼：${v}`);
    }
    return {
      key: slug(key || name, "theme"), name: name || key,
      bg, paper, fg,
      fg2: bare(r[5]) || fg, fg3: bare(r[6]) || bare(r[5]) || fg,
      accent: bare(r[7]) || fg, line: bare(r[8]) || fg,
      scheme: /dark/i.test(r[9] ?? "") ? "dark" : "light",
    };
  });
  if (!themes.length) fatal("ebook.md 主題表是空的");

  const fontT = findTable(tables, "預設", "最小", "最大") ?? findTable(tables, "預設");
  const fontDefault = num(fontT && findRow(fontT, "預設"), 100);
  const fontMin = num(fontT && findRow(fontT, "最小"), 85);
  const fontMax = num(fontT && findRow(fontT, "最大"), 145);
  const fontStep = num(fontT && findRow(fontT, "級距"), 5);
  const fontPresets = numList(fontT && findRow(fontT, "預設組")).filter((n) => n >= fontMin && n <= fontMax);

  const layoutT = findTable(tables, "最大行寬") ?? findTable(tables, "行高組") ?? meta;
  const lhDefault = num(findRow(layoutT, "預設行高"), 1.9);
  const lhPresets = numList(findRow(layoutT, "行高組"));
  const psDefault = num(findRow(layoutT, "預設段距"), 1.0);
  const measure = num(findRow(layoutT, "最大行寬"), 34);
  const indent = bool(findRow(layoutT, "首行縮排"), false);

  const famT = findTable(tables, "名稱", "檔案路徑");
  const families: { key: string; name: string; stack: string }[] = [];
  if (famT) {
    for (const r of famT.rows) {
      const name = bare(r[0]), stack = bare(r[1]);
      if (name && stack) families.push({ key: slug(name, "f" + families.length), name, stack });
    }
  }
  if (!families.length) {
    families.push({ key: "serif", name: "宋", stack: `"Songti SC","SimSun","Noto Serif CJK TC",serif` });
    families.push({ key: "sans", name: "黑", stack: `"PingFang TC","Microsoft JhengHei",system-ui,sans-serif` });
  }

  const featT = findTable(tables, "開關") ?? findTable(tables, "說明");
  const features: Record<string, boolean> = {};
  if (featT) for (const r of featT.rows) features[(r[0] ?? "").trim()] = bool(r[1], true);
  const feat = (k: string, d = true) => (k in features ? features[k] : d);

  const appT = findTable(tables, "標題", "目錄標籤");
  const appendix: AppendixItem[] = appT
    ? appT.rows.filter((r) => bare(r[0])).map((r) => ({
        heading: bare(r[0]), label: bare(r[1]) || bare(r[0]), note: bare(r[2]),
      }))
    : [];

  return {
    title: get("書名", "未命名"),
    subtitle: get("副題"),
    author: get("作者") === "—" ? "" : get("作者"),
    out: get("輸出檔", "novel/gouxingji.html"),
    pageTitle: get("頁面標題", `《${get("書名", "未命名")}》`),
    epigraph: get("首頁題記"),
    tocTitle: get("目錄標題", "目次"),
    tocHint: get("目錄提示"),
    footer: get("頁尾"),
    themes, fontDefault, fontMin, fontMax, fontStep,
    fontPresets: fontPresets.length ? fontPresets : [fontMin, fontDefault, fontMax],
    familyDefault: families[0].key, families,
    lhDefault, lhPresets: lhPresets.length ? lhPresets : [1.7, 1.9, 2.2],
    psDefault, measure, indent,
    appendixLabel: get("附錄標籤", "附錄"), appendixTitle: get("附錄題名", "人物與設定"),
    appendix,
    features: {
      fontSize: feat("字級調整"), theme: feat("主題切換"), family: feat("字型切換"),
      leading: feat("行高調整"), toc: feat("目錄"), prevNext: feat("篇末上一／下一章"),
      progress: feat("閱讀進度"), keyboard: feat("鍵盤操作"), remember: feat("記住偏好"),
      print: feat("列印樣式"), noscriptToc: feat("目錄內全文"), backmatter: feat("後設資料"),
    },
  };
}

// ─────────────────────────────────────────────────────────── 組頁

type Section = { n: number; label: string; id: string; html: string; chars: number };
type Page = {
  n: number; label: string; file: string; when: string; blurb: string;
  kind: "novel" | "back"; title: string; id: string;
  sections: Section[]; html: string; chars: number; minutes: number;
};

function loadParts(file: string): { title: string; parts: { label: string; text: string }[] } {
  const raw = read(join(NOVEL, file), `novel/${file}`);
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  let title = basename(file, ".md");
  const parts: { label: string; text: string }[] = [];
  let cur: { label: string; text: string[] } | null = null;
  let seenTitle = false;

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.*)$/);
    const h2 = line.match(/^##\s+(.*)$/);
    if (h1 && !seenTitle) { title = h1[1].trim(); seenTitle = true; continue; }
    if (h2) {
      if (cur) parts.push({ label: cur.label, text: cur.text.join("\n") });
      cur = { label: h2[1].trim(), text: [] };
      continue;
    }
    if (cur) cur.text.push(line);
  }
  if (cur) parts.push({ label: cur.label, text: cur.text.join("\n") });
  return { title, parts };
}

/** 取出 index.md 裡指定的 ## 小節，依附錄表的次序與標籤 */
function buildAppendix(indexMd: string, items: AppendixItem[], id: string, warn: (s: string) => void): Section[] {
  const lines = indexMd.replace(/\r\n?/g, "\n").split("\n");
  const heads: { i: number; heading: string }[] = [];
  lines.forEach((l, i) => {
    const m = l.match(/^##\s+(.*)$/);
    if (m) heads.push({ i, heading: m[1].trim() });
  });

  const out: Section[] = [];
  for (const item of items) {
    const want = item.heading.replace(/\s/g, "");
    const at = heads.findIndex((h) => h.heading === item.heading || h.heading.replace(/\s/g, "").startsWith(want));
    if (at < 0) { warn(`附錄找不到 index.md 的小節「${item.heading}」，略過`); continue; }
    const from = heads[at].i + 1;
    const to = at + 1 < heads.length ? heads[at + 1].i : lines.length;
    const text = lines.slice(from, to).join("\n").replace(/\n-{3,}\s*$/, "").trimEnd();
    if (!text) { warn(`附錄「${item.heading}」是空的，略過`); continue; }
    const n = out.length + 1;
    const label = item.note ? `${item.label}——${item.note}` : item.label;
    out.push({
      n, label, id: `${id}-${n}`,
      html: `<h2 id="${id}-${n}">${inline(label)}</h2>\n${mdToHtml(text)}`,
      chars: text.replace(/\s/g, "").length,
    });
  }
  return out;
}

function buildPages(indexMd: string, cfg: Config, warn: (s: string) => void): Page[] {
  const pages: Page[] = [];
  let n = 0;

  for (const e of parseIndex(indexMd)) {
    const { title, parts } = loadParts(e.file);
    let use = parts;
    const span = parseSpan(e.span);
    if (span) {
      const [a, b] = span;
      if (b > parts.length) warn(`${e.file} 只有 ${parts.length} 節，章序表卻要 一～${cn(b)}`);
      use = parts.slice(a - 1, b);
      if (!use.length) { warn(`${e.file} 取不到第 ${a}～${b} 節，略過`); continue; }
    }

    n++;
    const id = `p${n}`;
    const sections: Section[] = use.map((p, i) => ({
      n: i + 1, label: p.label, id: `${id}-${i + 1}`,
      html: `<h2 id="${id}-${i + 1}">${inline(p.label)}</h2>\n${mdToHtml(p.text)}`,
      chars: p.text.replace(/\s/g, "").length,
    }));
    const chars = sections.reduce((s, x) => s + x.chars, 0);
    pages.push({
      n, label: e.label || title, file: e.file, when: e.when, blurb: e.blurb,
      kind: "novel", title, id, sections,
      html: sections.map((s) => s.html).join("\n"),
      chars, minutes: Math.max(1, Math.round(chars / 300)),
    });
  }

  if (cfg.features.backmatter && cfg.appendix.length) {
    const id = `p${n + 1}`;
    const sections = buildAppendix(indexMd, cfg.appendix, id, warn);
    if (sections.length) {
      n++;
      const chars = sections.reduce((s, x) => s + x.chars, 0);
      pages.push({
        n, label: cfg.appendixLabel, file: "index.md", when: "後設資料",
        blurb: sections.map((s) => s.label.split("——")[0]).join("、") + "。",
        kind: "back", title: cfg.appendixTitle, id, sections,
        html: sections.map((s) => s.html).join("\n"),
        chars, minutes: Math.max(1, Math.round(chars / 300)),
      });
    } else warn("附錄沒有取到任何小節，略過附錄");
  }

  if (!pages.length) fatal("一篇正文都沒取到，請檢查 index.md 的篇章表");
  return pages;
}

// ─────────────────────────────────────────────────────────── 樣式

function css(cfg: Config): string {
  const themeVars = cfg.themes
    .map((t) =>
      `[data-theme="${t.key}"]{color-scheme:${t.scheme};--bg:${t.bg};--paper:${t.paper};--fg:${t.fg};` +
      `--fg2:${t.fg2};--fg3:${t.fg3};--accent:${t.accent};--line:${t.line}}`
    )
    .join("");
  const famVars = cfg.families.map((f) => `--ff-${f.key}:${f.stack}`).join(";");
  const famClasses = cfg.families.map((f) => `[data-family="${f.key}"]{--ff:var(--ff-${f.key})}`).join("");

  return `
*,*::before,*::after{box-sizing:border-box}
:root{
  --bar-h:3.05rem;
  --fs:${cfg.fontDefault}%; --lh:${cfg.lhDefault}; --ps:${cfg.psDefault};
  --measure:${cfg.measure}rem;
  ${famVars}; --ff:var(--ff-${cfg.familyDefault});
}
${themeVars}
${famClasses}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--bg);color:var(--fg);
  font-family:var(--ff);font-size:var(--fs);line-height:var(--lh);
  letter-spacing:.01em;overflow-wrap:break-word;overflow-x:hidden;
  -webkit-tap-highlight-color:transparent;
}
body.lock{overflow:hidden}
.hidden{display:none!important}
::selection{background:var(--accent);color:var(--paper)}

/* ── 頂欄 ───────────────────────────── */
.top{
  position:sticky;top:0;z-index:50;display:flex;align-items:center;gap:.3rem;
  min-height:var(--bar-h);
  padding:.35rem max(.5rem,env(safe-area-inset-left)) .35rem max(.5rem,env(safe-area-inset-right));
  padding-top:calc(.35rem + env(safe-area-inset-top));
  background:var(--paper);border-bottom:1px solid var(--line);
}
.btn{
  flex:none;min-width:2.5rem;min-height:2.5rem;padding:0 .45rem;
  display:inline-flex;align-items:center;justify-content:center;
  font:inherit;font-size:.95rem;line-height:1;color:var(--fg);
  background:transparent;border:1px solid transparent;border-radius:.5rem;cursor:pointer;
}
.btn:hover{background:color-mix(in srgb,var(--line) 55%,transparent)}
.btn:active{background:var(--line)}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.btn[aria-pressed="true"]{border-color:var(--accent);color:var(--accent)}
.top-mid{flex:1;min-width:0;text-align:center;line-height:1.25}
.top-title{display:block;font-size:.92rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.top-sub{display:block;font-size:.7rem;color:var(--fg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.progress{position:absolute;left:0;bottom:-1px;height:2px;width:0;background:var(--accent);opacity:.7}

/* ── 目次（只列篇） ─────────────────── */
.toc{
  position:fixed;left:0;right:0;top:0;bottom:0;z-index:70;
  background:var(--bg);display:flex;flex-direction:column;
}
.toc-head{
  flex:none;display:flex;align-items:center;justify-content:space-between;gap:.5rem;
  min-height:var(--bar-h);padding:calc(.35rem + env(safe-area-inset-top)) .6rem .35rem 1rem;
  border-bottom:1px solid var(--line);background:var(--paper);
}
.toc-head h2{margin:0;font-size:.95rem;font-weight:600}
.toc-body{
  flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;
  padding:.4rem 0 calc(1.5rem + env(safe-area-inset-bottom));
}
.toc-hint{margin:.7rem 1.1rem 1rem;font-size:.78rem;color:var(--fg2);line-height:1.6}
.toc ol{margin:0;padding:0;list-style:none}
.toc li{margin:0}
.toc a{
  display:flex;align-items:baseline;gap:.7rem;min-height:3.2rem;
  padding:.7rem 1.1rem;color:var(--fg);text-decoration:none;border-bottom:1px solid var(--line);
}
.toc a:active{background:var(--line)}
.toc a .no{
  flex:none;color:var(--fg3);font-size:.8rem;font-variant-numeric:tabular-nums;
  min-width:1.4em;text-align:right;
}
.toc a .tt{flex:1;min-width:0;font-size:1rem}
.toc a .tt .sub{display:block;font-size:.74rem;color:var(--fg2);margin-top:.2rem;line-height:1.5;font-weight:400}
.toc a[aria-current="page"]{color:var(--accent);font-weight:700;background:color-mix(in srgb,var(--line) 40%,transparent)}
.toc a[aria-current="page"] .no{color:var(--accent)}

/* ── 正文 ───────────────────────────── */
.page{display:none}
.page.on{display:block}
.page{max-width:var(--measure);margin:0 auto;
  padding:clamp(.8rem,3.5vw,1.6rem) clamp(1rem,4.5vw,1.6rem) 2.5rem}
.chapter{padding-bottom:1rem}
.eyebrow{font-size:.72rem;letter-spacing:.2em;color:var(--fg3)}
.chapter h1{margin:.25rem 0 .1rem;font-size:1.6em;line-height:1.35;font-weight:700;letter-spacing:.02em}
.byline{margin:.5rem 0 0;font-size:.76rem;color:var(--fg2)}
.byline .dot{margin:0 .4rem;color:var(--fg3)}
.blurb{margin:.85rem 0 0;padding:.7rem .9rem;font-size:.85rem;color:var(--fg2);
  background:color-mix(in srgb,var(--line) 45%,transparent);border-radius:.5rem;line-height:1.75}
.body{background:var(--paper);border:1px solid var(--line);border-radius:.7rem;
  padding:clamp(1rem,4.5vw,1.8rem);margin-top:1.2rem}

.body h2{margin:2.2em 0 .8em;font-size:1.05em;font-weight:700;letter-spacing:.06em;
  display:flex;align-items:center;gap:.6em}
.body h2::before{content:"";flex:none;width:.2em;height:1em;background:var(--accent);border-radius:1px;opacity:.85}
.body h3{margin:1.8em 0 .6em;font-size:1em;font-weight:700;color:var(--fg2)}
.body h4,.body h5,.body h6{margin:1.5em 0 .5em;font-size:.95em;font-weight:700;color:var(--fg2)}
.body h2:first-child,.body h3:first-child{margin-top:0}
.body p{margin:0 0 calc(var(--ps) * 1em)}
.body p+p{margin-top:calc(var(--ps) * 1em)}
.body ul,.body ol{margin:0 0 1em;padding-left:1.5em}
.body li{margin:.3em 0}
.body strong{color:var(--accent);font-weight:700}
.body em{font-style:normal;color:var(--fg2)}
.body p>em:only-child{display:block;text-align:center;font-size:.92em;letter-spacing:.08em;margin:1.3em 0}
.body a{color:var(--accent);text-decoration:underline;text-underline-offset:.2em}
.body code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em;
  padding:.12em .38em;border-radius:.3em;background:color-mix(in srgb,var(--line) 60%,transparent)}
.body pre{margin:0 0 1.2em;padding:.85em 1em;overflow-x:auto;border-radius:.5rem;
  background:color-mix(in srgb,var(--line) 45%,transparent);border:1px solid var(--line)}
.body pre code{background:none;padding:0;font-size:.84em;line-height:1.7;white-space:pre}
.body blockquote{margin:1.2em 0;padding:.1em 0 .1em 1em;border-left:3px solid var(--accent);
  color:var(--fg2);font-size:.94em}
.body blockquote p:last-child{margin-bottom:0}
.body hr.sep{border:0;height:0;margin:2.2em auto;width:5rem;border-top:1px solid var(--line)}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 0 1.3em}
.body table{border-collapse:collapse;width:100%;font-size:.85em}
.body th,.body td{padding:.48em .6em;border-bottom:1px solid var(--line);vertical-align:top;line-height:1.7}
.body th{font-weight:700;color:var(--fg2);white-space:nowrap;border-bottom-width:2px}
.body tbody tr:last-child td{border-bottom:0}
.a-right{text-align:right;font-variant-numeric:tabular-nums}
.a-center{text-align:center}

.nav{display:flex;gap:.6rem;margin-top:1.4rem}
.nav a{
  flex:1;display:flex;flex-direction:column;gap:.15rem;justify-content:center;
  min-height:3rem;padding:.6rem .8rem;border:1px solid var(--line);border-radius:.5rem;
  background:var(--paper);color:var(--fg);text-decoration:none;font-size:.85rem;
}
.nav a:hover{border-color:var(--accent)}
.nav .k{font-size:.7rem;color:var(--fg3);letter-spacing:.1em}
.nav .t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nav .next{align-items:flex-end;text-align:right}
.foot{margin:2rem 0 1rem;text-align:center;font-size:.72rem;color:var(--fg3);line-height:1.8}

/* ── 設定面板 ───────────────────────── */
.sheet-wrap{position:fixed;inset:0;z-index:80;display:flex;align-items:flex-end;justify-content:center;
  background:rgb(0 0 0/.45)}
.sheet{width:100%;max-width:30rem;background:var(--paper);border:1px solid var(--line);
  border-radius:.9rem .9rem 0 0;max-height:88dvh;overflow-y:auto;
  padding:.2rem 1rem calc(1.3rem + env(safe-area-inset-bottom))}
.sheet h2{margin:0;padding:1rem 0 .7rem;font-size:.98rem;display:flex;align-items:center;
  justify-content:space-between;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--paper)}
.sheet .close{border:0;background:none;color:var(--fg2);font:inherit;cursor:pointer;padding:.3rem .5rem}
.row{margin:1.1rem 0}
.row>.k{display:block;font-size:.74rem;letter-spacing:.14em;color:var(--fg3);margin-bottom:.5rem}
.seg{display:flex;flex-wrap:wrap;gap:.4rem}
.seg button{
  min-height:2.4rem;padding:.35rem .8rem;font:inherit;font-size:.86rem;cursor:pointer;
  color:var(--fg);background:transparent;border:1px solid var(--line);border-radius:.5rem;
}
.seg button[aria-pressed="true"]{border-color:var(--accent);color:var(--accent);font-weight:700}
.seg button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.swatches{display:flex;flex-wrap:wrap;gap:.5rem}
.swatch{min-height:2.6rem;display:flex;align-items:center;gap:.45rem;padding:.3rem .7rem;
  font:inherit;font-size:.82rem;cursor:pointer;color:var(--fg);background:transparent;
  border:1px solid var(--line);border-radius:.5rem}
.swatch[aria-pressed="true"]{border-color:var(--accent);font-weight:700}
.swatch i{width:1.1rem;height:1.1rem;border-radius:50%;border:1px solid var(--line);flex:none}
.slider{display:flex;align-items:center;gap:.7rem;margin-top:.6rem}
.slider input[type=range]{flex:1;accent-color:var(--accent);height:2.2rem}
.slider .val{min-width:3.4rem;text-align:right;font-size:.84rem;color:var(--fg2);font-variant-numeric:tabular-nums}
.sheet .hint{font-size:.74rem;color:var(--fg3);line-height:1.7;margin:.5rem 0 0}
.sheet .reset{width:100%;min-height:2.6rem;margin-top:.8rem;font:inherit;font-size:.88rem;cursor:pointer;
  color:var(--fg);background:transparent;border:1px dashed var(--line);border-radius:.5rem}

/* ── 桌機 ───────────────────────────── */
@media (min-width:48rem){
  .sheet-wrap{align-items:center;padding:2rem}
  .sheet{border-radius:.9rem;max-height:80dvh;padding-bottom:1.4rem}
}
@media (prefers-reduced-motion:reduce){
  *{animation-duration:.01ms!important;transition-duration:.01ms!important}
}
@media print{
  ${cfg.features.print ? `
  .top,.toc,.sheet-wrap,.nav{display:none!important}
  body{background:#fff;color:#000;font-size:11pt}
  .page{display:block!important;max-width:none;padding:0;page-break-after:always}
  .page:last-child{page-break-after:auto}
  .body{border:0;padding:0;background:#fff;margin-top:1rem}
  .body strong{color:#000}
  .blurb{background:none;border:0;padding:0}
  a{color:#000;text-decoration:none}` : ""}
}
`.trim();
}

// ─────────────────────────────────────────────────────────── 前端腳本

function js(cfg: Config, pages: Page[]): string {
  const meta = pages.map((p) => ({
    n: p.n, id: p.id, label: p.label, title: p.title, kind: p.kind, minutes: p.minutes,
  }));

  return `
(function(){
'use strict';
var PAGES = ${jsonForScript(meta)};
var CFG = ${jsonForScript({
    features: cfg.features,
    themes: cfg.themes.map((t) => ({ key: t.key, name: t.name, paper: t.paper, fg: t.fg, fg2: t.fg2 })),
    families: cfg.families.map((f) => ({ key: f.key, name: f.name })),
    font: { def: cfg.fontDefault, min: cfg.fontMin, max: cfg.fontMax, step: cfg.fontStep, presets: cfg.fontPresets },
    lh: { def: cfg.lhDefault, presets: cfg.lhPresets },
    family: cfg.familyDefault,
    key: 'gouXingJi.ebook.v2',
  })};
var LAST = PAGES.length;
var root = document.documentElement;
var $ = function(s){ return document.querySelector(s); };
var $$ = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };
var cur = 1;

/* ── 偏好 ───────────────────────────── */
var store = {
  d: {},
  load: function(){
    if(!CFG.features.remember) return;
    try{ this.d = JSON.parse(localStorage.getItem(CFG.key) || '{}') || {}; }catch(e){ this.d = {}; }
  },
  save: function(){
    if(!CFG.features.remember) return;
    try{ localStorage.setItem(CFG.key, JSON.stringify(this.d)); }catch(e){}
  },
  get: function(k, d){ var v = this.d[k]; return v === undefined || v === null ? d : v; },
  set: function(k, v){ this.d[k] = v; this.save(); }
};

function clampFont(v){
  v = Math.round(Number(v) || CFG.font.def);
  return Math.min(CFG.font.max, Math.max(CFG.font.min, v));
}
function clampLh(v){
  v = Number(v) || CFG.lh.def;
  return CFG.lh.presets.indexOf(v) >= 0 ? v : CFG.lh.def;
}
function apply(){
  var fs = clampFont(store.get('font', CFG.font.def));
  var lh = clampLh(store.get('lh', CFG.lh.def));
  root.style.setProperty('--fs', fs + '%');
  root.style.setProperty('--lh', String(lh));
  root.setAttribute('data-theme', store.get('theme', CFG.themes[0].key));
  root.setAttribute('data-family', store.get('family', CFG.family));
  $$('#fontPresets button').forEach(function(b){ b.setAttribute('aria-pressed', String(Number(b.dataset.v) === fs)); });
  var sl = $('#fontRange');
  if(sl && Number(sl.value) !== fs) sl.value = String(fs);
  var fv = $('#fontVal'); if(fv) fv.textContent = fs + '%';
  $$('#lhPresets button').forEach(function(b){ b.setAttribute('aria-pressed', String(Number(b.dataset.v) === lh)); });
  var th = store.get('theme', CFG.themes[0].key);
  $$('.swatch').forEach(function(b){ b.setAttribute('aria-pressed', String(b.dataset.v === th)); });
  var fam = store.get('family', CFG.family);
  $$('#famPresets button').forEach(function(b){ b.setAttribute('aria-pressed', String(b.dataset.v === fam)); });
}
function stepFont(dir){
  var next = clampFont(clampFont(store.get('font', CFG.font.def)) + dir * CFG.font.step);
  if(next === clampFont(store.get('font', CFG.font.def))) return;
  store.set('font', next); apply();
}

/* ── 目次面板 ───────────────────────── */
var toc = $('#toc'), menuBtn = $('#menuBtn');
function tocOpen(){ return toc && !toc.classList.contains('hidden'); }
function openToc(){
  if(!toc) return;
  toc.classList.remove('hidden');
  document.body.classList.add('lock');
  menuBtn.setAttribute('aria-expanded', 'true');
  var c = $('#tocClose'); if(c) c.focus();
}
function closeToc(){
  if(!toc || !tocOpen()) return;
  toc.classList.add('hidden');
  document.body.classList.remove('lock');
  menuBtn.setAttribute('aria-expanded', 'false');
}

/* ── 設定面板 ───────────────────────── */
var sheet = $('#sheetWrap');
function sheetOpen(){ return sheet && !sheet.classList.contains('hidden'); }
function openSheet(){ sheet.classList.remove('hidden'); $('#setBtn').setAttribute('aria-expanded','true'); $('#sheetClose').focus(); }
function closeSheet(){ sheet.classList.add('hidden'); $('#setBtn').setAttribute('aria-expanded','false'); $('#setBtn').focus(); }

/* ── 閱讀位置 ───────────────────────── */
var pos = {};
function savePos(){
  var p = PAGES[cur - 1]; if(!p) return;
  pos[p.id] = Math.round(window.pageYOffset || document.documentElement.scrollTop || 0);
  store.set('pos', pos);
}
function jumpTop(){ window.scrollTo(0, 0); }

/* ── 換篇 ───────────────────────────── */
function pageEl(n){ return document.getElementById('p' + n); }
function markToc(n){
  $$('.toc a[data-n]').forEach(function(a){
    if(Number(a.dataset.n) === n) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}
function go(n, opts){
  opts = opts || {};
  n = Math.min(LAST, Math.max(1, n | 0));
  if(n === cur && !opts.force){ closeToc(); return; }
  savePos();
  var prev = pageEl(cur); if(prev) prev.classList.remove('on');
  cur = n;
  var el = pageEl(cur); if(el) el.classList.add('on');
  var top = $('#topTitle'), sub = $('#topSub');
  if(top) top.textContent = PAGES[cur - 1].label;
  if(sub) sub.textContent = '第 ' + cur + ' / ' + LAST + ' 篇';
  markToc(cur);
  store.set('last', cur);
  if(opts.keep){ var y = pos[PAGES[cur - 1].id] || 0; requestAnimationFrame(function(){ window.scrollTo(0, y); }); }
  else jumpTop();
  var want = '#p' + cur;
  if(location.hash !== want) history.pushState({ p: cur }, '', want);
  closeToc();
}
function hashPage(){
  var m = (location.hash || '').match(/^#p(\\d+)/);
  if(!m) return 0;
  var n = parseInt(m[1], 10);
  return n >= 1 && n <= LAST ? n : 0;
}

/* ── 事件 ───────────────────────────── */
function bind(){
  $('#menuBtn').addEventListener('click', function(){ if(tocOpen()) closeToc(); else openToc(); });
  var tc = $('#tocClose'); if(tc) tc.addEventListener('click', closeToc);
  $('#setBtn').addEventListener('click', function(){ if(sheetOpen()) closeSheet(); else openSheet(); });
  $('#sheetClose').addEventListener('click', closeSheet);
  sheet.addEventListener('click', function(e){ if(e.target === sheet) closeSheet(); });

  $$('.toc a[data-n]').forEach(function(a){
    a.addEventListener('click', function(e){
      e.preventDefault();
      go(Number(a.dataset.n));
    });
  });

  $$('#fontPresets button, #lhPresets button, #famPresets button, .swatch').forEach(function(b){
    b.addEventListener('click', function(){
      var g = b.dataset.g, v = b.dataset.v;
      if(g === 'font') store.set('font', clampFont(v));
      else if(g === 'lh') store.set('lh', Number(v));
      else if(g === 'fam') store.set('family', v);
      else if(g === 'theme') store.set('theme', v);
      apply();
    });
  });
  var fr = $('#fontRange');
  if(fr) fr.addEventListener('input', function(){ store.set('font', clampFont(fr.value)); apply(); });
  $('#fontDown').addEventListener('click', function(){ stepFont(-1); });
  $('#fontUp').addEventListener('click', function(){ stepFont(1); });
  $('#resetBtn').addEventListener('click', function(){
    store.d = {}; store.save(); pos = {};
    root.removeAttribute('data-theme'); root.removeAttribute('data-family');
    root.style.removeProperty('--fs'); root.style.removeProperty('--lh');
    apply();
  });

  window.addEventListener('popstate', function(e){
    var n = (e.state && e.state.p) || hashPage() || cur;
    go(n, { keep: true });
  });

  if(CFG.features.keyboard){
    document.addEventListener('keydown', function(e){
      var tag = ((e.target && e.target.tagName) || '').toLowerCase();
      if(tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if(e.key === 'Escape'){
        if(sheetOpen()) return closeSheet();
        if(tocOpen()) return closeToc();
        return;
      }
      if((e.ctrlKey || e.metaKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')){
        e.preventDefault(); stepFont(e.key === 'ArrowUp' ? 1 : -1); return;
      }
      if(e.ctrlKey || e.metaKey || e.altKey) return;
      if(e.key === '-' || e.key === '_'){ e.preventDefault(); stepFont(-1); return; }
      if(e.key === '=' || e.key === '+'){ e.preventDefault(); stepFont(1); return; }
      if(e.key === 'ArrowLeft' && cur > 1){ go(cur - 1); return; }
      if(e.key === 'ArrowRight' && cur < LAST){ go(cur + 1); return; }
    });
  }

  var ticking = false;
  window.addEventListener('scroll', function(){
    if(ticking) return;
    ticking = true;
    requestAnimationFrame(function(){
      ticking = false;
      var de = document.documentElement;
      var max = de.scrollHeight - window.innerHeight;
      var y = window.pageYOffset || de.scrollTop || 0;
      var bar = $('#bar');
      if(bar) bar.style.width = (max > 8 ? Math.min(100, Math.max(0, y / max * 100)) : 100).toFixed(2) + '%';
      savePos();
    });
  }, { passive: true });

  window.addEventListener('pagehide', savePos);
}

/* ── 初始化 ─────────────────────────── */
store.load();
pos = store.get('pos', {});
apply();
bind();

var start = hashPage() || Number(store.get('last', 1)) || 1;
if(!(start >= 1 && start <= LAST)) start = 1;
cur = 1;
go(start, { force: true, keep: true });
if(!location.hash) history.replaceState({ p: cur }, '', '#p' + cur);
})();
`.trim();
}

// ─────────────────────────────────────────────────────────── HTML

function renderToc(pages: Page[], cfg: Config): string {
  return `<ol>${pages
    .map(
      (p) => `<li><a href="#${p.id}" data-n="${p.n}"><span class="no">${cn(p.n)}</span><span class="tt">${esc(
        p.label
      )}<span class="sub">${p.kind === "back" ? "後設資料" : `約 ${p.minutes} 分鐘`}</span></span></a></li>`
    )
    .join("")}</ol>`;
}

function renderPage(p: Page, pages: Page[], cfg: Config): string {
  const prev = pages[p.n - 2];
  const next = pages[p.n];
  const nav = cfg.features.prevNext
    ? `<nav class="nav">
${prev ? `<a class="prev" href="#${prev.id}"><span class="k">上一篇</span><span class="t">${esc(prev.label)}</span></a>` : `<span style="flex:1"></span>`}
${next ? `<a class="next" href="#${next.id}"><span class="k">下一篇</span><span class="t">${esc(next.label)}</span></a>` : `<span style="flex:1"></span>`}
</nav>`
    : "";

  return `<section class="page" id="${p.id}" data-n="${p.n}">
<header class="chapter">
<span class="eyebrow">${p.kind === "back" ? "後設資料" : `第 ${cn(p.n)} 篇`}${p.when ? ` · ${esc(p.when)}` : ""}</span>
<h1>${esc(p.title)}</h1>
<p class="byline"><span>${esc(p.file)}</span><span class="dot">·</span><span>約 ${p.minutes} 分鐘</span><span class="dot">·</span><span>${p.chars.toLocaleString("en-US")} 字</span></p>
${p.blurb ? `<p class="blurb">${esc(p.blurb)}</p>` : ""}
</header>
<article class="body">
${p.html}
</article>
${nav}
${p.n === pages.length ? `<p class="foot">${esc(cfg.footer)}</p>` : ""}
</section>`;
}

function buildHtml(pages: Page[], cfg: Config): string {
  return `<!doctype html>
<html lang="zh-Hant" data-theme="${cfg.themes[0].key}" data-family="${cfg.familyDefault}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta name="color-scheme" content="light dark"/>
<meta name="theme-color" content="${cfg.themes[0].bg}"/>
<meta name="description" content="${esc(cfg.subtitle || cfg.title)}"/>
<title>${esc(cfg.pageTitle)}</title>
<meta name="generator" content="tools/gen-novel-html.ts"/>
<style>
${css(cfg)}
</style>
</head>
<body>

<header class="top">
  <button class="btn" id="menuBtn" aria-label="目次" aria-controls="toc" aria-expanded="false">☰</button>
  <span class="top-mid">
    <span class="top-title" id="topTitle">${esc(cfg.title)}</span>
    <span class="top-sub" id="topSub"></span>
  </span>
  <button class="btn" id="fontDown" aria-label="字級變小">A−</button>
  <button class="btn" id="fontUp" aria-label="字級變大">A+</button>
  <button class="btn" id="setBtn" aria-label="閱讀設定" aria-expanded="false">Aa</button>
  <span class="progress" id="bar"></span>
</header>

<nav class="toc hidden" id="toc" aria-label="${esc(cfg.tocTitle)}">
  <div class="toc-head">
    <h2>${esc(cfg.tocTitle)}</h2>
    <button class="btn" id="tocClose" aria-label="關閉目次">✕</button>
  </div>
  <div class="toc-body">
    ${cfg.tocHint ? `<p class="toc-hint">${esc(cfg.tocHint)}</p>` : ""}
    ${renderToc(pages, cfg)}
  </div>
</nav>

<main>
${pages.map((p) => renderPage(p, pages, cfg)).join("\n")}
</main>

<div class="sheet-wrap hidden" id="sheetWrap">
  <div class="sheet" role="dialog" aria-modal="true" aria-label="閱讀設定">
    <h2>閱讀設定 <button class="close" id="sheetClose" aria-label="關閉設定">完成</button></h2>

    ${cfg.features.fontSize ? `<div class="row">
      <span class="k">字級</span>
      <div class="seg" id="fontPresets">
        ${cfg.fontPresets.map((v) => `<button data-g="font" data-v="${v}" aria-pressed="false">${v}%</button>`).join("")}
      </div>
      <div class="slider">
        <input type="range" id="fontRange" min="${cfg.fontMin}" max="${cfg.fontMax}" step="${cfg.fontStep}" value="${cfg.fontDefault}" aria-label="字級"/>
        <span class="val" id="fontVal">${cfg.fontDefault}%</span>
      </div>
      <p class="hint">鍵盤 <code>-</code> <code>=</code> 或 <code>Ctrl+↑</code> <code>Ctrl+↓</code> 也可調整。</p>
    </div>` : ""}

    ${cfg.features.theme ? `<div class="row">
      <span class="k">背景</span>
      <div class="swatches">
        ${cfg.themes
          .map((t) => `<button class="swatch" data-g="theme" data-v="${t.key}" aria-pressed="false"><i style="background:${t.paper};border-color:${t.fg2}"></i>${esc(t.name)}</button>`)
          .join("")}
      </div>
    </div>` : ""}

    ${cfg.features.family ? `<div class="row">
      <span class="k">字型</span>
      <div class="seg" id="famPresets">
        ${cfg.families.map((f) => `<button data-g="fam" data-v="${f.key}" aria-pressed="false">${esc(f.name)}</button>`).join("")}
      </div>
    </div>` : ""}

    ${cfg.features.leading ? `<div class="row">
      <span class="k">行距</span>
      <div class="seg" id="lhPresets">
        ${cfg.lhPresets.map((v) => `<button data-g="lh" data-v="${v}" aria-pressed="false">${v}</button>`).join("")}
      </div>
    </div>` : ""}

    <button class="reset" id="resetBtn">回復預設</button>
    <p class="hint">設定與閱讀位置存在這台裝置的瀏覽器裡，不會上傳。</p>
  </div>
</div>

<noscript>
<nav aria-label="${esc(cfg.tocTitle)}">
<h1>${esc(cfg.title)}</h1>
<ol>${pages.map((p) => `<li><a href="#${p.id}">${esc(p.label)}</a></li>`).join("")}</ol>
</nav>
</noscript>

<script>
${js(cfg, pages)}
</script>
</body>
</html>
`;
}

// ─────────────────────────────────────────────────────────── main

function main(): void {
  const argv = process.argv.slice(2);
  const has = (f: string) => argv.includes(f);
  const valOf = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const warnings: string[] = [];
  const warn = (s: string) => warnings.push(s);

  const cfg = parseEbook(read(join(NOVEL, "ebook.md"), "novel/ebook.md"));
  const indexMd = read(join(NOVEL, "index.md"), "novel/index.md");
  const pages = buildPages(indexMd, cfg, warn);

  const out = resolve(ROOT, valOf("--out") ?? cfg.out);
  const html = buildHtml(pages, cfg);
  const bytes = Buffer.byteLength(html, "utf8");

  const novelPages = pages.filter((p) => p.kind === "novel");
  const totalChars = novelPages.reduce((s, p) => s + p.chars, 0);

  console.log(`《${cfg.title}》電子書`);
  console.log(`  輸入    novel/ebook.md、novel/index.md、${novelPages.length} 個正文檔`);
  console.log(`  篇章    ${pages.length} 篇（正文 ${novelPages.length} ＋ 後設資料 ${pages.length - novelPages.length}）`);
  console.log(`  正文    ${totalChars.toLocaleString("en-US")} 字，約 ${novelPages.reduce((s, p) => s + p.minutes, 0)} 分鐘`);
  console.log(`  主題    ${cfg.themes.map((t) => t.name).join("、")}　字級 ${cfg.fontMin}–${cfg.fontMax}%（預設 ${cfg.fontDefault}%）`);
  console.log(`  輸出    ${out.replace(ROOT + "\\", "").replace(ROOT + "/", "")}  ${(bytes / 1024).toFixed(0)} KB`);
  for (const p of pages) {
    console.log(`    ${String(p.n).padStart(2)}  ${p.label.padEnd(12, "　")}  ${String(p.sections.length).padStart(2)} 節  ${p.chars.toLocaleString("en-US").padStart(7)} 字  ${p.file}`);
  }
  for (const w of warnings) console.warn("  ! " + w);

  if (has("--check")) {
    console.log("\n（--check：未寫檔）");
    return;
  }
  writeFileSync(out, html, "utf8");
  console.log("\n✓ 已寫入 " + out);

  if (has("--open")) {
    const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", out] : [out];
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  }
}

main();
