// Settings areas: one view per area, reached by the app's own route
// (#/settings/engine; the workspace codec reads the view and ignores the rest).
// The nav link, the view's title and the hash name the same area. The app
// rewrites the hash to #/settings on a view switch, so the last area is kept in
// memory and the hash wins only when it names one.

export const SETTINGS_AREAS = ["account", "appearance", "board", "engine"];

/**
 * @param {Object} options
 * @param {(area: string) => void} options.showArea - shows the area's cards and hides the rest
 * @param {HTMLElement} options.navEl - the .settings-nav element
 * @param {HTMLElement} options.titleEl - the view's title; it takes the area's name
 */
export function createSettingsRouter({ showArea, navEl, titleEl }) {
  let current = "account";
  const areaFromHash = () => {
    const area = location.hash.match(/^#\/settings\/(\w+)$/)?.[1];
    return SETTINGS_AREAS.includes(area) ? area : null;
  };

  function show(area) {
    current = area;
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

  return {
    open: () => show(areaFromHash() || current),
    // Back and forward (the view wires this to the window; pushState does not fire hashchange).
    hashChanged: () => {
      const area = areaFromHash();
      if (area) show(area);
    },
  };
}
