// Whole-game Stockfish throughput benchmark, run in headless Chromium against a
// running Vite dev server (COOP/COEP on). Compares the analyzer's provider
// strategies on the same positions so a shared-analysis change can be measured:
//
//   node scripts/bench/game-analysis-throughput.mjs [baseUrl] [modes] [depth] [runs]
//   e.g. node scripts/bench/game-analysis-throughput.mjs http://localhost:5180/static/ direct,store 16 3
//
// Modes: "direct" = one dedicated provider per analyzer lane (createEngineProvider),
// "store" = the per-position analysis store's game-analysis path, "legacy-shared" =
// a lane per evaluation-source handle (the pre-store regression; only present while
// engine/evaluation-source.js exists).
import { chromium } from "playwright";

const baseUrl = process.argv[2] || "http://localhost:5180/static/";
const modes = (process.argv[3] || "direct,store").split(",");
const depth = Number(process.argv[4] || 16);
const runs = Number(process.argv[5] || 2);

const PGN = "1. d4 e6 2. e4 d5 3. Nc3 c5 4. Nf3 Nc6 5. exd5 exd5 6. Be2 Nf6 7. O-O Be7 8. Bg5 O-O 9. dxc5 Be6 10. Nd4 Bxc5 11. Nxe6 fxe6 12. Bg4 Qd6 13. Bh3 Rae8 14. Qd2 Bb4 15. Bxf6 Rxf6 16. Rad1 Qc5 17. Qe2 Bxc3 18. bxc3 Qxc3 19. Rxd5 Nd4 20. Qh5 Ref8 21. Re5 Rh6 22. Qg5 Rxh3 23. Rc5 Qg3 24. Qxg3 Ne2+ 25. Kh1 Nxg3+ 26. Kg1 Ne2+ 27. Kh1 Rc3 0-1";

let browser;
for (const channel of ["msedge", "chrome", undefined]) {
  try {
    browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    break;
  } catch { /* try the next channel */ }
}
if (!browser) throw new Error("no Chromium-based browser is available");
try {
  const page = await browser.newPage();
  // Count engine worker spawns: a per-position worker is the regression signature.
  await page.addInitScript(() => {
    const Native = globalThis.Worker;
    globalThis.__engineWorkers = 0;
    globalThis.Worker = class extends Native {
      constructor(url, opts) { super(url, opts); if (String(url).includes("stockfish")) globalThis.__engineWorkers += 1; }
    };
  });
  await page.goto(new URL("engine/stockfish.manifest.json", baseUrl).href);
  const results = [];
  for (let run = 0; run < runs; run += 1) {
    for (const mode of modes) {
      const out = await page.evaluate(async ({ mode, depth, pgn, base }) => {
        const url = (p) => new URL(p, base).href;
        const { parsePgn } = await import(url("analyze-pgn.js"));
        const parsed = parsePgn(pgn);
        const fens = [];
        let node = parsed.root.children[0];
        fens.push(node.fenBefore);
        while (node) { fens.push(node.fenAfter); node = node.children && node.children[0]; }
        const ga = await import(url("engine/game-analyzer.js"));
        const sp = await import(url("engine/stockfish-provider.js"));
        let run;
        if (mode === "direct") {
          run = () => ga.analyzeGamePositions({ positions: fens, depth, multipv: 1, createProvider: sp.createEngineProvider });
        } else if (mode === "store") {
          const { createPositionAnalysisStore } = await import(url("engine/position-analysis-store.js"));
          const store = createPositionAnalysisStore();
          run = () => store.analyzeGame({ positions: fens, depth });
        } else if (mode === "legacy-shared") {
          const es = await import(url("engine/evaluation-source.js"));
          const source = es.createEvaluationSource();
          run = () => ga.analyzeGamePositions({ positions: fens, depth, multipv: 1, createProvider: (o) => source.createHandle(o) });
        } else throw new Error(`unknown mode ${mode}`);
        const workersBefore = globalThis.__engineWorkers;
        const t0 = performance.now();
        const result = await run();
        const ms = Math.round(performance.now() - t0);
        const workerScripts = globalThis.__engineWorkers - workersBefore;
        const depths = [...result.values()].map((v) => v.depth || 0);
        return { mode, ms, positions: result.size, minDepth: Math.min(...depths), workerScripts };
      }, { mode, depth, pgn: PGN, base: baseUrl });
      results.push({ run, ...out });
      console.log(JSON.stringify({ run, ...out }));
      await page.reload();
    }
  }
} finally {
  await browser.close();
}
