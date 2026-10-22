import { describe, expect, it, vi } from "vitest";

vi.mock("../engine/engine-downloads.js", () => ({
  deleteDownload: vi.fn(),
  downloadState: vi.fn(),
  formatMB: (b) => `${Math.round(b / 1e6)} MB`,
  refreshDownloads: vi.fn(),
  startDownload: vi.fn(),
  subscribeDownloads: vi.fn(() => () => {}),
}));
vi.mock("../core/prefs.js", () => ({ maiaAnalysisEnabled: () => false, setPref: vi.fn() }));
vi.mock("../engine-unlock.css", () => ({}));

const { downloadRowHtml } = await import("./settings-downloads.js");
const row = (s) => String(downloadRowHtml({ id: "maia", bytes: 46_417_576, version: "v3", fraction: null, ...s }));

// Settings shows each optional engine as one row: status, size, and the action
// that moves it on.
describe("settings download rows", () => {
  it("not downloaded: size and Download", () => {
    const html = row({ phase: "absent" });
    expect(html).toContain("Maia 3");
    expect(html).toContain("46 MB");
    expect(html).toContain("Not downloaded");
    expect(html).toContain('data-dl="get">Download');
  });

  it("downloading: the percentage in the pill and a bar at the true ratio, no action", () => {
    const html = row({ phase: "downloading", fraction: 0.42 });
    expect(html).toContain("Downloading 42%");
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain("width:42%");
    expect(html).not.toContain("data-dl=");
  });

  it("ready: the version and Delete to free the space", () => {
    const html = String(downloadRowHtml({ id: "stockfish", phase: "ready", bytes: 99_065_439, version: "v19" }));
    expect(html).toContain("Ready · v19");
    expect(html).toContain("99 MB");
    expect(html).toContain('data-dl="delete">Delete');
  });

  it("error: the reason in words and Retry", () => {
    const html = row({ phase: "error", error: "Not enough storage: it needs 46 MB and 12 MB is free." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Not enough storage");
    expect(html).toContain('data-dl="get">Retry');
  });

  it("a device that cannot hold the full net says so and offers nothing", () => {
    const html = String(downloadRowHtml({ id: "stockfish", phase: "unsupported", bytes: 99_065_439 }));
    expect(html).toContain("Not on this device");
    expect(html).not.toContain("data-dl=");
  });
});
