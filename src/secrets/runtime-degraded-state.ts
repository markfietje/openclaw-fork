/** Process-local registry for SecretRef owners isolated during cold startup. */

export type SecretOwnerKind =
  | "account"
  | "capability"
  | "gateway"
  | "provider"
  | "route"
  | "unknown";

export type SecretAssignmentDisposition = "fail-closed" | "isolate";

export type DegradedSecretOwner = {
  ownerKind: Exclude<SecretOwnerKind, "unknown">;
  ownerId: string;
  state: "unavailable";
  paths: string[];
  refKeys: string[];
  reason: string;
};

/** One owner from an atomic resolution attempt, including whether it caused the failure. */
type SecretResolutionErrorOwner = DegradedSecretOwner & {
  failureMatched: boolean;
};

export const SECRET_DEGRADATION_RETRY_HINT = "openclaw secrets reload" as const;

/** Secret degradation projected for operator status without exposing ref identifiers. */
export type SecretDegradationStatus = {
  kind: SecretOwnerKind;
  id: string;
  reason: string;
  state: "cold" | "stale";
  retryHint: typeof SECRET_DEGRADATION_RETRY_HINT;
  paths: string[];
};

const SECRET_SURFACE_UNAVAILABLE_ERROR_CODE = "SECRET_SURFACE_UNAVAILABLE";

/** Runtime error returned when a request targets an isolated SecretRef owner. */
export class SecretSurfaceUnavailableError extends Error {
  readonly code = SECRET_SURFACE_UNAVAILABLE_ERROR_CODE;
  readonly ownerKind: DegradedSecretOwner["ownerKind"];
  readonly ownerId: string;
  readonly paths: string[];

  constructor(owner: DegradedSecretOwner) {
    super(
      `Secret owner ${owner.ownerKind}:${owner.ownerId} is configured but unavailable (${owner.reason}).`,
    );
    this.name = "SecretSurfaceUnavailableError";
    this.ownerKind = owner.ownerKind;
    this.ownerId = owner.ownerId;
    this.paths = [...owner.paths];
  }
}

let activeDegradedOwners: DegradedSecretOwner[] = [];
let activeReloadDegradations: SecretDegradationStatus[] = [];
const resolutionErrorOwners = new WeakMap<object, SecretResolutionErrorOwner[]>();

function cloneOwner(owner: DegradedSecretOwner): DegradedSecretOwner {
  return {
    ...owner,
    paths: [...owner.paths],
    refKeys: [...owner.refKeys],
  };
}

function cloneResolutionErrorOwner(owner: SecretResolutionErrorOwner): SecretResolutionErrorOwner {
  return { ...cloneOwner(owner), failureMatched: owner.failureMatched };
}

/** Publishes the degraded-owner snapshot at the same edge as runtime config activation. */
export function setActiveDegradedSecretOwners(owners: readonly DegradedSecretOwner[]): void {
  activeDegradedOwners = owners.map(cloneOwner);
  // Any successful activation replaces the last-known-good outage with the
  // new snapshot, while its own unresolved owners remain cold below.
  activeReloadDegradations = [];
}

/** Returns the active degraded-owner snapshot without exposing mutable registry state. */
export function listActiveDegradedSecretOwners(): DegradedSecretOwner[] {
  return activeDegradedOwners.map(cloneOwner);
}

/** Associates a strict activation failure with the owners it prevented from refreshing. */
export function associateSecretResolutionErrorOwners(
  error: unknown,
  owners: readonly SecretResolutionErrorOwner[],
): void {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return;
  }
  resolutionErrorOwners.set(error, owners.map(cloneResolutionErrorOwner));
}

/** Returns owner metadata recorded for a strict activation failure. */
export function listSecretResolutionErrorOwners(error: unknown): SecretResolutionErrorOwner[] {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return [];
  }
  return (resolutionErrorOwners.get(error) ?? []).map(cloneResolutionErrorOwner);
}

/** Publishes owner states derived from one failed atomic runtime reload. */
export function setActiveReloadSecretDegradations(
  degradations: readonly SecretDegradationStatus[],
): void {
  activeReloadDegradations = degradations.map(cloneSecretDegradation);
}

function cloneSecretDegradation(entry: SecretDegradationStatus): SecretDegradationStatus {
  return {
    kind: entry.kind,
    id: entry.id,
    reason: entry.reason,
    state: entry.state,
    retryHint: entry.retryHint,
    paths: [...entry.paths],
  };
}

/** Lists active cold owners plus non-overlapping degradation from the last failed reload. */
export function listActiveSecretDegradations(): SecretDegradationStatus[] {
  const cold = activeDegradedOwners.map((owner) => ({
    kind: owner.ownerKind,
    id: owner.ownerId,
    reason: owner.reason,
    state: "cold" as const,
    retryHint: SECRET_DEGRADATION_RETRY_HINT,
    paths: [...owner.paths],
  }));
  const coldKeys = new Set(cold.map((owner) => `${owner.kind}\0${owner.id}`));
  return [
    ...cold,
    ...activeReloadDegradations
      .filter((owner) => !coldKeys.has(`${owner.kind}\0${owner.id}`))
      .map(cloneSecretDegradation),
  ];
}

/** Returns one active degraded owner, if present. */
export function findActiveDegradedSecretOwner(
  ownerKind: DegradedSecretOwner["ownerKind"],
  ownerId: string,
): DegradedSecretOwner | undefined {
  const owner = activeDegradedOwners.find(
    (entry) => entry.ownerKind === ownerKind && entry.ownerId === ownerId,
  );
  return owner ? cloneOwner(owner) : undefined;
}

/** Throws the canonical typed error when an owner was isolated at startup. */
export function assertSecretOwnerAvailable(
  ownerKind: DegradedSecretOwner["ownerKind"],
  ownerId: string,
): void {
  const owner = findActiveDegradedSecretOwner(ownerKind, ownerId);
  if (owner) {
    throw new SecretSurfaceUnavailableError(owner);
  }
}
