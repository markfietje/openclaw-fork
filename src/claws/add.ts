// Applies a consented Claw add plan in a recoverable order.
import { mkdir, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { transformConfigFileWithRetry } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveUserPath } from "../utils.js";
import { ClawPackageInstallError, installClawPackages } from "./packages.js";
import {
  persistClawInstallRecord,
  updateClawInstallRecordStatus,
  type PersistedClawInstall,
  type PersistedClawPackageRef,
} from "./provenance.js";
import { CLAW_OUTPUT_STABILITY, type ClawAddPlan } from "./types.js";
import {
  ClawWorkspaceWriteError,
  createClawWorkspaceFiles,
  type PersistedClawWorkspaceFile,
} from "./workspace.js";

export const CLAW_ADD_RESULT_SCHEMA_VERSION = "openclaw.clawAddResult.v1" as const;

type ConfigCommit = (transform: (config: OpenClawConfig) => OpenClawConfig) => Promise<void>;

export class ClawAddMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawAddMutationError";
  }
}

export type ClawAddResult = {
  schemaVersion: typeof CLAW_ADD_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: false;
  mutationAllowed: true;
  planIntegrity: string;
  status: "complete" | "partial";
  claw: ClawAddPlan["claw"];
  agent: ClawAddPlan["agent"];
  workspaceCreated: boolean;
  configCommitted: boolean;
  workspaceFiles: PersistedClawWorkspaceFile[];
  packages: PersistedClawPackageRef[];
  installRecord?: PersistedClawInstall;
  error?: {
    code: string;
    message: string;
    diagnostics?: ClawWorkspaceWriteError["diagnostics"];
  };
};

function hasUnsupportedMutationActions(plan: ClawAddPlan): boolean {
  return plan.actions.some(
    (action) => !["agent", "workspace", "workspaceFile", "package"].includes(action.kind),
  );
}

function partialResult(params: {
  plan: ClawAddPlan;
  installRecord: PersistedClawInstall;
  workspaceCreated: boolean;
  configCommitted: boolean;
  workspaceFiles?: PersistedClawWorkspaceFile[];
  packages?: PersistedClawPackageRef[];
  error: ClawAddResult["error"];
  nowMs?: number;
}): ClawAddResult {
  return {
    schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: false,
    mutationAllowed: true,
    planIntegrity: params.plan.planIntegrity,
    status: "partial",
    claw: params.plan.claw,
    agent: params.plan.agent,
    workspaceCreated: params.workspaceCreated,
    configCommitted: params.configCommitted,
    workspaceFiles: params.workspaceFiles ?? [],
    packages: params.packages ?? [],
    installRecord: {
      ...params.installRecord,
      status: "partial",
      updatedAtMs: params.nowMs ?? Date.now(),
    },
    error: params.error,
  };
}

