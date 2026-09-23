import fs from 'node:fs';

const move = JSON.parse(fs.readFileSync(new URL('./move-results.json', import.meta.url)));
const wdl = JSON.parse(fs.readFileSync(new URL('./wdl-results.json', import.meta.url)));
const methods = ['maia', 'maiaResidual'];
const gates = {
  pressureFloor: 0.55,
  pressureConsistency: 0.8,
  robustnessFloor: 0.55,
  blunderDependencyMax: 0.5,
};
const average = (values) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const jaccard = (a, b) => {
  const left = new Set(a.map((route) => route.moves.slice(0, 4).join(' ')));
  const right = new Set(b.map((route) => route.moves.slice(0, 4).join(' ')));
  const union = new Set([...left, ...right]);
  return union.size ? [...left].filter((key) => right.has(key)).length / union.size : null;
};

const rows = [];
for (const player of move.players) {
  const latest = player.sizes.at(-1);
  const previous = player.sizes.at(-2);
  for (const color of ['white', 'black']) {
    for (const method of methods) {
      const current = latest.methods[method].byColor[color];
      const earlier = previous?.methods[method].byColor[color];
      const routes = wdl.routes.filter((route) => route.player === player.player
        && route.trainGames === latest.trainGames && route.method === method
        && current.recommendations.some((candidate) =>
          candidate.moves.join(' ') === route.moves.join(' ')));
      const qualified = routes.filter(({ metrics }) =>
        metrics.pressureFloor >= gates.pressureFloor
        && metrics.pressureConsistency >= gates.pressureConsistency
        && metrics.robustnessFloor >= gates.robustnessFloor
        && metrics.blunderDependency <= gates.blunderDependencyMax);
      rows.push({
        player: player.player.split('/').at(-1).replace('.json', ''), color, method,
        trainGames: latest.trainGames, testGames: current.testGames,
        move: latest.methods[method].move,
        decisionCoverage: current.product.decisionPositionCoverage,
        routeMoveHit: current.product.conditionalRouteMoveHit,
        falsePrepRate: current.product.falsePrepRate,
        routeStability: earlier ? jaccard(earlier.recommendations, current.recommendations) : null,
        evaluatedRoutes: routes.length, qualifiedRoutes: qualified.length,
        meanPressureFloor: average(routes.map((route) => route.metrics.pressureFloor)),
        meanRobustnessFloor: average(routes.map((route) => route.metrics.robustnessFloor)),
        meanBlunderDependency: average(routes.map((route) => route.metrics.blunderDependency)),
        meanRoutePly: current.product.meanRoutePly,
      });
    }
  }
}
const result = { protocol: 'scout-gated-comparison-v1', gates, rows };
fs.writeFileSync(new URL('./gated-comparison.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
