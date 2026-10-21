import { describe, expect, it } from 'vitest';
import { HISTORY_LIMITS, readTrainingHistory, saveSmartRun, trainingHistoryUsage } from './train-history.js';

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
const storedRuns = (storage, owner = 'alice') => JSON.parse(storage.getItem(`pf.trainHistory:${owner}`)).runs;

describe('local opening training history', () => {
  it('keeps completed generations after the server reuses its session ID', () => {
    const storage = new Storage();
    expect(saveSmartRun('alice', run(), stats, storage, finished)).toBe(true);
    expect(saveSmartRun('alice', run('2026-10-22T12:00:00Z'), { ...stats, mistakes: 0 }, storage, new Date('2026-10-22T12:05:00Z'))).toBe(true);
    const rows = readTrainingHistory('alice', storage);
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.mistakes)).toEqual([0, 1]);
    expect(rows[1]).toMatchObject({ repertoires: ['London', 'Caro-Kann'], cards: 1, correct: 3, mistakes: 1, skipped: 1 });
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
    expect(readTrainingHistory('alice', storage)[0]).toMatchObject({ mode: 'blitz', cards: 0, correct: 0, mistakes: 0, skipped: 2 });
  });
  it(`keeps the newest ${HISTORY_LIMITS.runs} runs and drops the oldest`, () => {
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
    expect(trainingHistoryUsage('alice', storage).runs).toBe(HISTORY_LIMITS.runs);
  });
  it('keeps the newest runs inside the byte budget and reports the size it enforces', () => {
    const storage = new Storage();
    const longNames = Array.from({ length: 12 }, (_, index) => `A long repertoire name ${index} with extra words ${'x'.repeat(160)}`);
    const save = index => saveSmartRun('alice', { ...run(new Date(Date.UTC(2026, 0, 1) + index * 60000).toISOString()),
      queue: longNames.map(name => ({ repertoire_name: name })), cardIndex: longNames.length }, stats, storage,
    new Date(Date.UTC(2026, 0, 1) + index * 60000 + 30000));
    for (let index = 0; index < 60; index++) save(index);
    const usage = trainingHistoryUsage('alice', storage);
    const rows = readTrainingHistory('alice', storage);
    expect(usage.bytes).toBeLessThanOrEqual(HISTORY_LIMITS.bytes);
    expect(new TextEncoder().encode(JSON.stringify({ v: 1, runs: storedRuns(storage) })).length).toBe(usage.bytes);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.length).toBeLessThan(60);
    expect(rows[0].finishedAt).toBe(new Date(Date.UTC(2026, 0, 1) + 59 * 60000 + 30000).toISOString());
    expect(rows.at(-1).finishedAt).toBe(new Date(Date.UTC(2026, 0, 1) + (60 - rows.length) * 60000 + 30000).toISOString());
  });
  it('keeps a single oversized run rather than losing the session just finished', () => {
    const storage = new Storage();
    const huge = Array.from({ length: 900 }, (_, index) => `Repertoire ${index} ${'x'.repeat(120)}`);
    saveSmartRun('alice', { ...run(), queue: huge.map(repertoire_name => ({ repertoire_name })), cardIndex: huge.length }, stats, storage, finished);
    const rows = readTrainingHistory('alice', storage);
    expect(rows).toHaveLength(1);
    expect(rows[0].repertoires).toHaveLength(900);
    expect(trainingHistoryUsage('alice', storage).bytes).toBeGreaterThan(HISTORY_LIMITS.bytes);
  });
  it('drops an oversized older run before the newest one', () => {
    const storage = new Storage();
    const huge = Array.from({ length: 900 }, (_, index) => `Repertoire ${index} ${'x'.repeat(120)}`);
    saveSmartRun('alice', { ...run(), queue: huge.map(repertoire_name => ({ repertoire_name })), cardIndex: huge.length }, stats, storage, finished);
    saveSmartRun('alice', run('2026-10-22T12:00:00Z'), stats, storage, new Date('2026-10-22T12:05:00Z'));
    const rows = readTrainingHistory('alice', storage);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('same-session-id:2026-10-22T12:00:00Z');
    expect(trainingHistoryUsage('alice', storage).bytes).toBeLessThanOrEqual(HISTORY_LIMITS.bytes);
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
    storage.setItem('pf.trainHistory:alice', JSON.stringify({ v: 1, runs: [{ id: 'broken' }, null, 'nope'] }));
    expect(readTrainingHistory('alice', storage)).toEqual([]);
    storage.setItem('pf.trainHistory:alice', 'not json');
    expect(readTrainingHistory('alice', storage)).toEqual([]);
    storage.setItem('pf.trainHistory:alice', JSON.stringify({ v: 2, runs: [] }));
    expect(readTrainingHistory('alice', storage)).toEqual([]);
  });
  it('keeps a storage failure from breaking training completion', () => {
    expect(saveSmartRun('alice', run(), stats, { getItem() { throw new Error('Denied'); } })).toBe(false);
    expect(saveSmartRun('alice', run(), stats, null)).toBe(false);
    const storage = new Storage();
    storage.setItem('pf.trainHistory:alice', JSON.stringify({ v: 1, runs: [] }));
    storage.failWrites = true;
    expect(saveSmartRun('alice', run(), stats, storage)).toBe(false);
    expect(readTrainingHistory('alice', storage)).toEqual([]);
    expect(() => readTrainingHistory('alice', null)).toThrow('Allow site storage');
  });
});
