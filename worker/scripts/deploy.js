#!/usr/bin/env node
// Deploys the Worker AND the frontend together, both labelled with the same
// release version, so `wrangler versions list` always shows matching tags.
//
//   npm run deploy:staging      (from worker/)
//   npm run deploy:prod         (from worker/)
//   npm run deploy:staging -- --dry-run   (show the label, deploy nothing)
//
// Version label:
//   - HEAD exactly on a release tag (vX.Y.Z)  -> "vX.Y.Z"
//   - otherwise                               -> "<newest vX.Y.Z tag>+<short sha>"
//     (uses the newest tag in the repo, not `git describe`: merge-backs have
//     been squash-merged, so release tags are often not in staging's history)
//   - uncommitted changes                     -> "-dirty" appended
//
// Production refuses to deploy unless HEAD is exactly on a release tag and the
// working tree is clean. The frontend is deployed even when it has not
// changed: wrangler then uploads no files and only records the new version.

const { execSync, spawnSync } = require("node:child_process");
const path = require("node:path");

const env = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (env !== "staging" && env !== "production") {
  console.error("Usage: node scripts/deploy.js <staging|production> [--dry-run]");
  process.exit(1);
}

const repoRoot = path.resolve(__dirname, "..", "..");
const git = (args) =>
  execSync(`git ${args}`, { cwd: repoRoot, encoding: "utf8" }).trim();

execSync("git fetch --tags --quiet", { cwd: repoRoot, stdio: "inherit" });

const sha = git("rev-parse --short HEAD");
const dirty = git("status --porcelain") !== "";
const tagsAtHead = git("tag --points-at HEAD --list v*")
  .split("\n")
  .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
const newestTag = git("tag --list v* --sort=-v:refname")
  .split("\n")
  .find((t) => /^v\d+\.\d+\.\d+$/.test(t));

if (env === "production") {
  if (tagsAtHead.length === 0) {
    console.error(
      `Refusing to deploy to production: HEAD (${sha}) is not on a release tag.\n` +
        "Check out the release tag first, e.g. git switch --detach v1.2.3"
    );
    process.exit(1);
  }
  if (dirty) {
    console.error("Refusing to deploy to production: uncommitted changes.");
    process.exit(1);
  }
}

let version =
  tagsAtHead.length > 0
    ? tagsAtHead[tagsAtHead.length - 1]
    : `${newestTag || "v0.0.0"}+${sha}`;
if (dirty) version += "-dirty";

const message = `${version} ${env} @ ${sha}`;
console.log(
  `\n${dryRun ? "[dry run] Would deploy" : "Deploying"} ${version} to ${env} (Worker, then frontend)\n`
);

for (const dir of ["worker", "frontend"]) {
  console.log(`=== ${dir}`);
  const result = spawnSync(
    "npx",
    [
      "wrangler", "deploy", "--env", env, "--tag", version, "--message", `"${message}"`,
      ...(dryRun ? ["--dry-run"] : []),
    ],
    { cwd: path.join(repoRoot, dir), stdio: "inherit", shell: true }
  );
  if (result.status !== 0) {
    console.error(
      `\n${dir} deploy failed. ` +
        (dir === "frontend"
          ? "The Worker is already deployed: fix and re-run, or roll the Worker back."
          : "Nothing was deployed.")
    );
    process.exit(result.status || 1);
  }
}

if (dryRun) {
  console.log(`\n[dry run] Nothing deployed. Label would be ${version}.`);
  process.exit(0);
}

console.log(
  `\nDone: Worker and frontend on ${env} are both tagged ${version}.\n` +
    `Check: npx wrangler versions list --env ${env}  (in worker/ and frontend/)`
);
