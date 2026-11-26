import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as context from "./app-context.js";

const { handoffs, persistence, provideApp, shell } = context;

describe("app context", () => {
  it("is three named contracts, not one bag of shell functions", () => {
    expect(Object.keys(context).sort()).toEqual(["handoffs", "persistence", "provideApp", "shell"]);
    expect(Object.keys(shell)).toEqual(["switchView", "syncWorkspaceUrl", "syncViewHeads", "openSettingsSection"]);
    expect(Object.keys(persistence)).toEqual([
      "scheduleBuildFlush", "hardFlushBuild", "flushTrainSync", "queueTrainAttempt", "markTrainPositionDirty",
    ]);
    expect(Object.keys(handoffs)).toEqual([
      "openAnalyzeGame", "repertoiresChanged", "defaultRepertoireNameFromPgn", "importRepertoireFromPgnText",
    ]);
  });

  it("forwards to the function registered at call time, with its arguments and result", () => {
    const first = vi.fn(() => "first");
    provideApp({ shell: { switchView: first } });
    expect(shell.switchView("train", { fromUrl: true })).toBe("first");
    expect(first).toHaveBeenCalledWith("train", { fromUrl: true });

    const second = vi.fn(() => "second");
    provideApp({ shell: { switchView: second } });
    const { switchView } = shell;
    expect(switchView("build")).toBe("second");
    expect(first).toHaveBeenCalledOnce();
  });

  it("refuses anything outside a contract", () => {
    expect(() => provideApp({ shell: { runAnalysis() {} } })).toThrow(/shell\.runAnalysis/);
    expect(() => provideApp({ analyze: { runAnalysis() {} } })).toThrow(/analyze/);
  });

  it("fails loudly when the shell never registered an entry point", () => {
    expect(() => handoffs.openAnalyzeGame({ pgn: "1. e4 *" })).toThrow(/handoffs\.openAnalyzeGame/);
  });

  it("is registered in full by app.js", () => {
    const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
    const call = app.slice(app.indexOf("provideApp({"), app.indexOf("\n});", app.indexOf("provideApp({")));
    for (const [name, contract] of Object.entries({ shell, persistence, handoffs })) {
      const block = call.match(new RegExp(`\\b${name}: \\{([^}]*)\\}`))?.[1] || "";
      const registered = block.split(",").map((entry) => entry.split(":")[0].trim()).filter(Boolean);
      expect(registered, name).toEqual(Object.keys(contract));
    }
  });
});
