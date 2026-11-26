// Scout → Build: write a scouted line (and its reply) into a repertoire.
//
// A line from the opponent's games carries the moves THEIR opponents chose. Where
// your repertoire already plays a different move at your own turn, writing the line
// would put a second move of yours beside it, so that is said before anything is
// written and you choose to skip it or add it as an alternative.

import { countOf } from "../plural.js";
import { scoutLineText } from "../scout.js";
import { scoutLineKey } from "../scout-report.js";
import {
  addLineToLookup, bestCoveringRepertoireId, copyLookup, divergenceNote, ownMoveDivergence, sameDivergence,
} from "../scout-prep-divergence.js";

const PREVIEW_MAX = 10;
const otherColor = (color) => (color === "white" ? "black" : "white");

export function formatScoutLinePreview(line) {
  const text = line?.sans?.length ? scoutLineText(line.sans) : (line?.ucis || []).join(" ");
  const reply = line?.suggestedReply?.san || line?.suggestedReply?.uci;
  return reply ? `${text} → ${reply}` : text || "Line";
}

/** The moves a write adds: the line, then the suggested reply. */
export function lineUcisToWrite(line) {
  const ucis = [...(line?.ucis || [])];
  if (line?.suggestedReply?.uci) ucis.push(line.suggestedReply.uci);
  return ucis;
}

