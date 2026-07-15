// Signal plugin module implements setup core behavior.
import { normalizeAccountId, resolveAccountEntry } from "openclaw/plugin-sdk/account-resolution";
import type { ChannelSetupInput } from "openclaw/plugin-sdk/setup";
import {
  createCliPathTextInput,
  createDelegatedSetupWizardProxy,
  createDelegatedTextInputShouldPrompt,
  createPatchedAccountSetupAdapter,
  createSetupInputPresenceValidator,
  DEFAULT_ACCOUNT_ID,
  mergeAllowFromEntries,
  parseSetupEntriesAllowingWildcard,
  patchChannelConfigForAccount,
  promptParsedAllowFromForAccount,
  setAccountAllowFromForChannel,
  setSetupChannelEnabled,
  type ChannelSetupAdapter,
  type ChannelSetupWizard,
  type ChannelSetupWizardTextInput,
  type OpenClawConfig,
  createSetupTranslator,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatCliCommand, formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import type { SignalTransportConfig } from "./account-types.js";
import { resolveDefaultSignalAccountId, resolveSignalAccount } from "./accounts.js";
import {
  prepareSignalManagedNativeTransport,
  writeSignalAccountTransport,
} from "./setup-transport.js";
import { isValidSignalManagedNativePort } from "./transport-policy.js";

const t = createSetupTranslator();

const channel = "signal" as const;
const MIN_E164_DIGITS = 5;
const MAX_E164_DIGITS = 15;
const DIGITS_ONLY = /^\d+$/;
const INVALID_SIGNAL_ACCOUNT_ERROR =
  "Invalid E.164 phone number (must start with + and country code, e.g. +15555550123)";

export function normalizeSignalAccountInput(value: string | null | undefined): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }
  const phoneInput = trimmed.replace(/^signal:/i, "").trim();
  // Setup accepts formatting punctuation, but embedded or duplicate pluses are invalid input.
  const plusCount = phoneInput.match(/\+/g)?.length ?? 0;
  if (plusCount > 1 || (plusCount === 1 && !phoneInput.startsWith("+"))) {
    return null;
  }
  const normalized = normalizeE164(phoneInput);
  const digits = normalized.slice(1);
  if (!DIGITS_ONLY.test(digits)) {
    return null;
  }
  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) {
    return null;
  }
  return `+${digits}`;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function parseSignalAllowFromEntries(raw: string): { entries: string[]; error?: string } {
  return parseSetupEntriesAllowingWildcard(raw, (entry) => {
    if (normalizeLowercaseStringOrEmpty(entry).startsWith("uuid:")) {
      const id = entry.slice("uuid:".length).trim();
      if (!id) {
        return { error: "Invalid uuid entry" };
      }
      return { value: `uuid:${id}` };
    }
    if (isUuidLike(entry)) {
      return { value: `uuid:${entry}` };
    }
    const normalized = normalizeSignalAccountInput(entry);
    if (!normalized) {
      return { error: `Invalid entry: ${entry}` };
    }
    return { value: normalized };
  });
}

function buildSignalSetupPatch(input: {
  signalNumber?: string;
  signalTransport?: "external-native" | "container";
  cliPath?: string;
  httpUrl?: string;
  httpHost?: string;
  httpPort?: string;
}) {
  if (input.httpUrl && !input.signalTransport) {
    throw new Error("Signal HTTP transport kind must be prepared before writing config.");
  }
  const transport = input.httpUrl
    ? {
        kind: input.signalTransport,
        url: input.httpUrl,
      }
    : input.cliPath || input.httpHost || input.httpPort
      ? {
          kind: "managed-native" as const,
          ...(input.cliPath ? { cliPath: input.cliPath } : {}),
          ...(input.httpHost ? { httpHost: input.httpHost } : {}),
          ...(input.httpPort ? { httpPort: Number(input.httpPort) } : {}),
        }
      : undefined;
  return {
    ...(input.signalNumber ? { account: input.signalNumber } : {}),
    ...(transport ? { transport } : {}),
  };
}

function managedTransportOptions(
  transport: SignalTransportConfig | undefined,
): Omit<Extract<SignalTransportConfig, { kind: "managed-native" }>, "kind"> | undefined {
  if (transport?.kind !== "managed-native") {
    return undefined;
  }
  const { kind: _kind, ...options } = transport;
  return options;
}

type DetectSignalSetupTransport = (params: {
  url: string;
  account?: string;
}) => Promise<SignalTransportConfig>;

function resolveSignalSetupAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): string | undefined {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSignalAccountId(params.cfg),
  );
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return resolveSignalAccount({ cfg: params.cfg, accountId }).config.account;
  }
  return resolveAccountEntry(params.cfg.channels?.signal?.accounts, accountId)?.account;
}

