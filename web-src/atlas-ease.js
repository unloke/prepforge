// Compare plans at the same own pawn structure and development stage.
// Exact piece placement may differ: the point is whether actions are reusable.
function context(board, own) {
  const ownPawns = [], material = [], pawns = [];
  let opponentKing = "", ownKing = "", developed = 0;
  const home = own === "w" ? "1" : "8";
  for (const row of board.board()) for (const piece of row) {
    if (!piece) continue;
    material.push(piece.color + piece.type);
    if (piece.color === own) {
      if (piece.type === "p") ownPawns.push(piece.square);
      if (piece.type === "k") ownKing = piece.square;
      if (["n", "b"].includes(piece.type) && piece.square[1] !== home) developed++;
    }
    else if (piece.type === "p") pawns.push(piece.square);
    else if (piece.type === "k") opponentKing = piece.square;
  }
  return {
    group: [ownPawns.sort().join(""), developed, ownKing, material.sort().join(""), opponentKing, board.fen().split(" ")[2]].join("|"),
    pawns: new Set(pawns),
  };
}

const action = (position, edge) => position.board.get(edge.uci.slice(0, 2)).type + edge.uci.slice(2);

function plan(position, first, graph, distances, horizon) {
  const initial = action(position, first), next = graph.get(first.target);
  const second = new Map();
  // Each stored opponent response and each preferred own option has equal
  // reference weight. Missing continuations supply no invented second move.
  for (const reply of next.ordered) {
    if (distances.get(reply.target) >= horizon) continue;
    const after = graph.get(reply.target);
    for (const choice of after.ordered) {
      const token = action(after, choice);
      second.set(token, (second.get(token) || 0) + 1 / next.ordered.length / after.ordered.length);
    }
  }
  const sum = [...second.values()].reduce((a, b) => a + b, 0);
  const vector = new Map([[initial, 0.5]]);
  if (sum) for (const [token, value] of second) vector.set(token, (vector.get(token) || 0) + value / sum / 2);
  return { initial, vector, hasSecond: sum > 0 };
}

export function atlasEase(graph, distances, ownTurn, horizon) {
  const groups = new Map();
  for (const [key, position] of [...graph].sort(([a], [b]) => a.localeCompare(b))) {
    if (position.turn !== ownTurn || !position.ordered.length ||
        !distances.has(key) || distances.get(key) >= horizon || position.board.isCheck()) continue;
    const details = context(position.board, ownTurn);
    if (!groups.has(details.group)) groups.set(details.group, []);
    for (const edge of position.ordered) groups.get(details.group).push({
      key, first: edge.uci, pawns: details.pawns,
      plan: plan(position, edge, graph, distances, horizon), sum: 0, comparisons: 0,
    });
  }
  let pairs = 0, identicalPositionPairs = 0;
  const perPosition = new Map(), examples = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const a = group[i], b = group[j];
      const difference = [...a.pawns].filter((sq) => !b.pawns.has(sq)).length;
      if (difference > 1) continue; // Material is equal, so at most one pawn relocated.
      let similarity = Number(a.plan.initial === b.plan.initial);
      if (a.plan.hasSecond && b.plan.hasSecond) {
        similarity = 0;
        for (const [token, value] of a.plan.vector) similarity += Math.min(value, b.plan.vector.get(token) || 0);
      }
      a.sum += similarity; b.sum += similarity;
      a.comparisons++; b.comparisons++; pairs++;
      if (a.key === b.key) identicalPositionPairs++;
      if (examples.length < 5) examples.push({ positions: [a.key, b.key], moves: [a.first, b.first], similarity });
    }
    for (const c of group) if (c.comparisons) {
      if (!perPosition.has(c.key)) perPosition.set(c.key, []);
      perPosition.get(c.key).push(c.sum / c.comparisons);
    }
  }
  const total = [...perPosition.values()].reduce((sum, values) =>
    sum + values.reduce((a, b) => a + b, 0) / values.length, 0);
  return { numerator: total, denominator: perPosition.size, pairs, identicalPositionPairs, examples };
}
