// Floating status pill rules (pure, so they unit-test without a DOM).

// An error pill belongs to the page it happened on. When the user navigates
// away it is dropped — unless it was raised within `graceMs` of the
// navigation, i.e. by the very action that is switching pages.
export function shouldClearStatusOnNavigate(errorAt, now, graceMs) {
  const at = Number(errorAt) || 0;
  if (!at) return true;
  return now - at >= graceMs;
}
