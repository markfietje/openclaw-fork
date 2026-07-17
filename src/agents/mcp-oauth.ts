/** MCP OAuth credential provider, flow coordinator, and login helpers. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  type OpenClawStateLeaseContext,
  withOpenClawStateLease,
} from "../state/openclaw-state-lease.js";
import {
  clearMcpOAuthStore,
  readMcpOAuthStore,
  readMcpOAuthStoreReadOnly,
  resolveMcpOAuthStoreKey,
  updateMcpOAuthStore,
  type McpOAuthStore,
} from "./mcp-oauth-store.js";

export type McpOAuthConfig = {
  scope?: unknown;
  redirectUrl?: unknown;
  clientMetadataUrl?: unknown;
};

/** Persisted OAuth credential presence flags for one MCP server. */
export type McpOAuthCredentialsStatus = {
  hasTokens: boolean;
  hasClientInformation: boolean;
  hasCodeVerifier: boolean;
  hasDiscoveryState: boolean;
  hasLastAuthorizationUrl: boolean;
};

const LEGACY_DEFAULT_REDIRECT_URL = "http://127.0.0.1:8989/oauth/callback";
const LOCALHOST_REDIRECT_URL = "http://localhost:8989/oauth/callback";
const TOKEN_EXPIRY_SKEW_MS = 30_000;
const MCP_OAUTH_LEASE_MS = 60_000;
const MCP_OAUTH_LEASE_WAIT_MS = 30_000;

function resolveTokenExpiresAt(tokens: OAuthTokens): number | undefined {
  const expiresIn = tokens.expires_in;
  return typeof expiresIn === "number" && Number.isFinite(expiresIn)
    ? Date.now() + expiresIn * 1000
    : undefined;
}

function isMcpOAuthRedirectRegistrationError(error: unknown): boolean {
  return /invalid_client_metadata|redirect_uri/i.test(String(error));
}

function resolveOAuthRedirectUrl(config: McpOAuthConfig, store: McpOAuthStore = {}): string {
  return (
    normalizeOptionalString(config.redirectUrl) ??
    normalizeOptionalString(store.redirectUrl) ??
    LEGACY_DEFAULT_REDIRECT_URL
  );
}

