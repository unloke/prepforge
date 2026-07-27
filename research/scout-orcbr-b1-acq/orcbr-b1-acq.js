// ORCBR-B1 raw materialization / acquisition protocol helpers.
// Acquisition-only. Does not run ORCBR gates. Does not retune algorithm thresholds.
// Network is never implied — callers must pass an explicit execute flag + fetch impl.

import { createHash, createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const ACQ_PROTOCOL_KIND = "scout-orcbr-b1-raw-acquisition-protocol";
export const ACQ_PROTOCOL_ID = "scout-orcbr-b1-raw-acq-v1";
export const ACQ_CANDIDATE_ID = "orcbr-b1";
export const ACQ_PRODUCT_VERDICT = "preserve-v2";
export const RELATED_ALGORITHM_PROTOCOL_ID = "scout-orcbr-b1-v1";

export const ACQ_VERDICTS = Object.freeze({
  ACQ_PROTOCOL_FROZEN: "ACQ_PROTOCOL_FROZEN",
  ACQ_PANEL_SELECTED: "ACQ_PANEL_SELECTED",
  STOP_ACQUISITION_PANEL_UNAVAILABLE: "STOP_ACQUISITION_PANEL_UNAVAILABLE",
  ACQ_NETWORK_DISABLED: "ACQ_NETWORK_DISABLED",
  ACQ_EXECUTE_OK: "ACQ_EXECUTE_OK",
  STOP_ACQUISITION_HTTP_FAILURE: "STOP_ACQUISITION_HTTP_FAILURE",
  STOP_ACQUISITION_RATE_LIMIT: "STOP_ACQUISITION_RATE_LIMIT",
  STOP_ACQUISITION_FREEZE_REQUIRED: "STOP_ACQUISITION_FREEZE_REQUIRED",
  INVALID: "INVALID",
  TAMPER_DETECTED: "TAMPER_DETECTED",
});

export const BURN_ON_EXECUTE =
  "ACQUIRED_RAW_SEALED_NEWLY_BURNED_FOR_ORCBR_SCHEMA_STRUCTURAL_RESEARCH";
export const BURN_ON_INSPECT =
  "ACQUIRED_RAW_BURNED_FOR_ORCBR_SCHEMA_STRUCTURAL_RESEARCH_ONCE_INSPECTED";

/** SHA-256 hex of utf8 string or Buffer. */
export function sha256Hex(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return createHash("sha256").update(buf).digest("hex");
}

export function normalizeSubjectId(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  return s || null;
}

/**
 * Pseudonymous subject key for reports/manifests.
 * "subj_" + first 16 hex of HMAC-SHA256(researchSalt, normalizedId).
 */
export function subjectKey(normalizedId, researchSalt) {
  const norm = normalizeSubjectId(normalizedId);
  if (!norm) return null;
  if (!researchSalt || String(researchSalt).length < 8) {
    throw new Error("researchSalt must be at least 8 characters");
  }
  const hex = createHmac("sha256", String(researchSalt))
    .update(norm, "utf8")
    .digest("hex");
  return `subj_${hex.slice(0, 16)}`;
}

export function computeReportSha256(report) {
  const canonical = { ...(report || {}) };
  delete canonical.reportSha256;
  return sha256Hex(`${JSON.stringify(canonical, null, 2)}\n`);
}

/**
 * Detect raw-identity leakage in reports/receipts (not sealed raw custody files).
 */
export function assertNoRawIdentityLeakage(obj, path = "$", options = {}) {
  const leaks = [];
  const bannedKey =
    /^(opponentId|opponentName|subjectId|subjectName|userId|username|subject|rawUsername|lichessUsername|_rawNormalized|rawOpponent|rawSubject)$/i;
  const knownRaw = (options.knownRawTokens || [])
    .filter((t) => t != null && String(t).trim().length >= 2)
    .map((t) => String(t).toLowerCase());

  const walk = (v, p) => {
    if (v == null) return;
    if (typeof v === "string") {
      const lower = v.toLowerCase();
      if (
        !lower.startsWith("subj_")
        && !lower.startsWith("opp_")
        && knownRaw.some((t) => lower === t || (t.length >= 4 && lower.includes(t)))
      ) {
        leaks.push(`${p}=raw-token`);
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${p}[${i}]`));
      return;
    }
    if (typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        if (bannedKey.test(k)) leaks.push(`${p}.${k}`);
        if (k === "players" || k === "white" || k === "black") {
          if (val && typeof val === "object") leaks.push(`${p}.${k}`);
        }
        walk(val, `${p}.${k}`);
      }
    }
  };
  walk(obj, path);
  return { ok: leaks.length === 0, leaks };
}

/** Validate acquisition protocol locks (never algorithm pin retune). */
export function validateAcquisitionProtocol(protocol) {
  const errors = [];
  if (protocol?.kind !== ACQ_PROTOCOL_KIND) {
    errors.push(`kind must be ${ACQ_PROTOCOL_KIND}`);
  }
  if (protocol?.protocolId !== ACQ_PROTOCOL_ID) {
    errors.push(`protocolId must be ${ACQ_PROTOCOL_ID}`);
  }
  if (protocol?.candidateId !== ACQ_CANDIDATE_ID) {
    errors.push(`candidateId must be ${ACQ_CANDIDATE_ID}`);
  }
  if (protocol?.role !== "raw-materialization-only") {
    errors.push("role must be raw-materialization-only");
  }
  if (protocol?.researchOnly !== true) errors.push("researchOnly must be true");
  if (protocol?.outcomeBlind !== true) errors.push("outcomeBlind must be true");
  if (protocol?.productAuthorization !== false) {
    errors.push("productAuthorization must be false");
  }
  if (protocol?.productVerdict !== ACQ_PRODUCT_VERDICT) {
    errors.push(`productVerdict must be ${ACQ_PRODUCT_VERDICT}`);
  }
  if (protocol?.moduleAStatus !== "CLOSED_NOT_REOPENED") {
    errors.push("moduleAStatus must be CLOSED_NOT_REOPENED");
  }
  if (protocol?.calAllowed !== false) errors.push("calAllowed must be false");
  if (protocol?.testAllowed !== false) errors.push("testAllowed must be false");
  if (protocol?.calTestSplitAllowed !== false) {
    errors.push("calTestSplitAllowed must be false");
  }
  if (protocol?.outcomeEvaluationAllowed !== false) {
    errors.push("outcomeEvaluationAllowed must be false");
  }
  if (protocol?.orcbrGatesAllowed !== false) {
    errors.push("orcbrGatesAllowed must be false");
  }
  if (protocol?.networkEnabledDefault !== false) {
    errors.push("networkEnabledDefault must be false");
  }
  if (protocol?.networkRequiresExplicitExecuteFlag !== true) {
    errors.push("networkRequiresExplicitExecuteFlag must be true");
  }
  if (protocol?.relatedAlgorithmProtocolId !== RELATED_ALGORITHM_PROTOCOL_ID) {
    errors.push(`relatedAlgorithmProtocolId must be ${RELATED_ALGORITHM_PROTOCOL_ID}`);
  }
  if (protocol?.subjectSource?.resultBasedSelectionForbidden !== true) {
    errors.push("resultBasedSelectionForbidden must be true");
  }
  if (protocol?.subjectSource?.orcbrOutcomeSelectionForbidden !== true) {
    errors.push("orcbrOutcomeSelectionForbidden must be true");
  }
  const minS = protocol?.subjectSource?.minSubjects;
  const maxS = protocol?.subjectSource?.maxSubjects;
  if (!Number.isInteger(minS) || minS < 1) errors.push("minSubjects must be integer >= 1");
  if (!Number.isInteger(maxS) || maxS < minS) {
    errors.push("maxSubjects must be integer >= minSubjects");
  }
  const maxG = protocol?.fetch?.maxGamesPerSubject;
  if (!Number.isInteger(maxG) || maxG < 10) {
    errors.push("fetch.maxGamesPerSubject must be integer >= 10");
  }
  if (!protocol?.salt?.researchSalt || String(protocol.salt.researchSalt).length < 8) {
    errors.push("salt.researchSalt must be present and length >= 8");
  }
  if (!Array.isArray(protocol?.subjectSource?.candidateAllowlist)
    || protocol.subjectSource.candidateAllowlist.length === 0) {
    errors.push("candidateAllowlist must be non-empty");
  }
  if (!Array.isArray(protocol?.forbiddenSubjects?.subjects)) {
    errors.push("forbiddenSubjects.subjects required");
  }
  return { ok: errors.length === 0, errors };
}

export function forbiddenSubjectSet(protocol) {
  const list = protocol?.forbiddenSubjects?.subjects || [];
  return new Set(list.map((s) => normalizeSubjectId(s)).filter(Boolean));
}

/**
 * Scan source file text for candidate allowlist members (word-boundary-ish match).
 * Does not use ORCBR outcomes or performance metrics.
 */
export function extractCandidatesFromSourceText(text, allowlist) {
  const found = new Set();
  const body = String(text || "");
  for (const cand of allowlist || []) {
    const norm = normalizeSubjectId(cand);
    if (!norm) continue;
    // Match as whole identifier in source (quotes, defaults, comments).
    const re = new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegExp(cand)}(?:[^A-Za-z0-9_]|$)`, "i");
    if (re.test(body)) found.add(norm);
  }
  return [...found];
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deterministic subject panel selection from repo metadata sources.
 * Independent of ORCBR outcomes / performance.
 *
 * @param {object} protocol
 * @param {object} options
 * @param {string} [options.repoRoot] absolute repo root for reading sourceFiles
 * @param {Record<string,string>} [options.sourceTexts] path -> text overrides (tests)
 * @param {string[]} [options.orcbrOutcomeSubjects] if provided, selection must ignore these rankings
 * @param {Map|object} [options.performanceScores] forbidden influence — must not change order
 */
export function selectSubjectPanel(protocol, options = {}) {
  const locks = validateAcquisitionProtocol(protocol);
  if (!locks.ok) {
    return {
      ok: false,
      verdict: ACQ_VERDICTS.INVALID,
      errors: locks.errors,
      subjects: [],
    };
  }

  const allowlist = protocol.subjectSource.candidateAllowlist;
  const forbidden = forbiddenSubjectSet(protocol);
  const minSubjects = protocol.subjectSource.minSubjects;
  const maxSubjects = protocol.subjectSource.maxSubjects;
  const researchSalt = protocol.salt.researchSalt;
  const sourceFiles = protocol.subjectSource.sourceFiles || [];

  const appeared = new Set();
  const sourceHits = [];

  for (const src of sourceFiles) {
    const rel = src.path;
    let text = options.sourceTexts?.[rel];
    if (text == null && options.repoRoot) {
      const abs = join(options.repoRoot, rel);
      if (existsSync(abs)) {
        text = readFileSync(abs, "utf8");
      }
    }
    if (text == null) {
      sourceHits.push({ path: rel, present: false, found: [] });
      continue;
    }
    const found = extractCandidatesFromSourceText(text, allowlist);
    sourceHits.push({ path: rel, present: true, found });
    for (const f of found) appeared.add(f);
  }

  // Map normalized id -> canonical allowlist spelling for fetch URLs.
  const allowlistCanonical = new Map();
  for (const a of allowlist) {
    const n = normalizeSubjectId(a);
    if (n && !allowlistCanonical.has(n)) allowlistCanonical.set(n, String(a).trim());
  }

  // Qualified = in allowlist, appeared in metadata, not forbidden.
  // Sort localeCompare ascending on normalized id — never by performanceScores / ORCBR outcomes.
  const qualifiedNorm = [...appeared]
    .filter((id) => !forbidden.has(id))
    .filter((id) => allowlistCanonical.has(id))
    .sort((a, b) => a.localeCompare(b));

  // Explicitly ignore any outcome/performance ranking if supplied (test invariant).
  void options.orcbrOutcomeSubjects;
  void options.performanceScores;

  if (qualifiedNorm.length < minSubjects) {
    return {
      ok: false,
      verdict: ACQ_VERDICTS.STOP_ACQUISITION_PANEL_UNAVAILABLE,
      reason: `qualified subjects ${qualifiedNorm.length} < minSubjects ${minSubjects}`,
      subjects: [],
      sourceHits,
      forbiddenExcluded: [...appeared].filter((id) => forbidden.has(id)),
      productAuthorization: false,
      productVerdict: ACQ_PRODUCT_VERDICT,
    };
  }

  const selectedNorm = qualifiedNorm.slice(0, maxSubjects);
  const subjects = selectedNorm.map((normId) => ({
    subjectKey: subjectKey(normId, researchSalt),
    // Canonical raw id retained only for custody path selection / fetch URL construction;
    // stripped from public reports by stripPanelForReport.
    _rawId: allowlistCanonical.get(normId) || normId,
  }));

  return {
    ok: true,
    verdict: ACQ_VERDICTS.ACQ_PANEL_SELECTED,
    subjects,
    selectedCount: subjects.length,
    qualifiedCount: qualifiedNorm.length,
    sourceHits: sourceHits.map((h) => ({
      path: h.path,
      present: h.present,
      foundCount: (h.found || []).length,
    })),
    selectionRule: protocol.subjectSource.selectionRule,
    resultBasedSelection: false,
    orcbrOutcomeSelection: false,
    productAuthorization: false,
    productVerdict: ACQ_PRODUCT_VERDICT,
  };
}

/** Public panel view: no raw usernames. */
export function stripPanelForReport(panel) {
  if (!panel) return null;
  return {
    ok: panel.ok,
    verdict: panel.verdict,
    reason: panel.reason || null,
    selectedCount: panel.selectedCount ?? (panel.subjects || []).length,
    qualifiedCount: panel.qualifiedCount ?? null,
    subjectKeys: (panel.subjects || []).map((s) => s.subjectKey).filter(Boolean),
    sourceHits: panel.sourceHits || null,
    selectionRule: panel.selectionRule || null,
    resultBasedSelection: false,
    orcbrOutcomeSelection: false,
    productAuthorization: false,
    productVerdict: ACQ_PRODUCT_VERDICT,
  };
}

/**
 * Build Lichess public games export URL (raw-preserving NDJSON settings).
 */
export function buildAcquisitionUrl(username, protocol, { untilMs } = {}) {
  const max = protocol.fetch.maxGamesPerSubject;
  const safe = encodeURIComponent(String(username || "").trim());
  const params = new URLSearchParams({
    max: String(max),
    moves: String(protocol.fetch.moves !== false),
    clocks: String(protocol.fetch.clocks !== false),
    evals: String(!!protocol.fetch.evals),
    opening: String(!!protocol.fetch.opening),
    perfType: protocol.fetch.perfType || "blitz,rapid,classical",
    pgnInJson: String(protocol.fetch.pgnInJson !== false),
  });
  if (untilMs != null && Number.isFinite(Number(untilMs))) {
    params.set(protocol.fetch.untilParam || "until", String(Math.trunc(Number(untilMs))));
  }
  return `https://lichess.org/api/games/user/${safe}?${params}`;
}

/**
 * Deterministic NDJSON line cap: first maxGames complete non-empty lines.
 * Preserves exact line bytes; joins with \n and trailing newline when any kept.
 */
export function capNdjsonBytes(rawTextOrBuf, maxGames) {
  const raw = Buffer.isBuffer(rawTextOrBuf)
    ? rawTextOrBuf.toString("utf8")
    : String(rawTextOrBuf ?? "");
  const max = Math.max(0, Math.trunc(Number(maxGames) || 0));
  if (max === 0) {
    return { cappedText: "", lineCount: 0, rawLineCount: 0 };
  }
  const parts = raw.split("\n");
  const kept = [];
  let rawLineCount = 0;
  for (const line of parts) {
    // Preserve empty lines as separators only if they appear between content;
    // empty lines do not count toward game cap.
    if (line.trim() === "") continue;
    rawLineCount += 1;
    if (kept.length < max) kept.push(line);
  }
  // Also count trailing empties ignored for total non-empty.
  const cappedText = kept.length ? `${kept.join("\n")}\n` : "";
  return {
    cappedText,
    lineCount: kept.length,
    rawLineCount,
    bytes: Buffer.byteLength(cappedText, "utf8"),
  };
}

/**
 * Build freeze snapshot: binds protocol bytes, acquisition timestamp boundary, salt hash.
 * Must run before any network call.
 */
export function buildFreezeSnapshot(protocol, {
  protocolSha256,
  frozenAt = null,
  acquisitionUntilMs = null,
} = {}) {
  const locks = validateAcquisitionProtocol(protocol);
  if (!locks.ok) {
    return { ok: false, verdict: ACQ_VERDICTS.INVALID, errors: locks.errors };
  }
  const at = frozenAt || new Date().toISOString();
  const until = acquisitionUntilMs != null
    ? Number(acquisitionUntilMs)
    : Date.parse(at);
  const salt = protocol.salt.researchSalt;
  const snapshot = {
    ...protocol,
    protocolSha256: protocolSha256 || null,
    frozenAt: at,
    acquisitionUntilMs: until,
    saltSha256: sha256Hex(salt),
    // Keep researchSalt in snapshot for local custody determinism; reports omit it.
    productAuthorization: false,
    productVerdict: ACQ_PRODUCT_VERDICT,
    moduleAStatus: "CLOSED_NOT_REOPENED",
    networkEnabledDefault: false,
    freezeBeforeFetch: true,
    orcbrGatesAllowed: false,
    calAllowed: false,
    testAllowed: false,
  };
  return {
    ok: true,
    verdict: ACQ_VERDICTS.ACQ_PROTOCOL_FROZEN,
    snapshot,
  };
}

/** Refuse execute when freeze not done. */
export function assertFrozenBeforeFetch(snapshot) {
  if (!snapshot || snapshot.protocolId !== ACQ_PROTOCOL_ID || !snapshot.frozenAt) {
    return {
      ok: false,
      verdict: ACQ_VERDICTS.STOP_ACQUISITION_FREEZE_REQUIRED,
      reason: "freeze snapshot required before network",
    };
  }
  if (snapshot.networkEnabledDefault !== false) {
    return {
      ok: false,
      verdict: ACQ_VERDICTS.INVALID,
      reason: "networkEnabledDefault must remain false on snapshot",
    };
  }
  return { ok: true };
}

/**
 * Execute acquisition for one subject. Network only via injected fetchFn.
 * Default path is network-disabled unless confirmExecute === true.
 */
export async function acquireSubjectRaw({
  protocol,
  snapshot,
  rawUsername,
  subjectKey: subjKey,
  confirmExecute = false,
  fetchFn = null,
} = {}) {
  const frozen = assertFrozenBeforeFetch(snapshot || protocol);
  if (!frozen.ok) return frozen;

  if (!confirmExecute) {
    return {
      ok: false,
      verdict: ACQ_VERDICTS.ACQ_NETWORK_DISABLED,
      reason: "network disabled by default; pass explicit --confirm-execute",
      subjectKey: subjKey,
    };
  }

  if (typeof fetchFn !== "function") {
    return {
      ok: false,
      verdict: ACQ_VERDICTS.STOP_ACQUISITION_HTTP_FAILURE,
      reason: "no fetch implementation supplied",
      subjectKey: subjKey,
    };
  }

  const untilMs = snapshot.acquisitionUntilMs;
  const url = buildAcquisitionUrl(rawUsername, protocol, { untilMs });
  // URL contains username — do not put full URL in public reports.
  const urlSha256 = sha256Hex(url);

  let resp;
  try {
    resp = await fetchFn(url, {
      headers: { Accept: protocol.fetch.acceptHeader || "application/x-ndjson" },
    });
  } catch (err) {
    return {
      ok: false,
      verdict: ACQ_VERDICTS.STOP_ACQUISITION_HTTP_FAILURE,
      reason: "network error",
      subjectKey: subjKey,
      httpStatus: null,
      urlSha256,
      errorClass: err?.name || "Error",
    };
  }

  const status = resp.status;
  if (status === 429) {
    return {
      ok: false,
      verdict: ACQ_VERDICTS.STOP_ACQUISITION_RATE_LIMIT,
      reason: "HTTP 429 rate limit — no aggressive retry",
      subjectKey: subjKey,
      httpStatus: 429,
      urlSha256,
    };
  }
  if (!resp.ok) {
    return {
      ok: false,
      verdict: ACQ_VERDICTS.STOP_ACQUISITION_HTTP_FAILURE,
      reason: `HTTP ${status}`,
      subjectKey: subjKey,
      httpStatus: status,
      urlSha256,
    };
  }

  const rawText = typeof resp.text === "function" ? await resp.text() : String(resp.body || "");
  const rawBuf = Buffer.from(rawText, "utf8");
  const rawSha256 = sha256Hex(rawBuf);
  const capped = capNdjsonBytes(rawText, protocol.fetch.maxGamesPerSubject);
  const cappedSha256 = sha256Hex(capped.cappedText);

  const httpReceipt = {
    kind: "orcbr-b1-acq-http-receipt",
    subjectKey: subjKey,
    httpStatus: status,
    urlSha256,
    rawSha256,
    cappedSha256,
    rawByteLength: rawBuf.length,
    cappedByteLength: capped.bytes,
    cappedLineCount: capped.lineCount,
    rawNonEmptyLineCount: capped.rawLineCount,
    maxGamesPerSubject: protocol.fetch.maxGamesPerSubject,
    acquisitionUntilMs: untilMs,
    productAuthorization: false,
    productVerdict: ACQ_PRODUCT_VERDICT,
    burnDeclaration: BURN_ON_EXECUTE,
    rateLimitRetry: false,
  };
  httpReceipt.receiptSha256 = sha256Hex(
    `${JSON.stringify({ ...httpReceipt, receiptSha256: undefined }, null, 2)}\n`,
  );

  const leak = assertNoRawIdentityLeakage(httpReceipt, "$.httpReceipt", {
    knownRawTokens: [rawUsername],
  });
  if (!leak.ok) {
    return {
      ok: false,
      verdict: ACQ_VERDICTS.INVALID,
      reason: `raw identity in receipt: ${leak.leaks.join(",")}`,
      subjectKey: subjKey,
    };
  }

  return {
    ok: true,
    verdict: ACQ_VERDICTS.ACQ_EXECUTE_OK,
    subjectKey: subjKey,
    rawText,
    cappedText: capped.cappedText,
    rawSha256,
    cappedSha256,
    httpReceipt,
    burnDeclaration: BURN_ON_EXECUTE,
  };
}

/**
 * Run multi-subject acquisition with optional inter-subject delay.
 * Stops on first HTTP/rate failure (fail-closed).
 */
export async function executeAcquisition({
  protocol,
  snapshot,
  panel,
  confirmExecute = false,
  fetchFn = null,
  sleepFn = async (ms) => {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  },
} = {}) {
  const frozen = assertFrozenBeforeFetch(snapshot || protocol);
  if (!frozen.ok) return { ok: false, ...frozen, subjects: [] };

  if (!confirmExecute) {
    return {
      ok: false,
      verdict: ACQ_VERDICTS.ACQ_NETWORK_DISABLED,
      reason: "network disabled by default; pass explicit --confirm-execute",
      subjects: [],
    };
  }

  if (!panel?.ok || !panel.subjects?.length) {
    return {
      ok: false,
      verdict: panel?.verdict || ACQ_VERDICTS.STOP_ACQUISITION_PANEL_UNAVAILABLE,
      reason: panel?.reason || "no panel",
      subjects: [],
    };
  }

  const results = [];
  const delay = protocol.fetch?.interSubjectDelayMs ?? 1200;

  for (let i = 0; i < panel.subjects.length; i += 1) {
    if (i > 0 && delay > 0) await sleepFn(delay);
    const s = panel.subjects[i];
    const r = await acquireSubjectRaw({
      protocol,
      snapshot,
      rawUsername: s._rawId,
      subjectKey: s.subjectKey,
      confirmExecute: true,
      fetchFn,
    });
    results.push(r);
    if (!r.ok) {
      return {
        ok: false,
        verdict: r.verdict,
        reason: r.reason,
        subjects: results,
        stoppedAt: s.subjectKey,
        burnDeclaration: BURN_ON_EXECUTE,
      };
    }
  }

  return {
    ok: true,
    verdict: ACQ_VERDICTS.ACQ_EXECUTE_OK,
    subjects: results,
    burnDeclaration: BURN_ON_EXECUTE,
    productAuthorization: false,
    productVerdict: ACQ_PRODUCT_VERDICT,
    note: BURN_ON_INSPECT,
  };
}

/** Build global manifest (no raw identities). */
export function buildManifest({
  protocol,
  snapshot,
  panelPublic,
  subjectReceipts = [],
} = {}) {
  const rows = subjectReceipts.map((r) => ({
    subjectKey: r.subjectKey,
    ok: r.ok,
    verdict: r.verdict,
    rawSha256: r.rawSha256 || r.httpReceipt?.rawSha256 || null,
    cappedSha256: r.cappedSha256 || r.httpReceipt?.cappedSha256 || null,
    receiptSha256: r.httpReceipt?.receiptSha256 || null,
    httpStatus: r.httpStatus ?? r.httpReceipt?.httpStatus ?? null,
    cappedLineCount: r.httpReceipt?.cappedLineCount ?? null,
  }));
  const manifest = {
    kind: "orcbr-b1-acq-manifest",
    version: 1,
    protocolId: ACQ_PROTOCOL_ID,
    protocolSha256: snapshot?.protocolSha256 || null,
    frozenAt: snapshot?.frozenAt || null,
    acquisitionUntilMs: snapshot?.acquisitionUntilMs || null,
    saltSha256: snapshot?.saltSha256 || null,
    panel: panelPublic,
    subjects: rows,
    productAuthorization: false,
    productVerdict: ACQ_PRODUCT_VERDICT,
    moduleAStatus: "CLOSED_NOT_REOPENED",
    orcbrGatesRun: false,
    calTestSplit: false,
    burnDeclaration: BURN_ON_EXECUTE,
    relatedAlgorithmProtocolId: RELATED_ALGORITHM_PROTOCOL_ID,
  };
  manifest.manifestSha256 = sha256Hex(
    `${JSON.stringify({ ...manifest, manifestSha256: undefined }, null, 2)}\n`,
  );
  return manifest;
}

/** Final report — last written; no raw identity; self-hashed. */
export function buildAcquisitionReport({
  protocol,
  snapshot,
  panelPublic,
  executeResult,
  manifest,
} = {}) {
  const report = {
    kind: "orcbr-b1-acq-report",
    version: 1,
    protocolId: ACQ_PROTOCOL_ID,
    candidateId: ACQ_CANDIDATE_ID,
    role: "raw-materialization-only",
    researchOnly: true,
    productAuthorization: false,
    productVerdict: ACQ_PRODUCT_VERDICT,
    moduleAStatus: "CLOSED_NOT_REOPENED",
    scoutProductionDefault: "v2-unmodified",
    relatedAlgorithmProtocolId: RELATED_ALGORITHM_PROTOCOL_ID,
    protocolSha256: snapshot?.protocolSha256 || null,
    frozenAt: snapshot?.frozenAt || null,
    acquisitionUntilMs: snapshot?.acquisitionUntilMs || null,
    saltSha256: snapshot?.saltSha256 || null,
    panel: panelPublic,
    verdict: executeResult?.verdict
      || panelPublic?.verdict
      || ACQ_VERDICTS.ACQ_PROTOCOL_FROZEN,
    executeOk: executeResult?.ok === true,
    subjectCount: executeResult?.subjects?.length ?? 0,
    manifestSha256: manifest?.manifestSha256 || null,
    burnDeclaration: executeResult?.burnDeclaration || BURN_ON_INSPECT,
    burnNote:
      "Acquisition outputs are newly burned for ORCBR schema/structural research once inspected. Confirmatory reuse of EBB/SHPFA/opened artifacts is forbidden.",
    calAllowed: false,
    testAllowed: false,
    orcbrGatesAllowed: false,
    networkEnabledDefault: false,
  };
  report.reportSha256 = computeReportSha256(report);
  const known = [];
  // Collect any accidental raw ids from panel if present
  for (const s of executeResult?.subjects || []) {
    if (s?._rawId) known.push(s._rawId);
  }
  const leak = assertNoRawIdentityLeakage(report, "$.report", { knownRawTokens: known });
  if (!leak.ok) {
    return {
      ...report,
      verdict: ACQ_VERDICTS.INVALID,
      reportSha256: undefined,
      leakage: leak.leaks,
      reportSha256Final: null,
    };
  }
  return report;
}

/** Verify custody hashes / tamper detection. */
export function verifyCustodyArtifacts({
  snapshot,
  manifest,
  report,
  subjectFiles = [],
} = {}) {
  const issues = [];
  if (!snapshot?.protocolSha256) issues.push("missing protocolSha256");
  if (manifest?.manifestSha256) {
    const re = sha256Hex(
      `${JSON.stringify({ ...manifest, manifestSha256: undefined }, null, 2)}\n`,
    );
    if (re !== manifest.manifestSha256) issues.push("manifestSha256 mismatch");
  } else if (manifest) {
    issues.push("manifest missing manifestSha256");
  }
  if (report?.reportSha256) {
    const re = computeReportSha256(report);
    if (re !== report.reportSha256) issues.push("reportSha256 mismatch");
  } else if (report) {
    issues.push("report missing reportSha256");
  }
  for (const f of subjectFiles) {
    if (f.rawBytes != null && f.rawSha256) {
      if (sha256Hex(f.rawBytes) !== f.rawSha256) {
        issues.push(`raw tamper subjectKey=${f.subjectKey}`);
      }
    }
    if (f.cappedBytes != null && f.cappedSha256) {
      if (sha256Hex(f.cappedBytes) !== f.cappedSha256) {
        issues.push(`capped tamper subjectKey=${f.subjectKey}`);
      }
    }
  }
  if (issues.length) {
    return {
      ok: false,
      verdict: ACQ_VERDICTS.TAMPER_DETECTED,
      issues,
    };
  }
  return {
    ok: true,
    verdict: "VERIFY_OK",
    issues: [],
  };
}

export function loadProtocolFromPath(path) {
  const bytes = readFileSync(path);
  const protocol = JSON.parse(bytes.toString("utf8"));
  const protocolSha256 = sha256Hex(bytes);
  return { protocol, protocolSha256, bytes };
}
