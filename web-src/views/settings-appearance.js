// Settings Appearance area: theme, accent preset, board colours and piece set.
// Every choice applies at once; the previews are the real controls on the page
// (the accent sample uses the primary button, the board swatch is a 2x2 board).

import { ACCENT_MODES, BOARD_MODES, readStoredAccent, setAccent } from "../theme.js";

const ACCENT_LABELS = { blue: "Blue", orange: "Orange" };
const BOARD_LABELS = { slate: "Slate", classic: "Classic", green: "Green", walnut: "Walnut" };

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
        setPref("theme", btn.dataset.themeValue);
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

      // The dot is the preset's own colour; the selected name is underlined by CSS.
      const dot = document.createElement("span");
      dot.className = "accent-dot";
      btn.append(dot, ACCENT_LABELS[accent] || accent);
      btn.addEventListener("click", () => {
        setAccent(accent);
        renderAccentPresets();
      });
      container.append(btn);
    });
  }

  function renderBoardColors() {
    const container = document.getElementById("settings-board-colors");
    if (!container) return;

    const current = pref("boardTheme") || "slate";
    container.innerHTML = "";

    BOARD_MODES.forEach((board) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "board-color-swatch";
      btn.dataset.board = board;
      btn.setAttribute("aria-pressed", String(board === current));

      // A 2x2 board in this theme's own squares.
      const mini = document.createElement("span");
      mini.className = "board-mini";
      for (const tone of ["light", "dark", "dark", "light"]) {
        const square = document.createElement("span");
        square.className = `board-square ${tone}`;
        mini.append(square);
      }
      btn.append(mini, BOARD_LABELS[board] || board);
      btn.addEventListener("click", () => {
        setPref("boardTheme", board);
        renderBoardColors();
      });
      container.append(btn);
    });
  }

  return {
    render: () => {
      renderTheme();
      renderAccentPresets();
      renderBoardColors();
    },
    bind: bindTheme,
  };
}
