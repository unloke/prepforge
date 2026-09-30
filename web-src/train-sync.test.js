import { describe, expect, it } from "vitest";

import {
  flushGroups,
  groupAttempts,
  isRetriableSyncError,
  ungroupAttempts,
} from "./train-sync.js";

const attempt = (session, node, correct = true) => ({
  session_id: session,
  node_id: node,
  correct,
  attempt_uuid: `${session}-${node}`,
});

function httpError(status) {
  const err = new Error(`HTTP ${status}`);
  err.status = status;
  return err;
}

describe("groupAttempts", () => {
  it("groups by session preserving play order within each group", () => {
    const groups = groupAttempts(
      [attempt("a", "n1"), attempt("b", "n2", false), attempt("a", "n3")],
      "a",
    );
    expect(groups).toEqual([
      ["a", [{ node_id: "n1", correct: true, attempt_uuid: "a-n1" }, { node_id: "n3", correct: true, attempt_uuid: "a-n3" }]],
      ["b", [{ node_id: "n2", correct: false, attempt_uuid: "b-n2" }]],
    ]);
  });

  it("adds an empty group for the current session so a dirty position still flushes", () => {
    const groups = groupAttempts([attempt("old", "n1")], "current");
    expect(groups).toEqual([
      ["old", [{ node_id: "n1", correct: true, attempt_uuid: "old-n1" }]],
      ["current", []],
    ]);
  });

  it("does not add a group when there is no current session", () => {
    expect(groupAttempts([attempt("old", "n1")], null)).toHaveLength(1);
  });
});

describe("flushGroups", () => {
  const groups = (...ids) => ids.map((id) => [id, [{ node_id: `${id}-n`, correct: true }]]);

  it("posts every group in order on success", async () => {
    const posted = [];
    const result = await flushGroups(groups("a", "b", "c"), async (id) => posted.push(id));
    expect(posted).toEqual(["a", "b", "c"]);
    expect(result).toEqual({ retriable: false, failedGroups: [], rejectedGroups: [] });
  });

  it("a mid-batch 5xx never requeues already-posted groups", async () => {
    const posted = [];
    const input = groups("a", "b", "c");
    const result = await flushGroups(input, async (id) => {
      if (id === "b") throw httpError(503);
      posted.push(id);
    });
    expect(posted).toEqual(["a"]); // "a" landed and is NOT in failedGroups
    expect(result.retriable).toBe(true);
    expect(result.failedGroups).toEqual([input[1], input[2]]); // failing + unsent
  });

  it("a network error (no status) is retriable like a 5xx", async () => {
    const input = groups("a", "b");
    const result = await flushGroups(input, async (id) => {
      if (id === "a") throw new TypeError("Failed to fetch");
    });
    expect(result.retriable).toBe(true);
    expect(result.failedGroups).toEqual(input);
  });

  it("a permanent 4xx drops only that group (reported), later groups still land", async () => {
    const posted = [];
    const input = groups("a", "b", "c");
    const result = await flushGroups(input, async (id) => {
      if (id === "b") throw httpError(404);
      posted.push(id);
    });
    expect(posted).toEqual(["a", "c"]);
    expect(result.retriable).toBe(false);
    expect(result.failedGroups).toEqual([]);
    // The dropped attempts are reported, never silently discarded.
    expect(result.rejectedGroups).toEqual([
      { sessionId: "b", attempts: input[1][1], status: 404 },
    ]);
  });

  it("auth, CSRF, conflict and rate-limit 4xx keep the attempts queued and retriable", async () => {
    for (const status of [401, 403, 409, 429]) {
      const input = groups("a", "b");
      const posted = [];
      const result = await flushGroups(input, async (id) => {
        if (id === "a") throw httpError(status);
        posted.push(id);
      });
      expect(posted).toEqual([]); // flush stops at the unacknowledged group
      expect(result.retriable).toBe(true);
      expect(result.failedGroups).toEqual(input); // nothing lost
      expect(result.rejectedGroups).toEqual([]);
    }
  });

  it("a permanent 4xx followed by a 5xx reports both outcomes", async () => {
    const input = groups("a", "b", "c");
    const result = await flushGroups(input, async (id) => {
      if (id === "a") throw httpError(422);
      if (id === "b") throw httpError(500);
    });
    expect(result.retriable).toBe(true);
    expect(result.failedGroups).toEqual([input[1], input[2]]);
    expect(result.rejectedGroups).toEqual([
      { sessionId: "a", attempts: input[0][1], status: 422 },
    ]);
  });
});

describe("isRetriableSyncError", () => {
  it("treats network errors, 5xx and transient 4xx as retriable", () => {
    expect(isRetriableSyncError(new TypeError("Failed to fetch"))).toBe(true);
    for (const status of [401, 403, 408, 409, 423, 425, 429, 500, 503]) {
      expect(isRetriableSyncError({ status })).toBe(true);
    }
  });

  it("treats permanent 4xx as non-retriable", () => {
    for (const status of [400, 404, 410, 422]) {
      expect(isRetriableSyncError({ status })).toBe(false);
    }
  });
});

describe("ungroupAttempts", () => {
  it("is the inverse of groupAttempts for requeueing", () => {
    const pending = [attempt("a", "n1"), attempt("a", "n2", false), attempt("b", "n3")];
    expect(ungroupAttempts(groupAttempts(pending, null))).toEqual(pending);
  });

  it("drops empty groups (the current-session placeholder carries no attempts)", () => {
    expect(ungroupAttempts([["a", []]])).toEqual([]);
  });
});
