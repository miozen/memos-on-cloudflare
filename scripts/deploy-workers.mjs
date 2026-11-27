import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = new Set(process.argv.slice(2));
const skipMigrations = args.has("--skip-migrations");
const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";

function runCommand(command, commandArgs) {
  execFileSync(command, commandArgs, { stdio: "inherit" });
}

function runGit(gitArgs) {
  return execFileSync("git", gitArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function resolveVersion() {
  const explicitVersion = process.env.APP_VERSION?.trim();
  if (explicitVersion) {
    return explicitVersion;
  }

  try {
    const exactTag = runGit(["describe", "--tags", "--exact-match"]);
    if (exactTag) {
      return exactTag;
    }
  } catch {
    // Continue to nearest tag or package.json fallback.
  }

  try {
    const nearestTag = runGit(["describe", "--tags", "--abbrev=0"]);
    if (nearestTag) {
      return nearestTag;
    }
  } catch {
    // Repository may be shallow-cloned or have no tags.
  }

  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const baseVersion = typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : "1.0.0";
  const commitSha = (process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA || "").trim().slice(0, 7);
  return commitSha ? `${baseVersion}-${commitSha}` : baseVersion;
}

const version = resolveVersion();
console.log(`Deploying cfmemos version: ${version}`);

if (!skipMigrations) {
  runCommand(npxCmd, ["wrangler", "d1", "migrations", "apply", "cfmemos-db", "--remote"]);
}

runCommand(npxCmd, ["wrangler", "deploy", "--keep-vars", "--var", `APP_VERSION:${version}`]);
