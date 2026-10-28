// The Engine card's one-line status: the setup this device runs, its measured
// speed, and why Detect chose it, in plain words. Pure: settings.js feeds it the
// engine profile's state and paints the result.
import { LADDER, ladderStep } from "../engine/engine-ladder.js";

const NET = { big: "Full", lite: "Lite" };
const ORDINAL = ["", "1st", "2nd", "3rd"];
const workers = n => `${n} worker${n === 1 ? "" : "s"}`;
const step = (net, n) => `${NET[net]} ×${n}`;
export const BUSY = ["download", "compile", "waiting", "probe"];

export function speedLabel(nps) {
  if (!(nps > 0)) return "";
  // Lichess's ceval unit: thousands (or millions) of nodes a second.
  return nps >= 1e6 ? `${(nps / 1e6).toFixed(1)} Mn/s` : `${Math.round(nps / 1000)} kn/s`;
}

// Lifecycle marks are dev ids (api.js engineLifecycleMark): name the part of the app.
export function phaseLabel(phase) {
  const p = String(phase || "");
  const where = p.startsWith("build") ? "Build" : p.startsWith("analyze") ? "Analyze" : "";
  const what = p.includes("maia") ? "Maia" : p.includes("stockfish") ? "Stockfish" : "";
  if (where && what) return `${where}'s ${what} step`;
  return where || what || "a run";
}

// Why Detect stopped where it did, from what the run measured.
function reason(profile, m, { ceiling, cap, consent }) {
  const died = Number.isInteger(ceiling) ? LADDER[ceiling] : null;
  if (died && ceiling >= ladderStep(profile.net, profile.workers)) {
    return { text: `${step(...died)} closed this tab`, title: "This step ran out of memory, so Detect stays below it" };
  }
  if (m?.error) return { text: `Next step failed`, title: m.error };
  const scaling = m?.scaling?.[profile.net] || [];
  const n = profile.workers;
  if (scaling.length > n && scaling[0] > 0) {
    const gain = Math.max(0, Math.round((scaling[n] - scaling[n - 1]) / scaling[0] * 100));
    return { text: `${ORDINAL[n + 1] || `${n + 1}th`} worker +${gain}%`, title: `${workers(n + 1)} added ${gain}% of one worker's speed, under the 50% that pays for its memory` };
  }
  if (profile.net === "lite" && consent !== "yes") return { text: "Detected", title: "Full is measured once it is downloaded" };
  if (n >= cap) return { text: "Most this device runs", title: `Limited by this device to ${workers(cap)}` };
  return { text: "Detected", title: "" };
}

// { line, detail, title }: line is the setup, detail the reason or live phase.
export function engineSummary({ profile, setup, measurements: m, crash, detection, available = true }) {
  if (BUSY.includes(setup.phase)) {
    const bytes = setup.phase === "download" && setup.total
      ? `${Math.round(setup.loaded / 1048576)} / ${Math.round(setup.total / 1048576)} MB` : "";
    const steps = setup.phase === "probe" && setup.probeTotal ? `Step ${Math.min(setup.done + 1, setup.probeTotal)} of ${setup.probeTotal}` : "";
    return { line: setup.label || "Detecting…", detail: bytes || steps, title: "" };
  }
  if (!available) return { line: "Unavailable in this browser", detail: "", title: "" };
  // The speed Detect measured for exactly this step, whoever chose it.
  const measured = speedLabel(m?.scaling?.[profile.net]?.[profile.workers - 1]);
  const line = [NET[profile.net], workers(profile.workers), measured].filter(Boolean).join(" · ");
  if (setup.phase === "error") return { line, detail: setup.label, title: "" };
  if (crash) {
    return { line, detail: `${step(crash.net, crash.workers)} stopped during ${phaseLabel(crash.phase)}`,
      title: crash.phase ? `Last phase: ${crash.phase}` : "" };
  }
  if (m?.error && profile.source === "fallback") return { line, detail: "Detect failed", title: m.error };
  if (profile.source === "user") {
    const d = detection.detected;
    const differs = d && d.source !== "fallback" && (d.net !== profile.net || d.workers !== profile.workers);
    return { line, detail: differs ? `Set by you · Detect picked ${step(d.net, d.workers)}` : "Set by you", title: "" };
  }
  // A probe step that closed the tab leaves the step below it, not a fresh device.
  if (profile.source !== "detected" && !Number.isInteger(detection.ceiling)) return { line, detail: "Not measured yet", title: "" };
  const r = reason(profile, m, detection);
  return { line, detail: r.text, title: r.title };
}

// Why a segment is greyed out: Settings offers only the steps Detect held.
export function disabledReason(kind, value, { choices, net, fullChoice }) {
  if (kind === "net") {
    if (value !== "big") return "";
    return fullChoice ? "Download Full first" : "Detect stopped before Full on this device";
  }
  const held = choices[net];
  return held < 1 ? `Detect has not held ${NET[net]} on this device` : `Detect held ${workers(held)} on ${NET[net]}`;
}
