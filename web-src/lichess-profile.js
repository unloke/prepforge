// Narrow, normalized boundary for the public Lichess profile endpoint.
// Callers depend on this app-shaped result, not the provider's `perfs` tree.

const PROFILE_BASE = "https://lichess.org/api/user";
const RATING_MIN = 600;
const RATING_MAX = 2600;
const PERFORMANCE_ORDER = ["bullet", "blitz", "rapid", "classical"];

export function lichessProfileUrl(username) {
  return `${PROFILE_BASE}/${encodeURIComponent(String(username || "").trim())}`;
}

export function selectLichessRating(perfs) {
  let best = null;
  for (const perf of PERFORMANCE_ORDER) {
    const entry = perfs && typeof perfs === "object" ? perfs[perf] : null;
    const rating = Number(entry?.rating);
    if (!Number.isFinite(rating) || entry?.prov) continue;
    const games = Number(entry?.games);
    const candidate = {
      rating,
      games: Number.isFinite(games) ? Math.max(0, games) : 0,
      perf,
    };
    if (!best || candidate.games > best.games) best = candidate;
  }
  if (!best) return null;
  return {
    ...best,
    rating: Math.max(RATING_MIN, Math.min(RATING_MAX, Math.round(best.rating))),
  };
}

export function normalizeLichessProfile(raw, fallbackUsername = "") {
  const username = String(raw?.username || raw?.id || fallbackUsername || "").trim();
  const selected = selectLichessRating(raw?.perfs);
  return {
    username: username || null,
    maiaRating: selected?.rating ?? null,
    ratingGames: selected?.games ?? 0,
    ratingPerf: selected?.perf ?? null,
  };
}

export async function fetchLichessProfile(username, { fetchImpl, signal } = {}) {
  const safeUsername = String(username || "").trim();
  if (!safeUsername) throw new Error("Lichess username is required");
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const options = { headers: { Accept: "application/json" } };
  if (signal) options.signal = signal;
  const response = await doFetch(lichessProfileUrl(safeUsername), options);
  if (!response?.ok) {
    const error = new Error(`Lichess profile responded ${response?.status ?? "unknown"}`);
    error.status = response?.status;
    throw error;
  }
  let raw;
  try {
    raw = await response.json();
  } catch (cause) {
    const error = new Error("Lichess profile response was not valid JSON");
    error.cause = cause;
    throw error;
  }
  return normalizeLichessProfile(raw, safeUsername);
}
