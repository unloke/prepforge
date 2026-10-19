import { describe, expect, it } from "vitest";
import { html as safeHtml } from "./html.js";
import { createReplayView } from "./views/replay.js";

// A source that could not be read is named in the ledger, with the app's own
// separator between two of them — not a question mark.

const RENDERERS = {
  parseFenBoard: () => ({}),
  pieceSvg: (piece) => safeHtml`<svg data-piece="${piece}"></svg>`,
};

function render(payload) {
  const results = {
    get innerHTML() { return this._html ?? ""; },
    set innerHTML(value) { this._html = String(value); },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  globalThis.document = {
    getElementById: (id) => (id === "replay-results" ? results : null),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const view = createReplayView({
    boardRenderers: RENDERERS,
    getReplayFilter: () => null,
    isGameOpen: () => false,
    onToggleFilter: () => {},
    onToggleGame: () => {},
    onTrainMiss: () => {},
    onBuildReply: () => {},
    onAnalyze: () => {},
  });
  view.renderReplayResults(payload);
  return results.innerHTML;
}

describe("Games source errors", () => {
  it("names every source that failed, separated the way the app separates them", () => {
    const html = render({
      games: [],
      source_errors: [
        { username: "alpha", message: "not found" },
        { username: "beta", message: "rate limited" },
      ],
    });
    expect(html).toContain("alpha: not found");
    expect(html).toContain("beta: rate limited");
    expect(html).toContain("alpha: not found \u00b7 beta: rate limited");
    expect(html).not.toContain("? ");
  });
});
