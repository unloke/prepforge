// Scout v12 §5 — cohort discovery, pipeline run, z-scores + FDR.
//
// Usage:
//   node scripts/scout-bias-cohort.mjs discover <username> [--band-width 150] [--count 18] [--out tmp/cohort-<user>.json]
//   node scripts/scout-bias-cohort.mjs run <cohortJson> [--games 100] [--max-plies 60] [--rating 2550] [--dir tmp/cohort]
//   node scripts/scout-bias-cohort.mjs z <subjectFitJson> <cohortDir> [--fdr 0.05] [--min-firing 30] [--out tmp/cohort-z.json]

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { FEATURE_IDS } from "../web-src/scout-bias-features.js";
import {
  benjaminiHochberg,
  cohortStats,
  leaveOneOutZ,
  subjectZ,
  summarizeLeaveOneOut,
} from "../web-src/scout-bias-cohort.js";
import { decisionsForFit, fitBias, loadDump } from "../web-src/scout-bias-fit.js";
import { scoutUrl, parseNdjsonGames } from "../web-src/scout.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DUMP_SCRIPT = join(HERE, "scout-bias-dump.mjs");

function parseArgs(argv) {
  const out = {
    bandWidth: 150,
    count: 18,
    games: 100,
    maxPlies: 60,
    rating: 2550,
    dir: "tmp/cohort",
    fdr: 0.05,
    minFiring: 30,
    positional: [],
    subcommand: null,
  };
  let i = 2;
  if (argv[2] && !argv[2].startsWith("--")) {
    out.subcommand = argv[2];
    i = 3;
  }
  for (; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--band-width") out.bandWidth = Number(argv[++i]) || 150;
    else if (a === "--count") out.count = Number(argv[++i]) || 18;
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--games") out.games = Number(argv[++i]) || 100;
    else if (a === "--max-plies") out.maxPlies = Number(argv[++i]) || 60;
    else if (a === "--rating") out.rating = Number(argv[++i]) || 2550;
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--fdr") out.fdr = Number(argv[++i]) || 0.05;
    else if (a === "--min-firing") out.minFiring = Number(argv[++i]) || 30;
    else out.positional.push(a);
  }
  return out;
}

async function fetchWithRetry(url, headers = {}) {
  let resp = await fetch(url, { headers });
  if (resp.status === 429) {
    console.warn("  rate limited (429) — waiting 60s…");
    await new Promise((r) => setTimeout(r, 60_000));
    resp = await fetch(url, { headers });
  }
  return resp;
}

function discoverUrl(username, max = 300) {
  const safe = encodeURIComponent(String(username || "").trim());
  const params = new URLSearchParams({
    max: String(max),
    rated: "true",
    perfType: "blitz,rapid",
    pgnInJson: "true",
    moves: "true",
    clocks: "true",
    evals: "false",
    opening: "false",
  });
  return `https://lichess.org/api/games/user/${safe}?${params}`;
}

function parseRawNdjson(text) {
  const games = [];
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      games.push(JSON.parse(trimmed));
    } catch (_) {
      /* skip */
    }
  }
  return games;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function subjectSide(obj, username) {
  const needle = username.toLowerCase();
  const w = obj.players?.white;
  const b = obj.players?.black;
  const wName = (w?.user?.name || w?.user?.id || "").toLowerCase();
  const bName = (b?.user?.name || b?.user?.id || "").toLowerCase();
  if (wName === needle) return { color: "white", player: w, opponent: b };
  if (bName === needle) return { color: "black", player: b, opponent: w };
  return null;
}

function opponentFromGame(obj, username) {
  const sides = subjectSide(obj, username);
  if (!sides) return null;
  const opp = sides.opponent;
  if (!opp?.user?.id) return null;
  if (opp.user.title === "BOT") return null;
  const rating = Number(opp.rating);
  if (!Number.isFinite(rating) || rating <= 0) return null;
  const subjectRating = Number(sides.player?.rating);
  return {
    userId: opp.user.id,
    rating,
    subjectRating: Number.isFinite(subjectRating) ? subjectRating : null,
  };
}

