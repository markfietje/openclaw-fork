// Signal plugin module tracks native-reply quote authors for durable sends.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeSignalMessagingTarget } from "./normalize.js";
import { getOptionalSignalRuntime } from "./runtime.js";

const PERSISTENT_NAMESPACE = "signal.reply-authors.v1";
const PERSISTENT_MAX_ENTRIES = 5000;
const DEFAULT_REPLY_AUTHOR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type SignalReplyContextRecord = {
  author: string;
  body?: string;
  accountId: string;
  conversationKey: string;
  replyToId: string;
  sourceTimestamp: number;
  registeredAt: number;
};

type MemoryReplyContextRecord = SignalReplyContextRecord & {
  expiresAt: number;
};

export type SignalPersistedReplyContext = Pick<SignalReplyContextRecord, "author" | "body">;

const memoryReplyContexts = new Map<string, MemoryReplyContextRecord>();
let persistentStoreDisabled = false;

function openSignalReplyAuthorStore() {
  if (persistentStoreDisabled) {
    return undefined;
  }
  const runtime = getOptionalSignalRuntime();
  try {
    return runtime?.state.openKeyedStore<SignalReplyContextRecord>({
      namespace: PERSISTENT_NAMESPACE,
      maxEntries: PERSISTENT_MAX_ENTRIES,
      defaultTtlMs: DEFAULT_REPLY_AUTHOR_TTL_MS,
    });
  } catch (error) {
    persistentStoreDisabled = true;
    runtime?.logging
      .getChildLogger({ plugin: "signal", feature: "reply-author-state" })
      .warn("Signal persistent reply author state unavailable", { error: String(error) });
    return undefined;
  }
}

function buildSignalReplyAuthorStoreKey(params: {
  accountId?: string | null;
  to: string;
  replyToId?: string | null;
}): string | undefined {
  const conversationKey = normalizeSignalMessagingTarget(params.to);
  const replyToId = normalizeOptionalString(params.replyToId);
  if (!conversationKey || !replyToId) {
    return undefined;
  }
  const accountKey = normalizeLowercaseStringOrEmpty(
    normalizeOptionalString(params.accountId) ?? DEFAULT_ACCOUNT_ID,
  );
  return `account=${accountKey}|to=${conversationKey}|id=${replyToId}`;
}

function pruneMemoryReplyContexts(now = Date.now()): void {
  for (const [key, record] of memoryReplyContexts) {
    if (record.expiresAt <= now) {
      memoryReplyContexts.delete(key);
    }
  }
  while (memoryReplyContexts.size > PERSISTENT_MAX_ENTRIES) {
    const oldestKey = memoryReplyContexts.keys().next().value;
    if (!oldestKey) {
      break;
    }
    memoryReplyContexts.delete(oldestKey);
  }
}

function resolveReplyContext(
  record: SignalReplyContextRecord | undefined,
): SignalPersistedReplyContext | undefined {
  const author = normalizeOptionalString(record?.author);
  if (!author) {
    return undefined;
  }
  const body = normalizeOptionalString(record?.body);
  return {
    author,
    ...(body ? { body } : {}),
  };
}

function resolveSourceTimestamp(value: number | null | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : Date.now();
}

function shouldReplaceReplyContext(
  current: SignalReplyContextRecord | undefined,
  sourceTimestamp: number,
): boolean {
  return sourceTimestamp >= (current?.sourceTimestamp ?? 0);
}

