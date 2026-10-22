import { html } from "../html.js";
import { enterRows } from "../list-enter.js";
import { roleLabel } from "../share-roles.js";

// The Library table's rows and the painter that keeps them in place.
//
// One load renders the list twice: the cached team names arrive first (they are
// already in state), then the fresh /api/repertoires listing. Rewriting every
// row both times replayed the entrance animation over identical content and
// threw the focused row away, so the list "faded in twice". A row whose content
// is unchanged now keeps its DOM node; only a row that arrives or whose cells
// changed is rebuilt, and it is the only one carrying the entrance marker.
//
// Selection is deliberately not part of a row's key: applySelectionHighlight
// toggles it in place, so moving the selection is not a content change.

// Repertoires others shared with the caller, beside the own ones, at the
// caller's role; an editor opens one to edit it.
function sharedRowHtml(item) {
  const from = item.owner_display_name ? ` · ${item.owner_display_name}` : "";
  return html`
    <div class="lib-row is-shared" tabindex="0" data-repertoire-id="${item.id}" data-shared="1" data-role="${item.role}">
      <span class="lib-opt" role="option" aria-selected="false">
        <span class="lib-cell-rep">
          <span class="color-dot ${item.color}"></span>
          <span class="lib-name">
            <span class="lib-name-line"><b class="name">${item.name}</b><span class="lib-chip is-shared">shared</span></span>
            <small class="rep-sub">${String(item.color) === "black" ? "Black" : "White"} · ${roleLabel(item.role)}${from}</small>
          </span>
        </span>
        <span class="lib-cell-mastery"><span class="muted">—</span></span>
        <span class="lib-cell-queue"><span class="muted">—</span></span>
      </span>
    </div>`;
}

// An own row: name, colour dot, chips, the inline mastery bar and the queue
// chips. The listing API carries no line count or last-trained date, so the
// prototype's "Lines" / "Last trained" columns stay out rather than inventing
// data. Selection is state, not content, so it is not part of what
// rowContent() compares; entrance markers belong to newly created DOM nodes.
function ownRowHtml(item, { selected, repSubline }) {
  const id = item.id;
  const active = item.is_active !== false;
  const cls = ["lib-row", active ? "" : "is-disabled", selected ? "is-selected" : ""]
    .filter(Boolean)
    .join(" ");
  const chipsHtml =
    html`${active ? "" : html`<span class="lib-chip">disabled</span>`}${item.shared
      ? html`<span class="lib-chip is-shared">shared</span>`
      : ""}`;
  const health = item.health;
  const pct = health ? health.mastery_pct || 0 : null;
  // Two layers from the left: mastered moves on top, every move trained at least
  // once behind it, so practice shows before mastery catches up.
  let mastery = html`<span class="lib-mastery lib-mastery-none">no moves trained yet</span>`;
  if (pct != null) {
    const count = (k) => Number(health[k]) || 0;
    const started = count("mastered") + count("learning") + count("due") + count("weak");
    const total = count("trainable") || started + count("untrained");
    const startedPct = total ? Math.max(pct, Math.round((started / total) * 100)) : pct;
    const label = `${count("mastered")} mastered · ${started - count("mastered")} learning · ${count("untrained")} new`;
    mastery =
      html`<span class="lib-mastery" title="${label}"><span class="lib-mbar" role="img" aria-label="${pct}% mastered, ${startedPct}% trained"><i class="is-started" style="width:${startedPct}%"></i><i class="is-mastered" style="width:${pct}%"></i></span><b>${pct}%</b><span class="lib-mastery-word">mastered</span></span>`;
  }
  // Each queue chip starts this repertoire's Due queue in Train.
  const queue = [];
  const chip = (kind, count, word) =>
    html`<button type="button" class="kchip k-${kind}" data-train-chip="${kind}" title="Train ${count} ${word} in ${item.name}">${count} ${word}</button>`;
  if (health && health.weak) queue.push(chip("weak", health.weak, "weak"));
  if (health && health.due) queue.push(chip("due", health.due, "due"));
  if (health && health.untrained) queue.push(chip("new", health.untrained, "new"));
  const queueHtml = queue.length ? queue : html`<span class="muted">—</span>`;
  return html`
    <div class="${cls}" tabindex="0" data-repertoire-id="${id}" data-active="${active ? "1" : "0"}" aria-selected="${selected}">
      <span class="lib-opt" role="option" aria-selected="${selected}">
        <span class="lib-cell-rep">
          <span class="color-dot ${item.color}"></span>
          <span class="lib-name">
            <span class="lib-name-line"><b class="name">${item.name}</b>${chipsHtml}</span>
            <small class="rep-sub">${repSubline(item)}</small>
          </span>
        </span>
        <span class="lib-cell-mastery">${mastery}</span>
        <span class="lib-cell-queue">${queueHtml}</span>
      </span>
      <button type="button" class="btn ghost icon row-menu-btn" data-row-menu="${id}" title="Actions (train · rename · share · delete)" aria-label="Actions for ${item.name}" aria-haspopup="menu" aria-expanded="false" aria-controls="repertoire-context-menu">⋯</button>
    </div>
  `;
}

