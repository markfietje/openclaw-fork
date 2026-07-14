/** Installs per-attempt context-engine, overflow, image, and computer-frame guards. */
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
import { buildContextEngineRuntimeSettings } from "../../../context-engine/runtime-settings.js";
import { isHeartbeatLifecycleRunKind } from "../../bootstrap-mode.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession, SettingsManager } from "../../sessions/index.js";
import {
  type ComputerContextEpoch,
  invalidateComputerFrameIfMissing,
} from "../../tools/computer-tool.js";
import { readLastCacheTtlTimestamp } from "../cache-ttl.js";
import {
  installContextEngineLoopHook,
  installToolResultContextGuard,
} from "../tool-result-context-guard.js";
import { resolveLiveToolResultMaxChars } from "../tool-result-truncation.js";
import { repairAttemptToolUseResultPairing } from "./attempt-transcript-helpers.js";
import {
  buildLoopPromptCacheInfo,
  type AttemptContextEngine,
} from "./attempt.context-engine-helpers.js";
import { buildAfterTurnRuntimeContext } from "./attempt.prompt-helpers.js";
import { installHistoryImagePruneContextTransform } from "./history-image-prune.js";
import type { MidTurnPrecheckRequest } from "./midturn-precheck.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

type RuntimeGuardSettingsManager = Pick<
  SettingsManager,
  "getBlockImages" | "getCompactionReserveTokens"
>;

