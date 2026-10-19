// The phase tip explains the move AFTER the player finds it, so it is asked for
// once there is something to explain: on the teach card at prompt time, and as
// the "why" of a second miss (the reveal). Asked for on every prompt, the
// first answer usually arrived while the card was still waiting and was thrown
// away, so the reveal fell back to the generic "play it to continue".
export function prefetchTrainCoach(prompt, { appState, maiaPhaseCoach, setTrainBanner, trainTeachLine }) {
  if (!prompt?.fen_before) return;
  if (prompt.kind !== "new") return;
  return maiaPhaseCoach({ fen: prompt.fen_before, expectedUci: prompt.expected_uci,
    expectedSan: prompt.expected_san }).then((model) => {
    if (!appState.smart || appState.smart.prompt !== prompt || !model) return;
    prompt.phaseCoach = model;
    const banner = document.getElementById("train-banner");
    const title = document.getElementById("train-banner-title");
    if (banner?.dataset.state === "teach" && /New move/.test(title?.textContent || "")) {
      setTrainBanner("teach", `New move: ${prompt.expected_san}`,
        trainTeachLine(prompt, model) || "Watch the arrow, then play the move.");
    }
  });
}
