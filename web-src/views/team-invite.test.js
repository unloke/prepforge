import { beforeEach, describe, expect, it } from "vitest";

import {
  forgetInviteUrl,
  formatDay,
  inviteDialogBodyHtml,
  inviteDialogModel,
  knownInviteUrl,
  rememberInviteUrl,
  runInviteDialog,
} from "./team-invite.js";

// P1-2 (UX walkthrough 2026-09-30): opening the Invite dialog used to mint a new
// code immediately, silently killing the link already shared. The dialog must
// read status first, only rotate on an explicit (confirmed) request, and make
// Copy — not Revoke — the primary action.

function makeUi(actions) {
  const rendered = [];
  let closed = false;
  return {
    rendered,
    get closed() {
      return closed;
    },
    render: (model) => rendered.push(model),
    nextAction: async () => (actions.length ? actions.shift() : null),
    selectUrl: () => {},
    close: () => {
      closed = true;
    },
  };
}

function makeDeps({ status, actions, confirmAnswers = [] }) {
  const calls = [];
  let current = status;
  const api = async (path, opts = {}) => {
    calls.push([opts.method || "GET", path]);
    if (opts.method === "DELETE") {
      current = { exists: false };
      return null;
    }
    return current;
  };
  const postJson = async (path) => {
    calls.push(["POST", path]);
    current = { exists: true, created_at: "2026-09-30T10:00:00+00:00", expires_at: null };
    return { code: "NEWCODE", url: "/?join=NEWCODE", expires_at: null };
  };
  const copied = [];
  const confirms = [];
  const ui = makeUi(actions);
  return {
    calls,
    copied,
    confirms,
    ui,
    deps: {
      api,
      postJson,
      origin: "https://app.test",
      copyText: async (t) => copied.push(t),
      confirm: async (opts) => {
        confirms.push(opts);
        return confirmAnswers.length ? confirmAnswers.shift() : false;
      },
      setStatus: () => {},
      setStatusError: () => {},
      ui,
    },
  };
}

beforeEach(() => {
  forgetInviteUrl("t1");
});

describe("invite line formatting", () => {
  it("dates in English whatever the browser locale (the footer uses this)", () => {
    expect(formatDay("2030-10-04T12:00:00Z")).toBe("Oct 4");
    expect(formatDay(null)).toBe("");
  });
});