// The list's painter. It owns the DOM nodes and what each one was last told, so
// the view above it only has to say what the listing now contains.
// `openOwn` selects the row and opens its workspace (the production action);
// `openShared` opens a read-only share without claiming the local selection.
export function createLibraryRows({ openOwn, openShared, openRepertoireContextMenu, repSubline, trainRepertoire }) {
  // Rows on screen, by key, with the content they were painted from.
  const painted = new Map();

  // A row's own listeners. Only rows this painter created are bound, so a kept
  // row never collects a second handler.
  function bindRow(row) {
    const repId = row.dataset.repertoireId;
    if (row.dataset.shared) {
      const openSharedRow = () => openShared(repId);
      row.addEventListener("click", openSharedRow);
      row.addEventListener("keydown", (event) => {
        if (event.target !== row) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openSharedRow();
        }
      });
      return;
    }
    const open = () => openOwn(repId);
    row.addEventListener("click", (event) => {
      if (event.target.closest(".row-menu-btn")) return;
      const chip = event.target.closest("[data-train-chip]");
      if (chip && trainRepertoire) return trainRepertoire(repId, chip);
      open();
    });
    row.addEventListener("keydown", (event) => {
      if (event.target !== row) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        // Enter / Space open the workspace, the same as a click.
        open();
      }
    });
    row.addEventListener("contextmenu", (event) =>
      openRepertoireContextMenu(event, repId, row.dataset.active === "1"),
    );
    row.querySelector(".row-menu-btn").addEventListener("click", (event) => {
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      openRepertoireContextMenu(
        { preventDefault: () => {}, currentTarget: event.currentTarget, clientX: rect.left, clientY: rect.bottom + 4 },
        repId,
        row.dataset.active === "1",
      );
    });
  }

  // What the row says, selection and entrance aside: the painter's key for
  // "this row is already on screen". Rendered by the same template that paints
  // it, so a new column can never fall out of the comparison.
  const contentOf = (item, sharedRow) =>
    String(
      sharedRow
        ? sharedRowHtml(item)
        : ownRowHtml(item, { selected: false, repSubline }),
    );

  const keyOf = (item, sharedRow) => `${sharedRow ? "s" : "o"}:${item.id}`;

  // Selection is the row's state, not the listing's: move it without touching
  // content, so a refresh that keeps the selected row stays one settled frame.
  function highlight(container, selectedRepId) {
    container.querySelectorAll("[data-repertoire-id]").forEach((row) => {
      const selected = row.dataset.repertoireId === selectedRepId;
      row.classList.toggle("is-selected", selected);
      row.setAttribute("aria-selected", String(selected));
      // The role=option lives on the inner .lib-opt (it must not own the menu
      // button), so its aria-selected mirrors the row's selection state.
      row.querySelectorAll(".lib-opt").forEach((opt) => {
        opt.setAttribute("aria-selected", String(selected));
      });
    });
  }

  return {
    // Paint `visible` (own) then `shared` (read-only) into `container`,
    // reconciling against the nodes already there. Returns the rows the
    // selection highlight has to visit.
    render(container, visible, shared, { selectedRepId }) {
      const entries = [
        ...visible.map((item) => ({ item, sharedRow: false })),
        ...shared.map((item) => ({ item, sharedRow: true })),
      ].map((entry) => {
        const key = keyOf(entry.item, entry.sharedRow);
        const content = contentOf(entry.item, entry.sharedRow);
        const changed = painted.get(key) !== content;
        painted.set(key, content);
        return {
          ...entry,
          key,
          changed,
          markup: String(
            entry.sharedRow
              ? sharedRowHtml(entry.item)
              : ownRowHtml(entry.item, {
                  selected: String(entry.item.id) === selectedRepId,
                  repSubline,
                }),
          ),
        };
      });
      const wanted = new Set(entries.map((entry) => entry.key));
      const keyOfNode = (row) =>
        row.dataset.repertoireId
          ? `${row.dataset.shared ? "s" : "o"}:${row.dataset.repertoireId}`
          : null;
      const doc = container.ownerDocument;
      const existing = [...container.children];
      const keepable = existing.some((row) => wanted.has(keyOfNode(row)));
      if (keepable) {
        // Rows the new list no longer holds (or holds twice) leave first, so the
        // walk below only meets rows it still wants.
        const byKey = new Map();
        existing.forEach((row) => {
          const key = keyOfNode(row);
          if (!key || !wanted.has(key) || byKey.has(key)) {
            row.remove();
            return;
          }
          byKey.set(key, row);
        });
        // Anything the painter did not put on screen (the cold-start skeleton,
        // an empty state) is gone now, so the whole list starts from nothing.
        const template = doc.createElement("template");
        const nodeFor = (markup) => {
          template.innerHTML = markup;
          const node = template.content.firstElementChild;
          bindRow(node);
          return node;
        };
        let previous = null;
        entries.forEach((entry) => {
          let row = byKey.get(entry.key);
          if (row && entry.changed) {
            const fresh = nodeFor(entry.markup);
            row.replaceWith(fresh);
            row = fresh;
          } else if (!row) {
            row = nodeFor(entry.markup);
          }
          // An unchanged row is only moved when the new list puts it somewhere
          // else, so a reorder is the one case that touches a kept node.
          const expected = previous ? previous.nextElementSibling : container.firstElementChild;
          if (expected !== row) {
            if (previous) previous.after(row);
            else container.prepend(row);
          }
          previous = row;
        });
        for (const key of painted.keys()) {
          if (!wanted.has(key)) painted.delete(key);
        }
      } else {
        // Nothing to keep (first paint, or an empty state becoming rows): one
        // write, and every row is new so every row enters.
        painted.clear();
        entries.forEach((entry) => painted.set(entry.key, String(
          entry.sharedRow
            ? sharedRowHtml(entry.item)
            : ownRowHtml(entry.item, { selected: false, repSubline }),
        )));
        container.innerHTML = entries.map((entry) => entry.markup).join("");
        container.querySelectorAll(".lib-row").forEach(bindRow);
      }
      highlight(container, selectedRepId);
      // Only a row the listing did not show before enters: a kept row, and a
      // row repainted because its counts changed, stay settled.
      enterRows(container, { key: keyOfNode });
      return container.querySelectorAll(".lib-row");
    },
  };
}
