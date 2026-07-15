// Persists the root ownership record for one Claw-created agent and workspace.
import { createHash } from "node:crypto";
import { stableStringify } from "../agents/stable-stringify.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { ClawAddPlan, ClawPackage } from "./types.js";

const CLAW_INSTALL_RECORD_SCHEMA_VERSION = "openclaw.clawInstallRecord.v1" as const;

type ClawInstallStatus = "pending" | "complete" | "partial";

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

function digestAgentConfig(plan: ClawAddPlan): string {
  return `sha256:${createHash("sha256").update(stableStringify(plan.agent.config)).digest("hex")}`;
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
    // sqlite-allow-raw: this Claw prototype state-table write is scoped to one owned row.
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
    // sqlite-allow-raw: this Claw prototype state-table write is scoped to one owned row.
    db.prepare("UPDATE claw_installs SET status = ?, updated_at_ms = ? WHERE agent_id = ?").run(
      status,
      options.nowMs ?? Date.now(),
      agentId,
    );
  }, options);
}


export const CLAW_PACKAGE_REF_SCHEMA_VERSION = "openclaw.clawPackageRef.v1" as const;
export type ClawPackageRefStatus = "pending" | "complete";
export type ClawPackageOwnership = "claw-installed" | "preexisting";

export type PersistedClawPackageRef = {
  schemaVersion: typeof CLAW_PACKAGE_REF_SCHEMA_VERSION;
  agentId: string;
  clawName: string;
  kind: ClawPackage["kind"];
  source: ClawPackage["source"];
  ref: string;
  version: string;
  status: ClawPackageRefStatus;
  ownership: ClawPackageOwnership;
  installedAtMs: number;
};

type PackageRefRow = {
  schema_version: string;
  agent_id: string;
  claw_name: string;
  package_kind: ClawPackage["kind"];
  package_source: ClawPackage["source"];
  package_ref: string;
  package_version: string;
  package_status: ClawPackageRefStatus;
  ownership: ClawPackageOwnership;
  installed_at_ms: number | bigint;
};

function rowToPackageRef(row: PackageRefRow): PersistedClawPackageRef {
  return {
    schemaVersion: CLAW_PACKAGE_REF_SCHEMA_VERSION,
    agentId: row.agent_id,
    clawName: row.claw_name,
    kind: row.package_kind,
    source: row.package_source,
    ref: row.package_ref,
    version: row.package_version,
    status: row.package_status,
    ownership: row.ownership,
    installedAtMs: Number(row.installed_at_ms),
  };
}

export function persistClawPackageRef(
  plan: ClawAddPlan,
  pkg: ClawPackage,
  options: OpenClawStateDatabaseOptions & {
    nowMs?: number;
    status?: ClawPackageRefStatus;
    ownership?: ClawPackageOwnership;
  } = {},
): PersistedClawPackageRef {
  const record: PersistedClawPackageRef = {
    schemaVersion: CLAW_PACKAGE_REF_SCHEMA_VERSION,
    agentId: plan.agent.finalId,
    clawName: plan.claw.name,
    kind: pkg.kind,
    source: pkg.source,
    ref: pkg.ref,
    version: pkg.version,
    status: options.status ?? "complete",
    ownership: options.ownership ?? "claw-installed",
    installedAtMs: options.nowMs ?? Date.now(),
  };
  runOpenClawStateWriteTransaction(({ db }) => {
    // sqlite-allow-raw: this Claw prototype state-table write is scoped to one owned row.
    db.prepare(
      `INSERT INTO claw_package_refs (
         agent_id, package_kind, package_source, package_ref, package_version,
         schema_version, claw_name, package_status, ownership, installed_at_ms
       ) VALUES (
         @agent_id, @package_kind, @package_source, @package_ref, @package_version,
         @schema_version, @claw_name, @package_status, @ownership, @installed_at_ms
       )`,
    ).run({
      agent_id: record.agentId,
      package_kind: record.kind,
      package_source: record.source,
      package_ref: record.ref,
      package_version: record.version,
      schema_version: record.schemaVersion,
      claw_name: record.clawName,
      package_status: record.status,
      ownership: record.ownership,
      installed_at_ms: record.installedAtMs,
    });
  }, options);
  return record;
}

export function updateClawPackageRefStatus(
  ref: PersistedClawPackageRef,
  status: ClawPackageRefStatus,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawPackageRef {
  runOpenClawStateWriteTransaction(({ db }) => {
    // sqlite-allow-raw: this Claw package reference status update is scoped to one owned row.
    db.prepare(
      `UPDATE claw_package_refs
          SET package_status = @package_status
        WHERE agent_id = @agent_id
          AND package_kind = @package_kind
          AND package_source = @package_source
          AND package_ref = @package_ref
          AND package_version = @package_version`,
    ).run({
      agent_id: ref.agentId,
      package_kind: ref.kind,
      package_source: ref.source,
      package_ref: ref.ref,
      package_version: ref.version,
      package_status: status,
    });
  }, options);
  return { ...ref, status };
}

export function readClawPackageRefs(
  options: OpenClawStateDatabaseOptions & {
    kind?: ClawPackage["kind"];
    source?: ClawPackage["source"];
    ref?: string;
    version?: string;
    status?: ClawPackageRefStatus;
  } = {},
): PersistedClawPackageRef[] {
  const database = openOpenClawStateDatabase(options);
  const conditions: string[] = [];
  const params: Record<string, string> = {};
  for (const [column, value] of [
    ["package_kind", options.kind],
    ["package_source", options.source],
    ["package_ref", options.ref],
    ["package_version", options.version],
    ["package_status", options.status],
  ] as const) {
    if (value !== undefined) {
      conditions.push(`${column} = @${column}`);
      params[column] = value;
    }
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const rows = database.db
    // sqlite-allow-raw: read-only Claw package reference lookup with closed column filters.
    .prepare(
      `SELECT schema_version, agent_id, claw_name, package_kind, package_source,
              package_ref, package_version, package_status, ownership, installed_at_ms
         FROM claw_package_refs${where}
        ORDER BY agent_id, package_kind, package_ref`,
    )
    .all(params) as PackageRefRow[];
  return rows.map(rowToPackageRef);
}
