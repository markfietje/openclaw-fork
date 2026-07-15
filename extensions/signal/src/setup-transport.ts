// Signal setup owns transport discovery and canonical account writes.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  DEFAULT_ACCOUNT_ID,
  patchChannelConfigForAccount,
} from "openclaw/plugin-sdk/setup-runtime";
import type { SignalTransportConfig } from "./account-types.js";
import { listSignalAccountIds, resolveSignalAccount, resolveSignalTransport } from "./accounts.js";
import { clearLegacySignalTransportFieldsForAccount } from "./config-compat.js";
import {
  type SignalContainerTransportProbe,
  type SignalNativeTransportProbe,
  type SignalTransportProbeResult,
} from "./transport-detection.js";
import {
  allocateSignalManagedNativePort,
  DEFAULT_SIGNAL_MANAGED_NATIVE_HOST,
  resolveLocalSignalTransportPort,
} from "./transport-policy.js";
import { normalizeSignalTransportUrl } from "./transport-url.js";

export { detectSignalTransport, type SignalTransportProbeResult } from "./transport-detection.js";

export type SignalManagedNativeTransport = Extract<
  SignalTransportConfig,
  { kind: "managed-native" }
>;

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
    : signal?.accounts?.[accountId]?.transport;
}

export function prepareSignalManagedNativeTransport(params: {
  cfg: OpenClawConfig;
  accountId: string;
  overrides?: Omit<SignalManagedNativeTransport, "kind">;
}): SignalManagedNativeTransport {
  const existing = configuredTransportForAccount(params.cfg, params.accountId);
  const existingManaged = existing?.kind === "managed-native" ? existing : undefined;
  const preferredPort = params.overrides?.httpPort ?? existingManaged?.httpPort;
  const reservedPorts = new Set<number>();
  for (const accountId of listSignalAccountIds(params.cfg)) {
    if (accountId === params.accountId) {
      continue;
    }
    const account = resolveSignalAccount({ cfg: params.cfg, accountId });
    if (!account.configured) {
      continue;
    }
    if (account.transport.kind === "managed-native") {
      reservedPorts.add(account.transport.httpPort);
      continue;
    }
    const localPort = resolveLocalSignalTransportPort(account.transport.baseUrl);
    if (localPort !== undefined) {
      reservedPorts.add(localPort);
    }
  }

  const httpPort = allocateSignalManagedNativePort({ reservedPorts, preferredPort });
  return {
    kind: "managed-native",
    ...existingManaged,
    ...params.overrides,
    httpHost:
      params.overrides?.httpHost ?? existingManaged?.httpHost ?? DEFAULT_SIGNAL_MANAGED_NATIVE_HOST,
    httpPort,
  };
}

export async function probeSignalTransport(params: {
  transport: SignalTransportConfig;
  account?: string;
  timeoutMs?: number;
  probeNative?: SignalNativeTransportProbe;
  probeContainer?: SignalContainerTransportProbe;
}): Promise<SignalTransportProbeResult> {
  const timeoutMs = params.timeoutMs ?? 10_000;
  const resolved = resolveSignalTransport(params.transport);
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
