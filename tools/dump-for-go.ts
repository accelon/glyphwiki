import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";

const db = new Database("db/glyphwiki.db", { readonly: true });
const getData = db.query("SELECT data FROM glyphs WHERE name = ?");
const getKids = db.query("SELECT comp FROM parts WHERE glyph = ? AND kind = 99 ORDER BY idx");

const roots = (
  db.query(
    "SELECT name FROM glyphs WHERE name_type='codepoint' AND codepoint BETWEEN 0x4E00 AND 0x9FFF ORDER BY codepoint LIMIT 1000",
  ).all() as any[]
).map((r: any) => r.name);

const data: Record<string, string> = {};
const stack = [...roots];
while (stack.length) {
  const n = stack.pop()!;
  if (data[n] !== undefined) continue;
  const row = getData.get(n) as any;
  if (!row) continue;
  data[n] = row.data;
  for (const k of getKids.all(n) as any[]) stack.push(k.comp);
}

writeFileSync("gokage/glyphs.json", JSON.stringify(data));
writeFileSync("gokage/names.txt", roots.join("\n"));
console.log(`字形 ${Object.keys(data).length} 個（含依賴）、根 ${roots.length} 個`);
db.close();
