// Signal setup owns transport discovery and canonical account writes.
import { normalizeAccountId, resolveAccountEntry } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  DEFAULT_ACCOUNT_ID,
  patchChannelConfigForAccount,
} from "openclaw/plugin-sdk/setup-runtime";
import type { SignalTransportConfig } from "./account-types.js";
import { listSignalAccountIds, resolveSignalAccount, resolveSignalTransport } from "./accounts.js";
import { clearLegacySignalTransportFieldsForAccount } from "./config-compat.js";
import type {
  SignalContainerTransportProbe,
  SignalNativeTransportProbe,
  SignalTransportProbeResult,
} from "./transport-detection.js";
import {
  allocateSignalManagedNativePort,
  assignSignalManagedNativePort,
  DEFAULT_SIGNAL_MANAGED_NATIVE_HOST,
  isSignalManagedNativeConnectionUrlForBind,
  resolveLocalSignalTransportPort,
} from "./transport-policy.js";
import { normalizeSignalTransportUrl } from "./transport-url.js";

export { detectSignalTransport, type SignalTransportProbeResult } from "./transport-detection.js";

export type SignalManagedNativeTransport = Extract<
  SignalTransportConfig,
  { kind: "managed-native" }
>;

function managedTransportOptions(
  transport: SignalManagedNativeTransport,
): Omit<SignalManagedNativeTransport, "kind"> {
  const { kind: _kind, ...options } = transport;
  return options;
}

function normalizeTransport(transport: SignalTransportConfig): SignalTransportConfig {
  if (transport.kind === "managed-native") {
    return transport.url
      ? { ...transport, url: normalizeSignalTransportUrl(transport.url) }
      : transport;
  }
  return { ...transport, url: normalizeSignalTransportUrl(transport.url) };
}

function configuredTransportForAccount(
  cfg: OpenClawConfig,
  accountId: string,
): SignalTransportConfig | undefined {
  const signal = cfg.channels?.signal;
  return accountId === DEFAULT_ACCOUNT_ID
    ? signal?.transport
    : resolveAccountEntry(signal?.accounts, accountId)?.transport;
}

function alignManagedConnectionUrlAfterBindChange(params: {
  existing: SignalManagedNativeTransport | undefined;
  prepared: SignalManagedNativeTransport;
  httpPort: number;
  hasUrlOverride: boolean;
}): SignalManagedNativeTransport {
  if (
    params.hasUrlOverride ||
    !params.existing?.url ||
    !isSignalManagedNativeConnectionUrlForBind(params.existing)
  ) {
    return assignSignalManagedNativePort(params.prepared, params.httpPort);
  }

  const connectionUrl = new URL(params.existing.url);
  connectionUrl.port = String(params.httpPort);
  const alignedPortUrl = normalizeSignalTransportUrl(connectionUrl.toString());
  const next = { ...params.prepared, url: alignedPortUrl, httpPort: params.httpPort };
  if (isSignalManagedNativeConnectionUrlForBind(next)) {
    return next;
  }

  const bindHost = params.prepared.httpHost ?? DEFAULT_SIGNAL_MANAGED_NATIVE_HOST;
  const connectionHost =
    bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost === "::" ? "::1" : bindHost;
  connectionUrl.hostname = connectionHost.includes(":") ? `[${connectionHost}]` : connectionHost;
  return {
    ...next,
    url: normalizeSignalTransportUrl(connectionUrl.toString()),
  };
}