export async function prepareSignalSetupInput(params: {
  cfg?: OpenClawConfig;
  accountId?: string;
  input: ChannelSetupInput;
  detect?: DetectSignalSetupTransport;
}): Promise<ChannelSetupInput> {
  const httpUrl = normalizeOptionalString(params.input.httpUrl);
  if (!httpUrl || params.input.signalTransport) {
    return params.input;
  }
  const detect =
    params.detect ?? (await import("./transport-detection.runtime.js")).detectSignalTransport;
  const configuredAccount = params.cfg
    ? resolveSignalSetupAccount({ cfg: params.cfg, accountId: params.accountId })
    : undefined;
  const account =
    normalizeSignalAccountInput(params.input.signalNumber) ??
    normalizeSignalAccountInput(configuredAccount);
  const transport = await detect({
    url: httpUrl,
    ...(account ? { account } : {}),
  });
  if (transport.kind === "managed-native") {
    throw new Error("Signal endpoint detection returned an invalid managed transport.");
  }
  return {
    ...params.input,
    httpUrl: transport.url,
    signalTransport: transport.kind,
  };
}

async function promptSignalAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  return promptParsedAllowFromForAccount({
    cfg: params.cfg,
    accountId: params.accountId,
    defaultAccountId: resolveDefaultSignalAccountId(params.cfg),
    prompter: params.prompter,
    noteTitle: t("wizard.signal.allowlistTitle"),
    noteLines: [
      t("wizard.signal.allowlistIntro"),
      t("wizard.signal.examples"),
      "- +15555550123",
      "- uuid:123e4567-e89b-12d3-a456-426614174000",
      t("wizard.signal.multipleEntries"),
      `Docs: ${formatDocsLink("/signal", "signal")}`,
    ],
    message: t("wizard.signal.allowFromPrompt"),
    placeholder: "+15555550123, uuid:123e4567-e89b-12d3-a456-426614174000",
    parseEntries: parseSignalAllowFromEntries,
    getExistingAllowFrom: ({ cfg, accountId }) =>
      resolveSignalAccount({ cfg, accountId }).config.allowFrom ?? [],
    applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
      setAccountAllowFromForChannel({
        cfg,
        channel,
        accountId,
        allowFrom,
      }),
  });
}

export const signalDmPolicy = {
  label: "Signal",
  channel,
  policyKey: "channels.signal.dmPolicy",
  allowFromKey: "channels.signal.allowFrom",
  resolveConfigKeys: (cfg: OpenClawConfig, accountId?: string) =>
    (accountId ?? resolveDefaultSignalAccountId(cfg)) !== DEFAULT_ACCOUNT_ID
      ? {
          policyKey: `channels.signal.accounts.${accountId ?? resolveDefaultSignalAccountId(cfg)}.dmPolicy`,
          allowFromKey: `channels.signal.accounts.${accountId ?? resolveDefaultSignalAccountId(cfg)}.allowFrom`,
        }
      : {
          policyKey: "channels.signal.dmPolicy",
          allowFromKey: "channels.signal.allowFrom",
        },
  getCurrent: (cfg: OpenClawConfig, accountId?: string) =>
    resolveSignalAccount({ cfg, accountId: accountId ?? resolveDefaultSignalAccountId(cfg) }).config
      .dmPolicy ?? "pairing",
  setPolicy: (
    cfg: OpenClawConfig,
    policy: "pairing" | "allowlist" | "open" | "disabled",
    accountId?: string,
  ) =>
    patchChannelConfigForAccount({
      cfg,
      channel,
      accountId: accountId ?? resolveDefaultSignalAccountId(cfg),
      patch:
        policy === "open"
          ? {
              dmPolicy: "open",
              allowFrom: mergeAllowFromEntries(
                resolveSignalAccount({
                  cfg,
                  accountId: accountId ?? resolveDefaultSignalAccountId(cfg),
                }).config.allowFrom,
                ["*"],
              ),
            }
          : { dmPolicy: policy },
    }),
  promptAllowFrom: promptSignalAllowFrom,
};

function resolveSignalCliPath(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: Record<string, unknown>;
}) {
  const transport = resolveSignalAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  }).transport;
  if (transport.kind !== "managed-native") {
    return undefined;
  }
  return typeof params.credentialValues.cliPath === "string"
    ? params.credentialValues.cliPath
    : transport.cliPath;
}

export function createSignalCliPathTextInput(
  shouldPrompt: NonNullable<ChannelSetupWizardTextInput["shouldPrompt"]>,
): ChannelSetupWizardTextInput {
  return createCliPathTextInput({
    inputKey: "cliPath",
    message: "signal-cli path",
    resolvePath: ({ cfg, accountId, credentialValues }) =>
      resolveSignalCliPath({ cfg, accountId, credentialValues }),
    shouldPrompt,
  });
}

