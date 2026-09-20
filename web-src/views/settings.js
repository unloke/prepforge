// Settings tab rendering (lazy-loaded from app.js).

import { resolveModelBase, peekSharedMaia3Provider } from "../engine/maia3-provider.js";
import { getCachedWeights, clearWeightCache } from "../engine/maia3-weight-cache.js";

export function createSettingsView({
  appState,
  setStatus,
  saveSettings,
  loadSettings,
  pref,
  setPref,
  effectiveMaiaRating,
  maiaFallbackRating,
  getSharedMaia3Provider,
  disposeSharedMaia3Provider,
  showConfirmModal,
  startFen,
  api,
  postJson,
  startLichessOAuth = () => {},
  onAccountsChanged = () => {},
}) {
  let eventsBound = false;

  function paintSwitch(el, on) {
    if (!el) return;
    el.classList.toggle("is-on", !!on);
    el.setAttribute("aria-checked", String(!!on));
  }

  function readSwitch(el) {
    return !!el?.classList.contains("is-on");
  }

  function bindSwitch(el, initial, onChange) {
    if (!el) return;
    paintSwitch(el, initial);
    if (el.dataset.bound === "1") return;
    el.dataset.bound = "1";
    el.addEventListener("click", () => {
      if (el.disabled) return;
      const next = !readSwitch(el);
      paintSwitch(el, next);
      onChange(next);
    });
    el.addEventListener("keydown", (event) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        el.click();
      }
    });
  }

  function renderStrengthControls() {
    const depthEl = document.getElementById("settings-depth");
    const depthOut = document.getElementById("settings-depth-readout");
    const autoEl = document.getElementById("settings-maia-auto");
    const autoLabel = document.getElementById("settings-maia-auto-label");
    const ratingEl = document.getElementById("settings-maia-rating");
    const ratingOut = document.getElementById("settings-maia-rating-readout");
    if (!depthEl || !autoEl || !ratingEl) return;
    const settings = appState.settings || {};
    if (Number.isFinite(settings.stockfish_depth)) {
      depthEl.value = String(settings.stockfish_depth);
    }
    if (depthOut) depthOut.textContent = depthEl.value;
    const auto = !Number.isFinite(appState.maiaRatingPinned);
    paintSwitch(autoEl, auto);
    ratingEl.disabled = auto;
    ratingEl.value = String(effectiveMaiaRating());
    if (ratingOut) ratingOut.textContent = ratingEl.value;
    if (autoLabel) {
      autoLabel.textContent = appState.lichessUsername
        ? Number.isFinite(appState.maiaAutoRating)
          ? `Auto — match my Lichess rating (~${appState.maiaAutoRating})`
          : "Auto — match my Lichess rating"
        : `Auto — Lichess not linked, using ${maiaFallbackRating}`;
    }
  }

  function renderThemeControl() {
    const themeEl = document.getElementById("settings-theme");
    const current = String(pref("theme") || "system");
    if (themeEl) themeEl.value = current;
    const seg = document.getElementById("settings-theme-seg");
    if (seg) {
      seg.querySelectorAll(".seg-btn").forEach((btn) => {
        btn.classList.toggle("is-active", btn.dataset.themeValue === current);
        btn.setAttribute("aria-pressed", String(btn.dataset.themeValue === current));
      });
    }
  }

  function renderBrowserEngineStatus() {
    const browserStatusEl = document.getElementById("settings-browser-engine-status");
    const note = document.getElementById("settings-stockfish-status");
    if (browserStatusEl) {
      if (self.crossOriginIsolated) {
        browserStatusEl.textContent = "available";
        if (note) note.textContent = "";
      } else {
        browserStatusEl.textContent = "unavailable";
        if (note) {
          note.textContent =
            "This browser is not cross-origin isolated (COOP/COEP). Use a supported browser to run analysis locally.";
        }
      }
    }
    void renderStockfishVersion();
    renderMaia3Status();
  }

  async function renderStockfishVersion() {
    const versionEl = document.getElementById("settings-stockfish-version");
    if (!versionEl) return;
    try {
      const response = await fetch("/static/engine/stockfish.manifest.json");
      if (!response.ok) throw new Error(`manifest ${response.status}`);
      const manifest = await response.json();
      if (!manifest.packageVersion || manifest.variant !== "lite-threaded") {
        throw new Error("invalid manifest");
      }
      versionEl.textContent = `Stockfish ${manifest.packageVersion} lite (WASM)`;
    } catch {
      versionEl.textContent = "Stockfish version unavailable";
    }
  }

  function renderSettings(payload) {
    void payload;
    renderBrowserEngineStatus();
    renderStrengthControls();
    renderThemeControl();
    try {
      void renderConnections();
    } catch (_) {
      /* signed-out: connections list stays at its static markup */
    }
    renderMaiaAnalysis();
  }

  function renderMaiaAnalysis() {
    const maiaToggle = document.getElementById("settings-maia-analysis");
    if (maiaToggle) paintSwitch(maiaToggle, !!pref("maiaAnalysis"));
    renderMaia3Status();
  }

  function connectionAccounts() {
    const accounts = appState.lichessAccounts;
    if (Array.isArray(accounts)) return accounts;
    if (appState.lichessUsername) {
      return [{ id: "legacy", username: appState.lichessUsername, is_primary: true }];
    }
    return [];
  }

  async function renderConnections() {
    const list = document.getElementById("settings-lichess-accounts");
    if (!list) return;
    const accounts = connectionAccounts();
    if (!accounts.length) {
      list.innerHTML = '<p class="muted">No Lichess account linked.</p>';
      return;
    }
    list.innerHTML = accounts
      .map(
        (account) =>
          `<div class="conn-row" data-account-id="${account.id}">` +
          `<span class="conn-name">${account.username}` +
          (account.is_primary ? ' <span class="conn-primary">Primary</span>' : "") +
          `</span>` +
          `<span class="conn-actions">` +
          `<button type="button" class="conn-menu-btn" data-conn-action="menu" aria-label="Account actions for ${account.username}" aria-haspopup="menu" aria-expanded="false">⋯</button>` +
          `<span class="conn-menu" role="menu" hidden>` +
          (account.is_primary
            ? ""
            : `<button type="button" class="conn-menu-item" role="menuitem" data-conn-action="primary">Set primary</button>`) +
          `<button type="button" class="conn-menu-item is-danger" role="menuitem" data-conn-action="unlink">Unlink</button>` +
          `</span></span></div>`,
      )
      .join("");
  }

  async function refreshConnections() {
    if (typeof api !== "function") return;
    try {
      const status = await api("/api/lichess");
      appState.lichessAccounts = Array.isArray(status.accounts) ? status.accounts : [];
      const primary = appState.lichessAccounts.find((account) => account.is_primary)
        || appState.lichessAccounts[0];
      appState.lichessUsername = primary ? primary.username : null;
    } catch {
      /* keep last-known connection state */
    }
    await renderConnections();
  }

  async function setPrimaryAccount(accountId) {
    await postJson("/api/lichess/primary", { account_id: accountId });
    await refreshConnections();
    onAccountsChanged();
  }

  async function unlinkAccount(accountId) {
    const confirmed = await showConfirmModal({
      title: "Unlink this Lichess account?",
      body: "This browser keeps working; game imports for that identity stop.",
      okLabel: "Unlink",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    const response = await fetch(`/api/lichess/${encodeURIComponent(accountId)}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(`unlink ${response.status}`);
    await refreshConnections();
    onAccountsChanged();
  }

  // Maia3 runtime/cache/provider state. The analysis LAYER switch (Playing
  // strength → Maia analysis) only gates Analyze inference; health stays
  // independently viewable. Status values:
  //   Ready — provider ready this session, or cached weights verified present
  //   Available on demand — manifest reachable, nothing cached yet
  //   Loading — provider initializing, or a Retry verification in flight
  //   Cache missing — manifest reachable but the cached key is absent/empty
  //   Unavailable — provider init/crash failure, or manifest unreachable
  //   Error — unexpected failure while determining the state
  // Peek (provider + IDB presence) is free for every render; Retry performs the
  // actual load verification (constructs the provider + runs inference).
  const MAIA_STATUS = {
    READY: "Ready",
    AVAILABLE: "Available on demand",
    LOADING: "Loading",
    CACHE_MISSING: "Cache missing",
    UNAVAILABLE: "Unavailable",
    ERROR: "Error",
  };

  async function renderMaia3Status() {
    const modelEl = document.getElementById("settings-maia-model");
    const noteEl = document.getElementById("settings-maia-status");
    const errEl = document.getElementById("settings-maia-error");
    if (!modelEl) return;
    const set = (model, note = "", error = "") => {
      modelEl.textContent = model;
      if (noteEl) noteEl.textContent = note;
      if (errEl) {
        errEl.textContent = error ? `Last error: ${error}` : "";
        errEl.hidden = !error;
      }
    };
    try {
      // Peek-only: rendering the Settings status row must never construct the
      // Maia worker — with Maia analysis OFF no provider may be initialized.
      // Health stays viewable regardless of the analysis toggle; the toggle
      // only gates Analyze inference, never this status row or Retry/Reset.
      const provider = peekSharedMaia3Provider();
      if (provider) {
        if (provider.state === "ready") {
          const info = provider.info || {};
          const base = info.url || provider.assetBase || "";
          set(MAIA_STATUS.READY, base ? `Loaded this session · ${base}` : "Loaded this session.");
          return;
        }
        if (provider.state === "initializing") {
          set(MAIA_STATUS.LOADING, "Downloading / preparing the model.");
          return;
        }
        if (provider.state === "unavailable") {
          const err = provider.lastError;
          set(
            MAIA_STATUS.UNAVAILABLE,
            "Last load failed. Use Retry now, or Reset cache if it keeps failing.",
            err ? `${err.message}${err.phase ? ` (${err.phase})` : ""}` : "",
          );
          return;
        }
      }
      let manifest;
      try {
        const resp = await fetch("/static/maia3/maia3.manifest.json");
        if (!resp.ok) throw new Error(`manifest ${resp.status}`);
        manifest = await resp.json();
      } catch {
        set(MAIA_STATUS.UNAVAILABLE, "Model manifest is not reachable from this server.");
        return;
      }
      const base = resolveModelBase(manifest);
      const key =
        (manifest.backend_artifact && manifest.backend_artifact.wasm) ||
        (manifest.artifacts && manifest.artifacts.fp16 && manifest.artifacts.fp16.file) ||
        null;
      const bytes =
        (manifest.artifacts && manifest.artifacts.fp16 && manifest.artifacts.fp16.bytes) || 0;
      const sizeMb = bytes ? `${Math.round(bytes / (1024 * 1024))} MB` : "~46 MB";
      const cached = key ? await getCachedWeights(key) : null;
      if (cached) {
        set(MAIA_STATUS.READY, `${sizeMb} cached in this browser · ${base}`);
      } else if (!pref("maiaAnalysis")) {
        // Analysis OFF still reports real runtime state: with no provider and
        // nothing cached, the cache is verifiably empty (not merely on-demand).
        set(MAIA_STATUS.CACHE_MISSING, `Maia analysis is off — model not cached · ${base}`);
      } else {
        set(MAIA_STATUS.AVAILABLE, `Downloads ${sizeMb} on first use, then cached · ${base}`);
      }
    } catch {
      set(MAIA_STATUS.ERROR, "Could not determine the browser Maia3 state.");
    }
  }

  // Actual health/load verification: constructs the provider (unlike the
  // peek-only status render) and runs one real inference. Always available —
  // independent of the Maia analysis toggle, which only gates Analyze.
  async function verifyMaia3() {
    setStatus("Verifying Maia3…");
    try {
      const provider = getSharedMaia3Provider();
      renderMaia3Status();
      await provider.predictions({ fen: startFen });
      setStatus("Maia3 ready");
    } catch (err) {
      setStatus(`Maia3 retry failed: ${err.message}`);
    } finally {
      renderMaia3Status();
    }
  }

  async function retryMaia3() {
    const btn = document.getElementById("settings-maia-retry");
    if (btn) btn.disabled = true;
    try {
      await verifyMaia3();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function resetMaia3Cache() {
    const confirmed = await showConfirmModal({
      title: "Reset Maia cache?",
      body:
        "Deletes the cached Maia model from this browser, then reloads. The model " +
        "(~46 MB) re-downloads on next use. Use this if Maia keeps failing to load.",
      okLabel: "Reset & reload",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    setStatus("Clearing Maia cache…");
    try {
      disposeSharedMaia3Provider();
    } catch (_) {
      /* ignore */
    }
    await clearWeightCache();
    window.location.reload();
  }

  function toggleInfoPop(btnId, popId) {
    const btn = document.getElementById(btnId);
    const pop = document.getElementById(popId);
    if (!btn || !pop) return;
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = pop.hidden;
      for (const other of document.querySelectorAll("#view-settings .pf-info-pop")) {
        other.hidden = true;
      }
      for (const other of document.querySelectorAll("#view-settings .pf-info")) {
        other.setAttribute("aria-expanded", "false");
      }
      pop.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
    });
  }

  function bind() {
    if (eventsBound) return;
    eventsBound = true;

    // Segmented theme control: direct buttons (no select needed). The hidden
    // native #settings-theme select is still synced for assistive tech that
    // expects a select element.
    const themeSeg = document.getElementById("settings-theme-seg");
    if (themeSeg) {
      themeSeg.querySelectorAll(".seg-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          setPref("theme", btn.dataset.themeValue);
          renderThemeControl();
        });
      });
    }
    const themeEl = document.getElementById("settings-theme");
    if (themeEl) {
      themeEl.addEventListener("change", () => {
        setPref("theme", themeEl.value);
        renderThemeControl();
      });
    }

    toggleInfoPop("engine-info", "engine-info-pop");
    toggleInfoPop("maia-info", "maia-info-pop");
    toggleInfoPop("strength-info", "strength-info-pop");
    toggleInfoPop("maia-analysis-info", "maia-analysis-info-pop");
    toggleInfoPop("connections-info", "connections-info-pop");
    document.getElementById("view-settings")?.addEventListener("click", (event) => {
      if (event.target.closest(".pf-info, .pf-info-pop")) return;
      for (const other of document.querySelectorAll("#view-settings .pf-info-pop")) {
        other.hidden = true;
      }
      for (const other of document.querySelectorAll("#view-settings .pf-info")) {
        other.setAttribute("aria-expanded", "false");
      }
    });

    const refreshBtn = document.getElementById("settings-refresh");
    if (refreshBtn) refreshBtn.addEventListener("click", () => loadSettings().catch(() => {}));

    const maiaRetryBtn = document.getElementById("settings-maia-retry");
    if (maiaRetryBtn) maiaRetryBtn.addEventListener("click", () => retryMaia3().catch(() => {}));

    const maiaResetBtn = document.getElementById("settings-maia-reset");
    if (maiaResetBtn) maiaResetBtn.addEventListener("click", () => resetMaia3Cache().catch(() => {}));

    const maiaToggle = document.getElementById("settings-maia-analysis");
    bindSwitch(maiaToggle, !!pref("maiaAnalysis"), (next) => {
      setPref("maiaAnalysis", next);
      renderMaiaAnalysis();
    });

    const depthSlider = document.getElementById("settings-depth");
    if (depthSlider) {
      depthSlider.addEventListener("input", () => {
        const out = document.getElementById("settings-depth-readout");
        if (out) out.textContent = depthSlider.value;
      });
      depthSlider.addEventListener("change", () =>
        saveSettings({ stockfish_depth: Number(depthSlider.value) }).catch(() => {}),
      );
    }

    const maiaAuto = document.getElementById("settings-maia-auto");
    const maiaSlider = document.getElementById("settings-maia-rating");
    if (maiaAuto && maiaSlider) {
      bindSwitch(maiaAuto, !Number.isFinite(appState.maiaRatingPinned), (next) =>
        saveSettings({ maia_rating: next ? "auto" : Number(maiaSlider.value) }).catch(() => {}),
      );
      maiaSlider.addEventListener("input", () => {
        const out = document.getElementById("settings-maia-rating-readout");
        if (out) out.textContent = maiaSlider.value;
      });
      maiaSlider.addEventListener("change", () => {
        if (!readSwitch(maiaAuto)) saveSettings({ maia_rating: Number(maiaSlider.value) }).catch(() => {});
      });
    }

    const linkBtn = document.getElementById("settings-link-lichess");
    if (linkBtn) linkBtn.addEventListener("click", () => startLichessOAuth());

    const accountsList = document.getElementById("settings-lichess-accounts");
    if (accountsList) {
      const closeConnMenus = (except = null) => {
        for (const menu of accountsList.querySelectorAll(".conn-menu")) {
          if (menu !== except) menu.hidden = true;
        }
        for (const btn of accountsList.querySelectorAll(".conn-menu-btn")) {
          if (!except || btn.closest(".conn-actions")?.querySelector(".conn-menu") !== except) {
            btn.setAttribute("aria-expanded", "false");
          }
        }
      };
      accountsList.addEventListener("click", (event) => {
        const button = event.target.closest("[data-conn-action]");
        const row = event.target.closest("[data-account-id]");
        if (!button || !row) return;
        const accountId = row.dataset.accountId;
        if (button.dataset.connAction === "menu") {
          const menu = row.querySelector(".conn-menu");
          if (!menu) return;
          const open = menu.hidden;
          closeConnMenus(menu);
          menu.hidden = !open;
          button.setAttribute("aria-expanded", String(open));
          if (open) menu.querySelector(".conn-menu-item")?.focus();
          return;
        }
        closeConnMenus();
        if (button.dataset.connAction === "primary") {
          setPrimaryAccount(accountId).catch((error) => setStatus(String(error.message || error)));
        } else if (button.dataset.connAction === "unlink") {
          unlinkAccount(accountId).catch((error) => setStatus(String(error.message || error)));
        }
      });
      accountsList.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeConnMenus();
      });
      document.addEventListener("click", (event) => {
        if (!event.target.closest?.("#settings-lichess-accounts")) closeConnMenus();
      });
    }
  }

  return {
    bind,
    renderSettings,
    renderBrowserEngineStatus,
    renderMaia3Status,
    renderStrengthControls,
    renderThemeControl,
    renderMaiaAnalysis,
    renderConnections,
    refreshConnections,
    retryMaia3,
    verifyMaia3,
    resetMaia3Cache,
    // Test/acceptance hook: the Settings view binds lazily after the
    // /api/settings round-trip, so expose the binder for harnesses.
    ensureBound: bind,
  };
}
