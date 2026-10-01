// Left rail behaviour that is independent of the app state.
//
// The rail expands as a hover overlay (CSS `.rail:hover`) on top of the board.
// After a pointer click on a page destination it should get out of the way
// immediately, not stay open until the pointer happens to leave. The class
// `is-nav-collapsed` suppresses the hover expansion until the pointer leaves
// the rail; keyboard activation (event.detail === 0) keeps the rail open so a
// Tab user does not lose their place.

export const RAIL_COLLAPSED_CLASS = "is-nav-collapsed";

export function bindRailCollapseOnNavigate(rail) {
  if (!rail) return () => {};
  const onClick = (event) => {
    if (event.detail === 0) return;
    const target = event.target;
    const destination = target && typeof target.closest === "function" ? target.closest(".tab[data-view]") : null;
    if (!destination) return;
    rail.classList.add(RAIL_COLLAPSED_CLASS);
  };
  const onLeave = () => rail.classList.remove(RAIL_COLLAPSED_CLASS);
  rail.addEventListener("click", onClick);
  rail.addEventListener("pointerleave", onLeave);
  return () => {
    rail.removeEventListener("click", onClick);
    rail.removeEventListener("pointerleave", onLeave);
  };
}
