// Persists the root ownership record for one Claw-created agent and workspace.
import { createHash } from "node:crypto";
import { stableStringify } from "../agents/stable-stringify.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { ClawAddPlan, ClawPackage } from "./types.js";

export const CLAW_INSTALL_RECORD_SCHEMA_VERSION = "openclaw.clawInstallRecord.v1" as const;

export type ClawInstallStatus = "pending" | "complete" | "partial";

export type PersistedClawInstall = {
  schemaVersion: typeof CLAW_INSTALL_RECORD_SCHEMA_VERSION;
  claw: ClawAddPlan["claw"];
  agentId: string;
  workspace: string;
  agentConfigDigest: string;
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
  integrity: string;
  agent_id: string;
  workspace: string;
  agent_config_digest: string;
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
      integrity: row.integrity,
    },
    agentId: row.agent_id,
    workspace: row.workspace,
    agentConfigDigest: row.agent_config_digest,
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
  runOpenClawStateWriteTransaction(({ db }) => {
    db.prepare(
      `INSERT INTO claw_installs (
         agent_id, schema_version, source_kind, claw_name, claw_version,
         package_root, manifest_path, integrity, workspace, agent_config_digest,
         status, added_at_ms, updated_at_ms
       ) VALUES (
         @agent_id, @schema_version, @source_kind, @claw_name, @claw_version,
         @package_root, @manifest_path, @integrity, @workspace, @agent_config_digest,
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
      integrity: plan.claw.integrity,
      workspace: plan.agent.workspace,
      agent_config_digest: agentConfigDigest,
      status,
      added_at_ms: nowMs,
      updated_at_ms: nowMs,
    });
  }, options);
  return {
    schemaVersion: CLAW_INSTALL_RECORD_SCHEMA_VERSION,
    claw: plan.claw,
    agentId: plan.agent.finalId,
    workspace: plan.agent.workspace,
    agentConfigDigest,
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
              manifest_path, integrity, agent_id, workspace, agent_config_digest,
              status, added_at_ms, updated_at_ms
         FROM claw_installs
        WHERE agent_id = ?`,
    )
    .get(agentId) as InstallRow | undefined;
  return row ? rowToInstall(row) : undefined;
}

export function readClawInstallRecords(
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawInstall[] {
  const database = openOpenClawStateDatabase(options);
  const rows = database.db
    .prepare(
      `SELECT schema_version, source_kind, claw_name, claw_version, package_root,
              manifest_path, integrity, agent_id, workspace, agent_config_digest,
              status, added_at_ms, updated_at_ms
         FROM claw_installs
        ORDER BY agent_id`,
    )
    .all() as InstallRow[];
  return rows.map(rowToInstall);
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

export function updateClawInstallRecord(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & {
    nowMs?: number;
    expectedClaw?: { version: string; integrity: string };
  } = {},
): PersistedClawInstall {
  const current = readClawInstallRecord(plan.agent.finalId, options);
  if (!current) {
    throw new Error(
      `No Claw install record exists for agent ${JSON.stringify(plan.agent.finalId)}.`,
    );
  }
  const updatedAtMs = options.nowMs ?? Date.now();
  const agentConfigDigest = digestAgentConfig(plan);
  runOpenClawStateWriteTransaction(({ db }) => {
    ensureClawInstallTable(db);
    const result = db
      .prepare(
        `UPDATE claw_installs
            SET source_kind = @source_kind,
                claw_name = @claw_name,
                claw_version = @claw_version,
                package_root = @package_root,
                manifest_path = @manifest_path,
                integrity = @integrity,
                workspace = @workspace,
                agent_config_digest = @agent_config_digest,
                status = 'complete',
                updated_at_ms = @updated_at_ms
          WHERE agent_id = @agent_id
            AND claw_version = @expected_claw_version
            AND integrity = @expected_integrity`,
      )
      .run({
        agent_id: plan.agent.finalId,
        source_kind: plan.claw.kind,
        claw_name: plan.claw.name,
        claw_version: plan.claw.version,
        package_root: plan.claw.packageRoot,
        manifest_path: plan.claw.manifestPath,
        integrity: plan.claw.integrity,
        workspace: plan.agent.workspace,
        agent_config_digest: agentConfigDigest,
        updated_at_ms: updatedAtMs,
        expected_claw_version: options.expectedClaw?.version ?? current.claw.version,
        expected_integrity: options.expectedClaw?.integrity ?? current.claw.integrity,
      });
    if (Number(result.changes) !== 1) {
      throw new Error(
        `Claw install record changed for agent ${JSON.stringify(plan.agent.finalId)}.`,
      );
    }
  }, options);
  return {
    schemaVersion: CLAW_INSTALL_RECORD_SCHEMA_VERSION,
    claw: plan.claw,
    agentId: plan.agent.finalId,
    workspace: plan.agent.workspace,
    agentConfigDigest,
    status: "complete",
    addedAtMs: current.addedAtMs,
    updatedAtMs,
  };
}

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
    agentId?: string;
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
    ["agent_id", options.agentId],
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
    .prepare(
      `SELECT schema_version, agent_id, claw_name, package_kind, package_source,
              package_ref, package_version, package_status, ownership, installed_at_ms
         FROM claw_package_refs${where}
        ORDER BY agent_id, package_kind, package_ref`,
    )
    .all(params) as PackageRefRow[];
  return rows.map(rowToPackageRef);
}

export function deleteClawPackageRef(
  ref: Pick<PersistedClawPackageRef, "agentId" | "kind" | "source" | "ref" | "version">,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    ensureClawPackageRefTable(db);
    db.prepare(
      `DELETE FROM claw_package_refs
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
    });
  }, options);
}

export function upsertClawPackageRef(
  ref: PersistedClawPackageRef,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    ensureClawPackageRefTable(db);
    db.prepare(
      `INSERT INTO claw_package_refs (
         agent_id, package_kind, package_source, package_ref, package_version,
         schema_version, claw_name, installed_at_ms
       ) VALUES (
         @agent_id, @package_kind, @package_source, @package_ref, @package_version,
         @schema_version, @claw_name, @installed_at_ms
       )
       ON CONFLICT(agent_id, package_kind, package_source, package_ref, package_version)
       DO UPDATE SET
         schema_version = excluded.schema_version,
         claw_name = excluded.claw_name,
         installed_at_ms = excluded.installed_at_ms`,
    ).run({
      agent_id: ref.agentId,
      package_kind: ref.kind,
      package_source: ref.source,
      package_ref: ref.ref,
      package_version: ref.version,
      schema_version: ref.schemaVersion,
      claw_name: ref.clawName,
      installed_at_ms: ref.installedAtMs,
    });
  }, options);
}
