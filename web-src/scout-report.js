// Scout report rendering + delegated interaction handlers (testable without app.js).

import { Chess } from "chess.js";

import { engineScanPatterns } from "./scout-engine.js";
import {
  buildRefutations,
  collectActionableRefutationGapActions,
  collectActionableRefutationGaps,
} from "./scout-refutation.js";
import {
  SCOUT_BRANCH_HARD_CEILING,
  attachPrepReplies,
  fenAfterLine,
  mergeEngineIntoTargets,
  opponentColorStats,
  scoutLineText,
} from "./scout.js";
import { formatLastSeenLabel, lineLastSeen } from "./scout-stats.js";
import { buildScoutStats } from "./scout-stats.js";
import {
  applyMaiaToLines,
  medianOpponentRating,
  scoutLineWdlCounts,
  scoutMaiaRankedNote,
} from "./scout-maia.js";
import { buildScoutSectionSummary } from "./scout-summary.js";
import { PRODUCTION_MODULE_B_ID, selectProductionRoutes } from "./scout-selector.js";

export function scoutLineKey(ucis) {
  return (ucis || []).join(">");
}

/** Best-effort read of a cached ECO string or in-flight Promise. */
export async function consumeEcoCacheEntry(cached) {
  try {
    return cached instanceof Promise ? await cached : cached;
  } catch (_) {
    return null;
  }
}

export function captureScoutExpanded(resultsEl) {
  if (!resultsEl) return { expandedKeys: new Set(), scrollTop: 0 };
  const expandedKeys = new Set();
  const expanded =
    resultsEl.querySelectorAll?.(".scout-line.is-expanded[data-line-key]") || [];
  for (const el of expanded) {
    if (el.dataset.lineKey) expandedKeys.add(el.dataset.lineKey);
  }
  return { expandedKeys, scrollTop: resultsEl.scrollTop };
}

function findLineByKey(sections, color, lineKey) {
  const section = sections?.[color];
  if (!section || !lineKey) return null;
  for (const line of section.prepTargets || section.weaknessTargets || []) {
    if (scoutLineKey(line.ucis) === lineKey) return { line, rowKind: "prep" };
  }
  for (const line of section.gradedLines || []) {
    if (scoutLineKey(line.ucis) === lineKey) return { line, rowKind: "line" };
  }
  return null;
}

export function renderScoutColorTabsHtml(profile, escapeHtml, { hidden = false } = {}) {
  const colors = ["white", "black"].filter(
    (c) => profile?.colorStats?.[c] && profile.colorStats[c].games > 0,
  );
  // With a real opponent history both colours almost always have games; single-
  // colour histories render a lone (still-correct) tab. No data → no bar.
  if (!colors.length) return "";
  // WAI-ARIA tabs: exactly one aria-selected="true" and roving tabindex — only
  // the active tab is tabbable, the rest stay focusable via arrow keys.
  const buttons = colors
    .map((c, i) => {
      const stats = profile.colorStats[c];
      const label = c === "white" ? "With White" : "With Black";
      const selected = i === 0 ? "true" : "false";
      const tabindex = i === 0 ? "" : ' tabindex="-1"';
      return `<button type="button" class="scout-color-tab${i === 0 ? " is-active" : ""}" role="tab" data-scout-tab="${c}" aria-selected="${selected}"${tabindex} aria-controls="scout-section-${c}"><span class="scout-color-dot ${c}" aria-hidden="true"></span>${escapeHtml(label)} <small>${stats.games} games</small></button>`;
    })
    .join("");
  return `<div class="scout-color-tabs" role="tablist" aria-label="Opponent colour"${hidden ? ' hidden' : ''}>${buttons}</div>`;
}

// Tab switch = visibility only: the sections keep their computed line state
// (expansion, drilldown, enrichment). State lives on the results element so a
// re-render keeps the active colour and restored sections re-apply it.
// Also keeps roving tabindex in sync: only the selected tab is tabbable.
export function applyScoutColorTabs(resultsEl) {
  if (!resultsEl) return;
  const tabs = resultsEl.querySelectorAll(".scout-color-tab");
  if (!tabs.length) return;
  const sections = resultsEl.querySelectorAll(".scout-section[data-scout-color]");
  const active = resultsEl.dataset.scoutTab || tabs[0]?.dataset.scoutTab || "white";
  tabs.forEach((tab) => {
    const on = tab.dataset.scoutTab === active;
    tab.classList.toggle("is-active", on);
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.tabIndex = on ? 0 : -1;
  });
  sections.forEach((section) => {
    section.hidden = section.dataset.scoutColor !== active;
  });
}

export function handleScoutColorTabClick(event, resultsEl) {
  const tab = event.target.closest?.(".scout-color-tab");
  if (!tab || !resultsEl?.contains(tab)) return false;
  resultsEl.dataset.scoutTab = tab.dataset.scoutTab;
  applyScoutColorTabs(resultsEl);
  return true;
}

// ArrowLeft / ArrowRight cycle between the colour tabs; Home / End jump to the
// first / last (WAI-ARIA tabs pattern, automatic activation): focus follows the
// active tab and the same visibility-only switch runs as a click — section
// state is never rebuilt.
export function handleScoutColorTabKeydown(event, resultsEl) {
  if (
    event.key !== "ArrowLeft" &&
    event.key !== "ArrowRight" &&
    event.key !== "Home" &&
    event.key !== "End"
  ) {
    return false;
  }
  const tab = event.target.closest?.(".scout-color-tab");
  if (!tab || !resultsEl?.contains(tab)) return false;
  const tabs = Array.from(resultsEl.querySelectorAll?.(".scout-color-tab") || []);
  const index = tabs.indexOf(tab);
  if (index < 0) return false;
  let next;
  if (event.key === "Home") next = tabs[0];
  else if (event.key === "End") next = tabs[tabs.length - 1];
  else {
    const step = event.key === "ArrowRight" ? 1 : -1;
    next = tabs[(index + step + tabs.length) % tabs.length];
  }
  if (!next) return false;
  event.preventDefault?.();
  resultsEl.dataset.scoutTab = next.dataset.scoutTab;
  applyScoutColorTabs(resultsEl);
  next.focus?.();
  return true;
}

export function restoreScoutExpanded(resultsEl, sections, captured, ctx) {
  if (!resultsEl || !captured?.expandedKeys?.size) {
    if (resultsEl && captured) resultsEl.scrollTop = captured.scrollTop || 0;
    return;
  }
  const { expandedKeys, scrollTop } = captured;
  const rows = resultsEl.querySelectorAll?.(".scout-line[data-line-key]") || [];
  // One line is open at a time (its detail lives in the side panel), so the
  // first captured key that still exists after the rebuild wins.
  for (const el of rows) {
    if (!expandedKeys.has(el.dataset.lineKey)) continue;
    const match = findLineByKey(sections, el.dataset.color, el.dataset.lineKey);
    if (!match) continue;
    openScoutLine(el, match.line, match.rowKind, ctx);
    break;
  }
  resultsEl.scrollTop = scrollTop || 0;
}

