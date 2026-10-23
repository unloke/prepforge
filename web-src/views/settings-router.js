// Settings areas: one view per area, reached by a hash route (#settings-engine).
// The nav link, the view's title and the hash name the same area.

export const SETTINGS_AREAS = ["account", "appearance", "board", "engine"];

/**
 * @param {Object} options
 * @param {(area: string) => void} options.showArea - shows the area's cards and hides the rest
 * @param {HTMLElement} options.navEl - the .settings-nav element
 * @param {HTMLElement} options.titleEl - the view's title; it takes the area's name
 */
export function createSettingsRouter({ showArea, navEl, titleEl }) {
  const areaFromHash = () => {
    const area = location.hash.match(/^#settings-(\w+)$/)?.[1];
    return SETTINGS_AREAS.includes(area) ? area : "account";
  };

  function show(area) {
    navEl.querySelectorAll(".settings-nav-link").forEach((link) => {
      const active = link.dataset.area === area;
      link.classList.toggle("is-active", active);
      if (!active) return link.removeAttribute("aria-current");
      link.setAttribute("aria-current", "true");
      titleEl.textContent = link.textContent.trim();
    });
    showArea(area);
  }

  navEl.addEventListener("click", (event) => {
    const link = event.target.closest(".settings-nav-link");
    if (!link) return;
    event.preventDefault();
    history.pushState(null, "", link.getAttribute("href"));
    show(link.dataset.area);
  });
  // Back and forward move between areas (the view wires this to the window;
  // pushState does not fire hashchange).
  return { open: () => show(areaFromHash()), hashChanged: () => show(areaFromHash()) };
}
