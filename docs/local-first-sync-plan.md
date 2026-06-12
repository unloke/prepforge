# Local-first + debounced cloud sync — implementation plan

> Goal (priority order): **降延遲** (user never waits on the network for a move) →
> **降消耗** (batched writes instead of one request per move) → a Google-Docs-style
> sync indicator so nobody worries their work is lost.
>
> Guiding principle is unchanged and already true in this codebase: **the server
> stores data, it never computes chess** (engines run in the browser). This plan
> extends it — the server becomes a *sync + validation* layer; the client owns the
> live working state.

## Decision (2026-06-11)

**Scope for this round: Phase 1 (Build) only**, using the **new
`POST /api/build/add-moves` batched endpoint** (§1.3) — not the fire-and-forget
fallback. Phase 2 (Train) is **deferred**: revisit after Build's sync model has
baked in production. The fallback section is kept for reference only.

## Status update (2026-06-12) — everything below is SHIPPED

User pulled Phase 2 forward (requirements: minimal server load, Train always
starts from fresh data, no jank, confirmation-free local-first delete). What
landed, where it differs from the plan text below:

- **Build delete flush** (not in the original plan): `deleteBuildNodeLocal`
  prunes the subtree locally with NO confirmation, cancels pending adds inside
  it, queues the subtree root in `buildPendingDeletes`; `flushBuildMoves`
  sends deletes **before** adds via `POST /api/build/delete-nodes`
  (`delete_nodes_batch`: idempotent per id, root-protected, cap 200);
  `reapplyPendingBuildDeletes` re-prunes after reconcile hydrates.
- **Phase 2 Train, with one design change**: instead of porting the SR formula
  to JS (§2.1), `/smart/start` ships a per-target `cards` bundle and the new
  `POST /api/train/smart/sync` **replays `record_attempt` server-side** over
  the batched attempt-1 results — exact SR parity with zero formula port. The
  client owns grading/advancement/requeue/skip (`smartLocalPrompt`,
  `requeueSmartCard` mirroring `REQUEUE_GAP`); `/smart/move`+`/smart/skip` are
  no longer called (kept for rollback). Flush: 4s debounce, visibility-hidden,
  keepalive unload beacon, and forced before `/smart/summary`.
- **Start is always fresh**: `startSmartTraining` hard-flushes Build then sends
  `fresh: true` — never resumes a stale queue. The sync still persists
  card_index+queue so the stored session stays resumable in principle.
- Day streak stays server-side (§2.3), touched once per sync batch that graded.

## Status / context

- Phase 0 (the board snapback fix) is **already shipped**: `optimisticBoardMove`
  renders the dragged move locally before any round-trip. Keep it — it's the
  *visual* half of local-first. This plan does the *data* half.
- Build's tree is already fully client-side: `appState.build` (the workspace
  payload), `appState.buildNodeById` (flat `Map<id, node>`). Nodes are a **flat
  list keyed by `parent_id`** — there is no nested `children` array; the tree view
  derives children by scanning `parent_id`. Node shape is whatever
  `opening_item_to_json` emits (`workspace_view.py:44`): `id, parent_id, depth,
  san, uci, fen, fen_before, fen_after, move_number, ply, move_side, side_to_move,
  source, is_mainline, is_prepared, is_enabled, maia_probability,
  engine_evaluation, tags, comment, arrows, circles, mastery`.
- There is already a batched, validated, **no-compute** server primitive to copy
  from: `POST /api/build/generate/apply-plan` →
  `OpeningBuilderService.apply_generation_plan`. It does temp-id (`tmp-`) →
  real-id reconciliation, parentRef chaining (same-batch tmp ids resolve in DFS
  order), recomputes `is_mainline`/`is_prepared` itself, all-or-nothing persist,
  and is hardened (size caps, root-id match, dup/forged tmp-id rejection). **But
  it deliberately forbids `manual` source** (anti-spoof), so we can't reuse it
  as-is for hand-played moves — we mirror its validation spine in a manual sibling.

---

