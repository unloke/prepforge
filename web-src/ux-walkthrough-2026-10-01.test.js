// Regressions for the 2026-10-01 UX walkthrough fixes that live in small
// helpers: repertoire color choice (P0-4), guest Line rehearsal Start (P0-1),
// the sign-in modal's carried-over Enter (P0-3), create-account copy (P3-1)
// the email shape check (P3-2), hint retention after a miss (P1-4) and the
// Train save chip copy (P2-7).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { normalizeRepertoireColor, repertoireColorField } from "./repertoire-color.js";
import { trainStartDisabled } from "./train-start.js";
import { authInputError, authReasonFor, isOpeningKeystroke } from "./controllers/account.js";
import { coachTipMayReplace, wrongMoveTip } from "./train-hint.js";
import { syncChipVariant } from "./sync-chip.js";
import { nodeMenuHeading } from "./node-menu.js";

const root = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(root, "app.js"), "utf8");

describe("repertoire color is a two-way choice (P0-4)", () => {
  it("offers exactly White and Black as a select", () => {
    const field = repertoireColorField();
    expect(field.name).toBe("color");
    expect(field.type).toBe("select");
    expect(field.options.map((o) => o.value)).toEqual(["white", "black"]);
    expect(field.default).toBe("white");
    expect(repertoireColorField("black").default).toBe("black");
    expect(repertoireColorField("BLACK ").default).toBe("black");
  });

  it("normalizes the submitted value", () => {
    expect(normalizeRepertoireColor("black")).toBe("black");
    expect(normalizeRepertoireColor("white")).toBe("white");
    expect(normalizeRepertoireColor(undefined)).toBe("white");
  });

  it("no create/import dialog asks for the color as free text anymore", () => {
    expect(app).not.toMatch(/Your color \(white \/ black\)/);
    expect(app.match(/repertoireColorField\(/g) || []).toHaveLength(3);
  });
});

describe("guest Line rehearsal Start (P0-1)", () => {
  it("stays clickable for a guest so the click reaches the sign-in gate", () => {
    expect(trainStartDisabled({ mode: "all_lines", signedIn: false, hasRepertoire: false })).toBe(false);
  });

  it("still waits on the picker for a signed-in user without a repertoire", () => {
    expect(trainStartDisabled({ mode: "all_lines", signedIn: true, hasRepertoire: false })).toBe(true);
    expect(trainStartDisabled({ mode: "all_lines", signedIn: true, hasRepertoire: true })).toBe(false);
  });

  it("never disables Smart queue or Play", () => {
    for (const mode of ["smart", "play"]) {
      expect(trainStartDisabled({ mode, signedIn: true, hasRepertoire: false })).toBe(false);
      expect(trainStartDisabled({ mode, signedIn: false, hasRepertoire: false })).toBe(false);
    }
  });
});

describe("sign-in modal ignores the keystroke that opened it (P0-3)", () => {
  it("drops the palette's Enter, which was stamped before the modal opened", () => {
    expect(isOpeningKeystroke({ key: "Enter", timeStamp: 1000 }, 1000.5)).toBe(true);
  });

  it("handles a later Enter normally", () => {
    expect(isOpeningKeystroke({ key: "Enter", timeStamp: 1500 }, 1000.5)).toBe(false);
  });

  it("does not swallow events without a usable timestamp", () => {
    expect(isOpeningKeystroke({ key: "Enter", timeStamp: 0 }, 1000)).toBe(false);
    expect(isOpeningKeystroke({ key: "Enter" }, 1000)).toBe(false);
  });

  it("the palette also stops its Enter from bubbling to the document", () => {
    const branch = app.slice(app.indexOf('} else if (event.key === "Enter") {', app.indexOf("paletteActive = Math.max")));
    const body = branch.slice(0, branch.indexOf("runPaletteItem"));
    expect(body).toMatch(/event\.stopPropagation\(\)/);
  });
});

describe("create-account copy and email check (P3-1, P3-2)", () => {
  it("rephrases the gate reason on the create-account screen", () => {
    expect(authReasonFor("register", "Sign in to import a repertoire")).toBe("Create an account to import a repertoire");
    expect(authReasonFor("login", "Sign in to import a repertoire")).toBe("Sign in to import a repertoire");
    expect(authReasonFor("register", "")).toBe("");
  });

  it("rejects an email without a dotted domain before posting a registration", () => {
    expect(authInputError("register", { email: "abc@x", password: "longenough" })).toBe("Enter a valid email address.");
    expect(authInputError("register", { email: "abc@x.io", password: "longenough" })).toBe("");
    expect(authInputError("register", { email: "abc@x.io", password: "short" })).toBe(
      "Password must be at least 8 characters.",
    );
  });

  it("keeps the existing empty-field and reset checks", () => {
    expect(authInputError("login", { email: "", password: "" })).toBe("Enter your email and password.");
    expect(authInputError("login", { email: "a@b.co", password: "x" })).toBe("");
    expect(authInputError("forgot", { email: "" })).toBe("Enter your email.");
    expect(authInputError("reset", { password: "longenough", confirm: "different" })).toBe(
      "The two passwords don't match.",
    );
  });
});

describe("Train keeps the requested hint after a miss (P1-4)", () => {
  const hint = { strategy: "Fight for the center", piece: "Move the pawn" };

  it("keeps Hint 2 instead of the generic phase tip", () => {
    expect(
      wrongMoveTip({ hintLevel: 2, hint, coachTip: "Develop your pieces, occupy the center, and get the king safe." }),
    ).toBe("Move the pawn");
  });

  it("keeps Hint 1 and the revealed answer at their levels", () => {
    expect(wrongMoveTip({ hintLevel: 1, hint, coachTip: "generic" })).toBe("Fight for the center");
    expect(wrongMoveTip({ hintLevel: 3, hint, expectedSan: "e4", coachTip: "generic" })).toBe("Play e4");
  });

  it("without a requested hint, uses the coach tip, then the line's hints", () => {
    expect(wrongMoveTip({ hintLevel: 0, hint, coachTip: "Coach says" })).toBe("Coach says");
    expect(wrongMoveTip({ hintLevel: 0, hint })).toBe("Fight for the center");
    expect(wrongMoveTip({ hintLevel: 0, hint: {} })).toBe("Think about the idea behind the line.");
  });

  it("a late coach tip never overwrites a requested hint", () => {
    expect(coachTipMayReplace(0)).toBe(true);
    expect(coachTipMayReplace(undefined)).toBe(true);
    expect(coachTipMayReplace(2)).toBe(false);
  });
});

describe("Train save chip names training progress (P2-7)", () => {
  it("says progress, not 'Unsaved changes', on Train", () => {
    expect(syncChipVariant("dirty", "training").text).not.toMatch(/Unsaved changes/);
    expect(syncChipVariant("dirty", "training").text).toMatch(/progress/i);
    expect(syncChipVariant("saved", "training").text).toBe("✓ Progress saved");
    expect(syncChipVariant("syncing", "training").cls).toBe("is-syncing");
  });

  it("keeps the Repertoire wording and every error state", () => {
    expect(syncChipVariant("dirty").text).toBe("• Unsaved changes");
    expect(syncChipVariant("error", "training").text).toBe("⚠ Offline — will retry");
    expect(syncChipVariant("unknown", "training").cls).toBe("is-saved");
  });
});

describe("Repertoire node menu names its move (P2-8)", () => {
  it("labels white and black moves with their move number", () => {
    expect(nodeMenuHeading({ san: "Bxe6", move_number: 8, move_side: "white" })).toBe("8. Bxe6");
    expect(nodeMenuHeading({ san: "c5", move_number: 1, move_side: "black" })).toBe("1… c5");
    expect(nodeMenuHeading({ san: null, move_number: 0 })).toBe("Start position");
  });

  it("the menu renders the heading and clears the tree outline on close", () => {
    const open = app.slice(app.indexOf("function openNodeContextMenu("));
    const openBody = open.slice(0, open.indexOf("\nfunction "));
    expect(openBody).toMatch(/nodeMenuHeading\(node\)/);
    expect(openBody).toMatch(/markNodeMenuTarget\(nodeId\)/);
    // The repertoire (Library) menu has no tree node to outline.
    const repMenu = app.slice(app.indexOf('["toggle-active"'));
    expect(repMenu.slice(0, repMenu.indexOf("\nfunction "))).not.toMatch(/markNodeMenuTarget/);
    const close = app.slice(app.indexOf("function closeNodeContextMenu("));
    expect(close.slice(0, close.indexOf("\n}"))).toMatch(/markNodeMenuTarget\(null\)/);
  });
});

describe("command palette scrim matches modals in both themes (P2-3)", () => {
  const css = readFileSync(join(root, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  // Background of the rule whose selector is exactly `selector`.
  const bg = (selector) => {
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (m[1].trim() !== selector) continue;
      const hit = m[2].match(/background\s*:\s*([^;]+);/);
      if (hit) return hit[1].trim();
    }
    return null;
  };

  it("does not derive the backdrop from the text color (light in dark mode)", () => {
    expect(bg(".palette")).toBeTruthy();
    expect(bg(".palette")).not.toMatch(/--text/);
    expect(bg(".palette")).toBe(bg(".modal-overlay"));
  });
});
