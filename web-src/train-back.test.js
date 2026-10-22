// Train: "‹ Train" is the one way back from a session or a result to Home. A
// drill keeps its progress (Home then offers Resume for that scope); a live
// game with moves on the board asks first, because leaving loses it.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { confirmAbandonGame, playGameInProgress } from "./train-play.js";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const home = readFileSync(new URL("./controllers/train-home.js", import.meta.url), "utf8");

describe("Train back to Home", () => {
  it("‹ Train sits in the panel head, and there are no mode tabs to go back to", () => {
    const head = html.match(/<header class="train-head">([\s\S]*?)<\/header>/);
    expect(head).not.toBeNull();
    expect(head[1]).toMatch(/<button type="button" class="btn ghost sm train-back" id="train-back"[^>]*>[\s\S]*<span>Train<\/span><\/button>/);
    expect(html).not.toContain('id="train-modes"');
  });

  it("the back button and the result's Back to Train both leave through leaveToHome", () => {
    expect(home).toContain('$("train-back").addEventListener("click", () => void leaveToHome());');
    expect(home).toContain('$("train-summary-home").addEventListener("click", () => void leaveToHome());');
    const body = home.slice(home.indexOf("export async function leaveToHome("), home.indexOf("\n}\n", home.indexOf("export async function leaveToHome(")));
    expect(body).toContain('confirmAbandonGame(d.appState.play, d.showConfirmModal, "Leave this game?", "Leave game")');
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
