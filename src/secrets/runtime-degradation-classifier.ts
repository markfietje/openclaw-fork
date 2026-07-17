import { getPath } from "./path-utils.js";
import {
  listSecretResolutionErrorOwners,
  SECRET_DEGRADATION_RETRY_HINT,
  type SecretDegradationStatus,
} from "./runtime-degraded-state.js";
import { getActiveSecretsRuntimeSnapshot } from "./runtime-state.js";

function pathSegments(path: string): string[] {
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
}

/** Returns every owner rolled back by one failed atomic reload attempt. */
export function classifySecretResolutionErrorDegradations(params: {
  error: unknown;
}): SecretDegradationStatus[] {
  const attempts = listSecretResolutionErrorOwners(params.error);
  const active = getActiveSecretsRuntimeSnapshot();
  const genericRuntimeDegradation = (): SecretDegradationStatus => ({
    kind: "unknown",
    id: "runtime",
    reason: "secret reload failed",
    state: active ? "stale" : "cold",
    retryHint: SECRET_DEGRADATION_RETRY_HINT,
    paths: [],
  });
  if (attempts.length === 0) {
    return [genericRuntimeDegradation()];
  }

  const activeColdOwners = new Set(
    (active?.degradedOwners ?? []).map((owner) => `${owner.ownerKind}\0${owner.ownerId}`),
  );
  const classified = attempts.map<SecretDegradationStatus>((owner) => {
    const hasActiveValue = owner.paths.some(
      (path) => active && getPath(active.config, pathSegments(path)) !== undefined,
    );
    return {
      kind: owner.ownerKind,
      id: owner.ownerId,
      reason: owner.reason,
      state:
        activeColdOwners.has(`${owner.ownerKind}\0${owner.ownerId}`) || !hasActiveValue
          ? "cold"
          : "stale",
      retryHint: SECRET_DEGRADATION_RETRY_HINT,
      paths: [...owner.paths],
    };
  });
  return attempts.some((owner) => owner.failureMatched)
    ? classified
    : [genericRuntimeDegradation(), ...classified];
}
