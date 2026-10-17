import { describe, expect, it, vi } from "vitest";
import { MAIA_INIT_NOTICE_KEY, maiaInitMessage, watchMaiaInit } from "./maia-init-notice.js";

function fakeProvider() {
  let listener = null;
  return {
    subscribeInitProgress(fn) {
      listener = fn;
      return vi.fn();
    },
    emit(progress) {
      listener?.(progress);
    },
  };
}

describe("Maia init notice", () => {
  it("maps cold-init phases to concise progress text", () => {
    expect(maiaInitMessage({ phase: "download", loaded: 23, total: 46 })).toBe(
      "Downloading Maia model · 50%",
    );
    expect(maiaInitMessage({ phase: "cache" })).toBe("Loading Maia model from cache");
    expect(maiaInitMessage({ phase: "verify" })).toBe("Verifying Maia model");
    expect(maiaInitMessage({ phase: "session" })).toBe("Starting Maia engine");
  });

  it("updates one notice in place and cleans it up on success", () => {
    const provider = fakeProvider();
    const card = { dismiss: vi.fn() };
    const notices = { show: vi.fn(() => card) };
    const stop = watchMaiaInit(provider, { notices });

    provider.emit({ phase: "download", loaded: 23, total: 46 });
    expect(notices.show).toHaveBeenCalledWith(
      "Downloading Maia model · 50%",
      expect.objectContaining({ key: MAIA_INIT_NOTICE_KEY, duration: 0 }),
    );

    stop.succeed();
    expect(card.dismiss).toHaveBeenCalled();
  });

  it("turns a failure into a retryable error notice", () => {
    const provider = fakeProvider();
    const card = { dismiss: vi.fn() };
    const notices = { show: vi.fn(), cards: [card] };
    const onRetry = vi.fn();
    const stop = watchMaiaInit(provider, { notices, onRetry });

    stop.fail(new Error("weights unavailable"));
    expect(notices.show).toHaveBeenCalledWith(
      "weights unavailable",
      expect.objectContaining({
        key: MAIA_INIT_NOTICE_KEY,
        tone: "error",
        actions: [expect.objectContaining({ label: "Retry", onClick: onRetry })],
      }),
    );
    stop.succeed();
    expect(card.dismiss).not.toHaveBeenCalled();
  });
});
