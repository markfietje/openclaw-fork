import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-resolution";
// Signal compatibility migration moves shipped flat transport config into account ownership.
import type { ChannelDoctorConfigMutation } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SignalTransportConfig } from "./account-types.js";
import {
  allocateSignalManagedNativePort,
  DEFAULT_SIGNAL_MANAGED_NATIVE_PORT,
  resolveLocalSignalTransportPort,
} from "./transport-policy.js";
import { normalizeSignalTransportUrl } from "./transport-url.js";

const LEGACY_TRANSPORT_FIELDS = [
  "configPath",
  "httpUrl",
  "httpHost",
  "httpPort",
  "cliPath",
  "autoStart",
  "startupTimeoutMs",
  "receiveMode",
  "ignoreStories",
] as const;

const PENDING_LEGACY_TRANSPORT_WARNING =
  "- channels.signal: legacy auto transport needs a reachable daemon before it can be migrated; start the configured endpoint, then run openclaw doctor --fix.";

type DetectTransport = (params: {
  url: string;
  account?: string;
}) => Promise<SignalTransportConfig>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSignalTransportConfig(value: unknown): value is SignalTransportConfig {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "managed-native") {
    return true;
  }
  return (
    (value.kind === "external-native" || value.kind === "container") &&
    typeof value.url === "string"
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function inherited(entry: Record<string, unknown>, parent: Record<string, unknown>, key: string) {
  return Object.hasOwn(entry, key) ? entry[key] : parent[key];
}

function legacyBaseUrl(entry: Record<string, unknown>, parent: Record<string, unknown>): string {
  const url = optionalString(inherited(entry, parent, "httpUrl"));
  if (url) {
    return normalizeSignalTransportUrl(url);
  }
  const host = optionalString(inherited(entry, parent, "httpHost")) ?? "127.0.0.1";
  const rawPort = inherited(entry, parent, "httpPort");
  const port = typeof rawPort === "number" ? rawPort : 8080;
  return `http://${host}:${port}`;
}

function hasLegacyFields(entry: Record<string, unknown>): boolean {
  return LEGACY_TRANSPORT_FIELDS.some((field) => Object.hasOwn(entry, field));
}

function requiresDetection(
  entry: Record<string, unknown>,
  parent: Record<string, unknown>,
  apiMode: unknown,
): boolean {
  return (apiMode === undefined || apiMode === "auto") && !resolveLegacyAutoStart(entry, parent);
}

function resolveLegacyAutoStart(
  entry: Record<string, unknown>,
  parent: Record<string, unknown>,
): boolean {
  const autoStart = inherited(entry, parent, "autoStart");
  if (typeof autoStart === "boolean") {
    return autoStart;
  }
  return !optionalString(inherited(entry, parent, "httpUrl"));
}

function buildManagedNativeTransport(
  entry: Record<string, unknown>,
  parent: Record<string, unknown>,
): SignalTransportConfig {
  const value = (key: string) => inherited(entry, parent, key);
  const configPath = optionalString(value("configPath"));
  const cliPath = optionalString(value("cliPath"));
  let httpHost = optionalString(value("httpHost"));
  let httpPort = value("httpPort");
  const httpUrl = optionalString(value("httpUrl"));
  if (httpUrl && (!httpHost || typeof httpPort !== "number")) {
    const parsed = new URL(normalizeSignalTransportUrl(httpUrl));
    httpHost ??= parsed.hostname;
    httpPort =
      typeof httpPort === "number"
        ? httpPort
        : parsed.port
          ? Number.parseInt(parsed.port, 10)
          : parsed.protocol === "https:"
            ? 443
            : 80;
  }
  const startupTimeoutMs = value("startupTimeoutMs");
  const receiveMode = value("receiveMode");
  const ignoreStories = value("ignoreStories");
  return {
    kind: "managed-native",
    ...(configPath ? { configPath } : {}),
    ...(cliPath ? { cliPath } : {}),
    ...(httpHost ? { httpHost } : {}),
    ...(typeof httpPort === "number" ? { httpPort } : {}),
    ...(typeof startupTimeoutMs === "number" ? { startupTimeoutMs } : {}),
    ...(receiveMode === "on-start" || receiveMode === "manual" ? { receiveMode } : {}),
    ...(typeof ignoreStories === "boolean" ? { ignoreStories } : {}),
  };
}

function resolveLegacyTransportWithoutDetection(params: {
  entry: Record<string, unknown>;
  parent: Record<string, unknown>;
  apiMode: unknown;
}): SignalTransportConfig | undefined {
  if (isSignalTransportConfig(params.entry.transport)) {
    return params.entry.transport;
  }
  const baseUrl = legacyBaseUrl(params.entry, params.parent);
  const autoStart = inherited(params.entry, params.parent, "autoStart");
  if (params.apiMode === "container") {
    return { kind: "container", url: baseUrl };
  }
  if (params.apiMode === "native") {
    return resolveLegacyAutoStart(params.entry, params.parent)
      ? buildManagedNativeTransport(params.entry, params.parent)
      : { kind: "external-native", url: baseUrl };
  }
  if (requiresDetection(params.entry, params.parent, params.apiMode)) {
    return undefined;
  }
  if (autoStart === false) {
    return { kind: "external-native", url: baseUrl };
  }
  return buildManagedNativeTransport(params.entry, params.parent);
}

async function resolveLegacyTransport(params: {
  entry: Record<string, unknown>;
  parent: Record<string, unknown>;
  apiMode: unknown;
  detect?: DetectTransport;
}): Promise<SignalTransportConfig | undefined> {
  const resolved = resolveLegacyTransportWithoutDetection(params);
  if (resolved) {
    return resolved;
  }
  const account = optionalString(inherited(params.entry, params.parent, "account"));
  try {
    return await params.detect?.({
      url: legacyBaseUrl(params.entry, params.parent),
      ...(account ? { account } : {}),
    });
  } catch {
    return undefined;
  }
}

function clearLegacyTransportFields(entry: Record<string, unknown>): void {
  for (const field of LEGACY_TRANSPORT_FIELDS) {
    delete entry[field];
  }
}

function hasRootSignalAccount(entries: Record<string, unknown>[]): boolean {
  const root = entries[0];
  return (
    entries.length === 1 ||
    Boolean(optionalString(root?.account)) ||
    Boolean(optionalString(root?.accountUuid)) ||
    isSignalTransportConfig(root?.transport)
  );
}

export function clearLegacySignalTransportFieldsForAccount(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): OpenClawConfig {
  const next = structuredClone(params.cfg);
  const signal = next.channels?.signal as unknown;
  if (!isRecord(signal)) {
    return next;
  }
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    clearLegacyTransportFields(signal);
    delete signal.apiMode;
    const accounts = isRecord(signal.accounts) ? signal.accounts : undefined;
    const nestedDefault = accounts?.[DEFAULT_ACCOUNT_ID];
    if (isRecord(nestedDefault)) {
      // Setup writes the implicit default transport at the channel root.
      // Remove a nested copy so it cannot shadow the canonical write.
      clearLegacyTransportFields(nestedDefault);
      delete nestedDefault.transport;
    }
    return next;
  }
  const accounts = isRecord(signal.accounts) ? signal.accounts : undefined;
  const account = accounts?.[params.accountId];
  if (isRecord(account)) {
    clearLegacyTransportFields(account);
  }
  return next;
}

