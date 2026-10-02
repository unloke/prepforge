// Maia single vs batched positionRead throughput in headless Chromium against a
// running Vite dev server:  node scripts/bench/maia-batch.mjs [baseUrl] [positions]
import { chromium } from "playwright";

const baseUrl = process.argv[2] || "http://localhost:5180/static/";
const count = Number(process.argv[3] || 48);
const PGN = "1. d4 e6 2. e4 d5 3. Nc3 c5 4. Nf3 Nc6 5. exd5 exd5 6. Be2 Nf6 7. O-O Be7 8. Bg5 O-O 9. dxc5 Be6 10. Nd4 Bxc5 11. Nxe6 fxe6 12. Bg4 Qd6 13. Bh3 Rae8 14. Qd2 Bb4 15. Bxf6 Rxf6 16. Rad1 Qc5 17. Qe2 Bxc3 18. bxc3 Qxc3 19. Rxd5 Nd4 20. Qh5 Ref8 21. Re5 Rh6 22. Qg5 Rxh3 23. Rc5 Qg3 24. Qxg3 Ne2+ 25. Kh1 Nxg3+ 26. Kg1 Ne2+ 27. Kh1 Rc3 0-1";

let browser;
for (const channel of ["msedge", "chrome", undefined]) {
  try { browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); break; } catch { /* next */ }
}
try {
  const page = await browser.newPage();
  await page.goto(new URL("engine/stockfish.manifest.json", baseUrl).href);
  const out = await page.evaluate(async ({ base, pgn, count }) => {
    const url = (p) => new URL(p, base).href;
    const { parsePgn } = await import(url("analyze-pgn.js"));
    const { createMaia3Provider } = await import(url("engine/maia3-provider.js"));
    const parsed = parsePgn(pgn);
    const fens = [];
    let node = parsed.root.children[0];
    while (node) { fens.push(node.fenBefore); node = node.children && node.children[0]; }
    const list = fens.slice(0, count);
    const fresh = () => createMaia3Provider({ readCacheCap: 0 });
    const p1 = fresh();
    await p1.warmup();
    await p1.positionRead({ fen: list[0], rating: 1500 });
    let t = performance.now();
    for (const fen of list) await p1.positionRead({ fen, rating: 1501 });
    const single = Math.round(performance.now() - t);
    t = performance.now();
    for (let i = 0; i < list.length; i += 16) await p1.batch("positionReadBatch", { fens: list.slice(i, i + 16), rating: 1502 });
    const batched = Math.round(performance.now() - t);
    // Same answers either way.
    const a = await p1.positionRead({ fen: list[5], rating: 1503 });
    const [b] = await p1.batch("positionReadBatch", { fens: [list[5], list[6]], rating: 1504 });
    const same = a.predictions[0].move_uci === b.predictions[0].move_uci && a.wdl.win === b.wdl.win;
    p1.terminate();
    return { positions: list.length, singleMs: single, batchedMs: batched, same };
  }, { base: baseUrl, pgn: PGN, count });
  console.log(JSON.stringify(out));
} finally {
  await browser.close();
}
