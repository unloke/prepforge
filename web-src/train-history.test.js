import { describe, expect, it } from 'vitest';
import { HISTORY_LIMITS, readTrainingHistory, recentRuns, runSummary, saveRun, saveSmartRun } from './train-history.js';

class Storage {
  data = new Map();
  failWrites = false;
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.data.set(key, value);
  }
}
const run = (generation = '2026-10-21T12:00:00Z') => ({ sessionId: 'same-session-id', generation,
  repertoireName: 'London', queue: [{ repertoire_name: 'London' }, { repertoire_name: 'Caro-Kann' }],
  cardIndex: 2, cardsDone: 1, blitz: false });
const stats = { correct: 3, mistakes: 1, skipped: 1 };
const finished = new Date('2026-10-21T12:05:00Z');
const KEY = 'pf.trainHistory:alice';
const encoder = new TextEncoder();
const storedValue = (storage, owner = 'alice') => storage.getItem(`pf.trainHistory:${owner}`);
const bytesOf = text => encoder.encode(text).length;
// The document as it is actually stored: the one measure the cap is about.
const storedBytes = (storage, owner = 'alice') => bytesOf(storedValue(storage, owner));
const storedRuns = (storage, owner = 'alice') => JSON.parse(storedValue(storage, owner)).runs;
const longQueue = count => ({ ...run(), queue: Array.from({ length: count }, (_, index) => ({ repertoire_name: `Repertoire ${index} ${'x'.repeat(120)}` })) });

