// Tests root Claw install ownership and the narrow agent/workspace mutation slice.
import { access, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawAddPlan, ClawAddMutationError } from "./add.js";
import { ClawCronInstallError } from "./cron.js";
import { buildClawAddPlan } from "./lifecycle.js";
import {
  persistClawInstallRecord,
  persistClawPackageRef,
  readClawInstallRecord,
  readClawPackageRefs,
  replaceClawPackageRefExpected,
  updateClawInstallRecord,
  updateClawPackageRefStatus,
} from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

async function makePlan(manifestValue: unknown = { schemaVersion: 1, agent: { id: "worker" } }) {
  const root = await mkdtemp(join(tmpdir(), "openclaw-claw-add-"));
  const parsed = parseClawManifest(manifestValue);
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: "@acme/worker",
    version: "1.0.0",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrityKind: "artifact",
    integrity: "sha256:manifest",
    byteLength: 123,
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace: join(root, "workspace-worker") },
  });
  return { root, plan };
}

function stateEnv(root: string) {
  return { OPENCLAW_STATE_DIR: join(root, "state") };
}

describe("Claw root install provenance", () => {
  it("persists package identity, agent ownership, workspace, and config digest", async () => {
    const { root, plan } = await makePlan();

    const record = persistClawInstallRecord(plan, { env: stateEnv(root), nowMs: 42 });

    expect(record).toMatchObject({
      schemaVersion: "openclaw.clawInstallRecord.v1",
      claw: { name: "@acme/worker", version: "1.0.0", integrity: "sha256:manifest" },
      manifestSchemaVersion: 1,
      planIntegrity: plan.planIntegrity,
      agentId: "worker",
      workspace: plan.agent.workspace,
      agentOwnedPaths: ['agents.list["worker"]'],
      status: "complete",
      addedAtMs: 42,
    });
    expect(record.agentConfigDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(readClawInstallRecord("worker", { env: stateEnv(root) })).toEqual(record);
  });

  it("does not overwrite an existing install record for the same agent", async () => {
    const { root, plan } = await makePlan();
    persistClawInstallRecord(plan, { env: stateEnv(root), nowMs: 1 });

    expect(() => persistClawInstallRecord(plan, { env: stateEnv(root), nowMs: 2 })).toThrow();
    expect(readClawInstallRecord("worker", { env: stateEnv(root) })?.addedAtMs).toBe(1);
  });

  it("advances package identity while preserving install creation time", async () => {
    const { root, plan } = await makePlan();
    const original = persistClawInstallRecord(plan, { env: stateEnv(root), nowMs: 1 });
    const target = {
      ...plan,
      claw: { ...plan.claw, version: "2.0.0", integrity: "sha256:target" },
      agent: {
        ...plan.agent,
        config: { ...plan.agent.config, name: "Worker v2" },
      },
    };

    const updated = updateClawInstallRecord(target, { env: stateEnv(root), nowMs: 2 });

    expect(updated).toMatchObject({
      claw: { version: "2.0.0", integrity: "sha256:target" },
      addedAtMs: 1,
      updatedAtMs: 2,
      status: "complete",
    });
    expect(updated.agentConfigDigest).not.toBe(original.agentConfigDigest);
    expect(readClawInstallRecord("worker", { env: stateEnv(root) })).toEqual(updated);
  });

  it("rejects an update when package provenance changed after planning", async () => {
    const { root, plan } = await makePlan();
    const original = persistClawInstallRecord(plan, { env: stateEnv(root), nowMs: 1 });
    const target = {
      ...plan,
      claw: { ...plan.claw, version: "2.0.0", integrity: "sha256:target" },
    };

    expect(() =>
      updateClawInstallRecord(target, {
        env: stateEnv(root),
        nowMs: 2,
        expectedClaw: { version: "0.9.0", integrity: "sha256:stale" },
      }),
    ).toThrow("changed");
    expect(readClawInstallRecord("worker", { env: stateEnv(root) })).toEqual(original);
  });

  it("records package references independently of shared package ownership", async () => {
    const { root, plan } = await makePlan();
    const pkg = {
      kind: "plugin" as const,
      source: "clawhub" as const,
      ref: "@acme/audit",
      version: "2.3.4",
    };

    const record = persistClawPackageRef(plan, pkg, { env: stateEnv(root), nowMs: 43 });

    expect(record).toMatchObject({
      schemaVersion: "openclaw.clawPackageRef.v1",
      agentId: "worker",
      clawName: "@acme/worker",
      ...pkg,
    });
    expect(
      readClawPackageRefs({
        env: stateEnv(root),
        kind: "plugin",
        source: "clawhub",
        ref: "@acme/audit",
        version: "2.3.4",
      }),
    ).toEqual([record]);
  });

  it("rejects a package claim when the persisted reference changed after planning", async () => {
    const { root, plan } = await makePlan();
    const options = { env: stateEnv(root) };
    const pkg = {
      kind: "plugin" as const,
      source: "clawhub" as const,
      ref: "@acme/audit",
      version: "2.3.4",
    };
    const planned = persistClawPackageRef(plan, pkg, { ...options, nowMs: 43 });
    const current = updateClawPackageRefStatus(planned, "pending", options);
    const claim = { ...planned, version: "3.0.0", status: "pending" as const };

    expect(() => replaceClawPackageRefExpected(planned, claim, options)).toThrow(
      "changed after planning",
    );
    expect(readClawPackageRefs(options)).toEqual([current]);
  });
});

describe("applyClawAddPlan", () => {
  it("appends one agent, preserves defaults and existing agents, and creates a new workspace", async () => {
    const { root, plan } = await makePlan({
      schemaVersion: 1,
      agent: {
        id: "worker",
        name: "Worker",
        identity: { name: "Work" },
        tools: { deny: ["exec"] },
      },
    });
    let config: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/operator/default" },
        list: [{ id: "main", default: true }],
      },
    };

    const result = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: stateEnv(root),
      nowMs: 10,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(result).toMatchObject({
      schemaVersion: "openclaw.clawAddResult.v1",
      stability: "experimental",
      status: "complete",
      workspaceCreated: true,
      configCommitted: true,
      installRecord: { agentId: "worker" },
    });
    expect(config.agents?.defaults).toEqual({ workspace: "/operator/default" });
    expect(config.agents?.list).toEqual([
      { id: "main", default: true },
      {
        id: "worker",
        name: "Worker",
        identity: { name: "Work" },
        tools: { deny: ["exec"] },
        workspace: plan.agent.workspace,
      },
    ]);
    await expect(access(plan.agent.workspace)).resolves.toBeUndefined();
  });

  it("rechecks agent collisions during the config commit and cleans the reserved workspace", async () => {
    const { plan } = await makePlan();

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        commitConfig: async (transform) => {
          transform({ agents: { list: [{ id: "worker" }] } });
        },
      }),
    ).resolves.toMatchObject({
      status: "partial",
      workspaceCreated: false,
      configCommitted: false,
      error: { code: "agent_id_collision" },
    });
    await expect(access(plan.agent.workspace)).rejects.toThrow();
  });

  it("records a partial add when the workspace appears after planning", async () => {
    const { root, plan } = await makePlan();
    await mkdir(plan.agent.workspace);

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env: stateEnv(root),
      }),
    ).resolves.toMatchObject({
      status: "partial",
      workspaceCreated: false,
      error: { code: "workspace_collision" },
    });
    expect(readClawInstallRecord("worker", { env: stateEnv(root) })?.status).toBe("partial");
  });

  it("blocks declared components that this lifecycle slice cannot yet create", async () => {
    const { plan } = await makePlan({
      schemaVersion: 1,
      agent: { id: "worker" },
      packages: [{ kind: "skill", source: "clawhub", ref: "demo", version: "1.0.0" }],
    });

    await expect(
      applyClawAddPlan(plan, { consentPlanIntegrity: plan.planIntegrity }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ClawAddMutationError>>({ code: "plan_blocked" }),
    );
    await expect(access(plan.agent.workspace)).rejects.toThrow();
  });

  it("fails before mutation when the pending provenance record cannot be persisted", async () => {
    const { plan } = await makePlan();
    let config: OpenClawConfig = {};

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        commitConfig: async (transform) => {
          config = transform(config);
        },
        persistRecord: () => {
          throw new Error("database unavailable");
        },
      }),
    ).rejects.toMatchObject({ code: "provenance_failed" });
    expect(config.agents?.list).toBeUndefined();
  });

  it("returns partial cron ownership when scheduler installation fails", async () => {
    const { root, plan } = await makePlan({
      schemaVersion: 1,
      agent: { id: "worker" },
      cronJobs: [
        {
          id: "daily-report",
          schedule: { cron: "0 9 * * *", timezone: "UTC" },
          session: "isolated",
          message: "Prepare report",
        },
      ],
    });
    const failedRef = {
      schemaVersion: "openclaw.clawCronRef.v1" as const,
      agentId: "worker",
      manifestId: "daily-report",
      declarationKey: "claw:worker:daily-report",
      status: "failed" as const,
      job: {
        id: "daily-report",
        schedule: { cron: "0 9 * * *", timezone: "UTC" },
        session: "isolated" as const,
        message: "Prepare report",
      },
      error: "gateway unavailable",
      createdAtMs: 1,
      updatedAtMs: 2,
    };

    const result = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: stateEnv(root),
      commitConfig: async (transform) => {
        transform({});
      },
      installCronJobs: async () => {
        throw new ClawCronInstallError("cron_install_failed", "gateway unavailable", [failedRef]);
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      cronJobs: [{ manifestId: "daily-report", status: "failed" }],
      installRecord: { status: "partial" },
      error: { code: "cron_install_failed", message: "gateway unavailable" },
    });
  });

  it("rejects mutation when consent does not bind the current plan", async () => {
    const { plan } = await makePlan();

    await expect(
      applyClawAddPlan(plan, { consentPlanIntegrity: "sha256:stale" }),
    ).rejects.toMatchObject({ code: "plan_integrity_mismatch" });
    await expect(access(plan.agent.workspace)).rejects.toThrow();
  });
});
