// Scout v12 experimental route-audit viewer — pure HTML string renderer (no DOM).

import { isNestedPath } from "./scout-bias-routes.js";
import { CLAIM_LEVEL, fenFromUcis } from "./scout-route-audit.js";

/** Chinese labels for tendency feature ids (viewer copy only). */
export const TENDENCY_LABEL_ZH = {
  developsMinorFromHome: "子力出動",
  isCastle: "王翼易位",
  centralPawnPush: "中心兵推進",
  givesCheck: "將軍",
  kingMoveNonCastle: "王移動(非易位)",
  checkResponseKingMove: "將軍時移王",
  checkResponseCapture: "將軍時吃子",
  isCapture: "吃子",
  capturesPawn: "吃兵",
  quietPawnPush: "安靜推兵",
};

/** Vocabulary that must never appear in rendered viewer HTML. */
export const V12_BANNED_VOCAB = [
  "weakness",
  "exploit",
  "punish",
  "弱點",
  "不擅長",
  "吃虧",
  "打擊",
  "必殺",
];

const TIER_ORDER = ["advantage", "safe", "info"];
const TIER_HEADINGS = {
  advantage: "Advantage",
  safe: "Safe",
  info: "Info",
};
// Group-level copy (once per tier, not repeated on every card).
const TIER_SUBTITLES = {
  advantage: "",
  safe: "不虧、可走的路線;不宣稱優勢",
  info: "他常走進來的路徑情報",
};

function tendencyLabelZh(featureId) {
  return TENDENCY_LABEL_ZH[featureId] || featureId;
}

