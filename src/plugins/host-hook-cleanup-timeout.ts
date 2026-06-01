/** Maximum time allowed for plugin host cleanup hooks before the host continues cleanup. */
export const PLUGIN_HOST_CLEANUP_TIMEOUT_MS = 5_000;

/** Error raised when one plugin host cleanup hook exceeds the cleanup timeout. */
export class PluginHostCleanupTimeoutError extends Error {
  constructor(hookId: string) {
    super(`plugin host cleanup timed out: ${hookId}`);
    this.name = "PluginHostCleanupTimeoutError";
  }
}

/** Runs plugin host cleanup with a bounded timeout that does not keep the process alive. */
export async function withPluginHostCleanupTimeout<T>(
  hookId: string,
  cleanup: () => T | Promise<T>,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(cleanup),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new PluginHostCleanupTimeoutError(hookId));
        }, PLUGIN_HOST_CLEANUP_TIMEOUT_MS);
        // Cleanup should be bounded, but a pending timeout must not keep CLI/gateway exit alive.
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
