// The per-move menu offers only entries the page can act on and then show.
// Evidence for each removal is in tmp/briefs/REPORT.md; this pins the tree-
// facing contract so the entries cannot quietly come back or drift back to
// states the view does not draw.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const webSrc = join(root, "..");
const session = readFileSync(join(webSrc, "controllers", "build-session.js"), "utf8");
const css = readFileSync(join(webSrc, "styles.css"), "utf8");

const menuSource = () =>
  session.slice(session.indexOf("function openNodeContextMenu("), session.indexOf("async function handleNodeContextAction("));

describe("move menu — entries the panel can show", () => {
  it("offers generate, mainline, branch, comment, copy and delete, and nothing else", () => {
    const source = menuSource();
    for (const action of ["generate", "set_mainline", "disable_branch", "add_comment", "copy_fen", "copy_line_pgn", "delete"]) {
      expect(source).toContain(`"${action}"`);
    }
    // Mark prepared left: no view draws it, and the server already flags your
    // own moves. Tag left: no view reads a tag; the comment is the note the
    // tree dots. Export branch PGN left: Copy line PGN is the same text.
    for (const gone of ['"mark_prepared"', '"add_tag"', '"export_branch_pgn"']) {
      expect(source).not.toContain(gone);
    }
  });

  it("does not offer an entry whose action is already the state", () => {
    const source = menuSource();
    // "Mainline (active)" was an item that did nothing when clicked; a move
    // that already is the mainline no longer lists the action, and the root is
    // always the mainline.
    expect(source).not.toContain("Mainline (active)");
    expect(source).toMatch(/node\.is_mainline \|\| !node\.parent_id \? \[\]/);
    // Delete on the starting position would be refused after the click.
    expect(source).toMatch(/node\.parent_id \? \[\[\s*\["delete", "Delete this move"\]\]\] : \[\]/);
  });

  it("offers the shown move's menu from ⋯ only on a move, not the start position", () => {
    // The root node carries san "root", so the ⋯ menu listed "Move 1. root…".
    const open = session.slice(session.indexOf("function openBuildMenu("), session.indexOf("function openBuildMenu(") + 1600);
    expect(open).toMatch(/node\?\.san && node\.parent_id \? \[\["build-node-menu"/);
    // "Move 3. d4…" read as the verb; the entry names the move as its object.
    expect(open).toContain("`Options for ${nodeMenuHeading(node)}…`");
  });

  it("names the note entry for what it will do", () => {
    const source = menuSource();
    expect(source).toMatch(/node\.comment \? "Edit note…" : "Add note…"/);
  });

  it("is a keyboard menu, like the repertoire's own", () => {
    const source = menuSource();
    expect(source).toContain('role="menuitem"');
    expect(source).toContain('menu.setAttribute("role", "menu")');
    expect(source).toContain('menu.setAttribute("aria-label", "Move actions")');
    // Arrow keys / Home / End come from the shared menu helper.
    expect(source).toContain("menuKeys(menu, close)");
    expect(source).toContain('menu.querySelector("button")?.focus()');
  });
});

describe("move menu — the tree shows what the menu changes", () => {
  it("shows a move's note under the move, through the move-text renderer", () => {
    const view = readFileSync(join(webSrc, "views", "build.js"), "utf8");
    expect(view).toContain('class="mtree-comment${open}" data-note-for=');
    expect(view).toContain("${noteHtml(b)}");
    expect(view).not.toContain("mtree-note\"");
  });

  it("draws a disabled branch struck through", () => {
    expect(css).toMatch(/\.mtree-move\.is-disabled \{[^}]*text-decoration:\s*line-through/);
  });
});