describe("team invite dialog", () => {
  it("opening never rotates the link: it only reads status", async () => {
    const h = makeDeps({
      status: { exists: true, created_at: "2026-09-01T00:00:00+00:00" },
      actions: ["done"],
    });
    await runInviteDialog("t1", h.deps);
    expect(h.calls).toEqual([["GET", "/api/teams/t1/invite"]]);
    expect(h.ui.rendered[0].state).toBe("hidden");
    expect(h.ui.closed).toBe(true);
  });

  it("generating over a live link asks for confirmation; cancelling keeps the old link", async () => {
    const h = makeDeps({
      status: { exists: true, created_at: "2026-09-01T00:00:00+00:00" },
      actions: ["generate", "done"],
      confirmAnswers: [false],
    });
    await runInviteDialog("t1", h.deps);
    expect(h.confirms).toHaveLength(1);
    expect(h.calls.some(([m]) => m === "POST")).toBe(false);
  });

  it("confirmed regenerate mints, shows and copies the new link", async () => {
    const h = makeDeps({
      status: { exists: true, created_at: "2026-09-01T00:00:00+00:00" },
      actions: ["generate", "done"],
      confirmAnswers: [true],
    });
    await runInviteDialog("t1", h.deps);
    expect(h.calls.filter(([m]) => m === "POST")).toHaveLength(1);
    expect(h.copied).toEqual(["https://app.test/?join=NEWCODE"]);
    const last = h.ui.rendered.at(-1);
    expect(last.state).toBe("known");
    expect(last.url).toBe("https://app.test/?join=NEWCODE");
  });

  it("first link needs no confirmation", async () => {
    const h = makeDeps({ status: { exists: false }, actions: ["generate", "done"] });
    await runInviteDialog("t1", h.deps);
    expect(h.confirms).toHaveLength(0);
    expect(h.calls.filter(([m]) => m === "POST")).toHaveLength(1);
  });

  it("reopening in the same session shows the remembered link without minting", async () => {
    const created = "2026-09-30T10:00:00+00:00";
    rememberInviteUrl("t1", "https://app.test/?join=KEEP", created);
    const h = makeDeps({ status: { exists: true, created_at: created }, actions: ["copy", "done"] });
    await runInviteDialog("t1", h.deps);
    expect(h.calls.some(([m]) => m === "POST")).toBe(false);
    expect(h.ui.rendered[0].url).toBe("https://app.test/?join=KEEP");
    expect(h.copied).toEqual(["https://app.test/?join=KEEP"]);
  });

  it("a remembered link rotated elsewhere is not offered", () => {
    rememberInviteUrl("t1", "https://app.test/?join=OLD", "2026-09-01T00:00:00+00:00");
    expect(knownInviteUrl("t1", { exists: true, created_at: "2026-09-02T00:00:00+00:00" })).toBeNull();
    expect(knownInviteUrl("t1", { exists: false })).toBeNull();
  });

  it("revoke is confirmed, then the dialog shows the no-link state", async () => {
    rememberInviteUrl("t1", "https://app.test/?join=KEEP", null);
    const h = makeDeps({
      status: { exists: true, created_at: null },
      actions: ["revoke", "done"],
      confirmAnswers: [true],
    });
    await runInviteDialog("t1", h.deps);
    expect(h.calls).toContainEqual(["DELETE", "/api/teams/t1/invite"]);
    expect(h.ui.rendered.at(-1).state).toBe("none");
  });

  it("carries one status line and no standing explanation", () => {
    // Every state: the paragraph that explained what a link does is gone; only
    // the live status remains (and only where a link is shown).
    for (const [status, url] of [
      [{ exists: false }, null],
      [{ exists: true, created_at: "2026-09-01T00:00:00+00:00" }, null],
      [{ exists: true, created_at: "2026-09-01T00:00:00+00:00" }, "https://app.test/?join=X"],
    ]) {
      const model = inviteDialogModel({ status, url });
      expect(model.note.length).toBeLessThan(40);
      const html = String(inviteDialogBodyHtml(model));
      expect(html).not.toContain("anyone signed in who opens it");
      expect(html).not.toContain("only shown once");
      if (model.state !== "known") expect(html).not.toContain("data-invite-note");
    }
  });

  it("a link minted in this session shows its created day, not a blank status", () => {
    rememberInviteUrl("t1", "https://app.test/?join=NEW", "2026-09-30T10:00:00+00:00");
    // GET status right after POST /invite can report a fresh row with no timestamp.
    const model = inviteDialogModel({ status: { exists: true, created_at: null }, url: "https://app.test/?join=NEW", teamId: "t1" });
    expect(model.note).toBe("Invite link active · created Sep 30");
  });

  it("returns the last known status so the caller's line follows a mint or revoke", async () => {
    // The dialog stays open across actions; its final status is what the card's
    // invite line under the tabs must show (the old code returned nothing, so
    // the line kept the status from before the mint).
    const minted = makeDeps({ status: { exists: false }, actions: ["generate", "done"] });
    expect(await runInviteDialog("t1", minted.deps)).toEqual({
      exists: true, created_at: "2026-09-30T10:00:00+00:00", expires_at: null,
    });
    const revoked = makeDeps({ status: { exists: true, created_at: null }, actions: ["revoke", "done"], confirmAnswers: [true] });
    expect(await runInviteDialog("t1", revoked.deps)).toEqual({ exists: false });
  });

  it("a failed status read still resolves, so the caller's line is re-read", async () => {
    const ui = makeUi([]);
    const outcome = await runInviteDialog("t1", {
      api: async () => { throw new Error("Network down"); },
      postJson: async () => ({}),
      origin: "https://app.test",
      copyText: async () => {},
      confirm: async () => false,
      setStatus: () => {},
      setStatusError: () => {},
      ui,
    });
    expect(outcome).toBeUndefined();
    expect(ui.closed).toBe(true);
  });

  it("reports each status change to the caller, not just the final one", async () => {
    // The card's line follows a revoke even though the dialog stays open; the
    // caller repaints from the last known status once the stale detail read
    // has landed.
    const seen = [];
    const ui = makeUi(["revoke", "done"]);
    ui.status = (status) => seen.push(status);
    const h = makeDeps({ status: { exists: true, created_at: null }, actions: ["revoke", "done"], confirmAnswers: [true] });
    await runInviteDialog("t1", { ...h.deps, ui });
    // First paint, then the revoke; "done" repaints the same (no-link) state.
    expect(seen).toEqual([{ exists: true, created_at: null }, { exists: false }, { exists: false }]);
  });

  it("Copy is the primary button and Revoke is a quiet secondary action", () => {
    const model = inviteDialogModel({
      status: { exists: true, created_at: "2026-09-01T00:00:00+00:00" },
      url: "https://app.test/?join=X",
    });
    const primary = model.actions.filter((a) => a.kind === "primary");
    expect(primary.map((a) => a.id)).toEqual(["copy"]);
    expect(model.actions.find((a) => a.id === "revoke").kind).toBe("danger-quiet");
    const html = inviteDialogBodyHtml(model);
    expect(String(html)).toContain('class="btn primary" data-action="copy"');
    expect(String(html)).toContain('class="btn danger-quiet" data-action="revoke"');
    expect(String(html)).not.toContain("replaces any previous link");
  });
});
