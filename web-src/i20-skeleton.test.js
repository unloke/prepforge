import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { memberRowsSkeleton, sharedRepRowsSkeleton, teamRowsSkeleton } from "./views/team-skeleton.js";

// Item 20: the panes used to disagree on how they said "loading" — the
// directory and the members pane printed a dashed "Loading…" empty-state box,
// the team name printed italic skeleton-text, and the shared-repertoires pane
// showed nothing at all. All three now use one skeleton row style.

describe("Teams loading skeleton", () => {
  it("has no text and announces nothing while it loads", () => {
    for (const markup of [teamRowsSkeleton(3), memberRowsSkeleton(3), sharedRepRowsSkeleton(2)]) {
      const text = String(markup);
      expect(text).not.toMatch(/Loading/);
      expect(text).toContain('aria-hidden="true"');
      expect(text).not.toContain("empty-state");
      expect(text).not.toContain("skeleton-text");
    }
  });

  it("renders one row per placeholder, each with the shared bar class", () => {
    expect(String(teamRowsSkeleton(3)).match(/is-skeleton/g)).toHaveLength(3);
    expect(String(memberRowsSkeleton(3)).match(/is-skeleton/g)).toHaveLength(3);
    expect(String(sharedRepRowsSkeleton(2)).match(/is-skeleton/g)).toHaveLength(2);
    for (const markup of [teamRowsSkeleton(2), memberRowsSkeleton(2), sharedRepRowsSkeleton(2)]) {
      const bars = String(markup).match(/skeleton-bar/g) || [];
      expect(bars.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("uses the real rows' own classes, so the shape matches what replaces it", () => {
    expect(String(teamRowsSkeleton(1))).toContain('class="team-row is-skeleton"');
    // Members and shared repertoires are the same mem-row in both panes.
    for (const markup of [memberRowsSkeleton(1), sharedRepRowsSkeleton(1)]) {
      expect(String(markup)).toContain('class="mem-row is-skeleton"');
    }
  });

  it("varies the placeholder widths so a list of them reads as rows", () => {
    const widths = [...String(teamRowsSkeleton(4)).matchAll(/width:(\d+)%/g)].map((m) => m[1]);
    expect(new Set(widths).size).toBeGreaterThan(1);
  });
});

// The Account card's static "Loading account…" line is gone from index.html: the
// identity is already in state once /api/auth/me lands, and the skeleton in its
// place is the same bar style as the lists'.
describe("Settings → Account loading", () => {
  it("paints the account from state before the /api/settings read lands", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    expect(html).not.toContain("Loading account…");
    expect(html).toMatch(/id="settings-account-body"[^>]*role="status"/);
    expect(html).toContain("acct-skeleton-avatar");
    expect(html).toContain("skeleton-bar");
  });

  it("shares one billing read between the first paint and the settings re-render", async () => {
    const { createAccountSection } = await import("./views/settings-account.js");
    const body = { _html: "", set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; }, addEventListener: vi.fn() };
    globalThis.document = { getElementById: (id) => (id === "settings-account-body" ? body : null) };
    const api = vi.fn(async (path) => {
      if (path === "/api/billing/status") return { plan: "pro", billing_enabled: true, price_configured: true };
      return {};
    });
    const appState = { signedIn: true, account: { email: "a@b.test", displayName: "A", hasPassword: true, plan: "pro" } };
    const section = createAccountSection({
      appState, api, postJson: vi.fn(), setStatus: vi.fn(), showConfirmModal: vi.fn(),
      download: vi.fn(), navigate: vi.fn(),
    });
    // Both refreshes in flight together (first paint + the settings re-render)
    // must collapse into one billing request.
    await Promise.all([section.refresh(), section.refresh()]);
    expect(api.mock.calls.filter(([path]) => path === "/api/billing/status")).toHaveLength(1);
    // And the identity painted from state without waiting for anything.
    expect(body.innerHTML).toContain("a@b.test");
    expect(body.innerHTML).toContain("Manage subscription");
    delete globalThis.document;
  });
});

// The Library's cold start used to sit on a spinner plus "Loading your
// library…". It now ships skeleton rows at the real row geometry, so the list
// appears at its final height and shape the moment the view paints.
describe("Library cold-start skeleton", () => {
  it("ships skeleton rows instead of a spinner in the static markup", () => {
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    const list = html.match(/<div id="dashboard-repertoires"[\s\S]*?<\/div><\/div>/)[0];
    expect(list).toContain("is-skeleton");
    expect(list).not.toContain("library-loading");
    // The status label is the load announcement; no visible sentence stays.
    expect(list).toContain('aria-label="Loading your library"');
    expect(list).not.toMatch(/<p>[^<]*Loading/);
    expect(list).not.toContain('class="spinner"');
    // Enough rows to read as a table, and they keep the real row classes so the
    // grid columns (and the phone layout) match the rows that replace them.
    expect(list.match(/lib-row is-skeleton/g)).toHaveLength(4);
    for (const cell of ["lib-cell-rep", "lib-cell-mastery", "lib-cell-queue"]) {
      expect(list).toContain(cell);
    }
    // The pane announces the load once, as a status, rather than per row.
    expect(list).toContain('role="status"');
    expect(list).toContain("aria-hidden=\"true\"");
  });

  it("gives the skeleton the same bar and pulse as the tree skeleton", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    // One definition of the bar and the keyframes, shared by every skeleton.
    expect(css.match(/\.skeleton-bar \{/g)).toHaveLength(1);
    expect(css.match(/@keyframes skeleton-pulse/g)).toHaveLength(1);
    expect(css).not.toContain("tree-skeleton");
    expect(css).not.toContain(".lib-loading");
    // Every skeleton row is inert: no hover, no pointer, no focus.
    expect(css).toMatch(/\.lib-row\.is-skeleton \{ cursor: default; \}/);
    expect(css).toMatch(/\.lib-row\.is-skeleton:hover \{ background: none; \}/);
  });
});
