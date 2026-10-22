import { appState } from "./core/state.js";
import { api, postJson, setStatus, setStatusError } from "./core/api.js";
import { showConfirmModal } from "./core/modals.js";
import { buildRole, canCopy, roleLabel } from "./share-roles.js";

// The shared-repertoire viewer (?shared=<token>): a guest-readable, mutation-free
// Build view of someone else's repertoire, the role banner every shared state
// uses, "Copy to my account", share links and team joins.

let requireSignIn, editRepertoire, refreshDashboardRepertoires, switchView, loadTeams,
  hydrateBuild, removeReadOnlyBanner, syncCoverageReadOnlyState, syncViewHeads, openAuthModal;

export function createSharedViewer(deps) {
  ({ requireSignIn, editRepertoire, refreshDashboardRepertoires, switchView, loadTeams,
    hydrateBuild, removeReadOnlyBanner, syncCoverageReadOnlyState, syncViewHeads, openAuthModal } = deps);
  return { maybeOpenSharedView, maybeHandleJoinLink, renderReadOnlyBanner, forkReadableRepertoire };
}

// A share URL (/?shared=<token>) opens the Build view as a guest-readable,
// mutation-free viewer of someone else's repertoire. "Copy to my account" forks
// it server-side; signing in reloads the page with the token still in the URL,
// so the viewer (and the Copy button) come right back.

export async function maybeOpenSharedView() {
  let token = null;
  try {
    token = new URLSearchParams(window.location.search).get("shared");
  } catch (_) {
    return false;
  }
  if (!token) return false;
  try {
    const payload = await api(`/api/shared/${encodeURIComponent(token)}`);
    appState.sharedToken = token;
    await hydrateBuild(payload, payload.selected_node_id);
    renderReadOnlyBanner(payload);
    switchView("build");
    syncCoverageReadOnlyState();
    return true;
  } catch (error) {
    setStatus(`Share link problem: ${error.message}`, { severity: "error" });
    return false;
  }
}

// A join URL (/?join=<code>) redeems a team invite. Mirrors the shared viewer:
// signed-out visitors are nudged to sign in (the ?join= survives the reload), then
// we preview the team and let them confirm before joining. Idempotent server-side.
export async function maybeHandleJoinLink() {
  let code = null;
  try {
    code = new URLSearchParams(window.location.search).get("join");
  } catch (_) {
    return false;
  }
  if (!code) return false;
  if (!appState.signedIn) {
    openAuthModal("login", { notice: "Sign in (or create an account) to join the team" });
    return false; // ?join= stays in the URL; we resume after the sign-in reload
  }
  let preview;
  try {
    preview = await api(`/api/teams/join/${encodeURIComponent(code)}`);
  } catch (error) {
    setStatus(`Invite link problem: ${error.message}`, { severity: "error" });
    clearJoinParam();
    return false;
  }
  const members = `${preview.member_count} member${preview.member_count === 1 ? "" : "s"}`;
  const confirmed = await showConfirmModal({
    title: preview.already_member ? `Open ${preview.name}?` : `Join ${preview.name}?`,
    body: preview.already_member
      ? "You're already a member of this team."
      : `Join "${preview.name}" (${members})?`,
    okLabel: preview.already_member ? "Open" : "Join",
    cancelLabel: "Cancel",
  });
  clearJoinParam();
  if (!confirmed) return false;
  let result;
  try {
    result = await postJson(`/api/teams/join/${encodeURIComponent(code)}`, {});
  } catch (error) {
    setStatus(`Couldn't join: ${error.message}`, { severity: "error" });
    return false;
  }
  const team = result.team;
  setStatus(result.joined ? `Joined ${team.name}` : `You're already in ${team.name}`);
  appState.selectedTeamId = team.id;
  switchView("teams");
  await loadTeams();
  return true;
}

function clearJoinParam() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("join");
    window.history.replaceState(null, "", url.pathname + url.search);
  } catch (_) {
    /* cosmetic */
  }
}

// The shared/read-only banner is a static host in the Opus panel (index.html).
// Both states only change its text and visibility — no element is created,
// prepended, or re-rendered here, so the shared state renders in exactly the
// same panel composition as the writable one.
// The banner names the caller's role; Copy shows only where the owner allows it.
export function renderReadOnlyBanner(payload) {
  const banner = document.getElementById("shared-banner");
  if (!banner) return;
  const role = buildRole(payload);
  const title = document.getElementById("shared-banner-title");
  if (title) title.textContent = `${roleLabel(role)} · ${payload.name} · shared with you`;
  const fork = document.getElementById("shared-fork-btn");
  if (fork) fork.hidden = !canCopy(role);
  // Anyone it is shared with drills it on their own progress; a public link is
  // not a share, so its viewers copy it first.
  const train = document.getElementById("shared-train-btn");
  if (train) train.hidden = !!appState.sharedToken;
  banner.dataset.role = role;
  banner.hidden = false;
  syncViewHeads();
}


export async function forkReadableRepertoire() {
  const viaToken = !!appState.sharedToken;
  const viaGrant = !!appState.build && buildRole(appState.build) !== "owner";
  if ((!viaToken && !viaGrant) || !canCopy(buildRole(appState.build))) return;
  if (!requireSignIn("Sign in (or create an account) to copy this repertoire")) return;
  try {
    const result = viaToken
      ? await postJson(
          `/api/shared/${encodeURIComponent(appState.sharedToken)}/fork`,
          {},
        )
      : await postJson("/api/repertoires/fork", {
          repertoire_id: appState.build.repertoire_id,
        });
    appState.sharedToken = null;
    removeReadOnlyBanner();
    if (viaToken) {
      try {
        window.history.replaceState(null, "", window.location.pathname);
      } catch (_) {
        /* cosmetic */
      }
    }
    await editRepertoire(result.repertoire_id);
    await refreshDashboardRepertoires();
    setStatus(`Copied "${result.name}" to your account — it's yours now`);
  } catch (error) {
    setStatusError(error.message);
  }
}
