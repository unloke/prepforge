// What a Detect step must hold before it is kept: the engines it measured, plus the
// rest of the page's normal peak (Maia, and a margin for the page itself).
// The probe position: one for every round, since speed differs by position.
export const FEN = "r1bq1rk1/ppp2ppp/2np1n2/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 4 6";
// One Analyze chunk of Maia work (16 moves, brilliant-assess ASSESS_CHUNK) on the probe position.
const MAIA_ITEMS = ["a2a3", "a2a4", "b2b3", "b2b4", "g2g3", "h2h3", "h2h4", "c1d2", "c1e3", "c1g5", "d1e2", "f1e1", "a1b1", "g1h1", "c3d5", "f3g5"]
  .map(moveUci => ({ fen: FEN, moveUci }));
// The page can hold Maia beside the engines (Analyze, the Coach, Train's bot, Build), so
// a step Detect keeps must hold both. Maia is measured wherever its model is already
// here, whatever the analysis setting: Detect never fetches its 46 MB.
export async function maiaWorkload() {
  const [maia, { hasCachedWeights }] = await Promise.all([import("./maia3-provider.js"), import("./maia3-weight-cache.js")]);
  const provider = maia.peekSharedMaia3Provider();
  if (provider?.state !== "ready") {
    const m = await maia.loadMaia3Manifest();
    const key = m?.backend_artifact?.wasm || m?.artifacts?.fp16?.file;
    if (!key || !(await hasCachedWeights(key))) return null;
  }
  return () => maia.getSharedMaia3Provider().batch("moveAssessmentMany", { items: MAIA_ITEMS });
}

// Headroom over the measured engines and Maia: the page's own growth in normal use (the
// Analyze board, charts and stores). Touched, not only reserved: an OS counts the pages a
// tab writes, so this is what kills a tab that would run too close to its limit.
export const HEADROOM_MB = 256;
export function holdHeadroom(mb = HEADROOM_MB) {
  const block = new Uint8Array(mb * 1048576);
  for (let i = 0; i < block.length; i += 4096) block[i] = 1;
  return block.length;
}