function allocateMigratedManagedPorts(params: {
  entries: Record<string, unknown>[];
  transports: Array<SignalTransportConfig | undefined>;
}): Array<SignalTransportConfig | undefined> {
  const reservedPorts = new Set<number>();
  const rootIsAccount = hasRootSignalAccount(params.entries);
  for (const [index, transport] of params.transports.entries()) {
    if (!transport || (index === 0 && !rootIsAccount)) {
      continue;
    }
    if (transport.kind !== "managed-native") {
      const localPort = resolveLocalSignalTransportPort(transport.url);
      if (localPort !== undefined) {
        reservedPorts.add(localPort);
      }
      continue;
    }
    if (index === 0 || isRecord(params.entries[index]?.transport)) {
      reservedPorts.add(transport.httpPort ?? DEFAULT_SIGNAL_MANAGED_NATIVE_PORT);
    }
  }
  return params.transports.map((transport, index) => {
    if (!transport || (index === 0 && !rootIsAccount)) {
      return transport;
    }
    if (transport.kind !== "managed-native") {
      return transport;
    }
    const existingCanonical = isRecord(params.entries[index]?.transport);
    if (existingCanonical || index === 0) {
      return transport;
    }
    const rawPreferredPort = params.entries[index]?.httpPort;
    const preferredPort =
      typeof rawPreferredPort === "number" ? rawPreferredPort : transport.httpPort;
    const httpPort = allocateSignalManagedNativePort({
      reservedPorts,
      ...(typeof preferredPort === "number" ? { preferredPort } : {}),
    });
    reservedPorts.add(httpPort);
    return { ...transport, httpPort };
  });
}

