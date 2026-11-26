import { expect, it } from "vitest";
import { requeueMissedTarget } from "./train-retry.js";

const target = (id) => ({ node_id: id, san: id });

function session() {
  const line = { kind: "due", encoded: "due:rep:t1,t2,t3", targets: [target("t1"), target("t2"), target("t3")] };
  const rest = ["b", "c", "d", "e"].map((id) => ({ kind: "due", encoded: `due:rep:${id}`, targets: [target(id)] }));
  return { queue: [line, ...rest], cardIndex: 0, targetIndex: 1, requeueGap: 3, totalCards: 5, counts: { due: 5 } };
}

it("a missed move returns alone and ungraded, the gap later", () => {
  const smart = session();
  expect(requeueMissedTarget(smart, target("t2"))).toEqual({ added: true, pending: true });
  const retry = smart.queue[3];
  // Only the missed move: the two the player got right are not asked (or graded) again.
  // The retry mark rides in the synced encoding, so a reload or resume keeps it.
  expect(retry).toMatchObject({ retry: true, encoded: "due:rep:t2:retry", targets: [target("t2")] });
  expect(smart.queue.map((card) => card.encoded)).toEqual(["due:rep:t1,t2,t3", "due:rep:b", "due:rep:c", "due:rep:t2:retry", "due:rep:d", "due:rep:e"]);
  expect(smart).toMatchObject({ totalCards: 6, counts: { due: 6 } });
});

it("keeps one pending retry per move", () => {
  const smart = session();
  requeueMissedTarget(smart, target("t2"));
  expect(requeueMissedTarget(smart, target("t2"))).toEqual({ added: false, pending: true });
  expect(smart.queue).toHaveLength(6);
});

it("a missed retry card comes back once more", () => {
  const smart = session();
  requeueMissedTarget(smart, target("t2"));
  smart.cardIndex = 3;
  smart.targetIndex = 0;
  expect(requeueMissedTarget(smart, target("t2")).added).toBe(true);
  expect(smart.queue.filter((card) => card.encoded === "due:rep:t2:retry")).toHaveLength(2);
});

it("a missed new move comes back as recall, not a second lesson", () => {
  const smart = { queue: [{ kind: "new", encoded: "new:rep:n1,n2", targets: [target("n1"), target("n2")] }],
    cardIndex: 0, requeueGap: 3, totalCards: 1, counts: { new: 1 } };
  requeueMissedTarget(smart, target("n2"));
  // A "new" card shows the answer first and counts as learned; its retry does neither.
  expect(smart.queue[1]).toMatchObject({ kind: "due", retry: true, encoded: "due:rep:n2:retry" });
  expect(smart.counts).toEqual({ new: 1, due: 1 });
});
