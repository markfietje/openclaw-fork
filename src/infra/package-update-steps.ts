// Runs package update move, inventory, and cleanup steps.
import path from "node:path";
import { readPackageVersion } from "./package-json.js";
import {
  createPackageRuntimeEnv,
  resolvePackageRuntimeNpmInvocation,
} from "./package-runtime-env.js";
import {
  resolvePackageRuntime,
  runPackedPackageRuntimeGuard,
  runPackageInstallLifecycle,
} from "./package-update-lifecycle.js";
import {
  cleanupStagedNpmInstall,
  prepareStagedNpmInstall,
  removePackageUpdatePathBestEffort,
  resolveNpmTargetFromInvocation,
  resolveNpmTargetFromKnownPackageRoot,
  resolveStagedNpmTargetLayout,
  swapStagedNpmInstall,
  type StagedNpmInstall,
  withNpmInvocation,
} from "./package-update-npm-stage.js";
import {
  preparePackedPackageInstallSpec,
  prepareRegistryPackageInstallSpec,
} from "./package-update-source.js";
import type { PackageUpdateStepResult, PackageUpdateStepRunner } from "./package-update-types.js";
import { trimLogTail } from "./restart-sentinel.js";
import {
  PACKAGE_POST_INSTALL_DOCTOR_ADVISORY,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  type PackageUpdateStepAdvisory,
  type UpdatePostInstallDoctorResult,
} from "./update-doctor-result.js";
export type { PackageUpdateStepAdvisory } from "./update-doctor-result.js";
import {
  collectInstalledGlobalPackageErrors,
  globalInstallArgs,
  globalInstallFallbackArgs,
  resolvePnpmGlobalDirFromGlobalRoot,
  resolveExpectedInstalledVersionFromSpec,
  resolveGlobalInstallTarget,
  type CommandRunner,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";

function isBlockingPackageUpdateStep(step: PackageUpdateStepResult): boolean {
  return step.exitCode !== 0 && step.advisory === undefined;
}

function isNormalProcessExit(step: {
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  termination?: "exit" | "timeout" | "no-output-timeout" | "signal";
}): boolean {
  return (
    step.termination !== "timeout" &&
    step.termination !== "no-output-timeout" &&
    step.termination !== "signal" &&
    step.killed !== true &&
    (step.signal === undefined || step.signal === null)
  );
}

export function markPackagePostInstallDoctorAdvisory<
  T extends {
    exitCode: number | null;
    stderrTail?: string | null;
    signal?: NodeJS.Signals | null;
    killed?: boolean;
    termination?: "exit" | "timeout" | "no-output-timeout" | "signal";
    advisory?: PackageUpdateStepAdvisory;
  },
>(
  step: T,
  result: UpdatePostInstallDoctorResult | null,
): T & {
  advisory?: PackageUpdateStepAdvisory;
} {
  if (
    step.exitCode !== UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE ||
    result?.status !== "advisory" ||
    !isNormalProcessExit(step)
  ) {
    return step;
  }
  const advisoryTail = [
    step.stderrTail,
    ...result.advisory.details,
    PACKAGE_POST_INSTALL_DOCTOR_ADVISORY.message,
  ]
    .filter((line): line is string => Boolean(line?.trim()))
    .join("\n");
  return {
    ...step,
    advisory: PACKAGE_POST_INSTALL_DOCTOR_ADVISORY,
    stderrTail: trimLogTail(advisoryTail) ?? step.stderrTail,
  };
}

async function readPackageVersionIfPresent(packageRoot: string | null): Promise<string | null> {
  if (!packageRoot) {
    return null;
  }
  try {
    return await readPackageVersion(packageRoot);
  } catch {
    return null;
  }
}

function createPackageManagerInstallEnv(
  target: ResolvedGlobalInstallTarget,
  env: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  if (target.manager !== "bun" || !target.globalRoot) {
    return env;
  }
  return {
    ...Object.fromEntries(
      Object.entries(env ?? process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    BUN_INSTALL_GLOBAL_DIR: path.dirname(target.globalRoot),
  };
}

/**
 * Runs the global package update flow, including npm staging when possible,
 * package verification, optional post-verification, and cleanup.
 */
export async function runGlobalPackageUpdateSteps(params: {
  installTarget: ResolvedGlobalInstallTarget;
  installSpec: string;
  packageName: string;
  packageRoot?: string | null;
  runCommand: CommandRunner;
  runStep: PackageUpdateStepRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  installCwd?: string;
  nodePath?: string;
  postVerifyStep?: (packageRoot: string) => Promise<PackageUpdateStepResult | null>;
}): Promise<{
  steps: PackageUpdateStepResult[];
  verifiedPackageRoot: string | null;
  afterVersion: string | null;
  failedStep: PackageUpdateStepResult | null;
}> {
  const installCwd = params.installCwd === undefined ? {} : { cwd: params.installCwd };
  const installEnv = params.env === undefined ? {} : { env: params.env };
  let stagedInstall: StagedNpmInstall | null | undefined;
  let packedInstallDir: string | null = null;

  try {
    const initialStagedLayout = resolveStagedNpmTargetLayout(params.installTarget);
    const knownPackageRoot =
      params.installTarget.packageRoot?.trim() || params.packageRoot?.trim() || null;
    const knownNpmTarget =
      params.installTarget.manager === "npm" && initialStagedLayout === null
        ? resolveNpmTargetFromKnownPackageRoot(
            params.installTarget,
            params.packageName,
            knownPackageRoot,
          )
        : null;
    const preflightInstallTarget = knownNpmTarget ?? params.installTarget;
    const stagedNpmLayout = resolveStagedNpmTargetLayout(preflightInstallTarget);
    const updateUsesNpm = preflightInstallTarget.manager === "npm" || stagedNpmLayout !== null;
    const selectedRuntime = await resolvePackageRuntime({
      runCommand: params.runCommand,
      timeoutMs: params.timeoutMs,
      ...(params.nodePath === undefined ? {} : { nodePath: params.nodePath }),
      ...installEnv,
      ...installCwd,
    });
    // npm must run under the selected Node. pnpm and Bun retain the caller PATH
    // so that managed Node directories cannot shadow their selected manager.
    const updateEnv = updateUsesNpm
      ? createPackageRuntimeEnv(params.env, selectedRuntime.nodePath)
      : params.env;
    let npmCommandArgv: string[] | null = null;
    if (updateUsesNpm) {
      npmCommandArgv = await resolvePackageRuntimeNpmInvocation({
        nodePath: selectedRuntime.nodePath,
        fallbackCommand:
          preflightInstallTarget.manager === "npm" ? preflightInstallTarget.command : "npm",
        ...(params.installCwd === undefined ? {} : { cwd: params.installCwd }),
        ...(updateEnv === undefined ? {} : { env: updateEnv }),
        allowAdjacentFallback: stagedNpmLayout !== null,
      });
      if (!npmCommandArgv) {
        const failedStep: PackageUpdateStepResult = {
          name: "global install npm preflight",
          command: "resolve npm for selected Node",
          cwd: params.installCwd ?? process.cwd(),
          durationMs: 0,
          exitCode: 1,
          stdoutTail: null,
          stderrTail: "could not resolve an npm CLI for the selected managed-service Node",
        };
        return {
          steps: [failedStep],
          verifiedPackageRoot: params.packageRoot ?? params.installTarget.packageRoot,
          afterVersion: await readPackageVersionIfPresent(
            params.packageRoot ?? params.installTarget.packageRoot,
          ),
          failedStep,
        };
      }
    }
    const hasKnownPackageRoot = knownPackageRoot !== null;
    const recoveredNpmTarget =
      params.installTarget.manager === "npm" &&
      stagedNpmLayout === null &&
      !hasKnownPackageRoot &&
      npmCommandArgv
        ? resolveNpmTargetFromInvocation(params.installTarget, params.packageName, npmCommandArgv)
        : null;
    const effectiveInstallTarget = recoveredNpmTarget ?? preflightInstallTarget;
    const preparedInstall = await prepareStagedNpmInstall(
      effectiveInstallTarget,
      params.packageName,
    );
    stagedInstall = preparedInstall.stagedInstall;
    if (preparedInstall.failedStep) {
      return {
        steps: [preparedInstall.failedStep],
        verifiedPackageRoot:
          effectiveInstallTarget.packageRoot ??
          params.packageRoot ??
          params.installTarget.packageRoot,
        afterVersion: await readPackageVersionIfPresent(
          params.packageRoot ?? params.installTarget.packageRoot,
        ),
        failedStep: preparedInstall.failedStep,
      };
    }

    const installCommandTarget = stagedInstall?.installTarget ?? effectiveInstallTarget;
    const packageManagerEnv = createPackageManagerInstallEnv(installCommandTarget, updateEnv);
    const steps: PackageUpdateStepResult[] = [];
    const registrySpec = await prepareRegistryPackageInstallSpec({
      installTarget: installCommandTarget,
      installSpec: params.installSpec,
      packageName: params.packageName,
      runStep: params.runStep,
      timeoutMs: params.timeoutMs,
      runtimeVersion: selectedRuntime.version,
      ...(packageManagerEnv === undefined ? {} : { env: packageManagerEnv }),
      ...(params.installCwd === undefined ? {} : { installCwd: params.installCwd }),
    });
    steps.push(...registrySpec.steps);
    if (registrySpec.failedStep) {
      return {
        steps,
        verifiedPackageRoot:
          effectiveInstallTarget.packageRoot ??
          params.packageRoot ??
          params.installTarget.packageRoot,
        afterVersion: await readPackageVersionIfPresent(
          params.packageRoot ?? params.installTarget.packageRoot,
        ),
        failedStep: registrySpec.failedStep,
      };
    }

    const preparedSpec = await preparePackedPackageInstallSpec({
      installTarget: installCommandTarget,
      installSpec: registrySpec.installSpec,
      packageName: params.packageName,
      runStep: params.runStep,
      timeoutMs: params.timeoutMs,
      runtimeVersion: selectedRuntime.version,
      env: packageManagerEnv,
      installCwd: params.installCwd,
      forcePack: recoveredNpmTarget !== null,
      packCommandArgv: npmCommandArgv,
    });
    const expectedInstalledVersion = resolveExpectedInstalledVersionFromSpec(
      params.packageName,
      registrySpec.installSpec,
    );
    packedInstallDir = preparedSpec.packDir;
    steps.push(...preparedSpec.steps);
    if (preparedSpec.failedStep) {
      return {
        steps,
        verifiedPackageRoot: params.packageRoot ?? null,
        afterVersion: null,
        failedStep: preparedSpec.failedStep,
      };
    }

    if (recoveredNpmTarget !== null) {
      const runtimeGuardStep = await runPackedPackageRuntimeGuard(
        preparedSpec.installSpec,
        selectedRuntime.version,
        "global install runtime guard",
        expectedInstalledVersion,
      );
      steps.push(runtimeGuardStep);
      if (runtimeGuardStep.exitCode !== 0) {
        return {
          steps,
          verifiedPackageRoot:
            effectiveInstallTarget.packageRoot ??
            params.packageRoot ??
            params.installTarget.packageRoot,
          afterVersion: await readPackageVersionIfPresent(
            params.packageRoot ?? params.installTarget.packageRoot,
          ),
          failedStep: runtimeGuardStep,
        };
      }
    }

    // Keep npm's global destination stable when the packed source is an aliased fork.
    // npm-package-arg owns file-path encoding; pre-encoding makes spaces resolve as literal %20.
    const activationInstallSpec =
      preparedSpec.packDir && installCommandTarget.manager === "npm"
        ? `${params.packageName}@file:${preparedSpec.installSpec}`
        : preparedSpec.installSpec;

    const installLocation =
      stagedInstall?.prefix ??
      (installCommandTarget.manager === "pnpm"
        ? resolvePnpmGlobalDirFromGlobalRoot(installCommandTarget.globalRoot)
        : null);
    const updateStep = await params.runStep({
      name: "global update",
      argv: withNpmInvocation(
        globalInstallArgs(
          installCommandTarget,
          activationInstallSpec,
          undefined,
          installLocation,
        ),
        installCommandTarget,
        npmCommandArgv,
      ),
      ...installCwd,
      ...(packageManagerEnv === undefined ? {} : { env: packageManagerEnv }),
      timeoutMs: params.timeoutMs,
    });

    steps.push(updateStep);
    let finalInstallStep = updateStep;
    if (updateStep.exitCode !== 0) {
      await cleanupStagedNpmInstall(stagedInstall);
      stagedInstall = null;
      const preparedFallbackInstall = await prepareStagedNpmInstall(
        effectiveInstallTarget,
        params.packageName,
      );
      stagedInstall = preparedFallbackInstall.stagedInstall;
      if (preparedFallbackInstall.failedStep) {
        steps.push(preparedFallbackInstall.failedStep);
        return {
          steps,
          verifiedPackageRoot: params.packageRoot ?? null,
          afterVersion: null,
          failedStep: preparedFallbackInstall.failedStep,
        };
      }

      const fallbackArgv = globalInstallFallbackArgs(
        stagedInstall?.installTarget ?? effectiveInstallTarget,
        activationInstallSpec,
        undefined,
        stagedInstall?.prefix,
      );
      if (fallbackArgv) {
        const fallbackStep = await params.runStep({
          name: "global update (omit optional)",
          argv: withNpmInvocation(
            fallbackArgv,
            stagedInstall?.installTarget ?? effectiveInstallTarget,
            npmCommandArgv,
          ),
          ...installCwd,
          ...(packageManagerEnv === undefined ? {} : { env: packageManagerEnv }),
          timeoutMs: params.timeoutMs,
        });
        steps.push(fallbackStep);
        finalInstallStep = fallbackStep;
      } else {
        await cleanupStagedNpmInstall(stagedInstall);
        stagedInstall = null;
      }
    }

    const livePackageRoot =
      effectiveInstallTarget.packageRoot ??
      params.packageRoot ??
      (
        await resolveGlobalInstallTarget({
          manager: params.installTarget,
          runCommand: params.runCommand,
          timeoutMs: params.timeoutMs,
        })
      ).packageRoot ??
      null;
    const manualLifecyclePackageRoot =
      stagedInstall?.packageRoot ?? livePackageRoot;
    // Package-manager hooks stay disabled. Validate and run only OpenClaw's
    // root lifecycle under the same Node that passed the candidate guard.
    if (finalInstallStep.exitCode === 0 && manualLifecyclePackageRoot) {
      const lifecycle = await runPackageInstallLifecycle({
        packageRoot: manualLifecyclePackageRoot,
        runStep: params.runStep,
        timeoutMs: params.timeoutMs,
        ...(packageManagerEnv === undefined ? {} : { env: packageManagerEnv }),
        runtimeVersion: selectedRuntime.version,
        ...(selectedRuntime.nodePath === null ? {} : { nodePath: selectedRuntime.nodePath }),
        allowMissingGuardForVersion: expectedInstalledVersion,
      });
      steps.push(...lifecycle.steps);
      finalInstallStep = lifecycle.failedStep ?? finalInstallStep;
    }

    const verificationPackageRoot = stagedInstall?.packageRoot ?? livePackageRoot;
    let verifiedPackageRoot = livePackageRoot ?? verificationPackageRoot;

    let afterVersion: string | null = null;
    if (stagedInstall && finalInstallStep.exitCode !== 0) {
      afterVersion = await readPackageVersionIfPresent(livePackageRoot);
    }
    if (finalInstallStep.exitCode === 0 && verificationPackageRoot) {
      const candidateVersion = await readPackageVersion(verificationPackageRoot);
      if (!stagedInstall) {
        afterVersion = candidateVersion;
      }
      const verificationErrors = await collectInstalledGlobalPackageErrors({
        packageRoot: verificationPackageRoot,
        expectedVersion: expectedInstalledVersion,
      });
      if (verificationErrors.length > 0) {
        steps.push({
          name: "global install verify",
          command: `verify ${verificationPackageRoot}`,
          cwd: verificationPackageRoot,
          durationMs: 0,
          exitCode: 1,
          stderrTail: verificationErrors.join("\n"),
          stdoutTail: null,
        });
      }

      if (stagedInstall && verificationErrors.length === 0) {
        const swapStep = await swapStagedNpmInstall({
          stage: stagedInstall,
          installTarget: effectiveInstallTarget,
          packageName: params.packageName,
        });
        steps.push(swapStep);
        if (swapStep.exitCode === 0) {
          verifiedPackageRoot = effectiveInstallTarget.packageRoot ?? verifiedPackageRoot;
          afterVersion = candidateVersion;
        }
      }

      const failedVerifyOrSwap = steps.find(
        (step) =>
          (step.name === "global install verify" || step.name === "global install swap") &&
          step.exitCode !== 0,
      );
      const postVerifyStep = failedVerifyOrSwap
        ? null
        : verifiedPackageRoot
          ? await params.postVerifyStep?.(verifiedPackageRoot)
          : null;
      if (postVerifyStep) {
        steps.push(postVerifyStep);
      }
      if (failedVerifyOrSwap && stagedInstall) {
        afterVersion = await readPackageVersionIfPresent(livePackageRoot);
      }
    }

    const failedStep = isBlockingPackageUpdateStep(finalInstallStep)
      ? finalInstallStep
      : (steps.find((step) => step !== updateStep && isBlockingPackageUpdateStep(step)) ?? null);

    return {
      steps,
      verifiedPackageRoot,
      afterVersion,
      failedStep,
    };
  } finally {
    await cleanupStagedNpmInstall(stagedInstall ?? null);
    if (packedInstallDir) {
      await removePackageUpdatePathBestEffort(packedInstallDir);
    }
  }
}
