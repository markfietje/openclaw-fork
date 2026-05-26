import { createSubsystemLogger } from "../../logging/subsystem.js";
import { ensureSelectedAgentHarnessPlugin } from "./runtime-plugin.js";
import { selectAgentHarness } from "./selection.js";
import type { AgentHarnessPrewarmParams } from "./types.js";

const log = createSubsystemLogger("agents/harness");

export type AgentHarnessPrewarmStatus =
  | {
      status: "pi" | "unsupported";
      harnessId: string;
    }
  | {
      status: "warmed";
      harnessId: string;
    }
  | {
      status: "failed";
      harnessId?: string;
      error: string;
    };

export async function prewarmAgentHarnessRuntime(
  params: AgentHarnessPrewarmParams,
): Promise<AgentHarnessPrewarmStatus> {
  try {
    if (params.workspaceDir) {
      await ensureSelectedAgentHarnessPlugin({
        config: params.cfg,
        provider: params.provider,
        modelId: params.modelId ?? "",
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
      });
    }
    const harness = selectAgentHarness({
      provider: params.provider,
      modelId: params.modelId,
      config: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    });
    if (harness.id === "pi") {
      return { status: "pi", harnessId: harness.id };
    }
    if (!harness.prewarm) {
      return { status: "unsupported", harnessId: harness.id };
    }
    await harness.prewarm(params);
    return { status: "warmed", harnessId: harness.id };
  } catch (error) {
    log.warn("agent harness prewarm failed", {
      provider: params.provider,
      modelId: params.modelId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      error,
    });
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
