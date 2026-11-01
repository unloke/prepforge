import { describe, expect, it, vi } from "vitest";
import { provideApp, switchView, syncViewHeads } from "./app-context.js";

describe("app context", () => {
  it("forwards to the function registered at call time, with its arguments and result", () => {
    const first = vi.fn(() => "first");
    provideApp({ switchView: first });
    expect(switchView("train", { fromUrl: true })).toBe("first");
    expect(first).toHaveBeenCalledWith("train", { fromUrl: true });

    const second = vi.fn(() => "second");
    provideApp({ switchView: second });
    expect(switchView("build")).toBe("second");
    expect(first).toHaveBeenCalledOnce();
  });

  it("fails loudly when the shell never registered an entry point", () => {
    expect(() => syncViewHeads()).toThrow(TypeError);
  });
});
