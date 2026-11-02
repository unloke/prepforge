import { html } from "../html.js";
import { modalDialog, openModal } from "../core/dialog.js";

const ACTIONS = {
  add_moves: "Added moves", delete_nodes: "Deleted moves", generate: "Generated lines",
  add_comment: "Edited a note", annotate: "Annotated a position", rename: "Renamed repertoire",
  set_active: "Changed availability", revert: "Restored an edit", discussion: "Commented",
  discussion_update: "Updated a discussion", set_mainline: "Changed main line",
};
const stamp = (value) => new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const keyOf = (fen) => String(fen).split(" ").slice(0, 4).join(" ");

export function createBuildCollaboration({ appState, api, postJson, hydrateBuild, selectBuildNode, showInputModal, miniBoard }) {
  let data = null, discussions = [], loadedKey = null, sequence = 0;
  let scope = null, generation = appState.ownerGeneration;
  const dialogs = new Set();
  const drafts = new Map();
  const rid = () => appState.build?.repertoire_id;
  const node = () => appState.buildNodeById.get(appState.buildCurrentNodeId);
  const label = (id) => {
    const n = appState.buildNodeById.get(id);
    return n?.san ? `${n.move_number}${n.move_side === "black" ? "…" : "."} ${n.san}` : "Start";
  };

  function markMoves() {
    const unread = new Set(data?.unread_nodes || []);
    document.querySelectorAll("#builder-tree .mtree-move[data-node-id]").forEach((el) => {
      el.classList.toggle("has-unseen", unread.has(el.dataset.nodeId));
    });
  }

  function paintButtons() {
    const button = document.getElementById("build-activity");
    if (!button) return;
    const unread = data?.entries.filter((entry) => entry.unread).length || 0;
    button.textContent = unread ? `Activity · ${unread}` : "Activity";
    button.classList.toggle("has-unseen", unread > 0);
    const discuss = document.getElementById("build-discuss");
    const thread = discussions.find((item) => item.position_key === keyOf(node()?.fen));
    if (discuss) discuss.textContent = thread ? `Discuss · ${thread.messages.length}` : "Discuss";
    markMoves();
  }

  async function load(force = false) {
    if (!rid() || appState.sharedToken || !appState.signedIn) return;
    const key = `${appState.ownerGeneration}:${rid()}:${appState.build.revision}`;
    if (!force && key === loadedKey) return;
    loadedKey = key;
    const request = ++sequence;
    const repertoireId = rid();
    try {
      const [activity, threads] = await Promise.all([
        api(`/api/build/activity?repertoire_id=${encodeURIComponent(repertoireId)}`),
        api(`/api/build/discussions?repertoire_id=${encodeURIComponent(repertoireId)}`),
      ]);
      if (request !== sequence || rid() !== repertoireId) return;
      data = activity;
      discussions = threads.threads;
      paintButtons();
    } catch (error) {
      if (request !== sequence) return;
      loadedKey = null;
      throw error;
    }
  }

  function shell(title, className = "") {
    const dialog = modalDialog(`lineage-modal ${className}`);
    dialog.innerHTML = html`<header class="modal-header"><h2 class="modal-title">${title}</h2><button type="button" class="btn icon" data-close aria-label="Close">×</button></header><div class="lineage-body"></div>`;
    const dismiss = openModal(dialog, { onDismiss: () => dialogs.delete(close) });
    const close = () => { dialogs.delete(close); dismiss(); };
    dialogs.add(close);
    dialog.querySelector("[data-close]").addEventListener("click", () => close());
    return { dialog, body: dialog.querySelector(".lineage-body"), close };
  }

  async function openActivity() {
    const repertoireId = rid();
    const { dialog, body, close } = shell("Activity", "activity-modal");
    const errorState = (error) => {
      body.innerHTML = html`<div class="lineage-error" role="alert">${error.message}<button type="button" class="btn" data-retry>Retry</button></div>`;
      body.querySelector("[data-retry]").onclick = refresh;
    };
    const paint = () => {
      if (!dialog.open || rid() !== repertoireId) return;
      body.innerHTML = html`<div class="activity-tools"><span>${data.truncated ? "Recent edits" : "All recent edits"}</span><button type="button" class="btn sm" data-refresh>Refresh</button><button type="button" class="btn sm" data-seen>Mark read</button></div><ol class="activity-list">${data.entries.map((entry) => {
        const target = entry.nodes.find((id) => appState.buildNodeById.has(id));
        const counts = [entry.added ? `+${entry.added}` : "", entry.deleted ? `−${entry.deleted}` : "", entry.edited ? `${entry.edited} edited` : ""].filter(Boolean).join(" · ");
        return html`<li class="activity-entry${entry.unread ? " is-unread" : ""}"><span class="person-initial" aria-hidden="true">${entry.actor.slice(0, 1)}</span><div><header><b>${entry.actor}</b><time datetime="${entry.created_at}" title="${stamp(entry.created_at)}">${stamp(entry.created_at)}</time></header><span class="activity-action">${ACTIONS[entry.kind] || "Updated repertoire"}</span>${counts ? html`<span class="activity-count">${counts}</span>` : ""}<div class="activity-actions">${target ? html`<button class="btn sm ghost" type="button" data-jump="${target}">${label(target)} →</button>` : ""}${entry.discussion_id ? html`<button class="btn sm ghost" type="button" data-thread="${entry.discussion_id}">Discussion →</button>` : ""}${entry.can_revert ? html`<button class="btn sm ghost" type="button" data-revert="${entry.revision}">Restore edit</button>` : entry.reverted ? html`<span class="muted">Restored</span>` : ""}</div></div><span class="activity-revision">r${entry.revision}</span></li>`;
      })}</ol>`;
      body.querySelector("[data-refresh]").onclick = refresh;
      body.querySelector("[data-seen]").onclick = async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await postJson("/api/build/activity/seen", { repertoire_id: repertoireId, revision: data.revision });
          await refresh();
        } catch (error) { errorState(error); }
      };
      body.querySelectorAll("[data-jump]").forEach((button) => { button.onclick = () => { close(); void selectBuildNode(button.dataset.jump); }; });
      body.querySelectorAll("[data-thread]").forEach((button) => { button.onclick = () => { close(); void openDiscussion(button.dataset.thread); }; });
      body.querySelectorAll("[data-revert]").forEach((button) => {
        button.onclick = async () => {
          await showInputModal({
            title: `Restore edit r${button.dataset.revert}?`, okLabel: "Restore edit",
            fields: [{ name: "scope", type: "note", label: "Restore this tree edit. Subsequent changes are checked for conflicts. Training history is not restored." }],
            onSubmit: async (values, finish) => {
              const payload = await postJson("/api/build/activity/revert", { repertoire_id: repertoireId, revision: Number(button.dataset.revert) });
              if (rid() === repertoireId) await hydrateBuild(payload, appState.buildCurrentNodeId);
              finish(values);
              await refresh();
            },
          });
        };
      });
    };
    async function refresh() {
      try { await load(true); paint(); } catch (error) { errorState(error); }
    }
    body.innerHTML = html`<div class="lineage-loading" role="status">Loading activity…</div>`;
    await refresh();
  }

  async function openDiscussion(threadId = null) {
    const repertoireId = rid(), position = node();
    if (!position) return;
    const { dialog, body, close } = shell("Position discussion", "discussion-modal");
    let activeId = threadId, first = true;
    const paint = () => {
      if (!dialog.open || rid() !== repertoireId) return;
      if (first && !activeId) activeId = discussions.find((thread) => thread.position_key === keyOf(position.fen))?.id;
      first = false;
      const active = discussions.find((thread) => thread.id === activeId);
      const draftKey = `${repertoireId}:${active?.id || keyOf(position.fen)}`;
      const fen = active?.fen || position.fen;
      body.innerHTML = html`<div class="discussion-layout"><nav class="discussion-index" aria-label="Discussions"><button type="button" class="discussion-link${!active ? " is-active" : ""}" data-current>Current position</button>${discussions.map((thread) => html`<button type="button" class="discussion-link${thread.id === activeId ? " is-active" : ""}" data-discussion="${thread.id}"><span>${thread.node_id ? label(thread.node_id) : "Detached position"}</span><small>${thread.messages.length} · ${thread.resolved ? "Resolved" : "Open"}</small></button>`)}</nav><section class="discussion-content"><header class="discussion-position">${miniBoard(fen)}<div><h3>${active ? (active.node_id ? label(active.node_id) : "Position outside tree") : label(position.id)}</h3>${active?.node_id || !active ? html`<button class="btn sm" type="button" data-show>Show position →</button>` : html`<span class="discussion-detached">Original line deleted</span>${active.can_reanchor ? html`<button class="btn sm" type="button" data-anchor title="${`Attach to ${label(position.id)}`}">Attach here</button>` : ""}`}${active?.can_resolve ? html`<button class="btn sm ghost" type="button" data-resolve>${active.resolved ? "Reopen" : "Resolve"}</button>` : active?.resolved ? html`<span>Resolved</span>` : ""}</div></header><ol class="discussion-messages">${active?.messages.map((message) => html`<li><header><b>${message.author}</b><time datetime="${message.created_at}">${stamp(message.created_at)}</time></header><p>${message.body}</p></li>`) || html`<li class="muted">No messages yet.</li>`}</ol><form class="discussion-compose"><label for="discussion-reply">${active ? "Reply" : "Start a discussion"}</label><textarea id="discussion-reply" required maxlength="5000">${drafts.get(draftKey) || ""}</textarea><div class="lineage-error" role="alert" hidden></div><button class="btn primary" type="submit">Send</button></form></section></div>`;
      const errorEl = body.querySelector(".lineage-error");
      const fail = (error) => { errorEl.textContent = error.message; errorEl.hidden = false; };
      body.querySelector("[data-current]").onclick = () => { activeId = discussions.find((thread) => thread.position_key === keyOf(position.fen))?.id; paint(); };
      body.querySelectorAll("[data-discussion]").forEach((button) => { button.onclick = () => { activeId = button.dataset.discussion; paint(); }; });
      body.querySelector("[data-show]")?.addEventListener("click", () => { close(); void selectBuildNode(active?.node_id || position.id); });
      const changeThread = async (button, fields) => {
        button.disabled = true;
        try {
          await postJson("/api/build/discussions/update", { repertoire_id: repertoireId, thread_id: active.id, ...fields });
          await load(true);
          paint();
        } catch (error) { fail(error); button.disabled = false; }
      };
      body.querySelector("[data-anchor]")?.addEventListener("click", (event) => { void changeThread(event.currentTarget, { fen: position.fen }); });
      body.querySelector("[data-resolve]")?.addEventListener("click", (event) => { void changeThread(event.currentTarget, { resolved: !active.resolved }); });
      const input = body.querySelector("textarea");
      input.addEventListener("input", () => drafts.set(draftKey, input.value));
      body.querySelector("form").onsubmit = async (event) => {
        event.preventDefault();
        const button = body.querySelector('[type="submit"]');
        if (button.disabled) return;
        button.disabled = true;
        input.disabled = true;
        errorEl.hidden = true;
        try {
          const sent = await postJson("/api/build/discussions", { repertoire_id: repertoireId,
            ...(active ? { thread_id: active.id } : { fen }), body: input.value });
          drafts.delete(draftKey);
          input.value = "";
          activeId = sent.thread_id;
          try { await load(true); paint(); } catch (error) {
            fail(new Error(`Message sent. ${error.message}`));
            button.type = "button";
            button.textContent = "Refresh";
            button.disabled = false;
            button.onclick = async () => {
              button.disabled = true;
              try { await load(true); paint(); } catch (refreshError) {
                fail(new Error(`Message sent. ${refreshError.message}`));
                button.disabled = false;
              }
            };
          }
        } catch (error) { fail(error); button.disabled = false; input.disabled = false; input.focus(); }
      };
    };
    body.innerHTML = html`<div class="lineage-loading" role="status">Loading discussions…</div>`;
    try { await load(true); paint(); } catch (error) {
      body.innerHTML = html`<div class="lineage-error" role="alert">${error.message}<button class="btn" type="button" data-retry>Retry</button></div>`;
      body.querySelector("[data-retry]").onclick = () => { close(); void openDiscussion(threadId); };
    }
  }

  function sync() {
    const nextScope = `${appState.ownerGeneration}:${appState.signedIn}:${rid()}`;
    if (nextScope !== scope) {
      for (const close of dialogs) close();
      data = null;
      discussions = [];
      loadedKey = null;
      sequence++;
      scope = nextScope;
      if (generation !== appState.ownerGeneration) drafts.clear();
      generation = appState.ownerGeneration;
    }
    const bar = document.getElementById("build-lineage-tools");
    if (!bar) return;
    const available = !!(rid() && !appState.sharedToken && appState.signedIn);
    for (const id of ["build-activity", "build-discuss"]) {
      const button = document.getElementById(id);
      if (button) button.hidden = !available;
    }
    if (!available) return;
    document.getElementById("build-activity").onclick = () => { void openActivity(); };
    document.getElementById("build-discuss").onclick = () => { void openDiscussion(); };
    paintButtons();
    void load().catch(() => {});
  }
  return { sync, markMoves };
}
