import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const customType = 'agent-monitor-alert';
const actionable = event => (event.type === 'agent-state' &&
  ['exited-review-required', 'possibly-stalled'].includes(event.state)) ||
  ['inspection-error', 'monitor-error'].includes(event.type);
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const owner = ctx => ctx.sessionManager.getSessionId();

// Events remain on disk until their custom message is present in Pi's session.
// Queued delivery alone is not an acknowledgement: reload can discard that queue.
export function createDelivery(pi, ctx, directory) {
  const inFlight = new Set();
  return function poll(now = Date.now()) {
    const statusFile = path.join(directory, 'status.json');
    const status = fs.existsSync(statusFile) ? readJson(statusFile) : {
      ...readJson(path.join(directory, 'targets.json')),
      state: 'monitoring', updatedAt: fs.statSync(path.join(directory, 'targets.json')).mtime.toISOString(),
    };
    if (status.ownerSessionId !== owner(ctx)) return;
    const acknowledged = new Set(ctx.sessionManager.getBranch()
      .filter(entry => entry.type === 'custom_message' && entry.customType === customType)
      .flatMap(entry => entry.details?.eventIds ?? []));
    const eventsFile = path.join(directory, 'events.jsonl');
    const contents = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : '';
    const lines = contents.split('\n');
    lines.pop(); // a writer can be halfway through the final line
    const events = lines.filter(Boolean).map(line => JSON.parse(line)).filter(actionable);
    if (status.state === 'monitoring' && now - Date.parse(status.updatedAt) > 90_000) {
      events.push({ id: `${status.runId}:heartbeat-lost`, type: 'monitor-error', error: 'Monitor heartbeat missing for over 90 seconds' });
    }
    const pending = events.filter(event => event.id && !acknowledged.has(event.id) && !inFlight.has(event.id));
    if (!pending.length) return;
    const eventIds = pending.map(event => event.id);
    const summary = pending.map(event => `${event.name || event.agent || 'monitor'}: ${event.state || event.type}${event.error ? ` — ${event.error}` : ''}`).join('\n');
    for (const id of eventIds) inFlight.add(id);
    try {
      pi.sendMessage({ customType, display: true, details: { eventIds },
        content: `背景 agent 狀態變更：\n${summary}\n\n紀錄：${directory}\n請現在檢查相關報告、Git 與驗證結果，主動向使用者回報。程序退出只代表待審查；不要直接宣稱成功，也不要自行擴大任務。`,
      }, { triggerTurn: true, deliverAs: 'followUp' });
    } catch (error) {
      for (const id of eventIds) inFlight.delete(id);
      throw error;
    }
    if (ctx.hasUI) ctx.ui.notify(summary, pending.some(event => event.type.endsWith('error')) ? 'error' : 'info');
  };
}

export default function agentMonitor(pi) {
  let timer;
  let poll;
  let lastError;
  const stop = () => { clearInterval(timer); timer = null; poll = null; };
  const attach = (ctx, directory) => {
    stop();
    poll = createDelivery(pi, ctx, directory);
    const tick = () => {
      try { poll(); lastError = null; }
      catch (error) {
        if (String(error) !== lastError && ctx.hasUI) ctx.ui.notify(`Agent monitor: ${error.message}`, 'error');
        lastError = String(error);
      }
    };
    timer = setInterval(tick, 2000);
    timer.unref?.();
    tick();
  };
  pi.on('session_shutdown', stop);
  pi.on('session_start', (_event, ctx) => {
    stop();
    if (!['tui', 'rpc'].includes(ctx.mode)) return;
    const pointer = path.join(ctx.cwd, 'tmp', 'agent-monitor', 'active.json');
    if (!fs.existsSync(pointer)) return;
    const active = readJson(pointer);
    if (active.ownerSessionId === owner(ctx)) attach(ctx, active.directory);
  });
  pi.registerCommand('watch-agents', {
    description: 'Watch existing agent PIDs and automatically report each exit: /watch-agents <targets.json>',
    handler: async (args, ctx) => {
      const input = readJson(path.resolve(ctx.cwd, args.trim()));
      if (!input.agents?.length || input.agents.some(agent => !Number.isInteger(agent.pid) || !agent.cwd || !agent.name || !agent.branch)) {
        throw new Error('targets.json requires agents with pid, cwd, name and branch');
      }
      // Check that the host exposes the notification API before launching an observer.
      if (typeof pi.sendMessage !== 'function') throw new Error('Pi notification API unavailable');
      const runId = new Date().toISOString().replaceAll(/[:.]/g, '-');
      const base = path.join(ctx.cwd, 'tmp', 'agent-monitor');
      const directory = path.join(base, runId);
      fs.mkdirSync(directory, { recursive: true });
      const config = { ...input, runId, ownerSessionId: owner(ctx) };
      fs.writeFileSync(path.join(directory, 'targets.json'), JSON.stringify(config, null, 2));
      fs.writeFileSync(path.join(base, 'active.json'), JSON.stringify({ directory, ownerSessionId: owner(ctx) }));
      attach(ctx, directory); // Arm delivery before any child can exit.
      const log = fs.openSync(path.join(directory, 'runtime.log'), 'a');
      const child = spawn(process.execPath, [fileURLToPath(new URL('monitor.mjs', import.meta.url)), directory], {
        detached: true, windowsHide: true, stdio: ['ignore', log, log],
      });
      fs.closeSync(log);
      child.on('error', error => {
        pi.sendMessage({ customType, content: `背景監控啟動失敗：${error.message}`, display: true,
          details: { eventIds: [] } }, { triggerTurn: true, deliverAs: 'followUp' });
      });
      child.unref();
      ctx.ui.notify(`Monitoring ${input.agents.length} agents; each exit will trigger a report. PID ${child.pid}`, 'info');
    },
  });
}
