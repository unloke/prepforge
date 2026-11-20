import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./core/api.js", () => ({ api: vi.fn(), currentOwnerId: vi.fn(), postJson: vi.fn(), setStatus: vi.fn(), setStatusError: vi.fn(), localDateString: vi.fn() }));
vi.mock("./core/modals.js", () => ({ showInputModal: vi.fn() }));
vi.mock("./repertoire-limit.js", () => ({ repertoireLimitMessage: () => "" }));
import { postJson, setStatus } from "./core/api.js";
import { showInputModal } from "./core/modals.js";
import { createLibrary, promptImportRepertoireFromPgn } from "./library-entry.js";

describe("Library PGN import dialog", () => {
  let form, hydrateBuild;
  beforeEach(() => {
    vi.clearAllMocks();
    hydrateBuild = vi.fn();
    createLibrary({ hydrateBuild });
    showInputModal.mockImplementation((options) => { form = options; return Promise.resolve(null); });
  });
  it("keeps empty submissions open without requesting or showing a toast", async () => {
    await promptImportRepertoireFromPgn();
    const close = vi.fn();
    await expect(form.onSubmit({ pgn: "  " }, close)).rejects.toThrow("Paste a PGN or choose a file");
    expect(close).not.toHaveBeenCalled();
    expect(postJson).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });
  it("leaves server validation errors for the dialog's inline error handler", async () => {
    await promptImportRepertoireFromPgn();
    postJson.mockRejectedValueOnce(new Error("PGN must contain at least one legal move."));
    const close = vi.fn();
    await expect(form.onSubmit({ pgn: "junk" }, close)).rejects.toThrow("PGN must contain");
    expect(close).not.toHaveBeenCalled();
    expect(hydrateBuild).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });
  it("imports valid PGN, closes on success and quotes the name in the toast", async () => {
    await promptImportRepertoireFromPgn();
    const payload = { repertoire_id: "imported", name: "Imported game", selected_node_id: "root" };
    postJson.mockResolvedValueOnce(payload);
    const close = vi.fn();
    await form.onSubmit({ pgn: "1. e4 *", color: "white", name: "Imported game" }, close);
    expect(postJson).toHaveBeenCalledWith("/api/repertoires/import-pgn", { pgn: "1. e4 *", color: "white", name: "Imported game" });
    expect(close).toHaveBeenCalledWith(payload);
    expect(setStatus).toHaveBeenCalledWith("Imported “Imported game”");
  });
});
