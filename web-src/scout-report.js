// Scout report rendering + delegated interaction handlers (testable without app.js).

export function scoutLineText(sans) {
  const parts = [];
  sans.forEach((san, index) => {
    if (index % 2 === 0) parts.push(`${index / 2 + 1}.`);
    parts.push(san);
  });
  return parts.join(" ");
}

export function scoutCoverageTone(prepared, total) {
  if (!total) return "bad";
  const pct = prepared / total;
  if (pct >= 0.75) return "good";
  if (pct >= 0.25) return "warn";
  return "bad";
}

export function renderMiniBoardHtml(fen, orientation, { parseFenBoard, pieceSvg }) {
  const pieces = parseFenBoard(fen);
  const ranks = orientation === "black" ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const files = orientation === "black" ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const labels = ["a", "b", "c", "d", "e", "f", "g", "h"];
  let html = '<div class="scout-miniboard" aria-hidden="true">';
  for (const rank of ranks) {
    for (const fi of files) {
      const sq = `${labels[fi]}${rank}`;
      const dark = (rank + fi) % 2 === 1;
      const p = pieces[sq];
      html += `<div class="scout-minisquare ${dark ? "dark" : "light"}">${p ? pieceSvg(p) : ""}</div>`;
    }
  }
  return `${html}</div>`;
}

export function renderScoutProfile(profile, username, activeSpeed, escapeHtml) {
  const rating =
    profile.ratingMin != null
      ? `<span class="scout-profile-rating">${profile.ratingMin}–${profile.ratingMax}</span>`
      : "";
  const speeds = ["bullet", "blitz", "rapid", "classical"];
  const chips = speeds
    .filter((s) => (profile.speedCounts[s] || 0) >= 5)
    .map(
      (s) =>
        `<button type="button" class="scout-speed-chip${activeSpeed === s ? " is-on" : ""}" data-speed="${s}">${s.charAt(0).toUpperCase() + s.slice(1)} <span class="scout-speed-n">${profile.speedCounts[s]}</span></button>`,
    )
    .join("");
  return `
    <div class="scout-profile-card">
      <div class="scout-profile-main">
        <a class="scout-username-link" href="https://lichess.org/@/${encodeURIComponent(username)}" target="_blank" rel="noopener">${escapeHtml(username)}</a>
        <span class="scout-profile-games">${profile.total} games analyzed</span>
        ${rating}
      </div>
      <div class="scout-speed-chips">
        <button type="button" class="scout-speed-chip${activeSpeed === "all" ? " is-on" : ""}" data-speed="all">All</button>
        ${chips}
      </div>
    </div>`;
}

export function scoutLineDetailHtml(line, idx, oppColor, { fenAfterLine, renderBoard, escapeHtml }) {
  const fen = fenAfterLine(line.ucis);
  const prepBtn =
    !line.prepared && line.repId
      ? `<button type="button" class="btn ghost scout-action-prep" data-prep-rep="${escapeHtml(line.repId)}" data-prep-node="${escapeHtml(line.deepestNodeId || "")}">Prep gap ›</button>`
      : "";
  const subLines =
    line.subLines && line.subLines.length
      ? `<div class="scout-sublines-label muted">Sub-variations:</div>
         <div class="scout-sublines">${line.subLines
           .map((sub) => {
             const grey = sub.share < 0.03 ? " muted" : "";
             return `<div class="scout-subline${grey}">${escapeHtml(scoutLineText(sub.sans))}</div>`;
           })
           .join("")}</div>`
      : "";
  return `
      <div class="scout-miniboard-wrap">${renderBoard(fen, oppColor)}</div>
      <div class="scout-line-actions">
        <button type="button" class="btn ghost scout-action-analyze" data-line-idx="${idx}">Analyze ›</button>
        ${prepBtn}
        ${subLines}
      </div>`;
}

export function buildScoutAnalyzePgn(line, oppColor, username) {
  const [white, black] = oppColor === "white" ? [username, "?"] : ["?", username];
  const headers = `[Event "Scout — ${username}"]\n[White "${white}"]\n[Black "${black}"]\n[Result "*"]`;
  return `${headers}\n\n${scoutLineText(line.sans)} *`;
}

