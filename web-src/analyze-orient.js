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

// White / Black tag values from a PGN's headers ("" when absent).
export function pgnPlayers(text) {
  const header = (tag) => {
    const match = String(text || "").match(new RegExp(`\\[${tag}\\s+"([^"]*)"\\]`));
    return match ? match[1] : "";
  };
  return { white: header("White"), black: header("Black") };
}
