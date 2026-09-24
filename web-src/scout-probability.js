/** Sample-aware estimate of a historical opponent move at its exact position. */
export function opponentMoveProbability(moveGames, parentGames, method = "laplace") {
  if (parentGames <= 0 || moveGames < 0 || moveGames > parentGames) return 0;
  if (method === "raw") return moveGames / parentGames;
  if (method === "jeffreys") return (moveGames + 0.5) / (parentGames + 1);
  if (method === "wilson") {
    const z = 1.96;
    const p = moveGames / parentGames;
    const z2 = z * z;
    return (p + z2 / (2 * parentGames) - z * Math.sqrt(
      (p * (1 - p) + z2 / (4 * parentGames)) / parentGames,
    )) / (1 + z2 / parentGames);
  }
  return (moveGames + 1) / (parentGames + 2);
}
