// Persists the root ownership record for one Claw-created agent and workspace.
import { createHash } from "node:crypto";
import { stableStringify } from "../agents/stable-stringify.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { ClawAddPlan } from "./types.js";

export const CLAW_INSTALL_RECORD_SCHEMA_VERSION = "openclaw.clawInstallRecord.v1" as const;

export type ClawInstallStatus = "pending" | "complete" | "partial";

export type PersistedClawInstall = {
  schemaVersion: typeof CLAW_INSTALL_RECORD_SCHEMA_VERSION;
  claw: ClawAddPlan["claw"];
  manifestSchemaVersion: ClawAddPlan["manifestSchemaVersion"];
  planIntegrity: string;
  agentId: string;
  workspace: string;
  agentConfigDigest: string;
  agentOwnedPaths: string[];
  status: ClawInstallStatus;
  addedAtMs: number;
  updatedAtMs: number;
};

type InstallRow = {
  schema_version: string;
  source_kind: "package" | "development";
  claw_name: string;
  claw_version: string;
  package_root: string;
  manifest_path: string;
  integrity_kind: "artifact" | "development-snapshot";
  integrity: string;
  source_byte_length: number | bigint;
  manifest_schema_version: number | bigint;
  plan_integrity: string;
  agent_id: string;
  workspace: string;
  agent_config_digest: string;
  agent_owned_paths_json: string;
  status: ClawInstallStatus;
  added_at_ms: number | bigint;
  updated_at_ms: number | bigint;
};

function digestAgentConfig(plan: ClawAddPlan): string {
  return `sha256:${createHash("sha256").update(stableStringify(plan.agent.config)).digest("hex")}`;
}

function rowToInstall(row: InstallRow): PersistedClawInstall {
  return {
    schemaVersion: CLAW_INSTALL_RECORD_SCHEMA_VERSION,
    claw: {
      kind: row.source_kind,
      name: row.claw_name,
      version: row.claw_version,
      packageRoot: row.package_root,
      manifestPath: row.manifest_path,
      integrityKind: row.integrity_kind,
      integrity: row.integrity,
      byteLength: Number(row.source_byte_length),
    },
    manifestSchemaVersion: Number(row.manifest_schema_version) as 1,
    planIntegrity: row.plan_integrity,
    agentId: row.agent_id,
    workspace: row.workspace,
    agentConfigDigest: row.agent_config_digest,
    agentOwnedPaths: JSON.parse(row.agent_owned_paths_json) as string[],
    status: row.status,
    addedAtMs: Number(row.added_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export function persistClawInstallRecord(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & { status?: ClawInstallStatus; nowMs?: number } = {},
): PersistedClawInstall {
  const nowMs = options.nowMs ?? Date.now();
  const status = options.status ?? "complete";
  const agentConfigDigest = digestAgentConfig(plan);
  const agentOwnedPaths = plan.actions
    .filter((action) => action.kind === "agent")
    .map((action) => action.target);
  runOpenClawStateWriteTransaction(({ db }) => {
    db.prepare(
      `INSERT INTO claw_installs (
         agent_id, schema_version, source_kind, claw_name, claw_version,
         package_root, manifest_path, integrity_kind, integrity, source_byte_length,
         manifest_schema_version, plan_integrity, workspace, agent_config_digest,
         agent_owned_paths_json,
         status, added_at_ms, updated_at_ms
       ) VALUES (
         @agent_id, @schema_version, @source_kind, @claw_name, @claw_version,
         @package_root, @manifest_path, @integrity_kind, @integrity, @source_byte_length,
         @manifest_schema_version, @plan_integrity, @workspace, @agent_config_digest,
         @agent_owned_paths_json,
         @status, @added_at_ms, @updated_at_ms
       )`,
    ).run({
      agent_id: plan.agent.finalId,
      schema_version: CLAW_INSTALL_RECORD_SCHEMA_VERSION,
      source_kind: plan.claw.kind,
      claw_name: plan.claw.name,
      claw_version: plan.claw.version,
      package_root: plan.claw.packageRoot,
      manifest_path: plan.claw.manifestPath,
      integrity_kind: plan.claw.integrityKind,
      integrity: plan.claw.integrity,
      source_byte_length: plan.claw.byteLength,
      manifest_schema_version: plan.manifestSchemaVersion,
      plan_integrity: plan.planIntegrity,
      workspace: plan.agent.workspace,
      agent_config_digest: agentConfigDigest,
      agent_owned_paths_json: JSON.stringify(agentOwnedPaths),
      status,
      added_at_ms: nowMs,
      updated_at_ms: nowMs,
    });
  }, options);
  return {
    schemaVersion: CLAW_INSTALL_RECORD_SCHEMA_VERSION,
    claw: plan.claw,
    manifestSchemaVersion: plan.manifestSchemaVersion,
    planIntegrity: plan.planIntegrity,
    agentId: plan.agent.finalId,
    workspace: plan.agent.workspace,
    agentConfigDigest,
    agentOwnedPaths,
    status,
    addedAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

export function updateClawInstallRecordStatus(
  agentId: string,
  status: ClawInstallStatus,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    db.prepare("UPDATE claw_installs SET status = ?, updated_at_ms = ? WHERE agent_id = ?").run(
      status,
      options.nowMs ?? Date.now(),
      agentId,
    );
  }, options);
}

export function readClawInstallRecord(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawInstall | undefined {
  const database = openOpenClawStateDatabase(options);
  const row = database.db
    .prepare(
      `SELECT schema_version, source_kind, claw_name, claw_version, package_root,
              manifest_path, integrity_kind, integrity, source_byte_length,
              manifest_schema_version, plan_integrity, agent_id, workspace,
              agent_config_digest, agent_owned_paths_json,
              status, added_at_ms, updated_at_ms
         FROM claw_installs
        WHERE agent_id = ?`,
    )
    .get(agentId) as InstallRow | undefined;
  return row ? rowToInstall(row) : undefined;
}
