// Which side of a game is "me"? Analyze flips its board to the user's side
// when a loaded game names one of their linked Lichess identities.

// "white" / "black" when exactly one side is recognisably Self, else null
// (neither side, or both — a game against yourself stays as it is).
export function selfSide(white, black, names = []) {
  const mine = new Set(
    names.filter(Boolean).map((name) => String(name).trim().toLowerCase())
  );
  const w = String(white || "").trim().toLowerCase();
  const b = String(black || "").trim().toLowerCase();
  const isW = !!w && mine.has(w);
  const isB = !!b && mine.has(b);
  if (isB && !isW) return "black";
  if (isW && !isB) return "white";
  return null;
}

// Saved games speak from the linked player's viewpoint. Unidentified games
// retain their PGN result, since a win/loss sign would invent an identity.
export function analysisHistoryResult(game, names = []) {
  if (!game.result || game.result === "*") return { mark: "", label: "", tone: "" };
  const side = selfSide(game.white, game.black, names);
  if (!side || !["1-0", "0-1", "1/2-1/2"].includes(game.result)) return { mark: game.result, label: game.result, tone: "" };
  if (game.result === "1/2-1/2") return { mark: "=", label: "Draw", tone: "draw" };
  const won = (game.result === "1-0") === (side === "white");
  return { mark: won ? "+" : "−", label: won ? "Win" : "Loss", tone: won ? "win" : "loss" };
}

// "Engine review": on a game the user played (selfSide known), the coach grades only
// the user's own moves on the mainline — the opponent's slips are not the user's to fix.
// Free exploration (no mainline ply) and games with no recognisable Self review every move.
export function isReviewedMove({ mover, selfSide: self = null, mainline = true } = {}) {
  if (!mainline || !self) return true;
  return mover === self;
}

// White / Black tag values from a PGN's headers ("" when absent).
export function pgnPlayers(text) {
  const header = (tag) => {
    const match = String(text || "").match(new RegExp(`\\[${tag}\\s+"([^"]*)"\\]`));
    return match ? match[1] : "";
  };
  return { white: header("White"), black: header("Black") };
}
