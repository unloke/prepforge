import { ENGINE_ID } from "./stockfish-provider.js";
import { subscribeUsableEngineProfile } from "./engine-profile.js";
import { stockfishBudget } from "./compute-budget.js";
import { createEngineProvider, ANALYSIS_MAX_NODES } from "./stockfish-provider.js";
import { analyzeGamePositions, isTerminalPosition } from "./game-analyzer.js";

// Per-position analysis store for Analyze. One entry per position identity holds
// separate channels that never overwrite each other:
//   live  — the interactive Stockfish read (Engine panel, Coach), MultiPV, any depth
//   game  — the whole-game pass's single-line eval (also seeded from a saved analysis)
//   maia  — human-model reads per rating, batched into shared forwards
// Consumers lease a position instead of owning a worker. The interactive lanes
// keep their Stockfish workers warm and move them between positions with
// `update`, so stepping through a game never boots a worker per ply. The
// whole-game pass keeps its own dedicated pool (full throughput) and only
// exchanges finished results with the store.
//
// One lane per engine this device runs. Every lane holds a reserved WASM heap
// (384 MiB for the full net, 256 MiB for lite), and the device budget hands out
// exactly that many engines: a lane past the budget never gets one of its own —
// registering as idle makes the budget reclaim a warm lane's worker, which the
// next step then boots again, and every boot reserves the heap afresh.
// The lane count is therefore read from `budget.snapshot().limit`, never stated
// separately: engine-profile.js configures that limit from the same usable
// profile (net + workers) the lanes belong to, so one number decides both. Reading
// it any earlier than that `configure` would size the lanes from the fallback.

// The halfmove clock affects fifty-move draws; only the fullmove number is irrelevant.
export function positionKey(fen) {
  return String(fen || "").trim().split(/\s+/).slice(0, 5).join(" ");
}

function sideOf(fen) {
  return String(fen || "").split(" ")[1] === "b" ? "black" : "white";
}

// A finished game-channel eval as an EngineProvider snapshot for `fen`.
function gameSnapshot(fen, game) {
  const ev = game.eval;
  return {
    session_id: "game-analysis",
    // The pass's own read, not a live search: the Engine panel names it rather
    // than passing it off as its own.
    source: "analysis",
    fen,
    running: false,
    complete: true,
    current_depth: ev.depth || 0,
    max_depth: game.target,
    side_to_move: sideOf(fen),
    pvs: [{ score_cp: ev.score_cp ?? null, mate_in: ev.mate_in ?? null, pv_uci: (ev.pv || []).slice(), pv_san: (ev.pv_san || []).slice() }],
  };
}

function gameEvalFromSnapshot(snapshot) {
  const top = snapshot && snapshot.pvs && snapshot.pvs[0];
  if (!top || (top.score_cp == null && top.mate_in == null)) return null;
  return {
    score_cp: top.score_cp ?? null,
    mate_in: top.mate_in ?? null,
    best_move_uci: top.pv_uci && top.pv_uci.length ? top.pv_uci[0] : null,
    pv: (top.pv_uci || []).slice(),
    pv_san: (top.pv_san || []).slice(),
    depth: snapshot.current_depth || 0,
    nodes: snapshot.nodes ?? null,
  };
}

