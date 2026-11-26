// Picking the rail or tab-bar tab that is already shown.
import { describe, expect, it } from "vitest";
import { appSource } from "./test-app-source.js";

const source = appSource();
const start = source.indexOf('document.querySelectorAll(".tab[data-view]").forEach(');
const handler = source.slice(start, source.indexOf("\n  });\n", start));

describe("reselecting the shown tab", () => {
  it("only scrolls Analyze or Settings back to the top, before any navigation", () => {
    const guard = handler.indexOf('if (button.classList.contains("is-active") && ["analyze", "settings"].includes(button.dataset.view)) return void resetViewScroll();');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(handler.indexOf("activateWorkspaceTab("));
  });

  it("opens Settings with one load, the one switchView starts", () => {
    expect(handler).not.toContain("loadSettings");
    const view = source.slice(source.indexOf("function switchView("), source.indexOf("\n}\n", source.indexOf("function switchView(")));
    expect(view.match(/loadSettings\(\)/g)).toHaveLength(1);
  });
});
