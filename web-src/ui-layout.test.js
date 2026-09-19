import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(root, "styles.css"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");
const app = readFileSync(join(root, "app.js"), "utf8");
const account = readFileSync(join(root, "controllers", "account.js"), "utf8");

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

  it("keeps Teams in primary navigation and removes More", () => {
    expect(ruleBody(".tab")).toMatch(/display:\s*inline-flex/);
    expect(ruleBody(".tab")).toMatch(/align-items:\s*center/);
    expect(html).toContain('data-testid="nav-teams"');
    expect(html).not.toContain('id="more-nav"');
    expect(html).not.toContain('data-testid="nav-settings"');
    expect(account).toContain('data-action="settings"');
    expect(account).toContain("onOpenSettings();");
  });

  it("uses one mutually exclusive Build inspector", () => {
    expect(html).toContain('id="build-inspector"');
    expect(html).toContain('id="build-tool-explorer"');
    expect(html).toContain('id="build-tool-coverage"');
    expect(html).toContain('aria-controls="explorer-drawer"');
    expect(html).toContain('aria-controls="coverage-drawer"');
    expect(html).not.toContain('<summary>Opening explorer</summary>');
    expect(html).not.toContain('<summary>Coverage scan</summary>');
    expect(ruleBody(".inspector-panel")).toMatch(/overflow-y:\s*auto/);
    expect(app).toContain('setBuildInspector("explorer")');
    expect(app).toContain('setBuildInspector("coverage")');
    expect(app).toContain("panel.hidden = name !== active");
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