export function buildScoutSectionReport(
  scoutModule,
  { games, profile },
  oppColor,
  myLookups,
  { speedFilter = "all", escapeHtml },
) {
  const trie = scoutModule.buildOpeningTrie(games, oppColor, { speedFilter });
  if (!trie.gameCount) return { html: "", sectionData: null };
  const dist = scoutModule.moveDistribution(trie).slice(0, 4);
  const lines = scoutModule.topLines(trie);
  const graded = lines.map((line) => {
    let best = null;
    for (const { rep, lookup } of myLookups) {
      const g = scoutModule.gradeLines(lookup, [line])[0];
      if (!best || g.covered > best.covered) {
        best = { ...g, repId: rep.id, repName: rep.name };
      }
    }
    return best || { ...line, covered: 0, prepared: false, repId: null, repName: null };
  });
  const sectionData = { gradedLines: graded, trie, oppColor };

  const preparedCount = graded.filter((g) => g.prepared).length;
  const totalLines = graded.length;
  const unpreparedCount = totalLines - preparedCount;
  const covPct = totalLines ? Math.round((preparedCount / totalLines) * 100) : 0;
  const covTone = scoutCoverageTone(preparedCount, totalLines);
  const prepareAll =
    unpreparedCount > 0 && myLookups.length
      ? `<button type="button" class="btn ghost scout-prepare-all" data-color="${oppColor}">Prepare all gaps ›</button>`
      : "";

  const trending = profile.recentlyChanged[oppColor]
    ? '<span class="scout-trending" title="Their recent games show a different opening">⚡ Recently changed</span>'
    : "";

  const firstMoves = dist
    .map((m) => {
      const heat = m.scorePct >= 55 ? " is-hot" : m.scorePct <= 45 ? " is-cold" : "";
      return `
      <div class="scout-dist-row${heat}" data-first-uci="${escapeHtml(m.uci)}" role="button" tabindex="0">
        <span class="scout-dist-san">${escapeHtml(m.san)}</span>
        <span class="scout-dist-bar"><span style="width:${Math.round(m.share * 100)}%"></span></span>
        <span class="scout-dist-share">${Math.round(m.share * 100)}%</span>
        <span class="scout-dist-score" title="Their score with this move">${m.scorePct}%</span>
      </div>`;
    })
    .join("");

  const lineRows = graded
    .map((line, i) => {
      const gap = line.covered > 0;
      const label = line.prepared
        ? "&#10003; prepared"
        : gap
          ? `gap after ply ${line.covered}`
          : myLookups.length
            ? "not in prep"
            : "not prepared";
      const tone = line.prepared ? "good" : gap ? "warn" : "bad";
      const tip = line.prepared
        ? "Your prep follows this line"
        : gap
          ? `Gap in ${line.repName || "your prep"}`
          : "This line is not in your prep";
      const badge = `<span class="scout-badge ${tone}" title="${escapeHtml(tip)}">${label}</span>`;
      const moves = scoutLineText(line.sans);
      const rawCount = line.gameCount ?? Math.round(line.count);
      return `
      <div class="scout-line" data-line-idx="${i}" data-color="${oppColor}" role="button" tabindex="0" aria-expanded="false">
        <span class="scout-line-count" title="${rawCount} of their games">&times;${rawCount}</span>
        <div class="scout-line-main">
          <span class="scout-line-eco"></span>
          <span class="scout-line-moves" title="${escapeHtml(moves)}">${escapeHtml(moves)}</span>
        </div>
        <span class="scout-line-score" title="Their score in this line">${line.scorePct}%</span>
        <span class="scout-line-end">${badge}</span>
      </div>`;
    })
    .join("");

  const heading = oppColor === "white" ? "With White" : "With Black";
  const html = `
    <div class="scout-section" data-scout-color="${oppColor}">
      <div class="scout-section-head">
        <span class="scout-color-dot ${oppColor}" aria-hidden="true"></span>
        <h3>${heading}</h3>
        <span class="scout-games-count">${trie.gameCount} games</span>
        ${trending}
      </div>
      <div class="scout-coverage-bar-row">
        <div class="scout-coverage-bar">
          <div class="scout-coverage-fill ${covTone}" style="width:${covPct}%"></div>
        </div>
        <span class="scout-coverage-label">${preparedCount}/${totalLines} lines covered</span>
        ${prepareAll}
      </div>
      <div class="scout-body">
        <div class="scout-col">
          <div class="scout-col-label">First moves</div>
          <div class="scout-dist" data-dist-root="true">${firstMoves}</div>
        </div>
        <div class="scout-col">
          <div class="scout-col-label">Favourite lines</div>
          <div class="scout-lines">${lineRows}</div>
        </div>
      </div>
    </div>
  `;
  return { html, sectionData };
}

