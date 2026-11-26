// A missed move comes back once, alone, a few cards later. The retry card holds
// only that target and grades nothing, so FSRS keeps the first-try miss and the
// first-try stats never count the move twice. One retry is pending at a time.
export function requeueMissedTarget(smart, target) {
  const card = smart.queue[smart.cardIndex];
  if (!card || !target) return { added: false, pending: false };
  const ahead = smart.queue.slice(smart.cardIndex + 1);
  if (ahead.some((c) => c.targets?.some((t) => t.node_id === target.node_id))) return { added: false, pending: true };
  const [kind, repertoire] = String(card.encoded).split(":");
  const retry = { ...card, targets: [target], retry: true, encoded: `${kind}:${repertoire}:${target.node_id}` };
  smart.queue.splice(Math.min(smart.cardIndex + smart.requeueGap, smart.queue.length), 0, retry);
  smart.totalCards = smart.queue.length;
  smart.counts[card.kind] = (smart.counts[card.kind] || 0) + 1;
  return { added: true, pending: true };
}
