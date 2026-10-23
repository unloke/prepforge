import { detectEngineProfile, engineMeasurements, engineProfile, setEngineProfile, subscribeEngineProfile,
  engineSetupState, subscribeEngineSetup, engineWorkerChoices } from "../engine/engine-profile.js";
import { isBrowserEngineAvailable } from "../engine/stockfish-provider.js";
import { html } from "../html.js";
import { isPopoverOpen, menuKeys, openPopover } from "../core/dialog.js";
import { createSettingsDownloads } from "./settings-downloads.js";
import { subscribeDownloads } from "../engine/engine-downloads.js";
// Settings tab rendering (lazy-loaded from app.js).

import "./settings.css";
import { createAccountSection } from "./settings-account.js";
import { jumpToSection } from "./settings-jump.js";

export function createSettingsView({
  appState,
  setStatus,
  saveSettings,
  loadSettings,
  pref,
  setPref,
  effectiveMaiaRating,
  showConfirmModal,
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
  const downloads = createSettingsDownloads({ showConfirmModal, setPref });

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
    downloads.render();
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
    await Promise.allSettled([loadSettings(), renderStockfishVersion(), downloads.refresh()]);
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
      // Train's practice opponent and Build's Generate use Maia either way; the
      // switch only covers the analysis layer, so "Not in use" was untrue.
      usage.textContent = on ? "On in Analyze and Scout" : "Off in Analyze and Scout";
      usage.title = on ? "" : "Turn on Maia analysis under Playing strength";
    }
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
          html`<div class="conn-row" data-account-id="${account.id}"><span class="conn-name"><span class="status-pill">Lichess</span><a class="conn-user" href="https://lichess.org/@/${encodeURIComponent(account.username)}" target="_blank" rel="noopener">${account.username}</a>${account.is_primary ? html` <span class="conn-primary">Primary</span>` : ""}</span><span class="conn-actions"><button type="button" class="btn ghost icon sm conn-menu-btn" data-conn-action="menu" aria-label="Account actions for ${account.username}" aria-haspopup="menu" aria-expanded="false">⋯</button><span class="conn-menu" role="menu" popover>${account.is_primary
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
    // A clicked link stays the active marker while its scroll settles: a short
    // page cannot always bring the target to the spy line, so the spy would
    // otherwise hand the marker to a taller neighbour mid-scroll.
    let lockedId = null;
    nav.querySelectorAll(".settings-nav-link").forEach((link) => {
      link.addEventListener("click", (event) => {
        const id = (link.getAttribute("href") || "").slice(1);
        const target = id && document.getElementById(id);
        if (!target) return;
        event.preventDefault();
        markActiveSection(id);
        lockedId = id;
        jumpToSection(target, () => {
          if (lockedId === id) lockedId = null;
        });
      });
    });
    const sections = () =>
      Array.from(document.querySelectorAll("#view-settings .card[id]"));
    // A phone fits five of the six tabs: fade the edge that still has tabs
    // behind it, so a half-drawn label reads as "there is more" and not as a
    // broken word. The attribute is the only thing the stylesheet reads.
    const paintEdges = () => {
      const max = nav.scrollWidth - nav.clientWidth;
      nav.dataset.edge = max <= 1 ? "" : nav.scrollLeft <= 1 ? "end" : nav.scrollLeft >= max - 1 ? "start" : "both";
    };
    paintEdges();
    nav.addEventListener("scroll", paintEdges, { passive: true });
    // The view is display:none until it opens, so the strip has no width yet at
    // bind time; this fires again when it does (and when a resize or a font
    // change alters the tabs' width).
    if (typeof ResizeObserver === "function") new ResizeObserver(paintEdges).observe(nav);
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
        // When the viewport is taller than content, nothing hijacks the click's
        // choice—only scroll events change the marker. Keep the nav synced while
        // scrolling so it matches what the user actually sees.
        if (document.documentElement.scrollHeight - window.innerHeight < window.innerHeight * 0.5) return;
        // The last card whose top passed the probe line - also the right answer
        // when the line sits in the gap between two cards. At the bottom of the
        // page a last card too short to reach the line still counts, once it
        // sits in the upper half of the screen.
        const atEnd = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
        const probe = window.innerHeight * (atEnd ? 0.5 : 0.35);
        // By position, not markup order: the markup groups Board with the
        // personal cards for the two-column page, and one column shows it last.
        let current = list[0]?.id ?? null;
        let lowest = -Infinity;
        for (const section of list) {
          const top = section.getBoundingClientRect().top;
          if (top <= probe && top > lowest) { lowest = top; current = section.id; }
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
    unsubscribers.push(downloads.bind(), subscribeDownloads(renderMaiaAnalysis));

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
      accountsList.addEventListener("click", (event) => {
        const button = event.target.closest("[data-conn-action]");
        const row = event.target.closest("[data-account-id]");
        if (!button || !row) return;
        const accountId = row.dataset.accountId;
        const menu = row.querySelector?.(".conn-menu");
        if (button.dataset.connAction === "menu") {
          if (!menu) return;
          if (isPopoverOpen(menu)) return menu.hidePopover();
          const close = openPopover(menu, { opener: button });
          const anchor = button.getBoundingClientRect();
          const width = menu.offsetWidth;
          menu.style.left = `${Math.max(8, anchor.right - width)}px`;
          menu.style.top = `${anchor.bottom + 4}px`;
          menuKeys(menu, close);
          menu.querySelector(".conn-menu-item")?.focus();
          return;
        }
        if (isPopoverOpen(menu)) menu.hidePopover();
        if (button.dataset.connAction === "primary") {
          setPrimaryAccount(accountId).catch((error) => setStatus(String(error.message || error)));
        } else if (button.dataset.connAction === "unlink") {
          unlinkAccount(accountId).catch((error) => setStatus(String(error.message || error)));
        }
      });
    }
  }

  return {
    bind,
    dispose() { for (const unsubscribe of unsubscribers.splice(0)) unsubscribe(); },
    renderSettings,
    refreshEngineCard,
    renderBrowserEngineStatus,
    renderDownloads: downloads.render,
    renderStrengthControls,
    renderThemeControl,
    renderMaiaAnalysis,
    renderConnections,
    refreshConnections,
    renderAccount: () => accountSection.render(),
    bindSectionNav,
    markActiveSection,
  };
}