export async function registerSignalReplyAuthorForInboundMessage(params: {
  accountId?: string | null;
  to: string;
  replyToId?: string | null;
  author?: string | null;
  body?: string | null;
  sourceTimestamp?: number | null;
}): Promise<void> {
  const store = openSignalReplyAuthorStore();
  const key = buildSignalReplyAuthorStoreKey(params);
  const author = normalizeOptionalString(params.author);
  const body = normalizeOptionalString(params.body);
  const conversationKey = normalizeSignalMessagingTarget(params.to);
  const replyToId = normalizeOptionalString(params.replyToId);
  const accountKey = normalizeLowercaseStringOrEmpty(
    normalizeOptionalString(params.accountId) ?? DEFAULT_ACCOUNT_ID,
  );
  const sourceTimestamp = resolveSourceTimestamp(params.sourceTimestamp);
  if (!store || !key || !author || !conversationKey || !replyToId) {
    if (key && author && conversationKey && replyToId) {
      const registeredAt = Date.now();
      const record = {
        author,
        ...(body ? { body } : {}),
        accountId: accountKey,
        conversationKey,
        replyToId,
        sourceTimestamp,
        registeredAt,
        expiresAt: registeredAt + DEFAULT_REPLY_AUTHOR_TTL_MS,
      };
      if (shouldReplaceReplyContext(memoryReplyContexts.get(key), sourceTimestamp)) {
        memoryReplyContexts.set(key, record);
      }
      pruneMemoryReplyContexts(registeredAt);
    }
    return;
  }
  const registeredAt = Date.now();
  const record = {
    author,
    ...(body ? { body } : {}),
    accountId: accountKey,
    conversationKey,
    replyToId,
    sourceTimestamp,
    registeredAt,
    expiresAt: registeredAt + DEFAULT_REPLY_AUTHOR_TTL_MS,
  };
  if (!store.update) {
    if (shouldReplaceReplyContext(memoryReplyContexts.get(key), sourceTimestamp)) {
      memoryReplyContexts.set(key, record);
    }
    pruneMemoryReplyContexts(registeredAt);
    persistentStoreDisabled = true;
    getOptionalSignalRuntime()
      ?.logging.getChildLogger({ plugin: "signal", feature: "reply-author-state" })
      .warn("Signal persistent reply author state lacks atomic updates");
    return;
  }
  try {
    const updated = await store.update(key, (current) =>
      shouldReplaceReplyContext(current, sourceTimestamp)
        ? {
            author,
            ...(body ? { body } : {}),
            accountId: accountKey,
            conversationKey,
            replyToId,
            sourceTimestamp,
            registeredAt,
          }
        : undefined,
    );
    if (updated) {
      if (shouldReplaceReplyContext(memoryReplyContexts.get(key), sourceTimestamp)) {
        memoryReplyContexts.set(key, record);
      }
    } else {
      memoryReplyContexts.delete(key);
    }
    pruneMemoryReplyContexts(registeredAt);
  } catch (error) {
    if (shouldReplaceReplyContext(memoryReplyContexts.get(key), sourceTimestamp)) {
      memoryReplyContexts.set(key, record);
    }
    pruneMemoryReplyContexts(registeredAt);
    getOptionalSignalRuntime()
      ?.logging.getChildLogger({ plugin: "signal", feature: "reply-author-state" })
      .warn("Signal persistent reply author state failed", { error: String(error) });
  }
}

export async function resolveSignalReplyContextWithPersistence(params: {
  accountId?: string | null;
  to: string;
  replyToId?: string | null;
}): Promise<SignalPersistedReplyContext | undefined> {
  const store = openSignalReplyAuthorStore();
  const key = buildSignalReplyAuthorStoreKey(params);
  if (!key) {
    return undefined;
  }
  if (!store) {
    pruneMemoryReplyContexts();
    return resolveReplyContext(memoryReplyContexts.get(key));
  }
  pruneMemoryReplyContexts();
  const memoryContext = resolveReplyContext(memoryReplyContexts.get(key));
  if (memoryContext) {
    return memoryContext;
  }
  try {
    return resolveReplyContext(await store.lookup(key));
  } catch (error) {
    getOptionalSignalRuntime()
      ?.logging.getChildLogger({ plugin: "signal", feature: "reply-author-state" })
      .warn("Signal persistent reply author lookup failed", { error: String(error) });
    return undefined;
  }
}

export async function clearSignalReplyAuthorsForTest(): Promise<void> {
  memoryReplyContexts.clear();
  persistentStoreDisabled = false;
  await openSignalReplyAuthorStore()?.clear();
}