describe('local opening training history', () => {
  it('keeps completed generations after the server reuses its session ID', () => {
    const storage = new Storage();
    expect(saveSmartRun('alice', run(), stats, storage, finished)).toBe(true);
    expect(saveSmartRun('alice', run('2026-10-22T12:00:00Z'), { ...stats, mistakes: 0 }, storage, new Date('2026-10-22T12:05:00Z'))).toBe(true);
    const rows = readTrainingHistory('alice', storage);
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.mistakes)).toEqual([0, 1]);
    // Cards served: the completed one plus the skipped one.
    expect(rows[1]).toMatchObject({ repertoires: ['London', 'Caro-Kann'], cards: 2, correct: 3, mistakes: 1, skipped: 1 });
  });
  it('records a completion once even if rendering or sync retries it', () => {
    const storage = new Storage();
    saveSmartRun('alice', run(), stats, storage, finished);
    saveSmartRun('alice', run(), { ...stats, correct: 99 }, storage, new Date('2026-10-22T12:05:00Z'));
    expect(readTrainingHistory('alice', storage)).toHaveLength(1);
    expect(readTrainingHistory('alice', storage)[0].correct).toBe(3);
    expect(readTrainingHistory('alice', storage)[0].finishedAt).toBe(finished.toISOString());
  });
  it('keeps one document per account, so a repeated completion rewrites nothing else', () => {
    const storage = new Storage();
    saveSmartRun('alice', run(), stats, storage, finished);
    expect(storage.length).toBe(1);
    saveSmartRun('alice', run('2026-10-22T12:00:00Z'), stats, storage, finished);
    expect(storage.length).toBe(1);
    expect(readTrainingHistory('alice', storage)).toHaveLength(2);
  });
  it('isolates owners and does not retain unfinished or guest sessions', () => {
    const storage = new Storage();
    saveSmartRun('alice', run(), stats, storage, finished);
    expect(readTrainingHistory('bob', storage)).toEqual([]);
    expect(readTrainingHistory('alice.team', storage)).toEqual([]);
    saveSmartRun('alice.team', run(), stats, storage, finished);
    expect(readTrainingHistory('alice', storage)).toHaveLength(1);
    expect(readTrainingHistory(null, storage)).toEqual([]);
    expect(saveSmartRun(null, run(), stats, storage)).toBe(false);
    expect(saveSmartRun('bob', { ...run(), cardIndex: 1 }, stats, storage)).toBe(false);
    expect(saveSmartRun('bob', { ...run(), cardIndex: undefined }, stats, storage)).toBe(false);
    expect(storage.length).toBe(2);
    expect(storage.getItem('pf.trainHistory:bob')).toBeNull();
  });
  it('preserves Blitz and skipped-only results without fabricating accuracy', () => {
    const storage = new Storage();
    saveSmartRun('alice', { ...run(), blitz: true, cardsDone: 0 }, { correct: 0, mistakes: 0, skipped: 2 }, storage, finished);
    // Blitz is a flavour of the Due queue, not a mode; skipped cards were served.
    expect(readTrainingHistory('alice', storage)[0]).toMatchObject({ mode: 'smart', blitz: true, cards: 2, correct: 0, mistakes: 0, skipped: 2 });
    expect(runSummary(readTrainingHistory('alice', storage)[0])).toBe('2 cards');
  });
  it(`keeps the newest ${HISTORY_LIMITS.runs} runs by finish time and drops the oldest`, () => {
    const storage = new Storage();
    const total = HISTORY_LIMITS.runs + 12;
    for (let index = 0; index < total; index++) {
      const day = new Date(Date.UTC(2026, 0, 1) + index * 86400000);
      saveSmartRun('alice', run(day.toISOString()), stats, storage, new Date(day.getTime() + 60000));
    }
    const rows = readTrainingHistory('alice', storage);
    expect(rows).toHaveLength(HISTORY_LIMITS.runs);
    expect(rows[0].finishedAt).toBe(new Date(Date.UTC(2026, 0, total) + 60000).toISOString());
    expect(rows.at(-1).finishedAt).toBe(new Date(Date.UTC(2026, 0, total - HISTORY_LIMITS.runs + 1) + 60000).toISOString());
  });
  it('keeps the newest runs inside the byte budget and stores exactly that document', () => {
    const storage = new Storage();
    const longNames = Array.from({ length: 12 }, (_, index) => `A long repertoire name ${index} with extra words ${'x'.repeat(160)}`);
    const save = index => saveSmartRun('alice', { ...run(new Date(Date.UTC(2026, 0, 1) + index * 60000).toISOString()),
      queue: longNames.map(name => ({ repertoire_name: name })), cardIndex: longNames.length }, stats, storage,
    new Date(Date.UTC(2026, 0, 1) + index * 60000 + 30000));
    for (let index = 0; index < 60; index++) save(index);
    const rows = readTrainingHistory('alice', storage);
    expect(storedBytes(storage)).toBeLessThanOrEqual(HISTORY_LIMITS.bytes);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.length).toBeLessThan(60);
    expect(storedRuns(storage)).toHaveLength(rows.length);
    expect(rows[0].finishedAt).toBe(new Date(Date.UTC(2026, 0, 1) + 59 * 60000 + 30000).toISOString());
    expect(rows.at(-1).finishedAt).toBe(new Date(Date.UTC(2026, 0, 1) + (60 - rows.length) * 60000 + 30000).toISOString());
  });
  it('counts the cap in UTF-8 bytes of the stored value, wrapper and commas included', () => {
    const storage = new Storage();
    // CJK costs three UTF-8 bytes per character: a document that is 120,000
    // bytes is only 40,000 characters, so a character or UTF-16 count would
    // wave it through.
    const oversized = '開局準備'.repeat(10000);
    saveSmartRun('alice', { ...run(), queue: [{ repertoire_name: oversized }] }, stats, storage, finished);
    expect(storedValue(storage)).toBeNull();
    expect(saveSmartRun('alice', run(), stats, storage, finished)).toBe(true);
    const name = '開局準備'.repeat(80);
    saveSmartRun('alice', { ...run('2026-10-22T12:00:00Z'), queue: [{ repertoire_name: name }] }, stats, storage,
      new Date('2026-10-22T12:05:00Z'));
    const stored = storedRuns(storage);
    const wrapper = bytesOf('{"v":1,"runs":[]}');
    const expected = wrapper + stored.reduce((sum, entry) => sum + bytesOf(JSON.stringify(entry)), 0) + (stored.length - 1);
    // Three-byte characters at three bytes per UTF-16 unit: any count of
    // characters or code units would understate this record.
    const first = JSON.stringify(stored[0]);
    expect(bytesOf(first) / first.length).toBeGreaterThan(2);
    expect(storedBytes(storage)).toBe(expected);
    expect(storedBytes(storage)).toBeLessThan(HISTORY_LIMITS.bytes);
  });
  it('rejects a run that cannot fit and leaves the stored history byte for byte unchanged', () => {
    const storage = new Storage();
    expect(saveSmartRun('alice', run(), stats, storage, finished)).toBe(true);
    const before = storedValue(storage);
    const huge = longQueue(900);
    const attempted = saveSmartRun('alice', { ...huge, generation: '2026-10-23T12:00:00Z' }, stats, storage,
      new Date('2026-10-23T12:05:00Z'));
    expect(attempted).toBe(false);
    expect(storedValue(storage)).toBe(before);
    expect(readTrainingHistory('alice', storage)).toHaveLength(1);
    expect(readTrainingHistory('alice', storage)[0].finishedAt).toBe(finished.toISOString());
    // The history is not wedged either: the next run that fits is still saved.
    expect(saveSmartRun('alice', run('2026-10-24T12:00:00Z'), stats, storage, new Date('2026-10-24T12:05:00Z'))).toBe(true);
    expect(readTrainingHistory('alice', storage)).toHaveLength(2);
  });
  it('refuses a stored document over the byte cap instead of parsing it', () => {
    const storage = new Storage();
    const entry = JSON.stringify({ id: 's:g', mode: 'smart', blitz: false, repertoires: ['開局準備'.repeat(4500)],
      startedAt: '2026-10-21T12:00:00Z', finishedAt: '2026-10-21T12:05:00.000Z', cards: 4, correct: 3, mistakes: 1, skipped: 0 });
    // Two runs only, so the count cap is nowhere near: the size alone rejects it.
    storage.setItem(KEY, `{"v":1,"runs":[${entry},${entry}]}`);
    expect(bytesOf(storedValue(storage))).toBeGreaterThan(HISTORY_LIMITS.bytes);
    expect(readTrainingHistory('alice', storage)).toEqual([]);
    // One record of the same shape is inside the bound and still reads.
    storage.setItem(KEY, `{"v":1,"runs":[${entry}]}`);
    expect(bytesOf(storedValue(storage))).toBeLessThanOrEqual(HISTORY_LIMITS.bytes);
    expect(readTrainingHistory('alice', storage)).toHaveLength(1);
  });
  it('drops a run whose clock is behind a full list and reports that it was not kept', () => {
    const storage = new Storage();
    for (let index = 0; index < HISTORY_LIMITS.runs; index++) {
      const day = new Date(Date.UTC(2026, 0, 1) + index * 86400000);
      saveSmartRun('alice', run(day.toISOString()), stats, storage, new Date(day.getTime() + 60000));
    }
    const before = storedValue(storage);
    const backdated = saveSmartRun('alice', run('2025-06-01T00:00:00Z'), stats, storage, new Date('2025-06-01T00:05:00Z'));
    expect(backdated).toBe(false);
    expect(storedValue(storage)).toBe(before);
    // The list still ends on its real oldest day, not on the run that arrived late.
    expect(readTrainingHistory('alice', storage).at(-1).finishedAt).toBe(new Date(Date.UTC(2026, 0, 1) + 60000).toISOString());
  });
  it('files a backdated run by its finish time when there is room', () => {
    const storage = new Storage();
    saveSmartRun('alice', run('2026-03-01T12:00:00Z'), stats, storage, new Date('2026-03-01T12:05:00Z'));
    saveSmartRun('alice', run('2026-05-01T12:00:00Z'), stats, storage, new Date('2026-05-01T12:05:00Z'));
    expect(saveSmartRun('alice', run('2026-04-01T12:00:00Z'), stats, storage, new Date('2026-04-01T12:05:00Z'))).toBe(true);
    const rows = readTrainingHistory('alice', storage);
    expect(rows.map(row => row.finishedAt)).toEqual([
      new Date('2026-05-01T12:05:00Z').toISOString(),
      new Date('2026-04-01T12:05:00Z').toISOString(),
      new Date('2026-03-01T12:05:00Z').toISOString(),
    ]);
    expect(storedRuns(storage).map(row => row.finishedAt)).toEqual(rows.map(row => row.finishedAt));
  });
  it('never touches another view or account\'s storage', () => {
    const storage = new Storage();
    storage.setItem('pf.trainSessionMemo.alice.session.start', JSON.stringify({ keep: true }));
    storage.setItem('pf.prefs', JSON.stringify({ theme: 'dark' }));
    storage.setItem('pf.trainHistory:bob', JSON.stringify({ v: 1, runs: [] }));
    saveSmartRun('alice', run(), stats, storage, finished);
    expect(JSON.parse(storage.getItem('pf.trainSessionMemo.alice.session.start'))).toEqual({ keep: true });
    expect(JSON.parse(storage.getItem('pf.prefs'))).toEqual({ theme: 'dark' });
    expect(JSON.parse(storage.getItem('pf.trainHistory:bob'))).toEqual({ v: 1, runs: [] });
    expect(readTrainingHistory('alice', storage)).toHaveLength(1);
  });
  it('reads nothing from a document it does not understand', () => {
    const storage = new Storage();
    storage.setItem(KEY, JSON.stringify({ v: 1, runs: [{ id: 'broken' }, null, 'nope'] }));
    expect(readTrainingHistory('alice', storage)).toEqual([]);
    storage.setItem(KEY, 'not json');
    expect(readTrainingHistory('alice', storage)).toEqual([]);
    storage.setItem(KEY, JSON.stringify({ v: 2, runs: [] }));
    expect(readTrainingHistory('alice', storage)).toEqual([]);
  });
  it('keeps a storage failure from breaking training completion', () => {
    expect(saveSmartRun('alice', run(), stats, { getItem() { throw new Error('Denied'); } })).toBe(false);
    expect(saveSmartRun('alice', run(), stats, null)).toBe(false);
    const storage = new Storage();
    saveSmartRun('alice', run(), stats, storage, finished);
    const before = storedValue(storage);
    storage.failWrites = true;
    expect(saveSmartRun('alice', run('2026-10-22T12:00:00Z'), stats, storage, new Date('2026-10-22T12:05:00Z'))).toBe(false);
    expect(storedValue(storage)).toBe(before);
    // Reading is a separate failure: a denied read is what the dialog reports.
    expect(() => readTrainingHistory('alice', { getItem() { throw new Error('Denied'); } })).toThrow('Denied');
    expect(() => readTrainingHistory('alice', null)).toThrow('Allow site storage');
  });
  it('keeps rehearsals and games in the same list, newest first, with their own summaries', () => {
    const storage = new Storage();
    saveSmartRun('alice', run(), stats, storage, finished);
    expect(saveRun('alice', { id: 'rehearse:1', mode: 'all_lines', blitz: false, repertoires: ['London'],
      finishedAt: '2026-10-21T13:10:00.000Z', cards: 4, correct: 3, mistakes: 1, skipped: 0 }, storage)).toBe(true);
    expect(saveRun('alice', { id: 'play:1', mode: 'play', blitz: false, result: 'Resigned', repertoires: [],
      finishedAt: '2026-10-21T13:20:00.000Z', cards: 6, correct: 0, mistakes: 0, skipped: 0 }, storage)).toBe(true);
    expect(saveRun('alice', { id: 'x', mode: 'blitz', blitz: true, repertoires: [], finishedAt: '2026-10-21T13:30:00.000Z',
      cards: 1, correct: 1, mistakes: 0, skipped: 0 }, storage)).toBe(false);
    const recent = recentRuns('alice', 2, storage);
    expect(recent.map((r) => [r.mode, r.summary])).toEqual([['play', 'Resigned'], ['all_lines', '75% first try']]);
    expect(readTrainingHistory('alice', storage)).toHaveLength(3);
  });
});
