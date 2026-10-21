# pi agent supervision

The monitor records process and worktree state. The pi extension consumes each exit, stall, and monitor-failure event and calls `pi.sendMessage` with `triggerTurn: true` and `deliverAs: "followUp"`. When the parent is idle this starts a turn; when busy it queues a follow-up. The assistant must inspect results and report to the user. It does not wait for all agents to finish.

Install a personal extension that imports `pi-extension.mjs`. On this workstation it is installed at `C:/Users/andre/.pi/agent/extensions/agent-watch.ts`. Existing pi sessions must run `/reload` once; new sessions discover it automatically. The current conversation cannot hot-load an extension from an external shell.

Create a targets file using the actual PIDs of the agents already launched:

```json
{
  "agents": [
    { "name": "phone-ui", "pid": 12345, "cwd": "D:/auto_art/PrepForge-cc2-phone-ui", "branch": "cc2-phone-ui" },
    { "name": "perf-oom", "pid": 12346, "cwd": "D:/auto_art/PrepForge-cc2-perf-oom", "branch": "cc2-perf-oom" }
  ]
}
```

Run `/watch-agents <targets.json>` in the parent pi session. This arms event delivery before launching the detached observer. The command saves an owner-session ID and a run-specific directory under `tmp/agent-monitor/`, plus an `active.json` pointer used on session resume. Agent PIDs are pinned to their observed creation times; replacement processes are not silently substituted.

The observer checks every five seconds. Fifteen minutes without changes to files, Git state or child processes produces a possible-stall event. CPU and process I/O are recorded but do not reset this timer: harness/network heartbeat traffic is not proof of task progress. A monitor heartbeat missing for 90 seconds also triggers a follow-up, including failure before its first snapshot.

Completion events remain on disk. The consumer treats an event as acknowledged only when its custom message is present in the pi session, so an unpersisted queue is replayed after reload. Persisted messages are not repeated. Only the owning session consumes events. Partial JSONL writes wait for the final newline.

Outputs are `status.md`, `status.json`, `events.jsonl`, `samples.jsonl`, `monitor.pid` and `runtime.log`. Create `STOP` in the run directory to stop the observer, or let it stop after all original processes have exited. Exits always require review: attaching to an existing process cannot recover its shell exit code, and a report timestamp does not prove tests passed.

Automatic chat delivery requires the owning pi session to be open with the extension loaded. If it is closed, the detached observer continues recording; resuming the same session replays its undelivered events. This does not survive a Windows restart and does not provide an external push channel.

Verify the notification path with:

```sh
node --test scripts/agent-monitor/check.mjs
```

The checks cover separate exits, follow-up delivery options, replay after reload, persisted-message deduplication, queue failure, session ownership, monitor failure, partial events, and real Windows subprocesses exiting one at a time. The subprocess check reaches a recording implementation of the pi notification API; it does not make a paid model request.