async function cmdDiscover(args) {
  const username = args.positional[0];
  if (!username) {
    console.error(
      "usage: node scripts/scout-bias-cohort.mjs discover <username> [--band-width 150] [--count 18] [--out path]",
    );
    process.exit(2);
  }
  const outPath = args.out || `tmp/cohort-${username}.json`;
  const url = discoverUrl(username, 300);
  console.log(`→ fetching ${url}`);
  const resp = await fetchWithRetry(url, { Accept: "application/x-ndjson" });
  if (!resp.ok) {
    console.error(`✗ Lichess returned ${resp.status} ${resp.statusText}`);
    process.exit(1);
  }
  const rawGames = parseRawNdjson(await resp.text());
  console.log(`  ${rawGames.length} raw games`);

  const subjectRatings = [];
  const opponentMap = new Map();
  for (const g of rawGames) {
    const info = opponentFromGame(g, username);
    if (!info) continue;
    if (info.subjectRating != null) subjectRatings.push(info.subjectRating);
    opponentMap.set(info.userId, { userId: info.userId, rating: info.rating });
  }

  const subjectMedian = median(subjectRatings);
  const band = args.bandWidth;
  const candidates = [...opponentMap.values()]
    .filter((p) => Math.abs(p.rating - subjectMedian) <= band)
    .sort((a, b) => Math.abs(a.rating - subjectMedian) - Math.abs(b.rating - subjectMedian))
    .slice(0, args.count);

  const cohort = {
    subject: username,
    subjectMedian,
    band,
    players: candidates,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(cohort, null, 2));
  console.log(`\nCohort for ${username} (median rating ${subjectMedian}, band ±${band}):`);
  for (const p of candidates) {
    console.log(`  ${p.userId.padEnd(24)} ${p.rating}`);
  }
  console.log(`\n✓ ${candidates.length} players → ${outPath}`);
}

async function fetchPlayerGames(userId, maxGames) {
  const url = scoutUrl(userId, maxGames, { pgnInJson: true, excludeBullet: true });
  console.log(`    fetch ${url}`);
  const resp = await fetchWithRetry(url, { Accept: "application/x-ndjson" });
  if (!resp.ok) {
    throw new Error(`Lichess ${resp.status} for ${userId}`);
  }
  const games = parseNdjsonGames(await resp.text(), userId);
  return games;
}

function runDump(gamesPath, dumpPath, maxPlies, rating) {
  const result = spawnSync(
    process.execPath,
    [DUMP_SCRIPT, gamesPath, dumpPath, "--max-plies", String(maxPlies), "--rating", String(rating)],
    { stdio: "inherit", cwd: ROOT },
  );
  if (result.status !== 0) {
    throw new Error(`scout-bias-dump exited ${result.status}`);
  }
}

function fitPlayer(dumpPath, userId) {
  const text = readFileSync(dumpPath, "utf8");
  const { decisions } = loadDump(text);
  const fit = fitBias(decisionsForFit(decisions), { l2: 1e-3 });
  return {
    userId,
    n: decisions.length,
    beta: fit.beta,
    z: fit.z,
    se: fit.se,
    firingCounts: fit.firingCounts,
    converged: fit.converged,
  };
}

