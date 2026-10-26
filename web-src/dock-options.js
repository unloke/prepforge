// The Build dock's options: a button in the dock's one head row names what the
// open tab shows, and its popover (a sheet on a phone) holds the database, or
// the scope and horizon, with the panel's scope sentence.
import { openPopover } from "./core/dialog.js";

const PHONE = "(max-width: 760px) and (orientation: portrait), (max-width: 760px) and (min-height: 521px)";

// "Masters" / "Players" for the Explorer; "Mainline · 8 moves" for Coverage.
export function dockOptionsLabel({ tab, db, scope, horizon }) {
  if (tab === "coverage") return `${scope === "branch" ? "Branch" : "Mainline"}${horizon ? ` · ${horizon}` : ""}`;
  return db === "lichess" ? "Players" : "Masters";
}

export function paintDockOptions({ tab, db, scopeText }) {
  const label = dockOptionsLabel({
    tab,
    db,
    scope: document.querySelector("#coverage-scope .is-active")?.dataset.scope,
    horizon: document.getElementById("coverage-depth")?.selectedOptions?.[0]?.textContent || "",
  });
  const name = document.getElementById("build-dock-opts-label");
  if (name) name.textContent = label;
  const button = document.getElementById("build-dock-opts");
  if (button) {
    const what = tab === "coverage" ? "Coverage" : "Explorer";
    button.title = `${what} options: ${label}`;
    button.setAttribute("aria-label", `${what} options, ${label}`);
  }
  const scope = document.getElementById("inspector-scope");
  if (scope) scope.textContent = scopeText;
}

export function toggleDockOptions() {
  const tools = document.getElementById("build-dock-tools");
  const button = document.getElementById("build-dock-opts");
  if (!tools || !button) return;
  if (tools.matches(":popover-open")) {
    tools.hidePopover();
    return;
  }
  openPopover(tools, { opener: button });
  // On a phone it is a sheet at the thumb (phone.css); elsewhere it hangs
  // under the button, kept inside the window.
  const phone = window.matchMedia(PHONE).matches;
  const at = button.getBoundingClientRect();
  tools.style.left = phone ? "" : `${Math.round(Math.max(8, Math.min(at.left, window.innerWidth - tools.offsetWidth - 8)))}px`;
  tools.style.top = phone ? "" : `${Math.round(Math.min(at.bottom + 4, window.innerHeight - tools.offsetHeight - 8))}px`;
  tools.querySelector(".seg:not([hidden]) .is-active, select:not([hidden])")?.focus();
}
