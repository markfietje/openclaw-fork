// Plugin runtime entrypoint assembles runtime helpers available to activated plugins.
import {
  hasAnyActiveAgentUsageBudgetConfig,
  resolveAgentUsageBudgetConfig,
} from "../../agents/usage-budget.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  generateImage as generateRuntimeImage,
  listRuntimeImageGenerationProviders,
} from "../../image-generation/runtime.js";
import {
  generateMusic as generateRuntimeMusic,
  listRuntimeMusicGenerationProviders,
} from "../../music-generation/runtime.js";
import { RequestScopedSubagentRuntimeError } from "../../plugin-sdk/error-runtime.js";
import {
  createLazyRuntimeMethod,
  createLazyRuntimeMethodBinder,
  createLazyRuntimeModule,
  createLazyRuntimeSurface,
} from "../../shared/lazy-runtime.js";
import { VERSION } from "../../version.js";
import {
  generateVideo as generateRuntimeVideo,
  listRuntimeVideoGenerationProviders,
} from "../../video-generation/runtime.js";
import { listWebSearchProviders, runWebSearch } from "../../web-search/runtime.js";
import { gatewaySubagentState } from "./gateway-bindings.js";
import { createRuntimeAgent } from "./runtime-agent.js";
import { defineCachedValue } from "./runtime-cache.js";
import { createRuntimeChannel } from "./runtime-channel.js";
import { createRuntimeConfig } from "./runtime-config.js";
import { createRuntimeEvents } from "./runtime-events.js";
import { createRuntimeLogging } from "./runtime-logging.js";
import { createRuntimeMedia } from "./runtime-media.js";
import { createRuntimeSystem } from "./runtime-system.js";
import { createRuntimeTaskFlow } from "./runtime-taskflow.js";
import { createRuntimeTasks } from "./runtime-tasks.js";
import type { CreatePluginRuntimeOptions, PluginRuntime } from "./types.js";

export type { CreatePluginRuntimeOptions } from "./types.js";
export {
  clearGatewaySubagentRuntime,
  setGatewayNodesRuntime,
  setGatewaySubagentRuntime,
} from "./gateway-bindings.js";

const loadTtsRuntime = createLazyRuntimeModule(() => import("../../tts/tts.js"));
const loadMediaUnderstandingRuntime = createLazyRuntimeModule(
  () => import("../../media-understanding/runtime.js"),
);
const loadModelAuthRuntime = createLazyRuntimeModule(
  () => import("./runtime-model-auth.runtime.js"),
);

type UsageBudgetRuntimeParams = {
  cfg?: OpenClawConfig;
  agentId?: string | null;
};

const USAGE_BUDGET_RUNTIME_MEDIA_DENIAL =
  "Plugin runtime media provider calls are unavailable while agent usage budgets are enabled because media provider calls are not yet individually budget-metered.";

const USAGE_BUDGET_RUNTIME_TTS_DENIAL =
  "Plugin runtime TTS provider calls are unavailable while agent usage budgets are enabled because speech provider calls are not yet individually budget-metered.";

const USAGE_BUDGET_RUNTIME_NODE_INVOKE_DENIAL =
  "Plugin runtime node invocations are unavailable while agent usage budgets are enabled because node commands are not yet individually budget-metered.";

function hasActiveUsageBudget(params: UsageBudgetRuntimeParams): boolean {
  const cfg = params.cfg ?? getRuntimeConfig();
  if (params.agentId === undefined || params.agentId === null) {
    return hasAnyActiveAgentUsageBudgetConfig(cfg);
  }
  return Boolean(
    resolveAgentUsageBudgetConfig({
      config: cfg,
      agentId: params.agentId,
    }),
  );
}

function assertRuntimeMediaUsageBudgetAllowed(params: UsageBudgetRuntimeParams): void {
  if (hasActiveUsageBudget(params)) {
    throw new Error(USAGE_BUDGET_RUNTIME_MEDIA_DENIAL);
  }
}

