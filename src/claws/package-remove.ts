import { runPluginUninstallCommand } from "../cli/plugins-uninstall-command.js";
import { resolveInstalledClawHubPlugin } from "../plugins/plugin-install-preflight.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  applyClawHubSkillUninstall,
  planClawHubSkillUninstall,
  type ClawHubSkillUninstallPlan,
} from "../skills/lifecycle/clawhub-uninstall.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  readClawPackageRefs,
  type PersistedClawInstall,
  type PersistedClawPackageRef,
} from "./provenance.js";

export type ClawPackageRemovalDecision = {
  packageRef: PersistedClawPackageRef;
  action: "uninstall" | "retain";
  reason?: string;
  pluginId?: string;
  skillPlan?: ClawHubSkillUninstallPlan;
};

export type ClawPackageRemovalResult = {
  kind: PersistedClawPackageRef["kind"];
  ref: string;
  version: string;
  action: "uninstalled" | "retained" | "error";
  reason?: string;
};

export type PackageRemovalDeps = {
  readPackageRefs?: typeof readClawPackageRefs;
  resolvePlugin?: typeof resolveInstalledClawHubPlugin;
  planSkill?: typeof planClawHubSkillUninstall;
  uninstallPlugin?: typeof runPluginUninstallCommand;
  uninstallSkill?: typeof applyClawHubSkillUninstall;
};

function sameArtifact(left: PersistedClawPackageRef, right: PersistedClawPackageRef): boolean {
  return left.kind === right.kind && left.source === right.source && left.ref === right.ref;
}

export async function planClawPackageRemovals(
  install: PersistedClawInstall,
  packages: PersistedClawPackageRef[],
  options: OpenClawStateDatabaseOptions & { deps?: PackageRemovalDeps } = {},
): Promise<ClawPackageRemovalDecision[]> {
  const deps = options.deps ?? {};
  const allRefs = (deps.readPackageRefs ?? readClawPackageRefs)(options);
  const decisions: ClawPackageRemovalDecision[] = [];
  for (const packageRef of packages) {
    const retain = (reason: string): void => {
      decisions.push({ packageRef, action: "retain", reason });
    };
    if (packageRef.status !== "complete") {
      retain("Package installation is incomplete.");
      continue;
    }
    if (packageRef.ownership !== "claw-installed") {
      retain("Package existed before this Claw was added.");
      continue;
    }
    if (
      packageRef.kind === "plugin" &&
      allRefs.some(
        (candidate) =>
          candidate.agentId !== packageRef.agentId && sameArtifact(candidate, packageRef),
      )
    ) {
      retain("Another Claw still references this package.");
      continue;
    }
    if (packageRef.kind === "plugin") {
      const resolution = await (deps.resolvePlugin ?? resolveInstalledClawHubPlugin)({
        clawhubPackage: packageRef.ref,
      });
      if (resolution.status !== "found") {
        retain(
          resolution.status === "ambiguous"
            ? "Installed plugin identity is ambiguous."
            : "Installed plugin is missing.",
        );
        continue;
      }
      if (resolution.installedVersion !== packageRef.version) {
        retain("Installed plugin version changed after the Claw was added.");
        continue;
      }
      decisions.push({
        packageRef,
        action: "uninstall",
        pluginId: resolution.pluginId,
      });
      continue;
    }
    const skill = await (deps.planSkill ?? planClawHubSkillUninstall)({
      workspaceDir: install.workspace,
      slug: packageRef.ref,
      expectedVersion: packageRef.version,
    });
    if (!skill.ok) {
      retain(skill.error);
      continue;
    }
    decisions.push({ packageRef, action: "uninstall", skillPlan: skill.plan });
  }
  return decisions;
}

export async function applyClawPackageRemovals(
  decisions: ClawPackageRemovalDecision[],
  options: { deps?: PackageRemovalDeps } = {},
): Promise<ClawPackageRemovalResult[]> {
  const deps = options.deps ?? {};
  const results: ClawPackageRemovalResult[] = [];
  for (const decision of decisions) {
    const base = {
      kind: decision.packageRef.kind,
      ref: decision.packageRef.ref,
      version: decision.packageRef.version,
    };
    if (decision.action === "retain") {
      results.push({ ...base, action: "retained", reason: decision.reason });
      continue;
    }
    try {
      if (decision.packageRef.kind === "skill") {
        if (!decision.skillPlan) {
          throw new Error("Skill uninstall plan is missing.");
        }
        const removed = await (deps.uninstallSkill ?? applyClawHubSkillUninstall)(
          decision.skillPlan,
        );
        if (!removed.ok) {
          throw new Error(removed.error);
        }
      } else {
        const resolution = await (deps.resolvePlugin ?? resolveInstalledClawHubPlugin)({
          clawhubPackage: decision.packageRef.ref,
        });
        if (
          resolution.status !== "found" ||
          resolution.pluginId !== decision.pluginId ||
          resolution.installedVersion !== decision.packageRef.version
        ) {
          throw new Error(
            `Plugin ${decision.packageRef.ref}@${decision.packageRef.version} changed after removal planning.`,
          );
        }
        const runtime: RuntimeEnv = {
          log: () => undefined,
          error: () => undefined,
          exit: (code) => {
            throw new Error(`Plugin uninstall exited with code ${code}.`);
          },
        };
        await (deps.uninstallPlugin ?? runPluginUninstallCommand)(
          decision.pluginId ?? `clawhub:${decision.packageRef.ref}`,
          { force: true, invalidateRuntimeCache: false },
          runtime,
        );
      }
      results.push({ ...base, action: "uninstalled" });
    } catch (error) {
      results.push({
        ...base,
        action: "error",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
