// Scout v13 — prep-package panel renderer (design §8).

import { Chess } from "chess.js";

import { fenFromUcis } from "./scout-route-audit.js";
import { V12_BANNED_VOCAB } from "./scout-v12-report.js";
import { PACKAGE_STYLES, PERSONAL_SUBJECT_PHRASES } from "./scout-v13-package.js";

const STYLE_LABELS = {
  solid: "穩健",
  sharp: "尖銳",
  rare: "冷門",
  forcing: "強迫",
};

const RISK_LABELS = {
  ThinSample: "樣本偏少",
  CohortOnly: "僅分段資料",
  Narrow: "窄路線",
  HighVariance: "高變異",
  LowTheory: "理論偏少",
  Transposes: "可轉入",
};

const SOURCE_LABELS = {
  personal: "個人",
  cohort: "同分段",
  engine: "引擎",
};

function classToken(s) {
  return String(s || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function fmtCp(cp) {
  const n = Number(cp);
  if (!Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n}`;
}

function fmtPct(fraction) {
  const n = Number(fraction);
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function entrySanSequence(entryUcis, trunkUcis, esc) {
  if (!entryUcis?.length) return esc("—");
  try {
    const chess = new Chess();
    const sans = [];
    for (const uci of trunkUcis || []) {
      const m = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4] || undefined,
      });
      if (!m) break;
      sans.push(m.san);
      if (sans.length >= entryUcis.length) break;
    }
    return esc(sans.join(" "));
  } catch {
    return esc((entryUcis || []).join(" "));
  }
}

function edgeSan(edge) {
  return edge.san || edge.uci || "?";
}

function sourceChip(source, esc) {
  const cls = classToken(source);
  const label = SOURCE_LABELS[source] || source;
  return `<span class="scout-v13-src scout-v13-src-${cls}">${esc(label)}</span>`;
}

function cohortCopy(edge, esc) {
  const r = edge.receipts || {};
  const band = esc(String(r.ratingBand || "—"));
  const speed = esc(String(r.speed || "—"));
  const games = Number(r.explorerGames) || 0;
  return esc(`同分段對局中常見回應(${band} ${speed}, ${games} 局)`);
}

function engineCopy(edge, esc) {
  const evalCp = fmtCp(edge.receipts?.evalCp);
  if (edge.receipts?.gapToBestCp != null && Number.isFinite(edge.receipts.gapToBestCp)) {
    return esc(`引擎建議(${evalCp}cp, gap ${fmtCp(edge.receipts.gapToBestCp)})`);
  }
  return esc(`引擎建議(${evalCp}cp)`);
}

function personalCopy(edge, esc) {
  const games = Number(edge.receipts?.games) || 0;
  return esc(`他的對局中此路徑出現 ${games} 次`);
}

function edgeNote(edge, esc) {
  if (edge.evidenceSource === "cohort") return cohortCopy(edge, esc);
  if (edge.evidenceSource === "engine") {
    const gap = edge.receipts?.gapToBestCp;
    if (gap != null && Number(edge.receipts?.evalCp) >= 0) return esc("引擎戰術回應");
    return engineCopy(edge, esc);
  }
  return personalCopy(edge, esc);
}

function wdlReceipt(edge, esc) {
  const r = edge.receipts || {};
  const w = Number(r.wins) || 0;
  const d = Number(r.draws) || 0;
  const l = Number(r.losses) || 0;
  const games = Number(r.games) || w + d + l;
  if (!games) return "";
  return `<span class="scout-v13-wdl">${esc(`${w}W/${d}D/${l}L`)} <span class="scout-v13-games">n=${Number(games)}</span></span>`;
}

function renderExtensionEdge(edge, esc, faded = false) {
  const fadedCls = faded ? " scout-v13-edge-faded" : "";
  const evalNote =
    edge.evidenceSource === "engine" && edge.receipts?.evalCp != null
      ? `<span class="scout-v13-eval-check">${esc(fmtCp(edge.receipts.evalCp))}cp</span>`
      : "";
  return `<div class="scout-v13-edge scout-v13-edge-ext${fadedCls}">
    ${sourceChip(edge.evidenceSource, esc)}
    <span class="scout-v13-san">${esc(edgeSan(edge))}</span>
    ${evalNote}
    <span class="scout-v13-edge-note">${edgeNote(edge, esc)}</span>
  </div>`;
}

function renderTrunkEdge(edge, esc) {
  return `<div class="scout-v13-edge scout-v13-edge-trunk">
    <span class="scout-v13-san">${esc(edgeSan(edge))}</span>
    ${wdlReceipt(edge, esc)}
  </div>`;
}

function renderPackageCard(pkg, esc, renderMiniBoard) {
  const style = pkg.primaryStyle;
  const styleCls = style ? classToken(`scout-v13-style-${style}`) : "scout-v13-style-none";
  const styleLabel = style ? STYLE_LABELS[style] || style : "—";
  const entrySans = entrySanSequence(pkg.entryUcis, pkg.trunkUcis, esc);
  const reachPct = fmtPct(pkg.trunk?.reachLB);
  const anchorPly = Number(pkg.trunk?.personalAnchorPly) || 0;

  const riskChips = (pkg.riskTags || [])
    .map((tag) => {
      const cls = classToken(`scout-v13-risk-${tag}`);
      const label = RISK_LABELS[tag] || tag;
      return `<span class="scout-v13-risk scout-v13-risk-${cls}">${esc(label)}</span>`;
    })
    .join("");

  const trunkHtml = (pkg.trunk?.edges || []).map((e) => renderTrunkEdge(e, esc)).join("");

  const mainlineHtml = (pkg.extension?.mainline || [])
    .map((e) => renderExtensionEdge(e, esc, false))
    .join("");

  const branchHtml = (pkg.extension?.branches || [])
    .map((branch, bi) => {
      const edges = Array.isArray(branch) ? branch : branch.edges || [];
      return `<div class="scout-v13-branch" data-branch="${bi}">
        ${edges.map((e) => renderExtensionEdge(e, esc, true)).join("")}
      </div>`;
    })
    .join("");

  const hisReachLines = (pkg.trunk?.edges || [])
    .filter((e) => e.evidenceSource === "personal")
    .map((e) => {
      const games = Number(e.receipts?.games) || 0;
      return esc(`他的對局中此路徑出現 ${games} 次`);
    });

  let boardHtml = "";
  if (renderMiniBoard && pkg.trunkUcis?.length) {
    const fen = fenFromUcis(pkg.trunkUcis);
    const orientation = pkg.subjectColor === "white" ? "black" : "white";
    boardHtml = `<div class="scout-v13-board">${renderMiniBoard(fen, orientation)}</div>`;
  }

  const leafCount = pkg.extension?.leafCount ?? pkg.auditedLeaves?.length ?? "—";
  const sfDepth = Number(pkg.receipts?.sfDepth) || "—";

  return `<article class="scout-v13-card" data-package-id="${esc(pkg.id)}">
    <header class="scout-v13-card-head">
      <div class="scout-v13-card-title">
        <span class="scout-v13-entry">${entrySans}</span>
        <span class="scout-v13-style ${styleCls}">${esc(styleLabel)}</span>
        ${riskChips}
      </div>
      ${boardHtml}
    </header>
    <section class="scout-v13-why">
      <h4>${esc("為什麼從這裡進")}</h4>
      <p>${hisReachLines.join(" · ") || esc("個人樣本收據")} · reach LB ${esc(reachPct)}</p>
    </section>
    <section class="scout-v13-trunk">
      ${trunkHtml}
    </section>
    <div class="scout-v13-anchor-divider">─── ${esc(`個人樣本止於此(ply ${anchorPly})`)} ───</div>
    <section class="scout-v13-extension">
      ${mainlineHtml}
      ${branchHtml}
    </section>
    <footer class="scout-v13-receipts">
      <span>${esc(`explorer ${pkg.receipts?.ratingBand || "—"} / ${pkg.receipts?.speed || "—"}`)}</span>
      <span>${esc(`SF d${sfDepth} ${pkg.receipts?.engineLabel || "browser"}`)}</span>
      <span>${esc(`leaves ${leafCount}`)}</span>
    </footer>
  </article>`;
}

function plainReason(reason) {
  const map = {
    "extension:soundnessFail": "延伸段引擎差距過大",
    "extension:tooShort": "延伸段過短",
    "extension:endpointEval": "延伸終點評估不佳",
    "factuality:trunkPersonal": "主幹缺少足夠個人樣本",
    "factuality:cohort": "延伸段缺少分段事實支撐",
    "audit:mainlineLeaf": "主線終點未通過審計",
    "personalAnchor:emptyTrunk": "無有效個人錨點",
  };
  if (map[reason]) return map[reason];
  if (reason.startsWith("memorability:")) return "記憶負荷超出預算";
  if (reason.startsWith("schema:")) return "套件結構未通過驗證";
  return reason;
}

function summarizeEliminated(eliminated) {
  const hist = new Map();
  for (const e of eliminated || []) {
    for (const r of e.reasons || []) {
      hist.set(r, (hist.get(r) || 0) + 1);
    }
  }
  return [...hist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => `${plainReason(reason)} (${count})`);
}

/**
 * @param {{ report: object, meta?: object }} result
 * @param {{ escapeHtml?: (s: string) => string, renderMiniBoard?: Function }} [opts]
 */
export function renderV13Report(result, opts = {}) {
  const esc = opts.escapeHtml || ((s) => String(s));
  const report = result?.report || result;
  const meta = result?.meta || {};
  const packages = report?.packages || [];

  if (!packages.length) {
    const reasons = summarizeEliminated(report?.eliminated);
    const explorerNote = meta.explorerAvailable === false
      ? `<p class="scout-v13-note">${esc("同分段資料不可用(未連結 Lichess)")}</p>`
      : "";
    return `<div class="scout-v13-empty">
      <p class="scout-v13-empty-title">${esc("尚無備戰套件")}</p>
      ${explorerNote}
      ${reasons.length ? `<ul class="scout-v13-empty-reasons">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
    </div>`;
  }

  const vacancyNotes = (report?.bucketVacancies || []).map((v) => {
    const bucket = STYLE_LABELS[v.bucket] || v.bucket;
    return `<p class="scout-v13-vacancy">${esc(`此風格桶(${bucket})無過門檻候選`)}</p>`;
  }).join("");

  const cards = packages.map((pkg) => {
    const withReceipts = {
      ...pkg,
      receipts: {
        ...(pkg.receipts || {}),
        sfDepth: meta.sfDepth,
        ratingBand: meta.ratingBand,
        speed: meta.speeds,
        engineLabel: meta.engineLabel,
      },
    };
    return renderPackageCard(withReceipts, esc, opts.renderMiniBoard);
  }).join("");

  const eliminated = report?.eliminated || [];
  const eliminatedHtml = eliminated.length
    ? `<details class="scout-v13-eliminated">
        <summary>${esc(`淘汰 ${eliminated.length} 條候選`)}</summary>
      </details>`
    : "";

  return `<div class="scout-v13-report">
    ${vacancyNotes}
    <div class="scout-v13-cards">${cards}</div>
    ${eliminatedHtml}
  </div>`;
}

/**
 * @param {object} opts
 * @param {(s: string) => string} opts.escapeHtml
 * @param {string} [opts.playerName]
 * @param {string} [opts.reportHtml]
 * @param {boolean} [opts.canGenerate]
 * @param {boolean} [opts.running]
 * @param {number} [opts.progressDone]
 * @param {number} [opts.progressTotal]
 * @param {string} [opts.progressLabel]
 */
export function renderV13PanelShell(opts = {}) {
  const esc = opts.escapeHtml || ((s) => String(s));
  const playerName = opts.playerName ? esc(opts.playerName) : esc("對手");
  const reportHtml = opts.reportHtml || "";
  const canGenerate = opts.canGenerate !== false;
  const running = Boolean(opts.running);
  const indeterminate = running && !opts.progressTotal;
  const pct = opts.progressTotal
    ? Math.min(100, Math.round((Number(opts.progressDone) / Number(opts.progressTotal)) * 100))
    : 0;
  const progressLabel = esc(opts.progressLabel || "產生備戰套件中…");

  const progressHtml = running
    ? `<div class="scout-v13-progress scout-engine-progress${indeterminate ? " is-indeterminate" : ""}" role="progressbar">
        <div class="scout-progress-row">
          <span class="scout-progress-label">${progressLabel}</span>
          <span class="scout-progress-count">${indeterminate ? "" : `${pct}%`}</span>
        </div>
        <div class="scout-progress-track">
          <div class="scout-progress-fill" style="width:${indeterminate ? 40 : pct}%"></div>
        </div>
      </div>`
    : "";

  const cancelBtn = running
    ? `<button type="button" class="scout-btn btn ghost" id="scout-v13-cancel-btn">${esc("取消")}</button>`
    : "";

  return `<div class="scout-v13-panel">
    <div class="scout-v13-panel-head">
      <strong>${esc("Prep packages")}</strong>
      <span class="scout-v13-badge">v13</span>
    </div>
    <p class="scout-v13-subject">${esc("棋手")}: <strong>${playerName}</strong></p>
    <div class="scout-v13-actions">
      <button type="button" class="scout-btn btn primary" id="scout-v13-generate-btn"
        ${canGenerate && !running ? "" : "disabled"}>${esc("Generate prep packages")}</button>
      ${cancelBtn}
    </div>
    ${progressHtml}
    <div id="scout-v13-report-host">${reportHtml}</div>
  </div>`;
}

/** Self-check rendered HTML against banned vocabulary (for tests). */
export function assertV13ReportClean(html) {
  const lower = String(html).toLowerCase();
  if (lower.includes("pitilt")) throw new Error("v13 report must not contain piTilt");
  for (const word of V12_BANNED_VOCAB) {
    if (lower.includes(word.toLowerCase())) {
      throw new Error(`v13 report must not contain banned vocab: ${word}`);
    }
  }
  for (const phrase of PERSONAL_SUBJECT_PHRASES) {
    if (html.includes(phrase)) {
      throw new Error(`v13 report must not contain personal-subject phrase on non-personal edges: ${phrase}`);
    }
  }
}