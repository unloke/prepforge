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

export function scoutWdlHtml(w, d, l, { compact = false } = {}) {
  const cls = compact ? "scout-wdl scout-wdl-compact" : "scout-wdl";
  return `<span class="${cls}" aria-label="${w} wins, ${d} draws, ${l} losses">
    <span class="scout-wdl-pill scout-wdl-w" title="Wins">W${w}</span>
    <span class="scout-wdl-pill scout-wdl-d" title="Draws">D${d}</span>
    <span class="scout-wdl-pill scout-wdl-l" title="Losses">L${l}</span>
  </span>`;
}

export function scoutScoreWithSample(scorePct, games, { baseline, faded = false } = {}) {
  const fadedCls = faded ? " scout-stat-faded" : "";
  let text = `${scorePct}% <span class="scout-n">n=${games}</span>`;
  if (baseline != null && baseline > scorePct) {
    const delta = baseline - scorePct;
    text += ` <span class="scout-baseline-gap${fadedCls}" title="vs their overall ${baseline}%">−${delta} vs ${baseline}%</span>`;
  }
  if (faded) text += ' <span class="scout-small-sample">small sample</span>';
  return text;
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

function scoutAddPrepBtn(rowKind, idx, oppColor) {
  return `<button type="button" class="scout-btn btn ghost scout-action-add-prep" data-row-kind="${rowKind}" data-row-idx="${idx}" data-color="${oppColor}">Add to prep ▾</button>`;
}

export function scoutLineDetailHtml(line, idx, oppColor, rowKind, { fenAfterLine, renderBoard, escapeHtml }) {
  const fen = fenAfterLine(line.ucis);
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
        <button type="button" class="scout-btn btn ghost scout-action-analyze" data-row-kind="${rowKind}" data-row-idx="${idx}">Analyze ›</button>
        ${scoutAddPrepBtn(rowKind, idx, oppColor)}
        ${engineNote}
        ${subLines}
      </div>`;
}

export function buildScoutAnalyzePgn(line, oppColor, username) {
  const [white, black] = oppColor === "white" ? [username, "?"] : ["?", username];
  const headers = `[Event "Scout — ${username}"]\n[White "${white}"]\n[Black "${black}"]\n[Result "*"]`;
  return `${headers}\n\n${scoutLineText(line.sans)} *`;
}

function scoutDistRowHtml(m, escapeHtml, { clickable = true } = {}) {
  const heat = m.scorePct >= 55 ? " is-hot" : m.scorePct <= 45 ? " is-cold" : "";
  const clickAttrs = clickable && m.uci
    ? ` data-first-uci="${escapeHtml(m.uci)}" role="button" tabindex="0"`
    : "";
  return `
      <div class="scout-row scout-dist-row${heat}"${clickAttrs}>
        <span class="scout-row-count scout-dist-san">${escapeHtml(m.san)}</span>
        <span class="scout-row-main scout-dist-bar"><span style="width:${Math.round(m.share * 100)}%"></span></span>
        <span class="scout-row-share">${Math.round(m.share * 100)}%</span>
        <span class="scout-row-score" title="Their score with this move">${scoutScoreWithSample(m.scorePct, m.gameCount)}</span>
        <span class="scout-row-end">${scoutWdlHtml(m.w || 0, m.d || 0, m.l || 0, { compact: true })}</span>
      </div>`;
}

function scoutLineRowHtml(line, i, oppColor, baseline, escapeHtml, { rowKind = "line" } = {}) {
  const gap = line.covered > 0;
  const label = line.prepared
    ? "&#10003; prepared"
    : gap
      ? `gap @${line.covered}`
      : "not in prep";
  const tone = line.prepared ? "good" : gap ? "warn" : "bad";
  const tip = line.prepared
    ? "Your prep follows this line"
    : gap
      ? `Gap in ${line.repName || "your prep"}`
      : "This line is not in your prep";
  const badge = `<span class="scout-badge ${tone}" title="${escapeHtml(tip)}">${label}</span>`;
  const moves = scoutLineText(line.sans);
  const rawCount = line.gameCount ?? Math.round(line.count);
  const engineFlag = line.hasEngineMistake
    ? '<span class="scout-err-marker" title="Recurring mistake in deep scan">⚠</span>'
    : "";
  return `
      <div class="scout-row scout-line" data-row-kind="${rowKind}" data-row-idx="${i}" data-color="${oppColor}" role="button" tabindex="0" aria-expanded="false">
        <span class="scout-row-count" title="${rawCount} of their games">&times;${rawCount}</span>
        <div class="scout-row-main scout-line-main">
          <span class="scout-line-eco"></span>
          <span class="scout-line-moves" title="${escapeHtml(moves)}">${escapeHtml(moves)}</span>
        </div>
        <span class="scout-row-share">${Math.round((line.share || 0) * 100)}%</span>
        <span class="scout-row-score" title="Their score in this line">${scoutScoreWithSample(line.scorePct, rawCount, { baseline })}</span>
        <span class="scout-row-end">${engineFlag}${badge}${scoutAddPrepBtn(rowKind, i, oppColor)}</span>
      </div>`;
}

function scoutWeaknessRowHtml(target, i, oppColor, baseline, escapeHtml) {
  const moves = scoutLineText(target.sans);
  const engineFlag = target.hasEngineMistake
    ? '<span class="scout-err-marker" title="Recurring mistake in deep scan">⚠</span>'
    : "";
  const engineHint =
    target.enginePattern && target.hasEngineMistake
      ? ` · often …${escapeHtml(target.enginePattern.playedSan)}`
      : "";
  return `
      <div class="scout-row scout-line scout-weakness-row" data-row-kind="weakness" data-row-idx="${i}" data-color="${oppColor}" role="button" tabindex="0" aria-expanded="false">
        <span class="scout-row-count" title="${target.games} games">&times;${target.games}</span>
        <div class="scout-row-main scout-line-main">
          <span class="scout-line-moves" title="${escapeHtml(moves)}">${escapeHtml(moves)}${engineHint}</span>
        </div>
        <span class="scout-row-share">${Math.round(target.share * 100)}%</span>
        <span class="scout-row-score">${scoutScoreWithSample(target.scorePct, target.games, { baseline })}</span>
        <span class="scout-row-end">${engineFlag}${scoutWdlHtml(target.w, target.d, target.l, { compact: true })}${scoutAddPrepBtn("weakness", i, oppColor)}</span>
      </div>`;
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
    !event.target.closest?.(
      ".scout-badge, .scout-action-add-prep, .scout-action-analyze, .scout-action-prep, [data-prep-rep]",
    )
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
