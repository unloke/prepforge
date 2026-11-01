// Scout v15 — Stockfish engine cache identity envelope and confirmatory labeling guards.
// Pure helpers except optional UCI identity query (spawn).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

import {
  canonicalizeGameRecord,
  HISTORICAL_PARTITION_KIND,
  sha256Buffer,
  sha256Hex,
  sortGamesByCreatedAt,
  validateHistoricalProtocol,
  validateStudyProtocol,
  verifyManifestGameIds,
  verifyProtocolSha256,
} from "./scout-v15-study.js";

export const ENGINE_CACHE_SCHEMA_VERSION = 2;
export const SCORE_PARSER_VERSION = 1;

export const C1_PROTOCOL_KIND = "scout-v15-preregistration-protocol";
export const C1_PARTITION_KIND = "scout-v15-c1-partition";
export const HISTORICAL_PROTOCOL_KIND = "scout-v15-historical-replication-protocol";
export const CONFIRMATORY_STUDY_KIND_C1 = "C1";
export const CONFIRMATORY_STUDY_KIND_HR1 = "H-R1";

/**
 * Build the version-2 engine identity envelope used for cache load/save and header pinning.
 * @param {object} params
 * @returns {object}
 */
export function buildEngineIdentity({
  stockfishSha256,
  uciIdName = null,
  uciIdAuthor = null,
  depth,
  multipv,
  threads,
  hashMb,
  maxPlies,
  scoreParserVersion = SCORE_PARSER_VERSION,
} = {}) {
  return {
    schemaVersion: ENGINE_CACHE_SCHEMA_VERSION,
    stockfishSha256: String(stockfishSha256 || ""),
    uciIdName: uciIdName ?? null,
    uciIdAuthor: uciIdAuthor ?? null,
    depth: Number(depth),
    multipv: Number(multipv),
    threads: Number(threads),
    hashMb: Number(hashMb),
    maxPlies: Number(maxPlies),
    scoreParserVersion: Number(scoreParserVersion),
  };
}

export function engineIdentityKey(identity) {
  return [
    identity?.stockfishSha256 || "",
    identity?.uciIdName ?? "",
    identity?.uciIdAuthor ?? "",
    identity?.depth,
    identity?.multipv,
    identity?.threads,
    identity?.hashMb,
    identity?.maxPlies,
    identity?.scoreParserVersion ?? SCORE_PARSER_VERSION,
  ].join("|");
}

export function identitiesMatch(expected, actual) {
  if (!expected || !actual) return false;
  return engineIdentityKey(expected) === engineIdentityKey(actual);
}

/** MultiPV top-lines cache key — distinct from root-move restriction keys. */
export function buildTopCacheKey({ epd, identity }) {
  const engineSha = identity?.stockfishSha256 || "unknown";
  return `v2|top|${engineSha}|d${identity.depth}|m${identity.multipv}|${epd}`;
}

/** Root-move restricted evaluation cache key. */
export function buildRootMoveCacheKey({ epd, playedUci, identity }) {
  const engineSha = identity?.stockfishSha256 || "unknown";
  return `v2|rootmove|${engineSha}|d${identity.depth}|${epd}|${playedUci}`;
}

export function extractProtocolEngineConfig(protocol) {
  const engine = protocol?.engine;
  if (!engine) throw new Error("confirmatory mode requires protocol.engine settings");
  return {
    stockfishSha256: String(engine.sha256 || ""),
    relativePath: engine.relativePath ?? null,
    depth: Number(engine.depth),
    multipv: Number(engine.multipv),
    maxPlies: Number(engine.maxPlies),
    threads: Number(engine.threads),
    hashMb: Number(engine.hashMb),
  };
}

