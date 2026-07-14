export type PackageCliNodeRuntime = {
  version: string | null;
  bunVersion: string | null;
  execPath: string | null;
};
export const packagePreinstallRuntime: {
  completePackageInstallGuard: (
    options?: {
      markerUrl?: URL;
      remove?: (path: URL, options: { force: boolean }) => void;
    },
    reportError?: (...data: unknown[]) => void,
  ) => boolean;
  createPackageManagerWarningMessage: (packageManager: unknown) => string | null;
  detectLifecyclePackageManager: (env?: NodeJS.ProcessEnv) => string | null;
  enforceSupportedNodeRuntime: (
    options?: {
      engine?: string | null;
      probeNodeRuntime?: () => PackageCliNodeRuntime | null;
    },
    reportError?: (...data: unknown[]) => void,
  ) => boolean;
  nodeVersionSatisfiesPackageEngine: (version: string | null, engine: string | null) => boolean;
  PACKAGE_INSTALL_GUARD_RELATIVE_PATH: string;
  probePackageCliNodeRuntime: (options?: {
    pathEnv?: string;
    platform?: NodeJS.Platform;
    cwd?: string;
    run?: (
      command: string,
      args: string[],
      options: {
        cwd: string;
        encoding: "utf8";
        env: NodeJS.ProcessEnv;
        timeout: number;
        windowsHide: boolean;
      },
    ) => {
      status?: number | null;
      stdout?: string;
      error?: NodeJS.ErrnoException;
    };
  }) => PackageCliNodeRuntime | null;
  readPackageNodeEngine: (packageJsonUrl?: URL) => string | null;
  warnIfNonPnpmLifecycle: (env?: NodeJS.ProcessEnv, warn?: (...data: unknown[]) => void) => boolean;
};