export function prepareSignalManagedNativeTransport(params: {
  cfg: OpenClawConfig;
  accountId: string;
  overrides?: Omit<SignalManagedNativeTransport, "kind">;
}): SignalManagedNativeTransport {
  const existing = configuredTransportForAccount(params.cfg, params.accountId);
  const existingManaged = existing?.kind === "managed-native" ? existing : undefined;
  const preferredPort = params.overrides?.httpPort ?? existingManaged?.httpPort;
  const prepared: SignalManagedNativeTransport = {
    kind: "managed-native",
    ...existingManaged,
    ...params.overrides,
    httpHost:
      params.overrides?.httpHost ?? existingManaged?.httpHost ?? DEFAULT_SIGNAL_MANAGED_NATIVE_HOST,
  };
  const reservedPorts = new Set<number>();
  // Resolve existing accounts before adding the target. Persisting only the target's allocated
  // port reserves the newcomers around established implicit ports, even if account ids reorder.
  for (const accountId of listSignalAccountIds(params.cfg)) {
    if (normalizeAccountId(accountId) === normalizeAccountId(params.accountId)) {
      continue;
    }
    const account = resolveSignalAccount({ cfg: params.cfg, accountId });
    if (!account.configured) {
      continue;
    }
    if (account.transport.kind === "managed-native") {
      reservedPorts.add(account.transport.httpPort);
      const localConnectionPort = resolveLocalSignalTransportPort(account.transport.baseUrl);
      if (localConnectionPort !== undefined) {
        reservedPorts.add(localConnectionPort);
      }
      continue;
    }
    const localPort = resolveLocalSignalTransportPort(account.transport.baseUrl);
    if (localPort !== undefined) {
      reservedPorts.add(localPort);
    }
  }

  const hasIndependentPreparedConnectionUrl =
    prepared.url &&
    (params.overrides?.url !== undefined
      ? !isSignalManagedNativeConnectionUrlForBind(prepared)
      : Boolean(
          existingManaged?.url && !isSignalManagedNativeConnectionUrlForBind(existingManaged),
        ));
  if (hasIndependentPreparedConnectionUrl && prepared.url) {
    const localConnectionPort = resolveLocalSignalTransportPort(prepared.url);
    if (localConnectionPort !== undefined) {
      reservedPorts.add(localConnectionPort);
    }
  }

  const httpPort = allocateSignalManagedNativePort({ reservedPorts, preferredPort });
  // A managed connection URL that points at the daemon's bind is one endpoint.
  // Keep its connection endpoint aligned when setup changes or reallocates the bind.
  return alignManagedConnectionUrlAfterBindChange({
    existing: existingManaged,
    prepared,
    httpPort,
    hasUrlOverride: params.overrides?.url !== undefined,
  });
}

export async function probeSignalTransport(params: {
  cfg: OpenClawConfig;
  accountId: string;
  transport: SignalTransportConfig;
  account?: string;
  timeoutMs?: number;
  probeNative?: SignalNativeTransportProbe;
  probeContainer?: SignalContainerTransportProbe;
}): Promise<SignalTransportProbeResult> {
  const timeoutMs = params.timeoutMs ?? 10_000;
  const transport =
    params.transport.kind === "managed-native"
      ? prepareSignalManagedNativeTransport({
          cfg: params.cfg,
          accountId: params.accountId,
          overrides: managedTransportOptions(params.transport),
        })
      : params.transport;
  const resolved = resolveSignalTransport(transport);
  if (resolved.kind === "container") {
    const probeContainer =
      params.probeContainer ?? (await import("./transport-probes.runtime.js")).containerCheck;
    return probeContainer(resolved.baseUrl, timeoutMs, params.account);
  }
  const probeNative =
    params.probeNative ?? (await import("./transport-probes.runtime.js")).nativeCheck;
  return probeNative(resolved.baseUrl, timeoutMs);
}

export function writeSignalAccountTransport(params: {
  cfg: OpenClawConfig;
  accountId: string;
  transport: SignalTransportConfig;
}): OpenClawConfig {
  const next = patchChannelConfigForAccount({
    cfg: params.cfg,
    channel: "signal",
    accountId: params.accountId,
    patch: { transport: normalizeTransport(params.transport) },
  });
  return clearLegacySignalTransportFieldsForAccount({
    cfg: next,
    accountId: params.accountId,
  });
}
