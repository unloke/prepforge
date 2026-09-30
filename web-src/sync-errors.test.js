import { describe, expect, it } from "vitest";

import { classifySyncError, describeSyncError } from "./sync-errors.js";

// One error-class contract for the local-first flushes (R-01/R-02/R-04):
// network/5xx/401/403/409/429 keep the draft and tell the user what to do;
// only genuinely permanent payload errors (400/422/404/410) become "rejected"
// — never dropped silently, never marked Saved.

describe("classifySyncError", () => {
  it("treats a fetch failure (no status) as retryable network", () => {
    for (const error of [null, undefined, new Error("offline"), {}]) {
      const info = classifySyncError(error);
      expect(info.kind).toBe("network");
      expect(info.status).toBeNull();
      expect(info.retriable).toBe(true);
      expect(info.keepsDraft).toBe(true);
      expect(info.pauseForAuth).toBe(false);
    }
  });

  it("classifies 5xx / 408 / 425 as retryable server trouble", () => {
    for (const status of [500, 502, 503, 408, 425]) {
      const info = classifySyncError({ status });
      expect(info.kind).toBe("server");
      expect(info.retriable).toBe(true);
      expect(info.keepsDraft).toBe(true);
    }
  });

  it("pauses for auth on 401 but keeps every draft", () => {
    const info = classifySyncError({ status: 401 });
    expect(info.kind).toBe("auth");
    expect(info.pauseForAuth).toBe(true);
    expect(info.retriable).toBe(true);
    expect(info.keepsDraft).toBe(true);
  });

  it("treats 403 as a refreshable CSRF problem", () => {
    const info = classifySyncError({ status: 403 });
    expect(info.kind).toBe("csrf");
    expect(info.retriable).toBe(true);
    expect(info.keepsDraft).toBe(true);
    expect(info.pauseForAuth).toBe(false);
  });

  it("keeps the draft on 409 conflict but does not auto-retry it", () => {
    const info = classifySyncError({ status: 409 });
    expect(info.kind).toBe("conflict");
    expect(info.retriable).toBe(false);
    expect(info.keepsDraft).toBe(true);
  });

  it("reads retry-after for 429 from headers or the error body", () => {
    const viaHeaders = classifySyncError({
      status: 429,
      headers: { get: (name) => (name === "retry-after" ? "7" : null) },
    });
    expect(viaHeaders.kind).toBe("rate-limit");
    expect(viaHeaders.retryAfterMs).toBe(7000);
    const viaBody = classifySyncError({ status: 429, retryAfter: "3" });
    expect(viaBody.retryAfterMs).toBe(3000);
    const noHint = classifySyncError({ status: 429 });
    expect(noHint.retryAfterMs).toBeNull();
    const badHint = classifySyncError({ status: 429, retryAfter: "soon" });
    expect(badHint.retryAfterMs).toBeNull();
  });

  it("marks 400/404/410/422 permanent for THIS payload but keeps the draft", () => {
    for (const status of [400, 404, 410, 422]) {
      const info = classifySyncError({ status });
      expect(info.kind).toBe("validation");
      expect(info.retriable).toBe(false);
      expect(info.keepsDraft).toBe(true);
    }
  });

  it("falls back to unknown for anything else — still keeping the draft", () => {
    const info = classifySyncError({ status: 200 });
    expect(info.kind).toBe("unknown");
    expect(info.retriable).toBe(true);
    expect(info.keepsDraft).toBe(true);
  });
});

describe("describeSyncError", () => {
  it("makes waiting-for-sign-in and waiting-for-network look different (R-04)", () => {
    const auth = describeSyncError(classifySyncError({ status: 401 }), { count: 2 });
    const offline = describeSyncError(classifySyncError(null), { count: 2 });
    expect(auth).toContain("sign-in");
    expect(auth).toContain("2 edits");
    expect(offline).toContain("Retrying automatically");
    expect(auth).not.toBe(offline);
  });

  it("uses singular wording for exactly one edit", () => {
    const one = describeSyncError(classifySyncError({ status: 422 }), { count: 1 });
    expect(one).toBe("edit could not be saved and is kept for review.");
    const many = describeSyncError(classifySyncError({ status: 422 }), { count: 3 });
    expect(many).toBe("3 edits could not be saved and are kept for review.");
    const none = describeSyncError(classifySyncError({ status: 422 }), {});
    expect(none).toContain("kept for review");
  });

  it("explains conflicts as reconciliation, not data loss", () => {
    const msg = describeSyncError(classifySyncError({ status: 409 }), { count: 1 });
    expect(msg).toContain("changed elsewhere");
    expect(msg).toContain("kept");
  });

  it("carries the rate-limit wait into the message", () => {
    const withHint = describeSyncError(
      { kind: "rate-limit", retryAfterMs: 5000 },
      { count: 1 },
    );
    expect(withHint).toBe("Rate limited — saving again in ~5s. edit kept.");
    const withoutHint = describeSyncError({ kind: "rate-limit", retryAfterMs: null }, {});
    expect(withoutHint).toContain("saved shortly");
  });
});
