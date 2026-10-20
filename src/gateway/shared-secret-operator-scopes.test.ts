import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  resolveOpenAiCompatibleHttpSenderIsOwner,
  resolveSharedSecretHttpOperatorScopes,
  type AuthorizedGatewayHttpRequest,
} from "./http-auth-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { shouldClearUnboundScopesForMissingDeviceIdentity } from "./server/ws-connection/connect-policy.js";
import { SHARED_SECRET_OPERATOR_SCOPES } from "./shared-secret-operator-scopes.js";

const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage;

const sharedSecretAuth: AuthorizedGatewayHttpRequest = {
  authMethod: "token",
  trustDeclaredOperatorScopes: false,
};

const passwordSecretAuth: AuthorizedGatewayHttpRequest = {
  authMethod: "password",
  trustDeclaredOperatorScopes: false,
};

/** Methods the gateway scopes to `operator.admin` - a universal bypass. */
const ADMINISTRATIVE_METHODS = [
  "config.set",
  "config.apply",
  "update.run",
  "secrets.resolve",
  "terminal.open",
  "exec.approvals.set",
  "device.pair.setupCode",
];

/** Methods the gateway scopes to `operator.approvals` - self-approving an escalation. */
const APPROVAL_METHODS = ["exec.approval.resolve"];

describe("shared-secret operator scopes", () => {
  it("carries no administrative scope", () => {
    expect(SHARED_SECRET_OPERATOR_SCOPES).not.toContain("operator.admin");
    expect(SHARED_SECRET_OPERATOR_SCOPES).not.toContain("operator.approvals");
    expect(SHARED_SECRET_OPERATOR_SCOPES).not.toContain("operator.talk.secrets");
  });

  it("resolves a shared secret to exactly the named set", () => {
    expect(resolveSharedSecretHttpOperatorScopes(req, sharedSecretAuth)).toEqual([
      ...SHARED_SECRET_OPERATOR_SCOPES,
    ]);
  });

  it("resolves a password credential to the same named set", () => {
    expect(resolveSharedSecretHttpOperatorScopes(req, passwordSecretAuth)).toEqual([
      ...SHARED_SECRET_OPERATOR_SCOPES,
    ]);
  });

  it("does not let a shared secret authorize an administrative method", () => {
    const scopes = resolveSharedSecretHttpOperatorScopes(req, sharedSecretAuth);
    for (const method of [...ADMINISTRATIVE_METHODS, ...APPROVAL_METHODS]) {
      expect(authorizeOperatorScopesForMethod(method, scopes).allowed).toBe(false);
    }
  });

  it("is never an administrator on any transport", () => {
    // The WebSocket path withholds scopes from a shared secret outright.
    const wsScopesCleared = shouldClearUnboundScopesForMissingDeviceIdentity({
      decision: { kind: "allow" },
      authMethod: "token",
    });
    expect(wsScopesCleared).toBe(true);
    const wsScopes: readonly string[] = wsScopesCleared ? [] : SHARED_SECRET_OPERATOR_SCOPES;
    const httpScopes = resolveSharedSecretHttpOperatorScopes(req, sharedSecretAuth);
    for (const scopes of [httpScopes, wsScopes]) {
      expect(scopes).not.toContain("operator.admin");
      for (const method of ADMINISTRATIVE_METHODS) {
        expect(authorizeOperatorScopesForMethod(method, scopes).allowed).toBe(false);
      }
    }
  });

  it("still authorizes the OpenAI-compatible chat.send scope", () => {
    const scopes = resolveSharedSecretHttpOperatorScopes(req, sharedSecretAuth);
    expect(authorizeOperatorScopesForMethod("chat.send", scopes).allowed).toBe(true);
  });

  it("keeps the OpenAI-compatible owner semantics for a shared secret", () => {
    expect(resolveOpenAiCompatibleHttpSenderIsOwner(req, sharedSecretAuth)).toBe(true);
  });
});
