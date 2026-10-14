#!/usr/bin/env bun
/**
 * probe-ids-ladder.ts — 量「**從 IDS 找構字序**」的搜尋空間（師父第 116 輪的問題 ✓）。
 *
 * 師父示範的解法（`⿰木⿳金⿰水火土` → `機幾墨黒𨩛星炚日水`）是一種**階梯**：
 *   機(木幾) → 右槽換成 墨(黒土) → 墨的黒換成 𨩛(金星) → 𨩛的星換成 炚(日火) → 炚的日換成 水
 * 每一步都**鑽進一個真字現成的槽位** ✓——所以框都是對的 ✓（＝「選形式」而不是「算框」✓）。
 *
 * 這一支量：每一層「可以當階梯的字」有多少個 ✓ → 就知道自動化要搜多大 ✓、難在哪裡 ✓。
 *
 * 用法: bun run tools/probe-ids-ladder.ts
 */
import { resolve } from "node:path";
import { loadIdsFile } from "./ids-source.ts";

const ROOT = resolve(import.meta.dir, "..");
const ARITY: Record<string, number> = {
  "⿰": 2, "⿱": 2, "⿲": 3, "⿳": 3, "⿴": 2, "⿵": 2, "⿶": 2, "⿷": 2,
  "⿸": 2, "⿹": 2, "⿺": 2, "⿻": 2,
};
type Node = { op: string; kids: Node[] } | { ch: string };
function parse(s: string): Node | null {
  const chars = Array.from(s);
  let i = 0;
  const walk = (): Node | null => {
    if (i >= chars.length) return null;
    const c = chars[i]!;
    if (c === "&" || c === "{" || c === "[" || c === "#" || c === "(") return null;
    if (ARITY[c] !== undefined) {
      i++;
      const kids: Node[] = [];
      for (let k = 0; k < ARITY[c]!; k++) { const kid = walk(); if (!kid) return null; kids.push(kid); }
      return { op: c, kids };
    }
    i++;
    return { ch: c };
  };
  const root = walk();
  return root && i === chars.length ? root : null;
}
const leaves = (n: Node, out: string[] = []): string[] => {
  if ("ch" in n) { out.push(n.ch); return out; }
  for (const k of n.kids) leaves(k, out);
  return out;
};
/** 這個樹裡有沒有「以某個字為運算元的算子」——用來找「階梯」的形狀 ✓ */
function hasShape(n: Node, op: string, childCh: string, pos: number): boolean {
  if ("ch" in n) return false;
  if (n.op === op) {
    const kid = n.kids[pos];
    if (kid && "ch" in kid && kid.ch === childCh) return true;
    const sub = n.kids[pos];
    if (sub && !("ch" in sub) && leaves(sub).includes(childCh)) return true;
  }
  for (const k of n.kids) if (hasShape(k, op, childCh, pos)) return true;
  return false;
}

const tab = loadIdsFile(resolve(ROOT, "ids/ids_lv1.txt"));
console.log(`IDS 來源：${tab.size.toLocaleString()} 個字`);
const trees: { cp: number; t: Node }[] = [];
for (const [cp, e] of tab) {
  if (!e.primary.length) continue;
  const t = parse(e.primary[0]!);
  if (t) trees.push({ cp, t });
}
console.log(`可解析：${trees.length.toLocaleString()} 個\n`);
const ch = (cp: number) => String.fromCodePoint(cp);
const hex = (cp: number) => "U+" + cp.toString(16).toUpperCase();

/** 師父那條階梯每一層的「形狀」＋量出來的可選字數 */
const steps: { why: string; test: (t: Node) => boolean }[] = [
  { why: "基字：要 ⿰ 而且左邊就是木（右槽再鑽進去 ✓）", test: (t) => hasShape(t, "⿰", "木", 0) },
  { why: "第 1 換：要有「土 在最下面」的槽（墨型 ⿱X土 ✓）", test: (t) => hasShape(t, "⿱", "土", 1) },
  { why: "第 2 換：要有「金 在左」的槽（𨩛型 ⿰金X ✓）", test: (t) => hasShape(t, "⿰", "金", 0) },
  { why: "第 3 換：要有「日 與 火 同層」的槽（炚型 ✓）", test: (t) => {
      if ("ch" in t) return false;
      if (t.op === "⿰" || t.op === "⿱") {
        const ls = t.kids.map((k) => leaves(k));
        if (ls.length === 2 && ls[0]!.includes("日") && ls[1]!.includes("火")) return true;
      }
      return t.kids.some((k) => steps[3]!.test(k));
    } },
  { why: "第 4 換：要有「日 在左」的槽（換成水 ✓）", test: (t) => hasShape(t, "⿰", "日", 0) },
];
console.log("師父那條階梯，每一層在字庫裡有多少可選字 ✓：");
for (let i = 0; i < steps.length; i++) {
  const hit = trees.filter((x) => steps[i]!.test(x.t));
  const bmp = hit.filter((x) => x.cp >= 0x4e00 && x.cp <= 0x9fff);
  console.log(`  ${i}. ${steps[i]!.why}\n     → ${hit.length.toLocaleString()} 個（其中一般漢字 ${bmp.length.toLocaleString()}）` +
    `　例：${hit.slice(0, 8).map((x) => hex(x.cp) + ch(x.cp)).join(" ")}`);
}

/* 從「機」出發、走師父那條路，看每一步實際的候選有多少（＝搜尋分支） */
console.log("\n實際路徑上的分支（師父走的每一步，當時有多少選擇 ✓）：");
const byCp = new Map(trees.map((x) => [x.cp, x.t]));
const show = (cp: number, label: string) => {
  const t = byCp.get(cp);
  if (!t) { console.log(`  ${label} ${hex(cp)}：IDS 來源裡沒有分解 ✗`); return; }
  const ls = leaves(t);
  console.log(`  ${label} ${hex(cp)} ${ch(cp)}：${ls.join("＋")}（${ls.length} 葉）`);
};
for (const [cp, label] of [[0x6a5f, "基字"], [0x58a8, "第1換"], [0x28a5b, "第2換"], [0x709a, "第3換"]] as [number, string][]) show(cp, label);
