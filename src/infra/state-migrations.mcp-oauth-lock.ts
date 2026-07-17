import { randomUUID } from "node:crypto";
import type { Root } from "@openclaw/fs-safe";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import { isLockOwnerDefinitelyStale } from "./stale-lock-file.js";

const LOCK_RETRIES = 20;
const LOCK_RETRY_FACTOR = 1.3;
const LOCK_RETRY_MIN_MS = 25;
const LOCK_RETRY_MAX_MS = 500;
const LEGACY_LOCK_STALE_MS = 60_000;
const MAX_LEGACY_LOCK_BYTES = 64 * 1024;

function retryDelayMs(attempt: number): number {
  return Math.min(
    LOCK_RETRY_MAX_MS,
    Math.max(LOCK_RETRY_MIN_MS, LOCK_RETRY_MIN_MS * LOCK_RETRY_FACTOR ** attempt),
  );
}

function createLockPayload(): string {
  const payload: Record<string, unknown> = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    nonce: randomUUID(),
  };
  const starttime = getFileLockProcessStartTime(process.pid);
  if (starttime !== null) {
    payload.starttime = starttime;
  }
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function isAlreadyExists(error: unknown): boolean {
  return (error as { code?: unknown }).code === "already-exists";
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "not-found";
}

function parseLockPayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Classify only retired-runtime owners whose age and process identity are provably stale. */
export function isDefinitelyStaleLegacyMcpOAuthLock(params: {
  raw: string;
  nowMs?: number;
  isPidDefinitelyDead?: (pid: number) => boolean;
  getProcessStartTime?: (pid: number) => number | null;
}): boolean {
  const payload = parseLockPayload(params.raw);
  if (!payload) {
    return false;
  }
  const pid = payload.pid;
  const createdAt = payload.createdAt;
  const starttime = payload.starttime;
  if (
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof createdAt !== "string" ||
    (starttime !== undefined &&
      (typeof starttime !== "number" || !Number.isSafeInteger(starttime) || starttime < 0))
  ) {
    return false;
  }
  const createdAtMs = Date.parse(createdAt);
  const ageMs = (params.nowMs ?? Date.now()) - createdAtMs;
  if (
    !Number.isFinite(createdAtMs) ||
    new Date(createdAtMs).toISOString() !== createdAt ||
    !Number.isFinite(ageMs) ||
    ageMs < LEGACY_LOCK_STALE_MS
  ) {
    return false;
  }
  return isLockOwnerDefinitelyStale({
    payload,
    isPidDefinitelyDead: params.isPidDefinitelyDead ?? isPidDefinitelyDead,
    getProcessStartTime: params.getProcessStartTime ?? getFileLockProcessStartTime,
  });
}

async function hasDefinitelyStaleLock(params: {
  stateRoot: Root;
  lockRelativePath: string;
}): Promise<boolean> {
  try {
    const observed = await params.stateRoot.read(params.lockRelativePath, {
      maxBytes: MAX_LEGACY_LOCK_BYTES,
    });
    return isDefinitelyStaleLegacyMcpOAuthLock({ raw: observed.buffer.toString("utf8") });
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

async function acquireRootBoundedLegacyLock(params: {
  stateRoot: Root;
  targetRelativePath: string;
}): Promise<() => Promise<void>> {
  const lockRelativePath = `${params.targetRelativePath}.lock`;
  const raw = createLockPayload();
  for (let attempt = 0; ; attempt += 1) {
    try {
      // Root.create pins the parent directory and uses no-clobber semantics, so
      // a directory swap cannot redirect the retired runtime's sidecar outside stateDir.
      await params.stateRoot.create(lockRelativePath, raw, { mode: 0o600 });
      break;
    } catch (error) {
      if (!isAlreadyExists(error) || attempt >= LOCK_RETRIES) {
        if (isAlreadyExists(error)) {
          throw new Error(`file lock timeout for ${params.targetRelativePath}`, {
            cause: error,
          });
        }
        throw error;
      }
      if (
        await hasDefinitelyStaleLock({
          stateRoot: params.stateRoot,
          lockRelativePath,
        })
      ) {
        // POSIX path removal cannot be fenced against a replacement owner.
        // Security-sensitive migration therefore reports stale proof but never unlinks it.
        throw Object.assign(new Error(`file lock stale for ${params.targetRelativePath}`), {
          code: "file_lock_stale",
        });
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, retryDelayMs(attempt));
      });
    }
  }

  return async () => {
    const current = await params.stateRoot.readText(lockRelativePath);
    if (current !== raw) {
      throw new Error(`legacy file lock ownership changed for ${params.targetRelativePath}`);
    }
    await params.stateRoot.remove(lockRelativePath);
  };
}

/** Share the retired runtime's sidecar protocol without leaving the pinned state root. */
export async function withRootBoundedLegacyFileLock<T>(
  params: { stateRoot: Root; targetRelativePath: string },
  run: () => Promise<T>,
): Promise<T> {
  const release = await acquireRootBoundedLegacyLock(params);
  try {
    return await run();
  } finally {
    await release();
  }
}
