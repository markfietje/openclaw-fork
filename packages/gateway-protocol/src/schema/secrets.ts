// Gateway Protocol schema module defines protocol validation shapes.
import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/**
 * Secret-provider protocol schemas.
 *
 * These payloads request secret materialization from the gateway while keeping
 * caller scope, allowed paths, and provider overrides explicit.
 */
/** Empty request payload for reloading configured secret providers. */
export const SecretsReloadParamsSchema = closedObject({});

/** Runtime owner families reported by SecretRef degradation status. */
export const SecretsDegradedOwnerKindSchema = Type.Union([
  Type.Literal("account"),
  Type.Literal("capability"),
  Type.Literal("gateway"),
  Type.Literal("provider"),
  Type.Literal("route"),
  Type.Literal("unknown"),
]);

/** Availability of the active value for a degraded SecretRef owner. */
export const SecretsDegradationStateSchema = Type.Union([
  Type.Literal("cold"),
  Type.Literal("stale"),
]);

/** Operator-visible lifecycle state for one SecretRef owner. */
export const SecretsDegradedOwnerSchema = closedObject({
  kind: SecretsDegradedOwnerKindSchema,
  id: NonEmptyString,
  reason: NonEmptyString,
  state: SecretsDegradationStateSchema,
  retryHint: Type.Literal("openclaw secrets reload"),
  paths: Type.Array(NonEmptyString),
});

/** Secret-runtime section embedded in operator status responses. */
export const SecretsStatusSchema = closedObject({
  degraded: Type.Array(SecretsDegradedOwnerSchema),
});

export type SecretsDegradedOwner = Static<typeof SecretsDegradedOwnerSchema>;
export type SecretsStatus = Static<typeof SecretsStatusSchema>;

/** Request payload for resolving the secrets needed by one command invocation. */
export const SecretsResolveParamsSchema = closedObject({
  commandName: NonEmptyString,
  targetIds: Type.Array(NonEmptyString),
  allowedPaths: Type.Optional(Type.Array(NonEmptyString)),
  forcedActivePaths: Type.Optional(Type.Array(NonEmptyString)),
  optionalActivePaths: Type.Optional(Type.Array(NonEmptyString)),
  providerOverrides: Type.Optional(
    closedObject({
      webSearch: Type.Optional(NonEmptyString),
      webFetch: Type.Optional(NonEmptyString),
    }),
  ),
});

/** Static type for secret resolution requests. */
export type SecretsResolveParams = Static<typeof SecretsResolveParamsSchema>;

/** One resolved secret assignment path plus its provider-owned value. */
export const SecretsResolveAssignmentSchema = closedObject({
  path: Type.Optional(NonEmptyString),
  pathSegments: Type.Array(NonEmptyString),
  value: Type.Unknown(),
});

/** Secret resolution response with assignments and safe diagnostics. */
export const SecretsResolveResultSchema = closedObject({
  ok: Type.Optional(Type.Boolean()),
  assignments: Type.Optional(Type.Array(SecretsResolveAssignmentSchema)),
  diagnostics: Type.Optional(Type.Array(NonEmptyString)),
  inactiveRefPaths: Type.Optional(Type.Array(NonEmptyString)),
});

/** Static type for secret resolution responses. */
export type SecretsResolveResult = Static<typeof SecretsResolveResultSchema>;