function resolveRuntimeTtsUsageBudgetDenial(params: UsageBudgetRuntimeParams): string | undefined {
  return hasActiveUsageBudget(params) ? USAGE_BUDGET_RUNTIME_TTS_DENIAL : undefined;
}

function assertRuntimeNodeInvokeUsageBudgetAllowed(params: UsageBudgetRuntimeParams): void {
  if (hasActiveUsageBudget(params)) {
    throw new Error(USAGE_BUDGET_RUNTIME_NODE_INVOKE_DENIAL);
  }
}

function createRuntimeTts(): PluginRuntime["tts"] {
  const bindTtsRuntime = createLazyRuntimeMethodBinder(loadTtsRuntime);
  const textToSpeech = bindTtsRuntime((runtime) => runtime.textToSpeech);
  const textToSpeechStream = bindTtsRuntime((runtime) => runtime.textToSpeechStream);
  const textToSpeechTelephony = bindTtsRuntime((runtime) => runtime.textToSpeechTelephony);
  return {
    textToSpeech: async (params) => {
      // Channel-native TTS reaches provider synthesis through api.runtime.tts;
      // fail here so budgeted agents cannot bypass model-call metering.
      const denial = resolveRuntimeTtsUsageBudgetDenial(params);
      if (denial) {
        return { success: false, error: denial };
      }
      return await textToSpeech(params);
    },
    textToSpeechStream: async (params) => {
      const denial = resolveRuntimeTtsUsageBudgetDenial(params);
      if (denial) {
        return { success: false, error: denial };
      }
      return await textToSpeechStream(params);
    },
    textToSpeechTelephony: async (params) => {
      const denial = resolveRuntimeTtsUsageBudgetDenial(params);
      if (denial) {
        return { success: false, error: denial };
      }
      return await textToSpeechTelephony(params);
    },
    listVoices: bindTtsRuntime((runtime) => runtime.listSpeechVoices),
  };
}

function createRuntimeMediaUnderstandingFacade(): PluginRuntime["mediaUnderstanding"] {
  const bindMediaUnderstandingRuntime = createLazyRuntimeMethodBinder(
    loadMediaUnderstandingRuntime,
  );
  const runFile = bindMediaUnderstandingRuntime((runtime) => runtime.runMediaUnderstandingFile);
  const describeImageFile = bindMediaUnderstandingRuntime((runtime) => runtime.describeImageFile);
  const describeImageFileWithModel = bindMediaUnderstandingRuntime(
    (runtime) => runtime.describeImageFileWithModel,
  );
  const extractStructuredWithModel = bindMediaUnderstandingRuntime(
    (runtime) => runtime.extractStructuredWithModel,
  );
  const describeVideoFile = bindMediaUnderstandingRuntime((runtime) => runtime.describeVideoFile);
  const transcribeAudioFile = bindMediaUnderstandingRuntime(
    (runtime) => runtime.transcribeAudioFile,
  );
  return {
    runFile: async (params) => {
      assertRuntimeMediaUsageBudgetAllowed(params);
      return await runFile(params);
    },
    describeImageFile: async (params) => {
      assertRuntimeMediaUsageBudgetAllowed(params);
      return await describeImageFile(params);
    },
    describeImageFileWithModel: async (params) => {
      assertRuntimeMediaUsageBudgetAllowed(params);
      return await describeImageFileWithModel(params);
    },
    extractStructuredWithModel: async (params) => {
      assertRuntimeMediaUsageBudgetAllowed(params);
      return await extractStructuredWithModel(params);
    },
    describeVideoFile: async (params) => {
      assertRuntimeMediaUsageBudgetAllowed(params);
      return await describeVideoFile(params);
    },
    transcribeAudioFile: async (params) => {
      assertRuntimeMediaUsageBudgetAllowed(params);
      return await transcribeAudioFile(params);
    },
  };
}

