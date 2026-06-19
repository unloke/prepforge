// Settings tab rendering (lazy-loaded from app.js).

import { resolveModelBase } from "../engine/maia3-provider.js";
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
}) {
  let eventsBound = false;

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
    autoEl.checked = auto;
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
    renderMaia3Status();
  }

  function renderSettings(payload) {
    void payload;
    renderBrowserEngineStatus();
    renderStrengthControls();
    const brilliantToggle = document.getElementById("settings-brilliant-toggle");
    if (brilliantToggle) brilliantToggle.checked = !!pref("brilliantDetection");
  }

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
      const provider = getSharedMaia3Provider();
      if (provider.state === "ready") {
        const info = provider.info || {};
        const base = info.url || provider.assetBase || "";
        set("available", base ? `Loaded this session · ${base}` : "Loaded this session.");
        return;
      }
      if (provider.state === "initializing") {
        set("initializing…", "Downloading / preparing the model.");
        return;
      }
      if (provider.state === "unavailable") {
        const err = provider.lastError;
        set(
          "unavailable",
          "Last load failed. Use Retry now, or Reset cache if it keeps failing.",
          err ? `${err.message}${err.phase ? ` (${err.phase})` : ""}` : "",
        );
        return;
      }
      let manifest;
      try {
        const resp = await fetch("/static/maia3/maia3.manifest.json");
        if (!resp.ok) throw new Error(`manifest ${resp.status}`);
        manifest = await resp.json();
      } catch {
        set("unavailable", "Model manifest is not reachable from this server.");
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
        set("ready (cached)", `${sizeMb} cached in this browser · ${base}`);
      } else {
        set("available on demand", `Downloads ${sizeMb} on first use, then cached · ${base}`);
      }
    } catch {
      set("unavailable", "Could not determine the browser Maia3 state.");
    }
  }

  async function retryMaia3() {
    const btn = document.getElementById("settings-maia-retry");
    if (btn) btn.disabled = true;
    setStatus("Retrying Maia3…");
    try {
      const provider = getSharedMaia3Provider();
      renderMaia3Status();
      await provider.predictions({ fen: startFen });
      setStatus("Maia3 ready");
    } catch (err) {
      setStatus(`Maia3 retry failed: ${err.message}`);
    } finally {
      if (btn) btn.disabled = false;
      renderMaia3Status();
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

  function bind() {
    if (eventsBound) return;
    eventsBound = true;

    const refreshBtn = document.getElementById("settings-refresh");
    if (refreshBtn) refreshBtn.addEventListener("click", () => loadSettings().catch(() => {}));

    const maiaRetryBtn = document.getElementById("settings-maia-retry");
    if (maiaRetryBtn) maiaRetryBtn.addEventListener("click", () => retryMaia3().catch(() => {}));

    const maiaResetBtn = document.getElementById("settings-maia-reset");
    if (maiaResetBtn) maiaResetBtn.addEventListener("click", () => resetMaia3Cache().catch(() => {}));

    const brilliantToggle = document.getElementById("settings-brilliant-toggle");
    if (brilliantToggle) {
      brilliantToggle.checked = !!pref("brilliantDetection");
      brilliantToggle.addEventListener("change", () =>
        setPref("brilliantDetection", brilliantToggle.checked),
      );
    }

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
      maiaAuto.addEventListener("change", () =>
        saveSettings({ maia_rating: maiaAuto.checked ? "auto" : Number(maiaSlider.value) }).catch(
          () => {},
        ),
      );
      maiaSlider.addEventListener("input", () => {
        const out = document.getElementById("settings-maia-rating-readout");
        if (out) out.textContent = maiaSlider.value;
      });
      maiaSlider.addEventListener("change", () => {
        if (!maiaAuto.checked) saveSettings({ maia_rating: Number(maiaSlider.value) }).catch(() => {});
      });
    }
  }

  return {
    bind,
    renderSettings,
    renderBrowserEngineStatus,
    renderMaia3Status,
    renderStrengthControls,
    retryMaia3,
    resetMaia3Cache,
  };
}