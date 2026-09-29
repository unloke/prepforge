// Teams viewport smoke — fixture-backed (same stack as the games/scout smokes).
// Serves the committed static/ tree, intercepts /api/* with real-shape team
// payloads (a two-member team + one shared repertoire + a live invite), and at
// 1440x900 / 1180x900 / 390x844 checks:
//   - no horizontal overflow, no console errors
//   - directory lists the real team (name, member count, role badge)
//   - detail card: Members / Shared repertoires are two tabs over ONE panel,
//     with real counts on the tabs and the invite status as a footer line
//   - shared tab lists the real shared repertoire (color dot, owner, Copy)
//   - incoming shares list renders the real shared-to-you item
// Tracked UI-v2 smoke: run the whole eight-view suite with
// `npm run smoke:ui-v2` (scripts/smoke/ui-v2/run-all.mjs).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const STATIC_DIR = join(ROOT, "src", "prepforge_chess", "web", "static");
const PORT = Number(process.env.TEAMS_SMOKE_PORT || 8805);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// Real-shape fixtures (mirrors src/prepforge_chess/api/routers/teams.py +
// loadSharedRepertoires' /api/repertoires `shared` contract).
const TEAM_DETAIL = {
  id: "t1",
  name: "Taipei Knights",
  role: "owner",
  member_count: 2,
  members: [
    { user_id: "u1", display_name: "Andrew", lichess_username: "tactician_aw", role: "owner" },
    { user_id: "u2", display_name: "Sam", lichess_username: "samqueen", role: "member" },
  ],
  shared_repertoires: [
    { id: "rep-9", name: "Sicilian Drain", color: "black", owner_user_id: "u2", owner_display_name: "Sam" },
  ],
  invite: { exists: true, created_at: "2026-09-01T00:00:00Z", expires_at: null },
};

const api = (path) => {
  if (path.startsWith("/api/auth/me")) return { id: "u1", display_name: "Smoke Tester", email: "s@x.test" };
  if (path.startsWith("/api/auth/providers")) return { google: false };
  if (path.startsWith("/api/csrf")) return { csrf_token: "x" };
  if (path.startsWith("/api/repertoires")) {
    return {
      repertoires: [],
      shared: [
        { id: "rep-8", name: "French Fort", color: "white", team_id: "t1", owner_user_id: "u2" },
      ],
    };
  }
  if (path.startsWith("/api/teams/t1")) return TEAM_DETAIL;
  if (path.startsWith("/api/teams")) return { teams: [TEAM_DETAIL] };
  if (path.startsWith("/api/dashboard")) return { games: 0, repertoires: 0, training_sessions: 0, open_mistakes: 0, due_reviews: 0, due_soon: 0, streak: { current: 0, best: 0, trained_today: false }, recap: {}, recommendations: [] };
  if (path.startsWith("/api/lichess")) return { linked: true, accounts: [{ id: "a1", username: "me_user", is_primary: true }] };
  return {};
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(api(url.pathname)));
    return;
  }
  let path = url.pathname === "/" ? "/index.html" : url.pathname;
  if (path.startsWith("/static/")) path = path.slice("/static".length);
  try {
    const file = await readFile(join(STATIC_DIR, path));
    res.writeHead(200, {
      "Content-Type": MIME[extname(path)] || "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    res.end(file);
  } catch { res.writeHead(404); res.end("nope"); }
});
await new Promise((r) => server.listen(PORT, r));

const { chromium } = await import("playwright");
let browser;
for (const channel of ["msedge", "chrome", undefined]) {
  try { browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); break; }
  catch { /* next */ }
}
if (!browser) { console.error("[teams-smoke] no browser"); server.close(); process.exit(2); }

const base = `http://127.0.0.1:${PORT}`;
const failures = [];

