import { html } from "../html.js";
import { countOf } from "../plural.js";

// Scout's per-source fetch state: the cursor, whether more history is left, and the
// outcome each source reports. A merged report must say which sources it covers,
// and every source pages on its own: a source is never fetched from another
// source's cursor, and a stream of some sources (Retry) leaves the rest as they were.

// Games per account per fetch; "Load older" pulls the next batch.
export const SCOUT_STREAM_BATCH = 500;

export function scoutErrorHtml(title, message, action = null) {
  return html`<div class="scout-error" role="alert">
    <p class="scout-error-title">${title}</p>
    <p class="scout-error-body">${message}</p>
    ${action ? html`<button type="button" class="btn sm" id="scout-retry-failed">Retry failed sources</button>` : ""}
  </div>`;
}

// Multi-identity label: "self (2 accounts)" keeps time/sample stats honest
// while reading as one person, not a list of logins.
export function scoutLabel(usernames) {
  const names = (usernames || []).filter(Boolean);
  if (names.length <= 1) return names[0] || "";
  return `self (${names.length} accounts)`;
}

export function failedSources(session) {
  return Object.keys(session.sourceStatus || {}).filter((user) => session.sourceStatus[user].status === "failed");
}

export function scoutSourceFailureMessage(session) {
  const failed = failedSources(session);
  if (!failed.length) return null;
  if (failed.length === 1) {
    const error = session.sourceStatus[failed[0]].error;
    return error ? `${failed[0]}: ${error}` : `${failed[0]} could not be read. Try again.`;
  }
  return `${failed.length} sources could not be read. Retry the ones that failed.`;
}

/**
 * The sources one stream reads: `only` (Retry), or every source not yet read to
 * its end. A source whose last stream ended short of a full batch has no older
 * games, and asking Lichess again costs a request and can be rate-limited.
 */
export function sourcesToStream(session, only = null) {
  if (only?.length) return only;
  const all = session.usernames?.length ? session.usernames : [session.username].filter(Boolean);
  return all.filter((user) => session.refreshPending?.has(user) || !session.sourceProgress?.[user]?.exhausted);
}

/**
 * Where one source's next stream starts. A restored source still owed its newer
 * games reads from just after its newest saved game; any other source reads on
 * from its own oldest game (none yet: from its newest game).
 */
export function streamWindow(session, username) {
  const newest = session.newestDatestampByUser?.[username];
  if (session.refreshPending?.has(username) && newest != null) return { since: newest + 1 };
  return { until: session.oldestDatestampByUser[username] ?? undefined };
}

/**
 * Folds one stream's settled results into the session. `aborted[i]` says the
 * source was stopped before its end. Sets each source's cursor, outcome and
 * progress, then the session-wide `batchFull` (some source has older games left)
 * and `hasMore` (some source can still be read on). A refresh (newer games after a
 * restored run) keeps the source's older-games cursor and progress; only a full
 * refresh, a gap behind the new games, restarts that source (see settleRefresh).
 */
export function recordStreamResults(session, usernames, settled, { aborted = [], errorMessage }) {
  session.sourceProgress ||= {};
  usernames.forEach((username, i) => {
    const result = settled[i];
    const accepted = session.acceptedByUser?.[username] || 0;
    const refresh = session.refreshPending?.has(username) && "since" in streamWindow(session, username);
    if (refresh) session.refreshedThisStream = true;
    if (result.status === "fulfilled" && refresh && !aborted[i]) {
      session.refreshPending.delete(username);
      session.sourceStatus[username] = { status: accepted ? "ok" : "empty", accepted };
      if ((result.value?.received || 0) < SCOUT_STREAM_BATCH) return;
      (session.refreshGapped ||= []).push(username);
      session.oldestDatestampByUser[username] = result.value.lastDatestamp ?? undefined;
      session.sourceProgress[username] = { full: true, stopped: false, exhausted: false };
    } else if (refresh) {
      // Stopped or failed: the newer games are still owed, from the same point.
      if (result.status === "rejected" && result.reason?.name !== "AbortError" && !session.userStopped) {
        session.sourceStatus[username] = { status: "failed", accepted, error: errorMessage(result.reason) };
      }
    } else if (result.status === "fulfilled") {
      const { lastDatestamp = null, received = 0 } = result.value || {};
      if (lastDatestamp != null) session.oldestDatestampByUser[username] = lastDatestamp;
      const full = received >= SCOUT_STREAM_BATCH;
      const stopped = Boolean(aborted[i]) && !full;
      session.sourceProgress[username] = { full, stopped, exhausted: !full && !stopped };
      session.sourceStatus[username] = { status: accepted ? "ok" : "empty", accepted };
    } else if (result.reason?.name !== "AbortError" && !session.userStopped) {
      // A failed source is read again on Resume and on Retry, from its own cursor.
      session.sourceProgress[username] = { full: false, stopped: false, exhausted: false };
      session.sourceStatus[username] = { status: "failed", accepted, error: errorMessage(result.reason) };
    } else {
      session.sourceProgress[username] = { full: false, stopped: true, exhausted: false };
    }
  });
  const progress = Object.values(session.sourceProgress);
  session.batchFull = progress.some((p) => p.full);
  session.hasMore = progress.some((p) => p.full || p.stopped) || Boolean(session.refreshPending?.size);
}

// The batch cap is a choice the report has to state: a paused report of the
// newest 500 games per account otherwise reads as the player's whole history.
export function scoutStreamCapNoteHtml(session) {
  if (session?.state !== "paused" || !session.batchFull) return "";
  return html`<p class="scout-cap-note muted hint" id="scout-cap-note">Read the newest ${SCOUT_STREAM_BATCH} games per account. <button type="button" class="btn sm ghost" data-scout-load-older>Load older</button></p>`;
}

/** The per-source chips above a merged report, with Retry for failed sources. */
export function renderSourceWarnings(session, { results, hasGames, onRetry }) {
  if (!results) return;
  const statuses = Object.entries(session.sourceStatus || {}).filter(([, s]) => s.status !== "ok");
  // With no source left, the report area already shows the reason; don't repeat it.
  const anyOk = Object.values(session.sourceStatus || {}).some((s) => s.status === "ok");
  let bar = document.getElementById("scout-source-warnings");
  if ((!anyOk && !hasGames) || !statuses.length) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "scout-source-warnings";
    bar.className = "scout-source-warnings";
    results.parentNode.insertBefore(bar, results);
  }
  const chips = Object.entries(session.sourceStatus || {}).map(([user, s]) => {
    const label = s.status === "ok"
      ? countOf(s.accepted, "game")
      : s.status === "failed" ? `failed${s.error && anyOk ? ` · ${s.error}` : ""}` : "no games";
    return html`<span class="source-chip is-${s.status}"><b>${user}</b> ${label}</span>`;
  });
  bar.innerHTML =
    html`<div class="source-warn-text" title="The report covers only the sources that returned games">${countOf(statuses.length, "source")} incomplete</div><div class="source-chips">${chips}</div><button type="button" class="btn sm" id="scout-retry-failed">Retry failed sources</button>`;
  bar.querySelector("#scout-retry-failed")?.addEventListener("click", () => {
    if (onRetry()) bar.remove();
  });
}
