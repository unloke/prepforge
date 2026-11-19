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

  it("fits study screens, sheets and dialogs inside the visible viewport", () => {
    const css = cssSource("phone.css");
    expect(css).toContain("inset: var(--viewport-top) 0 auto");
    expect(css).toContain("height: var(--viewport-height)");
    expect(css).toContain("inset: auto 0 var(--viewport-bottom)");
    expect(css).toContain("max-height: calc(var(--viewport-height) * 0.72)");
    expect(css).toContain("--viewport-bottom) + 8px + env(safe-area-inset-bottom)");
  });
});