export function assertConfirmatoryEngineConfig(args, protocol) {
  const expected = extractProtocolEngineConfig(protocol);
  const mismatches = [];
  const check = (field, actual, expectedValue) => {
    if (actual !== expectedValue) mismatches.push({ field, actual, expected: expectedValue });
  };
  check("depth", Number(args.depth), expected.depth);
  check("multipv", Number(args.multipv), expected.multipv);
  check("maxPlies", Number(args.maxPlies), expected.maxPlies);
  check("threads", Number(args.threads), expected.threads);
  check("hash", Number(args.hash), expected.hashMb);
  if (args.stockfishSha256) {
    check("stockfishSha256", String(args.stockfishSha256), expected.stockfishSha256);
  }
  if (mismatches.length) {
    throw new Error(
      `confirmatory engine config mismatch: ${mismatches.map((m) => `${m.field}=${m.actual} expected ${m.expected}`).join("; ")}`,
    );
  }
  return expected;
}

export function rejectConfirmatoryLimitGames(limitGames, confirmatory) {
  if (!confirmatory) return;
  if (Number.isFinite(limitGames) && limitGames !== Infinity) {
    throw new Error("confirmatory mode rejects --limit-games");
  }
}

/** Confirmatory labeling must cover the full frozen partition acquisition scope. */
export function assertConfirmatoryAcquisitionScope({ color, speed } = {}) {
  if (color !== "both") {
    throw new Error(`confirmatory mode requires --color both (got ${color})`);
  }
  if (speed !== "all") {
    throw new Error(`confirmatory mode requires --speed all (got ${speed})`);
  }
}

export function detectConfirmatoryStudyKind(protocol) {
  const kind = protocol?.kind;
  if (kind === C1_PROTOCOL_KIND) return CONFIRMATORY_STUDY_KIND_C1;
  if (kind === HISTORICAL_PROTOCOL_KIND) return CONFIRMATORY_STUDY_KIND_HR1;
  throw new Error(`unsupported confirmatory protocol kind: ${kind}`);
}

export function expectedPartitionKindForProtocol(protocol) {
  const studyKind = detectConfirmatoryStudyKind(protocol);
  return studyKind === CONFIRMATORY_STUDY_KIND_C1
    ? C1_PARTITION_KIND
    : HISTORICAL_PARTITION_KIND;
}

export function assertConfirmatoryProtocolPartitionKindMatch(protocol, partitionManifest) {
  const expected = expectedPartitionKindForProtocol(protocol);
  const actual = partitionManifest?.kind;
  if (actual !== expected) {
    throw new Error(
      `confirmatory protocol/partition kind mismatch: protocol ${protocol?.kind} requires partition ${expected} got ${actual}`,
    );
  }
}

export function validateImmutableHistoricalR1Partition(manifest) {
  if (manifest?.kind !== HISTORICAL_PARTITION_KIND) {
    throw new Error(`partition manifest must be kind ${HISTORICAL_PARTITION_KIND}`);
  }
  if (!manifest?.immutable) {
    throw new Error("confirmatory mode requires an immutable H-R1 partition manifest");
  }
  if (!Array.isArray(manifest?.gameIds) || !manifest.gameIds.length) {
    throw new Error("partition manifest missing gameIds");
  }
  return manifest;
}

export function validateImmutableConfirmatoryPartition(manifest, expectedKind) {
  if (expectedKind === C1_PARTITION_KIND) return validateImmutableC1Partition(manifest);
  if (expectedKind === HISTORICAL_PARTITION_KIND) return validateImmutableHistoricalR1Partition(manifest);
  throw new Error(`unsupported confirmatory partition kind: ${expectedKind}`);
}

export function assertConfirmatoryHistoricalProductAuthorization(protocol) {
  if (detectConfirmatoryStudyKind(protocol) !== CONFIRMATORY_STUDY_KIND_HR1) return;
  if (protocol?.productAuthorization !== false) {
    throw new Error("H-R1 confirmatory mode requires productAuthorization false");
  }
}

/**
 * Pin partition manifest to the current protocol file before observations or engine work.
 */
