import { prepareCoverageReply } from "../coverage-plan.js";

export async function previewCoverageReplies(gaps, { isValid }, deps) {
  const { isBuildReadOnly, isBrowserEngineAvailable, unavailableMessage, jobToast,
    hardFlushBuild, captureBuildContext, getBuild, effectiveMaiaRating, effectiveStockfishDepth,
    getGenerator, getProvider, showConfirmModal, postJson, classifySyncError, hydrateBuild,
    trainRepertoire } = deps;
  if (isBuildReadOnly()) throw new Error("Copy this repertoire to add replies");
  if (!isBrowserEngineAvailable()) throw new Error(unavailableMessage);
  if (jobToast.isBusy()) throw new Error("Another job is running");
  await hardFlushBuild();
  if (!isValid()) throw new Error("Preparation changed; check again");
  const isCurrent = captureBuildContext();
  const snapshot = getBuild();
  const controller = new AbortController();
  const ready = [], failures = [];
  const rating = effectiveMaiaRating();
  jobToast.startJob({ id: `coverage-preview-${Date.now()}`, title: "Previewing replies",
    tab: "build", dock: document.getElementById("coverage-job-dock"), total: gaps.length,
    onCancel: () => controller.abort() });
  try {
    const { runBrowserBuildGenerate } = await getGenerator();
    for (const gap of gaps) {
      if (controller.signal.aborted || !isCurrent() || !isValid()) break;
      try {
        ready.push(await prepareCoverageReply({ build: snapshot, gap, signal: controller.signal,
          rating, depth: effectiveStockfishDepth(),
          generate: (options) => runBrowserBuildGenerate({ ...options, maiaProvider: getProvider() }),
        }));
      } catch (error) {
        if (error.name === "AbortError") break;
        failures.push(`${gap.moveSan}: ${error.message}`);
      }
      jobToast.updateJob({ current: ready.length + failures.length, total: gaps.length,
        message: `${ready.length} ready${failures.length ? `, ${failures.length} failed` : ""}` });
    }
    if (controller.signal.aborted || !isCurrent() || !isValid()) {
      jobToast.cancelJob("Reply preview stopped");
      return;
    }
    if (!ready.length) throw new Error(failures.join("; ") || "No replies generated");
    jobToast.completeJob({ title: "Replies previewed", message: `${ready.length} ready${failures.length ? `, ${failures.length} failed` : ""}` });
    const text = ready.map((r) => `${r.gap.pathSans.join(" ")} ${r.gap.moveSan}: ${r.sans.join(" ")} (+${r.addedMoves} moves)`).join("\n");
    const approved = await showConfirmModal({ title: "Add prepared replies?",
      body: text + (failures.length ? `\nFailed: ${failures.join("; ")}` : ""), okLabel: "Add replies" });
    if (!approved) return;
    if (!isCurrent() || !isValid() || isBuildReadOnly()) throw new Error("Preparation changed; check again");
    const root = snapshot.nodes.find((n) => n.depth === 0);
    const changes = ready.flatMap((r, index) => r.plan.changes.map((change) => {
      const renamed = { ...change };
      for (const field of ["tempId", "parentRef", "nodeRef"]) {
        if (typeof renamed[field] === "string" && renamed[field].startsWith("tmp-")) {
          renamed[field] = `tmp-coverage-${index}-${renamed[field].slice(4)}`;
        }
      }
      return renamed;
    }));
    const request = {
      repertoire_id: snapshot.repertoire_id, base_revision: snapshot.revision,
      root_node_id: root.id, plan: { rootNodeId: root.id, changes },
      operation_id: crypto.randomUUID(),
    };
    let payload;
    try { payload = await postJson("/api/build/generate/apply-plan", request); }
    catch (error) {
      if (!classifySyncError(error).retriable || !isCurrent()) throw error;
      const retry = await showConfirmModal({ title: "Save not confirmed",
        body: error.message, okLabel: "Retry same save" });
      if (!retry || !isCurrent()) throw error;
      payload = await postJson("/api/build/generate/apply-plan", request);
    }
    if (isCurrent()) {
      await hydrateBuild(payload, ready[0].rootNodeId);
      const train = await showConfirmModal({ title: "Replies added",
        body: `${payload.summary?.added_nodes || 0} moves added`, okLabel: "Practice replies", cancelLabel: "Stay in Build" });
      if (train && isCurrent()) {
        const targets = ready.flatMap((r, index) => r.ownNodeRefs.map((ref) =>
          payload.id_map?.[`tmp-coverage-${index}-${ref.slice(4)}`])).filter(Boolean);
        if (!targets.length) throw new Error("Saved replies could not be located; reopen training");
        await trainRepertoire(snapshot.repertoire_id, { targetNodeIds: targets, fresh: true });
      }
    }
  } catch (error) {
    if (error.name === "AbortError") jobToast.cancelJob("Reply preview stopped");
    else { if (jobToast.isBusy()) jobToast.failJob(error.message); throw error; }
  }
}
