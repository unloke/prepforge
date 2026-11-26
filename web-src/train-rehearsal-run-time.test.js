// A finished line rehearsal is saved to Train history with the time it started,
// not a second copy of the time it finished.
import { expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";
import { asSlices } from "./state/as-slices.fixture.js";

const source = appSource();
function compile(marker, deps) {
  const start = source.indexOf(marker);
  const end = source.indexOf("\n}\n", start) + 2;
  return new Function(...Object.keys(deps), `return (${source.slice(start, end)});`)(...Object.values(deps));
}

it("records when the rehearsal started", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-11-26T05:00:00Z"));
    const appState = { training: { session_id: "s", repertoire_name: "Italian", lines: [1, 2] }, trainAttempt: 1 };
    compile("function trainStatsReset(", { ...asSlices(appState),  })();
    vi.setSystemTime(new Date("2026-11-26T05:12:00Z"));
    const saveRun = vi.fn();
    const finish = compile("function finishTrainingSession(", {
      ...asSlices(appState), saveRun, currentOwnerId: () => "u", saveRehearsal: vi.fn(),
      boards: { train: { setEngineArrow: vi.fn() } }, updateTrainTurnBadge: vi.fn(),
      document: { getElementById: () => ({ textContent: "" }) },
      showTrainResult: vi.fn(), drillResult: () => ({}), celebrate: vi.fn(),
    });
    finish();
    expect(saveRun.mock.calls[0][1]).toMatchObject({
      startedAt: "2026-11-26T05:00:00.000Z", finishedAt: "2026-11-26T05:12:00.000Z",
    });
  } finally {
    vi.useRealTimers();
  }
});
