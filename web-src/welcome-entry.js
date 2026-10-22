// A first visit gets the welcome once; welcome.js decides and loads only then.
export function maybeWelcome(deps) {
  try { if (localStorage.getItem("prepforge.welcome")) return; } catch { return; }
  void import("./welcome.js").then((welcome) => welcome.maybeWelcome(deps)).catch(() => {});
}
