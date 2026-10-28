import { appState, boards } from "./core/state.js";
import { setStatus, setStatusError } from "./core/api.js";
import { analyzeView } from "./views/analyze-loader.js";
import { openModal } from "./core/dialog.js";
import { closeSheetOffPhone } from "./phone-layout.js";
import { wireLibraryPhoneHead } from "./library-phone.js";
import { disposeSharedMaia3Provider, peekSharedMaia3Provider } from "./engine/maia3-provider.js";

// Phone chrome and the Maia idle teardown: the More sheet, the thumb bar that
// slides over the tab bar in the study views, the phone report sheets, the
// hold-to-repeat board arrows, the mirrored Analyze label, and the timer that
// hands Maia's memory back after a tab has been parked. Bound once from the
// shell's bindEvents.

let onAccountChipClick, toggleTheme;

export function bindPhoneChrome(deps) {
  ({ onAccountChipClick, toggleTheme } = deps);
  wireMobileNav();
  wireLibraryPhoneHead();
}

// Maia idle teardown. The browser Maia engine (onnxruntime-web session + WASM heap) is by
// far the heaviest thing the page holds — tens-to-hundreds of MB of weights + activation
// arena that ORT never voluntarily releases. Backgrounding a tab only throttles its CPU; it
// does NOT free that worker/session, so a tab left in the background keeps the whole footprint
// resident. After the tab has been hidden a while with no Maia work in flight, dispose the
// shared provider to hand that memory back. It transparently re-inits on the next use, and the
// IndexedDB weight cache means a re-init skips the ~46 MB download — only the session is rebuilt.
//
// The window is deliberately generous (10 min). A re-init still has to rebuild the ORT session
// (graph-optimizing a 23M-param transformer — seconds, the genuinely slow part), so tearing down
// after a SHORT hidden spell punished the common dev/study loop of tabbing to an editor and back:
// every return rebuilt the session and the "loading model" toast read like a fresh download. Only
// a tab parked in the background for a long stretch — where reclaiming ~1 GB clearly wins — should
// pay that rebuild cost. (Returning to the foreground cancels the timer, so an active tab never
// tears down.)
const MAIA_IDLE_TEARDOWN_MS = 10 * 60 * 1000;
let maiaIdleTimer = null;

export function clearMaiaIdleTeardown() {
  if (maiaIdleTimer !== null) {
    clearTimeout(maiaIdleTimer);
    maiaIdleTimer = null;
  }
}

export function scheduleMaiaIdleTeardown() {
  clearMaiaIdleTeardown();
  maiaIdleTimer = setTimeout(() => {
    maiaIdleTimer = null;
    const provider = peekSharedMaia3Provider();
    if (!provider) return; // nothing live to release
    // Still working (e.g. a Generate run left in a hidden tab)? Don't abort it — check back later.
    if (provider.busy) {
      scheduleMaiaIdleTeardown();
      return;
    }
    disposeSharedMaia3Provider();
  }, MAIA_IDLE_TEARDOWN_MS);
}

// Mobile bottom bar: the More button opens a bottom sheet carrying the
// secondary destinations (Analyze, Scout, Teams, Settings, command palette).
// Sheet entries mirror the canonical nav buttons so every view keeps its real
// activation path (URL sync, loaders, transient-overlay cleanup).
export function wireMobileNav() {
  // Board screens only scroll down. overflow-x: hidden still lets a
  // scrollIntoView nudge the study sideways by a subpixel, which slid the
  // full-width board 1px off the left edge; snap any sideways scroll back.
  document.addEventListener("scroll", (event) => {
    const el = event.target;
    if (el instanceof Element && el.classList.contains("study") && el.scrollLeft !== 0) el.scrollLeft = 0;
  }, { capture: true, passive: true });
  const sheet = document.getElementById("more-sheet");
  const moreBtn = document.getElementById("more-nav-btn");
  if (!sheet || !moreBtn) return;
  let closeOpenSheet = null;
  const closeSheet = ({ restoreFocus = true } = {}) => {
    if (!closeOpenSheet) return;
    const close = closeOpenSheet;
    closeOpenSheet = null;
    moreBtn.setAttribute("aria-expanded", "false");
    close({ restoreFocus });
  };
  const openSheet = () => {
    moreBtn.setAttribute("aria-expanded", "true");
    closeOpenSheet = openModal(sheet, { keep: true, onDismiss: () => closeSheet() });
  };
  moreBtn.addEventListener("click", () => {
    if (sheet.open) closeSheet();
    else openSheet();
  });
  // The sheet belongs to the phone layout: a bar that is gone must not leave it
  // as a full-width bottom sheet over the desktop board.
  closeSheetOffPhone(() => closeSheet({ restoreFocus: false }));
  sheet.querySelectorAll("[data-nav-mirror]").forEach((item) => {
    item.addEventListener("click", () => {
      const [view, section] = item.dataset.navMirror.split(":");
      closeSheet({ restoreFocus: false });
      const target = document.querySelector(section
        ? `.tab[data-view="${view}"][data-replay-section="${section}"]`
        : `.tab[data-view="${view}"]`);
      target?.click();
    });
  });
  sheet.querySelectorAll("[data-lib-mirror]").forEach((item) => {
    item.addEventListener("click", () => {
      closeSheet({ restoreFocus: false });
      document.getElementById(item.dataset.libMirror)?.click();
    });
  });
  // Mobile account entry (the rail — and its account row — is hidden ≤ 760px).
  // Signed in, the account menu opens inside the still-open sheet with this
  // item as its opener, so Escape returns focus here; a guest gets the auth modal.
  const accountItem = document.getElementById("sheet-account");
  if (accountItem) {
    accountItem.addEventListener("click", () => {
      if (!appState.signedIn) closeSheet({ restoreFocus: false });
      onAccountChipClick(null, { trigger: accountItem });
    });
  }
  // Picking an account-menu action finishes the sheet's job too.
  document.getElementById("account-menu")?.addEventListener("click", (event) => {
    if (event.target.closest?.('[role="menuitem"]')) closeSheet({ restoreFocus: false });
  });
  // Phones have no rail: the sheet carries the light/dark toggle (it stays
  // open so the switch is visible behind it).
  document.getElementById("sheet-theme")?.addEventListener("click", toggleTheme);
  const paletteItem = document.getElementById("sheet-palette");
  if (paletteItem) {
    paletteItem.addEventListener("click", () => {
      closeSheet({ restoreFocus: false });
      document.getElementById("open-palette")?.click();
    });
  }
  wirePhoneStudyNav();
  wirePhoneSheets();
  wireHoldRepeat();
}

