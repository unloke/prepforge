import { html } from "../html.js";
import { reportGradeLabel, reportGradeOf } from "./analyze-report.js";
import { classBadgeSymbol } from "../move-grades.js";
import { nodeGrade } from "../analyze-tried-grade.js";

const ERROR_TIERS = [
  ["blunder", "??", "Blunder"],
  ["mistake", "?", "Mistake"],
  ["missed", "×", "Missed win"],
  ["inaccuracy", "?!", "Inaccuracy"],
];


function plateNameHtml(sideKey, sideData) {
  const fallback = sideKey === "white" ? "White" : "Black";
  const name = sideData?.name || fallback;
  return html`<span class="an-plate-who"><i class="rp-disc rp-${sideKey}" aria-hidden="true"></i><span class="an-plate-name" title="${name}">${name}</span></span>`;
}

// Compact error breakdown for the broadcast plates: "?? 3 · ? 1" (up to two
// worst error tiers so both plates stay clean and flush right).
function plateErrorsHtml(counts = {}) {
  const shown = ERROR_TIERS.filter(([key]) => counts[key] > 0).slice(0, 2);
  if (!shown.length) return "";
  const title = shown.map(([key, , label]) => `${counts[key]} ${label}`).join(", ");
  return html`<span class="an-plate-errs" title="${title}">${shown.map(
    ([key, glyph], idx) => html`${idx ? html`<span class="an-err-sep" aria-hidden="true">·</span>` : ""}<span class="an-err g-${key}"><i class="rp-glyph" aria-hidden="true">${glyph}</i>${counts[key]}</span>`,
  )}</span>`;
}

function plateStatHtml(sideData, graded) {
  if (!graded || !sideData) return "";
  const acc = sideData.accuracy == null ? "" : html`<b class="an-plate-acc">${sideData.accuracy}%</b>`;
  return html`<span class="an-plate-meta">${acc}${plateErrorsHtml(sideData.counts)}</span>`;
}

const cleanTag = (value) => {
  const text = String(value || "").trim();
  return !text || /^[?*.\s-]+$/.test(text) ? "" : text;
};