export function createPositionAnalysisStore({
  createProvider = createEngineProvider,
  analyzeFn = analyzeGamePositions,
  getMaia = null,
  idleCloseMs = 60000,
  cacheSize = 600,
  maxNodes = ANALYSIS_MAX_NODES,
  maiaBatchSize = 16,
  // (fen, uciLine) => sanLine; game-pass results arrive as UCI only.
  sanLine = null,
  // fen => a saved whole-game eval for it (an analysis loaded from the server), or null.
  savedEval = null,
} = {}) {
  const entries = new Map();
  // One lane per engine this device runs (see the header). `stockfishBudget.snapshot().limit`
  // is the number the budget hands out, and engine-profile.js configures it from the
  // same usable profile the lanes belong to, so reading it here is what keeps a lane
  // from existing that can never hold an engine.
  const lanes = Array.from({ length: Math.max(1, stockfishBudget.snapshot().limit) }, (_, id) => ({
    id, provider: null, depth: 0, entry: null, multipv: 0, unwatch: null, idleTimer: null, startedFor: null,
  }));
  let clock = 0;
  let generation = 0;
  // Whole-game passes in flight. A pass holds every worker, so the Engine card
  // reads what it has saved for its position instead of searching (see passRead).
  let passing = 0;
  const passListeners = new Set();

  function notifyPass() {
    for (const fn of [...passListeners]) {
      try { fn(); } catch (_) { /* a consumer's bug never stalls the store */ }
    }
  }

  function entryFor(fen) {
    const key = positionKey(fen);
    let entry = entries.get(key);
    if (!entry) {
      entry = { key, fen, live: null, search: null, game: null, maia: new Map(), refs: 0, want: null, wantedAt: 0, failures: 0, listeners: new Set() };
      entries.set(key, entry);
      trim();
    } else {
      // LRU order: a touched position is the newest.
      entries.delete(key);
      entries.set(key, entry);
    }
    return entry;
  }

  function trim() {
    if (entries.size <= cacheSize) return;
    for (const [key, entry] of entries) {
      if (entries.size <= cacheSize) break;
      if (entry.refs || lanes.some((lane) => lane.entry === entry)) continue;
      entries.delete(key);
    }
  }

  function emit(entry) {
    for (const fn of [...entry.listeners]) {
      try { fn(); } catch (_) { /* a consumer's bug never stalls the store */ }
    }
  }

  // Does `entry` already answer a request for `depth` / `multipv` without searching?
  function satisfied(entry, depth, multipv) {
    const live = entry.live;
    if (live && live.complete && live.multipv >= multipv && live.maxDepth >= depth) return true;
    return multipv <= 1 && !!entry.game && entry.game.target >= depth;
  }

  // What a consumer sees for `fen`: the finished read when one satisfies it, else the
  // most useful partial (an in-flight search, an older live read, the game eval).
  function view(entry, fen, depth, multipv) {
    const rewrite = (snap) => (snap && snap.fen !== fen ? { ...snap, fen, side_to_move: sideOf(fen) } : snap);
    const live = entry.live;
    if (live && live.complete && live.multipv >= multipv && live.maxDepth >= depth) return rewrite(live.snapshot);
    if (multipv <= 1 && entry.game && entry.game.target >= depth) return rewrite(gameSnapshot(fen, entry.game));
    const search = entry.search;
    const searching = lanes.some((lane) => lane.entry === entry);
    if (entry.error && !searching) return { session_id: "position-store", fen, running: false, current_depth: 0, max_depth: depth, side_to_move: sideOf(fen), pvs: [], error: entry.error };
    const candidates = [search, live && live.snapshot, entry.game && gameSnapshot(fen, entry.game)].filter((s) => s && s.pvs && s.pvs.length);
    const best = candidates.sort((a, b) => (b.pvs.length >= multipv) - (a.pvs.length >= multipv) || (b.current_depth || 0) - (a.current_depth || 0))[0];
    // Still "running" while a search for this position is queued, so a polling panel
    // keeps waiting for the lines it asked for.
    if (best) return rewrite({ ...best, running: searching || !!entry.want || !!best.running, complete: false });
    return { session_id: "position-store", fen, running: searching || !!entry.want, current_depth: 0, max_depth: depth, side_to_move: sideOf(fen), pvs: [] };
  }

  // Detach the lane's provider subscription: the search pushes each depth it reaches.
  function unwatch(lane) {
    lane.unwatch?.();
    lane.unwatch = null;
  }

  function armIdle(lane) {
    lane.unregisterIdle?.();
    lane.unregisterIdle = null;
    clearTimeout(lane.idleTimer);
    lane.idleTimer = null;
    if (!lane.provider || idleCloseMs <= 0) return;
    const reclaim = () => releaseWarm(lane);
    lane.idleTimer = setTimeout(reclaim, idleCloseMs);
    // The lane is idle either way; the budget is what decides whether a warm worker
    // may be reclaimed to make room for a queued one, so it is always told.
    lane.unregisterIdle = stockfishBudget.registerIdle(reclaim);
  }

  // Drop the lane's warm worker now: it is idle, so nothing is searching for it and
  // its reserved heap (384 MiB on the full net) is the only thing it costs. A lane
  // that is mid-search keeps its worker — that search is someone's answer.
  function releaseWarm(lane) {
    if (lane.entry || !lane.provider) return;
    clearTimeout(lane.idleTimer);
    lane.idleTimer = null;
    lane.unregisterIdle?.();
    lane.unregisterIdle = null;
    const provider = lane.provider;
    lane.provider = null;
    lane.fresh = false;
    Promise.resolve(provider.close()).catch(() => {});
  }

  // Keep the deeper of an interrupted search and an earlier read.
  function keepPartial(entry) {
    const s = entry.search;
    entry.search = null;
    if (!s || !s.pvs || !s.pvs.length) return;
    const live = entry.live;
    if (!live || (!live.complete && (s.current_depth || 0) >= (live.snapshot.current_depth || 0))) {
      entry.live = { snapshot: { ...s, running: false }, maxDepth: s.max_depth || 0, multipv: s.pvs.length, complete: false };
    }
  }

  function finish(lane, { error = null } = {}) {
    const entry = lane.entry;
    unwatch(lane);
    lane.entry = null;
    lane.startedFor = null;
    if (entry) {
      if (error) {
        keepPartial(entry);
        entry.error = error;
        entry.failures += 1;
      } else {
        const s = entry.search;
        entry.search = null;
        entry.error = null;
        entry.failures = 0;
        if (s && s.pvs && s.pvs.length) {
          entry.live = { snapshot: { ...s, running: false, complete: true }, maxDepth: lane.depth, multipv: lane.multipv, complete: true };
        }
        if (entry.want && satisfied(entry, entry.want.depth, entry.want.multipv)) entry.want = null;
      }
      emit(entry);
    }
    armIdle(lane);
    schedule();
  }

  function capture(lane) {
    const entry = lane.entry;
    if (!entry || !lane.provider) return;
    const snap = lane.provider.snapshot();
    if (!snap) return;
    if (snap.error) {
      // A dead worker: drop it so the lane rebuilds, and let the entry retry once.
      const provider = lane.provider;
      lane.provider = null;
      Promise.resolve(provider.close()).catch(() => {});
      finish(lane, { error: snap.error });
      return;
    }
    if (positionKey(snap.fen) !== entry.key) return;
    if (snap.pvs && snap.pvs.length && (!entry.search || (snap.current_depth || 0) >= (entry.search.current_depth || 0) || snap.pvs.length > entry.search.pvs.length)) {
      entry.search = { ...snap, pvs: snap.pvs.map((pv) => ({ ...pv })) };
      emit(entry);
    }
    if (snap.running === false && ((snap.current_depth || 0) > 0 || (snap.pvs && snap.pvs.length))) finish(lane);
  }

  async function run(lane, entry, depth, multipv) {
    // Terminal positions have no PV or depth info; waiting on a worker would
    // leave the lane polling forever after bestmove (none).
    if (isTerminalPosition(entry.fen)) {
      entry.live = {
        snapshot: { session_id: "position-store", fen: entry.fen, running: false, complete: true,
          current_depth: 0, max_depth: depth, side_to_move: sideOf(entry.fen), pvs: [] },
        maxDepth: depth, multipv, complete: true,
      };
      entry.want = null;
      emit(entry);
      return;
    }
    const epoch = generation;
    lane.unregisterIdle?.();
    lane.unregisterIdle = null;
    clearTimeout(lane.idleTimer);
    lane.idleTimer = null;
    if (lane.entry && lane.entry !== entry) keepPartial(lane.entry);
    unwatch(lane);
    if (lane.provider && lane.depth !== depth) {
      const old = lane.provider;
      lane.provider = null;
      Promise.resolve(old.close()).catch(() => {});
    }
    if (!lane.provider) {
      lane.fresh = true;
      // The provider reports every depth it reaches; the lane captures each one, so a
      // line appears at the depth the engine actually reached instead of at the next
      // sample of a timer. Deferred to a microtask so the capture (which may finish the
      // lane and start another search) never runs inside the worker's message handler.
      const laneProvider = createProvider({ maxDepth: depth, maxMultipv: 5, maxNodes });
      laneProvider.watch?.(() => queueMicrotask(() => capture(lane)));
      lane.provider = laneProvider;
    }
    lane.depth = depth;
    lane.entry = entry;
    lane.multipv = multipv;
    entry.search = null;
    const token = {};
    lane.startedFor = token;
    const provider = lane.provider;
    try {
      // A warm worker switches positions with `update` (stop + new go), no reboot.
      if (lane.fresh) {
        lane.fresh = false;
        await provider.open({ fen: entry.fen, multipv });
      } else {
        await provider.update({ fen: entry.fen, multipv });
      }
    } catch (error) {
      if (epoch !== generation || lane.startedFor !== token) return;
      if (lane.provider === provider) lane.provider = null;
      Promise.resolve(provider.close()).catch(() => {});
      finish(lane, { error: error && error.message ? error.message : String(error) });
      return;
    }
    if (epoch !== generation || lane.startedFor !== token || lane.provider !== provider) return;
    capture(lane);
  }

  // Give each waiting position a lane, newest request first. Idle lanes go first,
  // then lanes still finishing a search nobody holds any more. A position someone
  // holds is never preempted by another.
  function schedule() {
    const waiting = [...entries.values()]
      .filter((e) => e.want && e.refs > 0 && e.failures < 2 && !lanes.some((lane) => lane.entry === e))
      .sort((a, b) => b.wantedAt - a.wantedAt);
    for (const entry of waiting) {
      const { depth, multipv } = entry.want;
      const lane = lanes.find((l) => !l.entry) || lanes.filter((l) => l.entry.refs === 0).sort((a, b) => a.entry.wantedAt - b.entry.wantedAt)[0];
      if (!lane) break;
      void run(lane, entry, depth, multipv);
    }
  }

  function want(entry, depth, multipv) {
    entry.wantedAt = ++clock;
    if (satisfied(entry, depth, multipv)) return;
    const prior = entry.want;
    entry.want = { depth: Math.max(depth, prior ? prior.depth : 0), multipv: Math.max(multipv, prior ? prior.multipv : 0) };
    const lane = lanes.find((l) => l.entry === entry);
    // Already on a lane with a weaker contract (fewer lines / shallower): restart it there.
    if (lane && (lane.multipv < entry.want.multipv || lane.depth < entry.want.depth)) {
      void run(lane, entry, entry.want.depth, entry.want.multipv);
      return;
    }
    if (!lane) schedule();
  }

  function acquire(fen, { depth = 16, multipv = 1 } = {}) {
    const epoch = generation;
    const entry = entryFor(fen);
    entry.fen = fen;
    entry.refs += 1;
    if (entry.error && !lanes.some((l) => l.entry === entry)) entry.failures = Math.min(entry.failures, 1);
    // A saved analysis already holds this position's eval: seed the game channel.
    const saved = !entry.game && savedEval ? savedEval(fen) : null;
    if (saved && (createProvider !== createEngineProvider || saved.engine === ENGINE_ID) && (saved.score_cp != null || saved.mate_in != null)) publishGame(fen, { ...saved, pv: saved.pv || [] }, saved.depth || 0);
    want(entry, depth, multipv);
    let released = false;
    return {
      fen,
      snapshot: () => view(entry, fen, depth, multipv),
      satisfied: () => satisfied(entry, depth, multipv),
      // Resolve with the first view that `accept` takes (default: a satisfying read),
      // re-checked on every update to this position. Errors resolve too, so a waiter
      // never hangs on a dead worker.
      until(accept = () => satisfied(entry, depth, multipv)) {
        return new Promise((resolve) => {
          const check = () => {
            const snap = view(entry, fen, depth, multipv);
            if (released || epoch !== generation || accept(snap) || (snap.error && !lanes.some((l) => l.entry === entry))) {
              entry.listeners.delete(check);
              resolve(released || epoch !== generation ? null : snap);
              return true;
            }
            return false;
          };
          if (!check()) entry.listeners.add(check);
        });
      },
      // Call `fn` on every update to this position (the store emits on each captured
      // depth) until released. A panel renders pushes instead of polling.
      listen(fn) {
        const check = () => !released && epoch === generation && fn();
        entry.listeners.add(check);
        return () => entry.listeners.delete(check);
      },
      release() {
        if (released) return;
        released = true;
        entry.refs -= 1;
        emit(entry); // wake this lease's own waiters so they resolve null
        if (entry.refs <= 0) {
          entry.refs = 0;
          // An unheld search keeps its lane until another position needs it, so a
          // quick step back still finds the work done.
          if (!lanes.some((l) => l.entry === entry)) entry.want = null;
        }
        schedule();
      },
    };
  }

  function publishGame(fen, ev, target) {
    if (!fen || !ev) return;
    const entry = entryFor(fen);
    const old = entry.game;
    if (old && old.target > target) return;
    if (!(ev.pv_san && ev.pv_san.length) && ev.pv && ev.pv.length && sanLine) {
      try { ev = { ...ev, pv_san: sanLine(fen, ev.pv) }; } catch { /* keep UCI */ }
    }
    entry.game = { eval: ev, target: Math.max(target || 0, ev.depth || 0) };
    if (entry.want && satisfied(entry, entry.want.depth, entry.want.multipv)) entry.want = null;
    emit(entry);
    notifyPass();
  }

  // A finished read (live or game) good enough for the whole-game pass at `depth`.
  function reusableGameEval(fen, depth) {
    const entry = entries.get(positionKey(fen));
    if (!entry) return null;
    if (entry.game && entry.game.target >= depth) return entry.game.eval;
    const live = entry.live;
    if (live && live.complete && live.maxDepth >= depth) return gameEvalFromSnapshot(live.snapshot);
    return null;
  }

  // ---- Maia: batched per (rating) into one worker forward per tick -----------
  const maiaQueue = new Map(); // rating -> [{ fen, resolve, reject }]
  let maiaTimer = null;
  function flushMaia() {
    maiaTimer = null;
    for (const [rating, items] of maiaQueue) {
      maiaQueue.delete(rating);
      for (let i = 0; i < items.length; i += maiaBatchSize) {
        const chunk = items.slice(i, i + maiaBatchSize);
        Promise.resolve().then(() => {
          const provider = getMaia && getMaia();
          if (!provider) throw new Error("Maia unavailable");
          return typeof provider.batch === "function" && chunk.length > 1
            ? provider.batch("positionReadBatch", { fens: chunk.map((c) => c.fen), rating })
            : Promise.all(chunk.map((c) => provider.positionRead({ fen: c.fen, rating })));
        }).then(
          (reads) => chunk.forEach((c, k) => c.resolve(reads ? reads[k] ?? null : null)),
          (err) => chunk.forEach((c) => c.reject(err)),
        );
      }
    }
  }
  function maiaRead(fen, rating) {
    const entry = entryFor(fen);
    const key = String(rating ?? "default");
    let read = entry.maia.get(key);
    if (!read) {
      if (!getMaia || !getMaia()) return Promise.reject(new Error("Maia unavailable"));
      read = new Promise((resolve, reject) => {
        if (!maiaQueue.has(rating)) maiaQueue.set(rating, []);
        maiaQueue.get(rating).push({ fen, resolve, reject });
        if (!maiaTimer) maiaTimer = setTimeout(flushMaia, 0);
      });
      entry.maia.set(key, read);
      // A failed read stays retryable.
      read.catch(() => { if (entry.maia.get(key) === read) entry.maia.delete(key); });
    }
    return read;
  }

  const store = {
    acquire,
    publishGame,
    reusableGameEval,
    maiaRead,
    // What the whole-game pass has saved for `fen` — or null while it has not
    // reached that position. Reads only: no lease, no want, no worker. The Engine
    // card uses it to show the pass's own eval instead of competing for a worker
    // the pass holds.
    passRead(fen) {
      const entry = entries.get(positionKey(fen));
      return entry && entry.game ? { ...gameSnapshot(fen, entry.game), complete: false } : null;
    },
    // Drop every warm worker now. The store is a page-wide singleton, so a lane a
    // consumer left idle outlives the view that used it and its reserved heap sits
    // for `idleCloseMs`; leaving the view is when that heap is worth nothing. Cached
    // reads stay, so coming back is a re-boot, not a re-analysis.
    releaseWarm() {
      for (const lane of lanes) releaseWarm(lane);
    },
    // A whole-game pass started (1) or ended (0). Consumers read `passing` through
    // onPassChange to know the engine is taken and follow each saved position.
    passStart() {
      passing += 1;
      notifyPass();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        passing -= 1;
        notifyPass();
      };
    },
    get passing() {
      return passing > 0;
    },
    onPassChange(fn) {
      passListeners.add(fn);
      return () => passListeners.delete(fn);
    },
    // Whole-game pass: dedicated workers at full concurrency; positions the store can
    // already answer at this depth are reused, and every finished eval is published.
    // multipv > 1 (the brilliant check's best-other-move read) runs on the same
    // dedicated pool but neither reuses nor publishes: the game channel is single-line.
    // Only a single-line pass holds the workers for the Engine card: a MultiPV check
    // sidesteps the budget (batch) and is not what leaves the card waiting.
    analyzeGame({ positions, depth, multipv = 1, onProgress, shouldCancel, concurrency, onResult, engineRun, maxNodes: cap = maxNodes }) {
      const single = multipv <= 1;
      const endPass = single ? store.passStart() : () => {};
      return Promise.resolve(analyzeFn({
        positions,
        depth,
        maxNodes: cap,
        multipv: single ? 1 : multipv,
        concurrency,
        onProgress,
        shouldCancel,
        engineRun,
        reuse: single ? (fen) => reusableGameEval(fen, depth) : null,
        onResult: (fen, ev) => {
          if (single) publishGame(fen, ev, depth);
          if (typeof onResult === "function") onResult(fen, ev);
        },
      })).finally(endPass);
    },
    // EngineProvider-compatible handle for the Engine panel. close() only drops this
    // consumer's hold on the position. watch(fn) subscribes to every store update for the
    // held position, so the panel renders each depth as it arrives instead of sampling.
    createHandle({ maxDepth = 16 } = {}) {
      let lease = null;
      let onChange = null;
      let detach = null;
      const attach = () => {
        detach?.();
        detach = lease && onChange ? lease.listen(() => onChange(lease.snapshot())) : null;
      };
      const select = async ({ fen, multipv = 1 }) => {
        const next = acquire(fen, { depth: maxDepth, multipv });
        lease?.release();
        lease = next;
        attach();
        return next.snapshot();
      };
      return {
        open: select,
        update: select,
        snapshot: () => lease?.snapshot(),
        // Replace (or, with null, remove) the change listener on the held position.
        watch(fn) { onChange = fn; attach(); },
        close: async () => {
          detach?.();
          detach = null;
          lease?.release();
          lease = null;
        },
      };
    },
    clear() {
      generation += 1;
      for (const lane of lanes) {
        lane.unregisterIdle?.();
        lane.unregisterIdle = null;
        unwatch(lane);
        clearTimeout(lane.idleTimer);
        lane.entry = null;
        if (lane.provider) Promise.resolve(lane.provider.close()).catch(() => {});
        lane.provider = null;
      }
      for (const entry of entries.values()) emit(entry);
      entries.clear();
      clearTimeout(maiaTimer);
      maiaTimer = null;
      for (const items of maiaQueue.values()) {
        for (const item of items) item.reject(new Error("Analysis store cleared"));
      }
      maiaQueue.clear();
    },
  };
  if (createProvider === createEngineProvider) subscribeUsableEngineProfile((profile) => {
    // The device's engine count changed (a Detect, a settings pick): the lanes follow
    // it, or a device that just stepped down to one worker keeps two lanes fighting
    // over the single engine it is allowed.
    while (lanes.length > profile.workers) {
      const lane = lanes.pop();
      lane.unregisterIdle?.();
      unwatch(lane);
      clearTimeout(lane.idleTimer);
      if (lane.provider) void lane.provider.close();
    }
    for (let id = lanes.length; id < profile.workers; id += 1) {
      lanes.push({ id, provider: null, depth: 0, entry: null, multipv: 0, unwatch: null, idleTimer: null, startedFor: null });
    }
    // Keep leases attached while replacing all engine-derived state. In particular,
    // first-use detection must not orphan the board request that triggered it.
    for (const lane of lanes) {
      unwatch(lane);
      clearTimeout(lane.idleTimer);
      lane.unregisterIdle?.();
      lane.unregisterIdle = null;
      lane.startedFor = null;
      lane.entry = null;
      if (lane.provider) void lane.provider.close();
      lane.provider = null;
    }
    for (const entry of entries.values()) {
      if (entry.refs > 0) entry.want = {
        depth: Math.max(entry.want?.depth || 0, entry.live?.maxDepth || 0, entry.game?.target || 0),
        multipv: Math.max(entry.want?.multipv || 1, entry.live?.multipv || 1),
      };
      entry.live = entry.game = entry.search = null;
      entry.error = null;
      entry.failures = 0;
      emit(entry);
    }
    schedule();
  });
  return store;
}
