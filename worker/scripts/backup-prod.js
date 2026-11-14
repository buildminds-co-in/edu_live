// Records a restore point for the PRODUCTION D1 database before a migration.
//
// This is deliberately NOT a data export. The `transactions` table holds real
// questions from 16-17 year old students and must never leave Cloudflare, so
// no SQL dump is written to disk. Instead this asks D1 Time Travel for the
// current bookmark and saves it, with a timestamp, under worker/backups/
// (gitignored). To roll back, use:
//   npx wrangler d1 time-travel restore edu-live-db --env production --bookmark=<bookmark>
// Time Travel covers roughly the last 7 days on the free plan.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const DATABASE = "edu-live-db";
const BACKUP_DIR = path.join(__dirname, "..", "backups");

const result = spawnSync(
  "npx",
  ["wrangler", "d1", "time-travel", "info", DATABASE, "--env", "production"],
  { encoding: "utf8", shell: true, cwd: path.join(__dirname, "..") }
);

const output = `${result.stdout || ""}${result.stderr || ""}`;
if (result.status !== 0) {
  process.stderr.write(output);
  console.error("\nRestore point NOT recorded. Do not run the prod migration.");
  process.exit(1);
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = path.join(BACKUP_DIR, `prod-time-travel-${stamp}.txt`);
fs.writeFileSync(file, `# ${DATABASE} (production) Time Travel info, taken ${new Date().toISOString()}\n${output}`);

process.stdout.write(output);
console.log(`\nRestore point recorded: ${file}`);
console.log("Run the migration only after this line appears.");