export function assertConfirmatoryPartitionProvenance(partitionManifest, {
  protocol = null,
  protocolId = protocol?.protocolId ?? null,
  protocolSha256,
} = {}) {
  if (!protocol) {
    throw new Error("confirmatory mode requires protocol document");
  }
  assertConfirmatoryProtocolPartitionKindMatch(protocol, partitionManifest);
  assertConfirmatoryHistoricalProductAuthorization(protocol);
  const expectedKind = expectedPartitionKindForProtocol(protocol);
  const manifest = validateImmutableConfirmatoryPartition(partitionManifest, expectedKind);
  if (!protocolSha256) {
    throw new Error("confirmatory mode requires current protocol file sha256");
  }
  if (!manifest.protocolSha256) {
    throw new Error("partition manifest missing protocolSha256");
  }
  const shaCheck = verifyProtocolSha256({
    expectedSha256: protocolSha256,
    actualSha256: manifest.protocolSha256,
  });
  if (!shaCheck.ok) {
    throw new Error(`partition protocol sha mismatch: ${shaCheck.kind}`);
  }
  if (!protocolId) {
    throw new Error("confirmatory mode requires protocol id");
  }
  if (manifest.protocolId !== protocolId) {
    throw new Error(
      `partition protocol id mismatch: expected ${protocolId} got ${manifest.protocolId}`,
    );
  }
  return manifest;
}

/** Confirmatory cache load/save requires a successful UCI id name query. */
export function assertConfirmatoryUciIdentity(uciIdentity) {
  const name = String(uciIdentity?.uciIdName ?? "").trim();
  if (!name) {
    throw new Error("confirmatory mode requires successful UCI id name query");
  }
  return {
    uciIdName: name,
    uciIdAuthor: uciIdentity?.uciIdAuthor ?? null,
  };
}

export function validateImmutableC1Partition(manifest) {
  if (manifest?.kind !== C1_PARTITION_KIND) {
    throw new Error(`partition manifest must be kind ${C1_PARTITION_KIND}`);
  }
  if (!manifest?.immutable) {
    throw new Error("confirmatory mode requires an immutable C1 partition manifest");
  }
  if (!Array.isArray(manifest?.gameIds) || !manifest.gameIds.length) {
    throw new Error("partition manifest missing gameIds");
  }
  return manifest;
}

/**
 * Resolve confirmatory input games: exact partition membership, deterministic ordering.
 * @returns {{ games: object[], gamesInputSha256: string }}
 */
export function resolveConfirmatoryPartitionGames(allGames, partitionManifest, { protocol = null } = {}) {
  let manifest;
  if (protocol) {
    const expectedKind = expectedPartitionKindForProtocol(protocol);
    manifest = validateImmutableConfirmatoryPartition(partitionManifest, expectedKind);
  } else {
    manifest = validateImmutableC1Partition(partitionManifest);
  }
  const byId = new Map();
  const duplicateIds = [];

  for (const game of allGames || []) {
    const gameId = String(game?.gameId || "");
    if (!gameId) continue;
    if (byId.has(gameId)) duplicateIds.push(gameId);
    else byId.set(gameId, game);
  }
  if (duplicateIds.length) {
    throw new Error(`input contains duplicate game ids: ${[...new Set(duplicateIds)].join(",")}`);
  }

  const expectedIds = manifest.gameIds;
  const inputIds = [...byId.keys()];
  const expectedSet = new Set(expectedIds);
  const missing = expectedIds.filter((id) => !byId.has(id));
  const extras = inputIds.filter((id) => !expectedSet.has(id));
  if (missing.length || extras.length) {
    throw new Error(
      `partition membership mismatch: missing=${missing.length} extras=${extras.length}`,
    );
  }

  const ordered = expectedIds.map((id) => byId.get(id));
  const sortedCheck = sortGamesByCreatedAt(ordered);
  const idCheck = verifyManifestGameIds(manifest, sortedCheck);
  if (!idCheck.ok) {
    throw new Error(`partition manifest game id verification failed: ${idCheck.kind}`);
  }

  const gamesInputSha256 = sha256Hex(sortedCheck.map((game) => canonicalizeGameRecord(game)));
  if (manifest.gamesSha256 && manifest.gamesSha256 !== gamesInputSha256) {
    throw new Error("partition gamesSha256 mismatch");
  }
  if (manifest.gameCount != null && manifest.gameCount !== sortedCheck.length) {
    throw new Error(`partition gameCount mismatch: expected ${manifest.gameCount} got ${sortedCheck.length}`);
  }
  if (manifest.counts) {
    const white = sortedCheck.filter((g) => g.color === "white").length;
    const black = sortedCheck.filter((g) => g.color === "black").length;
    if (manifest.counts.white != null && manifest.counts.white !== white) {
      throw new Error(`partition white count mismatch: expected ${manifest.counts.white} got ${white}`);
    }
    if (manifest.counts.black != null && manifest.counts.black !== black) {
      throw new Error(`partition black count mismatch: expected ${manifest.counts.black} got ${black}`);
    }
  }

  return { games: sortedCheck, gamesInputSha256 };
}

