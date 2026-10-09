import { html } from "../html.js";
import { coverageTreeKey, runCoverageScan } from "../coverage.js";
import { localBoardAfterMove } from "../chess-local.js";

// Scope, horizon and Scan live in the inspector header row (like Explorer's
// database switch; app.js wires them); the panel body only shows the scan
// state and its gaps. The controls are the source of truth for scope/horizon.
export function createCoverageController({
  getContext, getProvider, selectNode, getBoard,
  previewReplies, getJob, onError,
}) {
  let result = null;
  let identity = null;
  let active = null;
  let scopeNodeId = null;
  let stale = false;
  const scope = () =>
    document.querySelector("#coverage-scope .is-active")?.dataset.scope === "branch" ? "branch" : "repertoire";
  const maxDepth = () => Number(document.getElementById("coverage-depth")?.value) || 16;
  const host = () => document.getElementById("coverage-gaps");
  // A rare but real gap reads "<0.1%", never a misleading "0.0%".
  const pct = (n) => (n > 0 && n < 0.0005 ? "<0.1%" : `${(n * 100).toFixed(1)}%`);

  function previewGap(gap) {
    const board = getBoard();
    if (!board) return;
    const after = localBoardAfterMove(gap.fen, gap.moveUci);
    const exit = document.getElementById("build-pv-exit");
    board.beginPreview({ onEnd: () => { if (exit) exit.hidden = true; } });
    board.showPreview({ fen: after.board.fen, lastMove: gap.moveUci });
    if (exit) { exit.hidden = false; exit.textContent = "Back to preparation"; }
  }
  function key() {
    const c = getContext();
    return JSON.stringify([c.ownerId, c.ownerGeneration, c.build?.repertoire_id,
      c.build?.revision, c.rating, c.modelVersion, scope(), scopeNodeId, maxDepth(),
      coverageTreeKey(c.build?.nodes)]);
  }
  function valid() { return identity === key() && !stale; }
  function invalidate() {
    scopeNodeId = scope() === "branch" ? getContext().selectedNodeId : null;
    if (identity) stale = true;
    if (active) active.controller.abort();
    paint();
    sync();
  }
  function sync() {
    if (identity && !valid()) {
      stale = true;
      if (active) active.controller.abort();
      paint();
    }
    const run = document.getElementById("coverage-run");
    if (run) {
      run.disabled = !!active || !getContext().build;
      run.title = `Scan with Maia ${getContext().rating}`;
    }
  }
  function clear() {
    if (active) { active.controller.abort(); getJob().cancelJob("Scan stopped"); }
    active = null;
    result = null;
    identity = null;
    stale = false;
    scopeNodeId = null;
    paint();
    sync();
  }
  function summary() {
    const status = result.scannedNodes ? `${result.scannedNodes} positions` : "No opponent positions";
    return html`<div class="coverage-summary" aria-live="polite"><div><b>${pct(result.coveredMass)} prepared</b><span>${status}</span></div>
      <div class="coverage-mass" role="img" aria-label="${pct(result.coveredMass)} prepared, ${pct(result.gapMass)} missing, ${pct(result.unknownMass)} unchecked">
        <i class="is-covered" style="width:${result.coveredMass * 100}%"></i><i class="is-gap" style="width:${result.gapMass * 100}%"></i><i class="is-unknown" style="width:${result.unknownMass * 100}%"></i></div>
      <div class="coverage-totals"><span>${pct(result.gapMass)} missing</span><span>${pct(result.unknownMass)} unchecked${result.status === "partial" ? " · partial" : ""}</span></div></div>`;
  }
  function gapRows(readOnly) {
    let markup = readOnly ? "" : html`<div class="coverage-complete-bar"><label class="coverage-selall"><input type="checkbox" id="coverage-selectall" />Select all</label><button type="button" class="btn primary" id="coverage-complete" data-testid="coverage-complete" disabled>Preview replies</button></div>`;
    markup = html`${markup}${result.gaps.map((gap, i) => {
      const path = gap.pathSans.join(" ") || "Start";
      const state = gap.kind === "missing_reply" ? "No reply" : "Missing branch";
      const check = readOnly ? "" : html`<label class="coverage-gap-select"><input type="checkbox" class="coverage-gap-check" data-index="${i}" aria-label="Select ${path + " " + gap.moveSan}" /></label>`;
      return html`<div class="coverage-gap${readOnly ? " is-readonly" : ""}" data-index="${i}">${check}
        <button type="button" class="coverage-gap-body" data-gap="${i}" title="Preview this opponent move"><span class="coverage-gap-path">${path}</span><span class="coverage-gap-line"><b class="coverage-gap-move">${gap.moveSan}</b><span class="coverage-gap-meta">${state}</span><b class="coverage-gap-impact">${pct(gap.impact)}</b></span><span class="coverage-gap-track"><i style="width:${gap.impact * 100}%"></i></span></button></div>`;
    })}`;
    if (result.omittedGapCount) markup = html`${markup}<div class="coverage-live">${result.omittedGapCount} more gaps</div>`;
    return markup;
  }
  function paint() {
    const el = host();
    if (!el) return;
    const badge = document.getElementById("build-coverage-count");
    if (badge) { badge.hidden = !result || stale || !result.totalGapCount; badge.textContent = String(result?.totalGapCount || 0); }
    const c = getContext();
    let body = "";
    if (!c.build) body = "";
    else if (active) body = html`<div class="coverage-live" role="status">Scanning · ${active.scanned} positions</div>`;
    else if (stale) body = html`<div class="coverage-stale" role="status">Preparation changed — scan again</div>`;
    else if (result) {
      body = summary();
      if (!result.gaps.length) {
        body = html`${body}<div class="coverage-live" role="status">${result.unknownMass > 0 ? "No gaps in checked positions" : "No gaps"}</div>`;
      } else body = html`${body}${gapRows(c.readOnly)}`;
    }
    el.innerHTML = body;
    const checks = () => [...el.querySelectorAll(".coverage-gap-check")];
    const selectAll = el.querySelector("#coverage-selectall");
    const complete = el.querySelector("#coverage-complete");
    const update = () => {
      const all = checks(), selected = all.filter((n) => n.checked).length;
      if (complete) { complete.disabled = !selected || !valid(); complete.textContent = selected ? `Preview ${selected} repl${selected === 1 ? "y" : "ies"}` : "Preview replies"; }
      if (selectAll) { selectAll.checked = selected > 0 && selected === all.length; selectAll.indeterminate = selected > 0 && selected < all.length; }
    };
    selectAll?.addEventListener("change", () => { checks().forEach((n) => { n.checked = selectAll.checked; }); update(); });
    checks().forEach((n) => n.addEventListener("change", update));
    complete?.addEventListener("click", () => {
      if (!valid()) { sync(); return; }
      const chosen = checks().filter((n) => n.checked).map((n) => result.gaps[Number(n.dataset.index)]);
      void previewReplies(chosen, { isValid: valid }).catch(onError);
    });
    el.querySelectorAll("[data-gap]").forEach((n) => n.addEventListener("click", async () => {
      if (!valid()) { sync(); return; }
      try {
        const gap = result.gaps[Number(n.dataset.gap)];
        await selectNode(gap.nodeId);
        if (valid()) previewGap(gap);
      } catch (error) { onError(error); }
    }));
  }
  async function scan() {
    sync();
    if (active || !getContext().build) return;
    const job = getJob();
    if (job.isBusy()) { onError(new Error("Another job is running")); return; }
    scopeNodeId = scope() === "branch" ? getContext().selectedNodeId : null;
    const c = getContext();
    identity = key();
    result = null;
    stale = false;
    const run = { controller: new AbortController(), scanned: 0, key: identity };
    active = run;
    const nodes = c.build.nodes.map((n) => ({ ...n }));
    job.startJob({ id: `coverage-${Date.now()}`, title: "Scanning coverage", tab: "build",
      dock: document.getElementById("coverage-job-dock"), total: 0, onCancel: () => run.controller.abort() });
    paint(); sync();
    try {
      const next = await runCoverageScan({ nodes, myColor: c.build.color, rating: c.rating,
        rootNodeId: scopeNodeId, maxDepth: maxDepth(),
        provider: getProvider(), signal: run.controller.signal,
        onProgress: ({ scanned }) => {
          if (active !== run) return;
          run.scanned = scanned;
          job.updateJob({ current: scanned, total: 0, message: `${scanned} positions` });
          const live = host()?.querySelector(".coverage-live");
          if (live) live.textContent = `Scanning · ${scanned} positions`;
        } });
      if (active !== run || run.key !== key()) { job.cancelJob("Scan discarded"); return; }
      result = next;
      job.completeJob({ title: "Coverage scanned", message: `${pct(next.coveredMass)} prepared${next.status === "partial" ? " · partial" : ""}` });
    } catch (error) {
      if (active !== run) return;
      if (error.name === "AbortError") job.cancelJob("Scan stopped");
      else { job.failJob(error.message); onError(error); }
    } finally {
      if (active === run) { active = null; paint(); sync(); }
    }
  }
  return { scan, sync, clear, paint, invalidate, isValid: valid };
}
