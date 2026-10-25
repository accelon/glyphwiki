/**
 * Self-explaining tour: `.tour` script → compiled macro data.
 *
 * ⚠ **這一份是 vendored（從上游搬進來、只做兩處小改）**：
 *   來源 `D:\2026\agent-norms\self-explaining-tour\compiler.ts`（2026-10-25 搬入）。
 *   改動只有兩處 ✓（都標了 `@local`）：
 *     ① `templateHtml`（@local）：本專案的頁面是**建置器當場組出來的樣板字串**，沒有實體的 template 檔，
 *        所以除了 `templateFile` 以外也可以直接給一段 HTML（`#id` 的靜態檢查照樣有效 ✓）。
 *     ② `outFile` 改成選用（@local）：本專案**不落地** `tour-data.ts`——
 *        編譯結果由建置器直接內嵌進產出頁，少一份會走鐘的中間檔 ✓
 *        （理由見 `pinxing.md`〈操作導覽〉）。
 *
 * The compiler is intentionally separate from the app:
 *   * scripts are a small Markdown dialect that non-programmers can edit;
 *   * the output is compact binary + base64, embedded in a single-file build;
 *   * typos in commands, selectors, tab names and `api:` paths fail at build time.
 *
 * A consumer supplies a `TourCompilerConfig` (paths + allow-lists) and calls
 * `compileTours()`. See `build-tours.ts` for the CLI wrapper.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { encodeTour, toBase64, OP, type Tour, type Scene, type Step, type TourMeta } from './format';

/** Script syntax allow-lists. Empty/undefined = don't validate that dimension. */
export interface TourSyntax {
  /** command aliases; defaults include 中文 + English */
  aliases?: Record<string, string>;
  /** `設定` keys the app understands */
  setKeys?: string[];
  /** `呼叫` function names the app understands */
  callNames?: string[];
  /** `分頁` names the app understands */
  tabNames?: string[];
  /** top-level keys of the app's state() for `api:` conditions */
  apiKeys?: string[];
}

export interface TourCompilerConfig extends TourSyntax {
  /** directory containing `*.tour` */
  tourDir: string;
  /** generated TypeScript file（@local：本專案不落地，選用＝不寫檔） */
  outFile?: string;
  /** optional HTML template; enables static `#id` checks */
  templateFile?: string;
  /** @local：劇本在選單裡的**順序**（`['welcome', 'find']`）——沒有列的排在後面，按檔名 ✓。
   *  為什麼需要：`readdirSync().sort()` 是**檔名字母序**（find 會排在 welcome 前面 ✗），
   *  而選單的第一列就是客人最先點的那一份 ✓——順序是給人看的，不是給檔案系統看的 ✓。 */
  order?: string[];
  /** @local：直接給一段 HTML 當 template（建置器當場組出來的那一頁）——`#id` 檢查照樣有效 */
  templateHtml?: string;
  /** ids created at runtime, not present in the template */
  dynamicIds?: string[];
  /** 5-byte ASCII magic; default `TOUR1` */
  magic?: string;
  /** import path for types in the generated file; default `./format` */
  formatImport?: string;
  /** extra header comment */
  header?: string;
}

export interface CompileResult {
  tours: Tour[];
  index: TourMeta[];
  blobs: Record<string, string>;
  text: string;
  errors: string[];
}

/** Identity helper for `tour.config.ts` (typing + editor completion). */
export function defineTourConfig(config: TourCompilerConfig): TourCompilerConfig {
  return config;
}

/** Chinese + English aliases. Add app-specific aliases in the config if needed. */
export const DEFAULT_ALIASES: Record<string, string> = {
  說: 'text', text: 'text', say: 'text',
  指向: 'point', point: 'point',
  不指向: 'unpoint', unpoint: 'unpoint',
  點: 'click', click: 'click',
  輸入: 'type', type: 'type',
  按鍵: 'key', key: 'key',
  等: 'wait', wait: 'wait',
  等頁面: 'waitFor', waitfor: 'waitFor',
  分頁: 'tab', tab: 'tab',
  側欄: 'side', side: 'side',
  設定: 'set', set: 'set',
  呼叫: 'call', call: 'call',
  你來: 'user', user: 'user',
  需要: 'require', require: 'require',
  若非: 'skipIf', skipif: 'skipIf', skipIf: 'skipIf',
  停: 'tap', tap: 'tap',
};