export function buildConfirmatoryProvenance({
  protocolSha256,
  partitionSha256,
  gamesInputSha256,
  partitionManifest = null,
  confirmatoryStudyKind = CONFIRMATORY_STUDY_KIND_C1,
  protocol = null,
} = {}) {
  const provenance = {
    confirmatory: true,
    protocolSha256,
    partitionSha256,
    gamesInputSha256,
    partitionGamesSha256: partitionManifest?.gamesSha256 ?? null,
    partitionGameCount: partitionManifest?.gameCount ?? null,
    partitionCounts: partitionManifest?.counts ?? null,
  };
  if (confirmatoryStudyKind === CONFIRMATORY_STUDY_KIND_HR1) {
    return {
      ...provenance,
      confirmatoryStudyKind: CONFIRMATORY_STUDY_KIND_HR1,
      role: protocol?.role ?? null,
      productAuthorization: false,
    };
  }
  return provenance;
}

export function validateCacheEntry(entry, mode) {
  if (entry == null) return { ok: false, reason: "missing-entry" };
  if (mode === "top") {
    if (!Array.isArray(entry) || !entry.length) return { ok: false, reason: "top-empty" };
    for (const row of entry) {
      if (!row?.score || !Array.isArray(row?.pv)) return { ok: false, reason: "top-malformed-row" };
    }
    return { ok: true };
  }
  if (mode === "rootmove") {
    if (!entry?.score) return { ok: false, reason: "rootmove-missing-score" };
    return { ok: true };
  }
  return { ok: false, reason: "unknown-mode" };
}

function isLegacyCacheDocument(parsed) {
  return parsed?.entries != null && parsed?.schemaVersion == null && parsed?.identity == null;
}

function parseCacheDocument(rawText) {
  try {
    return JSON.parse(rawText);
  } catch {
    return null;
  }
}

/**
 * Load engine cache. Confirmatory mode fails closed; legacy mode tolerates missing/malformed files.
 */
export function loadEngineCache(path, { identity, confirmatory = false } = {}) {
  if (!path || !existsSync(path)) {
    if (confirmatory) {
      return { map: new Map(), cacheHits: 0, created: true };
    }
    return { map: legacyLoadPermissive(path), cacheHits: 0, created: false };
  }

  const raw = readFileSync(path, "utf8");
  const parsed = parseCacheDocument(raw);
  if (!parsed) {
    if (confirmatory) throw new Error(`malformed engine cache: ${path}`);
    return { map: new Map(), cacheHits: 0, created: false };
  }

  if (isLegacyCacheDocument(parsed)) {
    if (confirmatory) {
      throw new Error("confirmatory mode rejects legacy v1 engine cache — delete cache or use a new path");
    }
    return { map: new Map(Object.entries(parsed.entries || {})), cacheHits: 0, created: false };
  }

  if (parsed.schemaVersion !== ENGINE_CACHE_SCHEMA_VERSION) {
    throw new Error(`unsupported engine cache schema version: ${parsed.schemaVersion}`);
  }
  if (!parsed.identity) {
    throw new Error("engine cache missing identity envelope");
  }
  if (!identitiesMatch(identity, parsed.identity)) {
    throw new Error("engine cache identity mismatch");
  }

  const map = new Map();
  for (const [key, value] of Object.entries(parsed.entries || {})) {
    const mode = key.includes("|rootmove|") ? "rootmove" : "top";
    const check = validateCacheEntry(value, mode);
    if (!check.ok) {
      throw new Error(`malformed engine cache entry for ${key}: ${check.reason}`);
    }
    map.set(key, value);
  }
  return { map, cacheHits: 0, created: false };
}

