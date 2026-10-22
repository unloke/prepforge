// The fixtures' Lichess account does not exist, so the app's public profile
// lookup (lichess.org/api/user/<name>) gets the 404 Lichess itself would send,
// CORS header included. The smokes never touch the network for it, and a
// sandbox whose proxy strips that header cannot fail them on a CORS error.
export function routeLichessProfile(target) {
  return target.route("https://lichess.org/api/user/**", (route) => route.fulfill({
    status: 404,
    headers: { "access-control-allow-origin": "*" },
    contentType: "application/json",
    body: JSON.stringify({ error: "Not found" }),
  }));
}
