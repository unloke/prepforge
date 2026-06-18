// Scout report rendering + delegated interaction handlers (testable without app.js).

import { mergeEngineIntoTargets, WEAKNESS_MIN_GAMES } from "./scout.js";

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

// Win/draw/loss as three small pills. Used in the roomy section header.
export function scoutWdlHtml(w, d, l, { compact = false } = {}) {
  const cls = compact ? "scout-wdl scout-wdl-compact" : "scout-wdl";
  return `<span class="${cls}" aria-label="${w} wins, ${d} draws, ${l} losses">
    <span class="scout-wdl-pill scout-wdl-w" title="Wins">W${w}</span>
    <span class="scout-wdl-pill scout-wdl-d" title="Draws">D${d}</span>
    <span class="scout-wdl-pill scout-wdl-l" title="Losses">L${l}</span>
  </span>`;
}

// Win/draw/loss as one compact proportional bar — fixed width, never wraps, so it
// stays aligned inside a row. The pill version above is for the header where there's room.
export function scoutWdlBar(w, d, l) {
  const total = w + d + l || 1;
  const pct = (n) => `${(n / total) * 100}%`;
  return `<span class="scout-wdlbar" title="W${w} D${d} L${l}" aria-label="${w} wins, ${d} draws, ${l} losses">
    <span class="scout-wdlbar-w" style="width:${pct(w)}"></span>
    <span class="scout-wdlbar-d" style="width:${pct(d)}"></span>
    <span class="scout-wdlbar-l" style="width:${pct(l)}"></span>
  </span>`;
}

// Stacked score cell: the score% on top, the sample size below, plus (for weakness
// rows) how far the line sits under the opponent's own baseline. Fixed width, no wrap.
export function scoutScoreCell(scorePct, games, { baseline, showGap = false } = {}) {
  const gap =
    showGap && baseline != null && baseline > scorePct
      ? `<span class="scout-gap" title="${baseline - scorePct} points below their overall ${baseline}%">−${baseline - scorePct} vs ${baseline}%</span>`
      : "";
  return `<span class="scout-score-cell">
      <span class="scout-score-pct">${scorePct}%</span>
      <span class="scout-n">n=${games}</span>${gap}
    </span>`;
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
        `<button type="button" class="scout-btn scout-speed-chip${activeSpeed === s ? " is-on" : ""}" data-speed="${s}">${s.charAt(0).toUpperCase() + s.slice(1)} <span class="scout-speed-n">${profile.speedCounts[s]}</span></button>`,
    )
    .join("");
  return `
    <div class="scout-profile-card">
      <div class="scout-profile-main">
        <a class="scout-username-link" href="https://lichess.org/@/${encodeURIComponent(username)}" target="_blank" rel="noopener">${escapeHtml(username)}</a>
        <span class="scout-profile-games">${profile.total} games analyzed</span>
        ${rating}
      </div>
      <div class="scout-profile-actions">
        <button type="button" class="scout-btn btn ghost" id="scout-share-btn" title="Copy scout summary">Copy report</button>
        <button type="button" class="scout-btn btn ghost" id="scout-deep-scan-btn" title="Stockfish scan of their opening mistakes">Deep scan ▾</button>
      </div>
      <div class="scout-speed-chips">
        <button type="button" class="scout-btn scout-speed-chip${activeSpeed === "all" ? " is-on" : ""}" data-speed="all">All</button>
        ${chips}
      </div>
    </div>`;
}

// Compact per-row affordance: a single "+" icon. The full labelled button lives in
// the expanded detail panel (scoutLineDetailHtml), so the row itself stays narrow.
function scoutAddPrepBtn(rowKind, idx, oppColor) {
  return `<button type="button" class="scout-add-icon scout-action-add-prep" title="Add this line to a repertoire" aria-label="Add to prep" data-row-kind="${rowKind}" data-row-idx="${idx}" data-color="${oppColor}">+</button>`;
}

function scoutPrepStatus(line) {
  if (line.covered === undefined) return { cls: "", text: "", tone: "" };
  if (line.prepared) {
    return { cls: "is-prepared", tone: "good", text: "In your prep" };
  }
  if (line.covered > 0) {
    return {
      cls: "is-gap",
      tone: "warn",
      text: `Gap in ${line.repName || "your prep"} after ${line.covered} plies`,
    };
  }
  return { cls: "is-new", tone: "bad", text: "Not in your prep" };
}

