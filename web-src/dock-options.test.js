import { describe, expect, it } from "vitest";
import { dockOptionsLabel } from "./dock-options.js";

describe("dockOptionsLabel", () => {
  it("names the Explorer's database", () => {
    expect(dockOptionsLabel({ tab: "explorer", db: "masters" })).toBe("Masters");
    expect(dockOptionsLabel({ tab: "explorer", db: "lichess" })).toBe("Players");
  });
  it("names Coverage's scope and horizon", () => {
    expect(dockOptionsLabel({ tab: "coverage", scope: "repertoire", horizon: "8 moves" })).toBe("Mainline · 8 moves");
    expect(dockOptionsLabel({ tab: "coverage", scope: "branch", horizon: "2 moves" })).toBe("Branch · 2 moves");
    expect(dockOptionsLabel({ tab: "coverage", scope: "branch", horizon: "" })).toBe("Branch");
  });
});