// Marks `lineEl` as the single open row and paints its detail into the side
// panel (ctx.sideEl). The ECO name is filled in from the cache, or enriched.
export function openScoutLine(lineEl, line, rowKind, ctx) {
  const { scoutModule, callbacks, sideEl } = ctx;
  const root = lineEl.closest?.(".scout-results") || lineEl.parentElement?.parentElement;
  for (const el of root?.querySelectorAll?.(".scout-line.is-expanded") || []) {
    if (el === lineEl) continue;
    el.classList.remove("is-expanded");
    el.setAttribute("aria-expanded", "false");
  }
  const key = lineEl.dataset.lineKey;
  const color = lineEl.dataset.color;
  const idx = parseInt(lineEl.dataset.rowIdx, 10);
  lineEl.classList.add("is-expanded");
  lineEl.setAttribute("aria-expanded", "true");
  if (sideEl) {
    if (sideEl.dataset.lineKey !== key || sideEl.dataset.color !== color) {
      sideEl.innerHTML = callbacks.scoutLineDetailHtml(line, idx, color, rowKind);
      sideEl.dataset.lineKey = key;
      sideEl.dataset.color = color;
    }
    sideEl.hidden = false;
  }
  const ecoCached = ctx.ecoCache?.get(key);
  const ecoEl = lineEl.querySelector?.(".scout-line-eco");
  if (ecoCached && ecoEl) {
    if (ecoCached instanceof Promise) {
      ecoCached
        .then((opening) => {
          if (opening) ecoEl.textContent = opening;
        })
        .catch(() => {});
    } else {
      ecoEl.textContent = ecoCached;
    }
  } else if (scoutModule && callbacks.enrichEcoForLine) {
    callbacks.enrichEcoForLine(lineEl, scoutModule.fenAfterLine(line.ucis), key);
  }
}

// After a (re)render or a colour-tab switch: make sure the visible colour has
// an open line (its first row by default) and the side panel shows it.
export function ensureScoutLineSelection(resultsEl, sections, ctx) {
  const { sideEl } = ctx;
  if (!resultsEl) return;
  const section = Array.from(resultsEl.querySelectorAll?.(".scout-section") || []).find(
    (el) => !el.hidden,
  );
  const open = section?.querySelector?.(".scout-line.is-expanded[data-line-key]");
  const target = open || section?.querySelector?.(".scout-line[data-line-key]");
  const match = target ? findLineByKey(sections, target.dataset.color, target.dataset.lineKey) : null;
  if (!match) {
    if (sideEl) {
      sideEl.hidden = true;
      sideEl.innerHTML = "";
      delete sideEl.dataset.lineKey;
    }
    return;
  }
  openScoutLine(target, match.line, match.rowKind, ctx);
}

export { scoutLineText };

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
export function scoutWdlBar(w, d, l, { maiaEstimate = false } = {}) {
  const total = w + d + l || 1;
  const pct = (n) => `${(n / total) * 100}%`;
  const title = maiaEstimate
    ? "Maia W/D/L estimate (not from their games)"
    : `W${w} D${d} L${l}`;
  const cls = maiaEstimate ? " scout-maia-estimate" : "";
  return `<span class="scout-wdlbar${cls}" title="${title}" aria-label="${title}">
    <span class="scout-wdlbar-w" style="width:${pct(w)}"></span>
    <span class="scout-wdlbar-d" style="width:${pct(d)}"></span>
    <span class="scout-wdlbar-l" style="width:${pct(l)}"></span>
  </span>`;
}