function buildOAuthClientMetadata(
  config: McpOAuthConfig,
  store: McpOAuthStore = {},
): OAuthClientMetadata {
  const redirectUrl = resolveOAuthRedirectUrl(config, store);
  return {
    client_name: "OpenClaw MCP",
    redirect_uris: [redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(normalizeOptionalString(config.scope)
      ? { scope: normalizeOptionalString(config.scope) }
      : {}),
  };
}

async function withMcpOAuthLease<T>(
  storeKey: string,
  run: (lease: OpenClawStateLeaseContext) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return await withOpenClawStateLease(
    {
      scope: "core:mcp-oauth",
      key: storeKey,
      database: { scope: "shared" },
      leaseMs: MCP_OAUTH_LEASE_MS,
      waitMs: MCP_OAUTH_LEASE_WAIT_MS,
      ...(signal ? { signal } : {}),
    },
    run,
  );
}

function bindLeaseAssertion(
  lease: OpenClawStateLeaseContext | undefined,
): ((database: DatabaseSync) => void) | undefined {
  return lease ? (database) => lease.assertOwnedInTransaction(database) : undefined;
}

/** Bind OAuth network work to the lease that fences its persisted side effects. */
export function withMcpOAuthLeaseSignal(
  fetchFn: FetchLike | undefined,
  leaseSignal: AbortSignal,
): FetchLike {
  const baseFetch: FetchLike = fetchFn ?? ((url, init) => fetch(url, init));
  return async (url, init) => {
    const requestSignal = init?.signal;
    const signal = requestSignal ? AbortSignal.any([requestSignal, leaseSignal]) : leaseSignal;
    return await baseFetch(url, { ...init, signal });
  };
}

function beginMcpOAuthAuthorization(store: McpOAuthStore): McpOAuthStore {
  const next = { ...store };
  if (next.credentialState === "uninitialized") {
    delete next.credentialState;
  }
  return next;
}

function mcpOAuthAdditionalAuthorizationError(serverName: string): Error {
  return new Error(
    `MCP server "${serverName}" requires additional OAuth authorization. Run openclaw mcp login ${serverName}.`,
  );
}

function applyMcpOAuthAuthorizationChallenge(
  current: McpOAuthStore,
  params: {
    resourceMetadataUrl?: string;
    scope?: string;
    requiresAuthorization?: true;
  },
): McpOAuthStore {
  const next: McpOAuthStore = {
    ...current,
    pendingAuthorizationChallenge: {
      ...current.pendingAuthorizationChallenge,
      ...(params.resourceMetadataUrl ? { resourceMetadataUrl: params.resourceMetadataUrl } : {}),
      ...(params.scope ? { scope: params.scope } : {}),
      ...(params.requiresAuthorization ? { requiresAuthorization: true } : {}),
    },
  };
  if (
    current.credentialState === undefined &&
    current.tokens === undefined &&
    current.clientInformation === undefined &&
    current.codeVerifier === undefined &&
    current.discoveryState === undefined &&
    current.lastAuthorizationUrl === undefined &&
    current.redirectUrl === undefined
  ) {
    next.credentialState = "uninitialized";
  }
  if (
    params.resourceMetadataUrl &&
    current.discoveryState?.resourceMetadataUrl !== params.resourceMetadataUrl
  ) {
    delete next.discoveryState;
  }
  return next;
}

/** Creates the MCP SDK OAuth provider backed by canonical shared SQLite state. */
export function createMcpOAuthClientProvider(params: {
  serverName: string;
  serverUrl: string;
  config?: McpOAuthConfig;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  allowAuthorizationRedirect?: boolean;
  suppressStoredTokens?: boolean;
  lease?: OpenClawStateLeaseContext;
}): OAuthClientProvider {
  const config = params.config ?? {};
  const storeKey = resolveMcpOAuthStoreKey(params.serverName, params.serverUrl);
  const assertOwnedInTransaction = bindLeaseAssertion(params.lease);
  const updateStore = (update: (store: McpOAuthStore) => McpOAuthStore) =>
    updateMcpOAuthStore(storeKey, update, assertOwnedInTransaction);
  const allowAuthorizationRedirect =
    params.allowAuthorizationRedirect ?? Boolean(params.onAuthorizationUrl);
  const assertAuthorizationRedirectAllowed = () => {
    if (!allowAuthorizationRedirect) {
      throw new Error(
        `MCP server "${params.serverName}" requires OAuth authorization. Run openclaw mcp login ${params.serverName}.`,
      );
    }
  };
  return {
    get redirectUrl() {
      return resolveOAuthRedirectUrl(config, readMcpOAuthStore(storeKey));
    },
    clientMetadataUrl: normalizeOptionalString(config.clientMetadataUrl),
    get clientMetadata() {
      return buildOAuthClientMetadata(config, readMcpOAuthStore(storeKey));
    },
    state() {
      assertAuthorizationRedirectAllowed();
      // State validates one browser round trip. It is not reusable persisted state.
      return randomUUID();
    },
    clientInformation() {
      return readMcpOAuthStore(storeKey).clientInformation;
    },
    saveClientInformation(clientInformation) {
      updateStore((store) => ({ ...beginMcpOAuthAuthorization(store), clientInformation }));
    },
    tokens() {
      return params.suppressStoredTokens ? undefined : readMcpOAuthStore(storeKey).tokens;
    },
    saveTokens(tokens) {
      updateStore((store) => {
        const next: McpOAuthStore = { ...store, tokens };
        delete next.credentialState;
        delete next.pendingAuthorizationChallenge;
        const tokenExpiresAt = resolveTokenExpiresAt(tokens);
        if (tokenExpiresAt === undefined) {
          delete next.tokenExpiresAt;
        } else {
          next.tokenExpiresAt = tokenExpiresAt;
        }
        return next;
      });
    },
    async redirectToAuthorization(authorizationUrl) {
      assertAuthorizationRedirectAllowed();
      updateStore((store) => ({
        ...beginMcpOAuthAuthorization(store),
        lastAuthorizationUrl: authorizationUrl.toString(),
      }));
      await params.onAuthorizationUrl?.(authorizationUrl);
    },
    saveCodeVerifier(codeVerifier) {
      assertAuthorizationRedirectAllowed();
      updateStore((store) => ({ ...beginMcpOAuthAuthorization(store), codeVerifier }));
    },
    codeVerifier() {
      const codeVerifier = readMcpOAuthStore(storeKey).codeVerifier;
      if (!codeVerifier) {
        throw new Error("Missing MCP OAuth code verifier. Run the login flow again.");
      }
      return codeVerifier;
    },
    invalidateCredentials(scope) {
      updateStore((store) => {
        const next: McpOAuthStore = { ...store };
        if (scope === "all" || scope === "client") {
          delete next.clientInformation;
        }
        if ((scope === "all" || scope === "tokens") && params.suppressStoredTokens !== true) {
          delete next.tokens;
          delete next.tokenExpiresAt;
          next.credentialState = "cleared";
        }
        if (scope === "all" || scope === "verifier") {
          delete next.codeVerifier;
        }
        if (scope === "all" || scope === "discovery") {
          delete next.discoveryState;
        }
        return next;
      });
    },
    saveDiscoveryState(discoveryState) {
      updateStore((store) => ({ ...beginMcpOAuthAuthorization(store), discoveryState }));
    },
    discoveryState() {
      return readMcpOAuthStore(storeKey).discoveryState;
    },
  };
}

type ResolveMcpOAuthAccessTokenParams = {
  serverName: string;
  serverUrl: string;
  config?: McpOAuthConfig;
  fetchFn?: FetchLike;
  acceptUnknownExpiry?: boolean;
  rejectedAccessToken?: string;
  resourceMetadataUrl?: URL;
  scope?: string;
  allowMissingToken?: boolean;
  authorizationChallenge?: boolean;
  interactiveAuthorizationRequired?: boolean;
  signal?: AbortSignal;
};

/** Returns a current MCP-native OAuth token under one cross-process flow lease. */
export function resolveMcpOAuthAccessToken(
  params: ResolveMcpOAuthAccessTokenParams & { allowMissingToken: true },
): Promise<string | undefined>;
export function resolveMcpOAuthAccessToken(
  params: ResolveMcpOAuthAccessTokenParams,
): Promise<string>;
export async function resolveMcpOAuthAccessToken(
  params: ResolveMcpOAuthAccessTokenParams,
): Promise<string | undefined> {
  const storeKey = resolveMcpOAuthStoreKey(params.serverName, params.serverUrl);
  return await withMcpOAuthLease(
    storeKey,
    async (lease) => {
      const store = readMcpOAuthStore(storeKey);
      const tokens = store.tokens;
      const rejectedCurrentToken = params.rejectedAccessToken === tokens?.access_token;
      const challengeAppliesToCurrentState = !tokens?.access_token || rejectedCurrentToken;
      if (params.authorizationChallenge === true && challengeAppliesToCurrentState) {
        const resourceMetadataUrl = params.resourceMetadataUrl?.toString();
        const scope = normalizeOptionalString(params.scope);
        if (resourceMetadataUrl || scope || params.interactiveAuthorizationRequired === true) {
          updateMcpOAuthStore(
            storeKey,
            (current) =>
              applyMcpOAuthAuthorizationChallenge(current, {
                resourceMetadataUrl,
                scope,
                ...(params.interactiveAuthorizationRequired === true
                  ? { requiresAuthorization: true }
                  : {}),
              }),
            bindLeaseAssertion(lease),
          );
        }
      }
      if (
        params.authorizationChallenge === true &&
        params.interactiveAuthorizationRequired === true &&
        challengeAppliesToCurrentState
      ) {
        throw mcpOAuthAdditionalAuthorizationError(params.serverName);
      }
      if (store.pendingAuthorizationChallenge?.requiresAuthorization === true) {
        throw mcpOAuthAdditionalAuthorizationError(params.serverName);
      }
      if (!tokens?.access_token) {
        if (params.allowMissingToken === true) {
          return undefined;
        }
        throw new Error(
          `MCP server "${params.serverName}" requires OAuth authorization. Run openclaw mcp login ${params.serverName}.`,
        );
      }

      const tokenIsFresh =
        store.tokenExpiresAt !== undefined &&
        store.tokenExpiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS;
      if (
        !rejectedCurrentToken &&
        (tokenIsFresh ||
          (store.tokenExpiresAt === undefined &&
            (params.acceptUnknownExpiry === true || !tokens.refresh_token)))
      ) {
        return tokens.access_token;
      }
      if (!tokens.refresh_token) {
        throw new Error(
          `MCP server "${params.serverName}" has expired OAuth credentials. Run openclaw mcp login ${params.serverName}.`,
        );
      }

      const pendingChallenge = store.pendingAuthorizationChallenge;
      const provider = createMcpOAuthClientProvider({ ...params, lease });
      const result = await auth(provider, {
        serverUrl: params.serverUrl,
        resourceMetadataUrl:
          params.resourceMetadataUrl ??
          (pendingChallenge?.resourceMetadataUrl
            ? new URL(pendingChallenge.resourceMetadataUrl)
            : undefined),
        scope:
          params.scope ??
          normalizeOptionalString(pendingChallenge?.scope) ??
          normalizeOptionalString(params.config?.scope),
        fetchFn: withMcpOAuthLeaseSignal(params.fetchFn, lease.signal),
      });
      lease.assertOwned();
      const refreshedTokens = await provider.tokens();
      if (result !== "AUTHORIZED" || !refreshedTokens?.access_token) {
        throw new Error(
          `MCP server "${params.serverName}" could not refresh OAuth credentials. Run openclaw mcp login ${params.serverName}.`,
        );
      }
      return refreshedTokens.access_token;
    },
    params.signal,
  );
}

/** Persist a terminal resource rejection without overwriting newer credentials. */
export async function recordMcpOAuthAuthorizationRequired(params: {
  serverName: string;
  serverUrl: string;
  rejectedAccessToken: string;
  resourceMetadataUrl?: URL;
  scope?: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const storeKey = resolveMcpOAuthStoreKey(params.serverName, params.serverUrl);
  return await withMcpOAuthLease(
    storeKey,
    async (lease) => {
      const store = readMcpOAuthStore(storeKey);
      if (store.tokens?.access_token !== params.rejectedAccessToken) {
        return false;
      }
      let recorded = false;
      updateMcpOAuthStore(
        storeKey,
        (current) => {
          if (current.tokens?.access_token !== params.rejectedAccessToken) {
            return current;
          }
          recorded = true;
          return applyMcpOAuthAuthorizationChallenge(current, {
            resourceMetadataUrl: params.resourceMetadataUrl?.toString(),
            scope: normalizeOptionalString(params.scope),
            requiresAuthorization: true,
          });
        },
        bindLeaseAssertion(lease),
      );
      return recorded;
    },
    params.signal,
  );
}

/** Deletes one OAuth session without racing an in-flight refresh or login. */
export async function clearMcpOAuthCredentials(params: {
  serverName: string;
  serverUrl: string;
}): Promise<void> {
  const storeKey = resolveMcpOAuthStoreKey(params.serverName, params.serverUrl);
  await withMcpOAuthLease(storeKey, async (lease) => {
    clearMcpOAuthStore(storeKey, bindLeaseAssertion(lease));
  });
}

/** Reads stored OAuth credential presence without exposing values or creating state. */
export async function readMcpOAuthCredentialsStatus(params: {
  serverName: string;
  serverUrl: string;
}): Promise<McpOAuthCredentialsStatus> {
  const store = readMcpOAuthStoreReadOnly(
    resolveMcpOAuthStoreKey(params.serverName, params.serverUrl),
  );
  return {
    hasTokens: Boolean(store.tokens),
    hasClientInformation: Boolean(store.clientInformation),
    hasCodeVerifier: Boolean(store.codeVerifier),
    hasDiscoveryState: Boolean(store.discoveryState),
    hasLastAuthorizationUrl: Boolean(store.lastAuthorizationUrl),
  };
}

async function runMcpOAuthLoginAttempt(
  params: {
    serverName: string;
    serverUrl: string;
    config?: McpOAuthConfig;
    authorizationCode?: string;
    fetchFn?: FetchLike;
    onAuthorizationUrl?: (url: URL) => void | Promise<void>;
    resourceMetadataUrl?: URL;
    scope?: string;
    forceAuthorization?: boolean;
  },
  lease: OpenClawStateLeaseContext,
): Promise<"authorized" | "redirect"> {
  const result = await auth(
    createMcpOAuthClientProvider({
      ...params,
      allowAuthorizationRedirect: true,
      suppressStoredTokens: params.forceAuthorization,
      lease,
    }),
    {
      serverUrl: params.serverUrl,
      authorizationCode: normalizeOptionalString(params.authorizationCode),
      resourceMetadataUrl: params.resourceMetadataUrl,
      scope: normalizeOptionalString(params.scope) ?? normalizeOptionalString(params.config?.scope),
      fetchFn: withMcpOAuthLeaseSignal(params.fetchFn, lease.signal),
    },
  );
  lease.assertOwned();
  return result === "AUTHORIZED" ? "authorized" : "redirect";
}

/** Runs both redirect-registration attempts under one OAuth session lease. */
export async function runMcpOAuthLogin(params: {
  serverName: string;
  serverUrl: string;
  config?: McpOAuthConfig;
  authorizationCode?: string;
  fetchFn?: FetchLike;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
}): Promise<"authorized" | "redirect"> {
  const storeKey = resolveMcpOAuthStoreKey(params.serverName, params.serverUrl);
  return await withMcpOAuthLease(storeKey, async (lease) => {
    const store = readMcpOAuthStore(storeKey);
    const pendingChallenge = store.pendingAuthorizationChallenge;
    const loginParams = {
      ...params,
      config: {
        ...params.config,
        redirectUrl: normalizeOptionalString(params.config?.redirectUrl) ?? store.redirectUrl,
      },
      resourceMetadataUrl: pendingChallenge?.resourceMetadataUrl
        ? new URL(pendingChallenge.resourceMetadataUrl)
        : undefined,
      scope: normalizeOptionalString(pendingChallenge?.scope),
      forceAuthorization: pendingChallenge?.requiresAuthorization === true,
    };
    try {
      return await runMcpOAuthLoginAttempt(loginParams, lease);
    } catch (error) {
      if (
        !normalizeOptionalString(params.authorizationCode) &&
        !normalizeOptionalString(params.config?.redirectUrl) &&
        isMcpOAuthRedirectRegistrationError(error)
      ) {
        const result = await runMcpOAuthLoginAttempt(
          {
            ...loginParams,
            config: { ...params.config, redirectUrl: LOCALHOST_REDIRECT_URL },
          },
          lease,
        );
        updateMcpOAuthStore(
          storeKey,
          (current) => ({ ...current, redirectUrl: LOCALHOST_REDIRECT_URL }),
          bindLeaseAssertion(lease),
        );
        return result;
      }
      throw error;
    }
  });
}
