import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(root, "styles.css"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");
const app = readFileSync(join(root, "app.js"), "utf8");

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`));
  return match ? match[1] : "";
}

describe("workspace chrome layout", () => {
  it("uses Settings as the only theme entry point", () => {
    expect(html).not.toContain('id="theme-toggle"');
    const settingsStart = html.indexOf('id="view-settings"');
    const settings = html.slice(settingsStart);
    expect(settings).toContain('id="settings-theme"');
    expect(app).not.toContain("theme-toggle");
    expect(app).not.toContain("nextTheme");
    expect(app).not.toContain("themeLabel");
  });

  it("keeps nav and More items vertically centered", () => {
    expect(ruleBody(".tab")).toMatch(/display:\s*inline-flex/);
    expect(ruleBody(".tab")).toMatch(/align-items:\s*center/);
    expect(ruleBody(".more-nav-menu .tab")).toMatch(/align-items:\s*center/);
    expect(ruleBody(".more-nav > summary")).toMatch(/align-items:\s*center/);
  });

  it("closes More when navigation changes or the user dismisses it", () => {
    expect(app).toContain('moreNav?.removeAttribute("open")');
    expect(app).toContain('document.getElementById("more-nav")?.removeAttribute("open")');
    expect(html).toContain('aria-controls="more-nav-menu"');
  });

  it("keeps More usable when the topbar wraps on narrow screens", () => {
    const mobile = css.slice(css.indexOf("@media (max-width: 720px)"));
    expect(mobile).toMatch(/\.tabs\s*\{[\s\S]*overflow:\s*visible/);
    expect(mobile).toMatch(/\.more-nav-menu\s*\{[\s\S]*right:\s*0/);
    expect(mobile).toMatch(/min-width:\s*min\(132px,\s*calc\(100vw\s*-\s*24px\)\)/);
    expect(mobile).toMatch(/max-width:\s*calc\(100vw\s*-\s*24px\)/);
  });

  it("keeps Coach height stable while the body owns long-copy scrolling", () => {
    const coach = ruleBody(".coach-prose");
    const maia = ruleBody(".coach-maia");
    const bookline = ruleBody(".coach-bookline");
    const card = ruleBody(".explain-card");
    const body = ruleBody(".coach-body");
    const secondary = ruleBody(".coach-secondary");
    expect(html).toContain('<header class="explain-head">');
    expect(html).toContain('<div class="coach-body" id="coach-body">');
    expect(html).toContain('<div class="coach-secondary">');
    expect(card).toMatch(/grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)/);
    expect(card).toMatch(/block-size:\s*var\(--coach-card-block-size\)/);
    expect(card).toMatch(/flex:\s*0\s+0\s+var\(--coach-card-block-size\)/);
    expect(card).toMatch(
      /--coach-card-block-size:\s*clamp\(136px,\s*calc\(var\(--study-h\)\s*\*\s*0\.23\),\s*170px\)/,
    );
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-direction:\s*column/);
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(secondary).toMatch(/margin-top:\s*auto/);
    expect(coach).toMatch(/overflow-wrap:\s*anywhere/);
    expect(maia).toMatch(/overflow-wrap:\s*anywhere/);
    expect(bookline).toMatch(/overflow-wrap:\s*anywhere/);
    expect(coach).not.toMatch(/line-clamp|overflow:\s*hidden/);
    expect(maia).not.toMatch(/line-clamp|overflow:\s*hidden/);
    expect(bookline).not.toMatch(/line-clamp|overflow:\s*hidden/);
    expect(ruleBody(".sidebar")).toMatch(/overflow-y:\s*auto/);
  });
});