export function scoutLineDetailHtml(line, idx, oppColor, rowKind, { fenAfterLine, renderBoard, escapeHtml }) {
  const fen = fenAfterLine(line.ucis);
  const status = scoutPrepStatus(line);
  const statusLine = status.text
    ? `<div class="scout-line-status ${status.tone}">${escapeHtml(status.text)}</div>`
    : "";
  const engineNote =
    line.enginePattern && line.hasEngineMistake
      ? `<div class="scout-engine-note" title="Recurring mistake from deep scan">Often errs: …${escapeHtml(line.enginePattern.playedSan)} (−${(line.enginePattern.avgCpLoss / 100).toFixed(1)}) in ${line.enginePattern.occurrences} games</div>`
      : line.hasEngineMistake
        ? `<div class="scout-engine-note">They often err here</div>`
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
        ${statusLine}
        <div class="scout-line-action-row">
          <button type="button" class="scout-btn btn ghost scout-action-analyze" data-row-kind="${rowKind}" data-row-idx="${idx}">Analyze ›</button>
          <button type="button" class="scout-btn btn ghost scout-action-add-prep" data-row-kind="${rowKind}" data-row-idx="${idx}" data-color="${oppColor}">Add to prep ▾</button>
        </div>
        ${engineNote}
        ${subLines}
      </div>`;
}

export function buildScoutAnalyzePgn(line, oppColor, username) {
  const [white, black] = oppColor === "white" ? [username, "?"] : ["?", username];
  const headers = `[Event "Scout — ${username}"]\n[White "${white}"]\n[Black "${black}"]\n[Result "*"]`;
  return `${headers}\n\n${scoutLineText(line.sans)} *`;
}

// First-move distribution row — lives in the narrow left column, so it stays simple:
// move, frequency bar, share%, score%. Its own grid (not the wide line-row grid).
export function scoutDistRowHtml(m, escapeHtml, { clickable = true } = {}) {
  const heat = m.scorePct >= 55 ? " is-hot" : m.scorePct <= 45 ? " is-cold" : "";
  const clickAttrs = clickable && m.uci
    ? ` data-first-uci="${escapeHtml(m.uci)}" role="button" tabindex="0"`
    : "";
  return `
      <div class="scout-dist-row${heat}"${clickAttrs}>
        <span class="scout-dist-san">${escapeHtml(m.san)}</span>
        <span class="scout-dist-bar"><span style="width:${Math.round(m.share * 100)}%"></span></span>
        <span class="scout-dist-share">${Math.round(m.share * 100)}%</span>
        <span class="scout-dist-score" title="Their score with this move · n=${m.gameCount}">${m.scorePct}%</span>
      </div>`;
}

// One shared markup for favourite-line and weakness rows. Prep status is shown as a
// coloured left border + tooltip (no wrapping badge), the score is a stacked cell, the
// result is a compact W/D/L bar, and the action is a single "+" icon. Fixed-width cells
// mean the columns line up and nothing overlaps regardless of column width.
function scoutLineRowHtml(line, i, oppColor, baseline, escapeHtml, { rowKind = "line" } = {}) {
  const weakness = rowKind === "weakness";
  const status = scoutPrepStatus(line);
  const moves = scoutLineText(line.sans);
  const rawCount = line.gameCount ?? Math.round(line.count ?? line.games ?? 0);
  const engineHint =
    weakness && line.enginePattern && line.hasEngineMistake
      ? `<span class="scout-line-hint"> · often …${escapeHtml(line.enginePattern.playedSan)}</span>`
      : "";
  const engineFlag = line.hasEngineMistake
    ? '<span class="scout-err-marker" title="Recurring mistake in deep scan">⚠</span>'
    : "";
  const rowTitle = status.text ? ` title="${escapeHtml(status.text)}"` : "";
  return `
      <div class="scout-line scout-line-row ${status.cls}${weakness ? " scout-weakness-row" : ""}" data-row-kind="${rowKind}" data-row-idx="${i}" data-color="${oppColor}" role="button" tabindex="0" aria-expanded="false"${rowTitle}>
        <span class="scout-lr-count" title="${rawCount} of their games">&times;${rawCount}</span>
        <div class="scout-lr-main">
          <span class="scout-line-eco"></span>
          <span class="scout-line-moves" title="${escapeHtml(moves)}">${escapeHtml(moves)}${engineHint}</span>
        </div>
        <span class="scout-lr-score">${scoutScoreCell(line.scorePct, rawCount, { baseline, showGap: weakness })}</span>
        <span class="scout-lr-wdl">${scoutWdlBar(line.w || 0, line.d || 0, line.l || 0)}</span>
        <span class="scout-lr-action">${engineFlag}${scoutAddPrepBtn(rowKind, i, oppColor)}</span>
      </div>`;
}

function scoutWeaknessRowHtml(target, i, oppColor, baseline, escapeHtml) {
  return scoutLineRowHtml(target, i, oppColor, baseline, escapeHtml, { rowKind: "weakness" });
}

export function buildScoutSectionReport(
  scoutModule,
  { games, profile },
  oppColor,
  myLookups,
  { speedFilter = "all", escapeHtml, enginePatterns = null },
) {
  const trie = scoutModule.buildOpeningTrie(games, oppColor, { speedFilter });
  if (!trie.gameCount) return { html: "", sectionData: null };
  const baseline =
    profile.colorStats?.[oppColor]?.scorePct ??
    (trie.count ? Math.round((trie.score / trie.count) * 100) : 0);
  const colorWdl = profile.colorStats?.[oppColor] || { w: trie.w, d: trie.d, l: trie.l, games: trie.gameCount };

  const dist = scoutModule.moveDistribution(trie).slice(0, 4);
  const lines = scoutModule.topLines(trie);
  let graded = lines.map((line) => {
    let best = null;
    for (const { rep, lookup } of myLookups) {
      const g = scoutModule.gradeLines(lookup, [line])[0];
      if (!best || g.covered > best.covered) {
        best = { ...g, repId: rep.id, repName: rep.name };
      }
    }
    return best || { ...line, covered: 0, prepared: false, repId: null, repName: null };
  });

  const breakdown = scoutModule.openingBreakdown(trie, { minGames: 1 });
  let weaknessTargets = scoutModule.recommendTargets(breakdown, baseline, {
    minGames: WEAKNESS_MIN_GAMES,
  });
  if (enginePatterns instanceof Map) {
    weaknessTargets = mergeEngineIntoTargets(weaknessTargets, enginePatterns);
    // Flag favourite-line rows up front (prefix match, same as the weakness merge) so
    // the collapsed ⚠ marker renders on this pass too — not only after a later
    // mergeEnginePatternsIntoSections call, by which point the HTML is already built.
    graded = mergeEngineIntoTargets(graded, enginePatterns);
  }

  const sectionData = {
    gradedLines: graded,
    weaknessTargets,
    breakdown,
    trie,
    oppColor,
    baselineScorePct: baseline,
    enginePatterns,
  };

  const preparedCount = graded.filter((g) => g.prepared).length;
  const totalLines = graded.length;
  const covPct = totalLines ? Math.round((preparedCount / totalLines) * 100) : 0;
  const covTone = scoutCoverageTone(preparedCount, totalLines);
  const prepareAll = `<button type="button" class="scout-btn btn ghost scout-prepare-all" data-color="${oppColor}">Add all gaps ▾</button>`;

  const trending = profile.recentlyChanged[oppColor]
    ? '<span class="scout-trending" title="Their recent games show a different opening">⚡ Recently changed</span>'
    : "";

  const firstMoves = dist.map((m) => scoutDistRowHtml(m, escapeHtml)).join("");
  const weaknessRows = weaknessTargets
    .map((t, i) => scoutWeaknessRowHtml(t, i, oppColor, baseline, escapeHtml))
    .join("");
  const weaknessPanel = weaknessRows
    ? `<div class="scout-col scout-col-weaknesses">
          <div class="scout-col-label">Prepare these first <span class="scout-col-hint muted">weaknesses & opportunities</span></div>
          <div class="scout-lines">${weaknessRows}</div>
        </div>`
    : `<div class="scout-col scout-col-weaknesses">
          <div class="scout-col-label">Prepare these first</div>
          <div class="muted hint">No lines score meaningfully below their ${baseline}% baseline (n≥${WEAKNESS_MIN_GAMES}).</div>
        </div>`;

  const lineRows = graded
    .map((line, i) => scoutLineRowHtml(line, i, oppColor, baseline, escapeHtml))
    .join("");

  const heading = oppColor === "white" ? "With White" : "With Black";
  const html = `
    <div class="scout-section" data-scout-color="${oppColor}">
      <div class="scout-section-head">
        <span class="scout-color-dot ${oppColor}" aria-hidden="true"></span>
        <h3>${heading}</h3>
        <span class="scout-games-count">${trie.gameCount} games</span>
        <span class="scout-section-wdl">${scoutWdlHtml(colorWdl.w, colorWdl.d, colorWdl.l, { compact: true })} <span class="scout-n">n=${colorWdl.games}</span></span>
        <span class="scout-section-score muted">${baseline}% overall</span>
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
        ${weaknessPanel}
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

export function mergeEnginePatternsIntoSections(sections, engineByColor) {
  for (const color of ["white", "black"]) {
    const section = sections[color];
    const patterns = engineByColor?.[color];
    if (!section || !patterns) continue;
    section.enginePatterns = patterns;
    section.weaknessTargets = mergeEngineIntoTargets(section.weaknessTargets, patterns);
    section.gradedLines = mergeEngineIntoTargets(section.gradedLines, patterns);
  }
}

export function buildScoutShareText({ username, profile, sections, activeSpeed }) {
  const lines = [`# Scout: ${username}`, "", `${profile.total} games · filter: ${activeSpeed}`, ""];
  for (const color of ["white", "black"]) {
    const section = sections[color];
    if (!section) continue;
    const heading = color === "white" ? "With White" : "With Black";
    const stats = profile.colorStats?.[color];
    lines.push(`## ${heading}`);
    if (stats) {
      lines.push(`Overall: ${stats.scorePct}% (W${stats.w}/D${stats.d}/L${stats.l}, n=${stats.games})`);
    }
    if (section.weaknessTargets?.length) {
      lines.push("", "**Prepare these first:**");
      for (const t of section.weaknessTargets.slice(0, 6)) {
        let row = `- ${scoutLineText(t.sans)} — ${Math.round(t.share * 100)}% share, ${t.scorePct}% score (n=${t.games})`;
        if (t.enginePattern) {
          row += `; often …${t.enginePattern.playedSan}`;
        }
        lines.push(row);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function handleScoutProfileClick(event, { getState, onSpeedChange, callbacks }) {
  const shareBtn = event.target.closest?.("#scout-share-btn");
  if (shareBtn) {
    callbacks?.copyScoutReport?.();
    return true;
  }
  const deepBtn = event.target.closest?.("#scout-deep-scan-btn");
  if (deepBtn) {
    callbacks?.runDeepScan?.();
    return true;
  }
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

function resolveRow(state, rowKind, color, idx) {
  const sectionData = state.sections[color];
  if (!sectionData) return null;
  if (rowKind === "weakness") return sectionData.weaknessTargets?.[idx] || null;
  return sectionData.gradedLines?.[idx] || null;
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
    if (sectionData) {
      const lines = [...sectionData.weaknessTargets, ...sectionData.gradedLines.filter((l) => !l.prepared)];
      await callbacks.scoutPrepareAll(lines, color);
    }
    return;
  }

  const addPrepBtn = event.target.closest?.(".scout-action-add-prep");
  if (addPrepBtn) {
    const color = addPrepBtn.dataset.color;
    const rowKind = addPrepBtn.dataset.rowKind || "line";
    const idx = parseInt(addPrepBtn.dataset.rowIdx, 10);
    const line = resolveRow(state, rowKind, color, idx);
    if (line) await callbacks.scoutAddToPrep(line, color);
    return;
  }

  const analyzeBtn = event.target.closest?.(".scout-action-analyze");
  if (analyzeBtn) {
    const lineEl = analyzeBtn.closest(".scout-line-detail")?.previousElementSibling;
    const color = lineEl?.dataset.color;
    const rowKind = analyzeBtn.dataset.rowKind || "line";
    const idx = parseInt(analyzeBtn.dataset.rowIdx, 10);
    const line = resolveRow(state, rowKind, color, idx);
    if (line) callbacks.scoutAnalyzeLine(line, color, state.username);
    return;
  }

  const lineEl = event.target.closest?.(".scout-line");
  if (
    lineEl &&
    !event.target.closest?.(".scout-add-icon, .scout-action-add-prep, .scout-action-analyze")
  ) {
    const color = lineEl.dataset.color;
    const rowKind = lineEl.dataset.rowKind || "line";
    const idx = parseInt(lineEl.dataset.rowIdx, 10);
    const sectionData = state.sections[color];
    if (!sectionData) return;
    const expanded = lineEl.classList.toggle("is-expanded");
    lineEl.setAttribute("aria-expanded", expanded);
    if (expanded && !lineEl.nextElementSibling?.classList.contains("scout-line-detail")) {
      const line = resolveRow(state, rowKind, color, idx);
      if (!line) return;
      const detail = makeEl("div");
      detail.className = "scout-line-detail";
      detail.innerHTML = callbacks.scoutLineDetailHtml(line, idx, color, rowKind);
      lineEl.insertAdjacentElement("afterend", detail);
      const fen = scoutModule.fenAfterLine(line.ucis);
      callbacks.enrichEcoForLine(lineEl, fen);
    } else if (!expanded) {
      const detail = lineEl.nextElementSibling;
      if (detail?.classList.contains("scout-line-detail")) detail.remove();
    }
  }
}
