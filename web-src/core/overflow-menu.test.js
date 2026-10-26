import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { overflowMenuHtml } from "./overflow-menu.js";

const kit = readFileSync(new URL("../phone-kit.css", import.meta.url), "utf8");

describe("overflow menu", () => {
  const items = [
    { action: "train", label: "Train this repertoire" },
    { action: "rename", label: "Rename...", group: 1 },
    { action: "share", label: "Share...", group: 1 },
    { action: "delete", label: "Delete...", danger: true, group: 2 },
  ];

  it("heads the sheet with the object it acts on and splits groups", () => {
    const out = String(overflowMenuHtml({ title: "Sicilian <Najdorf>", items, data: { "repertoire-id": "r1" } }));
    expect(out).toContain('<div class="menu-title" aria-hidden="true">Sicilian &lt;Najdorf&gt;</div>');
    expect(out.match(/role="separator"/g)).toHaveLength(2);
    expect(out.match(/data-repertoire-id="r1"/g)).toHaveLength(4);
    expect(out).toContain('class="is-danger" data-action="delete"');
    expect(out.match(/role="menuitem"/g)).toHaveLength(4);
  });

  it("draws no head and no separator for one plain group", () => {
    const out = String(overflowMenuHtml({ items: [{ action: "a", label: "A" }, { action: "b", label: "B" }] }));
    expect(out).not.toContain("menu-title");
    expect(out).not.toContain("separator");
  });

  it("shows the head only on a phone, where the menu is an action sheet", () => {
    expect(kit).toMatch(/^\.menu-title \{ display: none; \}/m);
    expect(kit).toMatch(/@media \(max-width: 760px\)[^{]*\{[\s\S]*\.context-menu \.menu-title \{\s*display: block;/);
  });
});
