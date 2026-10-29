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
  const fileInput = document.getElementById("pgn-file-input");
  document.getElementById("pgn-file-btn").addEventListener("click", () => {
    fileInput.value = "";
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void deps.fillPgnInputFromFile(file).catch((error) => deps.setStatusError(error.message));
  });
  document.getElementById("open-pgn").addEventListener("click", () => {
    void openPgnInput(deps).catch((error) => deps.setStatusError(error.message));
  });
  document.getElementById("games-import-pgn").addEventListener("click", async () => {
    try {
      await deps.switchView("analyze");
      await deps.preloadAnalyzeView();
      if (!deps.isAnalyzeActive()) return;
      document.getElementById("analyze-open").classList.add("is-open");
      document.querySelector('[data-sheet-open="analyze-open"]').setAttribute("aria-expanded", "true");
      document.getElementById("pgn-drawer").open = true;
      document.querySelector('[data-reveal="#pgn-drawer"]').setAttribute("aria-expanded", "true");
      document.getElementById("pgn-input").focus();
    } catch (error) {
      deps.setStatusError(error.message);
    }
  });
}
