// The worker ladder Detect climbs, and how far this device may climb it.
export const MAX_WORKERS = 3;

// Ladder order: each step adds one heap, so the count only ever grows.
// The step the device holds below a crashed one; lite x1 is the floor.
export const LADDER = [["lite", 1], ["big", 1], ["big", 2], ["big", 3]];
export function stepDownProfile(p) {
  return p.net === "big" && p.workers > 1
    ? { net: "big", workers: p.workers - 1, source: "fallback" }
    : { net: "lite", workers: p.net === "big" ? 1 : Math.max(1, p.workers - 1), source: "fallback" };
}
export const ladderStep = (net, workers) => LADDER.findIndex(([n, w]) => n === net && w === workers);
// The workers each net held before `step`: every ladder step below it completed.
export function heldBelow({ net, workers }) {
  const held = { lite: 0, big: 0 };
  for (const [n, w] of LADDER) {
    if (n === net && w === workers) break;
    held[n] = Math.max(held[n], w);
  }
  return held;
}

// A phone or tablet: the OS kills the whole tab (engines, Maia, page) past its memory
// limit, which a Stockfish-only probe never sees. iPadOS reports a Mac with touch.
export function isHandheld({ userAgent = "", userAgentData, maxTouchPoints = 0 } = {}) {
  return !!userAgentData?.mobile || /iPhone|iPad|iPod|Android|Mobile/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

// How many engines this device could HOLD. Every worker reserves its net's whole
// heap (384 MiB for big, 256 MiB for lite), so a memory signal bounds the count.
// deviceMemory is the only memory signal (Chromium). A handheld runs one engine, as
// Lichess does on mobile; elsewhere Detect proves each step by reserving its heap.
// Cores bound the count: a probe cannot use more workers than the CPU can run.
export function maxWorkers(device = {}) {
  const { hardwareConcurrency, deviceMemory } = device;
  if (isHandheld(device)) return 1;
  const byMemory = deviceMemory > 0 ? (deviceMemory <= 2 ? 1 : deviceMemory <= 4 ? 2 : MAX_WORKERS) : MAX_WORKERS;
  const cores = hardwareConcurrency > 0 ? hardwareConcurrency : 1;
  return Math.max(1, Math.min(MAX_WORKERS, byMemory, cores));
}
