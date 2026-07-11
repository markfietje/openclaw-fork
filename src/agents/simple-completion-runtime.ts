/**
 * Simple completion runtime preparation.
 *
 * Resolves agent model selection, auth, runtime policy, and missing-auth errors before simple completions run.
 */
import { randomUUID } from "node:crypto";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { streamSimple } from "../llm/stream.js";
import type {
  AssistantMessage,
  Model,
  ThinkingLevel as SimpleCompletionThinkingLevel,
} from "../llm/types.js";
import { prepareProviderRuntimeAuth } from "../plugins/provider-runtime.runtime.js";
import { resolveAgentDir, resolveAgentEffectiveModelPrimary } from "./agent-scope.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { resolveModel, resolveModelAsync } from "./embedded-agent-runner/model.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import {
  applyLocalNoAuthHeaderOverride,
  formatMissingAuthError,
  getApiKeyForModel,
  type ResolvedProviderAuth,
} from "./model-auth.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "./model-selection.js";
import { supportsOpenAIReasoningEffort } from "./openai-reasoning-effort.js";
import { OPENAI_PROVIDER_ID, isOpenAIProvider } from "./openai-routing.js";
import {
  isModelProviderDispatchObservableStreamFn,
  resolveProviderDispatchCostMultiplierForStreamFn,
  resolveProviderDispatchModelForStreamFn,
  resolveProviderDispatchReservationCostMultiplierForStreamFn,
} from "./provider-dispatch-observable-stream.js";
import { applyPreparedRuntimeAuthToModel } from "./provider-request-config.js";
import { prepareModelForSimpleCompletion } from "./simple-completion-transport.js";
import {
  acquireAgentUsageBudgetAdmission,
  AgentUsageBudgetError,
  buildUnsupportedAgentUsageBudgetStreamError,
  hasAnyActiveAgentUsageBudgetConfig,
  isAgentUsageBudgetError,
  recordAgentUsageBudgetAdmissionResult,
  resolveAgentUsageBudgetConfig,
  resolveUsageBudgetCostMultiplierUsage,
  type AgentUsageBudgetAdmissionRelease,
  type AgentUsageBudgetAdmissionReservation,
} from "./usage-budget.js";
import { hasNonzeroUsageLike, type UsageLike } from "./usage.js";

type SimpleCompletionAuthStorage = {
  setRuntimeApiKey: (provider: string, apiKey: string) => void;
};

type CompletionRuntimeCredential = {
  apiKey: string;
  model: Model;
};

type AllowedMissingApiKeyMode = ResolvedProviderAuth["mode"];

export type SimpleCompletionModelOptions = {
  maxTokens?: number;
  temperature?: number;
  reasoning?: ThinkLevel | SimpleCompletionThinkingLevel;
  signal?: AbortSignal;
};

export type SimpleCompletionUsageBudgetContext = {
  config?: OpenClawConfig;
  agentId?: string | null;
  provider: string;
  model: string;
  recordIdPrefix?: string;
  transcriptPath?: string;
};

function buildRepeatedSimpleCompletionDispatchBudgetError(params: {
  agentId?: string | null;
  provider: string;
  model: string;
}): AgentUsageBudgetError {
  return new AgentUsageBudgetError(
    `Usage budget blocked for agent "${params.agentId ?? "unknown"}": provider retry dispatch cannot be safely attributed.`,
    {
      agentId: params.agentId ?? "unknown",
      provider: params.provider,
      model: params.model,
      harnessId: "provider-retry",
      reason: "unsupported_harness",
    },
  );
}

function isProviderRetryUsageBudgetError(error: unknown): boolean {
  return (
    isAgentUsageBudgetError(error) &&
    typeof error === "object" &&
    error !== null &&
    (error as { details?: { harnessId?: unknown } }).details?.harnessId === "provider-retry"
  );
}

function estimateJsonTokenUpperBound(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}

