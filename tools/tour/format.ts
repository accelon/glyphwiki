/**
 * Self-explaining tour: compiled macro format.
 *
 * ⚠ **這一份是 vendored（原封不動搬進來的上游模組）**，不是本專案寫的：
 *   來源 `D:\2026\agent-norms\self-explaining-tour\format.ts`（2026-10-25 搬入）。
 *   上游是唯一的真實來源 ✓——要改格式請改上游、再整份搬過來 ✗，
 *   不要在這裡順手改（這個專案吃過「同一個東西兩份來源各說各話」的虧，見 `tools/embed-common.ts` 檔頭）。
 *
 * 這一份只給**建置期**（`bun run tools/build-pinxing.ts`）用：把 `.tour` 編成緊湊的巨集。
 * 頁面端不能用它（那是 TS ＋ node 模組）——頁面端有一份 ES5 的解碼器，
 * 在 `tools/tour/player.js` ✓（同一份位元組格式 ✓，兩邊都有 CRC 與版本號可以互相抓錯 ✓）。
 *
 * Three layers:
 *   1. `.tour` script (human-authored Markdown dialect)
 *   2. macro (this file: binary + base64; compact, not encrypted)
 *   3. player (`player.ts`) — decodes the macro and performs each step
 *
 * Why compile to binary instead of embedding the raw script?
 *   * single-file HTML under `file://` cannot fetch a sibling file, so data must be inline;
 *   * the player is decoupled from the DSL version;
 *   * accidental edits break loudly (CRC/version), not silently.
 *
 * Format (little-endian):
 *
 *   "TOUR1"          5 bytes    magic (configurable)
 *   u8               1           format version (TOUR_FMT)
 *   u8               1           flags (reserved, 0)
 *   u32              4           payload CRC32
 *   str id | str title | str intro | str require
 *   u16              2           scene count
 *     each scene: str title | str body(Markdown) | u16 step count
 *       each step: u8 opcode | u8 arg count | args × str
 *
 *   str = u16 byte length + UTF-8 bytes (max 65535)
 *
 * Numbers are stored as strings ("400"); the player calls Number().
 */

export const TOUR_MAGIC = 'TOUR1';

/** Older apps may still carry this magic; decode accepts it for migration. */
export const LEGACY_MAGICS = ['AC26T'] as const;

/** Format version. Increment when the encoding changes. */
export const TOUR_FMT = 1;

/** 單一指令。名字是小寫英文，劇本裡可以用中文別名（見 build-tours.ts 的 ALIAS）。 */
export const OP = {
  /** 換氣泡文字（場景中途分兩段講） */
  text: 1,
  /** 聚光燈照到某個元素 */
  point: 2,
  /** 收掉聚光燈 */
  unpoint: 3,
  /** el.click() */
  click: 4,
  /** 設值 ＋ 派送 input 事件（走真實的 debounce 路徑） */
  type: 5,
  /** 在指定元素（預設 activeElement）上派送 keydown */
  key: 6,
  /** 單純停一下，讓眼睛跟上 */
  wait: 7,
  /** 輪詢到條件成立 */
  waitFor: 8,
  /** 切換某一欄的分頁 */
  tab: 9,
  /** 顯示／收起某一欄 */
  side: 10,
  /** 設定項（advanced / variants / pagemarks / simmode / hardbreaks / raw） */
  set: 11,
  /** 白名單函式（openSettings / runSearchAll / dictLookup …） */
  call: 12,
  /** 等使用者自己做完（附完成條件） */
  user: 13,
  /** 條件不成立就停在這裡等（資料庫沒開、不是桌面版…） */
  require: 14,
  /** 條件成立就整場跳過 */
  skipIf: 15,
  /**
   * 停在這裡，等使用者**在畫面任何地方點一下**（或按空白／→／Enter）才繼續
   * （作者 2026-10-18：介紹介面的場景要用這種「等你看完」的節奏，不是自動跑完）
   */
  tap: 16,
} as const;

export type OpCode = (typeof OP)[keyof typeof OP];

/** opcode → 名字（錯誤訊息與測試用） */
export const OP_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(OP).map(([k, v]) => [v, k]),
);

/** 劇本裡的一步。`args` 的內容由 `op` 決定，見上面 OP 的註解。 */
export interface Step {
  op: number;
  args: string[];
}

/** 一個場景：一段說明文字 ＋ 一串指令。 */
export interface Scene {
  title: string;
  /** Markdown（只支援 **粗體**、`等寬`、空行分段） */
  body: string;
  steps: Step[];
}

/** 選單用的摘要（`tour-data.ts` 的 TOUR_INDEX；播放器不播放也能列出清單） */
export interface TourMeta {
  id: string;
  title: string;
  intro: string;
  scenes: number;
  steps: number;
  /** 檔案頭的 @require（例：`db=13j`）；空字串＝沒有要求 */
  require: string;
  /** 宏的位元組數（診斷用：多大一坨塞進 HTML） */
  bytes: number;
}