function applyMigratedSignalTransports(params: {
  cfg: OpenClawConfig;
  entries: Record<string, unknown>[];
  transports: Array<SignalTransportConfig | undefined>;
}): OpenClawConfig | undefined {
  const next = structuredClone(params.cfg);
  const nextSignal = next.channels?.signal as unknown;
  if (!isRecord(nextSignal)) {
    return undefined;
  }
  const sourceAccounts = isRecord(params.entries[0]?.accounts) ? params.entries[0].accounts : {};
  const accountIds = Object.entries(sourceAccounts)
    .filter(([, entry]) => isRecord(entry))
    .map(([accountId]) => accountId);
  const nextAccounts = isRecord(nextSignal.accounts) ? nextSignal.accounts : {};
  const nextEntries = [nextSignal, ...Object.values(nextAccounts).filter(isRecord)];
  const rootIsAccount = hasRootSignalAccount(params.entries);
  for (const [index, entry] of nextEntries.entries()) {
    const accountId = index === 0 ? undefined : accountIds[index - 1];
    if (accountId === DEFAULT_ACCOUNT_ID) {
      nextSignal.transport = params.transports[index];
      delete entry.transport;
    } else if (index === 0 && !rootIsAccount) {
      delete entry.transport;
    } else {
      entry.transport = params.transports[index];
    }
    clearLegacyTransportFields(entry);
  }
  delete nextSignal.apiMode;
  return next;
}

export async function migrateLegacySignalTransportConfig(params: {
  cfg: OpenClawConfig;
  detect?: DetectTransport;
}): Promise<ChannelDoctorConfigMutation> {
  const signal = params.cfg.channels?.signal as unknown;
  if (!isRecord(signal)) {
    return { config: params.cfg, changes: [] };
  }
  const accounts = isRecord(signal.accounts) ? signal.accounts : {};
  const hasLegacy =
    Object.hasOwn(signal, "apiMode") ||
    hasLegacyFields(signal) ||
    Object.values(accounts).some((entry) => isRecord(entry) && hasLegacyFields(entry));
  if (!hasLegacy) {
    return { config: params.cfg, changes: [] };
  }
  const apiMode = signal.apiMode;
  const entries = [signal, ...Object.values(accounts).filter(isRecord)];
  if (!params.detect && entries.some((entry) => requiresDetection(entry, signal, apiMode))) {
    return {
      config: params.cfg,
      changes: [],
      warnings: [PENDING_LEGACY_TRANSPORT_WARNING],
    };
  }

  const transports = allocateMigratedManagedPorts({
    entries,
    transports: await Promise.all(
      entries.map((entry) =>
        resolveLegacyTransport({ entry, parent: signal, apiMode, detect: params.detect }),
      ),
    ),
  });
  if (transports.some((transport) => !transport)) {
    return {
      config: params.cfg,
      changes: [],
      warnings: [PENDING_LEGACY_TRANSPORT_WARNING],
    };
  }

  const next = applyMigratedSignalTransports({ cfg: params.cfg, entries, transports });
  if (!next) {
    return { config: params.cfg, changes: [] };
  }
  return {
    config: next,
    changes: [
      "Migrated channels.signal transport settings to concrete account-owned transport objects.",
    ],
  };
}

export function migrateLegacySignalTransportConfigSync(
  cfg: OpenClawConfig,
): ChannelDoctorConfigMutation {
  const signal = cfg.channels?.signal as unknown;
  if (!isRecord(signal)) {
    return { config: cfg, changes: [] };
  }
  const accounts = isRecord(signal.accounts) ? signal.accounts : {};
  const hasLegacy =
    Object.hasOwn(signal, "apiMode") ||
    hasLegacyFields(signal) ||
    Object.values(accounts).some((entry) => isRecord(entry) && hasLegacyFields(entry));
  if (!hasLegacy) {
    return { config: cfg, changes: [] };
  }
  const entries = [signal, ...Object.values(accounts).filter(isRecord)];
  const transports = allocateMigratedManagedPorts({
    entries,
    transports: entries.map((entry) =>
      resolveLegacyTransportWithoutDetection({ entry, parent: signal, apiMode: signal.apiMode }),
    ),
  });
  if (transports.some((transport) => !transport)) {
    return { config: cfg, changes: [] };
  }
  const next = applyMigratedSignalTransports({ cfg, entries, transports });
  if (!next) {
    return { config: cfg, changes: [] };
  }
  return {
    config: next,
    changes: [
      "Migrated channels.signal transport settings to concrete account-owned transport objects.",
    ],
  };
}