export async function applyClawAddPlan(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & {
    consentPlanIntegrity?: string;
    commitConfig?: ConfigCommit;
    persistRecord?: typeof persistClawInstallRecord;
    updateRecord?: typeof updateClawInstallRecordStatus;
    createWorkspaceFiles?: typeof createClawWorkspaceFiles;
    installPackages?: typeof installClawPackages;
    nowMs?: number;
  } = {},
): Promise<ClawAddResult> {
  if (plan.blockers.length > 0) {
    throw new ClawAddMutationError("plan_blocked", "The Claw add plan contains blockers.");
  }
  if (hasUnsupportedMutationActions(plan)) {
    throw new ClawAddMutationError(
      "unsupported_components",
      "This build can add agent settings, workspace files, and declared packages; MCP servers and cron jobs require later lifecycle slices.",
    );
  }
  if (options.consentPlanIntegrity !== plan.planIntegrity) {
    throw new ClawAddMutationError(
      "plan_integrity_mismatch",
      "Consent does not match the current Claw add plan; run add --dry-run again.",
    );
  }

  const persistRecord = options.persistRecord ?? persistClawInstallRecord;
  let installRecord: PersistedClawInstall;
  try {
    installRecord = persistRecord(plan, { ...options, status: "pending" });
  } catch (error) {
    throw new ClawAddMutationError("provenance_failed", (error as Error).message);
  }

  const updateRecord = options.updateRecord ?? updateClawInstallRecordStatus;
  const installPackages = options.installPackages ?? installClawPackages;
  let packages: PersistedClawPackageRef[] = [];
  try {
    // Package installers retain their own trust and integrity gates. Run them before
    // creating the target agent or writing its workspace/configuration.
    packages = await installPackages(plan, options);
  } catch (error) {
    const packageError =
      error instanceof ClawPackageInstallError
        ? error
        : new ClawPackageInstallError(
            "package_install_failed",
            error instanceof Error ? error.message : String(error),
            packages,
          );
    updateRecord(plan.agent.finalId, "partial", options);
    return partialResult({
      plan,
      installRecord,
      workspaceCreated: false,
      configCommitted: false,
      packages: packageError.installedPackages,
      error: { code: packageError.code, message: packageError.message },
      nowMs: options.nowMs,
    });
  }

  const workspace = resolve(resolveUserPath(plan.agent.workspace));
  await mkdir(dirname(workspace), { recursive: true });
  try {
    await mkdir(workspace);
  } catch (error) {
    updateRecord(plan.agent.finalId, "partial", options);
    return partialResult({
      plan,
      installRecord,
      workspaceCreated: false,
      configCommitted: false,
      packages,
      error: {
        code: "workspace_collision",
        message: "Could not create new workspace " + JSON.stringify(workspace) + ": " + (error as Error).message,
      },
      nowMs: options.nowMs,
    });
  }

  try {
    const commit: ConfigCommit =
      options.commitConfig ??
      (async (transform) => {
        await transformConfigFileWithRetry({
          afterWrite: { mode: "auto" },
          transform: (config) => ({ nextConfig: transform(config) }),
        });
      });
    await commit((config) => {
      const existingAgents = config.agents?.list ?? [];
      if (listAgentIds(config).includes(plan.agent.finalId)) {
        throw new ClawAddMutationError(
          "agent_id_collision",
          "Agent " + JSON.stringify(plan.agent.finalId) + " was created after planning.",
        );
      }
      if (
        listAgentIds(config).some(
          (agentId) => resolve(resolveAgentWorkspaceDir(config, agentId)) === workspace,
        )
      ) {
        throw new ClawAddMutationError(
          "workspace_collision",
          "Workspace " + JSON.stringify(workspace) + " is already assigned to an agent.",
        );
      }
      return {
        ...config,
        agents: {
          ...config.agents,
          list: [...existingAgents, plan.agent.config],
        },
      };
    });
  } catch (error) {
    await rmdir(workspace).catch(() => undefined);
    updateRecord(plan.agent.finalId, "partial", options);
    throw error;
  }

  const createFiles = options.createWorkspaceFiles ?? createClawWorkspaceFiles;
  let workspaceFiles: PersistedClawWorkspaceFile[] = [];
  try {
    workspaceFiles = await createFiles(plan, options);
  } catch (error) {
    const workspaceError =
      error instanceof ClawWorkspaceWriteError
        ? error
        : new ClawWorkspaceWriteError(
            [
              {
                level: "error",
                code: "workspace_file_io_error",
                phase: "mutation",
                path: "$.workspace",
                message: error instanceof Error ? error.message : String(error),
              },
            ],
            workspaceFiles,
          );
    updateRecord(plan.agent.finalId, "partial", options);
    return partialResult({
      plan,
      installRecord,
      workspaceCreated: true,
      configCommitted: true,
      workspaceFiles: workspaceError.createdFiles,
      packages,
      error: {
        code: "workspace_files_failed",
        message: workspaceError.message,
        diagnostics: workspaceError.diagnostics,
      },
      nowMs: options.nowMs,
    });
  }

  try {
    updateRecord(plan.agent.finalId, "complete", options);
  } catch (error) {
    return partialResult({
      plan,
      installRecord,
      workspaceCreated: true,
      configCommitted: true,
      workspaceFiles,
      packages,
      error: { code: "provenance_failed", message: (error as Error).message },
      nowMs: options.nowMs,
    });
  }

  return {
    schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: false,
    mutationAllowed: true,
    planIntegrity: plan.planIntegrity,
    status: "complete",
    claw: plan.claw,
    agent: plan.agent,
    workspaceCreated: true,
    configCommitted: true,
    packages,
    workspaceFiles,
    installRecord: {
      ...installRecord,
      status: "complete",
      updatedAtMs: options.nowMs ?? Date.now(),
    },
  };
}
