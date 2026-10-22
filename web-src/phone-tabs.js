// Phone bottom bar: the tab labelled Games is lit on Games only; More is lit
// for the destinations its sheet carries (Scout, Teams, Settings), so the bar
// never names a page the user is not on.
export function paintPhoneTabs(view, section) {
  const mark = (button, active) => {
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  };
  document.querySelectorAll("[data-review-tab]").forEach((button) => mark(button, view === "replay" && section !== "scout"));
  const moreBtn = document.getElementById("more-nav-btn");
  if (moreBtn) mark(moreBtn, ["teams", "settings"].includes(view) || (view === "replay" && section === "scout"));
}