// Desktop broadcast board frame: symmetrical top/bottom player plates,
// slender vertical evaluation bar, opening header, and serif move headline.
export function createAnalyzePlates({ getReport, onFlip }) {
  let orientation = "white";

  function readOrientation() {
    const board = typeof document !== "undefined" && document.getElementById("analysis-board");
    const bottomLeft = board?.querySelector?.(".square[data-square]");
    if (bottomLeft?.dataset?.square === "h1") return "black";
    if (bottomLeft?.dataset?.square === "a8") return "white";
    return orientation;
  }

  function paintOpeningHead(headers = {}, report = null) {
    const head = typeof document !== "undefined" && document.getElementById("analysis-opening-head");
    if (!head) return;
    const opening = cleanTag(headers.Opening) || report?.opening || "";
    const event = cleanTag(headers.Event);
    const round = cleanTag(headers.Round);
    const date = cleanTag(headers.Date || headers.UTCDate);
    const meta = [round ? `Round ${round}` : "", date].filter(Boolean).join(" · ");
    const title = opening || event || meta;
    if (!title) {
      head.hidden = true;
      head.innerHTML = "";
      return;
    }
    head.hidden = false;
    head.innerHTML = html`<b class="an-oh-title" title="${title}">${title}</b>${meta && title !== meta ? html`<span class="an-oh-meta">${meta}</span>` : ""}`;
  }

  function paintPlates(headers = {}) {
    const topEl = typeof document !== "undefined" && document.getElementById("analysis-plate-top");
    const botLeftEl = typeof document !== "undefined" && document.getElementById("analysis-plate-bot-left");
    const botRightEl = typeof document !== "undefined" && document.getElementById("analysis-plate-bot-right");
    const report = getReport();
    paintOpeningHead(headers, report);
    if (!topEl || !botLeftEl || !botRightEl) return;
    orientation = readOrientation();
    const hasGame = Boolean(report && (report.graded || report.sides?.white?.name || report.sides?.black?.name));
    if (!hasGame) {
      topEl.hidden = true;
      botLeftEl.hidden = true;
      botRightEl.hidden = true;
      topEl.innerHTML = "";
      botLeftEl.innerHTML = "";
      botRightEl.innerHTML = "";
      return;
    }
    const topSide = orientation === "black" ? "white" : "black";
    const botSide = orientation === "black" ? "black" : "white";
    const topData = report.sides[topSide];
    const botData = report.sides[botSide];
    topEl.hidden = false;
    botLeftEl.hidden = false;
    botRightEl.hidden = false;
    topEl.innerHTML = html`${plateNameHtml(topSide, topData)}${plateStatHtml(topData, report.graded)}`;
    botLeftEl.innerHTML = plateNameHtml(botSide, botData);
    botRightEl.innerHTML = plateStatHtml(botData, report.graded);
  }

  function paintMoveHead(analysisState) {
    if (typeof document === "undefined") return;
    const card = document.getElementById("analysis-explain");
    const prose = document.getElementById("coach-prose");
    if (!card || !prose || typeof document.createElement !== "function") return;
    let host = document.getElementById("analysis-move-head");
    if (!host) {
      host = document.createElement("div");
      host.id = "analysis-move-head";
      host.className = "an-move-head";
      host.hidden = true;
      prose.before(host);
    }
    const node = analysisState?.analysisTree?.byId?.get?.(analysisState.analysisCurrentNodeId || "root");
    if (!node || !node.san) {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }
    const moveNum = node.moveNumber ?? Math.ceil((Number(node.ply) || 1) / 2);
    const sep = node.side === "black" ? "… " : ". ";
    const nodeClassification = nodeGrade(node);
    const gradeKey = reportGradeOf(nodeClassification);
    const gradeWord = reportGradeLabel(nodeClassification);
    const gradeMark = classBadgeSymbol(nodeClassification);
    host.hidden = false;
    host.innerHTML = html`<span class="an-mh-san"><span class="an-mh-number">${moveNum}${sep}</span>${node.san}</span>${gradeWord ? html`<span class="an-mh-grade g-${gradeKey}" role="img" aria-label="${gradeWord}" title="${gradeWord}">${gradeMark || gradeWord}</span>` : ""}`;
  }

  function compactRailEval(text) {
    if (!text) return "0.0";
    const s = String(text).trim();
    const mate = /^#[-−]?(\d+)$/.exec(s);
    if (mate) return `M${mate[1]}`;
    if (/^[+−-]?M$/i.test(s)) return "M";
    if (s === "1-0" || s === "0-1") return s;
    const num = Number.parseFloat(s.replace("−", "-"));
    if (!Number.isFinite(num)) return s.replace(/^[+−-]/, "").replace(/(\.\d)\d$/, "$1");
    const abs = Math.abs(num);
    if (abs < 0.05) return "0.0";
    return abs >= 10 ? String(Math.round(abs)) : abs.toFixed(1);
  }

  function paintVerticalEval({ text, side, pct, show }) {
    const rail = typeof document !== "undefined" && document.getElementById("analysis-eval-rail");
    const vBar = typeof document !== "undefined" && document.getElementById("analysis-eval-v");
    const vVal = typeof document !== "undefined" && document.getElementById("analysis-eval-v-val");
    if (!rail || !vBar) return;
    orientation = readOrientation();
    const flipped = orientation === "black" ? "true" : "false";
    const lead = Number.isFinite(pct) ? (pct < 50 ? "black" : "white") : (side === "black" ? "black" : "white");
    rail.hidden = !show;
    rail.dataset.flipped = flipped;
    rail.dataset.lead = lead;
    vBar.dataset.flipped = flipped;
    vBar.dataset.side = side;
    const vFill = document.getElementById("analysis-eval-v-fill");
    if (vFill) {
      const share = Number.isFinite(pct) ? Math.max(0.05, Math.min(0.95, pct / 100)) : 0.5;
      vFill.style.transform = `scaleY(${share.toFixed(4)})`;
    }
    if (vVal) {
      const compact = compactRailEval(text);
      if (vVal.textContent !== compact) vVal.textContent = compact;
    }
  }

  const flipBtn = typeof document !== "undefined" && document.getElementById("analysis-flip");
  if (flipBtn && typeof flipBtn.addEventListener === "function" && !flipBtn.dataset?.platesBound) {
    if (flipBtn.dataset) flipBtn.dataset.platesBound = "1";
    flipBtn.addEventListener("click", () => {
      orientation = orientation === "black" ? "white" : "black";
      paintPlates();
      onFlip?.();
    });
  }

  return { paintPlates, paintMoveHead, paintVerticalEval };
}
