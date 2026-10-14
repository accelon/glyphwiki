// box-dictionary.ts — 框字典：把差異很小的引用框歸成一類，共用一個代表框。
//
// 為什麼可行（實測）：框是人工隨意微調的，200×200 下差幾格不是問題。
// 全庫 117,120 個引用框只有 14,425 個相異值；以「最大座標差 ≤2 格」聚類
// 只需 5,794 個代表框，平均位移 0.60 格、最大 2 格。
//
// 為什麼有效（實測）：引用框在 gzip 後佔 167,154 bytes（17.8%）。
// 改成「字典 + 每筆一個索引」後，該部分 gzip 只需 25,523 bytes，
// 對整體精簡庫淨省 141,631 bytes（15.1%）。
//
// 效能：以「量化到 8 格的鍵」做空間索引，避免 O(n×m) 全掃。
// 建字典約 0.5 秒（117,120 個框）。


export interface BoxDict {
  /** 代表框（每筆 4 個座標） */
  reps: number[][];
  /** 引用框（依出現順序）→ 代表框索引 */
  assign: Int32Array;
}

/** 聚類門檻：允許的最大座標差（單位：200 空間的格） */
export const BOX_TOL = 1;

/**
 * 建立框字典。
 * @param lib 字形庫
 * @param tol 聚類門檻（最大座標差）
 */
// 只依賴最小介面（有 strokes[].kind 與 strokes[].box 即可），
// 這樣 build-library.ts 的 GlyphRec 也能直接用。
export interface HasBoxes {
  glyphs: { strokes: { kind: number; box?: number[] | null; pts?: number[] }[] }[];
}

/** 取得一筆引用的框（相容 box 與 pts 兩種欄位名） */
function boxOf(s: { kind: number; box?: number[] | null; pts?: number[] }): number[] | null {
  if (s.box && s.box.length >= 4) return s.box;
  if (s.pts && s.pts.length >= 4) return s.pts;
  return null;
}

export function buildBoxDict(lib: HasBoxes, tol = BOX_TOL): BoxDict {
  const reps: number[][] = [];
  let total = 0;
  for (const g of lib.glyphs) for (const s of g.strokes) if (s.kind === 99 && boxOf(s)) total++;
  const assign = new Int32Array(total);

  // 空間索引：量化到 8 格的鍵 → 代表框索引清單。
  // 查詢時只需檢查鄰近的 27 個格子（3×3×3），大幅減少比較次數。
  const CELL = 8;
  const key = (x: number, y: number, w: number, h: number) => {
    const qx = Math.floor(x / CELL), qy = Math.floor(y / CELL);
    const qw = Math.floor(w / CELL), qh = Math.floor(h / CELL);
    return qx + "," + qy + "," + qw + "," + qh;
  };
  const grid = new Map<string, number[]>();

  let i = 0;
  for (const g of lib.glyphs) {
    for (const s of g.strokes) {
      if (s.kind !== 99) continue;
      const b = boxOf(s);
      if (!b) continue;
      const bx1 = b[0]!, by1 = b[1]!, bx2 = b[2]!, by2 = b[3]!;
      const bw = bx2 - bx1, bh = by2 - by1;
      let bestI = -1, bestD = Infinity;

      // 檢查鄰近格子
      const qx = Math.floor(bx1 / CELL), qy = Math.floor(by1 / CELL);
      const qw = Math.floor(bw / CELL), qh = Math.floor(bh / CELL);
      for (let dx = -1; dx <= 1 && bestD > 0; dx++) {
        for (let dy = -1; dy <= 1 && bestD > 0; dy++) {
          for (let dw = -1; dw <= 1 && bestD > 0; dw++) {
            for (let dh = -1; dh <= 1 && bestD > 0; dh++) {
              const list = grid.get(`${qx + dx},${qy + dy},${qw + dw},${qh + dh}`);
              if (!list) continue;
              for (const k of list) {
                const r = reps[k]!;
                const d = Math.max(
                  Math.abs(bx1 - r[0]!), Math.abs(by1 - r[1]!),
                  Math.abs(bx2 - r[2]!), Math.abs(by2 - r[3]!),
                );
                if (d < bestD) { bestD = d; bestI = k; }
                if (bestD === 0) break;
              }
            }
          }
        }
      }

      if (bestI >= 0 && bestD <= tol) {
        assign[i] = bestI;
      } else {
        const k = reps.length;
        reps.push([bx1, by1, bx2, by2]);
        assign[i] = k;
        const gk = key(bx1, by1, bw, bh);
        const list = grid.get(gk);
        if (list) list.push(k); else grid.set(gk, [k]);
      }
      i++;
    }
  }
  return { reps, assign };
}

/** 依字典展開回每個引用的框（依出現順序） */
export function boxesFromDict(dict: BoxDict): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < dict.assign.length; i++) out.push(dict.reps[dict.assign[i]!]!);
  return out;
}

// ---------------------------------------------------------------- CLI：量測

if (import.meta.main) {
  const { readFileSync } = await import("node:fs");
  const { decodeLibrary } = await import("./lib-format.ts");
  const D = "D:/2023/glyphwiki";
  const lib = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

  const t0 = performance.now();
  const dict = buildBoxDict(lib);
  const dt = performance.now() - t0;

  // 位移統計
  let sum = 0, max = 0, n = 0;
  let i = 0;
  for (const g of lib.glyphs) {
    for (const s of g.strokes) {
      if (s.kind !== 99) continue;
      const b = boxOf(s);
      if (!b) continue;
      const r = dict.reps[dict.assign[i]!]!;
      const d = Math.max(
        Math.abs(b[0]! - r[0]!), Math.abs(b[1]! - r[1]!),
        Math.abs(b[2]! - r[2]!), Math.abs(b[3]! - r[3]!),
      );
      sum += d; n++;
      if (d > max) max = d;
      i++;
    }
  }
  console.log(`建字典 ${dt.toFixed(0)}ms`);
  console.log(`引用框 ${n.toLocaleString()} → 代表框 ${dict.reps.length.toLocaleString()}` +
    `（${(100 * (1 - dict.reps.length / n)).toFixed(1)}% 減少）`);
  console.log(`位移：平均 ${(sum / n).toFixed(2)} 格、最大 ${max} 格`);
}
