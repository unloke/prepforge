// Move-only features. No titles, notes, source metadata or chess evaluation.
export function atlasContentFeatures(graph, distances, ownTurn, horizon, raw) {
  let own = 0, quiet = 0;
  const levels = new Map(), pawnLevels = new Map();
  const descendants = (start) => {
    let layer = new Set([start]);
    const found = new Set(layer);
    for (let i = 0; i < 3; i++) {
      layer = new Set([...layer].flatMap((key) => graph.get(key).ordered
        .filter((e) => distances.get(e.target) <= horizon).map((e) => e.target)));
      for (const key of layer) found.add(key);
    }
    return found;
  };
  for (const [key, p] of graph) {
    const d = distances.get(key);
    if (d == null || d >= horizon || !p.ordered.length) continue;
    if (p.turn !== ownTurn) continue;
    own++;
    let alternatives = p.ordered.length;
    if (alternatives > 1) {
      // Nf3/d4 ordering that reaches the same position is one plan.
      const destinations = p.ordered.map((e) => descendants(e.target));
      if ([...destinations[0]].some((k) => destinations.every((s) => s.has(k)))) alternatives = 1;
    }
    const level = levels.get(d) || [];
    level.push(Math.log2(alternatives));
    levels.set(d, level);
    const pawns = p.board.board().flat().filter((piece) => piece?.type === "p" && piece.color === ownTurn)
      .map((piece) => piece.square).sort().join("");
    if (!pawnLevels.has(d)) pawnLevels.set(d, new Map());
    pawnLevels.get(d).set(pawns, (pawnLevels.get(d).get(pawns) || 0) + 1);
    for (const e of p.ordered) {
      const target = graph.get(e.target);
      const piece = p.board.get(e.uci.slice(0, 2));
      const capture = p.board.get(e.uci.slice(2, 4)) ||
        (piece.type === "p" && e.uci[0] !== e.uci[2]);
      if (!capture && !p.board.isCheck() && !target.board.isCheck() && e.uci.length === 4) quiet += 1 / p.ordered.length;
    }
  }
  let burden = 0;
  for (const [d, values] of levels) burden += values.reduce((a, b) => a + b, 0) / values.length * 0.7 ** (d / 2);
  const ownHome = ownTurn === "w" ? "1" : "8";
  const maturity = (p) => {
    if (p.boundary || (p.terminal && !(p.board.isCheckmate() && p.turn === ownTurn))) return 1;
    let developed = 0;
    for (const file of "bcfg") {
      const piece = p.board.get(file + ownHome);
      if (!piece || piece.color !== ownTurn || !["n", "b"].includes(piece.type)) developed++;
    }
    const king = p.board.get("e" + ownHome);
    return (developed / 4 * 0.75 + (!king || king.color !== ownTurn || king.type !== "k" ? 0.25 : 0));
  };
  const frontiers = [...raw.corePositions].filter((k) => {
    const p = graph.get(k);
    return p.boundary || p.terminal || !p.ordered.length || distances.get(k) >= horizon;
  }).map((k) => graph.get(k));
  // Equal unique core endpoints: a long example cannot swamp many short stubs.
  const handover = frontiers.length ? frontiers.reduce((sum, p) => sum + maturity(p), 0) / frontiers.length : raw.depth / horizon;
  const memo = new Map();
  const supportMemo = new Map();
  const continuation = (key, remaining) => {
    const cacheKey = key + "|" + remaining;
    if (supportMemo.has(cacheKey)) return supportMemo.get(cacheKey);
    const p = graph.get(key);
    if (p.boundary || (p.terminal && !(p.board.isCheckmate() && p.turn === ownTurn))) return 3;
    if (distances.get(key) >= horizon) return 0;
    const next = p.ordered.filter((e) => distances.get(e.target) > distances.get(key));
    if (!remaining || !next.length) return 0;
    const value = Math.min(3, Number(p.turn === ownTurn) + next.reduce((s, e) =>
      s + continuation(e.target, remaining - 1), 0) / next.length);
    supportMemo.set(cacheKey, value);
    return value;
  };
  const supportedAt = (p) => {
    if (p.turn === ownTurn) return 0;
    const support = p.ordered.map((e) => Math.max(0, continuation(e.target, 6) - 1) / 2);
    return support.reduce((a, b) => a + b, 0) - Math.max(0, ...support);
  };
  let supportedAlternatives = 0;
  for (const [key, p] of graph) if (distances.get(key) < horizon) supportedAlternatives += supportedAt(p);
  const routeBreadth = (key, remaining, path) => {
    if (!remaining || path.has(key)) return 0;
    const cacheKey = key + "|" + remaining;
    // Cache only the acyclic shortest-distance subgraph.
    if (memo.has(cacheKey)) return memo.get(cacheKey);
    const p = graph.get(key);
    const edges = p.ordered.filter((e) => distances.get(e.target) > distances.get(key));
    if (!edges.length) return 0;
    path.add(key);
    const value = supportedAt(p) + edges.reduce((sum, e) =>
      sum + routeBreadth(e.target, remaining - 1, path), 0) / edges.length;
    path.delete(key);
    memo.set(cacheKey, value);
    return value;
  };
  const root = [...distances].find(([, d]) => d === 0)?.[0];
  const perRoute = root ? routeBreadth(root, horizon, new Set()) : 0;
  const concentration = (stages) => {
    let sum = 0, weight = 0;
    for (const [d, frequencies] of stages) {
      const n = [...frequencies.values()].reduce((a, b) => a + b, 0);
      if (n <= 1) continue;
      const w = 0.9 ** (d / 2);
      sum += w * [...frequencies.values()].reduce((a, b) => a + (b / n) ** 2, 0);
      weight += w;
    }
    return weight ? sum / weight : 0;
  };
  return {
    completion: raw.depth / horizon,
    handover,
    adequacy: Math.sqrt(handover * raw.depth / horizon),
    routeBreadth: perRoute / (1 + perRoute),
    supportedBreadth: supportedAlternatives / (4 + supportedAlternatives),
    coherence: Math.exp(-burden),
    repeatedAgreement: raw.repeatedGroups ? raw.commonGroups / raw.repeatedGroups : 1,
    pawnReuse: concentration(pawnLevels),
    quiet: own ? quiet / own : 0,
    planReuse: raw.ease.denominator ? raw.ease.numerator / raw.ease.denominator : 0,
  };
}