function buildSimpleCompletionUsageBudgetReservation(params: {
  context: Parameters<typeof streamSimple>[1];
  model: Model;
  options: SimpleCompletionModelOptions;
}): AgentUsageBudgetAdmissionReservation | undefined {
  const inputTokens = estimateJsonTokenUpperBound(params.context);
  const outputTokens = params.options.maxTokens ?? params.model.maxTokens;
  const reservation = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
  return Object.keys(reservation).length > 0 ? reservation : undefined;
}

export type PreparedSimpleCompletionModel =
  | {
      model: Model;
      auth: ResolvedProviderAuth;
    }
  | {
      error: string;
      auth?: ResolvedProviderAuth;
    };

export type AgentSimpleCompletionSelection = {
  provider: string;
  modelId: string;
  /** Provider used for auth/transport when runtime policy redirects the logical model ref. */
  runtimeProvider?: string;
  profileId?: string;
  agentDir: string;
};

export type PreparedSimpleCompletionModelForAgent =
  | {
      selection: AgentSimpleCompletionSelection;
      model: Model;
      auth: ResolvedProviderAuth;
    }
  | {
      error: string;
      selection?: AgentSimpleCompletionSelection;
      auth?: ResolvedProviderAuth;
    };

export function resolveSimpleCompletionSelectionForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef?: string;
}): AgentSimpleCompletionSelection | null {
  const fallbackRef = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const modelRef =
    params.modelRef?.trim() || resolveAgentEffectiveModelPrimary(params.cfg, params.agentId);
  const split = modelRef ? splitTrailingAuthProfile(modelRef) : null;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: fallbackRef.provider || DEFAULT_PROVIDER,
  });
  const resolved = split
    ? resolveModelRefFromString({
        raw: split.model,
        defaultProvider: fallbackRef.provider || DEFAULT_PROVIDER,
        aliasIndex,
      })
    : null;
  const provider = resolved?.ref.provider ?? fallbackRef.provider;
  const modelId = resolved?.ref.model ?? fallbackRef.model;
  if (!provider || !modelId) {
    return null;
  }
  return {
    provider,
    modelId,
    ...resolveSimpleCompletionRuntimeProvider({
      cfg: params.cfg,
      agentId: params.agentId,
      provider,
      modelId,
    }),
    profileId: split?.profile || undefined,
    agentDir: resolveAgentDir(params.cfg, params.agentId),
  };
}

function resolveSimpleCompletionRuntimeProvider(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider: string;
  modelId: string;
}): Pick<AgentSimpleCompletionSelection, "runtimeProvider"> {
  if (!isOpenAIProvider(params.provider)) {
    return {};
  }
  const policy = resolveAgentHarnessPolicy({
    provider: params.provider,
    modelId: params.modelId,
    config: params.cfg,
    agentId: params.agentId,
  });
  return policy.runtime === "codex" ? { runtimeProvider: OPENAI_PROVIDER_ID } : {};
}

async function setRuntimeApiKeyForCompletion(params: {
  authStorage: SimpleCompletionAuthStorage;
  model: Model;
  apiKey: string;
  authMode: ResolvedProviderAuth["mode"];
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  profileId?: string;
}): Promise<CompletionRuntimeCredential> {
  if (params.model.provider === "github-copilot") {
    const { resolveCopilotApiToken } = await import("../plugin-sdk/provider-auth.js");
    const copilotToken = await resolveCopilotApiToken({
      githubToken: params.apiKey,
    });
    params.authStorage.setRuntimeApiKey(params.model.provider, copilotToken.token);
    return {
      apiKey: copilotToken.token,
      model: { ...params.model, baseUrl: copilotToken.baseUrl },
    };
  }
  const preparedAuth = await prepareProviderRuntimeAuth({
    provider: params.model.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: process.env,
    context: {
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env: process.env,
      provider: params.model.provider,
      modelId: params.model.id,
      model: params.model,
      apiKey: params.apiKey,
      authMode: params.authMode,
      profileId: params.profileId,
    },
  });
  const runtimeApiKey = preparedAuth?.apiKey?.trim() || params.apiKey;
  params.authStorage.setRuntimeApiKey(params.model.provider, runtimeApiKey);
  return {
    apiKey: runtimeApiKey,
    model: applyPreparedRuntimeAuthToModel(params.model, preparedAuth),
  };
}