export function handleScoutProfileClick(event, { getState, onSpeedChange }) {
  const chip = event.target.closest?.(".scout-speed-chip");
  if (!chip) return false;
  const state = getState();
  if (!state) return false;
  const speed = chip.dataset.speed;
  if (!speed || speed === state.activeSpeed) return false;
  state.activeSpeed = speed;
  onSpeedChange();
  return true;
}

export async function handleScoutResultsClick(event, ctx) {
  const { getState, scoutModule, escapeHtml, callbacks, createElement } = ctx;
  const makeEl = createElement || ((tag) => document.createElement(tag));
  const state = getState();
  if (!state) return;

  const backBtn = event.target.closest?.(".scout-dist-back");
  if (backBtn) {
    const sectionEl = backBtn.closest(".scout-section");
    const oppColor = sectionEl?.dataset.scoutColor;
    if (sectionEl && oppColor) callbacks.restoreDistRoot(sectionEl, oppColor);
    return;
  }

  const distRow = event.target.closest?.(".scout-dist-row[data-first-uci]");
  if (distRow) {
    const sectionEl = distRow.closest(".scout-section");
    const oppColor = sectionEl?.dataset.scoutColor;
    if (sectionEl && oppColor) callbacks.renderDistDrilldown(distRow, sectionEl, oppColor);
    return;
  }

  const prepAllBtn = event.target.closest?.(".scout-prepare-all");
  if (prepAllBtn) {
    const color = prepAllBtn.dataset.color;
    const sectionData = state.sections[color];
    if (sectionData) await callbacks.scoutPrepareAll(sectionData.gradedLines);
    return;
  }

  const analyzeBtn = event.target.closest?.(".scout-action-analyze");
  if (analyzeBtn) {
    const lineEl = analyzeBtn.closest(".scout-line-detail")?.previousElementSibling;
    const color = lineEl?.dataset.color;
    const idx = parseInt(analyzeBtn.dataset.lineIdx, 10);
    const sectionData = state.sections[color];
    if (sectionData && sectionData.gradedLines[idx]) {
      callbacks.scoutAnalyzeLine(sectionData.gradedLines[idx], color, state.username);
    }
    return;
  }

  const prepBtn = event.target.closest?.("[data-prep-rep]");
  if (prepBtn) {
    await callbacks.editRepertoire(prepBtn.dataset.prepRep);
    if (prepBtn.dataset.prepNode) await callbacks.selectBuildNode(prepBtn.dataset.prepNode);
    return;
  }

  const lineEl = event.target.closest?.(".scout-line");
  if (
    lineEl &&
    !event.target.closest?.(".scout-badge, .scout-action-prep, .scout-action-analyze, [data-prep-rep]")
  ) {
    const color = lineEl.dataset.color;
    const idx = parseInt(lineEl.dataset.lineIdx, 10);
    const sectionData = state.sections[color];
    if (!sectionData) return;
    const expanded = lineEl.classList.toggle("is-expanded");
    lineEl.setAttribute("aria-expanded", expanded);
    if (expanded && !lineEl.nextElementSibling?.classList.contains("scout-line-detail")) {
      const line = sectionData.gradedLines[idx];
      const detail = makeEl("div");
      detail.className = "scout-line-detail";
      detail.innerHTML = callbacks.scoutLineDetailHtml(line, idx, color);
      lineEl.insertAdjacentElement("afterend", detail);
      const fen = scoutModule.fenAfterLine(line.ucis);
      callbacks.enrichEcoForLine(lineEl, fen);
    } else if (!expanded) {
      const detail = lineEl.nextElementSibling;
      if (detail?.classList.contains("scout-line-detail")) detail.remove();
    }
  }
}

