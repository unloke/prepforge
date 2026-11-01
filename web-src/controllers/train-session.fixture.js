// The session entry points train-home.js calls, as mocks. A test that drives
// Home mocks the session module with these (it has no imports of its own, so
// the mock factory can load it while train-session.js is being replaced):
//   vi.mock("./controllers/train-session.js", () => import("./controllers/train-session.fixture.js"));
import { vi } from "vitest";

export const blitzEnabled = vi.fn(() => false);
export const clearBlitzTimer = vi.fn();
export const onFeelingLucky = vi.fn();
export const openPlayInAnalyze = vi.fn();
export const resetTrainBoardIdle = vi.fn(async () => {});
export const resignPlaySession = vi.fn();
export const setBlitzBarVisible = vi.fn();
export const setBlitzEnabled = vi.fn();
export const skipTrainingLine = vi.fn();
export const startPlaySessionTracked = vi.fn(async () => {});
export const startTraining = vi.fn(async () => {});
export const takebackPlaySession = vi.fn();
export const trainHint = vi.fn();
