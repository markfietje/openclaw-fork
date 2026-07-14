import path from "node:path";
import { applyPathPrepend } from "./path-prepend.js";

function resolveRuntimePathApi(value: string): typeof path.posix | typeof path.win32 | null {
  const pathApi =
    process.platform === "win32" || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\")
      ? path.win32
      : path.posix;
  return pathApi.isAbsolute(value) ? pathApi : null;
}

/** Pins package-manager lifecycle subprocesses to the Node runtime selected for activation. */
export function createPackageRuntimeEnv(
  env: NodeJS.ProcessEnv | undefined,
  nodePath: string | null,
): NodeJS.ProcessEnv | undefined {
  const trimmed = nodePath?.trim();
  if (!trimmed) {
    return env;
  }
  const pathApi = resolveRuntimePathApi(trimmed);
  if (!pathApi) {
    return env;
  }
  const result = Object.fromEntries(
    Object.entries(env ?? process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
  applyPathPrepend(result, [pathApi.dirname(trimmed)]);
  return result;
}

/** Resolves npm beside the selected Node so packing cannot fall back to a different shell Node. */
export function resolvePackageRuntimeNpmCommand(nodePath: string | null): string | null {
  const trimmed = nodePath?.trim();
  if (!trimmed) {
    return null;
  }
  const pathApi = resolveRuntimePathApi(trimmed);
  if (!pathApi) {
    return null;
  }
  return pathApi.join(pathApi.dirname(trimmed), pathApi === path.win32 ? "npm.cmd" : "npm");
}
