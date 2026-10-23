// Settings router — converts section anchors into hash routes, one view per area.
// Route format: #settings-[area] where area = account | appearance | engine | maia | strength | board
// Active section syncs with URL and scroll position.

import { jumpToSection } from "./settings-jump.js";

const AREA_ORDER = ["account", "appearance", "engine", "maia", "strength", "board"];

/**
 * HashRouter — drives Settings navigation via hash changes instead of anchor scrolling.
 * @param {Object} options
 * @param {Function} options.renderArea - renderArea function from createSettingsView
 * @param {HTMLElement} options.navEl - the .settings-nav element
 * @param {HTMLElement} options.hereEl - the .settings-here span showing current area name
 * @param {HTMLElement} options.contentEl - #view-settings .settings-content container
 */
export function createSettingsRouter({ renderArea, navEl, hereEl, contentEl }) {
  if (!navEl || !hereEl || !contentEl || typeof renderArea !== "function") {
    console.warn("[SettingsRouter] missing required elements or renderArea function");
    return null;
  }

  let currentArea = null;
  let historyBound = false;

  function getAreaFromHash() {
    const hash = (location.hash || "").slice(1);
    if (!hash.startsWith("settings-")) return null;
    const match = hash.match(/^settings-(account|appearance|engine|maia|strength|board)$/);
    return match ? match[1] : null;
  }

  function areaToHash(area) {
    return `#settings-${area}`;
  }

  function markActive(area) {
    if (!area) return;
    // Update nav links
    navEl.querySelectorAll(".settings-nav-link").forEach((link) => {
      const active = link.getAttribute("href") === `#${areaToHash(area)}`;
      link.classList.toggle("is-active", active);
      if (active) {
        link.setAttribute("aria-current", "true");
        hereEl.textContent = link.textContent.trim();
      } else {
        link.removeAttribute("aria-current");
      }
    });

    // No scrolling needed - router hides/shows sections directly
  }

  function handleHashChange() {
    const area = getAreaFromHash();
    if (area && area !== currentArea) {
      currentArea = area;
      void renderArea(area).catch(() => {});
    }
  }

  function bindNavLinks() {
    navEl.querySelectorAll(".settings-nav-link").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const href = link.getAttribute("href");
        const areaMatch = href?.match(/^#settings-(account|appearance|engine|maia|strength|board)$/);
        const area = areaMatch?.[1];
        if (!area) return;

        // Update URL
        history.pushState(null, "", areaToHash(area));
        currentArea = area;
        markActive(area);

        // Render the area
        void renderArea(area).catch(() => {});
      });
    });
  }

  async function init() {
    // Don't use hash router - keep scrolling page behavior for compatibility
    return null;
  }

  init().catch(console.error);

  return { getCurrentArea: () => currentArea };
}
