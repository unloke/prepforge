import { Chess } from 'chess.js';

// Fixed fixture scores; legal positions come from the Games row's actual SAN.
function savedReview(game) {
  const chess = new Chess();
  const moves = game.move_san_history.map((san, index) => {
    const before = chess.fen(), move = chess.move(san);
    return { ply: index + 1, move_number: Math.floor(index / 2) + 1,
      side: move.color === 'w' ? 'white' : 'black', san, uci: move.lan,
      fen_before: before, fen_after: chess.fen(), classification: 'good', score_cp: 20 };
  });
  return { game_id: 'saved-games-review', engine: 'fixture', depth: 4, moves,
    summary: { good: moves.length },
    eval_graph: moves.map(({ ply, san, score_cp, classification }) => ({ ply, san, score_cp, bounded_score_cp: score_cp, mate_in: null, classification })),
    position_evals: Object.fromEntries(moves.map(move => [move.fen_after, { engine: 'fixture', depth: 4, score_cp: 20, mate_in: null, pv: [] }])),
  };
}

export async function checkGamesAnalyze(page, games, check, shot) {
  const review = savedReview(games[0]);
  const metadata = { game_id: review.game_id, lichess_id: games[0].lichess_id,
    white: games[0].white, black: games[0].black, result: games[0].result };
  const lookups = [];
  let fullAnalysisRequests = 0;
  page.on('request', request => {
    if (request.url().includes('/api/analyze/prepare')) fullAnalysisRequests++;
  });
  await page.route(/\/api\/analyses(?:\/|\?|$)/, route => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/analyses/${review.game_id}`) {
      return route.fulfill({ json: review });
    }
    const id = url.searchParams.get('lichess_id');
    if (id) lookups.push(id);
    return route.fulfill({ json: { analyses: !id || id === games[0].lichess_id ? [metadata] : [], next_cursor: null } });
  });

  await page.locator('#replay-results .lr[data-index="0"]').evaluate(el => el.click());
  await page.locator('#replay-results .focus [data-act="analyze"]').evaluate(el => el.click());
  await page.waitForFunction(() => document.querySelector('#analysis-moves .mtree-move.is-current')?.textContent.includes('Nf3'), null, { timeout: 5000 }).catch(async error => {
    console.error('[games-analyze] saved-load state', JSON.stringify({ lookups, ui: await page.evaluate(() => ({
      active: document.querySelector('.view.is-active')?.id,
      moves: document.getElementById('analysis-moves')?.innerHTML,
      notices: [...document.querySelectorAll('[role="alert"]')].map(el => el.textContent),
      pgn: document.getElementById('pgn-input')?.value,
    })) }));
    await shot('analyze-failed');
    throw error;
  });
  const loaded = await page.evaluate(() => {
    const graph = document.getElementById('analysis-eval-graph');
    return { visible: !graph.hidden && graph.getBoundingClientRect().height >= 64,
      areas: document.querySelectorAll('#eval-chart .eval-area').length,
      grades: document.querySelectorAll('#analysis-moves .mtree-glyph').length,
      pgn: document.getElementById('pgn-input').value };
  });
  check(loaded.visible && loaded.areas === 2 && loaded.grades === review.moves.length,
    `Games must restore the saved chart and classifications: ${JSON.stringify(loaded)}`);
  check(loaded.pgn.includes(`https://lichess.org/${games[0].lichess_id}`), 'the recalled PGN must retain its Lichess identity');
  check(fullAnalysisRequests === 0, 'opening a saved review must not rerun whole-game analysis');
  await shot('analyze-saved');

  await page.evaluate(() => document.querySelector('[data-testid="nav-replay"]').click());
  await page.locator('#replay-summary [data-filter="user-error"]').click();
  await page.locator('#replay-results .lr[data-index="1"]').evaluate(el => el.click());
  await page.locator('#replay-results .focus [data-act="analyze"]').evaluate(el => el.click());
  await page.waitForFunction(() => document.querySelector('#analysis-moves .mtree-move.is-current')?.textContent.includes('d4'));
  check(await page.locator('#eval-chart .eval-area').count() === 0, 'a never-analysed game must not retain the previous game\'s chart');
  check(await page.locator('#analysis-moves .mtree-glyph').count() === 0, 'a never-analysed game must not retain previous classifications');
  check(lookups.join(',') === `${games[0].lichess_id},${games[1].lichess_id}`, `each Games action must look up its own game: ${lookups}`);
  await shot('analyze-new');
}
