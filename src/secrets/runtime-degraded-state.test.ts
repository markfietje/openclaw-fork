/** Tests for process-local SecretRef degraded-owner state. */
import { afterEach, describe, expect, it } from "vitest";
import {
  associateSecretResolutionErrorOwners,
  assertSecretOwnerAvailable,
  listActiveDegradedSecretOwners,
  listActiveSecretDegradations,
  listSecretResolutionErrorOwners,
  SecretSurfaceUnavailableError,
  setActiveDegradedSecretOwners,
  setActiveReloadSecretDegradations,
} from "./runtime-degraded-state.js";

afterEach(() => {
  setActiveDegradedSecretOwners([]);
});

describe("runtime degraded SecretRef owners", () => {
  it("publishes cloned owner snapshots and throws the typed unavailable error", () => {
    const owner = {
      ownerKind: "provider" as const,
      ownerId: "openai",
      state: "unavailable" as const,
      paths: ["models.providers.openai.apiKey"],
      refKeys: ["env:default:OPENAI_API_KEY"],
      reason: "secret reference was not found",
    };
    setActiveDegradedSecretOwners([owner]);
    owner.paths.push("mutated");

    expect(listActiveDegradedSecretOwners()).toEqual([
      expect.objectContaining({ paths: ["models.providers.openai.apiKey"] }),
    ]);
    expect(() => assertSecretOwnerAvailable("provider", "openai")).toThrowError(
      SecretSurfaceUnavailableError,
    );
    expect(() => assertSecretOwnerAvailable("provider", "openai")).toThrow(
      "Secret owner provider:openai is configured but unavailable",
    );
    expect(() => assertSecretOwnerAvailable("provider", "anthropic")).not.toThrow();
  });

  it("projects cold and stale owners with retry guidance", () => {
    const coldOwner = {
      ownerKind: "route" as const,
      ownerId: "webhooks/zapier",
      state: "unavailable" as const,
      paths: ["plugins.entries.webhooks.config.routes.zapier.secret"],
      refKeys: ["env:default:WEBHOOK_KEY"],
      reason: "secret reference was not found",
    };
    const staleOwner = {
      kind: "provider" as const,
      id: "openai",
      state: "stale" as const,
      paths: ["models.providers.openai.apiKey"],
      reason: "secret provider failed",
      retryHint: "openclaw secrets reload" as const,
    };
    setActiveDegradedSecretOwners([coldOwner]);
    setActiveReloadSecretDegradations([
      {
        kind: "route",
        id: "webhooks/zapier",
        reason: "reload attempt remained cold",
        state: "cold",
        retryHint: "openclaw secrets reload",
        paths: coldOwner.paths,
      },
      staleOwner,
    ]);

    expect(listActiveSecretDegradations()).toEqual([
      {
        kind: "route",
        id: "webhooks/zapier",
        reason: "secret reference was not found",
        state: "cold",
        retryHint: "openclaw secrets reload",
        paths: ["plugins.entries.webhooks.config.routes.zapier.secret"],
      },
      {
        kind: "provider",
        id: "openai",
        reason: "secret provider failed",
        state: "stale",
        retryHint: "openclaw secrets reload",
        paths: ["models.providers.openai.apiKey"],
      },
    ]);
  });

  it("records strict resolution owner metadata without exposing mutable state", () => {
    const error = new Error("private provider details");
    const owner = {
      ownerKind: "provider" as const,
      ownerId: "openai",
      state: "unavailable" as const,
      paths: ["models.providers.openai.apiKey"],
      refKeys: ["env:default:OPENAI_API_KEY"],
      reason: "secret provider failed",
      failureMatched: true,
    };
    associateSecretResolutionErrorOwners(error, [owner]);

    const recorded = listSecretResolutionErrorOwners(error);
    recorded[0]?.paths.push("mutated");
    expect(listSecretResolutionErrorOwners(error)[0]?.paths).toEqual([
      "models.providers.openai.apiKey",
    ]);
  });
});