async function runViewport(vp) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  const check = (ok, label) => { if (!ok) failures.push(`${vp.name}: ${label}`); };
  // Optional review screenshots (UI_V2_SHOTS=<dir> UI_V2_TAG=before|after); the
  // pointer is parked bottom-right so the hover rail stays collapsed.
  const shot = async (state) => {
    if (!process.env.UI_V2_SHOTS) return;
    await page.mouse.move(vp.width - 4, vp.height - 4);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(process.env.UI_V2_SHOTS, `teams-${state}-${process.env.UI_V2_TAG || "after"}-${vp.name}.png`) });
  };

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000); // boot + signed-in hydration

  // Navigate the way users do: desktop hover rail, mobile More sheet.
  if (vp.width > 760) {
    await page.mouse.move(30, 300);
    await page.waitForTimeout(400);
    const box = await page.locator('[data-testid="nav-teams"]').boundingBox();
    check(!!box, "nav-teams should expose a bounding box on the expanded rail");
    if (box) {
      await page.mouse.move(box.x + 20, box.y + box.height / 2);
      await page.waitForTimeout(120);
      await page.mouse.down();
      await page.mouse.up();
    }
  } else {
    await page.evaluate(() => document.querySelector('[data-testid="bottom-more"]').click());
    await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelector('[data-nav-mirror="teams"]').click());
  }
  await page.waitForFunction(
    () => document.querySelectorAll("#teams-list .team-row").length > 0,
    null,
    { timeout: 8000 },
  );

  // Park the pointer so the hover rail collapses and cannot overlay the directory rows.
  await page.mouse.move(vp.width - 4, vp.height - 4);
  await page.waitForTimeout(250);
  await shot("directory");

  // Directory: the real team from /api/teams.
  const dirName = await page.locator('#teams-list .team-row .name').first().textContent().catch(() => "");
  check(dirName === "Taipei Knights", `directory should list Taipei Knights, got "${dirName}"`);
  const dirCount = await page.locator('#teams-list .team-row .sub').first().textContent().catch(() => "");
  check(/2 members/.test(dirCount || ""), `directory should show "2 members", got "${dirCount}"`);
  const dirRole = await page.locator('#teams-list .team-row .team-role-badge').first().textContent().catch(() => "");
  check(/Owner/.test(dirRole || ""), `directory should show the Owner badge, got "${dirRole}"`);

  // Open the detail card.
  await page.locator("#teams-list .team-row").first().click();
  await page.waitForFunction(
    () => !document.getElementById("team-detail-card").hidden &&
      document.querySelectorAll("#team-members .team-member-row").length === 2,
    null,
    { timeout: 8000 },
  );

  // Detail header: name + role badge + manager tools visible for the owner.
  const detailName = await page.locator("#team-detail-name").textContent().catch(() => "");
  check(detailName === "Taipei Knights", `detail name should be the real team, got "${detailName}"`);
  const detailRole = await page.locator("#team-detail-role").textContent().catch(() => "");
  check(/Owner/.test(detailRole || ""), `detail role badge should read Owner, got "${detailRole}"`);
  check(await page.locator("#team-detail-delete:not([hidden])").count() === 1, "owner should see Delete");
  check(await page.locator("#team-detail-invite:not([hidden])").count() === 1, "owner should see Invite");
  check(await page.locator("#team-add-member:not([hidden])").count() === 1, "owner should see Add member");

  // Two tabs over ONE panel: Members visible, Shared hidden.
  const membersShown = await page.locator("#team-panel-members:not([hidden])").count();
  const repsHidden = await page.locator("#team-panel-repertoires[hidden]").count();
  check(membersShown === 1 && repsHidden === 1, "Members tab should start active with Shared hidden");
  const memberRows = await page.locator("#team-members .team-member-row").count();
  check(memberRows === 2, `members list should have the 2 real members, got ${memberRows}`);
  const ownerRow = await page.locator("#team-members .team-member-row").first().textContent().catch(() => "");
  check(/Andrew/.test(ownerRow) && /tactician_aw/.test(ownerRow), `owner row should show real name + lichess handle, got "${ownerRow}"`);
  check(/Owner/.test(ownerRow), "owner row should carry the Owner badge");

  // Real counts on the tabs (Members 2 / Shared repertoires 1).
  const membersCount = await page.locator('[data-team-count="members"]').textContent().catch(() => "");
  check(membersCount.trim() === "2", `Members tab count should be 2, got "${membersCount}"`);

  await shot("members");

  // Invite footer from the real payload (owner sees it).
  const foot = await page.locator("#team-invite-foot:not([hidden])").textContent().catch(() => "");
  check(/Invite link active/.test(foot || "") && /revoke from Invite/.test(foot || ""), `invite footer should render, got "${foot}"`);

  // Switch to Shared repertoires: members panel hides, real shared rep appears.
  await page.locator("#team-tab-repertoires").click();
  await page.waitForFunction(
    () => !document.getElementById("team-panel-repertoires").hidden &&
      document.getElementById("team-panel-members").hidden,
    null,
    { timeout: 5000 },
  );
  await shot("shared");
  const repsCount = await page.locator('[data-team-count="repertoires"]').textContent().catch(() => "");
  check(repsCount.trim() === "1", `Shared tab count should be 1, got "${repsCount}"`);
  const sharedRow = await page.locator("#team-shared-repertoires .team-shared-rep-row").first().textContent().catch(() => "");
  check(/Sicilian Drain/.test(sharedRow || "") && /Sam/.test(sharedRow || ""), `shared tab should list the real shared repertoire, got "${sharedRow}"`);
  check(await page.locator("#team-shared-repertoires .team-copy").count() === 1, "someone else's shared rep should offer Copy");
  check(await page.locator("#team-share-rep:not([hidden])").count() === 1, "members can share their own repertoire");
  // Keyboard: ArrowLeft steps back to Members (prototype tabs are arrow-steppable).
  await page.locator("#team-tab-repertoires").focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(
    () => !document.getElementById("team-panel-members").hidden,
    null,
    { timeout: 5000 },
  );

  // Incoming shares: the real shared-to-you repertoire with read-only + Copy.
  const incoming = await page.locator("#teams-shared .shared-rep-row").first().textContent().catch(() => "");
  check(/French Fort/.test(incoming || "") && /Taipei Knights/.test(incoming || ""), `incoming shares should list the real shared rep via its team, got "${incoming}"`);
  check(await page.locator('#teams-shared .shared-rep-row .team-role-badge.sm, #teams-shared .team-role-badge').count() >= 1, "incoming share should carry a read-only badge");

  // Close detail → the empty state returns (single-page grid fallback).
  await page.evaluate(() => document.getElementById("team-detail-close").click());
  await page.waitForTimeout(300);
  check(await page.locator("#team-detail-card[hidden]").count() === 1, "closing the detail hides the card");

  // Overflow + console errors.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `horizontal overflow of ${overflow}px`);
  const realErrors = consoleErrors.filter((t) => !/Failed to load resource|favicon|net::/i.test(t));
  check(realErrors.length === 0, `console errors: ${realErrors.join(" | ")}`);

  await page.close();
}

try {
  for (const vp of [
    { name: "desktop-1440", width: 1440, height: 900 },
    { name: "laptop-1180", width: 1180, height: 900 },
    { name: "mobile-390", width: 390, height: 844 },
  ]) await runViewport(vp);
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error("[teams-smoke] FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[teams-smoke] ok — all three viewports render Teams (directory, two-tab detail with real counts, invite footer, incoming shares) from real-shape fixtures with no overflow and no console errors.");