// Holding a move arrow steps on repeat, like a held arrow key. The click that
// ends a hold is dropped so letting go doesn't step once more.
export function wireHoldRepeat() {
  for (const id of ["analysis-prev", "analysis-next", "build-parent", "build-next"]) {
    const button = document.getElementById(id);
    if (!button) continue;
    let delay = 0;
    let timer = 0;
    let repeated = false;
    const stop = () => {
      clearTimeout(delay);
      clearInterval(timer);
    };
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      stop();
      repeated = false;
      delay = setTimeout(() => {
        timer = setInterval(() => {
          repeated = true;
          button.click();
        }, 110);
      }, 380);
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) button.addEventListener(type, stop);
    button.addEventListener("click", (event) => {
      if (!event.isTrusted || !repeated) return;
      repeated = false;
      event.stopImmediatePropagation();
    }, true);
    button.addEventListener("contextmenu", (event) => event.preventDefault());
  }
}

// Phone study views (Analyze, Repertoire, Train) hide the tab bar so the board
// and panel get the height; the views button in the board bar slides it up over
// the bar. Picking a destination, tapping elsewhere or Escape puts it away.
export function wirePhoneStudyNav() {
  const tabbar = document.getElementById("app-tabbar");
  const toggles = [...document.querySelectorAll("[data-phone-nav]")];
  if (!tabbar || !toggles.length) return;
  const isOpen = () => document.body.classList.contains("phone-nav-open");
  const setOpen = (open) => {
    document.body.classList.toggle("phone-nav-open", open);
    toggles.forEach((button) => button.setAttribute("aria-expanded", String(open)));
  };
  toggles.forEach((button) => button.addEventListener("click", () => setOpen(!isOpen())));
  tabbar.addEventListener("click", (event) => {
    if (event.target.closest(".tabbar-item")) setOpen(false);
  });
  document.addEventListener("pointerdown", (event) => {
    if (isOpen() && !event.target.closest?.("#app-tabbar, [data-phone-nav]")) setOpen(false);
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen()) setOpen(false);
  });
}

// Phone sheets (Analyze's report and games): a [data-sheet-open] button raises
// the sheet it names over the screen; Done, a tap outside or Escape lowers it.
// A [data-mirror] button clicks the control its selector names (phones hide some
// controls and offer them where the thumb is) and lowers any open sheet. A
// [data-reveal] button opens the <details> its selector names in place, inside
// the open sheet, and leaves the sheet up.
export function wirePhoneSheets() {
  const close = () => {
    const open = document.querySelector(".phone-sheet.is-open");
    if (!open) return;
    open.classList.remove("is-open");
    document.querySelector(`[data-sheet-open="${open.id}"]`)?.setAttribute("aria-expanded", "false");
  };
  document.addEventListener("click", (event) => {
    const opener = event.target.closest?.("[data-sheet-open]");
    if (opener) {
      const sheet = document.getElementById(opener.dataset.sheetOpen);
      const wasOpen = sheet?.classList.contains("is-open");
      close();
      if (sheet && !wasOpen) {
        sheet.classList.add("is-open");
        opener.setAttribute("aria-expanded", "true");
      }
      return;
    }
    const copy = event.target.closest?.("[data-copy]");
    if (copy) {
      close();
      void copyAnalysisText(copy.dataset.copy);
      return;
    }
    const mirror = event.target.closest?.("[data-mirror]");
    if (mirror) {
      close();
      document.querySelector(mirror.dataset.mirror)?.click();
      return;
    }
    const reveal = event.target.closest?.("[data-reveal]");
    if (reveal) {
      const target = document.querySelector(reveal.dataset.reveal);
      if (!target) return;
      target.open = !target.open;
      reveal.setAttribute("aria-expanded", String(target.open));
      target.scrollIntoView({ block: "nearest" });
      return;
    }
    // The dim backdrop is the sheet's ::before, so a tap on it lands above the sheet's top.
    const sheet = event.target.closest?.(".phone-sheet");
    if (event.target.closest?.("[data-sheet-close]") || !sheet || event.clientY < sheet.getBoundingClientRect().top) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
}

// The Games sheet's Copy rows (Lichess's Share & export): the game with its
// variations, as the PGN box holds it, or the position on the board.
export async function copyAnalysisText(kind) {
  const box = document.getElementById("pgn-input");
  const text = kind === "fen"
    ? boards.analysis?.fen
    : analyzeView?.serializeAnalysisPgn(box?.value || "") || box?.value;
  const name = kind === "fen" ? "FEN" : "PGN";
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`${name} copied`);
  } catch {
    setStatusError(`Could not copy the ${name}`);
  }
}
