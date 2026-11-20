import { describe, expect, it } from "vitest";
import { cssSource, eagerCss } from "./test-styles-source.js";

describe("shared interaction polish", () => {
  it("animates native disclosures without changing tab-panel visibility", () => {
    const css = cssSource("styles/disclosure.css");
    expect(css).toContain("@supports (interpolate-size: allow-keywords)");
    expect(css).toContain('details:not([role="tabpanel"])::details-content');
    expect(css).toContain("block-size: auto");
    expect(css).toContain("content-visibility var(--dur) allow-discrete");
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*transition: none/);
  });

  it("lets menus finish their exit without accepting clicks", () => {
    const css = cssSource("styles/overlays.css");
    expect(css).toContain("display var(--dur-fast) allow-discrete");
    expect(css).toContain("overlay var(--dur-fast) allow-discrete");
    expect(css).toMatch(/\.context-menu:not\(:popover-open\)[^}]*pointer-events: none/);
  });

  it("uses a reversible selection mark and preserves the reduced-motion override", () => {
    expect(eagerCss).toContain("transition: scale var(--dur) var(--ease-out)");
    expect(eagerCss).toContain("button.is-active::after { scale: 1; }");
    expect(eagerCss.lastIndexOf("transition-duration: 0.001ms !important"))
      .toBeGreaterThan(eagerCss.indexOf("transition: scale var(--dur)"));
  });

  it("reveals tab content without replaying refreshes or stacking view entrances", () => {
    for (const file of ["views/build.css", "views/teams.css"]) {
      const css = cssSource(file);
      expect(css).toContain("prefers-reduced-motion: no-preference");
      expect(css).toMatch(/\.is-enter\s*\{\s*animation: row-enter var\(--dur\) var\(--ease-out\) both/);
    }
    expect(cssSource("views/build.css")).toContain("(min-width: 761px) and (prefers-reduced-motion: no-preference)");
    expect(cssSource("views/teams.css")).toContain("[data-team-panel][hidden] { display: none; }");
  });

  it("gives desktop panel options a reversible native-popover entrance and exit", () => {
    const css = cssSource("views/build.css");
    expect(css).toContain("display var(--dur-fast) allow-discrete");
    expect(css).toContain("overlay var(--dur-fast) allow-discrete");
    expect(css).toMatch(/\.dock-tools:not\(:popover-open\)[^}]*pointer-events: none/);
    expect(css).toMatch(/@starting-style[\s\S]*\.dock-tools:popover-open \{ opacity: 0; translate: 0 -4px/);
  });

  it("stacks panel options without Safari's fixed-grid intrinsic-height stretch", () => {
    const css = cssSource("views/build.css");
    const tools = /\.dock-tools:popover-open \{([^}]+)\}/.exec(css)[1];
    expect(tools).toContain("display: grid");
    expect(tools).toContain("align-content: start");
    expect(tools).toContain("gap: 12px");
    const phone = cssSource("phone/study.css");
    expect(phone).toContain("bottom: calc(var(--viewport-bottom) + 8px + env(safe-area-inset-bottom))");
    expect(phone).toContain("max-height: calc(var(--viewport-height) - env(safe-area-inset-top) - 24px)");
  });

  it("reveals the phone Library search without delaying focus or changing layout", () => {
    const css = cssSource("phone/pages.css");
    expect(css).toMatch(/prefers-reduced-motion: no-preference[\s\S]*@starting-style/);
    expect(css).toContain(":root:not(.view-swap) #view-dashboard .lib[data-search-open]");
    expect(css).toContain(".lib-list :is(.search-field, .lib-search-cancel)");
    expect(css).toContain("translate: 0 -4px");
  });

  it("fits study screens, sheets and dialogs inside the visible viewport", () => {
    const css = cssSource("phone.css");
    expect(css).toContain("inset: var(--viewport-top) 0 auto");
    expect(css).toContain("height: var(--viewport-height)");
    expect(css).toContain("inset: auto 0 var(--viewport-bottom)");
    expect(css).toContain("max-height: calc(var(--viewport-height) * 0.72)");
    expect(css).toContain("--viewport-bottom) + 8px + env(safe-area-inset-bottom)");
  });
});
