export async function openPgnInput({
  document = globalThis.document, invalidateAnalysisSource, currentOwnerId,
  sourceIsCurrent, loadPgnIntoAnalyze, orientAnalysisFromPgn,
}) {
  const input = document.getElementById("pgn-input");
  const error = document.getElementById("pgn-error");
  error.hidden = true;
  input.removeAttribute("aria-invalid");
  const onInvalid = (message) => {
    error.textContent = message;
    error.hidden = false;
    input.setAttribute("aria-invalid", "true");
  };
  const text = input.value.trim();
  if (!text) {
    onInvalid("Paste a PGN first.");
    return;
  }
  const sourceSeq = invalidateAnalysisSource();
  const ownerId = currentOwnerId();
  const loaded = await loadPgnIntoAnalyze(text, { goToEnd: false, sourceSeq, onInvalid });
  if (!loaded || !sourceIsCurrent(sourceSeq) || ownerId !== currentOwnerId()) return;
  orientAnalysisFromPgn(text);
  document.querySelector("#analyze-open.is-open [data-sheet-close]")?.click();
}

export function bindPgnInput(deps) {
  document.getElementById("open-pgn").addEventListener("click", () => {
    void openPgnInput(deps).catch((error) => deps.setStatusError(error.message));
  });
}