export function createScoutPrepWriter(deps) {
  const {
    api, setStatus, switchView, showInputModal, createRepertoirePrompt, editRepertoire,
    boardAfterMove, buildProvisionalNode, hardFlushBuild, selectBuildNode, resolveBuildId,
    setBuildSync, notices, getBuildState, getBuildNodeById, queueBuildAdd,
    rememberHandoff = () => {}, loadScoutModule, getScoutState,
  } = deps;
  // Covers the write too: a second click while the first line is still being
  // written would open the picker again and write the line twice.
  let actionBusy = false;

  async function pickRepertoire(oppColor, ownColor, lines = null, { coverLines = lines || [] } = {}) {
    const myColor = ownColor ? oppColor : otherColor(oppColor);
    let reps = [];
    try {
      const payload = await api("/api/repertoires");
      reps = (payload.repertoires || []).filter((r) => r.is_active !== false && r.color === myColor);
    } catch (error) { setStatus(error.message); return null; }
    const scoutState = getScoutState();
    const createNew = async () => {
      const created = await createRepertoirePrompt({
        title: "New repertoire for scout prep",
        defaultName: scoutState?.username ? `vs ${scoutState.username}` : "Opponent prep",
        defaultColor: myColor,
        openAfter: false,
      });
      return created?.repertoire_id || null;
    };
    const batchCount = Array.isArray(lines) ? lines.length : 0;
    if (!reps.length && !batchCount) return createNew();
    const options = [
      ...reps.map((r) => ({ value: r.id, label: `${r.name} (${r.color})` })),
      { value: "__new__", label: "Create new repertoire…" },
    ];
    // The repertoire that already follows these lines furthest is the likely target.
    const preferred = bestCoveringRepertoireId(reps, scoutState?.lookups?.[myColor], coverLines);
    const countLabel = batchCount ? countOf(batchCount, "line") : null;
    const previewGroup = batchCount ? `Lines to add (${batchCount})` : null;
    const previewNotes = batchCount
      ? lines.slice(0, PREVIEW_MAX).map((l) => ({ type: "note", group: previewGroup, label: formatScoutLinePreview(l) }))
      : [];
    if (batchCount > PREVIEW_MAX) {
      previewNotes.push({ type: "note", group: previewGroup, label: `+${batchCount - PREVIEW_MAX} more` });
    }
    const result = await showInputModal({
      title: countLabel ? `Add ${countLabel} to prep` : "Add line to prep",
      okLabel: countLabel ? `Add ${countLabel}` : "Continue",
      fields: [
        { name: "repertoire", label: "Target repertoire", type: "select",
          default: preferred || reps[0]?.id || "__new__", options },
        ...previewNotes,
      ],
    });
    if (!result?.repertoire) return null;
    return result.repertoire === "__new__" ? createNew() : result.repertoire;
  }

  // The target's tree as it is now, for the "second move of yours" check. Scout's own
  // copy is from its Start, so a move added in Build since would be missed. The open
  // repertoire is read from Build (its unsynced moves included); any other from the
  // server. Undefined when it can't be read: the caller then writes nothing.
  async function latestLookup(repId) {
    const scoutModule = await loadScoutModule();
    const build = getBuildState();
    if (build?.repertoire_id === repId && Array.isArray(build.nodes)) return scoutModule.repertoireChildLookup(build.nodes);
    try {
      const payload = await api(`/api/build/load?repertoire_id=${encodeURIComponent(repId)}`, { responseType: "large-json" });
      return scoutModule.repertoireChildLookup(payload?.nodes || []);
    } catch (error) {
      setStatus(`Couldn't read the repertoire, so nothing was added: ${error.message}`, { severity: "error" });
      return undefined;
    }
  }

  // Lines that would add a second move of yours, and whether to write them anyway.
  // Resolves { skip: Set<line> } or null when the dialog was cancelled.
  // Each line is checked against the tree plus the lines before it in the batch, so two
  // lines that put different moves of yours at one position are caught too.
  async function resolveDivergences(lines, lookup, side) {
    const divergent = [];
    const queued = copyLookup(lookup);
    for (const line of lines) {
      const ucis = lineUcisToWrite(line);
      const divergence = ownMoveDivergence(queued, ucis, side);
      if (divergence) divergent.push({ line, divergence });
      else addLineToLookup(queued, ucis);
    }
    if (!divergent.length) return { skip: new Set() };
    const single = lines.length === 1;
    const group = single ? null : `Lines that branch from your own moves (${divergent.length})`;
    const notes = divergent.slice(0, PREVIEW_MAX).map(({ line, divergence }) => ({
      type: "note", group,
      label: single
        ? `This line ${divergenceNote(divergence)} as an alternative move.`
        : `${formatScoutLinePreview(line)} — ${divergenceNote(divergence)}`,
    }));
    if (divergent.length > PREVIEW_MAX) notes.push({ type: "note", group, label: `+${divergent.length - PREVIEW_MAX} more` });
    const choice = single ? [] : [{
      name: "divergent", label: "These lines", type: "select", default: "skip",
      options: [
        { value: "skip", label: `Skip ${divergent.length === 1 ? "it" : `these ${divergent.length}`}` },
        { value: "add", label: "Add as alternative moves" },
      ],
    }];
    const result = await showInputModal({
      title: single ? "Add as an alternative move?" : "Some lines branch from your own moves",
      okLabel: single ? "Add as alternative" : "Continue",
      fields: [...notes, ...choice],
    });
    if (!result) return null;
    const add = single || result.divergent === "add";
    return { skip: add ? new Set() : new Set(divergent.map((d) => d.line)), divergent };
  }

  // `confirmed` is the branch you said yes to for this line (or none), `queued` the ids
  // of the moves this batch has queued. The check before the write read the tree as
  // it was then; this one reads the tree the line is written to, so a move of yours
  // added since (in another tab, say) is not branched from unasked. Such a line is
  // not written: the result is { branches } for the caller to ask about or hold back.
  async function writeLineToRep(line, repId, { reload = true, flush = true, side = null, confirmed = null, queued = null } = {}) {
    const scoutModule = await loadScoutModule();
    const build = getBuildState();
    if (reload || !build || build.repertoire_id !== repId) await editRepertoire(repId);
    const freshBuild = getBuildState();
    if (!freshBuild || freshBuild.repertoire_id !== repId) return null;

    const lookup = scoutModule.repertoireChildLookup(freshBuild.nodes);
    const ucisToWrite = lineUcisToWrite(line);
    if (side) {
      const branches = ownMoveDivergence(lookup, ucisToWrite, side);
      if (branches && !sameDivergence(branches, confirmed) && !queued?.has(branches.yourId)) return { branches };
    }
    const { covered, deepestNodeId } = scoutModule.lineCoverage(lookup, ucisToWrite);
    const remaining = ucisToWrite.slice(covered);
    const alreadyPresent = ucisToWrite.length > 0 && !remaining.length && !String(deepestNodeId || "").startsWith("tmp-");
    let parentId = deepestNodeId;
    let parent = getBuildNodeById?.(parentId) || freshBuild.nodes.find((n) => n.id === parentId);
    let lastNodeId = parentId;

    let complete = true;
    for (const uci of remaining) {
      const existing = freshBuild.nodes.find((n) => n.parent_id === parentId && n.uci === uci);
      if (existing) {
        parentId = existing.id;
        parent = getBuildNodeById?.(parentId) || existing;
        lastNodeId = parentId;
        continue;
      }
      if (!parent) { complete = false; break; }
      let after;
      try { after = await boardAfterMove(parent.fen, uci); } catch { complete = false; break; }
      const node = buildProvisionalNode(parent, uci, after);
      queueBuildAdd(node);
      queued?.add(node.id);
      if (!freshBuild.nodes.includes(node)) freshBuild.nodes.push(node);
      parentId = node.id;
      parent = node;
      lastNodeId = node.id;
      setBuildSync("dirty");
    }

    // Whether the line went in whole and whether it synced are separate: the
    // caller counts the first and reports the second as "not synced yet".
    let syncError = "";
    if (flush) try { await hardFlushBuild(); } catch (error) { syncError = error.message; }
    if (!complete || getBuildState()?.repertoire_id !== repId) {
      setStatus(`Couldn't add the whole line to prep.${syncError ? ` Not synced yet: ${syncError}` : ""}`, { severity: "error" });
      return syncError ? { syncError, incomplete: true } : null;
    }
    if (syncError) { setStatus(syncError, { severity: "error" }); return { syncError }; }
    const resolvedId = resolveBuildId(lastNodeId);
    if (flush) await selectBuildNode(resolvedId);
    rememberHandoff({
      source: "scout",
      reason: "scout-add-to-prep",
      lineUcis: ucisToWrite,
      lineSans: line.sans || [],
      side,
      repertoireId: repId,
    });
    if (flush) switchView("build");
    return alreadyPresent ? { nodeId: resolvedId, alreadyPresent: true } : resolvedId;
  }

  async function addToPrep(line, oppColor, { ownColor = false } = {}) {
    if (actionBusy) return;
    actionBusy = true;
    try {
      const repId = await pickRepertoire(oppColor, ownColor, null, { coverLines: [line] });
      if (!repId) return;
      const side = ownColor ? oppColor : otherColor(oppColor);
      const lookup = await latestLookup(repId);
      if (!lookup) return;
      const decision = await resolveDivergences([line], lookup, side);
      if (!decision) { setStatus("Nothing added to prep."); return; }
      let res = await writeLineToRep(line, repId, { side, confirmed: decision.divergent?.[0]?.divergence });
      if (res?.branches) {
        // The tree changed since the check: ask again about the tree as it is now.
        const scoutModule = await loadScoutModule();
        const again = await resolveDivergences([line], scoutModule.repertoireChildLookup(getBuildState()?.nodes || []), side);
        if (!again) { setStatus("Nothing added to prep."); return; }
        res = await writeLineToRep(line, repId, { reload: false, side, confirmed: res.branches });
        if (res?.branches) { setStatus("Nothing added to prep: your repertoire changed again."); return; }
      }
      const at = line.suggestedReply?.san || line.sans?.at(-1) || "position";
      if (res && !res.syncError) setStatus(res.alreadyPresent ? `Already in prep. Opened at ${at}.` : `Added line to prep. Opened at ${at}.`);
    } finally {
      actionBusy = false;
    }
  }

  async function runPrepareAll(lines, oppColor) {
    const unique = [];
    const seen = new Set();
    for (const line of lines) {
      const key = scoutLineKey(line.ucis);
      if (!seen.has(key)) { seen.add(key); unique.push(line); }
    }
    if (!unique.length) { setStatus("No lines to add"); return; }
    if (notices.isBusy()) { setStatus("Another job is running"); return; }
    const repId = await pickRepertoire(oppColor, false, unique);
    if (!repId) return;
    const side = otherColor(oppColor);
    const lookup = await latestLookup(repId);
    if (!lookup) return;
    const decision = await resolveDivergences(unique, lookup, side);
    if (!decision) { setStatus("Nothing added to prep."); return; }
    const toWrite = unique.filter((line) => !decision.skip.has(line));
    const skipped = unique.length - toWrite.length;
    if (!toWrite.length) { setStatus(`Nothing added: ${countOf(skipped, "line")} skipped`); return; }
    if (notices.isBusy()) { setStatus("Another job is running"); return; }

    const ctrl = new AbortController();
    notices.startJob({
      id: `scout-prep-${Date.now()}`,
      title: "Add Scout Lines",
      tab: "build",
      total: toWrite.length,
      onCancel: () => ctrl.abort(),
    });
    const confirmed = new Map((decision.divergent || []).map(({ line, divergence }) => [line, divergence]));
    const queued = new Set();
    let done = 0, written = 0, alreadyPresent = 0, failed = 0, heldBack = 0, syncError = "";
    for (const line of toWrite) {
      if (ctrl.signal.aborted) break;
      notices.updateJob({ current: done, total: toWrite.length, message: `Adding ${done + 1}/${toWrite.length}` });
      try {
        const res = await writeLineToRep(line, repId, {
          reload: done === 0,
          flush: done === toWrite.length - 1,
          side,
          confirmed: confirmed.get(line),
          queued,
        });
        if (res?.branches) heldBack++;
        else if (res?.syncError) { syncError = res.syncError; if (res.incomplete) failed++; else written++; }
        else if (res && typeof res === "object" && res.alreadyPresent) alreadyPresent++;
        else if (res) written++;
        else failed++;
      } catch { failed++; }
      done++;
    }
    // Only the last line flushes. Stopped earlier, the lines already queued would
    // stay unsaved on this device until some later Build save.
    // A held-back last line skipped the flush the last line does.
    if (done > 0 && (done < toWrite.length || heldBack)) {
      try { await hardFlushBuild(); } catch (error) { syncError = error.message; }
    }
    // A failed sync stays in the result: the lines are still only on this device.
    const message = `Added ${countOf(written, "line")} to prep${alreadyPresent ? ` (${alreadyPresent} already present)` : ""}${skipped ? ` · ${skipped} skipped` : ""}${heldBack ? ` · ${heldBack} held back: your repertoire changed since the check` : ""}${failed ? ` · ${failed} failed` : ""}${syncError ? ` · not synced yet: ${syncError}` : ""}`;
    notices.completeJob({
      title: syncError ? "Not synced" : ctrl.signal.aborted ? "Stopped" : failed ? "Finished with errors" : "Lines added",
      message,
    });
    setStatus(message, ...(syncError ? [{ severity: "error" }] : []));
  }

  async function prepareAll(lines, oppColor) {
    if (actionBusy) return;
    actionBusy = true;
    try { await runPrepareAll(lines, oppColor); } finally { actionBusy = false; }
  }

  return { addToPrep, prepareAll, writeLineToRep };
}