function hasMissingApiKeyAllowance(params: {
  mode: ResolvedProviderAuth["mode"];
  allowMissingApiKeyModes?: ReadonlyArray<AllowedMissingApiKeyMode>;
}): boolean {
  return Boolean(params.allowMissingApiKeyModes?.includes(params.mode));
}

export async function prepareSimpleCompletionModel(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  agentDir?: string;
  profileId?: string;
  preferredProfile?: string;
  allowMissingApiKeyModes?: ReadonlyArray<AllowedMissingApiKeyMode>;
  allowBundledStaticCatalogFallback?: boolean;
  useAsyncModelResolution?: boolean;
  skipAgentDiscovery?: boolean;
  modelResolver?: typeof resolveModelAsync;
}): Promise<PreparedSimpleCompletionModel> {
  const resolved =
    params.useAsyncModelResolution || params.skipAgentDiscovery
      ? await (params.modelResolver ?? resolveModelAsync)(
          params.provider,
          params.modelId,
          params.agentDir,
          params.cfg,
          {
            ...(params.allowBundledStaticCatalogFallback !== undefined
              ? { allowBundledStaticCatalogFallback: params.allowBundledStaticCatalogFallback }
              : {}),
            ...(params.skipAgentDiscovery ? { skipAgentDiscovery: true } : {}),
            authProfileId: params.profileId,
            preferredProfile: params.preferredProfile,
          },
        )
      : resolveModel(params.provider, params.modelId, params.agentDir, params.cfg, {
          authProfileId: params.profileId,
          preferredProfile: params.preferredProfile,
        });
  if (!resolved.model) {
    return {
      error: resolved.error ?? `Unknown model: ${params.provider}/${params.modelId}`,
    };
  }

  let auth: ResolvedProviderAuth;
  try {
    auth = await getApiKeyForModel({
      model: resolved.model,
      cfg: params.cfg,
      agentDir: params.agentDir,
      profileId: params.profileId,
      preferredProfile: params.preferredProfile,
    });
  } catch (err) {
    return {
      error: `Auth lookup failed for provider "${resolved.model.provider}": ${formatErrorMessage(err)}`,
    };
  }
  const rawApiKey = auth.apiKey?.trim();
  if (
    !rawApiKey &&
    !hasMissingApiKeyAllowance({
      mode: auth.mode,
      allowMissingApiKeyModes: params.allowMissingApiKeyModes,
    })
  ) {
    return {
      error: formatMissingAuthError(auth, resolved.model.provider),
      auth,
    };
  }

  let resolvedApiKey = rawApiKey;
  let resolvedModel = resolved.model;
  if (rawApiKey) {
    const runtimeCredential = await setRuntimeApiKeyForCompletion({
      authStorage: resolved.authStorage,
      model: resolved.model,
      apiKey: rawApiKey,
      authMode: auth.mode,
      cfg: params.cfg,
      workspaceDir: params.agentDir,
      profileId: auth.profileId,
    });
    resolvedApiKey = runtimeCredential.apiKey;
    resolvedModel = runtimeCredential.model;
  }

  const resolvedAuth: ResolvedProviderAuth = {
    ...auth,
    apiKey: resolvedApiKey,
  };

  return {
    model: applyLocalNoAuthHeaderOverride(resolvedModel, resolvedAuth),
    auth: resolvedAuth,
  };
}

export async function prepareSimpleCompletionModelForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef?: string;
  preferredProfile?: string;
  allowMissingApiKeyModes?: ReadonlyArray<AllowedMissingApiKeyMode>;
  allowBundledStaticCatalogFallback?: boolean;
  useAsyncModelResolution?: boolean;
  skipAgentDiscovery?: boolean;
  modelResolver?: typeof resolveModelAsync;
}): Promise<PreparedSimpleCompletionModelForAgent> {
  const selection = resolveSimpleCompletionSelectionForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    modelRef: params.modelRef,
  });
  if (!selection) {
    return {
      error: `No model configured for agent ${params.agentId}.`,
    };
  }
  const prepared = await prepareSimpleCompletionModel({
    cfg: params.cfg,
    provider: selection.runtimeProvider ?? selection.provider,
    modelId: selection.modelId,
    agentDir: selection.agentDir,
    profileId: selection.profileId,
    preferredProfile: params.preferredProfile,
    allowMissingApiKeyModes: params.allowMissingApiKeyModes,
    ...(params.allowBundledStaticCatalogFallback !== undefined
      ? { allowBundledStaticCatalogFallback: params.allowBundledStaticCatalogFallback }
      : {}),
    useAsyncModelResolution: params.useAsyncModelResolution,
    skipAgentDiscovery: params.skipAgentDiscovery,
    modelResolver: params.modelResolver,
  });
  if ("error" in prepared) {
    return {
      ...prepared,
      selection,
    };
  }
  return {
    selection,
    model: prepared.model,
    auth: prepared.auth,
  };
}

