// Scout report rendering + delegated interaction handlers (testable without app.js).

import { Chess } from "chess.js";
import { countOf } from "./plural.js";

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
import { buildScoutSectionSummary, expectationText } from "./scout-summary.js";
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
  // Only a row the user opened survives a rebuild. The default-open first row
  // re-defaults, so it follows the ranking as streamed games reorder it.
  for (const el of expanded) {
    if (el.dataset.lineKey && el.dataset.userOpen === "1") expandedKeys.add(el.dataset.lineKey);
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

export function renderScoutColorTabsHtml(profile, escapeHtml, { hidden = false, username = "" } = {}) {
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
      const you = c === "white" ? "you have Black" : "you have White";
      const selected = i === 0 ? "true" : "false";
      const tabindex = i === 0 ? "" : ' tabindex="-1"';
      const title = `${username || "Opponent"} ${c === "white" ? "with White" : "with Black"}: ${countOf(stats.games, "game")}; in these games ${you}`;
      // The "you have <Colour>" clause lives in `title` only. Inlining it in the
      // always-visible label made each tab ~246px wide, and the nowrap flex row
      // then pushed the whole page to 503px at 390px. Keeping it in the tooltip
      // (and the a11y name) preserves the wording without the overflow.
      return `<button type="button" class="scout-color-tab${i === 0 ? " is-active" : ""}" role="tab" data-scout-tab="${c}" aria-selected="${selected}"${tabindex} aria-controls="scout-section-${c}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"><span class="scout-color-dot ${c}" aria-hidden="true"></span>${escapeHtml(label)} <small>${countOf(stats.games, "game")}</small></button>`;
    })
    .join("");
  return `<div class="scout-color-tabs" role="tablist" aria-label="Colour the opponent plays"${hidden ? ' hidden' : ''}>${buttons}</div>`;
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
    el.dataset.userOpen = "1";
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
    delete el.dataset.userOpen;
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
export function scoutWdlBar(w, d, l, { maiaEstimate = false, counts = true } = {}) {
  const total = w + d + l || 1;
  const pct = (n) => `${(n / total) * 100}%`;
  const title = maiaEstimate
    ? "Maia W/D/L estimate (not from their games)"
    : `W${w} D${d} L${l}`;
  const cls = maiaEstimate ? " scout-maia-estimate" : "";
  // Counts under the bar: a one-game line is a single solid segment, which read
  // as "a white bar" with no meaning until the numbers sat next to it.
  const nums = maiaEstimate || !counts
    ? ""
    : `<span class="scout-wdlbar-nums" aria-hidden="true"><span class="n-w">${w}W</span><span class="n-d">${d}D</span><span class="n-l">${l}L</span></span>`;
  return `<span class="scout-wdlbar-wrap"><span class="scout-wdlbar${cls}" title="${title}" aria-label="${title}">
    <span class="scout-wdlbar-w" style="width:${pct(w)}"></span>
    <span class="scout-wdlbar-d" style="width:${pct(d)}"></span>
    <span class="scout-wdlbar-l" style="width:${pct(l)}"></span>
  </span>${nums}</span>`;
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

// A mini chart with its axes spelled out: the y range on the left, what the
// x axis runs over underneath. Charts without them read as decoration.
function scoutAxisChart(plotHtml, { yTop, yBottom, xStart, xEnd, yTitle }) {
  return `<div class="scout-axis-chart">
      <span class="scout-axis-y" aria-hidden="true"><span>${yTop}</span><span>${yBottom}</span></span>
      <span class="scout-axis-plot">${plotHtml}</span>
      <span class="scout-axis-x" aria-hidden="true"><span>${xStart}</span><span>${xEnd}</span></span>
      ${yTitle ? `<span class="scout-axis-title">${yTitle}</span>` : ""}
    </div>`;
}

// Games per week as columns, oldest week on the left. Weeks without games stay
// as empty slots so gaps in activity are visible.
function scoutWeeklyColumns(buckets, { weeks = 12, bucketDays = 7 } = {}) {
  if (!buckets?.length) return null;
  const bucketMs = bucketDays * 86400000;
  // A non-finite datestamp collapses every bucket onto one NaN key, which left
  // slots empty and made slots[0] below throw. Skip them.
  const byKey = new Map(
    buckets
      .filter((b) => Number.isFinite(b.datestamp))
      .map((b) => [Math.floor(b.datestamp / bucketMs), b.count]),
  );
  if (!byKey.size) return null;
  const endKey = Math.max(...byKey.keys());
  const slots = [];
  for (let key = endKey - weeks + 1; key <= endKey; key += 1) {
    slots.push({ datestamp: key * bucketMs, count: byKey.get(key) || 0 });
  }
  const max = Math.max(1, ...slots.map((s) => s.count));
  const cols = slots
    .map((s) => {
      const h = s.count ? Math.max(6, Math.round((s.count / max) * 100)) : 0;
      return `<i style="height:${h}%" title="${s.count} game${s.count === 1 ? "" : "s"} · week of ${formatShortDate(s.datestamp)}"></i>`;
    })
    .join("");
  return {
    html: `<span class="scout-columns">${cols}</span>`,
    max,
    start: slots[0].datestamp,
    end: slots[slots.length - 1].datestamp,
  };
}

function formatShortDate(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en", { month: "short", day: "numeric" });
}

export function scoutSvgBar(
  items,
  {
    valueKey = "scorePct",
    labelKey = "san",
    maxValue = 100,
    valueSuffix = "%",
    escapeHtml,
    // Colour by what the value means for YOU: "low-good" (their score: low is
    // good news) or "high-good" (their error rate: high is good news).
    tone = "low-good",
    // Optional reference line (e.g. their overall score) drawn on every track.
    reference = null,
    countKey = null,
  } = {},
) {
  if (!items?.length) {
    return `<div class="scout-bar-chart scout-bar-empty muted hint">No family data yet.</div>`;
  }
  const scale = maxValue > 0 ? maxValue : 100;
  const refPct = reference != null ? Math.max(0, Math.min(100, (reference / scale) * 100)) : null;
  const rows = items.slice(0, 6).map((item) => {
    const val = item[valueKey] ?? 0;
    const pct = Math.max(2, Math.round((val / scale) * 100));
    const high = valueSuffix === "%" ? val >= 55 : val >= scale * 0.55;
    const low = valueSuffix === "%" ? val <= 40 : val <= scale * 0.25;
    const good = tone === "high-good" ? high : low;
    const bad = tone === "high-good" ? low : high;
    const toneCls = good ? " is-good" : bad ? " is-bad" : "";
    const label = escapeHtml ? escapeHtml(String(item[labelKey] || "?")) : String(item[labelKey] || "?");
    const count = countKey && item[countKey] != null ? `<span class="scout-bar-n">${item[countKey]}</span>` : "";
    const ref = refPct != null ? `<span class="scout-bar-ref" style="left:${refPct}%"></span>` : "";
    return `<div class="scout-bar-row${toneCls}${count ? " has-n" : ""}">
      <span class="scout-bar-label">${label}</span>
      <span class="scout-bar-track"><span class="scout-bar-fill" style="width:${pct}%"></span>${ref}</span>
      <span class="scout-bar-val">${val}${valueSuffix}</span>${count}
    </div>`;
  }).join("");
  return `<div class="scout-bar-chart">${rows}</div>`;
}

export function renderScoutEnginePanel(engineAgg, escapeHtml) {
  if (!engineAgg) {
    return `<div class="scout-engine-panel muted hint">Not scanned yet.</div>`;
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
    tone: "high-good",
    // The ACPL is the most sample-sensitive number on the card (it averages over
    // opponent plies, not games), so it must carry its n. Engine families expose
    // `analyzedGames`, not `games` — see scout-engine.js.
    countKey: "analyzedGames",
  });
  const worst = families[0];
  const scopeNote =
    engineAgg.scopeLimited && engineAgg.maxGames
      ? ` — based on latest ${engineAgg.maxGames} games`
      : "";
  const summary = worst
    ? `<div class="scout-engine-summary muted hint">Most mistakes after 1.${escapeHtml(worst.san)}: ${worst.acpl} cp lost per move${worst.firstInaccuracyPly != null ? `, first slip around move ${Math.floor(worst.firstInaccuracyPly / 2) + 1}` : ""}${escapeHtml(scopeNote)}</div>`
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
      engineEv?.analyzedGames != null ? ` over ${countOf(engineEv.analyzedGames, "game")}` : "";
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
        `<button type="button" class="scout-btn btn sm scout-refutation-gap-btn" data-refutation-gap="${escapeHtml(action.id)}" data-testid="${escapeHtml(action.testId)}" aria-label="${escapeHtml(action.ariaLabel)}">${escapeHtml(action.label)}</button>`,
    )
    .join("");
  return `<div class="scout-refutation-gap-actions" role="group" aria-label="Refutation preparation actions" title="Engine refutations for these lines need a Stockfish pass">${buttons}</div>`;
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
    recurrence != null ? `In ${countOf(recurrence, "game")} here they played …${escapeHtml(theirMove)}` : `They played …${escapeHtml(theirMove)}`;
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
      .map((f) => `1.${f.san} ${f.scorePct}% over ${countOf(f.games, "game")}`)
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
    parts.push(
      `Repertoire breadth: ${breadth.breadth} first move${breadth.breadth === 1 ? "" : "s"} with at least ${breadth.minGames} game${breadth.minGames === 1 ? "" : "s"}.`,
    );
  }

  const fresh = stats.repertoireFreshness;
  if (fresh?.freshFamilies?.length) {
    const names = fresh.freshFamilies
      .slice(0, 3)
      .map((f) => `${f.label || `1.${f.san}`} (${f.recentGames})`)
      .join(", ");
    parts.push(`Fresh families in the last ${fresh.recentWindow} games: ${names}.`);
  }

  const persona = stats.personaTags;
  if (persona?.systemSetup?.detected && persona.systemSetup.label) {
    parts.push(`Persona system: ${persona.systemSetup.name || persona.systemSetup.label}.`);
  } else if (persona?.games) {
    parts.push(
      `Persona: ${AGGRESSION_WORD[persona.aggression.label] || persona.aggression.label}, ${CASTLING_WORD[persona.castling.label] || persona.castling.label}, ${TRADE_WORD[persona.tradeSpeed.label] || persona.tradeSpeed.label}.`,
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
      readChip(
        `How often they choose it (${dev.games} games) vs how often masters do in the same position`,
        "More than the book",
        `${escapeHtml(dev.label)} ${dev.opponentSharePct}% vs masters ${dev.mastersSharePct}%`,
      ),
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

const AGGRESSION_WORD = { aggressive: "attacking", passive: "quiet", balanced: "balanced" };
const CASTLING_WORD = {
  uncastled: "often uncastled",
  late: "castles late",
  kingside: "castles short",
  queenside: "castles long",
};
const TRADE_WORD = { simplifier: "trades queens early", complicator: "keeps queens on", balanced: "trades queens midgame" };

// Read chips: each one answers a prep question on its own, with the numbers
// that back it. (Replaced: "Favourite first move" / "Top 3 lines" / "First moves
// used", which restated the first-move bars below them, and with Black described
// the OTHER player's first move.)
function renderScoutRepertoireReads(stats, escapeHtml) {
  const chips = [];
  const black = stats?.oppColor === "black";
  const expect = expectationText(stats?.firstChoices);
  if (expect) {
    chips.push(
      readChip(
        black ? "Their usual reply to each first move they face" : "Their first move, most common first",
        black ? "Their replies" : "Expect",
        escapeHtml(expect),
      ),
    );
  }
  const main = stats?.openingBranches?.mainPath;
  if (main && main.plies >= 2) {
    chips.push(
      readChip(
        "The route most of their games follow, as far as at least 1 in 10 of their games still share it",
        "Predictable until",
        `${escapeHtml(main.label)} · ${Math.round(main.share * 100)}% of games`,
      ),
    );
  }
  const fresh = stats?.repertoireFreshness;
  if (fresh?.freshFamilies?.length) {
    const top = fresh.freshFamilies[0];
    const recent = Math.min(fresh.recentWindow || 0, fresh.games || 0);
    chips.push(
      readChip(
        `Common in their last ${recent} games, almost never in the ${fresh.previousWindow} before`,
        "New lately",
        `${escapeHtml(top.label || `1.${top.san}`)} · ${top.recentGames} of ${recent}`,
      ),
    );
  }
  const shift = stats?.repertoireChangeTrend;
  if (shift?.points?.length >= 2 && shift.trend !== "flat") {
    // Only worth a chip when it moved; "stable" is the default expectation.
    const label = shift.trend === "up" ? "narrowing to fewer openings" : "trying new openings";
    chips.push(readChip("How varied their first choice is, older games vs newer", "Opening mix", label));
  }
  const persona = stats?.personaTags;
  if (persona?.systemSetup?.detected && persona.systemSetup.label) {
    chips.push(
      readChip(
        "A setup they reach regardless of your moves",
        "System",
        escapeHtml(persona.systemSetup.name || persona.systemSetup.label),
      ),
    );
  } else if (persona?.games >= 5) {
    const parts = [
      AGGRESSION_WORD[persona.aggression?.label] || persona.aggression?.label,
      CASTLING_WORD[persona.castling?.label] || persona.castling?.label,
      TRADE_WORD[persona.tradeSpeed?.label] || persona.tradeSpeed?.label,
    ].filter(Boolean);
    chips.push(readChip("Opening style tendencies", "Style", escapeHtml(parts.join(" · "))));
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
  // Supporting notes ride on the headline's tooltip, not as a standing list.
  const notes = (summary?.notes || (summary?.bullets || []).slice(1)).filter(Boolean).join("\n");
  const headline = summary?.headline ? escapeHtml(summary.headline) : "";
  const repertoireReads = renderScoutRepertoireReads(stats, escapeHtml);
  const explorerReadsHtml = renderScoutExplorerReads(explorerReads, escapeHtml);
  return `
      <p class="scout-intel-headline headline"${notes ? ` title="${escapeHtml(notes)}"` : ""}>${headline}</p>
      ${repertoireReads}
      ${explorerReadsHtml}`;
}

export function renderScoutIntelChartsStrip(
  stats,
  escapeHtml,
  { engineAgg = null, explorerReads = null, refutations = null, username = "", baseline = null } = {},
) {
  const who = escapeHtml(username || "Opponent");
  const families = stats?.scoreByFamily?.families?.slice(0, 6) || [];
  const scoreBars = scoutSvgBar(families, {
    escapeHtml,
    valueKey: "scorePct",
    reference: baseline,
    countKey: "games",
  });
  const repPoints = stats?.repertoireChangeTrend?.points || [];
  const repChart = repPoints.length >= 2
    ? scoutAxisChart(
      scoutSparkline(repPoints, { min: 0, max: 100, className: "scout-repchange-spark" }),
      { yTop: "100%", yBottom: "0%", xStart: "older games", xEnd: "newer" },
    )
    : '<div class="muted hint">Needs more dated games.</div>';
  const weekly = scoutWeeklyColumns(stats?.activitySeries?.buckets || [], {
    bucketDays: stats?.activitySeries?.bucketDays || 7,
  });
  const activityChart = weekly
    ? scoutAxisChart(weekly.html, {
      yTop: `${weekly.max}`,
      yBottom: "0",
      xStart: formatShortDate(weekly.start),
      xEnd: formatShortDate(weekly.end),
    })
    : '<div class="muted hint">No dated games.</div>';
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

  // With Black the first move is the other player's, so the same bars answer
  // "which first move should I play against them".
  const byFirstTitle =
    stats?.oppColor === "black"
      ? `${who}'s score against each first move`
      : `${who}'s score by first move`;
  return `
      ${a11yBlock}
      <div class="scout-intel-charts charts">
        <div class="scout-intel-panel card chart">
          <h3 class="scout-col-label"${baseline != null ? ` title="Their average ${baseline}%"` : ""}>${byFirstTitle}</h3>
          ${scoreBars}
        </div>
        <div class="scout-intel-panel card chart">
          <h3 class="scout-col-label scout-engine-label">Where ${who} makes mistakes</h3>
          ${enginePanel}
        </div>
        <div class="scout-intel-panel scout-intel-trends card chart">
          <h3 class="scout-col-label">Activity and habits</h3>
          <p class="scout-chart-title">Games per week</p>
          ${activityChart}
          <p class="scout-chart-title">First-move repetition</p>
          ${repChart}
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

// Stacked score cell: the opponent's score% on top, the sample size below, plus
// (for game-plan rows) their usual score to compare against. Fixed width, no wrap.
export function scoutScoreCell(scorePct, games, { baseline, showGap = false, maiaEstimate = false, showN = true } = {}) {
  const gap =
    showGap && baseline != null && baseline > scorePct
      ? `<span class="scout-gap" title="They usually score ${baseline}%">usually ${baseline}%</span>`
      : "";
  const estTitle = maiaEstimate ? ' title="Maia strength estimate"' : "";
  const estCls = maiaEstimate ? " scout-maia-estimate" : "";
  const n = games === 1 ? "1 game" : `${games} games`;
  return `<span class="scout-score-cell${estCls}"${estTitle}>
      <span class="scout-score-pct">${scorePct}%</span>
      ${showN ? `<span class="scout-n">${n}</span>` : ''}${gap}
    </span>`;
}

/** Patch score/WDL cells on a rendered game-plan row after Maia results arrive. */
export { scoutLineWdlCounts };

export function patchScoutLineMaiaCells(rowEl, line, baseline) {
  if (!rowEl || line?.maiaScorePct == null || !line?.maiaWdl) return;
  const scoreEl = rowEl.querySelector(".scout-lr-score");
  const wdlEl = rowEl.querySelector(".scout-lr-wdl");
  if (scoreEl) {
    scoreEl.innerHTML = scoutScoreCell(line.maiaScorePct, line.routeSupportGames ?? line.games, {
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

export function renderMiniBoardHtml(fen, orientation, { parseFenBoard, pieceSvg }, lastUci = null) {
  const pieces = parseFenBoard(fen);
  // Rows abbreviate long lines; marking the final move ties the board to the line's end.
  const last = lastUci ? new Set([lastUci.slice(0, 2), lastUci.slice(2, 4)]) : null;
  const ranks = orientation === "black" ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const files = orientation === "black" ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const labels = ["a", "b", "c", "d", "e", "f", "g", "h"];
  let html = '<div class="scout-miniboard" aria-hidden="true">';
  for (const rank of ranks) {
    for (const fi of files) {
      const sq = `${labels[fi]}${rank}`;
      const dark = (rank + fi) % 2 === 1;
      const p = pieces[sq];
      html += `<div class="scout-minisquare ${dark ? "dark" : "light"}${last?.has(sq) ? " last" : ""}">${p ? pieceSvg(p) : ""}</div>`;
    }
  }
  return `${html}</div>`;
}

// Games in the rendered report. The live fetch total lives in the toolbar
// counter ("N games fetched"); the report label only changes when the report does.
export function scoutAnalyzedLabel(analyzed) {
  const a = Number(analyzed) || 0;
  return `${a} game${a === 1 ? "" : "s"} analyzed`;
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
        <span class="scout-profile-games faint">${scoutAnalyzedLabel(profile.total)}</span>
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
    parts.push(`they score ${Math.max(0, baseline - line.belowBaseline)}% here, usually ${baseline}%`);
  } else if (line?.prepCategory === "attack") {
    parts.push("they score below their usual result");
  } else if (line?.prepCategory === "weapon") {
    parts.push("a frequent line they score well on");
  }
  const support = line?.routeSupportGames ?? line?.games ?? 0;
  if (support === 1) parts.push("thin sample (1 game)");
  else if (support > 1) parts.push(`seen in ${support} games`);
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
      ? `<p class="scout-engine-note note eng" title="Recurring mistake from deep scan">Often errs: …${escapeHtml(line.enginePattern.playedSan)} (−${(line.enginePattern.avgCpLoss / 100).toFixed(1)}) in ${countOf(line.enginePattern.occurrences, "game")}</p>`
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
      <div class="scout-miniboard-wrap focus-board">${renderBoard(fen, viewColor, line.ucis?.at(-1) || null)}</div>
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

// Rows for a move-distribution node, using REAL game counts for the share. The
// trie's `count` is recency-weighted (it ranks lines), so a single recent game
// could otherwise read as "100%" next to a 49% favourite.
export function scoutDisplayDistribution(node, moveDistribution, { limit = 4 } = {}) {
  if (!node) return [];
  const total = node.gameCount || 0;
  return moveDistribution(node)
    .map((m) => ({ ...m, share: total ? (m.gameCount || 0) / total : m.share }))
    .sort((a, b) => (b.gameCount || 0) - (a.gameCount || 0))
    .slice(0, limit);
}

// First-move distribution row: move, frequency bar + share, score.
export function scoutDistRowHtml(m, escapeHtml, { clickable = true } = {}) {
  const heat = m.scorePct >= 55 ? " is-hot" : m.scorePct <= 45 ? " is-cold" : "";
  const clickAttrs = clickable && m.uci
    ? ` data-first-uci="${escapeHtml(m.uci)}" role="button" tabindex="0" title="Show the replies to ${escapeHtml(m.san)}"`
    : "";
  const games = m.gameCount ?? m.count;
  return `
      <div class="scout-dist-row fm${heat}"${clickAttrs}>
        <b class="scout-dist-san">${escapeHtml(m.san)}</b>
        <span class="scout-dist-bar share"><i style="width:${Math.round(m.share * 100)}%"></i></span>
        <span class="scout-dist-share" title="${games} game${games === 1 ? "" : "s"}">${formatSharePct(m.share)}</span>
        <span class="scout-dist-score sc" title="Their score in these games · ${games} game${games === 1 ? "" : "s"}"><small>scores</small>${m.scorePct}%</span>
      </div>`;
}

// Rows used to print the whole game (19 moves of monospace). Show up to the
// move where it leaves your prep (the deviation point; at least 4 moves, at
// most 12), or the first 8 moves when there is no prep to compare. The full
// line is the tooltip and the expanded detail's title. A row that names YOUR
// reply keeps its whole line: the reply answers the final position.
export const SCOUT_ROW_DEFAULT_PLIES = 16;
export const SCOUT_ROW_MIN_PLIES = 8;
export const SCOUT_ROW_MAX_PLIES = 24;
export function scoutRowPlyLimit(line) {
  const total = line?.sans?.length || 0;
  if (line?.suggestedReply?.uci) return total;
  const hasDeviation = !line?.prepared && Number.isFinite(line?.covered) && line.covered >= 0;
  const limit = hasDeviation
    ? Math.min(SCOUT_ROW_MAX_PLIES, Math.max(SCOUT_ROW_MIN_PLIES, line.covered + 1))
    : SCOUT_ROW_DEFAULT_PLIES;
  return Math.min(total, limit);
}

function scoutPrepFramingHtml(line, escapeHtml) {
  // The line holds BOTH sides' moves, so it is "after", not "when they play".
  const fullLine = scoutLineText(line.sans);
  const shown = scoutRowPlyLimit(line);
  const hidden = (line.sans?.length || 0) - shown;
  const theirLine = hidden > 0 ? `${scoutLineText(line.sans.slice(0, shown))} …` : fullLine;
  const more = hidden > 0
    ? ` <span class="scout-line-more faint">+${Math.ceil(hidden / 2)} more move${Math.ceil(hidden / 2) === 1 ? "" : "s"}</span>`
    : "";
  const reply = line.suggestedReply;
  const when = `<span class="when" title="${escapeHtml(fullLine)}">After <b class="scout-prep-them">${escapeHtml(theirLine)}</b>${more}</span>`;
  if (reply?.uci) {
    const replyLabel = escapeHtml(formatReplyLabel(reply));
    return `<span class="scout-prep-framing">${when}<span class="then"><span class="scout-prep-arrow">→</span> your move: <b class="scout-prep-you">${replyLabel}</b></span></span>`;
  }
  if (line.needsPrep) {
    return `<span class="scout-prep-framing">${when}<span class="then needs"><span class="scout-prep-arrow">→</span> <span class="scout-prep-needs">no answer in your prep</span></span></span>`;
  }
  return `<span title="${escapeHtml(fullLine)}">${escapeHtml(theirLine)}</span>`;
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
    return '<span class="scout-prep-chip scout-prep-chip-attack cat c-attack" title="They score below their usual result here">weak spot</span>';
  }
  if (line.prepCategory === "weapon") {
    return '<span class="scout-prep-chip scout-prep-chip-weapon cat c-main" title="A line they play often and score well in: have an answer ready">main line</span>';
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
  const rawCount = line.routeSupportGames ?? line.gameCount ?? line.games ?? Math.round(line.count ?? 0);
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
  const displayScore = maiaEstimate ? line.maiaScorePct : (line.routeScorePct ?? line.scorePct);
  const wdl = scoutLineWdlCounts(line);
  if (weakness) {
    // Game-plan rows: no ×N count or share% — on n=1 deep lines these are always
    // trivially 1 and <1%, so they add visual noise without information. One game
    // reads as its result ("Lost"), not as 0% over a one-segment bar; larger samples
    // show score + n with a label-free W/D/L bar (counts in its tooltip).
    const oneGame = !maiaEstimate && rawCount === 1;
    const scoreHtml = oneGame
      ? `<span class="scout-score-cell scout-one-game" title="Their result in the only game">${wdl.w ? "Won" : wdl.l ? "Lost" : "Drew"}</span>`
      : scoutScoreCell(displayScore, rawCount, { baseline, showGap: line.belowBaseline > 0, maiaEstimate, showN: rawCount > 1 });
    const wdlHtml = oneGame ? "" : scoutWdlBar(wdl.w, wdl.d, wdl.l, { maiaEstimate, counts: false });
    return `
      <div class="scout-line scout-line-row line-row ${status.cls} scout-weakness-row scout-ranked-row" data-line-key="${escapeHtml(lineKey)}" data-row-kind="${rowKind}" data-row-idx="${i}" data-color="${oppColor}" role="button" tabindex="0" aria-expanded="false"${rowTitle}>
        <div class="scout-lr-main lr-main">
          <span class="scout-line-eco"></span>
          <span class="scout-line-moves">${framing}</span>
          ${refCard}
        </div>
        <span class="lr-meta">${categoryBadge}${lastSeenBadge}</span>
        <span class="scout-lr-score lr-score">${scoreHtml}</span>
        <span class="scout-lr-wdl lr-wdl">${wdlHtml}</span>
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

// How many of their games your repertoires follow move for move through the
// first PREPARED_PLIES plies (or the whole game, if shorter). Best repertoire
// per game.
export function scoutGameCoverage(games, oppColor, myLookups, scoutModule, { speedFilter = "all" } = {}) {
  const depth = scoutModule.PREPARED_PLIES || 8;
  if (typeof scoutModule.lineCoverage !== "function") return { games: 0, followed: 0 };
  let total = 0;
  let followed = 0;
  for (const game of games || []) {
    if (game.color !== oppColor || !game.ucis?.length) continue;
    if (speedFilter !== "all" && game.speed !== speedFilter) continue;
    total += 1;
    const need = Math.min(depth, game.ucis.length);
    const path = game.ucis.slice(0, need);
    for (const { lookup } of myLookups || []) {
      if (scoutModule.lineCoverage(lookup, path).covered >= need) {
        followed += 1;
        break;
      }
    }
  }
  return { games: total, followed };
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
    username,
    baseline,
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

  // Coverage over their actual games, not over a handful of summary lines ("0 of
  // 2 lines" said little): the share of games whose opening your repertoire
  // follows move for move to move 4 (or to the end of a shorter game).
  const coverage = scoutGameCoverage(games, oppColor, myLookups, scoutModule, { speedFilter });
  const covPct = coverage.games ? Math.round((coverage.followed / coverage.games) * 100) : 0;
  const covTone = scoutCoverageTone(coverage.followed, coverage.games);
  const coverageLabel = myLookups.length
    ? `your prep follows ${covPct}% of their games to move ${Math.ceil((scoutModule.PREPARED_PLIES || 8) / 2)}`
    : `no ${oppColor === "white" ? "Black" : "White"} repertoire to compare`;
  const prepareAll = `<button type="button" class="btn sm primary scout-prepare-all" data-color="${oppColor}">Add all gaps ▾</button>`;

  const trending = profile.recentlyChanged[oppColor]
    ? '<span class="scout-trending kchip k-due" title="Their recent games show a different opening">⚡ Recently changed</span>'
    : "";

  const firstMoves = scoutDisplayDistribution(trie, scoutModule.moveDistribution)
    .map((m) => scoutDistRowHtml(m, escapeHtml))
    .join("");
  const refutationGaps = collectActionableRefutationGapActions(refutations);
  const gapActionsHtml = refutationGaps.length
    ? renderScoutRefutationGapActions(refutationGaps, escapeHtml)
    : "";

  const prepRows = prepTargets
    .map((t, i) => scoutWeaknessRowHtml(t, i, oppColor, baseline, escapeHtml))
    .join("");
  const rankedNote = scoutMaiaRankedNote(prepTargets, maiaEnrichState, {
    prefilterState: prefilterEnrichState,
  });
  const who = escapeHtml(username || "Opponent");
  const yourSide = oppColor === "white" ? "Black" : "White";
  const planHead = `<div class="scout-game-plan-head plan-head">
            <b class="scout-col-label">Your game plan as ${yourSide}</b>
          </div>`;
  const firstMovesHtml = `<div class="scout-first-moves">
            <span class="scout-sub-label">${who}'s first moves</span>
            <div class="scout-dist scout-dist-compact first-moves" data-dist-root="true">${firstMoves}</div>
          </div>`;
  const listHead = `<div class="scout-lines-head" aria-hidden="true"><span>Line (both sides' moves)</span><span>Type · last seen</span><span>Their result</span><span></span><span></span></div>`;
  const prepPanel = prepRows
    ? `<div class="scout-game-plan plan">
          ${planHead}
          ${firstMovesHtml}
          ${gapActionsHtml}
          ${listHead}
          <div class="scout-lines scout-ranked-list lines" role="list">${prepRows}</div>
          ${rankedNote}
        </div>`
    : `<div class="scout-game-plan plan">
          ${planHead}
          ${firstMovesHtml}
          ${gapActionsHtml}
          <div class="muted hint">No reachable weak spots in these games</div>
        </div>`;

  const heading = oppColor === "white" ? "With White" : "With Black";
  const html = `
    <div class="scout-section" id="scout-section-${oppColor}" data-scout-color="${oppColor}" data-module-b="${PRODUCTION_MODULE_B_ID}">
      <h3 class="visually-hidden">${heading} · <span class="scout-games-count">${countOf(trie.gameCount, "game")}</span></h3>
      <section class="color-sec card">
        <div class="scout-section-head cs-head">
          <span class="scout-section-who">${who} with ${oppColor === "white" ? "White" : "Black"}</span>
          <span class="scout-section-wdl wdl-compact" title="${escapeHtml(countOf(colorWdl.games, "game"))}">${scoutWdlHtml(colorWdl.w, colorWdl.d, colorWdl.l, { compact: true })}</span>
          <span class="scout-section-score faint" title="Wins plus half the draws">scores ${baseline}%</span>
          ${trending}
          <span class="spacer"></span>
          <div class="scout-coverage-bar-row cov"${coverage.games ? "" : " hidden"}>
            ${myLookups.length ? `<div class="scout-coverage-bar hbar">
              <div class="scout-coverage-fill ${covTone}" style="width:${covPct}%"></div>
            </div>` : ""}
            <span class="scout-coverage-label" title="${coverage.followed} of ${coverage.games} games: your repertoire has every move of the game up to move ${Math.ceil((scoutModule.PREPARED_PLIES || 8) / 2)}">${coverageLabel}</span>
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
  const lines = [`# Scout: ${username}`, "", `${countOf(profile.total, "game")} · filter: ${activeSpeed}`, ""];
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
        const reply = t.suggestedReply?.uci ? ` → your move ${t.suggestedReply.uci}` : t.needsPrep ? " → no answer in your prep" : "";
        let row = `- After ${their}${reply} — ${Math.round(t.share * 100)}% of their games, they score ${t.scorePct}% (${t.games} game${t.games === 1 ? "" : "s"})`;
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
    lineEl.dataset.userOpen = "1";
    ctx.callbacks.revealScoutDetail?.();
  }
}
