import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import { resolveAgentHarnessPolicy } from "./policy.js";

export const PASSIVE_ROOM_OBSERVATION_RUNTIME_REQUIREMENT =
  "Passive room observations require the embedded OpenClaw runtime with an official core OpenAI model and transport.";

export class PassiveRoomObservationAdmissionError extends Error {
  readonly code = "runtime_model" as const;
  readonly reason = PASSIVE_ROOM_OBSERVATION_RUNTIME_REQUIREMENT;
  readonly provider?: string;
  readonly model?: string;

  constructor(params: { provider?: string; model?: string } = {}) {
    super(PASSIVE_ROOM_OBSERVATION_RUNTIME_REQUIREMENT);
    this.name = "PassiveRoomObservationAdmissionError";
    this.provider = params.provider;
    this.model = params.model;
  }
}

export function isPassiveRoomObservationAdmissionError(
  error: unknown,
): error is PassiveRoomObservationAdmissionError {
  return error instanceof PassiveRoomObservationAdmissionError;
}

function hasCustomOpenAITransport(config?: OpenClawConfig): boolean {
  const providers = config?.models?.providers;
  if (!providers) {
    return false;
  }
  const configured = Object.entries(providers).find(
    ([provider]) => normalizeProviderId(provider) === "openai",
  )?.[1];
  if (!configured) {
    return false;
  }
  return Boolean(
    configured.baseUrl ||
    configured.api ||
    configured.models?.length ||
    (configured.auth !== undefined && configured.auth !== "api-key") ||
    Object.keys(configured.headers ?? {}).length > 0 ||
    configured.authHeader !== undefined ||
    configured.request ||
    configured.localService ||
    configured.agentRuntime ||
    Object.keys(configured.params ?? {}).length > 0 ||
    configured.injectNumCtxForOpenAICompat !== undefined ||
    configured.region,
  );
}

function isOfficialOpenAIBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "api.openai.com" &&
      url.port === "" &&
      !url.username &&
      !url.password &&
      (url.pathname === "/v1" || url.pathname === "/v1/") &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function canRunPassiveRoomObservationWithResolvedModel(params: {
  config?: OpenClawConfig;
  provider?: string;
  model: Pick<Model, "provider" | "api" | "baseUrl" | "headers">;
}): boolean {
  return (
    normalizeProviderId(params.provider ?? "") === "openai" &&
    normalizeProviderId(params.model.provider) === "openai" &&
    !hasCustomOpenAITransport(params.config) &&
    (params.model.api === "openai-responses" || params.model.api === "openai-completions") &&
    isOfficialOpenAIBaseUrl(params.model.baseUrl) &&
    Object.keys(params.model.headers ?? {}).length === 0
  );
}

export function canRunPassiveRoomObservationWithEmbeddedHarness(params: {
  config?: OpenClawConfig;
  provider?: string;
  modelId?: string;
  agentId?: string;
  sessionKey?: string;
  runtimeOverride?: string;
}): boolean {
  if (normalizeProviderId(params.provider ?? "") !== "openai") {
    return false;
  }
  if (hasCustomOpenAITransport(params.config)) {
    return false;
  }
  const runtimeOverride = normalizeOptionalAgentRuntimeId(params.runtimeOverride);
  const configured = resolveAgentHarnessPolicy({
    config: params.config,
    provider: params.provider,
    modelId: params.modelId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const runtime =
    runtimeOverride && !isDefaultAgentRuntimeId(runtimeOverride)
      ? runtimeOverride
      : configured.runtime;
  return (
    runtime === "openclaw" ||
    runtime === "auto" ||
    // Official OpenAI routes default implicitly to Codex. Passive observations
    // deliberately replace that implicit choice with the isolated core runner;
    // an explicit model/provider/session Codex selection remains rejected.
    (runtime === "codex" && !runtimeOverride && configured.runtimeSource === "implicit")
  );
}
