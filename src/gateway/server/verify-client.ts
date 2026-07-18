import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";
import type { OpenClawConfig } from "../../config/types.js";
import {
  validateForwardedHeaderConsistency,
  validateProtoMismatch,
  validateSensitiveHeaders,
} from "../forwarded-headers.js";
import { isLoopbackAddress, isTrustedProxyAddress } from "../net.js";
import { checkBrowserOrigin } from "../origin-check.js";

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;

type GatewayVerifyClientInfo = { origin: string; secure: boolean; req: IncomingMessage };
type GatewayVerifyClientCallback = (
  result: boolean,
  code?: number,
  message?: string,
  headers?: OutgoingHttpHeaders,
) => void;

type GatewayVerifyClient = (
  info: GatewayVerifyClientInfo,
  callback: GatewayVerifyClientCallback,
) => void;

type GatewayVerifyClientParams = {
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  /** Runtime config snapshot getter. Required: the gateway already holds cfg at startup. */
  getConfigSnapshot: () => OpenClawConfig;
};

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function hasSocketTlsFlags(
  socket: object,
): socket is { authorized?: unknown; encrypted?: unknown } {
  return "authorized" in socket || "encrypted" in socket;
}

function isSecureUpgradeRequest(req: IncomingMessage): boolean {
  const socket = req.socket;
  return hasSocketTlsFlags(socket) && (socket.authorized === true || socket.encrypted === true);
}

/**
 * Pre-handshake WebSocket validation for the gateway. Runs before the HTTP 101
 * response so unauthenticated clients never complete the upgrade.
 *
 * Design is additive and safe for existing deployments:
 * - Non-browser clients (CLI, native apps) send no Origin header and pass through;
 *   they are authenticated post-handshake as upstream does today.
 * - Only browser-origin requests are origin-checked, and only when an Origin is present.
 * - Protocol/header contradiction checks only reject genuine mismatches; they never
 *   reject a well-formed request from a trusted proxy.
 *
 * Checks (defense-in-depth):
 * 1. Proto mismatch (opt-in via `strictHeaderValidation`) — reject when
 *    X-Forwarded-Proto / Forwarded proto disagrees with the socket transport,
 *    but only when the peer is NOT a trusted proxy (a trusted TLS-terminating
 *    proxy legitimately presents plaintext to the gateway).
 * 2. Forwarded-header consistency (opt-in via `strictHeaderValidation`) — reject
 *    when X-Forwarded-For and Forwarded disagree on the resolved client IP
 *    (header contradiction / smuggling attack).
 * 3. Strict header validation (opt-in via `strictHeaderValidation`) — reject
 *    duplicate or comma-chained sensitive proxy headers, read from rawHeaders
 *    so duplicates Node would normalize away are still caught.
 * 4. Untrusted proxy headers (opt-in via `rejectUntrustedProxyHeaders`) — reject
 *    proxy headers from a non-trusted peer.
 * 5. Origin + Sec-Fetch-Site — reject unauthorized browser origins and cross-site
 *    WebSocket initiations (CSRF / DNS-rebinding class defenses).
 */
