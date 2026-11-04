export function selectSmokeShard(suite, shard) {
  if (shard === undefined) return suite;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
  if (!match) throw new Error("UI_V2_SMOKE_SHARD must be index/count (for example 1/4)");
  const [, index, count] = match.map(Number);
  if (index > count || count > suite.length) throw new Error("Smoke shard is outside the suite");
  return suite.filter((_, i) => i % count === index - 1);
}
