// Enforces "migrations only add things": no DROP, RENAME, or column/table
// rewrites in any migration added after the grandfathered set. Migrations
// 0001-0005 were applied before this rule existed, so they are exempt.
//
// Run before every migration: npm run db:check

const fs = require("fs");
const path = require("path");

const GRANDFATHERED_MAX = 5; // 0005_drop_question_papers_class.sql is the last legacy one
const dir = path.join(__dirname, "..", "migrations");
const FORBIDDEN = /\b(DROP\s+(TABLE|COLUMN|INDEX|VIEW|TRIGGER)|RENAME\s+(TO|COLUMN)|ALTER\s+TABLE\s+\S+\s+RENAME)\b/i;

let failures = 0;
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  const number = parseInt(file.slice(0, 4), 10);
  if (!(number > GRANDFATHERED_MAX)) continue;
  const sql = fs.readFileSync(path.join(dir, file), "utf8");
  const match = sql.match(FORBIDDEN);
  if (match) {
    failures++;
    console.error(`FAIL ${file}: "${match[0]}" - migrations may only add tables/columns. ` +
      "Ship the removal in a later release, after no code relies on it.");
  } else {
    console.log(`ok   ${file}`);
  }
}

if (failures) process.exit(1);
console.log("All new migrations are additive.");