export function createGatewayVerifyClient(params: GatewayVerifyClientParams): GatewayVerifyClient {
  const { log, getConfigSnapshot } = params;

  return (info, callback) => {
    const { req } = info;
    const configSnapshot = getConfigSnapshot();
    const gateway = configSnapshot.gateway as unknown as Record<string, unknown> | undefined;
    const security = (gateway?.security ?? {}) as Record<string, unknown>;
    const controlUi = configSnapshot.gateway?.controlUi;
    const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];

    const remoteAddr = req.socket?.remoteAddress;
    const MAX_FORWARDED_HEADER_LENGTH = 4096;
    const forwardedFor =
      headerValue(req.headers["x-forwarded-for"])?.slice(0, MAX_FORWARDED_HEADER_LENGTH) ??
      undefined;
    const forwardedHost =
      headerValue(req.headers["x-forwarded-host"])?.slice(0, MAX_FORWARDED_HEADER_LENGTH) ??
      undefined;
    const xForwardedProto = headerValue(req.headers["x-forwarded-proto"]);
    const forwarded =
      headerValue(req.headers.forwarded)?.slice(0, MAX_FORWARDED_HEADER_LENGTH) ?? undefined;
    const hasProxyHeaders = Boolean(
      forwardedFor || req.headers["x-real-ip"] || forwardedHost || xForwardedProto || forwarded,
    );
    const remoteIsTrustedProxy = isTrustedProxyAddress(remoteAddr, trustedProxies);

    // 1-3: Strict proxy/header validation is opt-in. When `strictHeaderValidation`
    //    is enabled the gateway applies all three strict checks together: proto
    //    mismatch (only when the peer is not a trusted proxy), forwarded-header
    //    consistency, and duplicate/chained sensitive headers. All default off so
    //    existing proxy deployments see zero new rejections.
    if (security.strictHeaderValidation === true) {
      // 1. Proto mismatch — only enforce when the peer is not a trusted proxy.
      if (!remoteIsTrustedProxy) {
        const originProto = isSecureUpgradeRequest(req) ? "https" : "http";
        const protoCheck = validateProtoMismatch({
          originProto,
          forwardedProto: forwarded
            ? headerValue(req.headers.forwarded)?.match(/proto=([^;,]+)/i)?.[1]
            : undefined,
          xForwardedProto: xForwardedProto ? [xForwardedProto] : undefined,
        });
        if (!protoCheck.ok) {
          log.warn(`verifyClient: ${protoCheck.reason}`);
          callback(false, HTTP_BAD_REQUEST, "invalid protocol");
          return;
        }
      }

      // 2. Forwarded-header consistency.
      const consistency = validateForwardedHeaderConsistency(req.headers, trustedProxies);
      if (!consistency.ok) {
        log.warn(`verifyClient: ${consistency.reason}`);
        callback(false, HTTP_BAD_REQUEST, "invalid headers");
        return;
      }

      // 3. Sensitive-header duplicate/chain validation. Reads req.rawHeaders
      //    because Node's normalized req.headers discards duplicate Host lines
      //    and joins many other duplicates before this code runs, so the strict
      //    guarantee would silently miss the duplicates it advertises.
      const headerValidation = validateSensitiveHeaders(req.rawHeaders ?? []);
      if (!headerValidation.ok) {
        log.warn(`verifyClient: strict header validation failed: ${headerValidation.header}`);
        callback(false, HTTP_BAD_REQUEST, "invalid headers");
        return;
      }
    }

    // 4. Untrusted proxy headers (opt-in).
    if (hasProxyHeaders && !remoteIsTrustedProxy && security.rejectUntrustedProxyHeaders === true) {
      log.warn(`verifyClient: proxy headers from untrusted address (remote=${remoteAddr ?? "?"})`);
      callback(false, HTTP_FORBIDDEN, "proxy headers from untrusted source");
      return;
    }

    // 5. Origin + Sec-Fetch-Site (browser clients only).
    // A missing Origin header means a non-browser client (CLI, native app); it
    // authenticates post-handshake as today. A literal "null" Origin is a real
    // browser opaque origin and MUST fall through to checkBrowserOrigin, not skip
    // the gate — otherwise an opaque-origin context bypasses the CSRF/origin check.
    const MAX_ORIGIN_LENGTH = 256;
    const requestOrigin = info.origin?.slice(0, MAX_ORIGIN_LENGTH) ?? undefined;
    if (!requestOrigin) {
      callback(true);
      return;
    }

    const isLocalClient = isLoopbackAddress(remoteAddr) && !hasProxyHeaders;
    // Reuse the existing gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback
    // so pre-handshake and post-handshake admission share one source of truth.
    const originCheck = checkBrowserOrigin({
      requestHost: headerValue(req.headers.host)?.slice(0, 256),
      origin: requestOrigin,
      allowedOrigins: controlUi?.allowedOrigins,
      allowHostHeaderOriginFallback: controlUi?.dangerouslyAllowHostHeaderOriginFallback === true,
      isLocalClient,
    });
    if (!originCheck.ok) {
      log.warn(`verifyClient: origin not allowed (${originCheck.reason})`);
      callback(false, HTTP_FORBIDDEN, "origin not allowed");
      return;
    }

    // Sec-Fetch-Site cross-site rejection (CSRF class defense). Only browsers send
    // this header; same-origin Control UI connections pass. Opt-in only, because
    // browsers legitimately flag localhost/127.0.0.1 loopback aliases as cross-site
    // and checkBrowserOrigin already authorizes allowed origins above.
    const secFetchSite = headerValue(req.headers["sec-fetch-site"]).toLowerCase();
    if (
      security.rejectCrossSiteWebSocketRequests === true &&
      (secFetchSite === "cross-site" || secFetchSite === "cross-origin")
    ) {
      log.warn(
        `verifyClient: cross-site websocket request rejected (sec-fetch-site=${secFetchSite})`,
      );
      callback(false, HTTP_FORBIDDEN, "cross-site request rejected");
      return;
    }

    callback(true);
  };
}
