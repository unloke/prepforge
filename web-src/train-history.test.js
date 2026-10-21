import { describe, expect, it } from 'vitest';
import { readTrainingHistory, saveSmartRun } from './train-history.js';

class Storage {
  data = new Map();
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, value); }
}
const run = (generation = '2026-10-21T12:00:00Z') => ({ sessionId: 'same-session-id', generation,
  repertoireName: 'London', queue: [{ repertoire_name: 'London' }, { repertoire_name: 'Caro-Kann' }],
  cardIndex: 2, cardsDone: 1, blitz: false });
const stats = { correct: 3, mistakes: 1, skipped: 1 };
const finished = new Date('2026-10-21T12:05:00Z');

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
  });
  it('preserves Blitz and skipped-only results without fabricating accuracy', () => {
    const storage = new Storage();
    saveSmartRun('alice', { ...run(), blitz: true, cardsDone: 0 }, { correct: 0, mistakes: 0, skipped: 2 }, storage, finished);
    expect(readTrainingHistory('alice', storage)[0]).toMatchObject({ mode: 'blitz', cards: 0, correct: 0, mistakes: 0, skipped: 2 });
  });
  it('keeps a storage failure from breaking training completion', () => {
    expect(saveSmartRun('alice', run(), stats, { getItem() { throw new Error('Denied'); } })).toBe(false);
    expect(saveSmartRun('alice', run(), stats, null)).toBe(false);
    expect(() => readTrainingHistory('alice', null)).toThrow('Allow site storage');
  });
});
