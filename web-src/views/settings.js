import { detectEngineProfile, engineMeasurements, engineProfile, setEngineProfile, subscribeEngineProfile,
  engineSetupState, subscribeEngineSetup, engineWorkerChoices } from "../engine/engine-profile.js";
import { isBrowserEngineAvailable } from "../engine/stockfish-provider.js";
import { html } from "../html.js";
import { renderFullEngineChoice, bindFullEngineChoice } from "./settings-full-engine.js";
// Settings tab rendering (lazy-loaded from app.js).

import "./settings.css";
import { resolveModelBase, peekSharedMaia3Provider, loadMaia3Manifest } from "../engine/maia3-provider.js";
import { getCachedWeights, clearWeightCache } from "../engine/maia3-weight-cache.js";
import { createAccountSection } from "./settings-account.js";

export function createSettingsView({
  appState,
  setStatus,
  saveSettings,
  loadSettings,
  pref,
  setPref,
  effectiveMaiaRating,
  getSharedMaia3Provider,
  disposeSharedMaia3Provider,
  showConfirmModal,
  startFen,
  api,
  postJson,
  startLichessOAuth = () => {},
  onAccountsChanged = () => {},
  signOut,
  openAuthModal,
  refreshAuthStatus,
}) {
  let eventsBound = false;
  const unsubscribers = [];
  let stockfishManifest = null;
  const accountSection = createAccountSection({
    appState,
    api,
    postJson,
    setStatus,
    showConfirmModal,
    signOut,
    openAuthModal,
    refreshAuthStatus,
  });

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
    const effective = effectiveMaiaRating();
    ratingEl.value = String(effective);
    // The range snaps to its 50-point step (2377 -> 2400); while Auto drives the
    // rating, the readout shows the real value Maia uses, not the snapped thumb.
    if (ratingOut) ratingOut.textContent = auto ? String(effective) : ratingEl.value;
  }

  // The one way this card changes the color theme; the app's pref writer then
  // repaints this control, so both stay on one value.
  function pickTheme(value) {
    setPref("theme", value);
    renderThemeControl();
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
      if (isBrowserEngineAvailable()) {
        browserStatusEl.textContent = "available";
        browserStatusEl.className = "status-pill ok";
        if (note) note.textContent = "";
      } else {
        browserStatusEl.textContent = "unavailable";
        browserStatusEl.className = "status-pill err";
        if (note) {
          note.textContent =
            "This browser is not cross-origin isolated (COOP/COEP). Use a supported browser to run analysis locally.";
        }
      }
    }
    renderMaia3Status();
  }

  function renderEngineProfile() {
    const profile = engineProfile();
    const setup = engineSetupState();
    const busy = ["download", "compile", "waiting", "probe"].includes(setup.phase);
    const paint = (id, key, value) => document.getElementById(id)?.querySelectorAll(".seg-btn").forEach((btn) => {
      const active = btn.dataset[key] === String(value);
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    paint("settings-net-seg", "net", profile.net);
    paint("settings-workers-seg", "workers", profile.workers);
    // Only the steps this device measured are offered: asking for a count it never
    // ran, or for the net the ladder stopped at, would start heaps Detect could not
    // hold.
    const choices = engineWorkerChoices();
    document.getElementById("settings-net-seg")?.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.disabled = choices[btn.dataset.net] < 1;
    });
    document.getElementById("settings-workers-seg")?.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.disabled = Number(btn.dataset.workers) > choices[profile.net];
    });
    const detectBtn = document.getElementById("settings-detect");
    if (detectBtn) detectBtn.disabled = busy;
    const status = document.getElementById("settings-profile-status");
    if (status) {
      const m = engineMeasurements();
      const speed = m?.nodesPerSecond ? ` · ${Math.round(m.nodesPerSecond / 1000)}k nodes/s` : "";
      const bytes = setup.phase === "download" && setup.total
        ? ` ${Math.round(setup.loaded / 1048576)} / ${Math.round(setup.total / 1048576)} MB` : "";
      status.textContent = busy || setup.phase === "error" ? `${setup.label}${bytes}`
        : m?.error && profile.source === "fallback" ? `Detection failed: ${m.error}`
        : profile.source === "user" ? "Set by you"
        : profile.source === "detected" ? `Detected for this device${speed}`
        : "Not detected yet";
      // A detected profile that stopped on an error is the memory limit, not a failure.
      status.title = m?.error && profile.source === "detected" ? `Stopped at: ${m.error}` : "";
    }
    const bar = document.getElementById("settings-profile-progress");
    if (bar) {
      bar.hidden = !busy;
      // One bar for the whole setup: getting the net fills the first half, measuring the second,
      // so it never runs backwards between them. A small floor keeps a fresh start visible.
      const share = setup.phase === "download" || setup.phase === "compile" ? setup.fraction / 2
        : setup.phase === "probe" ? 0.5 + setup.fraction / 2 : 0.5;
      bar.firstElementChild.style.setProperty("--progress", String(Math.max(0.03, share)));
    }
    // The full net is this device's choice: the question until it answers, then
    // one action that brings its 94 MB back after a step down.
    renderFullEngineChoice();
  }

  async function renderStockfishVersion() {
    const versionEl = document.getElementById("settings-stockfish-version");
    if (!versionEl) return;
    try {
      stockfishManifest ||= fetch("/static/engine/stockfish.manifest.json").then(async response => {
        if (!response.ok) throw new Error(`manifest ${response.status}`);
        return response.json();
      });
      const net = engineProfile().net;
      const manifest = (await stockfishManifest).engines[net];
      if (!manifest.packageVersion || !manifest.id) {
        throw new Error("invalid manifest");
      }
      versionEl.textContent = `Stockfish ${manifest.packageVersion} ${net === "big" ? "full" : "lite"} (WASM)`;
    } catch {
      versionEl.textContent = "Stockfish version unavailable";
    }
  }

  // Refresh re-checks BOTH halves of this card: the server's saved settings
  // (loadSettings) and the browser engine the rows above report — availability,
  // the engine this device's profile loads, and its net/worker choice. It used
  // to reload /api/settings only, leaving a stale "checking…"/"unavailable"
  // browser row next to a fresh server read.
  async function refreshEngineCard() {
    renderBrowserEngineStatus();
    renderEngineProfile();
    stockfishManifest = null;
    await Promise.allSettled([loadSettings(), renderStockfishVersion()]);
  }

  // Resolves once the async Connections list has rendered too, so callers
  // (e.g. Library's "Link Lichess") can jump to a section on a settled layout.
  function renderSettings(payload) {
    void payload;
    renderBrowserEngineStatus();
    renderEngineProfile();
    void renderStockfishVersion();
    renderStrengthControls();
    renderThemeControl();
    let connections = Promise.resolve();
    try {
      connections = Promise.resolve(renderConnections()).catch(() => {});
    } catch {
      /* signed-out: connections list stays at its static markup */
    }
    renderMaiaAnalysis();
    const account = Promise.resolve(accountSection.refresh()).catch(() => {});
    return Promise.all([connections, account]);
  }

  // "Ready" on the Maia3 card means the model is downloaded; whether analysis
  // USES it is the separate Maia analysis switch. Report both states.
  function renderMaiaAnalysis() {
    const on = !!pref("maiaAnalysis");
    const maiaToggle = document.getElementById("settings-maia-analysis");
    if (maiaToggle) paintSwitch(maiaToggle, on);
    const usage = document.getElementById("settings-maia-usage");
    if (usage) {
      usage.textContent = on ? "In use" : "Not in use";
      usage.title = on ? "" : "Turn on Maia analysis under Playing strength";
    }
    renderMaia3Status();
  }

  function connectionAccounts() {
    const accounts = appState.lichessAccounts;
    if (Array.isArray(accounts)) return accounts;
    return [];
  }

  // Signed in but the /api/lichess answer hasn't landed yet: rendering the
  // empty "Link a Lichess account" state here flashed for seconds before the
  // linked accounts appeared. Show a loading line and fetch once instead.
  let connectionsFetchTried = false;
  function connectionsUnknown() {
    return !!appState.signedIn && !Array.isArray(appState.lichessAccounts) && !appState.lichessUsername;
  }

  async function renderConnections() {
    const list = document.getElementById("settings-lichess-accounts");
    if (!list) return;
    const linkBtn = document.getElementById("settings-link-lichess");
    if (appState.signedIn === false) {
      // Linking attaches Lichess to a PrepForge account: the button leads to
      // sign-in (startLichessOAuth gates it) and says so up front.
      if (linkBtn) {
        linkBtn.hidden = false;
        linkBtn.textContent = "Sign in to link Lichess";
      }
      // The button already says what to do; no standing explanation.
      list.innerHTML = "";
      return;
    }
    if (connectionsUnknown() && !connectionsFetchTried) {
      connectionsFetchTried = true;
      list.innerHTML =
        html`<p class="muted small conn-loading" data-testid="settings-connections-loading" aria-busy="true">Checking linked accounts…</p>`;
      if (linkBtn) linkBtn.hidden = true;
      return refreshConnections();
    }
    if (linkBtn) linkBtn.hidden = false;
    const accounts = connectionAccounts();
    if (linkBtn) linkBtn.textContent = accounts.length ? "Link another Lichess account" : "Link a Lichess account";
    if (!accounts.length) {
      list.innerHTML =
        html`<p class="muted hint">No Lichess account linked yet. Link one to import your games and see yourself in Games and Scout.</p>`;
      return;
    }

    list.innerHTML = html`${accounts
      .map(
        (account) =>
          html`<div class="conn-row" data-account-id="${account.id}"><span class="conn-name"><span class="conn-site">Lichess</span><a class="conn-user" href="https://lichess.org/@/${encodeURIComponent(account.username)}" target="_blank" rel="noopener">${account.username}</a>${account.is_primary ? html` <span class="conn-primary">Primary</span>` : ""}</span><span class="conn-actions"><button type="button" class="conn-menu-btn" data-conn-action="menu" aria-label="Account actions for ${account.username}" aria-haspopup="menu" aria-expanded="false">⋯</button><span class="conn-menu" role="menu" hidden>${account.is_primary
            ? ""
            : html`<button type="button" class="conn-menu-item" role="menuitem" data-conn-action="primary">Set primary</button>`}<button type="button" class="conn-menu-item is-danger" role="menuitem" data-conn-action="unlink">Unlink</button></span></span></div>`,
      )}`;
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
    await api(`/api/lichess/${encodeURIComponent(accountId)}`, { method: "DELETE" });
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

  const MAIA_STATUS_TONE = {
    [MAIA_STATUS.READY]: "ok",
    [MAIA_STATUS.LOADING]: "warn",
    [MAIA_STATUS.UNAVAILABLE]: "err",
    [MAIA_STATUS.ERROR]: "err",
  };

  // The one action button runs the same load verification in every state; its
  // label says what that means here. "Retry" over a model that was never
  // downloaded read as if something had failed.
  const MAIA_ACTION_LABEL = {
    [MAIA_STATUS.READY]: "Verify",
    [MAIA_STATUS.AVAILABLE]: "Download",
    [MAIA_STATUS.CACHE_MISSING]: "Download",
  };

  async function renderMaia3Status() {
    const modelEl = document.getElementById("settings-maia-model");
    const noteEl = document.getElementById("settings-maia-status");
    const errEl = document.getElementById("settings-maia-error");
    if (!modelEl) return;
    // The model source (a full asset URL on hosted deploys) lives in the
    // tooltip; the line itself names the fp16 build, as in the prototype.
    const set = (model, note = "", error = "", source = "") => {
      modelEl.textContent = model;
      modelEl.className = `status-pill ${MAIA_STATUS_TONE[model] || ""}`.trim();
      const actionBtn = document.getElementById("settings-maia-retry");
      if (actionBtn && model !== MAIA_STATUS.LOADING) {
        actionBtn.textContent = MAIA_ACTION_LABEL[model] || "Retry";
      }
      if (noteEl) {
        noteEl.textContent = note;
        noteEl.title = source ? `Model source: ${source}` : "";
      }
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
          set(MAIA_STATUS.READY, "Loaded this session · fp16", "", base);
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
            "Last load failed. Use Retry, or Reset cache if it keeps failing.",
            err ? `${err.message}${err.phase ? ` (${err.phase})` : ""}` : "",
          );
          return;
        }
      }
      let manifest;
      try {
        manifest = await loadMaia3Manifest();
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
        set(MAIA_STATUS.READY, `${sizeMb} cached in this browser · fp16`, "", base);
      } else if (!pref("maiaAnalysis")) {
        // Analysis OFF still reports real runtime state: with no provider and
        // nothing cached, the cache is verifiably empty (not merely on-demand).
        set(MAIA_STATUS.CACHE_MISSING, "Maia analysis is off — model not cached · fp16", "", base);
      } else {
        set(MAIA_STATUS.AVAILABLE, `${sizeMb} · not cached · fp16`, "", base);
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
      setStatus(`Maia3 could not load: ${err.message}`);
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
    } catch {
      /* ignore */
    }
    await clearWeightCache();
    window.location.reload();
  }

  // One info pop is open at most: opening one closes the rest.
  function closeInfoPops() {
    for (const pop of document.querySelectorAll("#view-settings .pf-info-pop")) pop.hidden = true;
    for (const btn of document.querySelectorAll("#view-settings .pf-info")) btn.setAttribute("aria-expanded", "false");
  }

  function toggleInfoPop(btnId, popId) {
    const btn = document.getElementById(btnId);
    const pop = document.getElementById(popId);
    if (!btn || !pop) return;
    btn.setAttribute("aria-controls", popId);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || pop.hidden) return;
      event.stopPropagation();
      pop.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      btn.focus();
    }, true);
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = pop.hidden;
      closeInfoPops();
      pop.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
    });
  }

  // Section nav: click scrolls the card into view and marks the link active; a
  // scroll spy keeps the active marker honest while the user scrolls by hand.
  // The same id names the section beside the page title, so the heading and the
  // strip never disagree. On a phone the strip is one row that scrolls
  // sideways, so the open link is brought into it.
  function markActiveSection(id) {
    let label = "";
    let current = null;
    document.querySelectorAll(".settings-nav .settings-nav-link").forEach((link) => {
      const active = link.getAttribute("href") === `#${id}`;
      link.classList.toggle("is-active", active);
      // aria-current is the accessible form of the same mark.
      if (!active) return link.removeAttribute("aria-current");
      link.setAttribute("aria-current", "true");
      label = link.textContent.trim();
      current = link;
    });
    const here = document.getElementById("settings-current");
    if (here && label) here.textContent = label;
    const nav = document.querySelector(".settings-nav");
    if (nav && current && nav.scrollWidth > nav.clientWidth) {
      const left = current.offsetLeft;
      const right = left + current.offsetWidth;
      if (left < nav.scrollLeft) nav.scrollLeft = Math.max(0, left - 16);
      else if (right > nav.scrollLeft + nav.clientWidth - 28) nav.scrollLeft = right - nav.clientWidth + 44;
    }
  }

  function bindSectionNav() {
    const nav = document.querySelector(".settings-nav");
    if (!nav || nav.dataset.navBound === "1") return;
    nav.dataset.navBound = "1";
    // The markup paints Account as the open section; this names it in the
    // heading too, so the two agree from the first frame.
    markActiveSection((nav.querySelector(".settings-nav-link.is-active")?.getAttribute("href") || "").slice(1) || "set-account");
    // A clicked link stays the active marker while its smooth scroll settles: a
    // short page cannot always bring the target to the spy line, so the spy
    // would otherwise hand the marker to a taller neighbour mid-scroll.
    let lockedId = null;
    let lockTimer = 0;
    nav.querySelectorAll(".settings-nav-link").forEach((link) => {
      link.addEventListener("click", (event) => {
        const id = (link.getAttribute("href") || "").slice(1);
        const target = id && document.getElementById(id);
        if (!target) return;
        event.preventDefault();
        // Reduced motion: jump instead of smooth-scrolling. matchMedia is
        // optional in embedded/test environments.
        const reduceMotion =
          typeof window !== "undefined" &&
          Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
        target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
        markActiveSection(id);
        lockedId = id;
        clearTimeout(lockTimer);
        lockTimer = setTimeout(() => {
          lockedId = null;
        }, 800);
      });
    });
    const sections = () =>
      Array.from(document.querySelectorAll("#view-settings .card[id]"));
    let spyTick = false;
    const onScroll = () => {
      if (spyTick) return;
      spyTick = true;
      requestAnimationFrame(() => {
        spyTick = false;
        if (lockedId) {
          markActiveSection(lockedId);
          return;
        }
        const list = sections();
        // A window that shows every card at once has no section "in front of
        // you", only the one you last jumped to: the spy stays out of the
        // click's way there.
        if (document.documentElement.scrollHeight - window.innerHeight < window.innerHeight * 0.5) return;
        // The last card whose top passed the probe line - also the right answer
        // when the line sits in the gap between two cards. At the bottom of the
        // page a last card too short to reach the line still counts, once it
        // sits in the upper half of the screen.
        const atEnd = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
        const probe = window.innerHeight * (atEnd ? 0.5 : 0.35);
        let current = list[0]?.id ?? null;
        for (const section of list) {
          if (section.getBoundingClientRect().top <= probe) current = section.id;
        }
        if (current) markActiveSection(current);
      });
    };
    document.addEventListener("scroll", onScroll, { passive: true });
  }

  function bind() {
    if (eventsBound) return;
    eventsBound = true;
    bindSectionNav();
    accountSection.bind();

    // Segmented theme control: direct buttons (no select needed). The hidden
    // native #settings-theme select is still synced for assistive tech that
    // expects a select element.
    const themeSeg = document.getElementById("settings-theme-seg");
    if (themeSeg) {
      themeSeg.querySelectorAll(".seg-btn").forEach((btn) => {
        btn.addEventListener("click", () => pickTheme(btn.dataset.themeValue));
      });
    }
    // The hidden select is a second door to the same pref: apply it through the
    // control's own pick (see pickTheme).
    const themeEl = document.getElementById("settings-theme");
    if (themeEl) {
      themeEl.addEventListener("change", () => pickTheme(themeEl.value));
    }

    document.getElementById("settings-net-seg")?.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        setEngineProfile({ net: btn.dataset.net, workers: engineProfile().workers });
      });
    });
    document.getElementById("settings-workers-seg")?.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => setEngineProfile({ net: engineProfile().net, workers: Number(btn.dataset.workers) }));
    });
    bindFullEngineChoice();

    document.getElementById("settings-detect")?.addEventListener("click", () => {
      void detectEngineProfile().catch(() => {});
    });
    unsubscribers.push(subscribeEngineProfile(() => { renderEngineProfile(); void renderStockfishVersion(); }),
      subscribeEngineSetup(renderEngineProfile));

    toggleInfoPop("engine-info", "engine-info-pop");
    toggleInfoPop("maia-info", "maia-info-pop");
    toggleInfoPop("strength-info", "strength-info-pop");
    toggleInfoPop("maia-analysis-info", "maia-analysis-info-pop");
    toggleInfoPop("connections-info", "connections-info-pop");
    document.getElementById("view-settings")?.addEventListener("click", (event) => {
      if (event.target.closest(".pf-info, .pf-info-pop")) return;
      closeInfoPops();
    });

    const refreshBtn = document.getElementById("settings-refresh");
    if (refreshBtn) refreshBtn.addEventListener("click", () => refreshEngineCard().catch(() => {}));

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
      bindSwitch(maiaAuto, !Number.isFinite(appState.maiaRatingPinned), (next) => {
        appState.maiaRatingPinned = next ? null : Number(maiaSlider.value);
        renderStrengthControls();
        saveSettings({ maia_rating: next ? "auto" : appState.maiaRatingPinned }).catch(() => {});
      });
      maiaSlider.addEventListener("input", () => {
        appState.maiaRatingPinned = Number(maiaSlider.value);
        paintSwitch(maiaAuto, false);
        const out = document.getElementById("settings-maia-rating-readout");
        if (out) out.textContent = maiaSlider.value;
      });
      maiaSlider.addEventListener("change", () => {
        saveSettings({ maia_rating: Number(maiaSlider.value) }).catch(() => {});
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
    dispose() { for (const unsubscribe of unsubscribers.splice(0)) unsubscribe(); },
    renderSettings,
    refreshEngineCard,
    renderBrowserEngineStatus,
    renderMaia3Status,
    renderStrengthControls,
    renderThemeControl,
    renderMaiaAnalysis,
    renderConnections,
    refreshConnections,
    renderAccount: () => accountSection.render(),
    retryMaia3,
    verifyMaia3,
    resetMaia3Cache,
    bindSectionNav,
    markActiveSection,
  };
}
