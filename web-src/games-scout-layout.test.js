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

  it("gives the Scout progress line its own row on phones", () => {
    // A zero-height line with negative margins drew "Checking lines…" over the colour tabs.
    expect(scoutCss).not.toMatch(/\.scout-engine-progress\s*\{[^}]*height:\s*0/);
    expect(scoutCss).not.toMatch(/\.scout-engine-progress\s*\{[^}]*margin-block:\s*-/);
  });
});
