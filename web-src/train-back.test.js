// Train: a running queue or rehearsal hid the mode tabs with no way back but a
// muted text link, and a finished session had none at all. Modes replaces the
// tabs in the panel head for every non-setup state. A Practice game keeps the
// tabs, and leaving a game with moves on the board asks first (it is lost);
// a queue or rehearsal never asks (the server resumes it on Start).
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appSource } from "./test-app-source.js";
import { confirmAbandonGame, playGameInProgress } from "./train-play.js";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html"), "utf8");
const source = appSource();

describe("Train back to modes", () => {
  it("Modes sits in the panel head beside the tabs", () => {
    const head = html.match(/<aside class="sidebar train-sidebar[^>]*>\s*<div class="panel-head">([\s\S]*?)\n {12}<\/div>/);
    expect(head).not.toBeNull();
    expect(head[1]).toContain('id="train-modes"');
    expect(head[1]).toMatch(/<button type="button" class="btn ghost sm train-back" id="train-back"[^>]*>[\s\S]*<span>Modes<\/span><\/button>/);
    // The mode name in the session card is a label now, not a hidden control.
    expect(html).toContain('<span class="train-mode-name" id="train-mode-name"></span>');
  });

  it("Modes clears the session and selects the current mode without a confirm", () => {
    const at = source.indexOf('getElementById("train-back")');
    expect(at).toBeGreaterThan(0);
    const handler = source.slice(at, source.indexOf("});", at));
    expect(handler).toMatch(/appState\.smart = null;\s*appState\.training = null;\s*selectTrainMode\(appState\.trainMode \|\| "smart"\)/);
    expect(handler).not.toContain("showConfirmModal");
  });

  it("switching tabs mid-game asks before the game is abandoned", () => {
    const at = source.indexOf('querySelectorAll("#train-modes .train-mode").forEach((btn) => {');
    const handler = source.slice(at, source.indexOf("selectTrainMode(btn.dataset.mode);", at));
    expect(handler).toContain('if (!(await confirmAbandonGame(appState.play, showConfirmModal, "Leave this game?", "Leave game"))) return;');
  });

  it("only a live game with moves counts as progress to lose", () => {
    expect(playGameInProgress(null)).toBe(false);
    expect(playGameInProgress({ active: true, history: [] })).toBe(false);
    expect(playGameInProgress({ active: false, history: ["e2e4"] })).toBe(false);
    expect(playGameInProgress({ active: true, history: ["e2e4"] })).toBe(true);
  });

  it("asks only when a game would be lost, and passes the answer through", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    expect(await confirmAbandonGame({ active: true, history: [] }, confirm, "Leave this game?", "Leave game")).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(await confirmAbandonGame({ active: true, history: ["e2e4"] }, confirm, "Leave this game?", "Leave game")).toBe(false);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Leave this game?", okLabel: "Leave game", cancelLabel: "Keep playing" }));
  });
});
