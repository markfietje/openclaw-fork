// Session artifact filename classifiers and archive timestamp helpers.
// Cleanup, disk-budget, and usage accounting use these predicates to avoid deleting live transcripts.

import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { timestampMsToIsoFileStamp } from "@openclaw/normalization-core/number-coercion";
import { escapeRegExp } from "../../shared/regexp.js";

export type SessionArchiveReason = "bak" | "reset" | "deleted";

const ARCHIVE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z$/;
const LEGACY_STORE_BACKUP_RE = /^sessions\.json\.bak\.\d+$/;
const COMPACTION_CHECKPOINT_TRANSCRIPT_RE =
  /^(.+)\.checkpoint\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i;

function hasArchiveSuffix(fileName: string, reason: SessionArchiveReason): boolean {
  const marker = `.${reason}.`;
  const index = fileName.lastIndexOf(marker);
  if (index < 0) {
    return false;
  }
  const raw = fileName.slice(index + marker.length);
  return ARCHIVE_TIMESTAMP_RE.test(raw);
}

/** Returns true for archived session artifacts and legacy store backup names. */
export function isSessionArchiveArtifactName(fileName: string): boolean {
  if (LEGACY_STORE_BACKUP_RE.test(fileName)) {
    return true;
  }
  return (
    hasArchiveSuffix(fileName, "deleted") ||
    hasArchiveSuffix(fileName, "reset") ||
    hasArchiveSuffix(fileName, "bak")
  );
}

// Compiled-pattern cache keyed by store basename. A disk sweep calls the matcher
// once per file, so compiling the per-store pattern once (basenames are few — one
// per agent store) keeps the hot path allocation-free.
const SESSION_STORE_TEMP_RE_CACHE = new Map<string, RegExp>();

function sessionStoreTempPattern(storeBasename: string): RegExp {
  let pattern = SESSION_STORE_TEMP_RE_CACHE.get(storeBasename);
  if (!pattern) {
    pattern = new RegExp(
      `^${escapeRegExp(storeBasename)}\\.(?:\\d+\\.)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$`,
      "i",
    );
    SESSION_STORE_TEMP_RE_CACHE.set(storeBasename, pattern);
  }
  return pattern;
}

// Atomic writes of the session store stage into `<store>.<pid>.<uuid>.tmp`
// (legacy: `<store>.<uuid>.tmp`) and rename into place. A crash between write and
// rename orphans the temp; these accumulate and waste disk (#56827). They are
// never the live store, so a stale one is safe to reclaim. `storeBasename` is the
// store filename (the atomic write's temp prefix, e.g. `sessions.json`), so a
// custom-named `session.store` is matched too.
export function isSessionStoreTempArtifactName(fileName: string, storeBasename: string): boolean {
  if (!storeBasename) {
    return false;
  }
  return sessionStoreTempPattern(storeBasename).test(fileName);
}

/** Parses a compaction checkpoint transcript filename into session/checkpoint ids. */
export function parseCompactionCheckpointTranscriptFileName(fileName: string): {
  sessionId: string;
  checkpointId: string;
} | null {
  const match = COMPACTION_CHECKPOINT_TRANSCRIPT_RE.exec(fileName);
  const sessionId = match?.[1];
  const checkpointId = match?.[2];
  return sessionId && checkpointId ? { sessionId, checkpointId } : null;
}

/** Returns true when a filename is a compaction checkpoint transcript. */
export function isCompactionCheckpointTranscriptFileName(fileName: string): boolean {
  return parseCompactionCheckpointTranscriptFileName(fileName) !== null;
}

/** Returns true for trajectory runtime jsonl artifacts. */
export function isTrajectoryRuntimeArtifactName(fileName: string): boolean {
  return fileName.endsWith(".trajectory.jsonl");
}

/** Returns true for trajectory pointer artifacts. */
export function isTrajectoryPointerArtifactName(fileName: string): boolean {
  return fileName.endsWith(".trajectory-path.json");
}

/** Returns true for any trajectory-related session artifact. */
export function isTrajectorySessionArtifactName(fileName: string): boolean {
  return isTrajectoryRuntimeArtifactName(fileName) || isTrajectoryPointerArtifactName(fileName);
}

/** Returns true for primary session transcript files that represent live session history. */
export function isPrimarySessionTranscriptFileName(fileName: string): boolean {
  if (fileName === "sessions.json") {
    return false;
  }
  if (!fileName.endsWith(".jsonl")) {
    return false;
  }
  if (isTrajectoryRuntimeArtifactName(fileName)) {
    return false;
  }
  if (isCompactionCheckpointTranscriptFileName(fileName)) {
    return false;
  }
  return !isSessionArchiveArtifactName(fileName);
}

/** Returns true for transcript files counted in usage, including reset/deleted archives. */
export function isUsageCountedSessionTranscriptFileName(fileName: string): boolean {
  if (isPrimarySessionTranscriptFileName(fileName)) {
    return true;
  }
  return hasArchiveSuffix(fileName, "reset") || hasArchiveSuffix(fileName, "deleted");
}

