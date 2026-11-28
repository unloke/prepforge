// Smart-queue retry scheduler (Chessbook / MoveTrainer / FSRS style):
// - Reconstructs the full root-to-target run-in when extracting a mid-line
//   target so the retry card animates from the shared opening prefix.
// - Spaces retries by failure severity: tighter (+2) after an answer reveal or
//   timeout, standard (requeueGap, +3) on a first-try miss, wider (+4) after a
//   hinted recall.
// - Two-stage graduation for revealed/timed-out blind spots: passing Stage 1
//   unaided schedules a delayed Stage 2 confirmation (+4 cards) before graduating.
// - Prevents 0-card visual echo at the queue tail by inserting a distinct
//   already-seen position as an ungraded spacer when available.
// - Preserves path order when multiple targets on the same card are missed.
export const MAX_RETRIES_PER_TARGET = 3;

export function standaloneRetryTarget(card, target) {
  const list = card?.targets;
  if (!Array.isArray(list) || list.length <= 1) return target;
  const idx = list.findIndex((t) => t?.node_id === target?.node_id);
  if (idx <= 0) return target;
  const prefix = [];
  for (let i = 0; i < idx; i += 1) {
    const prev = list[i];
    if (!prev?.uci || !prev?.fen_after) return target;
    if (prev.run_in?.length) prefix.push(...prev.run_in);
    prefix.push({ uci: prev.uci, san: prev.san, fen_after: prev.fen_after });
    if (prev.reply?.uci && prev.reply?.fen_after) prefix.push(prev.reply);
  }
  if (target.run_in?.length) prefix.push(...target.run_in);
  return {
    ...target,
    start_fen: list[0].start_fen || target.start_fen,
    run_in: prefix,
  };
}

function gapForSeverity(baseGap, severity) {
  const base = Math.max(1, Number(baseGap) || 3);
  if (severity === "reveal") return Math.max(2, base - 1);
  if (severity === "hint" || severity === "stage2") return base + 1;
  return base;
}

function minOrderIndex(smart, card, target) {
  const list = card?.targets;
  if (!Array.isArray(list) || list.length <= 1) return 0;
  const idx = list.findIndex((t) => t?.node_id === target?.node_id);
  if (idx <= 0) return 0;
  const earlierIds = new Set(list.slice(0, idx).map((t) => t?.node_id).filter(Boolean));
  let floor = 0;
  for (let i = smart.cardIndex + 1; i < smart.queue.length; i += 1) {
    if (smart.queue[i]?.targets?.some((t) => earlierIds.has(t.node_id))) floor = i + 1;
  }
  return floor;
}

export function recordSessionMiss(holder, nodeId, detail = null) {
  if (!holder || !nodeId) return;
  holder.missedNodeIds ||= [];
  if (!holder.missedNodeIds.includes(nodeId)) holder.missedNodeIds.push(nodeId);
  if (detail?.san) {
    holder.missedItems ||= [];
    if (!holder.missedItems.some((it) => it.nodeId === nodeId)) {
      holder.missedItems.push({ nodeId, ...detail });
    }
  }
}

function pickTailSpacer(smart, target) {
  if (!target?.fen_before) return null;
  for (let i = smart.cardIndex - 1; i >= 0; i -= 1) {
    const candidate = smart.queue[i];
    if (!candidate || candidate.kind === "new") continue;
    const first = candidate.targets?.[0];
    if (!first?.fen_before || first.fen_before === target.fen_before || first.node_id === target.node_id) continue;
    const kind = candidate.kind === "new" ? "due" : candidate.kind;
    const rep = String(candidate.encoded).split(":")[1];
    return {
      ...candidate,
      kind,
      targets: [standaloneRetryTarget(candidate, first)],
      retry: true,
      spacer: true,
      encoded: `${kind}:${rep}:${first.node_id}:retry`,
    };
  }
  return null;
}

export function requeueMissedTarget(smart, target, options = {}) {
  const card = smart?.queue?.[smart.cardIndex];
  if (!card || !target) return { added: false, pending: false };

  // Two-stage graduation check: passing Stage 1 unaided schedules Stage 2 (+4).
  if (options.stageAdvance) {
    if (!card.retry || !(card.stages > (card.stage || 1))) return { added: false, pending: false };
    return scheduleRetryCard(smart, card, target, {
      severity: "stage2",
      stage: (card.stage || 1) + 1,
      stages: card.stages,
    });
  }

  if (options.scored !== false && card.kind !== "new" && !card.retry) {
    recordSessionMiss(smart, target.node_id, {
      san: target.san,
      uci: target.uci,
      line: target.line || "",
      fenBefore: target.fen_before || null,
      fenAfter: target.fen_after || null,
      repertoireName: card.repertoire_name || smart.repertoireName || "",
    });
  }

  const severity = options.severity || (smart.attempt >= 2 ? "reveal" : "miss");
  const desiredGap = gapForSeverity(smart.requeueGap, severity);
  const existingOffset = smart.queue
    .slice(smart.cardIndex + 1)
    .findIndex((c) => !c?.spacer && c.targets?.some((t) => t.node_id === target.node_id));

  if (existingOffset >= 0) {
    const existingIdx = smart.cardIndex + 1 + existingOffset;
    const existing = smart.queue[existingIdx];
    if (severity === "reveal" && existing?.retry) {
      existing.stages = 2;
      existing.stage ||= 1;
      const pullTo = Math.max(
        minOrderIndex(smart, card, target),
        Math.min(smart.cardIndex + desiredGap, smart.queue.length - 1),
      );
      if (pullTo < existingIdx) {
        const [moved] = smart.queue.splice(existingIdx, 1);
        smart.queue.splice(pullTo, 0, moved);
        return { added: false, moved: true, pending: true };
      }
    }
    return { added: false, pending: true };
  }

  const priorRetries = smart.queue.filter(
    (c) => c?.retry && !c.spacer && c.targets?.some((t) => t.node_id === target.node_id),
  ).length;
  if (priorRetries >= MAX_RETRIES_PER_TARGET) {
    return { added: false, pending: false, capped: true };
  }

  const stages = severity === "reveal" ? 2 : card.retry && card.stages ? card.stages : 1;
  const stage = card.retry && card.stage ? card.stage : 1;
  return scheduleRetryCard(smart, card, target, { severity, stage, stages });
}

function scheduleRetryCard(smart, card, target, { severity, stage, stages }) {
  const desiredGap = gapForSeverity(smart.requeueGap, severity);
  const kind = card.kind === "new" ? "due" : card.kind;
  const repertoire = String(card.encoded).split(":")[1];
  const isolated = standaloneRetryTarget(card, target);
  const retry = {
    ...card,
    kind,
    targets: [isolated],
    retry: true,
    stage,
    stages,
    encoded: `${kind}:${repertoire}:${target.node_id}:retry`,
  };
  let insertAt = Math.min(
    Math.max(smart.cardIndex + desiredGap, minOrderIndex(smart, card, target)),
    smart.queue.length,
  );
  // Anti-echo at the queue tail: if no cards remain between here and the retry,
  // interleave one earlier position so the board switches context before re-testing.
  if (insertAt <= smart.cardIndex + 1) {
    const spacer = pickTailSpacer(smart, target);
    if (spacer) {
      smart.queue.splice(insertAt, 0, spacer);
      smart.counts[spacer.kind] = (smart.counts[spacer.kind] || 0) + 1;
      insertAt += 1;
    }
  }
  smart.queue.splice(insertAt, 0, retry);
  smart.totalCards = smart.queue.length;
  smart.counts[kind] = (smart.counts[kind] || 0) + 1;
  return { added: true, pending: true };
}
