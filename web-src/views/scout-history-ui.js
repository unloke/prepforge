import { html } from "../html.js";
import { countOf } from "../plural.js";

// The Scout History list: the runs this browser keeps (scout-history.js), each
// with Open and Delete, and Clear all. A <details> disclosure beside the source
// tray, so it opens and closes from the keyboard like any button; hidden while
// the list is empty.

const COLOR_LABEL = { white: "as White", black: "as Black", both: "both colours" };

export function relativeTime(then, now = Date.now()) {
  const minutes = Math.round((now - then) / 60000);
  if (!(minutes >= 1)) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(then).toLocaleDateString();
}

function runName(entry) {
  return (entry.usernames?.length ? entry.usernames.join(", ") : entry.label) || "Unnamed";
}

export function scoutHistoryRowsHtml(entries, now = Date.now()) {
  return entries.map((entry) => {
    const name = runName(entry);
    const meta = `${COLOR_LABEL[entry.color] || entry.color} · ${countOf(entry.gameCount || 0, "game")} · ${relativeTime(entry.savedAt, now)}`;
    return html`<li class="scout-history-row">
      <span class="scout-history-name"><b>${name}</b> <span class="muted">${meta}</span></span>
      <button type="button" class="btn sm" data-scout-history-open="${entry.key}" aria-label="Open ${name}, ${meta}">Open</button>
      <button type="button" class="btn sm ghost" data-scout-history-delete="${entry.key}" aria-label="Delete ${name}, ${meta}">Delete</button>
    </li>`;
  });
}

/**
 * Binds the History list in `root` (the <details> in index.html). `history` is
 * scout-history.js's object, `owner()` the account it reads, and `onOpen(entry)`
 * re-scouts a saved run. `refresh()` re-reads the list; call it after each save.
 */
export function createScoutHistoryUi({ root, history, owner, onOpen, now = () => Date.now() }) {
  if (!root || !history) return { refresh: async () => [] };
  const summary = root.querySelector("summary");
  const list = root.querySelector(".scout-history-list");
  let entries = [];
  let generation = 0;

  async function refresh() {
    const ask = ++generation;
    const next = owner() ? await history.list(owner()) : [];
    if (ask !== generation) return entries;
    entries = next;
    root.hidden = !entries.length;
    if (!entries.length) root.open = false;
    if (list) list.innerHTML = html`${scoutHistoryRowsHtml(entries, now())}`;
    return entries;
  }

  function close() {
    root.open = false;
    summary?.focus();
  }

  root.addEventListener("toggle", () => { if (root.open) void refresh(); });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && root.open) {
      event.preventDefault();
      close();
    }
  });
  root.addEventListener("click", async (event) => {
    const open = event.target.closest?.("[data-scout-history-open]");
    if (open) {
      const entry = entries.find((e) => e.key === open.dataset.scoutHistoryOpen);
      close();
      if (entry) onOpen(entry);
      return;
    }
    const remove = event.target.closest?.("[data-scout-history-delete]");
    if (remove) {
      const row = remove.closest("li");
      // Focus moves to the next row's Open (or the summary): the pressed button is about to go.
      const nextKey = (row?.nextElementSibling || row?.previousElementSibling)
        ?.querySelector("[data-scout-history-open]")?.dataset.scoutHistoryOpen;
      await history.remove(owner(), remove.dataset.scoutHistoryDelete);
      await refresh();
      const target = nextKey && [...(list?.querySelectorAll("[data-scout-history-open]") || [])]
        .find((button) => button.dataset.scoutHistoryOpen === nextKey);
      (target || summary)?.focus();
      return;
    }
    if (event.target.closest?.("[data-scout-history-clear]")) {
      await history.clear(owner());
      await refresh();
      summary?.focus();
    }
  });

  return { refresh };
}
