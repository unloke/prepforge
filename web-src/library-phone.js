import { openOverflowMenu } from "./core/overflow-menu.js";

// Library's phone head, the Lichess study list's shape: the list starts under
// one row of filters. The + opens an action sheet (New repertoire, Import PGN)
// and the magnifier opens the filter field in place, focused; Cancel clears the
// query and folds it away. The desktop card head keeps its own buttons, which
// these click.
export function wireLibraryPhoneHead() {
  const lib = document.querySelector("#view-dashboard .lib");
  const add = document.getElementById("library-add");
  const menu = document.getElementById("library-add-menu");
  const toggle = document.getElementById("library-search-toggle");
  const input = document.getElementById("lib-filter-search");
  const cancel = document.getElementById("lib-search-cancel");
  if (!lib || !add || !menu || !toggle || !input || !cancel) return;

  add.addEventListener("click", (event) => {
    openOverflowMenu(menu, {
      event,
      title: "Library",
      items: [{ action: "dashboard-new-rep", label: "New repertoire" }, { action: "dashboard-import-pgn", label: "Import PGN" }],
      onPick: (action) => {
        menu.hidePopover?.();
        document.getElementById(action)?.click();
      },
    });
  });

  const setOpen = (open) => {
    lib.toggleAttribute("data-search-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    if (open) input.focus();
  };
  const close = () => {
    if (input.value) {
      input.value = "";
      input.dispatchEvent(new Event("input"));
    }
    setOpen(false);
    toggle.focus();
  };
  toggle.addEventListener("click", () => (lib.hasAttribute("data-search-open") ? close() : setOpen(true)));
  cancel.addEventListener("click", close);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && lib.hasAttribute("data-search-open")) close();
  });
}
