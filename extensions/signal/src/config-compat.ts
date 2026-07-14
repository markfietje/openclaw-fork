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

const LEGACY_TRANSPORT_FIELDS = [
  "configPath",
  "httpUrl",
  "httpHost",
  "httpPort",
  "cliPath",
  "autoStart",
  "startupTimeoutMs",
  "receiveMode",
  "ignoreAttachments",
  "ignoreStories",
] as const;

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
    return url;
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
  const httpUrl = optionalString(inherited(entry, parent, "httpUrl"));
  return (apiMode === undefined || apiMode === "auto") && Boolean(httpUrl);
}

function buildManagedNativeTransport(
  entry: Record<string, unknown>,
  parent: Record<string, unknown>,
): SignalTransportConfig {
  const value = (key: string) => inherited(entry, parent, key);
  const configPath = optionalString(value("configPath"));
  const cliPath = optionalString(value("cliPath"));
  const httpHost = optionalString(value("httpHost"));
  const httpPort = value("httpPort");
  const startupTimeoutMs = value("startupTimeoutMs");
  const receiveMode = value("receiveMode");
  const ignoreAttachments = value("ignoreAttachments");
  const ignoreStories = value("ignoreStories");
  return {
    kind: "managed-native",
    ...(configPath ? { configPath } : {}),
    ...(cliPath ? { cliPath } : {}),
    ...(httpHost ? { httpHost } : {}),
    ...(typeof httpPort === "number" ? { httpPort } : {}),
    ...(typeof startupTimeoutMs === "number" ? { startupTimeoutMs } : {}),
    ...(receiveMode === "on-start" || receiveMode === "manual" ? { receiveMode } : {}),
    ...(typeof ignoreAttachments === "boolean" ? { ignoreAttachments } : {}),
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
    return autoStart === false || optionalString(inherited(params.entry, params.parent, "httpUrl"))
      ? { kind: "external-native", url: baseUrl }
      : buildManagedNativeTransport(params.entry, params.parent);
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

export function hasPendingLegacySignalTransportDetection(cfg: OpenClawConfig): boolean {
  const signal = cfg.channels?.signal as unknown;
  if (!isRecord(signal)) {
    return false;
  }
  const accounts = isRecord(signal.accounts) ? signal.accounts : {};
  return [signal, ...Object.values(accounts).filter(isRecord)].some((entry) =>
    requiresDetection(entry, signal, signal.apiMode),
  );
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
    const httpPort = allocateSignalManagedNativePort({
      reservedPorts,
      ...(typeof rawPreferredPort === "number" ? { preferredPort: rawPreferredPort } : {}),
    });
    reservedPorts.add(httpPort);
    return { ...transport, httpPort };
  });
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
    return { config: params.cfg, changes: [] };
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
    return { config: params.cfg, changes: [] };
  }

  const next = structuredClone(params.cfg);
  const nextSignal = next.channels?.signal as unknown;
  if (!isRecord(nextSignal)) {
    return { config: params.cfg, changes: [] };
  }
  const nextAccounts = isRecord(nextSignal.accounts) ? nextSignal.accounts : {};
  const nextEntries = [nextSignal, ...Object.values(nextAccounts).filter(isRecord)];
  const rootIsAccount = hasRootSignalAccount(entries);
  for (const [index, entry] of nextEntries.entries()) {
    if (index === 0 && !rootIsAccount) {
      delete entry.transport;
    } else {
      entry.transport = transports[index];
    }
    clearLegacyTransportFields(entry);
  }
  delete nextSignal.apiMode;
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
  const next = structuredClone(cfg);
  const nextSignal = next.channels?.signal as unknown;
  if (!isRecord(nextSignal)) {
    return { config: cfg, changes: [] };
  }
  const nextAccounts = isRecord(nextSignal.accounts) ? nextSignal.accounts : {};
  const nextEntries = [nextSignal, ...Object.values(nextAccounts).filter(isRecord)];
  const rootIsAccount = hasRootSignalAccount(entries);
  for (const [index, entry] of nextEntries.entries()) {
    if (index === 0 && !rootIsAccount) {
      delete entry.transport;
    } else {
      entry.transport = transports[index];
    }
    clearLegacyTransportFields(entry);
  }
  delete nextSignal.apiMode;
  return {
    config: next,
    changes: [
      "Migrated channels.signal transport settings to concrete account-owned transport objects.",
    ],
  };
}
