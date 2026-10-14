// shot-compose.ts — 產生測試頁：預填組字範例，供瀏覽器截圖
import { readFileSync, writeFileSync } from "node:fs";

const html = readFileSync("D:/2023/glyphwiki/out/kage-viewer.html", "utf8");

// 測試輸入（用空白分隔）：
//   寶        原字
//   寶缶支    組字：缶→支
//   盟        原字
//   盟皿月    組字：皿→月
//   漢氵木    組字：氵→木
//   寶缶支木  兩個替換
//   寶缶      偶數長度 → 應報錯
const TEST = "\u5bf6 \u5bf6\u7f36\u652f \u76df \u76df\u76bf\u6708 \u6f22\u6c35\u6728 \u5bf6\u7f36\u652f\u6728 \u5bf6\u7f36";

const out = html.replace(
  'id="q" type="text" placeholder',
  'id="q" type="text" value="' + TEST + '" placeholder',
);
writeFileSync("D:/2023/glyphwiki/out/_cs.html", out, { encoding: "utf8" });
console.log("已寫出 _cs.html");