/** Legacy permissive loader — returns empty map on missing/invalid cache. */
export function legacyLoadPermissive(path) {
  if (!path || !existsSync(path)) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return new Map(Object.entries(parsed?.entries || {}));
  } catch {
    return new Map();
  }
}

export function serializeEngineCache(identity, entries) {
  return {
    schemaVersion: ENGINE_CACHE_SCHEMA_VERSION,
    identity,
    entries: Object.fromEntries(entries),
  };
}

export function saveEngineCacheAtomic(path, entries, identity) {
  if (!path) return;
  const payload = serializeEngineCache(identity, entries);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(payload)}\n`, "utf8");
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // best-effort replace on Windows
    }
  }
  renameSync(tmp, path);
}

/** Legacy cache save — preserves v1 meta shape for non-confirmatory runs. */
export function saveLegacyEngineCache(path, entries, meta) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ meta, entries: Object.fromEntries(entries) })}\n`, "utf8");
}

export function loadAndValidateProtocol(protocolPath, protocolBytes = null) {
  const raw = protocolBytes ?? readFileSync(protocolPath);
  const protocol = JSON.parse(raw.toString("utf8"));
  const protocolSha256 = sha256Buffer(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "utf8"));
  let validation;
  let confirmatoryStudyKind;
  if (protocol?.kind === C1_PROTOCOL_KIND) {
    validation = validateStudyProtocol(protocol);
    confirmatoryStudyKind = CONFIRMATORY_STUDY_KIND_C1;
  } else if (protocol?.kind === HISTORICAL_PROTOCOL_KIND) {
    validation = validateHistoricalProtocol(protocol);
    confirmatoryStudyKind = CONFIRMATORY_STUDY_KIND_HR1;
  } else {
    throw new Error(`unsupported confirmatory protocol kind: ${protocol?.kind}`);
  }
  if (!validation.ok) {
    throw new Error(`invalid protocol: ${validation.errors.join("; ")}`);
  }
  return { protocol, validation, protocolSha256, confirmatoryStudyKind };
}

/**
 * Best-effort UCI `id name` / `id author` query before labeling.
 * Returns nulls when the engine does not respond in time.
 */
export function queryUciEngineIdentity(exePath, { threads = 4, hash = 256, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const proc = spawn(exePath, [], { stdio: ["pipe", "pipe", "pipe"] });
    const done = (result) => {
      if (settled) return;
      settled = true;
      try {
        proc.stdin.write("quit\n");
      } catch {
        /* ignore */
      }
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      if (buf.includes("uciok")) {
        const idName = buf.match(/^id name (.+)$/m)?.[1]?.trim() ?? null;
        const idAuthor = buf.match(/^id author (.+)$/m)?.[1]?.trim() ?? null;
        done({ uciIdName: idName, uciIdAuthor: idAuthor });
      }
    });
    proc.on("error", () => done({ uciIdName: null, uciIdAuthor: null }));
    try {
      proc.stdin.write(
        `uci\nsetoption name Threads value ${threads}\nsetoption name Hash value ${hash}\n`,
      );
    } catch {
      done({ uciIdName: null, uciIdAuthor: null });
      return;
    }
    setTimeout(() => done({ uciIdName: null, uciIdAuthor: null }), timeoutMs);
  });
}

/** Legacy v1 cache keys for non-confirmatory decision dumps. */
export function buildLegacyTopCacheKey({ epd, depth, multipv }) {
  return `top|${epd}|d${depth}|m${multipv}`;
}

export function buildLegacyRootMoveCacheKey({ epd, playedUci, depth }) {
  return `rootmove|${epd}|${playedUci}|d${depth}`;
}