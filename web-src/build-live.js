// Live Build: the open repertoire follows edits made on other devices, other
// tabs and other editors (anyone the repertoire is shared with), without a reload.
//
// The server logs one op per write (repertoire_ops) and serves the catch-up as
// a state delta: GET /api/build/changes?since=<revision> returns the current
// state of every node written since then, the ids deleted since then, the name
// and one entry per write. Applying it is idempotent, so a delta that also holds
// this tab's own writes is harmless. Delivery is a conditional poll (an
// unchanged repertoire costs one indexed read): every few seconds while the
// Build view is open and visible, slower once nothing has changed for a minute,
// paused while hidden, and immediately on focus, on return to the tab, or when
// another tab of this browser announces a write over BroadcastChannel.

import { buildRole } from "./share-roles.js";

export const BUILD_MUTATIONS = new Set([
  "/api/build/rename", "/api/build/add-move", "/api/build/add-moves",
  "/api/build/delete-nodes", "/api/build/generate/apply-plan",
  "/api/build/action", "/api/build/annotations",
]);

export const LIVE_POLL_MS = 3000;
export const LIVE_IDLE_POLL_MS = 10000;
const LIVE_IDLE_AFTER_MS = 60000;
const LIVE_BUSY_RETRY_MS = 500;

const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("prepforge-build") : null;
let active = null;

// This tab just wrote: tell this browser's other tabs, and catch up now (an
// edit from elsewhere may have landed just before ours). Editing also keeps
// polling at the fast rate while collaborators are quiet.
export function announceBuildWrite(repertoireId) {
  try { channel?.postMessage({ repertoire_id: repertoireId }); } catch (_) { /* best effort */ }
  active?.poke();
}

// Check for remote changes now (a 409 node_deleted means the tree is stale).
export function pokeBuildLive() {
  active?.poke();
}

// Patch a Build payload with a /build/changes delta. Pure: returns a new payload
// (server nodes only; hydrateBuild puts this tab's unsynced moves back) and the
// selection to land on: the selected node, or its nearest surviving ancestor.
export function applyBuildChanges(build, changes, selectedId) {
  const removed = new Set(changes.removed || []);
  const incoming = new Map((changes.nodes || []).map((node) => [node.id, node]));
  const merged = [];
  for (const node of build.nodes) {
    if (removed.has(node.id) || String(node.id).startsWith("tmp-")) continue;
    merged.push(incoming.get(node.id) || node);
    incoming.delete(node.id);
  }
  merged.push(...incoming.values());
  // Keep what is still reachable from the root: a removed node takes its subtree.
  const children = new Map();
  for (const node of merged) {
    const list = children.get(node.parent_id) || [];
    list.push(node);
    children.set(node.parent_id, list);
  }
  const alive = new Set();
  const stack = [...(children.get(null) || [])];
  while (stack.length) {
    const node = stack.pop();
    alive.add(node.id);
    stack.push(...(children.get(node.id) || []));
  }
  const nodes = merged.filter((node) => alive.has(node.id));
  const before = new Map(build.nodes.map((node) => [node.id, node]));
  let selection = selectedId;
  while (selection && !alive.has(selection)) selection = before.get(selection)?.parent_id ?? null;
  const payload = {
    ...build,
    nodes,
    revision: changes.revision,
    name: changes.name ?? build.name,
    nodes_total: changes.nodes_total ?? build.nodes_total,
    ...(changes.health ? { health: changes.health } : {}),
  };
  return { payload, selection, removed };
}

// The one-line notice for writes this tab did not make, or null.
export function remoteChangeNotice(changes, { tabId, selectionLost, name }) {
  const foreign = (changes.ops || []).filter((op) => op.client_id !== tabId);
  if (!foreign.length) return null;
  if (selectionLost) return "Line deleted elsewhere";
  if (foreign.some((op) => op.kind === "rename") && name) return `Renamed to ${name} elsewhere`;
  return "Updated elsewhere";
}

// deps: api, appState, hydrate(payload, selection), reload(),
// activeView() (the shown view's name), notify(text), tabId; tests also pass
// isOpen, now, timers ({ setTimeout, clearTimeout }) and doc (document).
export function createBuildLive(deps) {
  const { api, appState, hydrate, reload, notify, tabId } = deps;
  // Polled only while Build shows a saved repertoire this account can read.
  const isOpen = deps.isOpen || (() => !!(appState.signedIn && !appState.sharedToken
    && appState.build?.repertoire_id && !appState.build.optimistic && deps.activeView() === "build"));
  const now = deps.now || (() => Date.now());
  const timers = deps.timers || globalThis;
  const doc = deps.doc || (typeof document === "undefined" ? null : document);
  let timer = null;
  let pulling = null;
  let lastChange = now();
  let stopped = false;

  const busy = () => !!(appState.buildFlushing || appState.buildMutationSaving
    || appState.buildAnnotationsSaving || appState.buildLoading);

  function schedule(ms) {
    timers.clearTimeout(timer);
    timer = stopped ? null : timers.setTimeout(tick, ms);
  }

  async function tick() {
    timer = null;
    if (!isOpen() || doc?.hidden) return schedule(LIVE_POLL_MS);
    if (busy() || pulling) return schedule(LIVE_BUSY_RETRY_MS);
    pulling = pull().catch(() => {}).finally(() => { pulling = null; });
    await pulling;
    schedule(now() - lastChange < LIVE_IDLE_AFTER_MS ? LIVE_POLL_MS : LIVE_IDLE_POLL_MS);
  }

  async function pull() {
    const build = appState.build;
    const since = build.revision;
    const changes = await api(
      `/api/build/changes?repertoire_id=${encodeURIComponent(build.repertoire_id)}&since=${since}`,
    );
    // This tab wrote, navigated or started saving meanwhile: its own reply (or
    // the next tick) carries newer truth than this delta.
    if (appState.build !== build || build.revision !== since || busy()) return;
    // The owner changed this caller's role (or a team's): reload so the banner,
    // Copy and editing follow it.
    if (changes.reset || (changes.role && changes.role !== buildRole(build))) {
      lastChange = now();
      await reload();
      return;
    }
    if (!(changes.revision > since)) return;
    lastChange = now();
    const selected = appState.buildCurrentNodeId;
    const { payload, selection } = applyBuildChanges(build, changes, selected);
    await hydrate(payload, String(selected).startsWith("tmp-") ? selected : selection);
    const text = remoteChangeNotice(changes, {
      tabId,
      selectionLost: selection !== selected && !appState.buildNodeById.has(selected),
      name: payload.name,
    });
    if (text) notify(text);
  }

  function poke() {
    lastChange = now();
    if (!pulling) schedule(0);
  }

  const onVisible = () => { if (!doc?.hidden) poke(); };
  const onMessage = (event) => {
    if (event?.data?.repertoire_id === appState.build?.repertoire_id) poke();
  };

  const instance = {
    start() {
      stopped = false;
      doc?.addEventListener?.("visibilitychange", onVisible);
      globalThis.addEventListener?.("focus", onVisible);
      channel?.addEventListener("message", onMessage);
      active = instance;
      schedule(LIVE_POLL_MS);
    },
    stop() {
      stopped = true;
      timers.clearTimeout(timer);
      timer = null;
      doc?.removeEventListener?.("visibilitychange", onVisible);
      globalThis.removeEventListener?.("focus", onVisible);
      channel?.removeEventListener("message", onMessage);
      if (active === instance) active = null;
    },
    poke,
    tick,
    onMessage,
  };
  return instance;
}
