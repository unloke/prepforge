import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Run through /watch-agents so the notification consumer is armed before launch.
const directory = path.resolve(process.argv[2]);
const config = JSON.parse(fs.readFileSync(path.join(directory, 'targets.json'), 'utf8'));
if (!config.ownerSessionId || !config.agents?.length) throw new Error('Missing owner session or targets');
const targets = config.agents.map(target => ({
  ...target, lastActivity: Date.now(), previous: null, identity: null, previousState: null,
}));
const startedAt = new Date().toISOString();
const intervalMs = config.intervalMs ?? 5000;
const staleMs = config.staleMs ?? 15 * 60_000;
const runId = config.runId;
let sequence = 0;
let lastMonitorError = null;
let absentSamples = 0;
const eventsPath = path.join(directory, 'events.jsonl');
const json = value => JSON.stringify(value, null, 2);
function atomicWrite(name, text) {
  const dest = path.join(directory, name);
  fs.writeFileSync(`${dest}.next`, text, 'utf8');
  fs.renameSync(`${dest}.next`, dest);
}
function event(type, data) {
  fs.appendFileSync(eventsPath, `${JSON.stringify({ id: `${runId}:${++sequence}`, runId, at: new Date().toISOString(), type, ...data })}\n`);
}
function git(target, args) {
  return execFileSync('git', ['--no-optional-locks', '-C', target.cwd, ...args], {
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function processes() {
  // Command lines are unnecessary: targets are attached by PID and creation time.
  const script = '$ErrorActionPreference = "Stop"; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate,KernelModeTime,UserModeTime,ReadTransferCount,WriteTransferCount,WorkingSetSize) | ConvertTo-Json -Compress';
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(output);
}
function artifacts(target) {
  const result = [];
  for (const relative of ['tmp', 'tmp/briefs', 'tmp/briefs/logs']) {
    const dir = path.join(target.cwd, relative);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const filename = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(filename);
        result.push({ path: `${relative}/${entry.name}`, size: stat.size, modifiedMs: stat.mtimeMs });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
function inspect(target, inventory, now) {
  const root = inventory.find(proc => proc.ProcessId === target.pid
    && (!target.created || proc.CreationDate === target.created));
  if (!target.identity && root) target.identity = { pid: root.ProcessId, created: root.CreationDate };
  // Track this run only; a replacement run must get a fresh monitor.
  const alive = Boolean(root && target.identity?.pid === root.ProcessId
    && target.identity?.created === root.CreationDate);
  const descendants = alive ? [root] : [];
  const ids = new Set(descendants.map(proc => proc.ProcessId));
  for (let changed = true; changed;) {
    changed = false;
    for (const proc of inventory) {
      if (ids.has(proc.ProcessId) || !ids.has(proc.ParentProcessId)) continue;
      ids.add(proc.ProcessId);
      descendants.push(proc);
      changed = true;
    }
  }
  const head = git(target, ['log', '-1', '--format=%h %s']);
  const branch = git(target, ['branch', '--show-current']);
  const dirty = git(target, ['status', '--porcelain=v1', '--untracked-files=all']);
  const tracked = git(target, ['ls-files', '-m', '-o', '--exclude-standard']).split('\n').filter(Boolean).map(relative => {
    try {
      const stat = fs.statSync(path.join(target.cwd, relative));
      return [relative, stat.size, stat.mtimeMs];
    } catch (error) {
      if (error.code === 'ENOENT') return [relative, 'deleted'];
      throw error;
    }
  });
  const files = artifacts(target);
  const report = files.find(file => file.path === 'tmp/briefs/REPORT.md');
  const fingerprint = JSON.stringify({ head, branch, dirty, tracked, files });
  const cpu = descendants.reduce((sum, proc) => sum + Number(proc.KernelModeTime) + Number(proc.UserModeTime), 0);
  const io = descendants.reduce((sum, proc) => sum + Number(proc.ReadTransferCount) + Number(proc.WriteTransferCount), 0);
  const processSignature = descendants.map(proc => `${proc.ProcessId}:${proc.CreationDate}`).sort().join(',');
  const previous = target.previous;
  const evidence = [];
  if (previous) {
    if (previous.fingerprint !== fingerprint) evidence.push('files-or-git');
    if (cpu > previous.cpu + 500_000) evidence.push('cpu');
    if (io !== previous.io) evidence.push('process-io');
    if (processSignature !== previous.processSignature) evidence.push('child-processes');
  }
  // Harness/network heartbeat I/O is not evidence of task progress.
  if (evidence.some(item => item === 'files-or-git' || item === 'child-processes')) target.lastActivity = now;
  const silentMinutes = Math.floor((now - target.lastActivity) / 60_000);
  const state = !alive ? 'exited-review-required' : now - target.lastActivity >= staleMs ? 'possibly-stalled' : 'running';
  const warnings = [];
  if (branch !== target.branch) warnings.push(`Branch changed: ${branch}`);
  if (!alive && dirty) warnings.push('Process exited with uncommitted changes');
  if (!alive && (!report || report.modifiedMs < new Date(startedAt).getTime())) warnings.push('No report updated since monitoring began');
  if (state === 'possibly-stalled') warnings.push('No observable activity for 15 minutes; this does not prove a hang');
  if (root && !alive) warnings.push('A replacement process was detected; original run has exited');
  const snapshot = {
    name: target.name, cwd: target.cwd, state, pid: target.identity?.pid ?? null,
    silentMinutes, evidence, head, branch, dirty,
    processCount: descendants.length,
    treeWorkingSetMiB: Math.round(descendants.reduce((sum, proc) => sum + Number(proc.WorkingSetSize), 0) / 1048576),
    children: descendants.slice(1).map(proc => ({ pid: proc.ProcessId, name: proc.Name })),
    report: report ? { path: path.join(target.cwd, report.path), modifiedAt: new Date(report.modifiedMs).toISOString(), updatedSinceMonitorStarted: report.modifiedMs >= new Date(startedAt).getTime() } : null,
    recentArtifacts: [...files].sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, 5), warnings,
  };
  const transition = JSON.stringify({ state, head, warnings });
  if (target.previousState !== transition) event('agent-state', snapshot);
  target.previousState = transition;
  target.previous = { fingerprint, cpu, io, processSignature };
  return snapshot;
}
function render(status) {
  const lines = [
    '# DeepSeek pi agent 背景監控', '',
    `更新：${status.updatedAt} · 監控 PID：${process.pid} · ${status.state}`, '',
    `每 ${intervalMs / 1000} 秒檢查；${staleMs / 60_000} 分鐘沒有檔案、Git 或子程序變動時標記疑似停滯。程序退出需要人工審查，不能據此宣告任務成功。`, '',,
    '| Agent | 狀態 | PID | 無活動（分） | 程序樹 RAM（MiB） | 最新 commit |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const agent of status.agents) lines.push(`| ${agent.name} | ${agent.state} | ${agent.pid ?? '—'} | ${agent.silentMinutes ?? '—'} | ${agent.treeWorkingSetMiB ?? '—'} | ${(agent.head || '').replaceAll('|', '\\|')} |`);
  lines.push('', 'RAM 為程序樹 working set 加總，可能重複計算共享頁面；不代表手機或瀏覽器 WASM 記憶體。', '');
  for (const agent of status.agents) {
    lines.push(`## ${agent.name}`, '', `目錄：\`${agent.cwd}\``, '');
    if (agent.error) lines.push(`檢查失敗：${agent.error}`, '');
    if (agent.warnings?.length) lines.push(...agent.warnings.map(warning => `- ${warning}`), '');
    lines.push(`報告：${agent.report ? `${agent.report.modifiedAt}（監控啟動後${agent.report.updatedSinceMonitorStarted ? '已更新' : '尚未更新'}）` : '尚無／無法讀取'}`, '');
    if (agent.dirty) lines.push('未提交變更：', '', '```text', agent.dirty, '```', '');
  }
  lines.push('停止監控：在此資料夾建立 STOP 檔案；三個程序皆退出並連續確認兩次後也會自動停止。', '', '本監控僅觀察並記錄，不會自動重啟 agent 或審查程式碼。', '');
  return lines.join('\n');
}
function tick() {
  if (fs.existsSync(path.join(directory, 'STOP'))) {
    event('monitor-stopped', { reason: 'STOP file' });
    const last = JSON.parse(fs.readFileSync(path.join(directory, 'status.json'), 'utf8'));
    last.state = 'stopped-by-request';
    last.updatedAt = new Date().toISOString();
    atomicWrite('status.json', json(last));
    atomicWrite('status.md', render(last));
    return;
  }
  try {
    const inventory = processes();
    const now = Date.now();
    const agents = targets.map(target => {
      try {
        const snapshot = inspect(target, inventory, now);
        target.previousError = null;
        return snapshot;
      } catch (error) {
        const message = String(error.message).slice(0, 1000);
        if (target.previousError !== message) event('inspection-error', { agent: target.name, error: message });
        target.previousError = message;
        return { name: target.name, cwd: target.cwd, state: 'inspection-error', error: message };
      }
    });
    lastMonitorError = null;
    absentSamples = agents.every(agent => agent.state === 'exited-review-required') ? absentSamples + 1 : 0;
    const status = { ownerSessionId: config.ownerSessionId, runId, startedAt, updatedAt: new Date(now).toISOString(), monitorPid: process.pid, intervalMs, staleMs, state: absentSamples >= 2 ? 'finished-observing' : 'monitoring', agents };
    atomicWrite('status.json', json(status));
    atomicWrite('status.md', render(status));
    fs.appendFileSync(path.join(directory, 'samples.jsonl'), `${JSON.stringify(status)}\n`);
    if (absentSamples >= 2) {
      event('monitor-stopped', { reason: 'All original agent processes exited; results require review' });
      return;
    }
  } catch (error) {
    const message = String(error.message).slice(0, 1000);
    if (lastMonitorError !== message) event('monitor-error', { error: message });
    lastMonitorError = message;
  }
  setTimeout(tick, intervalMs);
}
fs.writeFileSync(path.join(directory, 'monitor.pid'), String(process.pid));
event('monitor-started', { pid: process.pid, startedAt });
tick();
