import { beforeEach, describe, expect, it } from "vitest";

import {
  forgetInviteUrl,
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

  it("Copy is the primary button and Revoke is a quiet secondary action", () => {
    const model = inviteDialogModel({
      status: { exists: true, created_at: "2026-09-01T00:00:00+00:00" },
      url: "https://app.test/?join=X",
    });
    const primary = model.actions.filter((a) => a.kind === "primary");
    expect(primary.map((a) => a.id)).toEqual(["copy"]);
    expect(model.actions.find((a) => a.id === "revoke").kind).toBe("danger-quiet");
    const html = inviteDialogBodyHtml(model, (s) => String(s));
    expect(html).toContain('class="btn primary" data-action="copy"');
    expect(html).toContain('class="btn danger-quiet" data-action="revoke"');
    expect(html).not.toContain("replaces any previous link");
  });
});
