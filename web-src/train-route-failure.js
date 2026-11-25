import { setStatusError } from "./core/api.js";
import { parseWorkspaceLocation } from "./workspace-url.js";

export function showTrainModuleLoadFailure(error, retry) {
  const home = document.getElementById("train-home");
  const message = document.getElementById("train-due-error");
  const button = document.getElementById("train-due-retry");
  if (home) {
    home.classList.remove("is-loading");
    home.removeAttribute("aria-busy");
  }
  if (message) {
    message.textContent = "Train couldn't load.";
    message.hidden = false;
  }
  if (button) {
    button.hidden = false;
    button.onclick = async () => {
      button.onclick = null;
      button.hidden = true;
      if (message) message.hidden = true;
      try { await retry(); } catch (retryError) { showTrainModuleLoadFailure(retryError, retry); }
    };
  }
  setStatusError(error.message);
}

export function retryTrainEntry(isActive, enter, onFailure = showTrainModuleLoadFailure) {
  const attempt = async () => { if (isActive()) await enter(isActive); };
  return attempt().catch((error) => { if (isActive()) onFailure(error, attempt); });
}

export function trainRouteMatches(loc) {
  const now = parseWorkspaceLocation(window.location.href);
  return now.view === "train" && (now.repertoireId || null) === (loc.repertoireId || null) && (now.trainMode || null) === (loc.trainMode || null);
}
