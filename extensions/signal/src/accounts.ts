// Signal plugin module implements accounts behavior.
import {
  createAccountListHelpers,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveAccountEntry,
  resolveMergedAccountConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SignalAccountConfig, SignalTransportConfig } from "./account-types.js";
import {
  allocateSignalManagedNativePort,
  DEFAULT_SIGNAL_MANAGED_NATIVE_PORT,
  resolveLocalSignalTransportPort,
} from "./transport-policy.js";

export type ResolvedSignalTransport =
  | {
      kind: "managed-native";
      baseUrl: string;
      cliPath: string;
      configPath?: string;
      httpHost: string;
      httpPort: number;
      startupTimeoutMs: number;
      receiveMode?: "on-start" | "manual";
      ignoreStories?: boolean;
    }
  | {
      kind: "external-native" | "container";
      baseUrl: string;
    };

export type ResolvedSignalAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl: string;
  transport: ResolvedSignalTransport;
  configured: boolean;
  config: SignalAccountConfig;
};

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("signal", {
  implicitDefaultAccount: {
    channelKeys: ["account", "accountUuid", "transport"],
  },
});
export const listSignalAccountIds = listAccountIds;
export const resolveDefaultSignalAccountId = resolveDefaultAccountId;

function mergeSignalAccountConfig(cfg: OpenClawConfig, accountId: string): SignalAccountConfig {
  const channelConfig = cfg.channels?.signal;
  const {
    transport: _transport,
    accounts: _accounts,
    defaultAccount: _defaultAccount,
    ...shared
  } = channelConfig ?? {};
  return resolveMergedAccountConfig<SignalAccountConfig>({
    channelConfig: (accountId === DEFAULT_ACCOUNT_ID ? channelConfig : shared) as
      | SignalAccountConfig
      | undefined,
    accounts: cfg.channels?.signal?.accounts as
      | Record<string, Partial<SignalAccountConfig>>
      | undefined,
    accountId,
    nestedObjectKeys: ["aliases"],
  });
}

function resolveSignalManagedNativePort(params: {
  cfg: OpenClawConfig;
  accountId: string;
  transport: SignalTransportConfig | undefined;
}): number {
  if (params.transport?.kind === "managed-native" && params.transport.httpPort !== undefined) {
    return params.transport.httpPort;
  }

  const reservedPorts = new Set<number>();
  const implicitManagedAccountIds: string[] = [];
  // Reserve concrete local endpoints first, then assign implicit ports in account order.
  // Independent account resolution must produce the same collision-free daemon binds.
  for (const accountId of listSignalAccountIds(params.cfg)) {
    const transport = mergeSignalAccountConfig(params.cfg, accountId).transport;
    if (transport?.kind === "external-native" || transport?.kind === "container") {
      const localPort = resolveLocalSignalTransportPort(transport.url);
      if (localPort !== undefined) {
        reservedPorts.add(localPort);
      }
      continue;
    }
    if (transport?.kind === "managed-native" && transport.httpPort !== undefined) {
      reservedPorts.add(transport.httpPort);
      continue;
    }
    implicitManagedAccountIds.push(accountId);
  }

  for (const accountId of implicitManagedAccountIds) {
    const port = allocateSignalManagedNativePort({ reservedPorts });
    reservedPorts.add(port);
    if (accountId === params.accountId) {
      return port;
    }
  }
  return DEFAULT_SIGNAL_MANAGED_NATIVE_PORT;
}

export function resolveSignalTransport(
  transport: SignalTransportConfig | undefined,
  managedNativePort = DEFAULT_SIGNAL_MANAGED_NATIVE_PORT,
): ResolvedSignalTransport {
  if (transport?.kind === "external-native" || transport?.kind === "container") {
    return {
      kind: transport.kind,
      baseUrl: transport.url.trim(),
    };
  }

  const httpHost = normalizeOptionalString(transport?.httpHost) ?? "127.0.0.1";
  const httpPort = transport?.httpPort ?? managedNativePort;
  const configPath = normalizeOptionalString(transport?.configPath);
  return {
    kind: "managed-native",
    baseUrl: `http://${httpHost}:${httpPort}`,
    cliPath: normalizeOptionalString(transport?.cliPath) ?? "signal-cli",
    ...(configPath ? { configPath } : {}),
    httpHost,
    httpPort,
    startupTimeoutMs: transport?.startupTimeoutMs ?? 30_000,
    ...(transport?.receiveMode ? { receiveMode: transport.receiveMode } : {}),
    ...(typeof transport?.ignoreStories === "boolean"
      ? { ignoreStories: transport.ignoreStories }
      : {}),
  };
}

export function resolveSignalAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedSignalAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSignalAccountId(params.cfg),
  );
  const baseEnabled = params.cfg.channels?.signal?.enabled !== false;
  const merged = mergeSignalAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const transport = resolveSignalTransport(
    merged.transport,
    resolveSignalManagedNativePort({ cfg: params.cfg, accountId, transport: merged.transport }),
  );
  const baseUrl = transport.baseUrl;
  const configured = Boolean(
    normalizeOptionalString(merged.account) ||
    normalizeOptionalString(merged.accountUuid) ||
    merged.transport,
  );
  return {
    accountId,
    enabled,
    name: normalizeOptionalString(merged.name),
    baseUrl,
    transport,
    configured,
    config: merged,
  };
}

export function listEnabledSignalAccounts(cfg: OpenClawConfig): ResolvedSignalAccount[] {
  return listSignalAccountIds(cfg)
    .map((accountId) => resolveSignalAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}

function normalizeSignalReplyToMode(value: unknown): ReplyToMode | undefined {
  return value === "off" || value === "first" || value === "all" || value === "batched"
    ? value
    : undefined;
}

export function resolveSignalReplyToMode(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  chatType?: string | null;
}): ReplyToMode {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSignalAccountId(params.cfg),
  );
  const signalConfig = params.cfg.channels?.signal;
  const accountConfig = resolveAccountEntry(
    signalConfig?.accounts as Record<string, SignalAccountConfig> | undefined,
    accountId,
  );
  const chatType =
    params.chatType === "direct" || params.chatType === "group" ? params.chatType : undefined;
  if (chatType) {
    const accountScoped = normalizeSignalReplyToMode(
      accountConfig?.replyToModeByChatType?.[chatType],
    );
    if (accountScoped) {
      return accountScoped;
    }
    const accountDefault = normalizeSignalReplyToMode(accountConfig?.replyToMode);
    if (accountDefault) {
      return accountDefault;
    }
    const channelScoped = normalizeSignalReplyToMode(
      signalConfig?.replyToModeByChatType?.[chatType],
    );
    if (channelScoped) {
      return channelScoped;
    }
  }
  return (
    normalizeSignalReplyToMode(accountConfig?.replyToMode) ??
    normalizeSignalReplyToMode(signalConfig?.replyToMode) ??
    "all"
  );
}