## Phase 1 — Build: local-first with debounced batch sync  *(do this first)*

Biggest UX win, least risk, and it builds the local-first + debounce + indicator
machinery that Phase 2 reuses.

### 1.1 Local tree mutation (`onBuildBoardMove`)

Stop calling `/api/build/add-move` synchronously. Instead:

1. Compute `fenAfter`/`san` locally with `boardAfterMove` (already local).
2. Find the parent node in `buildNodeById`.
   - If a child with the same `uci` already exists → `selectBuildNode(child.id)`
     and return (dedupe — parity with today's server behaviour). No dirty state.
3. Otherwise mint `tmp-<counter>` and insert a provisional node into the flat
   list + `buildNodeById`, matching the serializer shape:
   - `id = tmp-N`, `parent_id = parent.id` (may itself be a `tmp-`),
     `fen = fenAfter`, `uci`, `san`, `depth = parent.depth + 1`,
     `move_number`/`move_side`/`side_to_move` derived from `parent.fen`,
     `source = "manual"`, `is_enabled = true`, `tags = []`,
     `arrows/circles = []`, `engine_evaluation = null`, `mastery = null`.
   - `is_mainline = !someEnabledChildOf(parent)`, `is_prepared =
     parent.side_to_move === build.color`. **These are provisional/display-only** —
     the server recomputes them and we adopt the authoritative payload on
     reconcile, so don't over-invest in matching the exact rule here.
4. `selectBuildNode(tmpId)` → instant render + tree update.
5. Mark the node dirty (append to a **pending queue**) and call
   `scheduleBuildFlush()`.

### 1.2 Debounce + flush triggers

- `scheduleBuildFlush()` (re)arms a ~2s idle timer; on fire → `flushBuildMoves()`.
- **Hard flush (await before proceeding)** on anything that needs server truth or
  a real anchor id: Build→Generate (apply-plan anchors on a *real* node id — a
  `tmp-` anchor would 400), export, switch/delete/rename repertoire, node-action,
  annotations save, and on `visibilitychange → hidden`.
- **Unload:** `beforeunload` → best-effort `navigator.sendBeacon` of the pending
  batch. Can't read the response, so treat as fire-and-forget; the next page load
  re-hydrates from server truth anyway.

### 1.3 New server endpoint: `POST /api/build/add-moves`

The manual sibling of apply-plan. Reuse the same validation spine.

- Body: `{ repertoire_id, moves: [{ tempId, parentRef, uci }] }` in
  insertion/DFS order. `parentRef` is a real node id **or** an earlier `tempId`
  in the same batch.
- Server (`OpeningBuilderService.add_moves_batch`, looping `add_move`'s existing
  per-move logic over a resolved parent map, persisting **once** at the end):
  owner-gate; re-validate legality (`apply_uci` raises → 400); resolve parentage
  (real id must live in this repertoire, tmp id must appear earlier in the
  batch); **recompute** `is_mainline`/`is_user_prepared_move`; force
  `source = MANUAL`; dedupe existing children (don't double-insert); all-or-nothing;
  caps (≤~500 moves/batch, depth-from-anchor bound) — copy the hardening list
  from apply-plan.
- Returns the refreshed `build_workspace_payload` **plus** `id_map: { tempId:
  realId }`.

> Why a new endpoint instead of extending apply-plan: apply-plan forbids `manual`
> source by design. Keep that boundary; share the service internals, not the HTTP
> surface.

### 1.4 Reconcile (the load-bearing bit)

- Snapshot the batch being flushed; **new moves made during the round-trip get
  fresh tmp ids and stay in a separate "still-pending" set** (don't lose them).
- On success: translate the current selection through `id_map`
  (`buildCurrentNodeId`, `buildBranchChoiceId`: tmp → real), then `hydrateBuild(
  payload, translatedSelectedId)` to replace the local tree with the authoritative
  one (hydrate rebuilds `buildNodeById` from `payload.nodes`).
- Re-apply the still-pending tmp nodes onto the fresh tree — their `parentRef` may
  now be a real id (look it up in `id_map`) — and arm another flush.
- This pending-vs-in-flight separation is the part to get right and test hardest.

### 1.5 Sync indicator (Google-Docs style)

- A small chip by the Build board label, driven by a `buildSync` state:
  `saved` (✓ "Saved"), `dirty` (• "Unsaved changes"), `syncing` (↻ "Saving…"),
  `error` (⚠ "Offline — will retry").
- `aria-live="polite"`, respects `prefers-reduced-motion` (no spinner animation),
  uses existing design tokens (see `styles.css` convention / memory `web-ui-tokens`).

### 1.6 Failure / retry

- Network/5xx: stay dirty, show `error`, exponential backoff retry; also flush on
  the next move.
- Validation 4xx (shouldn't happen for legal moves, but defend): surface the
  error, drop the bad batch, re-hydrate from server to resync truth.

### 1.7 Build test matrix

- Two fast moves where the 2nd's parent is a tmp from the same batch → parentRef
  chaining resolves.
- Move, then Generate before the idle flush → hard-flush-await first, then
  apply-plan anchors on the now-real id.
- Reload while dirty → beacon flush; reload shows the move (server truth).
- Replaying an existing line creates **no** tmp node (dedupe).
- Moves made *during* an in-flight flush survive and flush next cycle.
- Shared/read-only view still blocks (unchanged).
- Server: `add_moves_batch` parity with `add_move` (flags, mainline, dedupe),
  illegal-move reject + no-persist, unknown-parent reject, caps. Mirror
  `tests/test_opening_builder.py` + `tests/test_api_workspace.py`.

---

## Phase 2 — Train: local-first  *(optional, bigger; cheating accepted)*

Today every training move is a `POST /api/train/smart/move` (or `/api/train/move`).
That's a request *per move* — the largest consumption/latency item. Moving it
local is the biggest **降消耗** win but needs a faithful scheduler port.

### 2.1 What moves to the client

- **Grading**: compare played uci to the card's expected uci — trivial; the
  prompt already carries the position.
- **Opponent reply + next position**: read from the repertoire tree (client holds
  it).
- **SR scheduling**: port `SmartTrainingService` card selection / queue / SR-score
  update from Python → JS. This is the real work; port **under test**, mirroring
  `tests/test_*train*` so behaviour matches the Python scheduler.

### 2.2 Server becomes sync-only for Train

- `POST /train/smart/start` still fetches the session/tree + current SR state.
- Everything after runs local. Replace per-move POSTs with a debounced
  `POST /api/train/sr/sync` that writes a **batch** of SR deltas (`node_id,
  attempts, correct_attempts, spaced_repetition_score, is_mastered, last_seen`).
  Server persists with light sanity clamps only.
- Per your call: a tampered client can fake its own SR progress — accepted, it
  only hurts that user's own training. Document it so it's a known trade-off, not
  a latent bug.

### 2.3 Train decisions / risks

- **Day streak** (`_touch_streak`) has product meaning. Cheapest: keep it
  server-side (one call per day, not per move) — leave it alone. Don't move it
  local just for symmetry.
- **Parity** with the Python scheduler is the main correctness risk → the JS port
  must be test-covered before it replaces the endpoint.
- `submitReviewMove` is *already* fully local — use it as the reference for how
  local move feedback should feel.

### 2.4 Recommendation

Ship Phase 1, let the Build sync model bake in production, then port Train as a
clean full local scheduler (2.1–2.2). Avoid a half-measure (grade local but keep
server scheduling) — it's messier than either end state.

---

## Smaller fallback (if you want the latency win for Build *today*)

If the batched endpoint is more than you want to build right now: keep
`/api/build/add-move` per move but make it **fire-and-forget** — don't `await` it
in the UI path (the optimistic render already shows the move), serialize the
requests in a tiny queue, and show the same 1.5 sync indicator. You lose the
**降消耗** batching but get **降延遲** immediately, with almost no server change.
Phase 1 proper supersedes this.