async function cmdRun(args) {
  const cohortPath = args.positional[0];
  if (!cohortPath) {
    console.error(
      "usage: node scripts/scout-bias-cohort.mjs run <cohortJson> [--games 100] [--max-plies 60] [--rating 2550] [--dir tmp/cohort]",
    );
    process.exit(2);
  }
  const cohort = JSON.parse(readFileSync(cohortPath, "utf8"));
  const dir = args.dir;
  mkdirSync(dir, { recursive: true });

  for (const player of cohort.players) {
    const userId = player.userId;
    console.log(`\n▶ ${userId} (cohort rating ${player.rating})`);
    const gamesPath = join(dir, `${userId}.json`);
    const dumpPath = join(dir, `${userId}-bias.ndjson`);
    const fitPath = join(dir, `${userId}-fit.json`);

    if (!existsSync(gamesPath)) {
      let games;
      try {
        games = await fetchPlayerGames(userId, args.games);
      } catch (err) {
        // Closed/renamed accounts 404 — a missing cohort member is a warning, not a run-killer.
        console.warn(`  ⚠ fetch failed (${err.message}) — skipping ${userId}`);
        continue;
      }
      if (games.length < 30) {
        console.warn(`  ⚠ only ${games.length} games — skipping ${userId}`);
        continue;
      }
      writeFileSync(gamesPath, JSON.stringify(games));
      console.log(`  ✓ ${games.length} games → ${gamesPath}`);
    } else {
      console.log(`  skip fetch (exists ${gamesPath})`);
    }

    if (!existsSync(dumpPath)) {
      console.log(`  dump → ${dumpPath}`);
      runDump(gamesPath, dumpPath, args.maxPlies, args.rating);
    } else {
      console.log(`  skip dump (exists ${dumpPath})`);
    }

    if (!existsSync(fitPath)) {
      const fit = fitPlayer(dumpPath, userId);
      writeFileSync(fitPath, JSON.stringify(fit, null, 2));
      console.log(`  ✓ fit n=${fit.n} converged=${fit.converged} → ${fitPath}`);
    } else {
      console.log(`  skip fit (exists ${fitPath})`);
    }
  }
  console.log("\n✓ cohort run complete");
}

function loadFitFiles(cohortDir, excludeUserId = null) {
  const fits = [];
  for (const name of readdirSync(cohortDir)) {
    if (!name.endsWith("-fit.json")) continue;
    const fit = JSON.parse(readFileSync(join(cohortDir, name), "utf8"));
    if (excludeUserId && fit.userId === excludeUserId) continue;
    fits.push(fit);
  }
  return fits;
}

function printZTable(rows) {
  console.log("\nfeature                          subjectβ  cohort μ±σ        z      p   BH");
  for (const r of rows) {
    const beta = Number.isFinite(r.subjectBeta) ? r.subjectBeta.toFixed(4) : "   n/a";
    const cohort =
      r.insufficient || !Number.isFinite(r.cohortMean)
        ? "        n/a"
        : `${r.cohortMean.toFixed(4)}±${r.cohortSd.toFixed(4)}`;
    const z = Number.isFinite(r.z) ? r.z.toFixed(2) : " n/a";
    const p = Number.isFinite(r.p) ? r.p.toFixed(4) : " n/a";
    const bh = r.insufficient ? "  —" : r.bhPass ? "  ✓" : "   ";
    console.log(
      `${r.id.padEnd(32)} ${beta.padStart(8)} ${cohort.padStart(16)} ${z.padStart(8)} ${p.padStart(8)}${bh}`,
    );
  }
}

