export function formatEngineEval(cp, mate) {
  if (mate !== null && mate !== undefined) {
    if (mate > 0) return `#${mate}`;
    if (mate < 0) return `#-${Math.abs(mate)}`;
    return "#0";
  }
  if (cp === null || cp === undefined) return "...";
  const pawns = cp / 100;
  return (pawns >= 0 ? "+" : "") + pawns.toFixed(2);
}