// Untrusted JSON strings that land inside a class attribute must be reduced to a
// safe CSS token (audit JSON is user-loaded via file/paste).
function classToken(s) {
  return String(s || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function fmtCp(cp) {
  const n = Number(cp);
  if (!Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n}`;
}

function tierBadge(tier) {
  if (!tier) return "";
  const cls = `scout-v12-tier scout-v12-tier-${tier}`;
  return `<span class="${cls}">${tier}</span>`;
}

// Horizontal eval bar centred at 0, clamped to ±100cp. Positive = our side.
function evalBarHtml(cp) {
  const n = Number(cp);
  if (!Number.isFinite(n)) return "";
  const mag = Math.min(Math.abs(n), 100);
  const half = (mag / 100) * 50;
  const side = n >= 0 ? "pos" : "neg";
  const style = n >= 0 ? `left:50%;width:${half}%` : `left:${50 - half}%;width:${half}%`;
  return `<span class="scout-v12-evalbar" title="d18 ${fmtCp(n)}cp" aria-label="d18 ${fmtCp(n)}cp">
    <span class="scout-v12-evalbar-fill scout-v12-evalbar-${side}" style="${style}"></span>
  </span>`;
}

// Stacked W/D/L bar for an actual-response row.
function wdlBarHtml(r) {
  const w = Number(r.wins) || 0;
  const d = Number(r.draws) || 0;
  const l = Number(r.losses) || 0;
  const total = w + d + l;
  if (!total) return "";
  const seg = (n, cls) =>
    n ? `<span class="scout-v12-wdl-seg scout-v12-wdl-${cls}" style="flex:${n}"></span>` : "";
  return `<span class="scout-v12-wdl-bar" title="${w}W/${d}D/${l}L">${seg(w, "w")}${seg(d, "d")}${seg(l, "l")}</span>`;
}

// Thin 0–100% reach bar (share of his games that actually enter this route).
function reachBarHtml(fraction) {
  const f = Number(fraction);
  if (!Number.isFinite(f)) return "";
  const pct = Math.max(0, Math.min(f * 100, 100));
  return `<span class="scout-v12-reachbar" aria-hidden="true">
    <span class="scout-v12-reachbar-fill" style="width:${pct.toFixed(1)}%"></span>
  </span>`;
}

const TIER_PRIORITY = { advantage: 3, safe: 2, info: 1 };

function routePriority(row) {
  return TIER_PRIORITY[row.tier] || 0;
}

/**
 * Drop routes that sit on the same ancestor chain as a better one (parent and
 * grandchild of the same line must not both appear). Better = higher tier,
 * then deeper node (more prep information), then original order.
 */
export function dedupNestedRoutes(rows) {
  const ranked = rows
    .map((row, idx) => ({ row, idx }))
    .sort((a, b) => {
      const byTier = routePriority(b.row) - routePriority(a.row);
      if (byTier) return byTier;
      const byDepth = (b.row.ucis?.length || 0) - (a.row.ucis?.length || 0);
      if (byDepth) return byDepth;
      return a.idx - b.idx;
    });
  const keptPaths = [];
  const keptIdx = new Set();
  for (const { row, idx } of ranked) {
    const path = row.ucis;
    if (Array.isArray(path) && path.length) {
      if (keptPaths.some((p) => isNestedPath(p, path))) continue;
      keptPaths.push(path);
    }
    keptIdx.add(idx);
  }
  return rows.filter((_, idx) => keptIdx.has(idx));
}

function flattenRoutes(auditJson) {
  const rows = [];
  const tendencies = auditJson?.tendencies || [];
  for (let ti = 0; ti < tendencies.length; ti += 1) {
    const t = tendencies[ti];
    const routes = t.routes || [];
    for (let ri = 0; ri < routes.length; ri += 1) {
      rows.push({ ...routes[ri], featureId: t.featureId, _ti: ti, _ri: ri });
    }
  }
  return rows;
}

function renderActualColumn(actual, esc) {
  const responses = actual?.responses || [];
  if (!responses.length) {
    return `<div class="scout-v12-replies scout-v12-replies-actual">
      <div class="scout-v12-col-label">他實戰走過(真實對局)</div>
      <p class="scout-v12-empty muted">無實戰樣本到達此節點</p>
    </div>`;
  }
  const items = responses
    .map(
      (r) =>
        `<li><span class="scout-v12-move">${esc(r.san || "")}</span> `
        + `${wdlBarHtml(r)} `
        + `<span class="scout-v12-wdl">${Number(r.wins) || 0}W/${Number(r.draws) || 0}D/${Number(r.losses) || 0}L</span></li>`,
    )
    .join("");
  return `<div class="scout-v12-replies scout-v12-replies-actual">
    <div class="scout-v12-col-label">他實戰走過(真實對局)</div>
    <ul class="scout-v12-reply-list">${items}</ul>
  </div>`;
}

function renderPolicyColumn(policyResponses, esc) {
  const list = policyResponses || [];
  const items = list.length
    ? list
        .map(
          (r) =>
            `<li><span class="scout-v12-move">${esc(r.san || "")}</span> `
            + `<span class="scout-v12-eval">${fmtCp(r.evalAfterCp)}cp</span></li>`,
        )
        .join("")
    : `<li class="muted">—</li>`;
  return `<div class="scout-v12-replies scout-v12-replies-policy">
    <div class="scout-v12-col-label">模型推估回應(policy audit)</div>
    <div class="scout-v12-col-sub muted">模型排序的主要回應之一 — 非他本人最可能</div>
    <ul class="scout-v12-reply-list">${items}</ul>
  </div>`;
}

// Card = <details>: the summary row carries everything scannable (line, tier, risk,
// tendency, eval + reach bars); columns/board/actions live in the collapsed body.
// Advantage cards open by default; Safe/Info start collapsed (收納).
function renderRouteCard(route, routeKey, { esc, renderMiniBoard, orientation, open }) {
  const reach = route.actualReach || {};
  const nodeEval = route.sfVerify?.nodeEvalCp18;
  const narrow = route.fragility?.narrowPath === true;
  const advCopy =
    route.tier === "advantage"
      ? `<p class="scout-v12-copy">這條線把他的《${esc(tendencyLabelZh(route.featureId))}》傾向帶到我方較舒服的局面</p>`
      : "";
  const reachPct = Number.isFinite(Number(reach.fraction))
    ? `${(Number(reach.fraction) * 100).toFixed(1)}%`
    : "—";
  let boardHtml = "";
  if (typeof renderMiniBoard === "function" && Array.isArray(route.ucis) && route.ucis.length) {
    try {
      boardHtml = `<div class="scout-v12-board">${renderMiniBoard(fenFromUcis(route.ucis), orientation)}</div>`;
    } catch (_) {
      /* unparseable line — skip the board, keep the card */
    }
  }

  return `<details class="scout-v12-card" data-v12-route="${esc(routeKey)}"${open ? " open" : ""}>
    <summary class="scout-v12-card-head">
      <code class="scout-v12-line">${esc(route.sanLine || "")}</code>
      ${tierBadge(route.tier)}
      <span class="scout-v12-risk scout-v12-risk-${classToken(route.riskLevel) || "unknown"}">${esc(route.riskLevel || "—")}</span>
      ${narrow ? `<span class="scout-v12-chip scout-v12-chip-narrow" title="續行路徑窄,容錯低">窄路</span>` : ""}
      <span class="scout-v12-chip muted">${esc(tendencyLabelZh(route.featureId))}</span>
      <span class="scout-v12-summary-stats">
        <span class="scout-v12-evalcell" title="Stockfish d18(我方視角)">d18 ${fmtCp(nodeEval)} ${evalBarHtml(nodeEval)}</span>
        <span class="scout-v12-reachcell" title="他實戰走進此路線的比例 (${Number(reach.passed) || 0}/${Number(reach.total) || 0})">reach ${reachPct} ${reachBarHtml(reach.fraction)}</span>
      </span>
    </summary>
    <div class="scout-v12-card-body">
      ${advCopy}
      <div class="scout-v12-detail-cols">
        ${boardHtml}
        <div class="scout-v12-reply-cols">
          ${renderActualColumn(route.actualPlayerResponses, esc)}
          ${renderPolicyColumn(route.policyResponses, esc)}
        </div>
      </div>
      <div class="scout-v12-actions">
        <button type="button" class="scout-btn btn ghost" data-v12-action="analyze" data-v12-route="${esc(routeKey)}">Analyze ›</button>
        <button type="button" class="scout-btn btn ghost" data-v12-action="build" data-v12-route="${esc(routeKey)}">Add to prep ▾</button>
      </div>
    </div>
  </details>`;
}

function renderTierGroup(tier, routes, auditIdx, ctx) {
  if (!routes.length) return "";
  const heading = TIER_HEADINGS[tier] || tier;
  const sub = TIER_SUBTITLES[tier]
    ? `<span class="scout-v12-tier-sub muted">${TIER_SUBTITLES[tier]}</span>`
    : "";
  const cards = routes
    .map((r) =>
      renderRouteCard(r, `${auditIdx}:${r._ti}:${r._ri}`, { ...ctx, open: tier === "advantage" }),
    )
    .join("");
  return `<section class="scout-v12-tier-group">
    <h4 class="scout-v12-tier-head">${heading} <span class="scout-v12-count">${routes.length}</span> ${sub}</h4>
    ${cards}
  </section>`;
}

function renderEliminated(routes, esc) {
  if (!routes.length) return "";
  const items = routes
    .map(
      (r) =>
        `<li><code>${esc(r.sanLine || "")}</code> `
        + `<span class="muted">${esc((r.reasons || []).join("; "))}</span></li>`,
    )
    .join("");
  return `<details class="scout-v12-eliminated">
    <summary>audit 淘汰 (${routes.length})</summary>
    <ul>${items}</ul>
  </details>`;
}

function renderColorSection(auditJson, auditIdx, esc, renderMiniBoard) {
  const meta = auditJson?.meta || {};
  const rows = flattenRoutes(auditJson);
  const byTier = { advantage: [], safe: [], info: [] };
  const eliminated = [];
  const tiered = [];

  for (const r of rows) {
    if (r.verdict === "fail" || r.tier == null) eliminated.push(r);
    else if (byTier[r.tier]) tiered.push(r);
  }
  // Cross-tendency pass: tendencies are selected independently, so the same line's
  // parent and grandchild can both survive per-tendency selection.
  for (const r of dedupNestedRoutes(tiered)) byTier[r.tier].push(r);

  // Board from OUR side: the subject is the opponent, so flip his color.
  const orientation = meta.subjectColor === "white" ? "black" : "white";
  const ctx = { esc, renderMiniBoard, orientation };
  const tierHtml = TIER_ORDER.map((t) => renderTierGroup(t, byTier[t], auditIdx, ctx)).join("");
  const colorLabel = meta.subjectColor === "white" ? "White" : "Black";
  const chips = TIER_ORDER.filter((t) => byTier[t].length)
    .map((t) => `<span class="scout-v12-chip scout-v12-chip-${t}">${TIER_HEADINGS[t]} ${byTier[t].length}</span>`)
    .join("");

  return `<section class="scout-v12-color" data-subject-color="${esc(meta.subjectColor || "")}">
    <header class="scout-v12-color-head">
      <h3>${colorLabel} prep routes</h3>
      ${chips}
      <span class="muted">games ${Number.isFinite(Number(meta.games)) ? Number(meta.games) : "—"} · d18 ${Number(meta.sfDepth) || 18}</span>
    </header>
    ${tierHtml}
    ${renderEliminated(eliminated, esc)}
  </section>`;
}

/**
 * Render one or more annotated audit JSON blobs (white/black) as HTML.
 * @param {object|object[]} audits — single audit or array
 * @param {{ escapeHtml?: (s: string) => string, renderMiniBoard?: (fen: string, orientation: string) => string }} [opts]
 */
export function renderV12Report(audits, opts = {}) {
  const esc =
    opts.escapeHtml
    || ((s) =>
      String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])));
  const list = Array.isArray(audits) ? audits : [audits];
  const sections = list
    .filter(Boolean)
    .map((a, i) => renderColorSection(a, i, esc, opts.renderMiniBoard))
    .join("");

  return `<div class="scout-v12-report">
    <div class="scout-v12-banner">實驗報告 — 主張等級:${CLAIM_LEVEL}</div>
    ${sections || '<p class="muted">Load annotated audit JSON to view routes.</p>'}
  </div>`;
}

/** File-input shell for the v12 experimental viewer (prep panel). Once a report is
 * loaded the load controls collapse into a summary row (收納) — reopen to load another. */
export function renderV12PanelShell(opts = {}) {
  const esc = opts.escapeHtml || ((s) => String(s));
  const reportHtml = opts.reportHtml || "";
  const hasReport = !!reportHtml.trim();
  return `<div class="scout-v12-panel">
    <div class="scout-v12-panel-head">
      <strong>${esc("Tendency-aligned routes(實驗報告)")}</strong>
      <span class="scout-v12-badge">v12 experimental</span>
    </div>
    <details class="scout-v12-load-wrap"${hasReport ? "" : " open"}>
      <summary class="scout-v12-load-summary">Load audit JSON${hasReport ? " (replace current report)" : ""}</summary>
      <div class="scout-v12-load">
        <label class="scout-v12-file-label">
          Choose file(s)
          <input type="file" id="scout-v12-file" accept=".json,application/json" multiple class="scout-v12-file" />
        </label>
        <textarea id="scout-v12-paste" class="scout-v12-paste" rows="3" placeholder="Or paste annotated audit JSON here…"></textarea>
        <button type="button" class="scout-btn btn ghost" id="scout-v12-load-btn">Load report</button>
      </div>
    </details>
    <div id="scout-v12-report-host">${reportHtml}</div>
  </div>`;
}