function createRuntimeImageGeneration(): PluginRuntime["imageGeneration"] {
  return {
    generate: async (params) => {
      assertRuntimeMediaUsageBudgetAllowed(params);
      return await generateRuntimeImage(params);
    },
    listProviders: (params) => listRuntimeImageGenerationProviders(params),
  };
}

function createRuntimeVideoGeneration(): PluginRuntime["videoGeneration"] {
  return {
    generate: async (params) => {
      assertRuntimeMediaUsageBudgetAllowed(params);
      return await generateRuntimeVideo(params);
    },
    listProviders: (params) => listRuntimeVideoGenerationProviders(params),
  };
}

function createRuntimeMusicGeneration(): PluginRuntime["musicGeneration"] {
  return {
    generate: async (params) => {
      assertRuntimeMediaUsageBudgetAllowed(params);
      return await generateRuntimeMusic(params);
    },
    listProviders: (params) => listRuntimeMusicGenerationProviders(params),
  };
}

function createRuntimeLlmFacade(): PluginRuntime["llm"] {
  const loadLlm = createLazyRuntimeSurface(
    () => import("./runtime-llm.runtime.js"),
    (m) =>
      m.createRuntimeLlm({
        getConfig: getRuntimeConfig,
        authority: {
          allowComplete: true,
        },
      }),
  );
  return {
    complete: async (params) => {
      const llm = await loadLlm();
      return llm.complete(params);
    },
  };
}

function createRuntimeModelAuth(): PluginRuntime["modelAuth"] {
  const getApiKeyForModel = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.getApiKeyForModel,
  );
  const getRuntimeAuthForModel = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.getRuntimeAuthForModel,
  );
  const resolveApiKeyForProvider = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.resolveApiKeyForProvider,
  );
  return {
    getApiKeyForModel: (params) =>
      getApiKeyForModel({
        model: params.model,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
      }),
    getRuntimeAuthForModel: (params) =>
      getRuntimeAuthForModel({
        model: params.model,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
      }),
    resolveApiKeyForProvider: (params) =>
      resolveApiKeyForProvider({
        provider: params.provider,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
      }),
  };
}

function createUnavailableSubagentRuntime(): PluginRuntime["subagent"] {
  const unavailable = () => {
    throw new RequestScopedSubagentRuntimeError();
  };
  return {
    run: unavailable,
    waitForRun: unavailable,
    getSessionMessages: unavailable,
    getSession: unavailable,
    deleteSession: unavailable,
  };
}

// ── Process-global gateway subagent runtime ─────────────────────────
// The gateway creates a real subagent runtime during startup, but gateway-owned
// plugin registries may be loaded (and cached) before the gateway path runs.
// A process-global holder lets explicitly gateway-bindable runtimes resolve the
// active gateway subagent dynamically without changing the default behavior for
// ordinary plugin runtimes.

/**
 * Create a late-binding subagent that resolves to:
 * 1. An explicitly provided subagent (from runtimeOptions), OR
 * 2. The process-global gateway subagent when the caller explicitly opts in, OR
 * 3. The unavailable fallback (throws with a clear error message).
 */
function createLateBindingSubagent(
  explicit?: PluginRuntime["subagent"],
  allowGatewaySubagentBinding = false,
): PluginRuntime["subagent"] {
  if (explicit) {
    return explicit;
  }

  const unavailable = createUnavailableSubagentRuntime();
  if (!allowGatewaySubagentBinding) {
    return unavailable;
  }

  return new Proxy(unavailable, {
    get(_target, prop, _receiver) {
      const resolved = gatewaySubagentState.subagent ?? unavailable;
      return Reflect.get(resolved, prop, resolved);
    },
  });
}

function createUnavailableNodesRuntime(): PluginRuntime["nodes"] {
  const unavailable = () => {
    throw new Error("Plugin node runtime is only available inside the Gateway.");
  };
  return {
    list: unavailable,
    invoke: unavailable,
  };
}

