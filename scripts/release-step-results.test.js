import { expect, it } from "vitest";
import { requiredStepFailures } from "./release-step-results.mjs";

it("an aborted journey fails when required steps never ran", () => {
  expect(requiredStepFailures([{ id: "auth", pass: true }], new Set(["auth", "save"]))).toEqual(["save"]);
  expect(requiredStepFailures([], new Set(["auth", "save"]))).toEqual(["auth", "save"]);
});

it("only explicit success satisfies each required step", () => {
  expect(requiredStepFailures([{ id: "auth", pass: true }, { id: "save", pass: false }], ["auth", "save"])).toEqual(["save"]);
  expect(requiredStepFailures([{ id: "auth", pass: true }, { id: "save", pass: true }], ["auth", "save"])).toEqual([]);
});