/** Extracts the session id from a usage-counted transcript filename. */
export function parseUsageCountedSessionIdFromFileName(fileName: string): string | null {
  if (isPrimarySessionTranscriptFileName(fileName)) {
    return fileName.slice(0, -".jsonl".length);
  }
  for (const reason of ["reset", "deleted"] as const) {
    const marker = `.jsonl.${reason}.`;
    const index = fileName.lastIndexOf(marker);
    if (index > 0 && hasArchiveSuffix(fileName, reason)) {
      return fileName.slice(0, index);
    }
  }
  return null;
}

type UsageFamilyHeaderLike = {
  type?: unknown;
  id?: unknown;
  usageFamilyKey?: unknown;
  parentSession?: unknown;
};

const USAGE_FAMILY_HEADER_READ_BYTES = 64 * 1024;

function readUsageFamilyHeaderFromFile(filePath: string): UsageFamilyHeaderLike | undefined {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.allocUnsafe(Math.min(8192, USAGE_FAMILY_HEADER_READ_BYTES));
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes < USAGE_FAMILY_HEADER_READ_BYTES) {
      const bytesToRead = Math.min(buffer.length, USAGE_FAMILY_HEADER_READ_BYTES - totalBytes);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, totalBytes);
      if (bytesRead === 0) {
        break;
      }
      const newlineIndex = buffer.subarray(0, bytesRead).indexOf(0x0a);
      if (newlineIndex >= 0) {
        chunks.push(Buffer.from(buffer.subarray(0, newlineIndex)));
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      totalBytes += bytesRead;
    }
    if (chunks.length === 0) {
      return undefined;
    }
    const header = JSON.parse(Buffer.concat(chunks).toString("utf8")) as UsageFamilyHeaderLike;
    return header.type === "session" && typeof header.id === "string" ? header : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** Resolves the canonical usage family a copied transcript should keep using. */
export function resolveSessionHeaderUsageFamilyKey(params: {
  header?: UsageFamilyHeaderLike | null;
  parentSession?: string;
  resolveParentUsageFamilyKey?: (parentSession: string) => string | undefined;
}): string | undefined {
  const explicit =
    typeof params.header?.usageFamilyKey === "string" ? params.header.usageFamilyKey.trim() : "";
  if (explicit) {
    return explicit;
  }
  const parentSession =
    (typeof params.header?.parentSession === "string" ? params.header.parentSession.trim() : "") ||
    params.parentSession?.trim() ||
    "";
  if (!parentSession) {
    return undefined;
  }
  const parentUsageFamilyKey = params.resolveParentUsageFamilyKey?.(parentSession);
  if (parentUsageFamilyKey) {
    return parentUsageFamilyKey;
  }
  return parseUsageCountedSessionIdFromFileName(path.basename(parentSession)) ?? undefined;
}

function resolveSessionFileUsageFamilyKeyInner(params: {
  header?: UsageFamilyHeaderLike | null;
  sessionFile: string;
  visited: Set<string>;
}): string | undefined {
  const sessionFile = path.resolve(params.sessionFile);
  if (params.visited.has(sessionFile)) {
    return undefined;
  }
  params.visited.add(sessionFile);
  return resolveSessionHeaderUsageFamilyKey({
    header: params.header,
    parentSession: sessionFile,
    resolveParentUsageFamilyKey: (parentSession) => {
      const parentPath = path.isAbsolute(parentSession)
        ? parentSession
        : path.resolve(path.dirname(sessionFile), parentSession);
      const parentHeader = readUsageFamilyHeaderFromFile(parentPath);
      if (!parentHeader) {
        return undefined;
      }
      return resolveSessionFileUsageFamilyKeyInner({
        header: parentHeader,
        sessionFile: parentPath,
        visited: params.visited,
      });
    },
  });
}

/** Resolves the persisted usage family for a transcript file by following parent headers. */
export function resolveSessionFileUsageFamilyKey(params: {
  header?: UsageFamilyHeaderLike | null;
  sessionFile: string;
}): string | undefined {
  return resolveSessionFileUsageFamilyKeyInner({
    header: params.header,
    sessionFile: params.sessionFile,
    visited: new Set<string>(),
  });
}

/** Formats an archive timestamp that is safe for filenames. */
export function formatSessionArchiveTimestamp(nowMs = Date.now()): string {
  return timestampMsToIsoFileStamp(nowMs);
}

function restoreSessionArchiveTimestamp(raw: string): string {
  const [datePart, timePart] = raw.split("T");
  if (!datePart || !timePart) {
    return raw;
  }
  return `${datePart}T${timePart.replace(/-/g, ":")}`;
}

export function parseSessionArchiveTimestamp(
  fileName: string,
  reason: SessionArchiveReason,
): number | null {
  const marker = `.${reason}.`;
  const index = fileName.lastIndexOf(marker);
  if (index < 0) {
    return null;
  }
  const raw = fileName.slice(index + marker.length);
  if (!raw) {
    return null;
  }
  if (!ARCHIVE_TIMESTAMP_RE.test(raw)) {
    return null;
  }
  const timestamp = Date.parse(restoreSessionArchiveTimestamp(raw));
  return Number.isNaN(timestamp) ? null : timestamp;
}
