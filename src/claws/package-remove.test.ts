import { describe, expect, it, vi } from "vitest";
import { applyClawPackageRemovals, planClawPackageRemovals } from "./package-remove.js";
import type { PersistedClawInstall, PersistedClawPackageRef } from "./provenance.js";

const install = {
  workspace: "/tmp/claw-workspace",
} as PersistedClawInstall;

function packageRef(overrides: Partial<PersistedClawPackageRef> = {}): PersistedClawPackageRef {
  return {
    schemaVersion: "openclaw.clawPackageRef.v1",
    agentId: "worker",
    clawName: "@acme/worker",
    kind: "plugin",
    source: "clawhub",
    ref: "audit",
    version: "1.0.0",
    status: "complete",
    ownership: "claw-installed",
    installedAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

describe("Claw package removal", () => {
  it("uninstalls a sole unchanged Claw-installed plugin through the shared lifecycle", async () => {
    const ref = packageRef();
    const uninstallPlugin = vi.fn().mockResolvedValue(undefined);
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref]),
        resolvePlugin: vi.fn().mockResolvedValue({
          status: "found",
          pluginId: "audit-runtime",
          record: { source: "clawhub" },
          installedVersion: "1.0.0",
        }),
      },
    });

    expect(decisions).toMatchObject([{ action: "uninstall", pluginId: "audit-runtime" }]);
    await expect(
      applyClawPackageRemovals(decisions, {
        deps: {
          readPackageRefs: vi.fn().mockReturnValue([ref]),
          uninstallPlugin,
          resolvePlugin: vi.fn().mockResolvedValue({
            status: "found",
            pluginId: "audit-runtime",
            record: { source: "clawhub" },
            installedVersion: "1.0.0",
          }),
        },
      }),
    ).resolves.toEqual([{ kind: "plugin", ref: "audit", version: "1.0.0", action: "uninstalled" }]);
    expect(uninstallPlugin).toHaveBeenCalledWith(
      "audit-runtime",
      { force: true, invalidateRuntimeCache: false },
      expect.any(Object),
    );
  });

  it.each([
    ["independently-owned", packageRef({ ownership: "independently-owned" })],
    ["pending", packageRef({ status: "pending" })],
    ["shared", packageRef()],
  ])("retains %s artifacts while releasing the Claw reference", async (scenario, ref) => {
    const other = packageRef({ agentId: "other" });
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue(scenario === "shared" ? [ref, other] : [ref]),
        resolvePlugin: vi.fn(),
      },
    });
    expect(decisions).toMatchObject([{ action: "retain", reason: expect.any(String) }]);
  });

  it("retains a plugin whose installed version drifted", async () => {
    const ref = packageRef();
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref]),
        resolvePlugin: vi.fn().mockResolvedValue({
          status: "found",
          pluginId: "audit",
          record: { source: "clawhub" },
          installedVersion: "2.0.0",
        }),
      },
    });
    expect(decisions).toMatchObject([
      { action: "retain", reason: "Installed plugin version changed after the Claw was added." },
    ]);
  });

  it("retains a plugin reinstalled directly after Claw provenance", async () => {
    const ref = packageRef({ updatedAtMs: 10 });
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref]),
        resolvePlugin: vi.fn().mockResolvedValue({
          status: "found",
          pluginId: "audit",
          record: { source: "clawhub", installedAt: new Date(20).toISOString() },
          installedVersion: "1.0.0",
        }),
      },
    });

    expect(decisions).toMatchObject([
      { action: "retain", reason: "Package is independently owned outside this Claw." },
    ]);
  });

  it("treats equal skill refs in separate agent workspaces as separate artifacts", async () => {
    const ref = packageRef({ kind: "skill", ref: "triage" });
    const other = packageRef({ kind: "skill", ref: "triage", agentId: "other" });
    const skillPlan = {
      workspaceDir: install.workspace,
      slug: "triage",
      version: "1.0.0",
      installedAt: 1,
      targetDir: "/tmp/claw-workspace/skills/triage",
      skillFilePath: "SKILL.md",
      skillFileSha256: "abc",
    };
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref, other]),
        planSkill: vi.fn().mockResolvedValue({ ok: true, plan: skillPlan }),
      },
    });
    expect(decisions).toMatchObject([{ action: "uninstall", skillPlan }]);
  });

  it("reports shared lifecycle failures as partial cleanup evidence", async () => {
    const ref = packageRef();
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref]),
        resolvePlugin: vi.fn().mockResolvedValue({
          status: "found",
          pluginId: "audit",
          record: { source: "clawhub" },
          installedVersion: "1.0.0",
        }),
      },
    });
    await expect(
      applyClawPackageRemovals(decisions, {
        deps: {
          readPackageRefs: vi.fn().mockReturnValue([ref]),
          resolvePlugin: vi.fn().mockResolvedValue({
            status: "found",
            pluginId: "audit",
            record: { source: "clawhub" },
            installedVersion: "1.0.0",
          }),
          uninstallPlugin: vi.fn().mockRejectedValue(new Error("busy")),
        },
      }),
    ).resolves.toEqual([
      { kind: "plugin", ref: "audit", version: "1.0.0", action: "error", reason: "busy" },
    ]);
  });

  it("rejects uninstall when direct adoption appears after planning", async () => {
    const ref = packageRef();
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref]),
        resolvePlugin: vi.fn().mockResolvedValue({
          status: "found",
          pluginId: "audit",
          record: { source: "clawhub" },
          installedVersion: "1.0.0",
        }),
      },
    });
    const adopted = packageRef({ ownership: "independently-owned" });

    await expect(
      applyClawPackageRemovals(decisions, {
        deps: {
          readPackageRefs: vi.fn().mockReturnValue([adopted]),
          uninstallPlugin: vi.fn(),
        },
      }),
    ).resolves.toMatchObject([
      { action: "error", reason: expect.stringContaining("ownership changed") },
    ]);
  });
});