export const signalNumberTextInput: ChannelSetupWizardTextInput = {
  inputKey: "signalNumber",
  message: t("wizard.signal.botNumberPrompt"),
  currentValue: ({ cfg, accountId }) =>
    normalizeSignalAccountInput(resolveSignalAccount({ cfg, accountId }).config.account) ??
    undefined,
  keepPrompt: (value) => t("wizard.signal.accountKeep", { value }),
  validate: ({ value }) =>
    normalizeSignalAccountInput(value) ? undefined : INVALID_SIGNAL_ACCOUNT_ERROR,
  normalizeValue: ({ value }) => normalizeSignalAccountInput(value) ?? value,
};

export const signalCompletionNote = {
  title: t("wizard.signal.nextStepsTitle"),
  lines: [
    t("wizard.signal.nextLinkDevice"),
    t("wizard.signal.nextScanQr"),
    `Then run: ${formatCliCommand("openclaw gateway call channels.status --params '{\"probe\":true}'")}`,
    `Docs: ${formatDocsLink("/signal", "signal")}`,
  ],
};

const signalSetupAdapterBase = createPatchedAccountSetupAdapter({
  channelKey: channel,
  validateInput: createSetupInputPresenceValidator({
    validate: ({ cfg, accountId, input }) => {
      if (
        input.signalTransport &&
        input.signalTransport !== "external-native" &&
        input.signalTransport !== "container"
      ) {
        return "Signal --signal-transport must be external-native or container.";
      }
      if (input.signalTransport && !input.httpUrl) {
        return "Signal --signal-transport requires --http-url.";
      }
      if (input.httpPort !== undefined && !isValidSignalManagedNativePort(Number(input.httpPort))) {
        return "Signal --http-port must be an integer between 1 and 65535.";
      }
      if (
        input.signalTransport === "container" &&
        !normalizeSignalAccountInput(input.signalNumber) &&
        !normalizeSignalAccountInput(resolveSignalSetupAccount({ cfg, accountId }))
      ) {
        return "Signal container transport requires --signal-number or an existing account.";
      }
      if (
        !input.signalNumber &&
        !input.httpUrl &&
        !input.httpHost &&
        !input.httpPort &&
        !input.cliPath
      ) {
        return "Signal requires --signal-number or --http-url/--http-host/--http-port/--cli-path.";
      }
      return null;
    },
  }),
  buildPatch: (input) => buildSignalSetupPatch(input),
});

export const signalSetupAdapter: ChannelSetupAdapter = {
  ...signalSetupAdapterBase,
  prepareAccountConfigInput: async ({ cfg, accountId, input }) =>
    await prepareSignalSetupInput({ cfg, accountId, input }),
  applyAccountConfig: (params) => {
    const accountId = normalizeAccountId(params.accountId);
    const nestedDefaultTransport =
      accountId === DEFAULT_ACCOUNT_ID
        ? resolveAccountEntry(params.cfg.channels?.signal?.accounts, DEFAULT_ACCOUNT_ID)?.transport
        : undefined;
    const cfg = nestedDefaultTransport
      ? writeSignalAccountTransport({
          cfg: params.cfg,
          accountId,
          transport: nestedDefaultTransport,
        })
      : params.cfg;
    const previousTransport = resolveSignalAccount({
      cfg,
      accountId,
    }).config.transport;
    const next = signalSetupAdapterBase.applyAccountConfig?.({ ...params, cfg, accountId }) ?? cfg;
    const account = resolveSignalAccount({ cfg: next, accountId });
    const configuredTransport = account.config.transport;
    if (account.transport.kind !== "managed-native") {
      return configuredTransport
        ? writeSignalAccountTransport({
            cfg: next,
            accountId,
            transport: configuredTransport,
          })
        : next;
    }
    return writeSignalAccountTransport({
      cfg: next,
      accountId,
      transport: prepareSignalManagedNativeTransport({
        cfg: next,
        accountId,
        overrides: {
          ...managedTransportOptions(previousTransport),
          ...managedTransportOptions(configuredTransport),
        },
      }),
    });
  },
};

export function createSignalSetupWizardProxy(loadWizard: () => Promise<ChannelSetupWizard>) {
  return createDelegatedSetupWizardProxy({
    channel,
    loadWizard,
    status: {
      configuredLabel: t("wizard.channels.statusConfigured"),
      unconfiguredLabel: t("wizard.channels.statusNeedsSetup"),
      configuredHint: t("wizard.channels.statusSignalCliFound"),
      unconfiguredHint: t("wizard.channels.statusSignalCliMissing"),
      configuredScore: 1,
      unconfiguredScore: 0,
    },
    delegatePrepare: true,
    credentials: [],
    textInputs: [
      createSignalCliPathTextInput(
        createDelegatedTextInputShouldPrompt({
          loadWizard,
          inputKey: "cliPath",
        }),
      ),
      signalNumberTextInput,
    ],
    completionNote: signalCompletionNote,
    dmPolicy: signalDmPolicy,
    disable: (cfg: OpenClawConfig) => setSetupChannelEnabled(cfg, channel, false),
  });
}