export async function completeWithPreparedSimpleCompletionModel(params: {
  model: Model;
  auth: ResolvedProviderAuth;
  context: Parameters<typeof streamSimple>[1];
  cfg?: OpenClawConfig;
  options?: SimpleCompletionModelOptions;
  usageBudget?: SimpleCompletionUsageBudgetContext;
}): Promise<AssistantMessage> {
  const config = params.usageBudget?.config ?? params.cfg ?? getRuntimeConfig();
  const completionModel = prepareModelForSimpleCompletion({ model: params.model, cfg: config });
  const { reasoning: rawReasoning, ...options } = params.options ?? {};
  const reasoning = normalizeSimpleCompletionReasoning(rawReasoning, completionModel);
  const complete = async (onProviderDispatch?: () => void, disableProviderRetries = false) => {
    const stream = streamSimple(completionModel, params.context, {
      ...options,
      ...(reasoning ? { reasoning } : {}),
      apiKey: params.auth.apiKey,
      ...(disableProviderRetries ? { maxRetries: 0 } : {}),
      ...(onProviderDispatch ? { onProviderDispatch } : {}),
    });
    return await stream.result();
  };
  const usageBudget = params.usageBudget;
  if (!usageBudget) {
    if (hasAnyActiveAgentUsageBudgetConfig(config)) {
      throw new AgentUsageBudgetError(
        'Usage budget blocked for agent "unknown": simple completion requires agent attribution before model dispatch.',
        {
          agentId: "unknown",
          provider: completionModel.provider,
          model: completionModel.id,
          reason: "unsupported_harness",
        },
      );
    }
    return await complete();
  }
  const usageBudgetConfig = resolveAgentUsageBudgetConfig({
    config,
    agentId: usageBudget.agentId,
  });
  if (!usageBudgetConfig) {
    return await complete();
  }
  if (
    !isModelProviderDispatchObservableStreamFn({
      streamFn: streamSimple,
      model: completionModel,
    })
  ) {
    throw buildUnsupportedAgentUsageBudgetStreamError({
      agentId: usageBudget.agentId,
      provider: completionModel.provider,
      model: completionModel.id,
    });
  }

  let usageBudgetTimestampMs: number | undefined;
  let releaseUsageBudgetAdmission: AgentUsageBudgetAdmissionRelease | undefined;
  let usageRecorded = false;
  let preserveInFlightUsageBudgetAdmission = false;
  let providerDispatchStarted = false;
  const usageBudgetOperationId = randomUUID();
  const usageBudgetStreamOptions = {
    ...options,
    ...(reasoning ? { reasoning } : {}),
    apiKey: params.auth.apiKey,
    maxRetries: 0,
  };
  const usageBudgetDispatchModel = resolveProviderDispatchModelForStreamFn({
    streamFn: streamSimple,
    model: completionModel,
    context: params.context,
    options: usageBudgetStreamOptions,
  });
  const usageBudgetDispatchProvider = usageBudgetDispatchModel.provider;
  const usageBudgetDispatchModelId = usageBudgetDispatchModel.id;
  const usageBudgetCostMultiplier = resolveProviderDispatchCostMultiplierForStreamFn({
    streamFn: streamSimple,
    model: completionModel,
    context: params.context,
    options: usageBudgetStreamOptions,
  });
  const usageBudgetReservationCostMultiplier =
    resolveProviderDispatchReservationCostMultiplierForStreamFn({
      streamFn: streamSimple,
      model: completionModel,
      context: params.context,
      options: usageBudgetStreamOptions,
    });
  const recordUsage = (usage?: UsageLike) => {
    if (!releaseUsageBudgetAdmission || usageBudgetTimestampMs === undefined) {
      return;
    }
    const timestampMs = usageBudgetTimestampMs;
    const recordedUsage = resolveUsageBudgetCostMultiplierUsage({
      config,
      provider: usageBudgetDispatchProvider,
      model: usageBudgetDispatchModelId,
      usage,
      costMultiplier: usageBudgetCostMultiplier,
    });
    try {
      recordAgentUsageBudgetAdmissionResult({
        config,
        agentId: usageBudget.agentId,
        provider: usageBudgetDispatchProvider,
        model: usageBudgetDispatchModelId,
        usage: recordedUsage,
        timestampMs,
        recordId: `${usageBudget.recordIdPrefix ?? "simple-completion"}:${timestampMs}:${randomUUID()}`,
        usageBudgetOperationId,
      });
      usageRecorded = true;
    } catch (error) {
      preserveInFlightUsageBudgetAdmission = true;
      throw error;
    }
  };
  try {
    releaseUsageBudgetAdmission = await acquireAgentUsageBudgetAdmission({
      config,
      agentId: usageBudget.agentId,
      provider: usageBudgetDispatchProvider,
      model: usageBudgetDispatchModelId,
      transcriptPath: usageBudget.transcriptPath,
      reservation: buildSimpleCompletionUsageBudgetReservation({
        context: params.context,
        model: usageBudgetDispatchModel,
        options,
      }),
      costMultiplier: usageBudgetReservationCostMultiplier,
      reservationCostKnown: usageBudgetReservationCostMultiplier !== undefined,
      usageBudgetOperationId,
      signal: options.signal,
    });
    usageBudgetTimestampMs = releaseUsageBudgetAdmission?.timestampMs;
    const result = await complete(() => {
      if (providerDispatchStarted) {
        throw buildRepeatedSimpleCompletionDispatchBudgetError({
          agentId: usageBudget.agentId,
          provider: usageBudgetDispatchProvider,
          model: usageBudgetDispatchModelId,
        });
      }
      providerDispatchStarted = true;
    }, true);
    if (
      releaseUsageBudgetAdmission &&
      (providerDispatchStarted || hasNonzeroUsageLike(result.usage))
    ) {
      recordUsage(result.usage);
    }
    return result;
  } catch (error) {
    const errorUsage = readSimpleCompletionErrorUsage(error);
    if (
      releaseUsageBudgetAdmission &&
      !usageRecorded &&
      (!isAgentUsageBudgetError(error) || isProviderRetryUsageBudgetError(error)) &&
      (providerDispatchStarted || hasNonzeroUsageLike(errorUsage))
    ) {
      recordUsage(errorUsage);
    }
    throw error;
  } finally {
    await releaseUsageBudgetAdmission?.({
      preserveInFlight: preserveInFlightUsageBudgetAdmission,
    });
  }
}

function readSimpleCompletionErrorUsage(error: unknown): UsageLike | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const carrier = error as { usage?: UsageLike; partialUsage?: UsageLike };
  return carrier.partialUsage ?? carrier.usage;
}

function normalizeSimpleCompletionReasoning(
  reasoning: SimpleCompletionModelOptions["reasoning"],
  model: Model,
): SimpleCompletionThinkingLevel | undefined {
  switch (reasoning) {
    case undefined:
    case "off":
      return undefined;
    case "adaptive":
      return "medium";
    case "max":
      return isOpenAIProvider(model.provider) && supportsOpenAIReasoningEffort(model, "max")
        ? "max"
        : "xhigh";
    default:
      return reasoning;
  }
}
