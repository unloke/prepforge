import { expect, it } from "vitest";
import { MAX_RETRIES_PER_TARGET, requeueMissedTarget } from "./train-retry.js";

const target = (id, extra = {}) => ({ node_id: id, san: id, ...extra });

function session() {
  const line = { kind: "due", encoded: "due:rep:t1,t2,t3", targets: [target("t1"), target("t2"), target("t3")] };
  const rest = ["b", "c", "d", "e"].map((id) => ({ kind: "due", encoded: `due:rep:${id}`, targets: [target(id)] }));
  return { queue: [line, ...rest], cardIndex: 0, targetIndex: 1, requeueGap: 3, totalCards: 5, counts: { due: 5 } };
}

it("a missed move returns alone and ungraded, the gap later", () => {
  const smart = session();
  expect(requeueMissedTarget(smart, target("t2"))).toEqual({ added: true, pending: true });
  const retry = smart.queue[3];
  expect(retry).toMatchObject({ retry: true, encoded: "due:rep:t2:retry", targets: [target("t2")] });
  expect(smart.queue.map((card) => card.encoded)).toEqual([
    "due:rep:t1,t2,t3", "due:rep:b", "due:rep:c", "due:rep:t2:retry", "due:rep:d", "due:rep:e",
  ]);
  expect(smart).toMatchObject({ totalCards: 6, counts: { due: 6 }, missedNodeIds: ["t2"] });
});

it("reconstructs the full run-in and start_fen when extracting a mid-line target", () => {
  const t1 = target("t1", {
    uci: "e2e4", san: "e4", start_fen: "START", fen_before: "START", fen_after: "FEN_E4",
    run_in: [], reply: { uci: "c7c5", san: "c5", fen_after: "FEN_C5" },
  });
  const t2 = target("t2", {
    uci: "g1f3", san: "Nf3", start_fen: "FEN_C5", fen_before: "FEN_C5", fen_after: "FEN_NF3",
    run_in: [], reply: { uci: "d7d6", san: "d6", fen_after: "FEN_D6" },
  });
  const smart = {
    queue: [{ kind: "due", encoded: "due:rep:t1,t2", targets: [t1, t2] }],
    cardIndex: 0, requeueGap: 3, totalCards: 1, counts: { due: 1 },
  };
  requeueMissedTarget(smart, t2);
  expect(smart.queue[1].targets[0]).toMatchObject({
    node_id: "t2",
    start_fen: "START",
    run_in: [
      { uci: "e2e4", san: "e4", fen_after: "FEN_E4" },
      { uci: "c7c5", san: "c5", fen_after: "FEN_C5" },
    ],
  });
});

it("preserves path order when multiple targets on the same card are missed", () => {
  const smart = session();
  requeueMissedTarget(smart, target("t1"));
  requeueMissedTarget(smart, target("t2"));
  const retries = smart.queue.filter((c) => c.retry).map((c) => c.encoded);
  expect(retries).toEqual(["due:rep:t1:retry", "due:rep:t2:retry"]);
});

it("spaces retries by severity: reveal pulls closer, hint schedules further out", () => {
  const hinted = session();
  requeueMissedTarget(hinted, target("t2"), { severity: "hint" });
  expect(hinted.queue[4].encoded).toBe("due:rep:t2:retry");

  const revealed = session();
  requeueMissedTarget(revealed, target("t2"), { severity: "miss" });
  expect(revealed.queue[3].encoded).toBe("due:rep:t2:retry");
  // Second miss / reveal pulls the pending retry forward for quicker consolidation
  expect(requeueMissedTarget(revealed, target("t2"), { severity: "reveal" })).toMatchObject({
    added: false, moved: true, pending: true,
  });
  expect(revealed.queue[2].encoded).toBe("due:rep:t2:retry");
});

it("keeps one pending retry per move and caps total session retries per target", () => {
  const smart = session();
  requeueMissedTarget(smart, target("t2"));
  expect(requeueMissedTarget(smart, target("t2"))).toEqual({ added: false, pending: true });
  expect(smart.queue).toHaveLength(6);

  for (let pass = 1; pass < MAX_RETRIES_PER_TARGET; pass += 1) {
    const idx = smart.queue.findIndex((c, i) => i > smart.cardIndex && c.encoded === "due:rep:t2:retry");
    smart.cardIndex = idx;
    expect(requeueMissedTarget(smart, target("t2")).added).toBe(true);
  }
  const finalIdx = smart.queue.findIndex((c, i) => i > smart.cardIndex && c.encoded === "due:rep:t2:retry");
  smart.cardIndex = finalIdx;
  expect(requeueMissedTarget(smart, target("t2"))).toEqual({ added: false, pending: false, capped: true });
});

it("a missed new move comes back as recall, not a second lesson", () => {
  const smart = {
    queue: [{ kind: "new", encoded: "new:rep:n1,n2", targets: [target("n1"), target("n2")] }],
    cardIndex: 0, requeueGap: 3, totalCards: 1, counts: { new: 1 },
  };
  requeueMissedTarget(smart, target("n2"));
  expect(smart.queue[1]).toMatchObject({ kind: "due", retry: true, encoded: "due:rep:n2:retry" });
  expect(smart.counts).toEqual({ new: 1, due: 1 });
});

it("requires a second delayed confirmation stage after an answer reveal", () => {
  const smart = session();
  requeueMissedTarget(smart, target("t2"), { severity: "reveal" });
  expect(smart.queue[2]).toMatchObject({ encoded: "due:rep:t2:retry", stage: 1, stages: 2 });

  // Passing Stage 1 unaided schedules Stage 2 (+4 cards later) before graduating
  smart.cardIndex = 2;
  expect(requeueMissedTarget(smart, target("t2"), { stageAdvance: true })).toEqual({ added: true, pending: true });
  const stage2 = smart.queue.find((c, i) => i > 2 && c.encoded === "due:rep:t2:retry");
  expect(stage2).toMatchObject({ stage: 2, stages: 2 });

  // Passing Stage 2 unaided graduates completely
  smart.cardIndex = smart.queue.indexOf(stage2);
  expect(requeueMissedTarget(smart, target("t2"), { stageAdvance: true })).toEqual({ added: false, pending: false });
});

it("inserts an anti-echo spacer when missing on the final card of a multi-position queue", () => {
  const earlier = {
    kind: "due", encoded: "due:rep:a",
    targets: [target("a", { fen_before: "FEN_A", fen_after: "FEN_A2", uci: "e2e4" })],
  };
  const last = {
    kind: "due", encoded: "due:rep:z",
    targets: [target("z", { fen_before: "FEN_Z", fen_after: "FEN_Z2", uci: "d2d4" })],
  };
  const smart = { queue: [earlier, last], cardIndex: 1, requeueGap: 3, totalCards: 2, counts: { due: 2 } };
  requeueMissedTarget(smart, last.targets[0]);
  expect(smart.queue.slice(2).map((c) => [c.encoded, Boolean(c.spacer)])).toEqual([
    ["due:rep:a:retry", true],
    ["due:rep:z:retry", false],
  ]);
});
