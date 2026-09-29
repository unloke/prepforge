import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDashboardView, filterLibraryRows } from "./dashboard.js";

// Characterization for the Library filter bar (ui-prototype-v2 round):
//  - All / White / Black / Shared / Disabled + a repertoire name search are a
//    pure client-side narrowing of the cached /api/repertoires listing — no
//    refetch, no reshaped rows;
//  - selection follows the visible list (the selected row is gone → first
//    shown row), preview/keyboard markup is untouched;
//  - the shared read-only fallback survives filtering;
//  - role="option" rows always sit in a role="listbox" container, which drops
//    the role again for empty states.

const REPS = [
  {
    id: "rep-1",
    name: "Caro-Kann: Advance",
    color: "black",
    is_active: true,
    visibility: "private",
    health: null,
  },
  {
    id: "rep-2",
    name: "London System",
    color: "white",
    is_active: true,
    visibility: "team",
    team_id: "t1",
    health: null,
  },
  {
    id: "rep-3",
    name: "QGD vs 1.d4",
    color: "black",
    is_active: false,
    visibility: "private",
    health: null,
  },
];

describe("filterLibraryRows (pure predicate)", () => {
  it("keeps everything for All and narrows by colour", () => {
    expect(filterLibraryRows(REPS, { filter: "all" })).toHaveLength(3);
    expect(filterLibraryRows(REPS, { filter: "white" }).map((r) => r.id)).toEqual(["rep-2"]);
    expect(filterLibraryRows(REPS, { filter: "black" }).map((r) => r.id)).toEqual([
      "rep-1",
      "rep-3",
    ]);
  });

  it("matches Shared on team visibility and on shared fallback rows", () => {
    const sharedRows = [{ id: "s1", name: "Team prep", color: "white", sharedRow: true }];
    expect(filterLibraryRows(REPS, { filter: "shared" }).map((r) => r.id)).toEqual(["rep-2"]);
    expect(
      filterLibraryRows([...REPS, ...sharedRows], { filter: "shared" }).map((r) => r.id),
    ).toEqual(["rep-2", "s1"]);
  });

  it("matches Disabled on the production is_active state only", () => {
    expect(filterLibraryRows(REPS, { filter: "disabled" }).map((r) => r.id)).toEqual(["rep-3"]);
  });

  it("searches repertoire names case-insensitively and combines with a filter", () => {
    expect(filterLibraryRows(REPS, { query: "london" }).map((r) => r.id)).toEqual(["rep-2"]);
    expect(filterLibraryRows(REPS, { query: "  CARO  " }).map((r) => r.id)).toEqual(["rep-1"]);
    expect(
      filterLibraryRows(REPS, { filter: "black", query: "caro" }).map((r) => r.id),
    ).toEqual(["rep-1"]);
    expect(filterLibraryRows(REPS, { filter: "black", query: "london" })).toEqual([]);
    expect(filterLibraryRows(null, {})).toEqual([]);
  });
});