export function scoutSparkline(
  points,
  { width = 80, height = 24, min = null, max = null, className = "" } = {},
) {
  if (!points?.length) {
    return `<svg class="scout-sparkline ${className}" width="${width}" height="${height}" aria-hidden="true"></svg>`;
  }
  const lo = min ?? Math.min(...points);
  const hi = max ?? Math.max(...points);
  const range = hi - lo || 1;
  const coords = points.map((v, i) => {
    const x = (i / Math.max(1, points.length - 1)) * (width - 2) + 1;
    const y = height - 1 - ((v - lo) / range) * (height - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg class="scout-sparkline ${className}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${coords.join(" ")}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

export function scoutSvgBar(
  items,
  {
    valueKey = "scorePct",
    labelKey = "san",
    maxValue = 100,
    valueSuffix = "%",
    escapeHtml,
  } = {},
) {
  if (!items?.length) {
    return `<div class="scout-bar-chart scout-bar-empty muted hint">No family data yet.</div>`;
  }
  const scale = maxValue > 0 ? maxValue : 100;
  const rows = items.slice(0, 6).map((item) => {
    const val = item[valueKey] ?? 0;
    const pct = Math.max(2, Math.round((val / scale) * 100));
    const tone =
      valueSuffix === "%" && val <= 40
        ? " is-cold"
        : valueSuffix === "%" && val >= 55
          ? " is-hot"
          : val >= scale * 0.55
            ? " is-hot"
            : val <= scale * 0.25
              ? " is-cold"
              : "";
    const label = escapeHtml ? escapeHtml(String(item[labelKey] || "?")) : String(item[labelKey] || "?");
    return `<div class="scout-bar-row${tone}">
      <span class="scout-bar-label">${label}</span>
      <span class="scout-bar-track"><span class="scout-bar-fill" style="width:${pct}%"></span></span>
      <span class="scout-bar-val">${val}${valueSuffix}</span>
    </div>`;
  }).join("");
  return `<div class="scout-bar-chart">${rows}</div>`;
}

export function renderScoutEnginePanel(engineAgg, escapeHtml) {
  if (!engineAgg) {
    return `<div class="scout-engine-panel muted hint">Engine scan: run Deep scan for eval trends</div>`;
  }
  if (!engineAgg.sufficient) {
    const analyzed = engineAgg.analyzedGames ?? 0;
    const eligible = engineAgg.eligibleGames ?? 0;
    const coverage = engineAgg.coveragePct ?? 0;
    const staleNote =
      engineAgg.status === "stale" ? " — new games arrived, re-run Deep scan" : "";
    return `<div class="scout-engine-panel scout-engine-insufficient muted hint">Deep scan coverage insufficient (${analyzed}/${eligible} games analyzed, ${coverage}% coverage — need ≥${engineAgg.minAnalyzedGames} games and ≥${engineAgg.minCoveragePct}%)${escapeHtml(staleNote)}</div>`;
  }
  const families = engineAgg.families?.slice(0, 6) || [];
  const maxAcpl = Math.max(120, ...families.map((f) => f.acpl || 0));
  const bars = scoutSvgBar(families, {
    escapeHtml,
    valueKey: "acpl",
    maxValue: maxAcpl,
    valueSuffix: " cp",
  });
  const worst = families[0];
  const scopeNote =
    engineAgg.scopeLimited && engineAgg.maxGames
      ? ` — based on latest ${engineAgg.maxGames} games`
      : "";
  const summary = worst
    ? `<div class="scout-engine-summary muted hint">Highest ACPL: 1.${escapeHtml(worst.san)} (${worst.acpl} cp${worst.firstInaccuracyPly != null ? `, first inaccuracy ~ply ${worst.firstInaccuracyPly}` : ""})${escapeHtml(scopeNote)}</div>`
    : engineAgg.scopeLimited && engineAgg.maxGames
      ? `<div class="scout-engine-summary muted hint">Based on latest ${engineAgg.maxGames} games</div>`
      : "";
  return `<div class="scout-engine-panel">${bars}${summary}</div>`;
}

function formatRefutationLine(pathSans) {
  if (!pathSans?.length) return "?";
  return pathSans.map((san, i) => (i === 0 ? `1.${san}` : san)).join(" ");
}

export function refutationA11ySummary(refutations) {
  const hits = (refutations || []).filter((r) => r.refutation).slice(0, 3);
  if (!hits.length) {
    const gaps = collectActionableRefutationGaps(refutations);
    if (!gaps.length) return "";
    return `Refutation prep gaps: ${gaps.join(", ")}.`;
  }
  const parts = hits.map((item) => {
    const line = formatRefutationLine(item.candidate?.pathSans);
    const reply = item.refutation?.suggestedUci || "?";
    const engineEv = item.evidence?.find((e) => e.layer === "engine");
    const explorerEv = item.evidence?.find((e) => e.layer === "explorer");
    const acpl = engineEv?.acpl != null ? `, ACPL ${engineEv.acpl} cp` : "";
    const sample =
      engineEv?.analyzedGames != null ? ` over ${engineEv.analyzedGames} games` : "";
    const masters =
      explorerEv?.mastersSharePct != null
        ? `, masters ${explorerEv.mastersSharePct}%`
        : "";
    return `After ${line}, play ${reply}${acpl}${sample}${masters}`;
  });
  return `Engine refutations: ${parts.join("; ")}.`;
}

export function renderScoutRefutationGapActions(actions, escapeHtml) {
  if (!actions?.length) return "";
  const buttons = actions
    .map(
      (action) =>
        `<button type="button" class="scout-btn btn ghost scout-refutation-gap-btn" data-refutation-gap="${escapeHtml(action.id)}" data-testid="${escapeHtml(action.testId)}" aria-label="${escapeHtml(action.ariaLabel)}">${escapeHtml(action.label)}</button>`,
    )
    .join("");
  return `<div class="scout-refutation-gap-actions" role="group" aria-label="Refutation preparation actions">${buttons}</div>`;
}

export function handleScoutRefutationGapClick(event, { callbacks } = {}) {
  const gapBtn = event.target.closest?.("[data-refutation-gap]");
  if (!gapBtn) return false;
  const action = gapBtn.dataset.refutationGap;
  if (action === "deep-scan") {
    callbacks?.runDeepScan?.();
    return true;
  }
  return false;
}

function formatPlayerSwingFromCpLoss(cpLoss) {
  if (cpLoss == null || !Number.isFinite(cpLoss)) return null;
  const val = cpLoss / 100;
  return `${val > 0 ? "+" : ""}${val.toFixed(1)}`;
}

function formatReplyLabel(reply) {
  if (!reply) return "?";
  if (typeof reply === "string") return reply;
  return reply.san || reply.uci || "?";
}

export function renderInlineRefutationCard(line, oppColor, escapeHtml, { renderBoard } = {}) {
  const ref = line.refutation;
  if (!ref?.suggestedUci) return "";
  const playerColor = oppColor === "white" ? "black" : "white";
  const theirMove = ref.playedSan || ref.playedUci || "?";
  const cpSwing = ref.cpLoss != null ? formatPlayerSwingFromCpLoss(ref.cpLoss) : null;
  const replyLabel = escapeHtml(ref.suggestedSan || line.suggestedReply?.san || ref.suggestedUci);
  const recurrence = line.enginePattern?.occurrences || line.refutationGames || null;
  const recurrenceNote =
    recurrence != null ? `In ${recurrence} games here they played …${escapeHtml(theirMove)}` : `They played …${escapeHtml(theirMove)}`;
  const swingNote = cpSwing ? ` <span class="scout-refutation-swing">(${cpSwing})</span>` : "";
  const replyFen = fenAfterLine([...(line.ucis || []), ref.suggestedUci].filter(Boolean));
  const boardHtml = renderBoard
    ? `<div class="scout-refutation-card-board">${renderBoard(replyFen, playerColor)}</div>`
    : "";
  return `<div class="scout-refutation-card" data-testid="scout-refutation-card">
    <div class="scout-refutation-card-copy">${recurrenceNote}${swingNote}. You answer <strong class="scout-refutation-reply-san">${replyLabel}</strong>.</div>
    ${boardHtml}
  </div>`;
}

export function renderScoutRefutationPanel(refutations, escapeHtml) {
  const hits = (refutations || []).filter((r) => r.refutation).slice(0, 3);
  if (!hits.length) {
    const actions = collectActionableRefutationGapActions(refutations);
    if (!actions.length) {
      return `<div class="scout-refutation-panel muted hint">No refutation lines yet.</div>`;
    }
    const gapActions = renderScoutRefutationGapActions(actions, escapeHtml);
    const labels = collectActionableRefutationGaps(refutations)
      .map((gap) => escapeHtml(gap))
      .join(" · ");
    return `<div class="scout-refutation-panel scout-refutation-gaps" role="region" aria-label="Refutation preparation gaps">
      <p class="scout-refutation-gaps-copy muted hint">${labels}</p>
      ${gapActions}
    </div>`;
  }
  const rows = hits
    .map((item) => {
      const line = escapeHtml(formatRefutationLine(item.candidate?.pathSans));
      const reply = escapeHtml(item.refutation.suggestedUci || "?");
      const engineEv = item.evidence?.find((e) => e.layer === "engine");
      const explorerEv = item.evidence?.find((e) => e.layer === "explorer");
      const acpl =
        engineEv?.acpl != null
          ? `<span class="scout-refutation-stat">${engineEv.acpl} cp ACPL</span>`
          : "";
      const sample =
        engineEv?.analyzedGames != null
          ? `<span class="scout-refutation-stat">n=${engineEv.analyzedGames}</span>`
          : "";
      const masters =
        explorerEv?.mastersSharePct != null
          ? `<span class="scout-refutation-stat">${explorerEv.mastersSharePct}% masters</span>`
          : "";
      const scopeNote =
        engineEv?.scopeLimited && engineEv?.maxGames
          ? `<span class="scout-refutation-stat">latest ${engineEv.maxGames} games</span>`
          : "";
      return `<div class="scout-refutation-hit" data-testid="scout-refutation-hit">
        <div class="scout-refutation-line">${line}</div>
        <div class="scout-refutation-reply muted hint">Play <code class="scout-refutation-uci">${reply}</code></div>
        <div class="scout-refutation-meta">${[acpl, sample, masters, scopeNote].filter(Boolean).join("")}</div>
      </div>`;
    })
    .join("");
  return `<div class="scout-refutation-panel">${rows}</div>`;
}

function engineA11ySummary(engineAgg) {
  if (!engineAgg) return "";
  if (!engineAgg.sufficient) {
    return `Engine scan coverage insufficient: ${engineAgg.analyzedGames}/${engineAgg.eligibleGames} games, ${engineAgg.coveragePct}% coverage.`;
  }
  const worst = engineAgg.families?.[0];
  if (!worst) return "";
  return `Engine ACPL by family, worst first: 1.${worst.san} ${worst.acpl} cp over ${worst.analyzedGames} analyzed games.`;
}

function trendLabel(trend) {
  if (trend === "up") return "improving";
  if (trend === "down") return "declining";
  return "flat";
}

export function buildScoutIntelligenceA11ySummary(stats) {
  if (!stats) return "";
  const parts = [];

  const families = stats.scoreByFamily?.families?.slice(0, 6) || [];
  if (families.length) {
    const familyText = families
      .map((f) => `1.${f.san} ${f.scorePct}% over ${f.games} games`)
      .join(", ");
    parts.push(`Opening families by score, worst first: ${familyText}.`);
  }

  const shift = stats.repertoireChangeTrend;
  if (shift?.points?.length >= 2) {
    parts.push(`Repertoire concentration trend ${trendLabel(shift.trend)}.`);
  }

  const activity = stats.activitySeries;
  if (activity?.recentWindow?.length) {
    const weeks = activity.recentBuckets || activity.recentWindow.length;
    parts.push(
      `Activity in the last ${weeks} weeks: ${activity.recentGames ?? 0} games.`,
    );
  }

  const predict = stats.predictability;
  if (predict?.topMove) {
    parts.push(
      `First-move predictability: ${predict.label}, top move 1.${predict.topMove.san} ${Math.round((predict.topMove.share || 0) * 100)}%.`,
    );
  }

  const pets = stats.petLineConcentration;
  if (pets?.games > 0) {
    parts.push(`Pet-line concentration: top 3 paths cover ${pets.top3SharePct}% (${pets.label}).`);
  }

  const breadth = stats.repertoireBreadth;
  if (breadth?.breadth > 0) {
    parts.push(`Repertoire breadth: ${breadth.breadth} first moves with at least ${breadth.minGames} games.`);
  }

  const fresh = stats.repertoireFreshness;
  if (fresh?.freshFamilies?.length) {
    const names = fresh.freshFamilies
      .slice(0, 3)
      .map((f) => `1.${f.san} (${f.recentGames})`)
      .join(", ");
    parts.push(`Fresh families in the last ${fresh.recentWindow} games: ${names}.`);
  }

  const persona = stats.personaTags;
  if (persona?.systemSetup?.detected && persona.systemSetup.label) {
    parts.push(`Persona system: ${persona.systemSetup.label}.`);
  } else if (persona?.games) {
    parts.push(
      `Persona: ${persona.aggression.label} aggression, ${persona.castling.label} castling, ${persona.tradeSpeed.label} queen trades.`,
    );
  }

  return parts.join(" ");
}

function explorerA11ySummary(explorerReads) {
  if (!explorerReads?.available) return "";
  const parts = [];
  const dev = explorerReads.theoryDeviation?.items?.[0];
  if (explorerReads.theoryDeviation?.available && dev) {
    parts.push(
      `Theory deviation: ${dev.label} ${dev.opponentSharePct}% vs ${dev.mastersSharePct}% in masters.`,
    );
  }
  const rare = explorerReads.rareWeapons?.items?.[0];
  if (explorerReads.rareWeapons?.available && rare) {
    parts.push(
      `Rare weapon: ${rare.label} scores ${rare.scorePct}% (${rare.mastersSharePct}% in masters).`,
    );
  }
  if (explorerReads.offBook?.available && explorerReads.offBook.sharePct > 0) {
    parts.push(`Off-book share: ${explorerReads.offBook.sharePct}% of probed games.`);
  }
  return parts.join(" ");
}

function renderScoutExplorerReads(explorerReads, escapeHtml) {
  if (!explorerReads?.available) return "";
  const chips = [];

  const dev = explorerReads.theoryDeviation?.items?.[0];
  if (explorerReads.theoryDeviation?.available && dev) {
    chips.push(
      readChip("Opponent share vs masters DB", "Theory", `${escapeHtml(dev.label)} ${dev.opponentSharePct}% vs ${dev.mastersSharePct}% book`),
    );
  }

  const rare = explorerReads.rareWeapons?.items?.[0];
  if (explorerReads.rareWeapons?.available && rare) {
    chips.push(
      readChip("Low masters share, strong results", "Rare", `${escapeHtml(rare.label)} ${rare.scorePct}% · masters ${rare.mastersSharePct}%`),
    );
  }

  if (explorerReads.offBook?.available && explorerReads.offBook.sharePct > 0) {
    const top = explorerReads.offBook.items?.[0];
    const move = top ? ` · ${escapeHtml(top.label)}` : "";
    chips.push(
      readChip("Moves under 5% in masters", "Off-book", `${explorerReads.offBook.sharePct}%${move}`),
    );
  }

  if (!chips.length) return "";
  return `<div class="scout-repertoire-reads scout-explorer-reads">${chips.join("")}</div>`;
}

// Two-line chip: small label over the value (prototype read-chip).
function readChip(title, label, value) {
  return `<span class="scout-read-chip" title="${title}"><small>${label}</small>${value}</span>`;
}

function renderScoutRepertoireReads(stats, escapeHtml) {
  const chips = [];
  const predict = stats?.predictability;
  if (predict?.topMove && predict.games > 0) {
    const pct = Math.round((predict.topMove.share || 0) * 100);
    chips.push(
      readChip("First-move entropy", "Predictability", `${escapeHtml(predict.label)} · 1.${escapeHtml(predict.topMove.san)} ${pct}%`),
    );
  }
  const pets = stats?.petLineConcentration;
  if (pets?.games > 0) {
    chips.push(
      readChip("Share in top 3 opening paths", "Pet lines", `${pets.top3SharePct}% top-3 · ${escapeHtml(pets.label)}`),
    );
  }
  const breadth = stats?.repertoireBreadth;
  if (breadth?.games > 0) {
    chips.push(
      readChip("First moves with enough sample", "Breadth", `${breadth.breadth} main moves (n≥${breadth.minGames})`),
    );
  }
  const fresh = stats?.repertoireFreshness;
  if (fresh?.freshFamilies?.length) {
    const top = fresh.freshFamilies[0];
    chips.push(
      readChip("New families in recent window", "Fresh", `1.${escapeHtml(top.san)} (${top.recentGames} recent)`),
    );
  }
  const shift = stats?.repertoireChangeTrend;
  if (shift?.points?.length >= 2) {
    const label =
      shift.trend === "up"
        ? "concentrating"
        : shift.trend === "down"
          ? "experimenting"
          : "stable";
    chips.push(readChip("First-move mix over time", "Repertoire", label));
  }
  const persona = stats?.personaTags;
  if (persona?.systemSetup?.detected && persona.systemSetup.label) {
    chips.push(
      readChip("Recurring system setup", "System", escapeHtml(persona.systemSetup.label)),
    );
  } else if (persona?.games >= 5) {
    chips.push(
      readChip("Opening style tendencies", "Style", `${escapeHtml(persona.aggression.label)} · ${escapeHtml(persona.castling.label)} · ${escapeHtml(persona.tradeSpeed.label)}`),
    );
  }
  if (!chips.length) return "";
  return `<div class="scout-repertoire-reads">${chips.join("")}</div>`;
}

export function renderScoutIntelSummary(
  stats,
  summary,
  escapeHtml,
  { explorerReads = null } = {},
) {
  const bullets = (summary?.bullets || [])
    .slice(1)
    .map((b) => `<li>${escapeHtml(b)}</li>`)
    .join("");
  const headline = summary?.headline ? escapeHtml(summary.headline) : "";
  const repertoireReads = renderScoutRepertoireReads(stats, escapeHtml);
  const explorerReadsHtml = renderScoutExplorerReads(explorerReads, escapeHtml);
  return `
      <p class="scout-intel-headline headline">${headline}</p>
      ${bullets ? `<ul class="scout-intel-bullets">${bullets}</ul>` : ""}
      ${repertoireReads}
      ${explorerReadsHtml}`;
}

export function renderScoutIntelChartsStrip(
  stats,
  escapeHtml,
  { engineAgg = null, explorerReads = null, refutations = null } = {},
) {
  const families = stats?.scoreByFamily?.families?.slice(0, 6) || [];
  const scoreBars = scoutSvgBar(families, { escapeHtml, valueKey: "scorePct" });
  const repChangeSpark = scoutSparkline(stats?.repertoireChangeTrend?.points || [], {
    min: 0,
    max: 100,
    className: "scout-repchange-spark",
  });
  const activityBuckets = stats?.activitySeries?.recentWindow?.length
    ? stats.activitySeries.recentWindow
    : stats?.activitySeries?.buckets || [];
  const activityCounts = activityBuckets.map((b) => b.count);
  const activitySpark = scoutSparkline(activityCounts, {
    min: 0,
    max: stats?.activitySeries?.max || 1,
    className: "scout-activity-spark",
  });
  const chartSummary = [
    buildScoutIntelligenceA11ySummary(stats),
    explorerA11ySummary(explorerReads),
    engineA11ySummary(engineAgg),
    refutationA11ySummary(refutations),
  ]
    .filter(Boolean)
    .join(" ");
  const a11yBlock = chartSummary
    ? `<p class="visually-hidden">${escapeHtml(chartSummary)}</p>`
    : "";
  const enginePanel = renderScoutEnginePanel(engineAgg, escapeHtml);

  return `
      ${a11yBlock}
      <div class="scout-intel-charts charts">
        <div class="scout-intel-panel card chart">
          <h3 class="scout-col-label">Worst performance <small>by score · n≥3</small></h3>
          ${scoreBars}
        </div>
        <div class="scout-intel-panel card chart">
          <h3 class="scout-col-label scout-engine-label">Engine ACPL <small>deep scan</small></h3>
          ${enginePanel}
        </div>
        <div class="scout-intel-panel scout-intel-trends card chart">
          <h3 class="scout-col-label">Activity</h3>
          <div class="scout-spark-row">
            <span class="scout-spark-label">Repertoire focus</span>
            <span class="scout-spark-box">${repChangeSpark}</span>
            <span class="scout-spark-label">Games</span>
            <span class="scout-spark-box">${activitySpark}</span>
          </div>
        </div>
      </div>`;
}

export function renderScoutIntelligencePanel(
  stats,
  summary,
  escapeHtml,
  { explorerReads = null, engineAgg = null, refutations = null } = {},
) {
  return `
    <div class="scout-intel intel">
      ${renderScoutIntelSummary(stats, summary, escapeHtml, { explorerReads })}
      ${renderScoutIntelChartsStrip(stats, escapeHtml, { engineAgg, explorerReads, refutations })}
    </div>`;
}

// Stacked score cell: the score% on top, the sample size below, plus (for weakness
// rows) how far the line sits under the opponent's own baseline. Fixed width, no wrap.
export function scoutScoreCell(scorePct, games, { baseline, showGap = false, maiaEstimate = false, showN = true } = {}) {
  const gap =
    showGap && baseline != null && baseline > scorePct
      ? `<span class="scout-gap" title="${baseline - scorePct} points below their overall ${baseline}%">−${baseline - scorePct} vs ${baseline}%</span>`
      : "";
  const estTitle = maiaEstimate ? ' title="Maia strength estimate"' : "";
  const estCls = maiaEstimate ? " scout-maia-estimate" : "";
  return `<span class="scout-score-cell${estCls}"${estTitle}>
      <span class="scout-score-pct">${scorePct}%</span>
      ${showN ? `<span class="scout-n">n=${games}</span>` : ''}${gap}
    </span>`;
}

/** Patch score/WDL cells on a rendered game-plan row after Maia results arrive. */
export { scoutLineWdlCounts };

export function patchScoutLineMaiaCells(rowEl, line, baseline) {
  if (!rowEl || line?.maiaScorePct == null || !line?.maiaWdl) return;
  const scoreEl = rowEl.querySelector(".scout-lr-score");
  const wdlEl = rowEl.querySelector(".scout-lr-wdl");
  if (scoreEl) {
    scoreEl.innerHTML = scoutScoreCell(line.maiaScorePct, line.games, {
      baseline,
      showGap: line.belowBaseline > 0,
      maiaEstimate: true,
    });
  }
  if (wdlEl) {
    wdlEl.innerHTML = scoutWdlBar(line.maiaWdl.win, line.maiaWdl.draw, line.maiaWdl.loss, {
      maiaEstimate: true,
    });
  }
  const movesEl = rowEl.querySelector(".scout-line-moves");
  if (movesEl) {
    for (const chip of movesEl.querySelectorAll(".scout-prep-chip")) chip.remove();
    const badge = scoutPrepCategoryBadge(line);
    if (badge) movesEl.insertAdjacentHTML("beforeend", ` ${badge}`);
  }
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

export function renderScoutProfile(profile, username, activeSpeed, escapeHtml, { colorRecHtml = "" } = {}) {
  const speeds = ["bullet", "blitz", "rapid", "classical"];
  const chips = speeds
    .filter((s) => (profile.speedCounts[s] || 0) >= 5)
    .map(
      (s) =>
        `<button type="button" class="scout-speed-chip speed${activeSpeed === s ? " is-on" : ""}" data-speed="${s}" aria-pressed="${activeSpeed === s}">${s.charAt(0).toUpperCase() + s.slice(1)} <small class="scout-speed-n">${profile.speedCounts[s]}</small></button>`,
    )
    .join("");
  return `
    <div class="prof-row">
      <div class="prof-id scout-profile-main">
        <a class="scout-username-link prof-name" data-username="${escapeHtml(username)}" href="https://lichess.org/@/${encodeURIComponent(username)}" target="_blank" rel="noopener">${escapeHtml(username)} ↗</a>
        <span class="scout-profile-games faint">${profile.total} games analyzed</span>
      </div>
      <div class="scout-speed-chips speed-chips" role="group" aria-label="Speed">
        <button type="button" class="scout-speed-chip speed${activeSpeed === "all" ? " is-on" : ""}" data-speed="all" aria-pressed="${activeSpeed === "all"}">All</button>
        ${chips}
      </div>
      <span class="spacer"></span>
      <button type="button" class="btn sm" id="scout-share-btn" title="Copy scout summary">Copy report</button>
      <button type="button" class="btn sm" id="scout-deep-scan-btn" title="Stockfish scan of their opening mistakes">Deep scan ▾</button>
    </div>
    ${colorRecHtml}`;
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

/** Short why-this-route copy from fields the selector already computed. */
export function scoutRouteReasonText(line, baseline) {
  const parts = [];
  if (line?.maiaScorePct != null) {
    parts.push(`Maia estimates they score ${line.maiaScorePct}% here`);
  } else if (baseline != null && line?.belowBaseline > 0) {
    parts.push(`${line.belowBaseline} points below their ${baseline}% baseline`);
  } else if (line?.prepCategory === "attack") {
    parts.push("below their own baseline");
  } else if (line?.prepCategory === "weapon") {
    parts.push("a frequent line they score well on");
  }
  if ((line?.games || 0) === 1) parts.push("thin sample (1 game)");
  else if ((line?.games || 0) > 1) parts.push(`seen in ${line.games} games`);
  if (line?.lastSeen) {
    const seen = formatLastSeenLabel(line.lastSeen);
    if (seen) parts.push(seen);
  }
  return parts.join(" · ");
}

export function scoutLineDetailHtml(line, idx, oppColor, rowKind, { fenAfterLine, renderBoard, escapeHtml, baseline = null }) {
  const fen = fenAfterLine(line.ucis);
  // The board sits on the preparing player's side (opposite the scouted colour).
  const viewColor = oppColor === "white" ? "black" : "white";
  const status = scoutPrepStatus(line);
  const statusLine = status.text
    ? `<div class="scout-line-status line-status ${status.tone}">${escapeHtml(status.text)}</div>`
    : "";
  const reason = rowKind === "prep" || rowKind === "weakness" ? scoutRouteReasonText(line, baseline ?? line.baselineScorePct) : "";
  const reasonLine = reason
    ? `<p class="scout-line-reason note">${escapeHtml(reason)}</p>`
    : "";
  const replyNote = line.suggestedReply?.uci
    ? `<p class="scout-line-reply note good">Suggested reply: <strong>${escapeHtml(formatReplyLabel(line.suggestedReply))}</strong> (${escapeHtml(line.suggestedReply.source || "engine")})</p>`
    : line.needsPrep
      ? `<p class="scout-line-reply note warn">No reply in your prep yet — run Deep scan or extend repertoire</p>`
      : "";
  const engineNote =
    line.enginePattern && line.hasEngineMistake
      ? `<p class="scout-engine-note note eng" title="Recurring mistake from deep scan">Often errs: …${escapeHtml(line.enginePattern.playedSan)} (−${(line.enginePattern.avgCpLoss / 100).toFixed(1)}) in ${line.enginePattern.occurrences} games</p>`
      : line.hasEngineMistake || line.refutation
        ? `<p class="scout-engine-note note eng">Engine refutation available</p>`
        : "";
  const subLines =
    line.subLines && line.subLines.length
      ? `<div class="subvars"><small class="scout-sublines-label faint">Sub-variations</small>
         <div class="scout-sublines">${line.subLines
           .map((sub) => {
             const grey = sub.share < 0.03 ? " muted" : "";
             const pct = Math.round((sub.share || 0) * 100);
             return `<div class="scout-subline sv${grey}"><span>${escapeHtml(scoutLineText(sub.sans))}</span><i style="width:${Math.max(pct, 2)}%"></i><b>${pct}%</b></div>`;
           })
           .join("")}</div></div>`
      : "";
  return `
      <div class="eyebrow">Line detail</div>
      <h2 class="line-title">${escapeHtml(scoutLineText(line.sans))}</h2>
      <div class="scout-miniboard-wrap focus-board">${renderBoard(fen, viewColor)}</div>
      ${statusLine}
      ${reasonLine}
      ${replyNote}
      ${engineNote}
      <div class="scout-line-action-row actions">
        <button type="button" class="scout-action-analyze btn" data-row-kind="${rowKind}" data-row-idx="${idx}" data-color="${oppColor}">Analyze ›</button>
        <button type="button" class="scout-action-add-prep btn primary" data-row-kind="${rowKind}" data-row-idx="${idx}" data-color="${oppColor}">Add to prep ▾</button>
      </div>
      ${subLines}`;
}

export function buildScoutAnalyzePgn(line, oppColor, username) {
  const [white, black] = oppColor === "white" ? [username, "?"] : ["?", username];
  const headers = `[Event "Scout — ${username}"]\n[White "${white}"]\n[Black "${black}"]\n[Result "*"]`;
  return `${headers}\n\n${scoutLineText(legalScoutLineSans(line))} *`;
}

export function legalScoutLineSans(line) {
  if (!line?.ucis?.length) return line?.sans || [];
  const chess = new Chess();
  const sans = [];
  for (const uci of line.ucis) {
    try {
      const move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4] || undefined,
      });
      if (!move) return line.sans || [];
      sans.push(move.san);
    } catch (_) {
      return line.sans || [];
    }
  }
  return sans;
}

// First-move distribution row — lives in the narrow left column, so it stays simple:
// move, frequency bar, share%, score%. Its own grid (not the wide line-row grid).
export function scoutDistRowHtml(m, escapeHtml, { clickable = true } = {}) {
  const heat = m.scorePct >= 55 ? " is-hot" : m.scorePct <= 45 ? " is-cold" : "";
  const clickAttrs = clickable && m.uci
    ? ` data-first-uci="${escapeHtml(m.uci)}" role="button" tabindex="0"`
    : "";
  return `
      <div class="scout-dist-row fm${heat}"${clickAttrs}>
        <b class="scout-dist-san">${escapeHtml(m.san)}</b>
        <span class="scout-dist-bar share"><i style="width:${Math.round(m.share * 100)}%"></i></span>
        <span class="scout-dist-share">${Math.round(m.share * 100)}%</span>
        <span class="scout-dist-score sc" title="Their score with this move · n=${m.gameCount}">${m.scorePct}%</span>
      </div>`;
}

function scoutPrepFramingHtml(line, escapeHtml) {
  const theirLine = scoutLineText(line.sans);
  const reply = line.suggestedReply;
  const when = `<span class="when">When they play <b class="scout-prep-them">${escapeHtml(theirLine)}</b></span>`;
  if (reply?.uci) {
    const replyLabel = escapeHtml(formatReplyLabel(reply));
    return `<span class="scout-prep-framing">${when}<span class="then"><span class="scout-prep-arrow">→</span> you play <b class="scout-prep-you">${replyLabel}</b></span></span>`;
  }
  if (line.needsPrep) {
    return `<span class="scout-prep-framing">${when}<span class="then needs"><span class="scout-prep-arrow">→</span> <span class="scout-prep-needs">needs prep</span></span></span>`;
  }
  return escapeHtml(theirLine);
}

// A rare line (1 game in a big sample) is a real prep target, not noise — show "<1%"
// rather than rounding it to a misleading "0%".
function formatSharePct(share) {
  const pct = (share || 0) * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

function scoutPrepCategoryBadge(line) {
  if (line.prepCategory === "attack") {
    return '<span class="scout-prep-chip scout-prep-chip-attack cat c-attack" title="Below their baseline">attack</span>';
  }
  if (line.prepCategory === "weapon") {
    return '<span class="scout-prep-chip scout-prep-chip-weapon cat c-main" title="Strong repertoire line">main</span>';
  }
  return "";
}

// Prep rows: framing, last-seen badge, optional inline refutation card.
function scoutLineRowHtml(
  line,
  i,
  oppColor,
  baseline,
  escapeHtml,
  { rowKind = "line", renderBoard = null, rank = null } = {},
) {
  const weakness = rowKind === "weakness" || rowKind === "prep";
  const status = scoutPrepStatus(line);
  const framing = scoutPrepFramingHtml(line, escapeHtml);
  // Real integer game count for display — never the recency-weighted `count`, which
  // decays toward 0 for old lines and would render a true n=1 line as "n=0".
  const rawCount = line.gameCount ?? line.games ?? Math.round(line.count ?? 0);
  const engineFlag = line.hasEngineMistake || line.refutation
    ? '<i class="scout-err-marker eng" title="Engine-backed refutation available">⚠</i>'
    : "";
  const lineKey = scoutLineKey(line.ucis);
  const rowTitle = status.text ? ` title="${escapeHtml(status.text)}"` : "";
  const lastSeenBadge = line.lastSeen
    ? `<span class="scout-last-seen seen">${escapeHtml(formatLastSeenLabel(line.lastSeen))}</span>`
    : "";
  const categoryBadge = weakness ? scoutPrepCategoryBadge(line) : "";
  const refCard =
    weakness && line.refutation
      ? renderInlineRefutationCard(line, oppColor, escapeHtml, { renderBoard })
      : "";
  const addTitle = line.suggestedReply?.uci
    ? `Add your reply ${formatReplyLabel(line.suggestedReply)} to prep`
    : "Add this line to a repertoire";
  const addBtn = `<button type="button" class="scout-add-icon scout-action-add-prep add" title="${escapeHtml(addTitle)}" aria-label="Add to prep" data-row-kind="${rowKind}" data-row-idx="${i}" data-color="${oppColor}">+</button>`;
  const maiaEstimate = line.maiaScorePct != null;
  const displayScore = maiaEstimate ? line.maiaScorePct : line.scorePct;
  const wdl = scoutLineWdlCounts(line);
  if (weakness) {
    // Game-plan rows: no ×N count or share% — on n=1 deep lines these are always
    // trivially 1 and <1%, so they add visual noise without information.
    return `
      <div class="scout-line scout-line-row line-row ${status.cls} scout-weakness-row scout-ranked-row" data-line-key="${escapeHtml(lineKey)}" data-row-kind="${rowKind}" data-row-idx="${i}" data-color="${oppColor}" role="button" tabindex="0" aria-expanded="false"${rowTitle}>
        <div class="scout-lr-main lr-main">
          <span class="scout-line-eco"></span>
          <span class="scout-line-moves">${framing}</span>
          ${refCard}
        </div>
        <span class="lr-meta">${categoryBadge}${lastSeenBadge}</span>
        <span class="scout-lr-score lr-score">${scoutScoreCell(displayScore, rawCount, { baseline, showGap: line.belowBaseline > 0, maiaEstimate, showN: rawCount > 1 })}</span>
        <span class="scout-lr-wdl lr-wdl">${scoutWdlBar(wdl.w, wdl.d, wdl.l, { maiaEstimate })}</span>
        <span class="scout-lr-action lr-flags">${engineFlag}${addBtn}</span>
      </div>`;
  }
  const countCell = `<span class="scout-lr-count" title="${rawCount} of their games">&times;${rawCount}</span>`;
  return `
      <div class="scout-line scout-line-row ${status.cls}" data-line-key="${escapeHtml(lineKey)}" data-row-kind="${rowKind}" data-row-idx="${i}" data-color="${oppColor}" role="button" tabindex="0" aria-expanded="false"${rowTitle}>
        ${countCell}
        <div class="scout-lr-main">
          <span class="scout-line-eco"></span>
          <span class="scout-line-moves">${framing}</span>
        </div>
        <span class="scout-lr-score">${scoutScoreCell(displayScore, rawCount, { baseline, maiaEstimate })}</span>
        <span class="scout-lr-wdl">${scoutWdlBar(wdl.w, wdl.d, wdl.l, { maiaEstimate })}</span>
        <span class="scout-lr-action">${engineFlag}${addBtn}</span>
      </div>`;
}

function scoutWeaknessRowHtml(target, i, oppColor, baseline, escapeHtml, opts = {}) {
  return scoutLineRowHtml(target, i, oppColor, baseline, escapeHtml, {
    rowKind: "prep",
    rank: i,
    ...opts,
  });
}

export function buildScoutSectionReport(
  scoutModule,
  { games, profile, username },
  oppColor,
  myLookups,
  {
    speedFilter = "all",
    escapeHtml,
    enginePatterns = null,
    explorerReads = null,
    engineAgg = null,
    engineScan = null,
    maiaResults = null,
    maiaRatings = null,
    maiaEnrichState = "idle",
    prefilterEnrichState = "idle",
    prefilteredLines = null,
    trie: prebuiltTrie = null,
    // v12 mode: the standalone audit viewer replaces this section's weakness list and
    // coverage bar; keep the heading, intel summary, first-move distribution and charts.
    v3Mode = false,
  },
) {
  // The streaming view keeps a persistent per-colour trie (inserted once per game) and
  // passes it in so we don't rebuild it from every game on each batch — the O(N²) that
  // made Scout heavy mid-stream. Fall back to a one-shot build when none is supplied.
  const trie = prebuiltTrie || scoutModule.buildOpeningTrie(games, oppColor, { speedFilter, maxPlies: Infinity });
  if (!trie.gameCount) return { html: "", sectionData: null };

  const stats = buildScoutStats(games, { color: oppColor, speedFilter });
  const colorWdl = opponentColorStats(games, oppColor, { speedFilter });
  // Speed-filtered WDL/score must match the filtered trie. When the filter is
  // "all", an explicit profile.colorStats override is kept (tests + header).
  const profileBaseline = profile.colorStats?.[oppColor]?.scorePct;
  const baseline =
    speedFilter !== "all"
      ? colorWdl.scorePct
      : (profileBaseline ?? (trie.count ? Math.round((trie.score / trie.count) * 100) : colorWdl.scorePct));

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
  const sectionRating = maiaRatings?.[oppColor] ?? medianOpponentRating(games, oppColor);
  const { branches: allOpeningLines, ancestorFreq } = scoutModule.rankedOpeningBranches(
    games,
    oppColor,
    { speedFilter, trie, baselineScorePct: baseline, limit: SCOUT_BRANCH_HARD_CEILING },
  );
  let gamePlanSource = allOpeningLines;
  if (Array.isArray(prefilteredLines) && (prefilteredLines.length || prefilterEnrichState === "ready")) {
    const byKey = new Map(
      allOpeningLines.map((line) => [scoutLineKey(line.ucis), line]),
    );
    gamePlanSource = prefilteredLines
      .map((line) => ({ ...byKey.get(scoutLineKey(line.ucis)), ...line }))
      .filter(Boolean);
  }
  if (maiaResults?.size) {
    gamePlanSource = applyMaiaToLines(gamePlanSource, {
      maiaResults,
      rating: sectionRating,
      oppColor,
      baselineScorePct: baseline,
      fenAfterLine: scoutModule.fenAfterLine,
      enrichPrepTarget: scoutModule.enrichPrepTarget,
    });
  }
  let weaknessTargets = selectProductionRoutes(gamePlanSource, baseline, {
    oppColor,
    games,
    speedFilter,
    lineLastSeen,
    ancestorFreq,
  });
  if (enginePatterns instanceof Map) {
    weaknessTargets = mergeEngineIntoTargets(weaknessTargets, enginePatterns);
    graded = mergeEngineIntoTargets(graded, enginePatterns);
  }

  const refutations = buildRefutations({
    weaknessTargets,
    color: oppColor,
    speedFilter,
    baselineScorePct: baseline,
    explorerReads,
    mastersByFen: explorerReads?.mastersByFen,
    engineAgg,
    engineScan,
  });

  const lookups = myLookups.map(({ lookup }) => ({ lookup }));
  const lastSeenByLine = new Map();
  for (const target of weaknessTargets) {
    const key = scoutLineKey(target.ucis);
    const seen = lineLastSeen(games, target.ucis, { color: oppColor, speedFilter });
    target.lastSeen = seen;
    lastSeenByLine.set(key, seen);
  }
  const prepTargets = attachPrepReplies(weaknessTargets, {
    lookups,
    refutations,
    oppColor,
  });

  const summary = buildScoutSectionSummary(stats, {
    username: username || "opponent",
    explorerReads,
    engineAgg,
    prepTargets,
    lastSeenByLine,
  });
  const intelSummary = renderScoutIntelSummary(stats, summary, escapeHtml, { explorerReads });
  const intelCharts = renderScoutIntelChartsStrip(stats, escapeHtml, {
    explorerReads,
    engineAgg,
    refutations,
  });

  const sectionData = {
    moduleB: PRODUCTION_MODULE_B_ID,
    gradedLines: graded,
    weaknessTargets: prepTargets,
    prepTargets,
    breakdown,
    trie,
    oppColor,
    baselineScorePct: baseline,
    enginePatterns,
    stats,
    summary,
    explorerReads,
    engineAgg,
    refutations,
  };

  const preparedCount = graded.filter((g) => g.prepared).length;
  const totalLines = graded.length;
  const covPct = totalLines ? Math.round((preparedCount / totalLines) * 100) : 0;
  const covTone = scoutCoverageTone(preparedCount, totalLines);
  const prepareAll = `<button type="button" class="btn sm primary scout-prepare-all" data-color="${oppColor}">Add all gaps ▾</button>`;

  const trending = profile.recentlyChanged[oppColor]
    ? '<span class="scout-trending kchip k-due" title="Their recent games show a different opening">⚡ Recently changed</span>'
    : "";

  const firstMoves = dist.map((m) => scoutDistRowHtml(m, escapeHtml)).join("");
  const refutationGaps = collectActionableRefutationGapActions(refutations);
  const gapActionsHtml = refutationGaps.length
    ? renderScoutRefutationGapActions(refutationGaps, escapeHtml)
    : "";

  const prepRows = v3Mode
    ? ""
    : prepTargets
        .map((t, i) => scoutWeaknessRowHtml(t, i, oppColor, baseline, escapeHtml))
        .join("");
  const rankedNote = scoutMaiaRankedNote(prepTargets, maiaEnrichState, {
    prefilterState: prefilterEnrichState,
  });
  const planHead = `<div class="scout-game-plan-head plan-head">
            <b class="scout-col-label">${v3Mode ? "First moves" : "Your game plan"}</b>
            ${v3Mode ? "" : '<span class="scout-col-hint faint">most exploitable first · when they play X → you play Y</span>'}
          </div>`;
  const firstMovesHtml = `<div class="scout-first-moves">
            <span class="visually-hidden">First moves</span>
            <div class="scout-dist scout-dist-compact first-moves" data-dist-root="true">${firstMoves}</div>
          </div>`;
  const prepPanel = prepRows
    ? `<div class="scout-game-plan plan">
          ${planHead}
          ${firstMovesHtml}
          ${gapActionsHtml}
          <div class="scout-lines scout-ranked-list lines" role="list">${prepRows}</div>
          ${rankedNote}
        </div>`
    : `<div class="scout-game-plan plan">
          ${planHead}
          ${firstMovesHtml}
          ${gapActionsHtml}
          ${v3Mode ? "" : '<div class="muted hint">No actionable lines yet — fetch more games or try a broader speed filter.</div>'}
        </div>`;

  const heading = oppColor === "white" ? "With White" : "With Black";
  const html = `
    <div class="scout-section" id="scout-section-${oppColor}" data-scout-color="${oppColor}" data-module-b="${PRODUCTION_MODULE_B_ID}">
      <h3 class="visually-hidden">${heading} · <span class="scout-games-count">${trie.gameCount} games</span></h3>
      <section class="color-sec card">
        <div class="scout-section-head cs-head">
          <span class="scout-section-wdl wdl-compact">${scoutWdlHtml(colorWdl.w, colorWdl.d, colorWdl.l, { compact: true })} <small class="scout-n">n=${colorWdl.games}</small></span>
          <span class="scout-section-score faint">${baseline}% overall</span>
          ${trending}
          <span class="spacer"></span>
          <div class="scout-coverage-bar-row cov">
            <div class="scout-coverage-bar hbar">
              <div class="scout-coverage-fill ${covTone}" style="width:${covPct}%"></div>
            </div>
            <span class="scout-coverage-label">${preparedCount}/${totalLines} lines covered</span>
          </div>
          ${prepareAll}
        </div>
        <div class="scout-intel scout-intel-summary-only intel">${intelSummary}</div>
        ${prepPanel}
      </section>
      <div class="scout-intel-charts-strip">${intelCharts}</div>
    </div>
  `;
  return { html, sectionData };
}

export function mergeEnginePatternsIntoSections(sections, engineByColor, { speedFilter = "all" } = {}) {
  for (const color of ["white", "black"]) {
    const section = sections[color];
    const scan = engineByColor?.[color];
    const patterns = engineScanPatterns(scan);
    if (!section || !patterns) continue;
    if (scan?.speedFilter && scan.speedFilter !== speedFilter) continue;
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
    const prep = section.prepTargets || section.weaknessTargets;
    if (prep?.length) {
      lines.push("", "**Your game plan:**");
      for (const t of prep) {
        const their = scoutLineText(t.sans);
        const reply = t.suggestedReply?.uci ? ` → you play ${t.suggestedReply.uci}` : " → needs prep";
        let row = `- When they play ${their}${reply} — ${Math.round(t.share * 100)}% share, ${t.scorePct}% score (n=${t.games})`;
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
  if (rowKind === "weakness" || rowKind === "prep") {
    return sectionData.prepTargets?.[idx] || sectionData.weaknessTargets?.[idx] || null;
  }
  return sectionData.gradedLines?.[idx] || null;
}

export async function handleScoutResultsClick(event, ctx) {
  const { getState, callbacks } = ctx;
  const state = getState();
  if (!state) return;

  if (handleScoutRefutationGapClick(event, { callbacks })) return;

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
      const lines = [
        ...(sectionData.prepTargets || sectionData.weaknessTargets || []),
        ...sectionData.gradedLines.filter((l) => !l.prepared),
      ];
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
    const color = analyzeBtn.dataset.color;
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
    if (!state.sections[color]) return;
    const line = resolveRow(state, rowKind, color, idx);
    if (!line) return;
    openScoutLine(lineEl, line, rowKind, { ...ctx, sideEl: ctx.getSideEl?.() || null });
    ctx.callbacks.revealScoutDetail?.();
  }
}
