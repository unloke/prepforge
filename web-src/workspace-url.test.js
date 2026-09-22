import { describe, it, expect } from "vitest";

import {
  REPLAY_SECTIONS,
  WORKSPACE_VIEWS,
  formatWorkspaceHash,
  parseWorkspaceHash,
  parseWorkspaceLocation,
  serializeWorkspaceLocation,
  workspaceLocationFromState,
} from "./workspace-url.js";

describe("workspace URL codec", () => {
  it("round-trips every workspace view", () => {
    for (const view of WORKSPACE_VIEWS) {
      const hash = formatWorkspaceHash({
        view,
        replaySection: view === "replay" ? "games" : undefined,
      });
      expect(parseWorkspaceHash(hash)).toEqual({
        view,
        replaySection: view === "replay" ? "games" : null,
        repertoireId: null,
        ply: null,
      });
    }
  });

  it("round-trips view + repertoire + ply", () => {
    const loc = { view: "analyze", replaySection: null, repertoireId: "rep-42", ply: 12 };
    const hash = formatWorkspaceHash(loc);
    expect(hash).toBe("#/analyze?rep=rep-42&ply=12");
    expect(parseWorkspaceHash(hash)).toEqual(loc);
  });

  it("omits ply 0 and empty repertoire", () => {
    expect(formatWorkspaceHash({ view: "build", repertoireId: "", ply: 0 })).toBe(
      "#/build",
    );
  });

  it("falls back unknown views to dashboard", () => {
    expect(parseWorkspaceHash("#/not-a-tab")).toEqual({
      view: "dashboard",
      replaySection: null,
      repertoireId: null,
      ply: null,
    });
    expect(parseWorkspaceHash("#/replay")).toEqual({
      view: "replay",
      replaySection: "games",
      repertoireId: null,
      ply: null,
    });
  });

  it("parses a full href and leaves the search string alone", () => {
    const href = "https://app.example/path?join=abc#/teams?rep=r1";
    expect(parseWorkspaceLocation(href)).toEqual({
      view: "teams",
      replaySection: null,
      repertoireId: "r1",
      ply: null,
    });
    const serialized = serializeWorkspaceLocation(
      { view: "settings" },
      href,
    );
    expect(serialized).toContain("?join=abc");
    expect(serialized).toContain("#/settings");
  });

  it("serialize then parse restores the location", () => {
    const loc = { view: "train", replaySection: null, repertoireId: "abc", ply: null };
    const href = serializeWorkspaceLocation(loc, "https://x.test/app");
    expect(parseWorkspaceLocation("https://x.test" + href)).toEqual(loc);
  });

  it("reads view, repertoire, and analyze ply from app state", () => {
    expect(
      workspaceLocationFromState({
        currentView: "analyze",
        analysisPly: 7,
        build: { repertoire_id: "r9" },
      }),
    ).toEqual({ view: "analyze", replaySection: null, repertoireId: "r9", ply: 7 });
    expect(
      workspaceLocationFromState({
        currentView: "build",
        analysisPly: 7,
        trainingRepertoireId: "r2",
      }),
    ).toEqual({ view: "build", replaySection: null, repertoireId: "r2", ply: null });
  });
});

describe("games/scout deep links", () => {
  it("exposes exactly the two replay sections", () => {
    expect(REPLAY_SECTIONS).toEqual(["games", "scout"]);
  });

  it("serializes replay + section to the section alias", () => {
    expect(formatWorkspaceHash({ view: "replay", replaySection: "games" })).toBe("#/games");
    expect(formatWorkspaceHash({ view: "replay", replaySection: "scout" })).toBe("#/scout");
    expect(formatWorkspaceHash({ view: "replay" })).toBe("#/games");
  });

  it("accepts a bare section view from callers that do not know the internal view", () => {
    expect(formatWorkspaceHash({ view: "games" })).toBe("#/games");
    expect(formatWorkspaceHash({ view: "scout" })).toBe("#/scout");
  });

  it("parses #/games and #/scout to replay + section", () => {
    expect(parseWorkspaceHash("#/games")).toEqual({
      view: "replay",
      replaySection: "games",
      repertoireId: null,
      ply: null,
    });
    expect(parseWorkspaceHash("#/scout")).toEqual({
      view: "replay",
      replaySection: "scout",
      repertoireId: null,
      ply: null,
    });
  });

  it("round-trips each section through serialize + parse (refresh/back-forward)", () => {
    for (const replaySection of REPLAY_SECTIONS) {
      const loc = { view: "replay", replaySection, repertoireId: null, ply: null };
      const href = serializeWorkspaceLocation(loc, "https://x.test/app");
      expect(parseWorkspaceLocation("https://x.test" + href)).toEqual(loc);
    }
  });

  it("never serializes a bare #/replay hash", () => {
    expect(formatWorkspaceHash({ view: "replay", replaySection: "scout", repertoireId: "r1" }))
      .toBe("#/scout?rep=r1");
  });

  it("reads the replay section from app state only on the replay view", () => {
    expect(
      workspaceLocationFromState({ currentView: "replay", replaySection: "scout" }),
    ).toEqual({ view: "replay", replaySection: "scout", repertoireId: null, ply: null });
    expect(
      workspaceLocationFromState({ currentView: "build", replaySection: "scout" }),
    ).toEqual({ view: "build", replaySection: null, repertoireId: null, ply: null });
  });

  it("app wires section restoration for direct open and popstate", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const root = dirname(fileURLToPath(import.meta.url));
    const app = readFileSync(join(root, "app.js"), "utf8");
    expect(app).toContain("appState.replaySection = loc.replaySection");
    expect(app).toContain("setReplaySection(appState.replaySection)");
    expect(app).toContain('button.dataset.replaySection === (appState.replaySection || "games")');
  });
});
