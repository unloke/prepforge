// Settings Appearance area — accent presets and board color themes.
// Replaces inline appearance controls in index.html with modular rendering.

import { ACCENT_MODES, readStoredAccent, setAccent } from "../theme.js";
import { html } from "../html.js";

export function createAppearanceSection({ pref, setPref }) {
  let bound = false;

  function renderTheme() {
    const themeSeg = document.getElementById("settings-theme-seg");
    if (!themeSeg) return;

    const current = String(pref("theme") || "system");
    themeSeg.querySelectorAll(".seg-btn").forEach((btn) => {
      const isActive = btn.dataset.themeValue === current;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    });

    // Keep native select in sync (for assistive tech)
    const nativeSelect = document.getElementById("settings-theme");
    if (nativeSelect) nativeSelect.value = current;
  }

  function bindTheme() {
    if (bound) return;
    bound = true;

    const themeSeg = document.getElementById("settings-theme-seg");
    if (!themeSeg) return;

    themeSeg.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const value = btn.dataset.themeValue;
        setPref("theme", value);
        renderTheme();
      });
    });
  }

  function renderAccentPresets() {
    const container = document.getElementById("settings-accent-pickers");
    if (!container) return;

    const current = readStoredAccent() || "blue";

    container.innerHTML = "";

    ACCENT_MODES.forEach((accent) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "accent-swatch";
      btn.dataset.accent = accent;
      btn.setAttribute("aria-pressed", String(accent === current));
      btn.setAttribute("title", `${accent.charAt(0).toUpperCase() + accent.slice(1)} accent`);

      // Create colored line element for the swatch
      const line = document.createElement("span");
      line.className = "accent-line";
      btn.append(line);

      container.append(btn);

      // Bind click handler
      btn.addEventListener("click", () => {
        setAccent(accent);
        renderAccentPresets();
        updateAccentSample();
      });
    });

    // Also update the sample preview
    updateAccentSample();
  }

  function updateAccentSample() {
    const sample = document.getElementById("settings-accent-sample");
    if (!sample) return;

    // The sample button will automatically pick up the current accent via CSS
    // because it has class="btn primary" which uses --primary, set by accent preset
  }

  function renderBoardColors() {
    const container = document.getElementById("settings-board-colors");
    if (!container) return;

    const currentPair = [pref("boardLight"), pref("boardDark")] || ["classic", null];
    const lightColor = currentPair[0] || "#f0d9b5";
    const darkColor = currentPair[1] || "#b58863";

    // Board color themes from existing CSS variables
    const themes = [
      { name: "classic", light: "#f0d9b5", dark: "#b58863" },
      { name: "green", light: "#dee3c6", dark: "#769456" },
      { name: "blue", light: "#cce0ff", dark: "#5e7fa0" },
      { name: "dark", light: "#c3bcbb", dark: "#787270" },
      { name: "seafoam", light: "#d1f2eb", dark: "#43a198" },
    ];

    container.innerHTML = "";

    themes.forEach((theme) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "board-color-swatch";
      btn.dataset.themeName = theme.name;
      btn.setAttribute("aria-pressed", String(theme.name === currentPair[0]));
      btn.setAttribute("title", `${theme.name.charAt(0).toUpperCase() + theme.name.slice(1)} board`);

      // Two squares showing the pair
      const squareLight = document.createElement("div");
      squareLight.className = "board-square light";
      squareLight.style.backgroundColor = theme.light;

      const squareDark = document.createElement("div");
      squareDark.className = "board-square dark";
      squareDark.style.backgroundColor = theme.dark;

      btn.append(squareLight, squareDark);
      container.append(btn);

      // Bind click handler
      btn.addEventListener("click", () => {
        setPref("boardLight", theme.name);
        setPref("boardDark", null); // null means use CSS default
        renderBoardColors();
      });
    });
  }

  function bindBoardColors() {
    // Handlers attached during render
  }

  function dispose() {
    // No persistent state to clean up
  }

  return {
    render: () => {
      renderTheme();
      renderAccentPresets();
      renderBoardColors();
    },
    bind: () => {
      bindTheme();
      bindBoardColors();
    },
    dispose,
  };
}
