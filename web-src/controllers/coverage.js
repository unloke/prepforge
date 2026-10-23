import { html } from "../html.js";
import { enterRows } from "../list-enter.js";
import { countOf } from "../plural.js";
import { coverageTreeKey, runCoverageScan } from "../coverage.js";
import { encodeLine } from "../move-text.js";
import { maiaInitMessage } from "../maia-init-notice.js";

// A share that rounds to nothing but is not nothing reads "<0.1%": a real
// 0.05% remainder printed as "0.0%" made the summary look like it did not add up.
function formatMass(value) {
  if (value > 0 && value < 0.05) return "<0.1%";
  return `${value.toFixed(1)}%`;
}

// Scope, horizon and Scan live in the inspector header row (like Explorer's
// database switch; app.js wires them); the panel body only shows the scan
// state and its gaps. The controls are the source of truth for scope/horizon.
export function createCoverageController({
  getContext, getProvider, selectNode,
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
  const pct = (n) => formatMass(n * 100);

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
  // The summary is ONE breakdown of the same mass, and its figures are printed
  // to a tenth: whatever a share's own rounding leaves over goes to the next
  // one, so the printed prepared + missing + unchecked is never over 100%.
  // A share that rounds to nothing is not printed as "0.0%" (with a 1.2% gap
  // the page read "0.0% prepared / 100.0% missing / <0.1% unchecked"): the
  // least significant remainder reads "<0.1%", and a figure that is exactly
  // zero says so without a tenth.
  function shares() {
    const tenths = (mass) => Math.round(mass * 1000);
    const hasUnknown = result.unknownMass > 0;
    const preparedTenths = tenths(result.coveredMass);
    // Unchecked keeps at least a tenth of the scale when there is any of it,
    // and missing takes what the other two leave (never more than its own
    // rounded share). With prepared at 0.0% the remainder goes to a share that
    // is actually printed as a number: "<0.1% covered / 99.9% missing /
    // <0.1% unchecked" left the reader adding up the wrong pair.
    const uncheckedTenths = hasUnknown ? Math.max(1, tenths(result.unknownMass)) : 0;
    const missingTenths = hasUnknown
      ? Math.min(tenths(result.gapMass), Math.max(0, 1000 - preparedTenths - uncheckedTenths))
      : tenths(result.gapMass);
    const figure = (value) => (value > 0 && value < 1 ? "<0.1%" : `${value.toFixed(1)}%`);
    return {
      prepared: figure(preparedTenths / 10),
      missing: figure(missingTenths / 10),
      unchecked: hasUnknown ? figure(uncheckedTenths / 10) : "",
      aria: hasUnknown
        ? `${figure(preparedTenths / 10)} prepared, ${figure(missingTenths / 10)} missing, ${figure(uncheckedTenths / 10)} unchecked`
        : `${figure(preparedTenths / 10)} prepared, ${figure(missingTenths / 10)} missing`,
    };
  }
  // What the gaps are, in the same words the rows use: the number on the tab
  // is their total.
  function gapKinds() {
    const missingReply = result.gaps.filter((g) => g.kind === "missing_reply").length;
    const missingBranch = result.gaps.length - missingReply;
    const parts = [];
    if (missingReply) parts.push(countOf(missingReply, "missing reply", "missing replies"));
    if (missingBranch) parts.push(countOf(missingBranch, "missing branch", "missing branches"));
    if (result.omittedGapCount) parts.push(`${result.omittedGapCount} not listed`);
    return parts.join(" · ");
  }
  function summary() {
    const status = result.scannedNodes ? countOf(result.scannedNodes, "position") : "No opponent positions";
    const s = shares();
    const unchecked = s.unchecked ? html`<span>${s.unchecked} unchecked</span>` : "";
    return html`<div class="coverage-summary" aria-live="polite"><div><b>${s.prepared} prepared</b><span>${status}</span></div>
      <div class="coverage-mass" role="img" aria-label="${s.aria}"><i class="is-covered" style="width:${result.coveredMass * 100}%"></i><i class="is-gap" style="width:${result.gapMass * 100}%"></i><i class="is-unknown" style="width:${result.unknownMass * 100}%"></i></div>
      <div class="coverage-totals"><span>${s.missing} missing</span>${unchecked}</div>
      ${result.totalGapCount ? html`<div class="coverage-kinds">${gapKinds()}</div>` : ""}</div>`;
  }
  function gapRows(readOnly) {
    let markup = readOnly ? "" : html`<div class="coverage-complete-bar"><label class="coverage-selall"><input type="checkbox" id="coverage-selectall" />Select all</label><button type="button" class="btn primary" id="coverage-complete" data-testid="coverage-complete" disabled>Preview replies</button></div>`;
    markup = html`${markup}${result.gaps.map((gap, i) => {
      const path = gap.pathSans.join(" ") || "Start";
      const state = gap.kind === "missing_reply" ? "No reply" : "Missing branch";
      const check = readOnly ? "" : html`<label class="coverage-gap-select"><input type="checkbox" class="coverage-gap-check" data-index="${i}" aria-label="Select ${path + " " + gap.moveSan}" /></label>`;
      return html`<div class="coverage-gap${readOnly ? " is-readonly" : ""}" data-index="${i}">${check}
        <button type="button" class="coverage-gap-body" data-gap="${i}" title="Preview this opponent move"><span class="coverage-gap-path">${path}</span><span class="coverage-gap-line"><b class="coverage-gap-move" data-mt="${encodeLine(gap.fen, [gap.moveUci])}" data-p="0">${gap.moveSan}</b><span class="coverage-gap-meta">${state}</span><b class="coverage-gap-impact">${pct(gap.impact)}</b></span><span class="coverage-gap-track"><i style="width:${gap.impact * 100}%"></i></span></button></div>`;
    })}`;
    return markup;
  }
  // Before the first position the only thing to report is the Maia cold init
  // itself (it fetches ~46 MB), which must show up here instead of leaving the
  // panel at "0 positions" with no explanation.
  function liveText() {
    if (!active) return "";
    return active.init ? maiaInitMessage(active.init) : `Scanning · ${countOf(active.scanned, "position")}`;
  }
  function paint() {
    const el = host();
    if (!el) return;
    const badge = document.getElementById("build-coverage-count");
    if (badge) {
      // The tab's count is what is left to prepare: the gaps the last scan
      // found, which the one line above them spells out ("2 missing replies ·
      // 1 missing branch") so a bare number never stands alone.
      const n = result && !stale ? result.totalGapCount || 0 : 0;
      badge.hidden = !n;
      badge.textContent = String(n);
      const text = n ? `${countOf(n, "gap")} from the last scan` : "";
      badge.title = text;
      badge.setAttribute("aria-label", text);
    }
    const c = getContext();
    let body = "";
    if (!c.build) body = "";
    else if (active) body = html`<div class="coverage-live" role="status" aria-live="polite">${liveText()}</div>`;
    else if (stale) body = html`<div class="coverage-stale" role="status">Preparation changed — scan again</div>`;
    else if (result) {
      body = summary();
      if (!result.gaps.length) {
        body = html`${body}<div class="coverage-live" role="status">${result.unknownMass > 0 ? "No gaps in checked positions" : "No gaps"}</div>`;
      } else body = html`${body}${gapRows(c.readOnly)}`;
    } else {
      // The empty state names the action, not the feature: what a scan is for
      // lives in the ⓘ beside it.
      body = html`<p class="coverage-live" role="status" data-testid="coverage-empty">Press Scan to check this line.</p>`;
    }
    el.innerHTML = body;
    // Gaps the panel already showed stay put through a repaint; a new scan's enter.
    enterRows(el, { key: (row) => row.dataset.index != null ? `${row.textContent}` : row.className });
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
        // The position the gap comes from, on the board: the missing move is
        // named in the row, and playing it is the user's own edit.
        const gap = result.gaps[Number(n.dataset.gap)];
        await selectNode(gap.nodeId);
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
    const run = { controller: new AbortController(), scanned: 0, key: identity, init: { phase: "session" } };
    active = run;
    const nodes = c.build.nodes.map((n) => ({ ...n }));
    job.startJob({ id: `coverage-${Date.now()}`, title: "Scanning coverage", tab: "build",
      dock: document.getElementById("coverage-job-dock"), total: 0, onCancel: () => run.controller.abort() });
    // No denominator exists (positions are only known as they are read), so the
    // card's bar stays indeterminate until the first position lands.
    job.updateJob({ phase: "init", message: maiaInitMessage(run.init), current: 0, total: 0 });
    paint(); sync();
    // The first position needs a warm provider. A cold Maia spends seconds to
    // minutes fetching ~46 MB before it answers anything, and that wait used to
    // be invisible: the panel said "Scanning · 0 positions" until the first
    // reply. Watch the provider's own init progress and report the real step.
    const provider = getProvider();
    let unwatchInit = null;
    if (provider && typeof provider.subscribeInitProgress === "function") {
      unwatchInit = provider.subscribeInitProgress((progress) => {
        if (active !== run || !maiaInitMessage(progress)) return;
        run.init = progress;
        job.updateJob({ phase: `init:${progress.phase}`, message: maiaInitMessage(progress) });
        paint();
      });
    }
    try {
      const next = await runCoverageScan({ nodes, myColor: c.build.color, rating: c.rating,
        rootNodeId: scopeNodeId, maxDepth: maxDepth(),
        provider, signal: run.controller.signal,
        onProgress: ({ scanned }) => {
          if (active !== run) return;
          run.scanned = scanned;
          run.init = null;
          job.updateJob({ phase: "scan", current: scanned, total: 0, message: countOf(scanned, "position") });
          paint();
        } });
      if (active !== run || run.key !== key()) { job.cancelJob("Scan discarded"); return; }
      result = next;
      job.completeJob({ title: "Coverage scanned", message: `${pct(next.coveredMass)} prepared` });
    } catch (error) {
      if (active !== run) return;
      if (error.name === "AbortError") job.cancelJob("Scan stopped");
      else { job.failJob(error.message); onError(error); }
    } finally {
      unwatchInit?.();
      if (active === run) { active = null; paint(); sync(); }
    }
  }
  return { scan, sync, clear, paint, invalidate, isValid: valid };
}
