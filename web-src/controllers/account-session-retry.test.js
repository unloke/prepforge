import { describe, expect, it, vi } from "vitest";
import { createAccountController } from "./account.js";

// A session read that gets no answer (a server waking, a 502) is not "signed
// out": the chip used to sit on "Checking your session…" for good and a press
// on it offered a signed-in user the sign-in form.
describe("session read without an answer", () => {
  const makeController = ({ api }) => {
    const appState = { signedIn: false, accountUsername: null, accountUserId: null, lichessUsername: null };
    const setStatus = vi.fn();
    const controller = createAccountController({
      appState, api, postJson: vi.fn(), setStatus, showConfirmModal: vi.fn(), refreshAutoMaiaRating: vi.fn(),
    });
    return { appState, controller, setStatus };
  };

  it("asks again when the session read fails without an answer, and a chip press reads it instead of offering sign-in", async () => {
    vi.useFakeTimers();
    try {
      globalThis.document = { getElementById: () => null, querySelector: () => null, body: { classList: { toggle: () => {} } } };
      const api = vi.fn().mockRejectedValueOnce(Object.assign(new Error("Bad gateway"), { status: 502 }))
        .mockResolvedValueOnce({ id: "alice", display_name: "Alice" });
      const { appState, controller, setStatus } = makeController({ api });
      await controller.refreshAuthStatus();
      expect(appState.authKnown).toBeFalsy();
      controller.onAccountChipClick();
      expect(setStatus).toHaveBeenCalledWith("Checking your session…");
      await vi.runOnlyPendingTimersAsync();
      expect(appState.authKnown).toBe(true);
      expect(appState.signedIn).toBe(true);
    } finally {
      vi.useRealTimers();
      delete globalThis.document;
    }
  });
});
