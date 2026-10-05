export function prefetchTrainCoach(prompt, { appState, maiaPhaseCoach, setTrainBanner, trainTeachLine }) {
  if (!prompt?.fen_before) return;
  return maiaPhaseCoach({ fen: prompt.fen_before, expectedUci: prompt.expected_uci,
    expectedSan: prompt.expected_san }).then((model) => {
    if (!appState.smart || appState.smart.prompt !== prompt || !model) return;
    prompt.phaseCoach = model;
    const banner = document.getElementById("train-banner");
    const title = document.getElementById("train-banner-title");
    if (prompt.kind === "new" && banner?.dataset.state === "teach" && /New move/.test(title?.textContent || "")) {
      setTrainBanner("teach", `New move: ${prompt.expected_san}`,
        trainTeachLine(prompt, model) || "Watch the arrow, then play the move.");
    }
  });
}
