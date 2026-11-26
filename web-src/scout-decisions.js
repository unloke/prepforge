// The scouted player's own first decision, read against what they faced.
// With White that is their first move. With Black it is their reply, and a reply only
// means something next to the first move it answers: counting (first move, reply)
// pairs as one distribution measures what their OPPONENTS open with — a Black player
// who always meets 1.e4 with 1…c5 and 1.d4 with 1…Nf6 read as "unpredictable" and
// "changed openings" as soon as their opponents switched from 1.d4 to 1.e4.
// Pure and dependency-free (scout.js imports it, so it must not import scout.js).

/** Ply index of their first decision: 0 with White, 1 (the reply) with Black. */
export const decisionPly = (color) => (color === "black" ? 1 : 0);

/**
 * Their first decisions grouped by what they faced: Map faced -> { games, choices }.
 * White has one group (faced ""); Black one group per White first move. `choices` is
 * Map uci -> count in first-seen order (games are newest first).
 */
export function decisionGroups(games, color) {
  const at = decisionPly(color);
  const groups = new Map();
  for (const game of games || []) {
    const ucis = game?.ucis || [];
    if (ucis.length <= at) continue;
    const faced = at ? ucis[0] : "";
    let group = groups.get(faced);
    if (!group) groups.set(faced, (group = { games: 0, choices: new Map() }));
    group.games += 1;
    group.choices.set(ucis[at], (group.choices.get(ucis[at]) || 0) + 1);
  }
  return groups;
}

function topChoice(choices) {
  let top = [null, 0];
  for (const entry of choices) if (entry[1] > top[1]) top = entry; // ties keep the earlier key
  return top;
}

/**
 * How guessable their first decision is, averaged over what they faced (weighted by
 * games): normalised entropy (0 = always the same choice, 1 = uniform), entropy in
 * bits, and the share of their most common choice. Within a group, choices seen in
 * fewer than `minGames` games (one-off slips) are left out of the entropy whenever more
 * than one real choice remains.
 */
export function decisionSpread(groups, { minGames = 1 } = {}) {
  let total = 0;
  for (const group of groups.values()) total += group.games;
  let normalized = 0;
  let entropy = 0;
  let topShare = 0;
  if (!total) return { normalized, entropy, topShare, games: 0 };
  for (const group of groups.values()) {
    const all = [...group.choices.values()];
    const significant = all.filter((n) => n >= minGames);
    const used = significant.length > 1 ? significant : all;
    const n = used.reduce((s, x) => s + x, 0);
    const bits = -used.reduce((h, x) => h + (x / n) * Math.log2(x / n), 0);
    const weight = group.games / total;
    entropy += weight * bits;
    if (used.length > 1) normalized += (weight * bits) / Math.log2(used.length);
    topShare += (weight * Math.max(...all)) / group.games;
  }
  return { normalized, entropy, topShare, games: total };
}

/**
 * True when, against the same first move (White: overall), their most common choice
 * in `recent` differs from the one in `previous` and gained at least `minShift` share.
 * Both windows need `minGames` games against that move.
 */
export function decisionShifted(recent, previous, color, { minGames, minShift }) {
  const before = decisionGroups(previous, color);
  for (const [faced, now] of decisionGroups(recent, color)) {
    const then = before.get(faced);
    if (!then || now.games < minGames || then.games < minGames) continue;
    const [topKey, topCount] = topChoice(now.choices);
    if (topKey === topChoice(then.choices)[0]) continue;
    if (topCount / now.games - (then.choices.get(topKey) || 0) / then.games >= minShift) return true;
  }
  return false;
}

/** Games through each move prefix shorter than `depth` plies, keyed "e2e4", "e2e4>c7c5", … */
export function prefixCounts(games, depth) {
  const counts = new Map();
  for (const game of games || []) {
    const ucis = game?.ucis || [];
    for (let d = 1; d < Math.min(depth, ucis.length); d += 1) {
      const key = ucis.slice(0, d).join(">");
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}
