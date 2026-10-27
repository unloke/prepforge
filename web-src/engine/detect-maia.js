// The probe position: one for every round, since speed differs by position.
export const FEN = "r1bq1rk1/ppp2ppp/2np1n2/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 4 6";
// One Analyze chunk of Maia work (16 moves, brilliant-assess ASSESS_CHUNK) on the probe position.
const MAIA_ITEMS = ["a2a3", "a2a4", "b2b3", "b2b4", "g2g3", "h2h3", "h2h4", "c1d2", "c1e3", "c1g5", "d1e2", "f1e1", "a1b1", "g1h1", "c3d5", "f3g5"]
  .map(moveUci => ({ fen: FEN, moveUci }));
// Analyze holds Maia beside the engines; a step Detect keeps must hold both. Maia is
// measured only where Analyze uses it and its model is already here: Detect never
// fetches its 46 MB.
export async function maiaWorkload() {
  const [{ maiaAnalysisEnabled }, maia, { hasCachedWeights }] = await Promise.all([
    import("../core/prefs.js"), import("./maia3-provider.js"), import("./maia3-weight-cache.js")]);
  if (!maiaAnalysisEnabled()) return null;
  const provider = maia.peekSharedMaia3Provider();
  if (provider?.state !== "ready") {
    const m = await maia.loadMaia3Manifest();
    const key = m?.backend_artifact?.wasm || m?.artifacts?.fp16?.file;
    if (!key || !(await hasCachedWeights(key))) return null;
  }
  return () => maia.getSharedMaia3Provider().batch("moveAssessmentMany", { items: MAIA_ITEMS });
}
