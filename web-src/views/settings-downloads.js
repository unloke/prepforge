import { html } from "../html.js";
import { deleteDownload, downloadState, formatMB, refreshDownloads, startDownload, subscribeDownloads } from "../engine/engine-downloads.js";
import { ENGINE_NAMES } from "../engine-unlock.js";

// One row per optional engine: where it stands in this browser, its size, and
// the one action that moves it on (download, retry, or delete to free the space).
const STATUS = {
  checking: ["Checking…", ""],
  absent: ["Not downloaded", ""],
  downloading: ["Downloading", "warn"],
  ready: ["Ready", "ok"],
  error: ["Error", "err"],
  unsupported: ["Not on this device", ""],
};

export function downloadRowHtml(s) {
  const [label, tone] = STATUS[s.phase] || STATUS.absent;
  const pct = s.fraction == null ? null : Math.round(s.fraction * 100);
  const pill = s.phase === "downloading" ? (pct == null || pct >= 100 ? "Preparing" : `${label} ${pct}%`)
    : s.phase === "ready" ? `${label} · ${s.version}` : label;
  const action = s.phase === "absent" ? html`<button type="button" class="btn sm primary" data-dl="get">Download</button>`
    : s.phase === "error" ? html`<button type="button" class="btn sm" data-dl="get">Retry</button>`
    : s.phase === "ready" ? html`<button type="button" class="btn sm danger ghost" data-dl="delete">Delete</button>`
    : "";
  const sub = s.phase === "error" ? html`<p class="dl-line is-err" role="alert">${s.error}</p>`
    : s.note ? html`<p class="dl-line">${s.note}</p>` : "";
  const bar = s.phase === "downloading"
    ? html`<span class="dl-bar${pct == null ? " is-busy" : ""}" role="progressbar" aria-label="${ENGINE_NAMES[s.id]} download" aria-valuemin="0" aria-valuemax="100"${pct == null ? "" : html` aria-valuenow="${pct}"`}><i style="width:${pct ?? 0}%"></i></span>` : "";
  return html`<div class="dl-head"><span class="dl-text"><b>${ENGINE_NAMES[s.id]}</b><span class="dl-size">${formatMB(s.bytes)}</span></span><span class="status-pill ${tone}" data-testid="settings-dl-status-${s.id}">${pill}</span>${action}</div>${bar}${sub}`;
}

export function createSettingsDownloads({ showConfirmModal, setPref }) {
  const rows = () => ["stockfish", "maia"].map((id) => [id, document.getElementById(`settings-dl-${id}`)]).filter(([, el]) => el);

  function render() {
    for (const [id, el] of rows()) {
      const markup = String(downloadRowHtml(downloadState(id)));
      if (el.dlMarkup !== markup) el.innerHTML = el.dlMarkup = markup;
    }
  }

  async function remove(id) {
    const s = downloadState(id);
    const ok = await showConfirmModal({
      title: `Delete ${ENGINE_NAMES[id]}?`,
      body: id === "maia"
        ? `Frees ${formatMB(s.bytes)}. Maia analysis turns off; anything that needs Maia downloads it again.`
        : `Frees ${formatMB(s.bytes)}. Analysis runs on the lite engine until you download it again.`,
      okLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    if (id === "maia") setPref("maiaAnalysis", false);
    await deleteDownload(id);
  }

  let bound = false;
  function bind() {
    if (bound) return () => {};
    bound = true;
    for (const [id, el] of rows()) {
      el.addEventListener("click", (event) => {
        const act = event.target.closest("[data-dl]")?.dataset.dl;
        if (act === "get") void startDownload(id);
        else if (act === "delete") void remove(id);
      });
    }
    return subscribeDownloads(render);
  }

  return { render, bind, refresh: refreshDownloads };
}
