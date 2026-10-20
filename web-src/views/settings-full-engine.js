import { fullEngineChoice, chooseFullEngine } from "../engine/engine-profile.js";

// The full net's 94 MB are the device owner's call, not the probe's: the row
// asks once, then keeps one action that fetches it again after a step down.
export function renderFullEngineChoice() {
  const choice = fullEngineChoice();
  document.getElementById("settings-full-row")?.toggleAttribute("hidden", !choice);
  const label = document.getElementById("settings-full-label"), download = document.getElementById("settings-full-download"),
    keep = document.getElementById("settings-full-keep");
  if (label) label.textContent = choice === "ask" ? "Download the full engine?" : "Full engine";
  if (download) download.textContent = choice === "ask" ? "Download (94 MB)" : "Download the full engine (94 MB)";
  if (keep) keep.toggleAttribute("hidden", choice !== "ask");
}

export function bindFullEngineChoice() {
  document.getElementById("settings-full-download")?.addEventListener("click", () => {
    void chooseFullEngine(true).catch(() => {});
  });
  document.getElementById("settings-full-keep")?.addEventListener("click", () => {
    void chooseFullEngine(false).catch(() => {});
  });
}