export function installEmbeddedAttemptRuntimeGuards(input: {
  activeContextEngine?: AttemptContextEngine;
  activeSession: Pick<AgentSession, "agent">;
  agentDir: string;
  attempt: EmbeddedRunAttemptParams;
  computerContextEpoch: ComputerContextEpoch;
  effectiveCwd: string;
  effectiveWorkspace: string;
  getEffectivePromptCacheRetention: () => "none" | "short" | "long" | undefined;
  getPrePromptMessageCount: () => number;
  getPromptCache: () => EmbeddedRunAttemptResult["promptCache"];
  getSystemPrompt: () => string;
  isOpenAIResponsesApi: boolean;
  repairToolUseResultPairing: boolean;
  sessionAgentId: string;
  sessionManager: ReturnType<typeof guardSessionManager>;
  settingsManager: RuntimeGuardSettingsManager;
}): {
  cleanup: () => void;
  getContextEngineAfterTurnCheckpoint: () => number | null;
  takePendingMidTurnPrecheckRequest: () => MidTurnPrecheckRequest | null;
} {
  const { activeContextEngine, activeSession, attempt, settingsManager } = input;
  const contextTokenBudgetForGuard = Math.max(
    1,
    Math.floor(
      attempt.contextTokenBudget ??
        attempt.model.contextWindow ??
        attempt.model.maxTokens ??
        DEFAULT_CONTEXT_TOKENS,
    ),
  );
  const toolResultMaxCharsForGuard = resolveLiveToolResultMaxChars({
    contextWindowTokens: contextTokenBudgetForGuard,
    cfg: attempt.config,
    agentId: input.sessionAgentId,
  });
  let pendingMidTurnPrecheckRequest: MidTurnPrecheckRequest | null = null;
  const midTurnPrecheckOptions =
    attempt.config?.agents?.defaults?.compaction?.midTurnPrecheck?.enabled === true
      ? {
          midTurnPrecheck: {
            enabled: true,
            contextTokenBudget: contextTokenBudgetForGuard,
            reserveTokens: () => settingsManager.getCompactionReserveTokens(),
            toolResultMaxChars: toolResultMaxCharsForGuard,
            getSystemPrompt: input.getSystemPrompt,
            getPrePromptMessageCount: input.getPrePromptMessageCount,
            onMidTurnPrecheck: (request: MidTurnPrecheckRequest) => {
              pendingMidTurnPrecheckRequest = request;
            },
          },
        }
      : {};

  let contextEngineAfterTurnCheckpoint: number | null = null;
  let removeLoopContextGuard: () => void;
  if (activeContextEngine?.info.ownsCompaction === true) {
    const selectedContextEngineId = activeContextEngine.info.id;
    const removeContextEngineLoopHook = installContextEngineLoopHook({
      agent: activeSession.agent,
      contextEngine: activeContextEngine,
      sessionId: attempt.sessionId,
      sessionKey: attempt.sessionKey,
      sessionTarget: attempt.sessionTarget,
      sessionFile: attempt.sessionFile,
      tokenBudget: attempt.contextTokenBudget,
      modelId: attempt.modelId,
      ...(input.repairToolUseResultPairing
        ? {
            repairAssembledMessages: (messages) =>
              repairAttemptToolUseResultPairing(messages, input.isOpenAIResponsesApi),
          }
        : {}),
      getPrePromptMessageCount: input.getPrePromptMessageCount,
      onAfterTurnCheckpoint: (messageCount) => {
        contextEngineAfterTurnCheckpoint = messageCount;
      },
      getRuntimeContext: ({ messages, prePromptMessageCount }) =>
        buildAfterTurnRuntimeContext({
          attempt,
          workspaceDir: input.effectiveWorkspace,
          cwd: input.effectiveCwd,
          agentDir: input.agentDir,
          tokenBudget: attempt.contextTokenBudget,
          promptCache:
            input.getPromptCache() ??
            buildLoopPromptCacheInfo({
              messagesSnapshot: messages,
              prePromptMessageCount,
              retention: input.getEffectivePromptCacheRetention(),
              fallbackLastCacheTouchAt: readLastCacheTtlTimestamp(input.sessionManager, {
                provider: attempt.provider,
                modelId: attempt.modelId,
              }),
            }),
        }),
      runtimeSettings: buildContextEngineRuntimeSettings({
        contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
        provider: attempt.provider,
        requestedModel: attempt.requestedModelId,
        resolvedModel: attempt.modelId,
        selectedContextEngineId,
        contextEngineSelectionSource:
          selectedContextEngineId === "legacy" ? "default" : "configured",
        promptTokenBudget: attempt.contextTokenBudget,
        fallbackReason: attempt.fallbackReason,
        degradedReason: attempt.degradedReason,
      }),
      isHeartbeat: isHeartbeatLifecycleRunKind(attempt.bootstrapContextRunKind),
    });
    const removeToolResultGuard = installToolResultContextGuard({
      agent: activeSession.agent,
      contextWindowTokens: contextTokenBudgetForGuard,
      ...midTurnPrecheckOptions,
    });
    removeLoopContextGuard = () => {
      removeToolResultGuard();
      removeContextEngineLoopHook();
    };
  } else {
    removeLoopContextGuard = installToolResultContextGuard({
      agent: activeSession.agent,
      contextWindowTokens: contextTokenBudgetForGuard,
      ...midTurnPrecheckOptions,
    });
  }

  const removeHistoryImagePruneContextTransform = installHistoryImagePruneContextTransform(
    activeSession.agent,
  );
  const previousComputerFrameTransform = activeSession.agent.transformContext;
  activeSession.agent.transformContext = async (messages, signal) => {
    const transformed = previousComputerFrameTransform
      ? await previousComputerFrameTransform.call(activeSession.agent, messages, signal)
      : messages;
    const modelContext = Array.isArray(transformed) ? transformed : messages;
    invalidateComputerFrameIfMissing({
      contextEpoch: input.computerContextEpoch,
      messages: modelContext,
      imagesBlocked: settingsManager.getBlockImages(),
    });
    return modelContext;
  };

  return {
    cleanup: () => {
      activeSession.agent.transformContext = previousComputerFrameTransform;
      removeHistoryImagePruneContextTransform();
      removeLoopContextGuard();
    },
    getContextEngineAfterTurnCheckpoint: () => contextEngineAfterTurnCheckpoint,
    takePendingMidTurnPrecheckRequest: () => {
      const request = pendingMidTurnPrecheckRequest;
      pendingMidTurnPrecheckRequest = null;
      return request;
    },
  };
}
