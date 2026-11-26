import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cssSource } from "./test-styles-source.js";

const replayCss = cssSource("views/replay.css");
const scoutCss = cssSource("views/scout.css");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

describe("Games and Scout layout regressions", () => {
  it("keeps the empty Games ledger at full width", () => {
    // The triage is a flex column: start alignment shrank the empty card to
    // zero width on desktop, so "No games checked yet" never showed.
    expect(replayCss).not.toMatch(/\.ledger:has\(\.ledger-empty\)\s*\{\s*align-self:\s*start/);
  });

  it("gives the phone Games setup button a settings icon, not a sun", () => {
    const button = html.slice(html.indexOf('id="games-setup"'), html.indexOf("</button>", html.indexOf('id="games-setup"')));
    expect(button).toContain('aria-label="Games source and sample"');
    expect(button).not.toContain('<circle cx="12" cy="12" r="3"/>');
    expect(button).toContain('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/>');
  });

  it("announces the Scout stream's phase, not every game it counts", () => {
    const card = html.slice(html.indexOf('class="scout-stream'), html.indexOf("</div></div>", html.indexOf('class="scout-stream')));
    expect(card).toContain('<b id="scout-stream-phase" role="status">');
    expect(card.match(/role="status"/g)).toHaveLength(1);
    expect(card).toMatch(/<p id="scout-stream-detail"(?![^>]*role=)/);
  });

  it("gives the Scout progress line its own row on phones", () => {
    // A zero-height line with negative margins drew "Checking lines…" over the colour tabs.
    expect(scoutCss).not.toMatch(/\.scout-engine-progress\s*\{[^}]*height:\s*0/);
    expect(scoutCss).not.toMatch(/\.scout-engine-progress\s*\{[^}]*margin-block:\s*-/);
  });
});

describe("Games and Scout normal-use regressions", () => {
  it("folds a long Games move list only on a phone", () => {
    expect(replayCss).toMatch(/\.moveline-more \{ display: none; \}/);
    expect(replayCss).toMatch(/@media \(max-width: 760px\)[^{]*\{\s*\.moveline:has\(> \.moveline-more\) > \.move-pair\.is-far \{ display: none; \}/);
  });

  it("heads the Scout line column with what its rows show", () => {
    const report = readFileSync(new URL("./scout-report.js", import.meta.url), "utf8");
    expect(report).toContain("<span>Last seen</span>");
    expect(report).not.toContain("Type · last seen");
    expect(html).not.toContain("Type · last seen");
  });

  it("puts Scout's engine offer under the report, not above it", () => {
    const main = html.slice(html.indexOf('<div class="scout-main">'), html.indexOf('id="scout-side"'));
    expect(main.indexOf('data-unlock-place="scout"')).toBeGreaterThan(main.indexOf('id="scout-results"'));
  });
});
