import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export function newerStockfishVersion(current, latest) {
  const parse = version => {
    if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
      throw new Error(`Expected an exact stable Stockfish version, got ${JSON.stringify(version)}`);
    }
    return version.split(".").map(BigInt);
  };
  const installed = parse(current), published = parse(latest);
  for (let i = 0; i < installed.length; i++) {
    if (published[i] !== installed[i]) return published[i] > installed[i] ? latest : null;
  }
  return null;
}

export function assertCiPassed(result, sha) {
  const required = ["python", "postgres", "js", "stockfish", "e2e", "docker"];
  if (result.headSha !== sha || result.conclusion !== "success"
    || !required.every(name => result.jobs?.some(job => job.name === name))
    || !result.jobs.every(job => job.conclusion === "success")) {
    throw new Error(`CI must pass every job (including ${required.join(", ")}) on ${sha}`);
  }
}

export async function mergeAfterCi({ repository, pr, sha, command = execFileSync, sleep = setTimeout }) {
  const json = args => JSON.parse(command("gh", [...args, "--repo", repository], { encoding: "utf8" }));
  let run;
  // App-authenticated PR creation triggers CI asynchronously. Never treat "no checks" as green.
  for (let attempt = 0; attempt < 30; attempt++) {
    [run] = json(["run", "list", "--workflow", "ci.yml", "--event", "pull_request",
      "--commit", sha, "--json", "databaseId,status,conclusion", "--limit", "1"]);
    if (run) break;
    await sleep(10_000);
  }
  if (!run) throw new Error(`No pull-request CI run appeared for ${sha} within five minutes`);
  const runId = String(run.databaseId);
  // An unchanged PR gets no new push event on tomorrow's attempt. Retry its CI
  // after a transient failure/cancellation instead of watching the old red run forever.
  if (run.status === "completed" && run.conclusion !== "success") {
    command("gh", ["run", "rerun", runId, "--repo", repository], { stdio: "inherit" });
  }
  command("gh", ["run", "watch", runId, "--repo", repository, "--exit-status"], { stdio: "inherit" });
  assertCiPassed(json(["run", "view", runId, "--json", "headSha,conclusion,jobs"]), sha);
  // Respect branch protection and refuse to merge a head that changed during CI.
  command("gh", ["pr", "merge", String(pr), "--repo", repository,
    "--squash", "--match-head-commit", sha], { stdio: "inherit" });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv[2] === "check") {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const latest = JSON.parse(execFileSync("npm", ["view", "stockfish", "version", "--json"], { encoding: "utf8" }));
    const version = newerStockfishVersion(pkg.dependencies.stockfish, latest);
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version || ""}\n`);
    console.log(version ? `Stockfish update: ${pkg.dependencies.stockfish} -> ${version}` : "Stockfish is current");
  } else if (process.argv[2] === "merge") {
    await mergeAfterCi({ repository: process.env.GITHUB_REPOSITORY, pr: process.argv[3], sha: process.argv[4] });
  } else {
    throw new Error("Usage: node scripts/update-stockfish.mjs check | merge <pr> <sha>");
  }
}
