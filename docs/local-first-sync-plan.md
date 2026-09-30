# Local editing and cloud synchronization

Current implementation snapshot: 2026-09-29. The original implementation plan is
[archived](archive/history/local-first-sync-plan.md); its staged task list is not
an active roadmap.

## Build

`web-src/app.js` applies legal edits immediately, assigns temporary node IDs,
debounces adds/deletes, and reconciles server ID mappings. `hardFlushBuild()`
coordinates actions needing server IDs. Pending changes made during a round trip
are reapplied after hydration.

Network/5xx failures requeue pending changes. The present 4xx branch still drops
its in-flight batch and attempts a server reload; temporary 4xx failures need
separate handling. Do not interpret the current UI as guaranteeing durable offline
editing.

## Train

`web-src/train-sync.js` groups attempts by session and preserves attempt UUIDs.
The API saves receipts and progress together for idempotent retries. Transport,
5xx, authentication/conflict/rate-limit errors keep attempts queued; permanent
rejections are returned separately. The mixed rejected/retriable UI path still
needs to show every outcome.

## Interruption behavior

Browser pending queues are primarily in memory. Visibility/unload handlers use
best-effort flushes and keepalive fetches. Account logout currently precedes
reload without a durable-outbox handoff. These mechanisms are useful but do not
make refresh, browser termination, or offline logout recoverable in every case.

The [latest review](project-review-followup-2026-09-29.md) proposes a durable outbox,
account-scoped replay and truthful save states. These are proposed improvements,
not claims that they are already implemented.
