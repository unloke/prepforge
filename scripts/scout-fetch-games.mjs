// Fetch a real Lichess player's games in Node and dump the parsed scout records to JSON,
// so the Scout v3 backtest (scripts/scout-backtest.mjs) can run against a REAL opponent
// instead of the synthetic archetypes. The public games export is CORS-open and needs no
// token; in Node there is no CORS at all. We reuse scout.js's exact URL builder + ND-JSON
// parser so the records are byte-identical to what the browser Scout produces.
//
// Usage:
//   node scripts/scout-fetch-games.mjs <username> [max] [outPath]
//   node scripts/scout-fetch-games.mjs DrNykterstein 400 tmp/magnus.json
//
// Output: array of scout game records (parseNdjsonGames shape).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { scoutUrl, parseNdjsonGames } from "../web-src/scout.js";

async function main() {
  const username = process.argv[2];
  const max = process.argv[3] ? Number(process.argv[3]) : 400;
  const outPath = process.argv[4] || `tmp/scout-${username}.json`;
  if (!username) {
    console.error("usage: node scripts/scout-fetch-games.mjs <username> [max] [outPath]");
    process.exit(2);
  }

  const url = scoutUrl(username, max, { pgnInJson: true, excludeBullet: true });
  console.log(`→ fetching ${url}`);
  const resp = await fetch(url, { headers: { Accept: "application/x-ndjson" } });
  if (!resp.ok) {
    console.error(`✗ Lichess returned ${resp.status} ${resp.statusText}`);
    process.exit(1);
  }
  const text = await resp.text();
  const games = parseNdjsonGames(text, username);

  const byColor = { white: 0, black: 0 };
  for (const g of games) byColor[g.color] += 1;

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(games));
  console.log(
    `✓ ${games.length} games (${byColor.white} white / ${byColor.black} black) → ${outPath}`,
  );
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