function createLateBindingNodes(allowGatewayBinding = false): PluginRuntime["nodes"] {
  const unavailable = createUnavailableNodesRuntime();
  if (!allowGatewayBinding) {
    return unavailable;
  }
  return new Proxy(unavailable, {
    get(_target, prop, _receiver) {
      const resolved = gatewaySubagentState.nodes ?? unavailable;
      return Reflect.get(resolved, prop, resolved);
    },
  });
}

function createUsageBudgetGuardedNodesRuntime(
  nodes: PluginRuntime["nodes"],
): PluginRuntime["nodes"] {
  return {
    list: (params) => nodes.list(params),
    invoke: async (params) => {
      const { cfg, agentId, ...invokeParams } = params;
      assertRuntimeNodeInvokeUsageBudgetAllowed({
        cfg: cfg ?? getRuntimeConfig(),
        ...(agentId !== undefined ? { agentId } : {}),
      });
      return await nodes.invoke(invokeParams);
    },
  };
}

export function createPluginRuntime(_options: CreatePluginRuntimeOptions = {}): PluginRuntime {
  const mediaUnderstanding = createRuntimeMediaUnderstandingFacade();
  const taskFlow = createRuntimeTaskFlow();
  const tasks = createRuntimeTasks({
    legacyTaskFlow: taskFlow,
  });
  const runtime = {
    // Sourced from the shared OpenClaw version resolver (#52899) so plugins
    // always see the same version the CLI reports, avoiding API-version drift.
    version: VERSION,
    config: createRuntimeConfig(),
    agent: createRuntimeAgent(),
    subagent: createLateBindingSubagent(
      _options.subagent,
      _options.allowGatewaySubagentBinding === true,
    ),
    nodes: createUsageBudgetGuardedNodesRuntime(
      _options.nodes ?? createLateBindingNodes(_options.allowGatewaySubagentBinding === true),
    ),
    system: createRuntimeSystem(),
    media: createRuntimeMedia(),
    webSearch: {
      listProviders: listWebSearchProviders,
      search: runWebSearch,
    },
    channel: createRuntimeChannel(),
    events: createRuntimeEvents(),
    logging: createRuntimeLogging(),
    state: {
      resolveStateDir,
      openKeyedStore: () => {
        throw new Error("openKeyedStore is only available through the plugin runtime proxy.");
      },
      openSyncKeyedStore: () => {
        throw new Error("openSyncKeyedStore is only available through the plugin runtime proxy.");
      },
      openChannelIngressQueue: () => {
        throw new Error(
          "openChannelIngressQueue is only available through the plugin runtime proxy.",
        );
      },
    },
    tasks,
    taskFlow,
  } satisfies Omit<
    PluginRuntime,
    | "tts"
    | "mediaUnderstanding"
    | "stt"
    | "modelAuth"
    | "imageGeneration"
    | "videoGeneration"
    | "musicGeneration"
    | "llm"
  > &
    Partial<
      Pick<
        PluginRuntime,
        | "tts"
        | "mediaUnderstanding"
        | "stt"
        | "modelAuth"
        | "imageGeneration"
        | "videoGeneration"
        | "musicGeneration"
        | "llm"
      >
    >;

  defineCachedValue(runtime, "tts", createRuntimeTts);
  defineCachedValue(runtime, "mediaUnderstanding", () => mediaUnderstanding);
  defineCachedValue(runtime, "stt", () => ({
    transcribeAudioFile: mediaUnderstanding.transcribeAudioFile,
  }));
  defineCachedValue(runtime, "modelAuth", createRuntimeModelAuth);
  defineCachedValue(runtime, "imageGeneration", createRuntimeImageGeneration);
  defineCachedValue(runtime, "videoGeneration", createRuntimeVideoGeneration);
  defineCachedValue(runtime, "musicGeneration", createRuntimeMusicGeneration);
  defineCachedValue(runtime, "llm", createRuntimeLlmFacade);

  return runtime as unknown as PluginRuntime;
}

export type { PluginRuntime } from "./types.js";
