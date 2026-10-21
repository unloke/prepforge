import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createDelivery } from './pi-extension.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-watch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const entries = [], messages = [];
  const ctx = { hasUI: false, sessionManager: { getSessionId: () => 'owner', getBranch: () => entries } };
  const pi = { sendMessage: (message, options) => messages.push({ message, options }) };
  const status = { runId: 'run', ownerSessionId: 'owner', state: 'monitoring', updatedAt: new Date().toISOString() };
  const save = () => fs.writeFileSync(path.join(directory, 'status.json'), JSON.stringify(status));
  const emit = (id, name) => fs.appendFileSync(path.join(directory, 'events.jsonl'), JSON.stringify({ id, type: 'agent-state', name, state: 'exited-review-required' }) + '\n');
  fs.writeFileSync(path.join(directory, 'events.jsonl'), '');
  save();
  return { directory, entries, messages, ctx, pi, status, save, emit };
}

test('reports each exit while other agents are still running, and requests a follow-up turn', t => {
  const f = fixture(t), poll = createDelivery(f.pi, f.ctx, f.directory);
  f.emit('first-exit', 'first'); poll();
  assert.equal(f.messages.length, 1);
  assert.deepEqual(f.messages[0].options, { triggerTurn: true, deliverAs: 'followUp' });
  assert.match(f.messages[0].message.content, /first: exited-review-required/);
  poll(); assert.equal(f.messages.length, 1);
  f.emit('second-exit', 'second'); poll();
  assert.equal(f.messages.length, 2);
  assert.match(f.messages[1].message.content, /second: exited-review-required/);
});

test('reload replays an unpersisted queued event, but never repeats a persisted message', t => {
  const f = fixture(t);
  f.emit('exit', 'first'); createDelivery(f.pi, f.ctx, f.directory)();
  createDelivery(f.pi, f.ctx, f.directory)();
  assert.equal(f.messages.length, 2);
  f.entries.push({ type: 'custom_message', ...f.messages[0].message });
  createDelivery(f.pi, f.ctx, f.directory)();
  assert.equal(f.messages.length, 2);
});

test('a failure to queue a message remains retryable', t => {
  const f = fixture(t); f.emit('exit', 'first');
  let fail = true;
  const poll = createDelivery({ sendMessage: (...args) => { if (fail) throw new Error('queue unavailable'); f.pi.sendMessage(...args); } }, f.ctx, f.directory);
  assert.throws(() => poll(), /queue unavailable/);
  fail = false; poll(); assert.equal(f.messages.length, 1);
});

test('wrong sessions cannot consume another session’s completion events', t => {
  const f = fixture(t); f.status.ownerSessionId = 'other'; f.save(); f.emit('exit', 'first');
  createDelivery(f.pi, f.ctx, f.directory)();
  assert.equal(f.messages.length, 0);
});

test('a dead monitor and a failure before the first snapshot both trigger alerts', t => {
  const f = fixture(t);
  f.status.updatedAt = new Date(Date.now() - 100_000).toISOString(); f.save();
  createDelivery(f.pi, f.ctx, f.directory)();
  assert.match(f.messages[0].message.content, /heartbeat missing/);
  fs.unlinkSync(path.join(f.directory, 'status.json'));
  const configPath = path.join(f.directory, 'targets.json');
  fs.writeFileSync(configPath, JSON.stringify(f.status));
  fs.utimesSync(configPath, new Date(0), new Date(0));
  createDelivery(f.pi, f.ctx, f.directory)();
  assert.match(f.messages[1].message.content, /heartbeat missing/);
});

test('partially written events wait until their final newline', t => {
  const f = fixture(t), poll = createDelivery(f.pi, f.ctx, f.directory);
  const eventsPath = path.join(f.directory, 'events.jsonl');
  fs.appendFileSync(eventsPath, '{"id":"exit","type":"agent-state","state":"exited-review-required"');
  poll(); assert.equal(f.messages.length, 0);
  fs.appendFileSync(eventsPath, '}\n');
  poll(); assert.equal(f.messages.length, 1);
});

test('two exits between polls are both delivered even when the monitor already stopped', t => {
  const f = fixture(t);
  f.status.state = 'finished-observing';
  f.status.updatedAt = new Date(0).toISOString(); f.save();
  f.emit('first-exit', 'first'); f.emit('second-exit', 'second');
  createDelivery(f.pi, f.ctx, f.directory)();
  assert.deepEqual(f.messages[0].message.details.eventIds, ['first-exit', 'second-exit']);
  assert.match(f.messages[0].message.content, /first: exited-review-required/);
  assert.match(f.messages[0].message.content, /second: exited-review-required/);
  assert.doesNotMatch(f.messages[0].message.content, /heartbeat missing/);
});

test('a failed worktree produces one alert per failure rather than one model turn per poll', { skip: process.platform !== 'win32', timeout: 60_000 }, async t => {
  const f = fixture(t);
  const config = { ownerSessionId: 'owner', runId: 'run', intervalMs: 100, agents: [
    { pid: process.pid, name: 'bad-worktree', cwd: path.join(f.directory, 'missing'), branch: 'main' },
  ] };
  fs.writeFileSync(path.join(f.directory, 'targets.json'), JSON.stringify(config));
  fs.unlinkSync(path.join(f.directory, 'status.json'));
  const monitor = spawn(process.execPath, [fileURLToPath(new URL('monitor.mjs', import.meta.url)), f.directory], { stdio: 'ignore', windowsHide: true });
  t.after(async () => { monitor.kill(); await delay(300); });
  const samplesPath = path.join(f.directory, 'samples.jsonl');
  await until(() => fs.existsSync(samplesPath) && fs.readFileSync(samplesPath, 'utf8').trim().split('\n').length >= 3);
  const events = fs.readFileSync(path.join(f.directory, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.type === 'inspection-error').length, 1);
  createDelivery(f.pi, f.ctx, f.directory)();
  assert.equal(f.messages.length, 1);
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for monitor');
    await delay(100);
  }
}

test('real Windows child exits reach the Pi notification API separately', { skip: process.platform !== 'win32', timeout: 60_000 }, async t => {
  const f = fixture(t);
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  const branch = execFileSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
  const children = [1, 2].map(() => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true }));
  const config = { ownerSessionId: 'owner', runId: 'run', intervalMs: 200, agents: children.map((child, i) => ({ pid: child.pid, name: `child-${i}`, cwd, branch })) };
  fs.writeFileSync(path.join(f.directory, 'targets.json'), JSON.stringify(config));
  fs.unlinkSync(path.join(f.directory, 'status.json'));
  const monitor = spawn(process.execPath, [fileURLToPath(new URL('monitor.mjs', import.meta.url)), f.directory], { stdio: 'ignore', windowsHide: true });
  const statusFile = path.join(f.directory, 'status.json');
  const read = () => fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : null;
  t.after(async () => {
    for (const child of [...children, monitor]) child.kill();
    await delay(300);
  });
  await until(() => read()?.agents.every(agent => agent.state === 'running'));
  children[0].kill();
  await until(() => read()?.agents[0].state === 'exited-review-required');
  assert.equal(read().agents[1].state, 'running');
  const poll = createDelivery(f.pi, f.ctx, f.directory); poll();
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].message.content, /child-0/);
  children[1].kill();
  await until(() => read()?.agents[1].state === 'exited-review-required');
  poll(); assert.equal(f.messages.length, 2);
  assert.match(f.messages[1].message.content, /child-1/);
  await until(() => read()?.state === 'finished-observing');
});
