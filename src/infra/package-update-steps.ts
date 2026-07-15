// Runs package update move, inventory, and cleanup steps.
import { readPackageBinNames, readPackageVersion } from "./package-json.js";
import {
  createPackageRuntimeEnv,
  resolvePackageRuntimeNpmInvocation,
} from "./package-runtime-env.js";
import {
  resolvePackageRuntime,
  readPackedPackageBinNames,
  runPackedPackageRuntimeGuard,
  runPackageInstallLifecycle,
} from "./package-update-lifecycle.js";
import * as liveActivation from "./package-update-live-activation.js";
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

function createNpmPreflightFailure(cwd: string | undefined): PackageUpdateStepResult {
  return {
    name: "global install npm preflight",
    command: "resolve npm for selected Node",
    cwd: cwd ?? process.cwd(),
    durationMs: 0,
    exitCode: 1,
    stdoutTail: null,
    stderrTail: "could not resolve an npm CLI for the selected managed-service Node",
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
  let liveRollback: liveActivation.LivePackageRollback | null = null;

  try {
    const originalPackageRoot = params.packageRoot ?? params.installTarget.packageRoot;
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
    const nonNpmManager = !updateUsesNpm;
    const selectedRuntime = await resolvePackageRuntime({
      runCommand: params.runCommand,
      timeoutMs: params.timeoutMs,
      ...(params.nodePath === undefined ? {} : { nodePath: params.nodePath }),
      ...installEnv,
      ...installCwd,
    });
    const packageRuntimeEnv = createPackageRuntimeEnv(params.env, selectedRuntime.nodePath);
    let npmCommandArgv: string[] | null = null;
    if (updateUsesNpm) {
      npmCommandArgv = await resolvePackageRuntimeNpmInvocation({
        nodePath: selectedRuntime.nodePath,
        fallbackCommand:
          preflightInstallTarget.manager === "npm" ? preflightInstallTarget.command : "npm",
        ...(params.installCwd === undefined ? {} : { cwd: params.installCwd }),
        ...(packageRuntimeEnv === undefined ? {} : { env: packageRuntimeEnv }),
        allowAdjacentFallback: stagedNpmLayout !== null || nonNpmManager,
      });
      if (!npmCommandArgv) {
        const failedStep = createNpmPreflightFailure(params.installCwd);
        return {
          steps: [failedStep],
          verifiedPackageRoot: originalPackageRoot,
          afterVersion: await readPackageVersionIfPresent(originalPackageRoot),
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
    const steps: PackageUpdateStepResult[] = [];
    const registryManagerEnv = liveActivation.createPackageManagerInstallEnv(
      effectiveInstallTarget,
      packageRuntimeEnv,
    );
    const registrySpec = await prepareRegistryPackageInstallSpec({
      installTarget: effectiveInstallTarget,
      installSpec: params.installSpec,
      packageName: params.packageName,
      runStep: params.runStep,
      timeoutMs: params.timeoutMs,
      runtimeVersion: selectedRuntime.version,
      ...(registryManagerEnv === undefined ? {} : { env: registryManagerEnv }),
      ...(params.installCwd === undefined ? {} : { installCwd: params.installCwd }),
    });
    steps.push(...registrySpec.steps);
    if (registrySpec.failedStep) {
      return {
        steps,
        verifiedPackageRoot: effectiveInstallTarget.packageRoot ?? originalPackageRoot,
        afterVersion: await readPackageVersionIfPresent(originalPackageRoot),
        failedStep: registrySpec.failedStep,
      };
    }
    if (registrySpec.packedArtifact === null && npmCommandArgv === null) {
      npmCommandArgv = await resolvePackageRuntimeNpmInvocation({
        nodePath: selectedRuntime.nodePath,
        fallbackCommand: "npm",
        ...(params.installCwd === undefined ? {} : { cwd: params.installCwd }),
        ...(packageRuntimeEnv === undefined ? {} : { env: packageRuntimeEnv }),
        allowAdjacentFallback: true,
      });
      if (!npmCommandArgv) {
        const failedStep = createNpmPreflightFailure(params.installCwd);
        return {
          steps: [...steps, failedStep],
          verifiedPackageRoot: effectiveInstallTarget.packageRoot ?? originalPackageRoot,
          afterVersion: await readPackageVersionIfPresent(originalPackageRoot),
          failedStep,
        };
      }
    }
    packedInstallDir = registrySpec.packedArtifact?.cleanupDir ?? null;

    const preparedInstall = await prepareStagedNpmInstall(
      effectiveInstallTarget,
      params.packageName,
    );
    stagedInstall = preparedInstall.stagedInstall;
    if (preparedInstall.failedStep) {
      return {
        steps: [...steps, preparedInstall.failedStep],
        verifiedPackageRoot: effectiveInstallTarget.packageRoot ?? originalPackageRoot,
        afterVersion: await readPackageVersionIfPresent(originalPackageRoot),
        failedStep: preparedInstall.failedStep,
      };
    }

    const installCommandTarget = stagedInstall?.installTarget ?? effectiveInstallTarget;
    // Manager shims and lifecycle children must use the Node that passed the candidate guard.
    const packageManagerEnv = liveActivation.createPackageManagerInstallEnv(
      installCommandTarget,
      packageRuntimeEnv,
    );
    const preparedSpec = registrySpec.packedArtifact
      ? {
          installSpec: registrySpec.packedArtifact.tarballPath,
          packDir: registrySpec.packedArtifact.cleanupDir,
          steps: [],
          failedStep: null,
        }
      : await preparePackedPackageInstallSpec({
          installTarget: installCommandTarget,
          installSpec: registrySpec.installSpec,
          packageName: params.packageName,
          runStep: params.runStep,
          timeoutMs: params.timeoutMs,
          runtimeVersion: selectedRuntime.version,
          env: packageRuntimeEnv,
          installCwd: params.installCwd,
          forcePack: recoveredNpmTarget !== null || nonNpmManager,
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

    const guardPackedSpec =
      preparedSpec.packDir !== null &&
      (registrySpec.packedArtifact !== null || nonNpmManager || recoveredNpmTarget !== null);
    if (guardPackedSpec) {
      const runtimeGuardStep = await runPackedPackageRuntimeGuard(
        preparedSpec.installSpec,
        selectedRuntime.version,
        registrySpec.packedArtifact !== null || nonNpmManager
          ? "global update pack runtime guard"
          : "global install runtime guard",
        expectedInstalledVersion,
      );
      steps.push(runtimeGuardStep);
      if (runtimeGuardStep.exitCode !== 0) {
        return {
          steps,
          verifiedPackageRoot: effectiveInstallTarget.packageRoot ?? originalPackageRoot,
          afterVersion: await readPackageVersionIfPresent(originalPackageRoot),
          failedStep: runtimeGuardStep,
        };
      }
    }

    // Keep the canonical package root when a packed source is an aliased fork.
    // Manager parsers own file-path encoding; pre-encoding makes spaces literal %20.
    const activationInstallSpec = preparedSpec.packDir
      ? `${params.packageName}@file:${preparedSpec.installSpec}`
      : preparedSpec.installSpec;

    if (nonNpmManager) {
      const currentBinNames = originalPackageRoot
        ? await readPackageBinNames(originalPackageRoot)
        : [];
      const candidateBinNames = await readPackedPackageBinNames(preparedSpec.installSpec);
      const preparedRollback = await liveActivation.prepareLivePackageRollback({
        installTarget: effectiveInstallTarget,
        binNames: [...new Set([...currentBinNames, ...candidateBinNames])],
        runCommand: params.runCommand,
        timeoutMs: params.timeoutMs,
        ...(packageManagerEnv === undefined ? {} : { env: packageManagerEnv }),
        ...(params.installCwd === undefined ? {} : { cwd: params.installCwd }),
      });
      if (preparedRollback.failedStep) {
        steps.push(preparedRollback.failedStep);
        return {
          steps,
          verifiedPackageRoot: originalPackageRoot,
          afterVersion: await readPackageVersionIfPresent(originalPackageRoot),
          failedStep: preparedRollback.failedStep,
        };
      }
      liveRollback = preparedRollback.rollback;
    }

    const installLocation =
      stagedInstall?.prefix ??
      (installCommandTarget.manager === "pnpm"
        ? resolvePnpmGlobalDirFromGlobalRoot(installCommandTarget.globalRoot)
        : null);
    const updateStep = await params.runStep({
      name: "global update",
      argv: withNpmInvocation(
        globalInstallArgs(installCommandTarget, activationInstallSpec, undefined, installLocation),
        installCommandTarget,
        npmCommandArgv,
      ),
      ...installCwd,
      ...(packageManagerEnv === undefined ? {} : { env: packageManagerEnv }),
      timeoutMs: params.timeoutMs,
    });

    steps.push(updateStep);
    let finalInstallStep = updateStep;
    if (updateStep.exitCode !== 0 && stagedInstall) {
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
    const manualLifecyclePackageRoot = stagedInstall?.packageRoot ?? livePackageRoot;
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

    let failedStep = isBlockingPackageUpdateStep(finalInstallStep)
      ? finalInstallStep
      : (steps.find((step) => step !== updateStep && isBlockingPackageUpdateStep(step)) ?? null);

    const finalizedRollback = await liveActivation.finalizeLivePackageRollback(
      liveRollback,
      failedStep,
    );
    failedStep = finalizedRollback.failedStep;
    if (finalizedRollback.rollbackStep) {
      steps.push(finalizedRollback.rollbackStep);
      verifiedPackageRoot = livePackageRoot ?? verifiedPackageRoot;
      afterVersion = await readPackageVersionIfPresent(livePackageRoot);
    }

    return {
      steps,
      verifiedPackageRoot,
      afterVersion,
      failedStep,
    };
  } catch (error) {
    await liveActivation.throwAfterLivePackageRollback(liveRollback, error);
  } finally {
    await cleanupStagedNpmInstall(stagedInstall ?? null);
    if (packedInstallDir) {
      await removePackageUpdatePathBestEffort(packedInstallDir);
    }
  }
}