const normCol = (s: string): 'L' | 'R' | null => {
  if (s === '左' || s === 'L' || s === 'l' || s === 'left') return 'L';
  if (s === '右' || s === 'R' || s === 'r' || s === 'right') return 'R';
  return null;
};
const isOn = (s: string): boolean => s === '開' || s === 'on' || s === '1' || s === 'true';
const isOff = (s: string): boolean => s === '關' || s === 'off' || s === '0' || s === 'false';
const setOf = (xs?: string[]): Set<string> => new Set(xs ?? []);

/** Trim outer blank lines, keep internal blanks (Markdown paragraphs). */
function cleanBody(lines: string[]): string {
  const trimmed = lines.map((l) => l.replace(/\s+$/, ''));
  let a = 0;
  let b = trimmed.length;
  while (a < b && trimmed[a] === '') a++;
  while (b > a && trimmed[b - 1] === '') b--;
  return trimmed.slice(a, b).join('\n');
}

export interface Parsed {
  tour: Tour;
  errors: string[];
}

/** Validate a condition's shape. `api:` keys are checked against the allow-list. */
function checkCond(cond: string, apiKeys: Set<string>, err: (m: string) => void): void {
  const c = cond.startsWith('!') ? cond.slice(1) : cond;
  if (!c) { err('條件是空的'); return; }
  const m = /^api:([A-Za-z0-9_.]+)(?:=(.*))?$/.exec(c);
  if (m) {
    const head = m[1].split('.')[0];
    if (apiKeys.size && !apiKeys.has(head)) err(`api: 不認得 ${head}（可用：${[...apiKeys].join(' ')}）`);
    return;
  }
  if (/^count:/.test(c)) {
    if (!/\S/.test(c.slice(6))) err('count: 後面要接選擇器');
    return;
  }
  if (/^text:/.test(c)) {
    if (!/=/.test(c)) err('text: 的寫法是 text:選擇器=文字');
    return;
  }
  if (!/^[#.[a-zA-Z]/.test(c)) err(`看不懂的條件：${cond}`);
}

/** One `> command args` line → Step. */
function parseStep(
  word: string,
  rest: string,
  syntax: TourSyntax,
  err: (m: string) => void,
): Step | null {
  const aliases = { ...DEFAULT_ALIASES, ...(syntax.aliases ?? {}) };
  const setKeys = setOf(syntax.setKeys);
  const callNames = setOf(syntax.callNames);
  const tabNames = setOf(syntax.tabNames);
  const apiKeys = setOf(syntax.apiKeys);
  const name = aliases[word] ?? aliases[word.toLowerCase()] ?? null;
  if (!name) {
    err(`不認得的指令「${word}」（可用：${[...new Set(Object.keys(aliases))].join(' ')}）`);
    return null;
  }
  const r = rest.trim();
  const two = r.split(/\s+/).filter(Boolean);
  const arrow = r.indexOf('=>');
  const left = arrow >= 0 ? r.slice(0, arrow).trim() : r;
  const right = arrow >= 0 ? r.slice(arrow + 2).trim() : '';

  switch (name) {
    case 'text':
      if (!r) { err('說 後面要接文字'); return null; }
      return { op: OP.text, args: [r] };
    case 'point':
    case 'click':
      if (!r) { err(`${name} 後面要接選擇器`); return null; }
      return { op: OP[name as 'point' | 'click'], args: [r] };
    case 'unpoint':
      return { op: OP.unpoint, args: [] };
    case 'type':
      if (arrow < 0 || !left) { err('輸入 的寫法是：輸入 選擇器 => 文字'); return null; }
      return { op: OP.type, args: [left, right] };
    case 'key':
      if (!two.length) { err('按鍵 後面要接鍵名（例：Enter、Escape）'); return null; }
      return { op: OP.key, args: two.length > 1 ? [two[0], two.slice(1).join(' ')] : [two[0]] };
    case 'wait': {
      if (!two.length || !/^\d+$/.test(two[0])) { err('等 後面要接毫秒數'); return null; }
      return { op: OP.wait, args: [two[0]] };
    }
    case 'waitFor': {
      let cond = r;
      let timeout = '';
      const last = two[two.length - 1] ?? '';
      const prev = two[two.length - 2] ?? '';
      const op = /^(>=|<=|==|!=|>|<)$/.test(prev);
      // A trailing number is a timeout only when it is not the right-hand side of a comparison.
      if (two.length > 1 && /^\d+$/.test(last) && !op) {
        cond = r.slice(0, r.length - last.length).trim();
        timeout = last;
      }
      if (!cond) { err('等頁面 後面要接條件（例：#searchList .snippet）'); return null; }
      checkCond(cond, apiKeys, err);
      return { op: OP.waitFor, args: timeout ? [cond, timeout] : [cond] };
    }
    case 'tab': {
      if (two.length < 2) { err('分頁 的寫法是：分頁 左|右 名稱'); return null; }
      const col = normCol(two[0]);
      if (!col) { err(`分頁 的第一個參數要是 左 或 右（收到「${two[0]}」）`); return null; }
      const tab = two[1];
      if (tabNames.size && !tabNames.has(tab)) err(`不認得的分頁「${tab}」（可用：${[...tabNames].join(' ')}）`);
      return { op: OP.tab, args: [col, tab] };
    }
    case 'side': {
      if (two.length < 2) { err('側欄 的寫法是：側欄 左|右 開|關'); return null; }
      const col = normCol(two[0]);
      if (!col) { err(`側欄 的第一個參數要是 左 或 右（收到「${two[0]}」）`); return null; }
      if (!isOn(two[1]) && !isOff(two[1])) { err(`側欄 的第二個參數要是 開 或 關（收到「${two[1]}」）`); return null; }
      return { op: OP.side, args: [col, isOn(two[1]) ? 'on' : 'off'] };
    }
    case 'set': {
      if (two.length < 2) { err('設定 的寫法是：設定 鍵 值'); return null; }
      if (setKeys.size && !setKeys.has(two[0])) err(`不認得的設定鍵「${two[0]}」（可用：${[...setKeys].join(' ')}）`);
      return { op: OP.set, args: [two[0], two[1]] };
    }
    case 'call': {
      if (!left) { err('呼叫 的寫法是：呼叫 函式名 => 參數'); return null; }
      if (callNames.size && !callNames.has(left)) err(`不認得的函式「${left}」（可用：${[...callNames].join(' ')}）`);
      return { op: OP.call, args: right ? [left, right] : [left] };
    }
    case 'user':
      if (!left) { err('你來 的寫法是：你來 說明 => 完成條件'); return null; }
      if (right) checkCond(right, apiKeys, err);
      return { op: OP.user, args: right ? [left, right] : [left] };
    case 'require':
    case 'skipIf':
      if (!r) { err(`${name} 後面要接條件`); return null; }
      checkCond(r, apiKeys, err);
      return { op: name === 'require' ? OP.require : OP.skipIf, args: [r] };
    case 'tap':
      return { op: OP.tap, args: r ? [r] : [] };
    default:
      err(`未實作的指令 ${name}`);
      return null;
  }
}

export function parseTour(src: string, file: string, syntax: TourSyntax = {}): Parsed {
  const lines = src.replace(/^\uFEFF/, '').split(/\r?\n/);
  const errors: string[] = [];
  const tour: Tour = { id: '', title: '', intro: '', require: '', scenes: [] };
  let scene: Scene | null = null;
  let body: string[] = [];
  let seenScene = false;

  const flush = (): void => {
    if (!scene) return;
    scene.body = cleanBody(body);
    tour.scenes.push(scene);
    scene = null;
    body = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const ln = i + 1;
    const at = (m: string): void => { errors.push(`${file}:${ln}  ${m}`); };

    const head = /^\s*(#{3,})\s*(.*)$/.exec(raw);
    if (head) {
      flush();
      seenScene = true;
      scene = { title: head[2].trim() || `場景 ${tour.scenes.length + 1}`, body: '', steps: [] };
      continue;
    }
    const cmd = /^\s*>\s?(.*)$/.exec(raw);
    if (cmd) {
      const text = cmd[1].trim();
      if (!text) { at('`>` 後面是空的'); continue; }
      if (!scene) { at('指令必須在一個 `### 場景` 裡面'); continue; }
      const sp = text.search(/\s/);
      const word = sp < 0 ? text : text.slice(0, sp);
      const rest = sp < 0 ? '' : text.slice(sp + 1);
      const st = parseStep(word, rest, syntax, at);
      if (st) scene.steps.push(st);
      continue;
    }
    const dir = /^\s*@(\w+)\s+(.*)$/.exec(raw);
    if (dir && ['id', 'title', 'intro', 'require'].includes(dir[1])) {
      if (seenScene) { at('`@` 檔頭資訊要放在第一個場景之前'); continue; }
      const v = dir[2].trim();
      if (dir[1] === 'id') tour.id = v;
      else if (dir[1] === 'title') tour.title = v;
      else if (dir[1] === 'intro') tour.intro = v;
      else tour.require = v;
      continue;
    }
    if (/^\s*#(?!#)\s?/.test(raw)) continue;
    if (scene) body.push(raw);
    else if (raw.trim()) at('場景之外的文字沒有去處（要放進場景，或寫成 `@intro`）');
  }
  flush();

  const base = file.replace(/^.*[\\/]/, '').replace(/\.tour$/, '');
  if (!tour.id) tour.id = base;
  if (tour.id !== base) errors.push(`${file}  @id「${tour.id}」要跟檔名「${base}」一致`);
  if (!tour.title) tour.title = tour.id;
  if (!tour.scenes.length) errors.push(`${file}  沒有任何場景（用 \`### 標題\` 開始一個場景）`);
  return { tour, errors };
}

function templateIds(
  file: string | undefined,
  htmlGiven: string | undefined,
  dynamicIds: string[],
): Set<string> | null {
  /* @local：`templateHtml` 直接給一段 HTML（建置器當場組出來的那一頁）——
     與讀檔案的結果完全一樣，只是不必先把頁面寫到磁碟再讀回來 ✓。 */
  const html = htmlGiven !== undefined ? htmlGiven : (file ? readFileSync(file, 'utf8') : null);
  if (html === null) return null;
  const ids = new Set<string>();
  for (const m of html.matchAll(/id="([A-Za-z][\w-]*)"/g)) ids.add(m[1]);
  for (const d of dynamicIds) ids.add(d);
  return ids;
}

function checkSelector(
  sel: string,
  ids: Set<string> | null,
  tabNames: Set<string>,
  err: (m: string) => void,
): void {
  if (ids) {
    for (const m of sel.matchAll(/#([A-Za-z][\w-]*)/g)) {
      if (!ids.has(m[1])) err(`選擇器裡的 #${m[1]} 在 template 裡找不到（改名了？打錯字？）`);
    }
  }
  for (const m of sel.matchAll(/\[data-tab=["']?([\w-]+)/g)) {
    if (tabNames.size && !tabNames.has(m[1])) err(`data-tab="${m[1]}" 不是已知分頁`);
  }
}

function lint(tour: Tour, config: TourCompilerConfig, ids: Set<string> | null, err: (m: string) => void): void {
  const tabNames = setOf(config.tabNames);
  const apiKeys = setOf(config.apiKeys);
  if (!tour.title) err('缺 @title');
  tour.scenes.forEach((sc, i) => {
    if (!sc.title) err(`場景 ${i + 1} 沒有標題`);
    if (!sc.body && !sc.steps.length) err(`場景 ${i + 1}「${sc.title}」是空的`);
    sc.steps.forEach((st, j) => {
      const where = (m: string) => err(`場景 ${i + 1} 第 ${j + 1} 步：${m}`);
      if (!st.args.length && st.op !== OP.unpoint && st.op !== OP.tap) where('缺參數');
      for (const a of st.args) {
        checkSelector(a, ids, tabNames, where);
        if (/^api:/.test(a)) checkCond(a, apiKeys, where);
      }
    });
  });
}

/**
 * Compile all `*.tour` files into generated TypeScript text.
 * Does not write; the caller decides (CLI writes or compares with `--check`).
 */
export function compileTours(config: TourCompilerConfig): CompileResult {
  const errors: string[] = [];
  const tourDir = resolve(config.tourDir);
  const template = config.templateFile ? resolve(config.templateFile) : undefined;
  const magic = config.magic ?? 'TOUR1';

  if (!existsSync(tourDir)) {
    errors.push(`沒有 ${tourDir}（放 *.tour 劇本的地方）`);
    return { tours: [], index: [], blobs: {}, text: '', errors };
  }
  const files = readdirSync(tourDir).filter((f) => f.endsWith('.tour')).sort();
  if (!files.length) {
    errors.push(`${tourDir} 裡沒有 .tour 劇本`);
    return { tours: [], index: [], blobs: {}, text: '', errors };
  }

  let ids: Set<string> | null = null;
  if (config.templateHtml !== undefined) {
    /* @local：建置器直接把「剛組好的那一頁」交進來（不必先落地再讀回來 ✓）。 */
    ids = templateIds(undefined, config.templateHtml, config.dynamicIds ?? []);
  } else if (template) {
    if (!existsSync(template)) errors.push(`template 不存在：${template}`);
    else ids = templateIds(template, undefined, config.dynamicIds ?? []);
  }

  const tours: Tour[] = [];
  for (const f of files) {
    const src = readFileSync(resolve(tourDir, f), 'utf8');
    const parsed = parseTour(src, f, config);
    let bad = parsed.errors.length;
    for (const m of parsed.errors) errors.push(m);
    const lintErrors: string[] = [];
    lint(parsed.tour, config, ids, (m) => lintErrors.push(`${f}  ${m}`));
    for (const m of lintErrors) errors.push(m);
    bad += lintErrors.length;
    if (!bad) tours.push(parsed.tour);
  }
  if (errors.length) return { tours: [], index: [], blobs: {}, text: '', errors };

  /* @local：選單順序（見 config 的 order）——`tours` 目前是檔名序 ✓，這裡按 order 重排 ✓。
     `sort` 在 V8／JavaScriptCore 都是穩定排序，所以沒列到的仍保持檔名序 ✓。 */
  const order = config.order ?? [];
  if (order.length) {
    for (const id of order) {
      if (!tours.some((t) => t.id === id)) errors.push(`tour.config 的 order 指到不存在的劇本「${id}」`);
    }
    if (errors.length) return { tours: [], index: [], blobs: {}, text: '', errors };
    const rank = (id: string): number => { const i = order.indexOf(id); return i < 0 ? order.length + 1 : i; };
    tours.sort((a, b) => rank(a.id) - rank(b.id));
  }

  const index: TourMeta[] = tours.map((t) => ({
    id: t.id, title: t.title, intro: t.intro, scenes: t.scenes.length,
    steps: t.scenes.reduce((a, s) => a + s.steps.length, 0),
    require: t.require,
    bytes: encodeTour(t, magic).length,
  }));
  const blobs: Record<string, string> = Object.fromEntries(
    tours.map((t) => [t.id, toBase64(encodeTour(t, magic))]),
  );
  const formatImport = config.formatImport ?? './format';
  const extra = config.header ? `\n * ${config.header}\n` : '';
  const text = `/**
 * AUTO-GENERATED by self-explaining-tour/compiler.ts — do not edit.
 *
 * Edit ${JSON.stringify(config.tourDir)}/*.tour then run the build command.
 *${extra} */
import type { TourMeta } from '${formatImport}';

/** Menu summary; can render without decoding blobs. */
export const TOUR_INDEX: TourMeta[] = ${JSON.stringify(index, null, 2)};

/** id → base64 macro */
export const TOUR_BLOBS: Record<string, string> = {
${Object.entries(blobs).map(([id, b]) => `  ${JSON.stringify(id)}: '${b}',`).join('\n')}
};
`;
  return { tours, index, blobs, text, errors: [] };
}

/** Write the generated file (used by the CLI). */
export function writeCompiled(result: CompileResult, outFile: string): void {
  const file = resolve(outFile);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, result.text, 'utf8');
}
