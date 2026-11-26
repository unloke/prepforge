// A missed move comes back once, alone, a few cards later. The retry card holds
// only that target and grades nothing, so FSRS keeps the first-try miss and the
// first-try stats never count the move twice. One retry is pending at a time.
export function requeueMissedTarget(smart, target) {
  const card = smart.queue[smart.cardIndex];
  if (!card || !target) return { added: false, pending: false };
  const ahead = smart.queue.slice(smart.cardIndex + 1);
  if (ahead.some((c) => c.targets?.some((t) => t.node_id === target.node_id))) return { added: false, pending: true };
  // A new move comes back as recall: no second demonstration, no second "learned".
  const kind = card.kind === "new" ? "due" : card.kind;
  const repertoire = String(card.encoded).split(":")[1];
  // The ":retry" mark is synced with the queue, so a reload still re-tests it ungraded.
  const retry = { ...card, kind, targets: [target], retry: true, encoded: `${kind}:${repertoire}:${target.node_id}:retry` };
  smart.queue.splice(Math.min(smart.cardIndex + smart.requeueGap, smart.queue.length), 0, retry);
  smart.totalCards = smart.queue.length;
  smart.counts[kind] = (smart.counts[kind] || 0) + 1;
  return { added: true, pending: true };
}