function cmdZ(args) {
  const subjectFitPath = args.positional[0];
  const cohortDir = args.positional[1];
  if (!subjectFitPath || !cohortDir) {
    console.error(
      "usage: node scripts/scout-bias-cohort.mjs z <subjectFitJson> <cohortDir> [--fdr 0.05] [--min-firing 30] [--out path]",
    );
    process.exit(2);
  }
  let subjectFit = JSON.parse(readFileSync(subjectFitPath, "utf8"));
  // Accept both shapes: a cohort member fit ({beta: number[], ...}) and a
  // scout-bias-fit.mjs --report file, whose fit.beta/se/z/firingCounts are objects
  // keyed by feature id — convert those to FEATURE_IDS-ordered arrays.
  if (!Array.isArray(subjectFit.beta) && subjectFit.fit) {
    const byId = (obj) => FEATURE_IDS.map((id) => obj?.[id]);
    subjectFit = {
      userId: subjectFit.header?.subject,
      converged: subjectFit.fit.converged !== false,
      beta: byId(subjectFit.fit.beta),
      se: byId(subjectFit.fit.se),
      z: byId(subjectFit.fit.z),
      firingCounts: byId(subjectFit.fit.firingCounts),
    };
  }
  const subjectId = subjectFit.userId;
  const cohortFits = loadFitFiles(cohortDir, subjectId);
  const stats = cohortStats(cohortFits, { minFiring: args.minFiring });
  const { z, p } = subjectZ(subjectFit, stats);

  const testableIdx = [];
  for (let f = 0; f < FEATURE_IDS.length; f += 1) {
    if (!stats.insufficient[f] && Number.isFinite(p[f])) testableIdx.push(f);
  }
  const pTest = testableIdx.map((f) => p[f]);
  const bhLocal = benjaminiHochberg(pTest, args.fdr);
  const bhPass = new Array(FEATURE_IDS.length).fill(false);
  for (let t = 0; t < testableIdx.length; t += 1) {
    if (bhLocal[t]) bhPass[testableIdx[t]] = true;
  }

  const rows = FEATURE_IDS.map((id, f) => ({
    id,
    subjectBeta: subjectFit.beta[f],
    cohortMean: stats.means[f],
    cohortSd: stats.sds[f],
    cohortN: stats.nUsable[f],
    z: z[f],
    p: p[f],
    bhPass: bhPass[f],
    insufficient: stats.insufficient[f],
  })).sort((a, b) => {
    const az = Math.abs(a.z ?? 0);
    const bz = Math.abs(b.z ?? 0);
    if (bz !== az) return bz - az;
    return a.id.localeCompare(b.id);
  });

  const survivors = rows.filter((r) => r.bhPass);
  console.log(
    `\nSubject ${subjectId} vs cohort (${cohortFits.length} members, min-firing=${args.minFiring}, FDR=${args.fdr})`,
  );
  console.log(`BH survivors: ${survivors.length} / ${testableIdx.length} testable features`);
  printZTable(rows);

  const loo = leaveOneOutZ(cohortFits, {
    minFiring: args.minFiring,
    fdr: args.fdr,
    featureIds: FEATURE_IDS,
  });
  const looSummary = summarizeLeaveOneOut(loo);
  const subjectMaxAbsZ = Math.max(...z.filter(Number.isFinite).map(Math.abs), 0);
  const subjectBhSurvivors = survivors.length;

  console.log("\n§7.2 discrimination (leave-one-out null):");
  console.log(
    `  cohort max|z| — min ${looSummary.maxAbsZ.min.toFixed(2)}, median ${looSummary.maxAbsZ.median.toFixed(2)}, max ${looSummary.maxAbsZ.max.toFixed(2)}`,
  );
  console.log(
    `  cohort BH survivors — min ${looSummary.bhSurvivors.min}, median ${looSummary.bhSurvivors.median}, max ${looSummary.bhSurvivors.max}`,
  );
  console.log(`  subject max|z| = ${subjectMaxAbsZ.toFixed(2)}, BH survivors = ${subjectBhSurvivors}`);

  const outPath = args.out || "tmp/cohort-z.json";
  const report = {
    subject: subjectId,
    cohortMembers: cohortFits.length,
    fdr: args.fdr,
    minFiring: args.minFiring,
    features: rows,
    bhSurvivors: survivors.map((r) => r.id),
    subjectMaxAbsZ,
    subjectBhSurvivors,
    leaveOneOut: looSummary,
    leaveOneOutMembers: loo.map((m) => ({
      userId: m.userId,
      maxAbsZ: m.maxAbsZ,
      bhSurvivors: m.bhSurvivors,
    })),
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n✓ report → ${outPath}`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.subcommand) {
    console.error("subcommands: discover | run | z");
    process.exit(2);
  }
  if (args.subcommand === "discover") await cmdDiscover(args);
  else if (args.subcommand === "run") await cmdRun(args);
  else if (args.subcommand === "z") cmdZ(args);
  else {
    console.error(`unknown subcommand: ${args.subcommand}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});