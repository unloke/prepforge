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
  expect(retry).toMatchObject({ retry: true, encoded: "due:rep:t2", targets: [target("t2")] });
  expect(smart.queue.map((card) => card.encoded)).toEqual(["due:rep:t1,t2,t3", "due:rep:b", "due:rep:c", "due:rep:t2", "due:rep:d", "due:rep:e"]);
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
  expect(smart.queue.filter((card) => card.encoded === "due:rep:t2")).toHaveLength(2);
});
