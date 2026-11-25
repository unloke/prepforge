import { setStatusError } from "./core/api.js";

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
      button.hidden = true;
      if (message) message.hidden = true;
      try { await retry(); } catch (retryError) { showTrainModuleLoadFailure(retryError, retry); }
    };
  }
  setStatusError(error.message);
}
