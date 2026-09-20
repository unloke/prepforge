import { describe, it, expect } from "vitest";

import {
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
      const hash = formatWorkspaceHash({ view });
      expect(parseWorkspaceHash(hash)).toEqual({
        view,
        repertoireId: null,
        ply: null,
      });
    }
  });

  it("round-trips view + repertoire + ply", () => {
    const loc = { view: "analyze", repertoireId: "rep-42", ply: 12 };
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
      repertoireId: null,
      ply: null,
    });
  });

  it("parses a full href and leaves the search string alone", () => {
    const href = "https://app.example/path?join=abc#/teams?rep=r1";
    expect(parseWorkspaceLocation(href)).toEqual({
      view: "teams",
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

  it("boots hashless first-open URLs on the dashboard", () => {
    // A fresh first open (including OAuth ?lichess=linked/?signed_in=1
    // returns and plain bookmarks) carries no hash, so the startup route must
    // be the default home view.
    for (const href of [
      "https://app.example/",
      "https://app.example/?lichess=linked",
      "https://app.example/?signed_in=1",
      "https://app.example/?join=abc",
      "https://app.example/?shared=tok",
      "https://app.example/?view=settings",
    ]) {
      expect(parseWorkspaceLocation(href).view).toBe("dashboard");
    }
  });

  it("keeps explicit hash routes after hydration settles", () => {
    // An explicit hash always wins: delayed hydration must leave it alone.
    for (const view of WORKSPACE_VIEWS) {
      expect(parseWorkspaceLocation(`https://app.example/#/${view}`).view).toBe(view);
    }
    expect(parseWorkspaceLocation("https://app.example/?lichess=linked#/analyze").view).toBe(
      "analyze",
    );
    expect(parseWorkspaceLocation("https://app.example/?shared=tok#/build").view).toBe("build");
  });

  it("serialize then parse restores the location", () => {
    const loc = { view: "train", repertoireId: "abc", ply: null };
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
    ).toEqual({ view: "analyze", repertoireId: "r9", ply: 7 });
    expect(
      workspaceLocationFromState({
        currentView: "build",
        analysisPly: 7,
        trainingRepertoireId: "r2",
      }),
    ).toEqual({ view: "build", repertoireId: "r2", ply: null });
  });
});