describe("library filter wiring", () => {
  let container;
  let view;
  let api;

  function makeContainer() {
    return {
      innerHTML: "",
      querySelectorAll: vi.fn(() => []),
      addEventListener: vi.fn(),
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
    };
  }

  beforeEach(() => {
    container = makeContainer();
    const elements = new Map([
      ["dashboard-repertoires", container],
      ["dashboard-rep-count", { hidden: true, textContent: "" }],
    ]);
    globalThis.document = {
      getElementById: (id) => elements.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    api = vi.fn(async (url) => {
      if (String(url).startsWith("/api/teams")) return { teams: [{ id: "t1", name: "Club" }] };
      return { repertoires: REPS, shared: [] };
    });
    view = createDashboardView({
      appState: { signedIn: true, teams: [], pendingRepDeletes: new Set() },
      api,
      postJson: vi.fn(),
      escapeHtml: (s) => String(s),
      setStatus: vi.fn(),
      localDateString: () => "2026-09-28",
      goToSmartTraining: vi.fn(),
      editRepertoire: vi.fn(),
      openRepertoireContextMenu: vi.fn(),
      createRepertoirePrompt: vi.fn(),
      hydrateBuild: vi.fn(),
      showInputModal: vi.fn(),
      promptImportRepertoireFromPgn: vi.fn(),
      requireSignIn: vi.fn(),
      goToView: vi.fn(),
    });
  });

  afterEach(() => {
    delete globalThis.document;
  });

  it("renders every row under All and narrows the table per filter without refetching", async () => {
    await view.loadDashboardRepertoires();
    expect(container.innerHTML).toContain('data-repertoire-id="rep-1"');
    expect(container.innerHTML).toContain('data-repertoire-id="rep-2"');
    expect(container.innerHTML).toContain('data-repertoire-id="rep-3"');
    expect(container.innerHTML.match(/class="lib-row /g) || []).toHaveLength(3);
    const callsAfterLoad = api.mock.calls.length;

    view.setLibraryFilter("black");
    expect(container.innerHTML).toContain('data-repertoire-id="rep-1"');
    expect(container.innerHTML).toContain('data-repertoire-id="rep-3"');
    expect(container.innerHTML).not.toContain('data-repertoire-id="rep-2"');
    expect(api.mock.calls.length).toBe(callsAfterLoad);

    view.setLibraryFilter("disabled");
    expect(container.innerHTML.match(/class="lib-row /g) || []).toHaveLength(1);
    expect(container.innerHTML).toContain('data-repertoire-id="rep-3"');

    view.setLibraryFilter("shared");
    expect(container.innerHTML.match(/class="lib-row /g) || []).toHaveLength(1);
    expect(container.innerHTML).toContain('data-repertoire-id="rep-2"');
  });

  it("searches repertoire names from the same cached listing", async () => {
    await view.loadDashboardRepertoires();
    view.setLibraryQuery("qgd");
    expect(container.innerHTML.match(/class="lib-row /g) || []).toHaveLength(1);
    expect(container.innerHTML).toContain('data-repertoire-id="rep-3"');
    view.setLibraryQuery("");
    expect(container.innerHTML.match(/class="lib-row /g) || []).toHaveLength(3);
  });

  it("moves selection to the first shown row when the selected one is filtered out", async () => {
    await view.loadDashboardRepertoires();
    // Default selection is the first row (rep-1, black). The option role sits
    // on the inner .lib-opt so the ⋯ menu button stays outside the option.
    expect(container.innerHTML).toMatch(
      /class="lib-row list-item[^"]*is-selected[^"]*"[^>]*data-repertoire-id="rep-1"/,
    );
    expect(container.innerHTML).toContain('class="lib-opt" role="option"');
    expect(container.innerHTML).not.toMatch(
      /role="option"[^>]*aria-haspopup/, // button must not live inside an option
    );
    view.setLibraryFilter("white");
    expect(container.innerHTML).toMatch(
      /class="lib-row list-item[^"]*is-selected[^"]*"[^>]*data-repertoire-id="rep-2"/,
    );
    expect(container.innerHTML.match(/aria-selected="true"/g) || []).toHaveLength(2);
  });

  it("shows a filter empty state and clears it when a filter matches again", async () => {
    await view.loadDashboardRepertoires();
    view.setLibraryQuery("no such repertoire");
    expect(container.innerHTML).toContain("No repertoires match this filter.");
    expect(container.innerHTML).not.toContain('role="option"');
    view.setLibraryQuery("");
    expect(container.innerHTML).toContain('data-repertoire-id="rep-2"');
  });

  it("keeps the shared read-only fallback behaviour under filters", async () => {
    api.mockImplementation(async (url) => {
      if (String(url).startsWith("/api/teams")) return { teams: [] };
      return {
        repertoires: [],
        shared: [
          { id: "s1", name: "Club anti-Sicilian", color: "white" },
          { id: "s2", name: "Club endgames", color: "black" },
        ],
      };
    });
    await view.loadDashboardRepertoires();
    expect(container.innerHTML).toContain('data-shared="1"');
    expect(container.innerHTML).toContain("read-only");
    expect(container.innerHTML.match(/class="lib-row /g) || []).toHaveLength(2);

    view.setLibraryFilter("shared");
    expect(container.innerHTML.match(/class="lib-row /g) || []).toHaveLength(2);
    view.setLibraryFilter("black");
    expect(container.innerHTML.match(/class="lib-row /g) || []).toHaveLength(1);
    expect(container.innerHTML).toContain('data-repertoire-id="s2"');
  });

  it("gives the role=option rows a real listbox container and drops it for empty states", async () => {
    await view.loadDashboardRepertoires();
    expect(container.setAttribute).toHaveBeenCalledWith("role", "listbox");
    expect(container.setAttribute).toHaveBeenCalledWith("aria-label", "Repertoires");
    expect(container.removeAttribute).not.toHaveBeenCalled();

    container.setAttribute.mockClear();
    view.setLibraryQuery("nothing matches");
    expect(container.removeAttribute).toHaveBeenCalledWith("role");
    expect(container.setAttribute).not.toHaveBeenCalled();
  });
});
