import { afterEach, describe, expect, it, vi } from 'vitest';
import { appSource } from './test-app-source.js';
import { playSessionPgn } from './train-play.js';
import * as history from './train-history.js';
import { openTrainingHistory } from './views/train-history.js';
import { asSlices } from "./state/as-slices.fixture.js";

const modal = vi.hoisted(() => ({ overlay: null, close: null }));
vi.mock('./core/dialog.js', () => ({
  modalDialog: () => modal.overlay,
  openModal: () => modal.close,
}));
const source = appSource();
function compile(marker, deps) {
  const start = source.indexOf(marker);
  const end = source.indexOf('\n}\n', start) + 2;
  return new Function(...Object.keys(deps), `return (${source.slice(start, end)});`)(...Object.values(deps));
}
const saved = {
  id: 'practice', mode: 'play', blitz: false, result: 'Resigned', repertoires: [],
  finishedAt: '2026-11-20T12:00:00Z', cards: 1, correct: 0, mistakes: 0, skipped: 0,
  pgn: '[Event "Practice game"]\n\n1. e4 e5 0-1', userColor: 'black',
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('saved Practice games', () => {
  it.each([undefined, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 11'])(
    'retains the completed game PGN, starting position and orientation (%s)', startFen => {
      const storage = { data: new Map(), getItem(k) { return this.data.get(k); }, setItem(k, v) { this.data.set(k, v); } };
      const play = { startedAt: Date.parse(saved.finishedAt), startFen, userColor: 'black', book: 'maia', rating: 1500,
        result: '1-0', history: [{ san: startFen ? 'e5' : 'e4', by: 'user' }] };
      const deps = { ...asSlices({ play, lichessUsername: 'Alice' }), boards: { train: { setPremove: vi.fn() } },
        updateTrainTurnBadge: vi.fn(), currentOwnerId: () => 'alice', playResult: () => ({}), showTrainResult: vi.fn(),
        playSessionPgn, saveRun: (owner, run) => history.saveRun(owner, run, storage) };
      compile('function endPlayGame(', deps)('Resigned');
      history.saveRun('alice', { ...saved, id: 'later', mode: 'smart', finishedAt: '2027-01-01T00:00:00Z' }, storage);
      const run = history.readTrainingHistory('alice', storage)[1];
      expect(run.pgn).toBe(playSessionPgn(play, 'Alice'));
      expect(run.pgn).toContain(startFen ? '[FEN "' + startFen + '"]' : '1. e4');
      expect(run.userColor).toBe('black');
      expect(history.readTrainingHistory('bob', storage)).toEqual([]);
    });

  function analyzeHarness() {
    const input = {}, drawer = { open: true };
    const deps = { ...asSlices({ play: null, ownerGeneration: 1 }), currentOwnerId: () => 'alice', analysisRecallSeq: 3,
      invalidateAnalysisSource: () => 3, document: { getElementById: id => id === 'pgn-input' ? input : drawer },
      switchView: vi.fn(), boards: { analysis: { setOrientation: vi.fn() } }, playSessionPgn,
      loadPgnIntoAnalyze: vi.fn(async () => true), setStatus: vi.fn(), setStatusError: vi.fn(), runAnalysis: vi.fn() };
    return { deps, input, drawer, open: compile('async function openPlayInAnalyze(', deps) };
  }
  it('opens an older saved game without relying on the current Practice session', async () => {
    const h = analyzeHarness();
    await h.open(saved);
    expect(h.input.value).toBe(saved.pgn);
    expect(h.drawer.open).toBe(false);
    expect(h.deps.switchView).toHaveBeenCalledWith('analyze');
    expect(h.deps.boards.analysis.setOrientation).toHaveBeenCalledWith('black');
    expect(h.deps.loadPgnIntoAnalyze).toHaveBeenCalledWith(saved.pgn, { goToEnd: false, quiet: true, sourceSeq: 3 });
    expect(h.deps.runAnalysis).toHaveBeenCalledOnce();
  });
  it('ignores an empty game and reports a failed PGN load without running analysis', async () => {
    const h = analyzeHarness();
    await h.open({});
    expect(h.deps.switchView).not.toHaveBeenCalled();
    h.deps.loadPgnIntoAnalyze.mockResolvedValue(false);
    await h.open(saved);
    expect(h.deps.setStatusError).toHaveBeenCalledWith('Could not load this Practice game. Try Analyze game again.');
    expect(h.deps.runAnalysis).not.toHaveBeenCalled();
    h.deps.loadPgnIntoAnalyze.mockRejectedValue(new Error('Invalid PGN'));
    await h.open(saved);
    expect(h.deps.setStatusError).toHaveBeenLastCalledWith('Invalid PGN');
  });
});

describe('Training history buttons', () => {
  function render(runs) {
    const buttons = [];
    modal.overlay = {
      markup: '', get innerHTML() { return this.markup; }, set innerHTML(value) { this.markup = String(value); },
      setAttribute: vi.fn(),
      querySelector: () => ({ addEventListener: vi.fn() }),
      querySelectorAll: () => {
        for (const match of modal.overlay.innerHTML.matchAll(/data-open-practice="([^"]+)"/g)) {
          const button = { dataset: { openPractice: match[1] }, addEventListener: (_event, cb) => { button.click = cb; } };
          buttons.push(button);
        }
        return buttons;
      },
    };
    modal.close = vi.fn();
    vi.stubGlobal('document', { activeElement: null, getElementById: () => null, body: { append: vi.fn() } });
    vi.spyOn(history, 'readTrainingHistory').mockReturnValue(runs);
    const open = vi.fn();
    openTrainingHistory('alice', open);
    return { open, buttons, html: modal.overlay.innerHTML };
  }
  it('renders only saved Practice games as native buttons and opens the selected game', () => {
    const h = render([{ ...saved, id: 'latest', mode: 'smart' }, saved,
      { ...saved, id: 'due', mode: 'smart' }, { ...saved, id: 'rehearse', mode: 'all_lines' },
      { ...saved, id: 'missing', pgn: undefined }, { ...saved, id: 'blank', pgn: ' ' }, { ...saved, id: 'invalid', pgn: {} }]);
    expect(h.buttons).toHaveLength(1);
    expect(h.html).toContain('<button type="button" class="th-run th-open"');
    h.buttons[0].click();
    expect(modal.close).toHaveBeenCalledOnce();
    expect(h.open).toHaveBeenCalledWith(saved);
  });
  it('renders the empty history without game buttons', () => {
    const h = render([]);
    expect(h.buttons).toHaveLength(0);
    expect(h.html).toContain('No runs saved yet');
    expect(h.open).not.toHaveBeenCalled();
  });
});