/** 一整份劇本。 */
export interface Tour {
  id: string;
  title: string;
  intro: string;
  /** 檔案頭的 `@require`（例：`db=13j`）；空字串＝沒有要求 */
  require: string;
  scenes: Scene[];
}

// ------------------------------------------------------------------ byte I/O
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

class Writer {
  private b: number[] = [];
  u8(v: number): void { this.b.push(v & 0xff); }
  u16(v: number): void { this.b.push(v & 0xff, (v >> 8) & 0xff); }
  u32(v: number): void {
    this.b.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  }
  raw(a: Uint8Array): void { for (const x of a) this.b.push(x); }
  str(s: string): void {
    const u = enc.encode(s);
    if (u.length > 0xffff) throw new Error(`字串太長（${u.length} bytes，上限 65535）：${s.slice(0, 20)}…`);
    this.u16(u.length);
    this.raw(u);
  }
  bytes(): Uint8Array { return new Uint8Array(this.b); }
}

class Reader {
  i = 0;
  constructor(private readonly d: Uint8Array) {}
  u8(): number { return this.d[this.i++] ?? 0; }
  u16(): number {
    const v = (this.d[this.i] ?? 0) | ((this.d[this.i + 1] ?? 0) << 8);
    this.i += 2;
    return v;
  }
  u32(): number {
    const v = ((this.d[this.i] ?? 0) | ((this.d[this.i + 1] ?? 0) << 8)
      | ((this.d[this.i + 2] ?? 0) << 16) | ((this.d[this.i + 3] ?? 0) << 24)) >>> 0;
    this.i += 4;
    return v;
  }
  raw(n: number): Uint8Array {
    const r = this.d.subarray(this.i, this.i + n);
    this.i += n;
    return r;
  }
  str(): string { return dec.decode(this.raw(this.u16())); }
  ascii(n: number): string { return String.fromCharCode(...this.raw(n)); }
  get eof(): boolean { return this.i >= this.d.length; }
}

// -------------------------------------------------------------------- CRC32
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------------ encode/decode
/** Script → binary macro. Empty scenes / unknown opcodes are rejected by the compiler, not here. */
export function encodeTour(t: Tour, magic: string = TOUR_MAGIC): Uint8Array {
  if (!/^[\x20-\x7e]{5}$/.test(magic)) throw new Error(`tour magic must be 5 printable ASCII chars: ${JSON.stringify(magic)}`);
  const body = new Writer();
  body.str(t.id);
  body.str(t.title);
  body.str(t.intro ?? '');
  body.str(t.require ?? '');
  body.u16(t.scenes.length);
  for (const sc of t.scenes) {
    body.str(sc.title);
    body.str(sc.body ?? '');
    body.u16(sc.steps.length);
    for (const st of sc.steps) {
      body.u8(st.op);
      body.u8(st.args.length);
      for (const a of st.args) body.str(a);
    }
  }
  const payload = body.bytes();
  const out = new Writer();
  out.raw(enc.encode(magic));
  out.u8(TOUR_FMT);
  out.u8(0);
  out.u32(crc32(payload));
  out.raw(payload);
  return out.bytes();
}

/** Binary macro → script. Every mismatch throws a human-readable error. */
export function decodeTour(bytes: Uint8Array, magic: string = TOUR_MAGIC): Tour {
  const r = new Reader(bytes);
  const gotMagic = r.ascii(5);
  const accepted = new Set<string>([magic, TOUR_MAGIC, ...LEGACY_MAGICS]);
  if (!accepted.has(gotMagic)) throw new Error(`not a tour macro (magic=${JSON.stringify(gotMagic)})`);
  const fmt = r.u8();
  if (fmt !== TOUR_FMT) throw new Error(`tour macro format ${fmt}; this player understands ${TOUR_FMT} (update the player)`);
  r.u8();                                  // flags, reserved
  const want = r.u32();
  const got = crc32(bytes.subarray(r.i));  // payload starts here
  if (want !== got) throw new Error(`tour macro is corrupt (CRC ${got.toString(16)} ≠ ${want.toString(16)})`);
  const tour: Tour = {
    id: r.str(), title: r.str(), intro: r.str(), require: r.str(),
    scenes: [],
  };
  const n = r.u16();
  for (let i = 0; i < n; i++) {
    const sc: Scene = { title: r.str(), body: r.str(), steps: [] };
    const m = r.u16();
    for (let j = 0; j < m; j++) {
      const op = r.u8();
      const argc = r.u8();
      const args: string[] = [];
      for (let k = 0; k < argc; k++) args.push(r.str());
      if (!OP_NAME[op]) throw new Error(`scene ${i + 1} step ${j + 1}: unknown opcode ${op}`);
      sc.steps.push({ op, args });
    }
    tour.scenes.push(sc);
  }
  if (!r.eof) throw new Error(`tour macro has ${bytes.length - r.i} trailing bytes`);
  return tour;
}

// ------------------------------------------------------------------- base64
/** 二進位 → base64（瀏覽器與 Bun 都有 btoa；分塊避免 spread 爆堆疊） */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/** base64 → 二進位 */
export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
