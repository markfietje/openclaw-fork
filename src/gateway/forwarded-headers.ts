import { normalizeIpAddress } from "@openclaw/net-policy/ip";
import { isTrustedProxyAddress } from "./net.js";

// Client-IP resolution for proxy headers, walking right-to-left for the first
// untrusted hop. net.ts resolves the effective client IP but not the per-header
// value needed for header-consistency checks, so these stay local.
function firstUntrustedHop(ips: string[], trustedProxies?: string[]): string | undefined {
  for (let i = ips.length - 1; i >= 0; i -= 1) {
    if (!isTrustedProxyAddress(ips[i], trustedProxies)) {
      return ips[i];
    }
  }
  return undefined;
}

// Canonical host extraction: strips brackets, strips :port for IPv4, and leaves
// unbracketed IPv6 (no port) intact. normalizeIpAddress then parses both
// families and maps IPv4-mapped IPv6 to its IPv4 text, so distinct forwards
// values compare correctly instead of being truncated at the first colon.
function normalizeForwardedIp(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  let host = trimmed;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end !== -1) {
      host = host.slice(1, end);
    }
  } else if (host.includes(":")) {
    // Bracketed IPv6 literals are handled above. Any remaining colon for a
    // non-bracketed value is either IPv4:port or an unbracketed IPv6 literal.
    // Use canonical IP parsing to tell them apart rather than split(":").
    const direct = normalizeIpAddress(host);
    if (direct) {
      return direct;
    }
    const lastColon = host.lastIndexOf(":");
    const withoutPort = host.slice(0, lastColon);
    host = withoutPort;
  }
  return normalizeIpAddress(host);
}

function forwardedForClientIp(forwardedFor: string, trustedProxies?: string[]): string | undefined {
  const ips: string[] = [];
  for (const entry of forwardedFor.split(",")) {
    const normalized = normalizeForwardedIp(entry);
    if (normalized) {
      ips.push(normalized);
    }
  }
  return firstUntrustedHop(ips, trustedProxies);
}

function resolveForwardedHeaderClientIp(params: {
  forwarded?: string;
  trustedProxies?: string[];
}): string | undefined {
  if (!params.forwarded || !params.trustedProxies?.length) {
    return undefined;
  }
  const ips: string[] = [];
  for (const segment of params.forwarded.split(/\s*,\s*/)) {
    const forMatch = segment.match(/for=(?:"([^"]+)"|([^;,]+))/i);
    if (!forMatch) {
      continue;
    }
    const captured = forMatch[1] ?? forMatch[2];
    // forMatch is truthy only when one of the two capture groups matched.
    const normalized = normalizeForwardedIp(captured!);
    if (normalized) {
      ips.push(normalized);
    }
  }
  return firstUntrustedHop(ips, params.trustedProxies);
}

/**
 * Headers a reverse proxy may set that influence trust/session decisions.
 * When present more than once or comma-chained, the request is malformed or
 * an attempt to smuggle a second value past the proxy.
 */
const SENSITIVE_HEADERS = new Set([
  "host",
  "origin",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
]);

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Rejects requests that send sensitive proxy headers more than once or
 * comma-chained. Off by default; enable with `gateway.security.strictHeaderValidation`.
 *
 * Reads Node's `req.rawHeaders` (the flat [name, value, ...] array) because the
 * normalized `req.headers` discards duplicate Host lines and joins many other
 * duplicates before this code runs, so a strict guarantee built on the normalized
 * view would silently miss the duplicates it advertises.
 */
export function validateSensitiveHeaders(
  rawHeaders: string[],
): { ok: false; header: string; reason: string } | { ok: true } {
  // rawHeaders is a flat [name, value, name, value, ...] array; walk pairs.
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (typeof name !== "string" || typeof value !== "string") {
      continue;
    }
    if (!SENSITIVE_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    // Duplicate detection: any other pair with the same sensitive name is a
    // smuggling attempt regardless of value. Node's normalized headers would
    // have collapsed or discarded these.
    for (let j = i + 2; j + 1 < rawHeaders.length; j += 2) {
      const otherName = rawHeaders[j];
      if (typeof otherName === "string" && otherName.toLowerCase() === name.toLowerCase()) {
        return { ok: false, header: name.toLowerCase(), reason: "duplicate" };
      }
    }
    // Comma-chain detection on the raw value. A single header line carrying a
    // comma in a sensitive field is a chain attempt that proxies would split.
    if (value.includes(",")) {
      return { ok: false, header: name.toLowerCase(), reason: "chain-not-allowed" };
    }
  }
  return { ok: true };
}

export function validateProtoMismatch(params: {
  originProto: string;
  forwardedProto?: string;
  xForwardedProto?: string | string[];
}): { ok: true } | { ok: false; reason: string } {
  const { originProto, forwardedProto, xForwardedProto } = params;

  const originNormalized = originProto.toLowerCase();

  if (forwardedProto) {
    const forwardedNormalized = forwardedProto.toLowerCase();
    if (originNormalized !== forwardedNormalized) {
      return {
        ok: false,
        reason: `origin protocol (${originProto}) does not match Forwarded proto (${forwardedProto})`,
      };
    }
  }

  if (xForwardedProto) {
    const raw = Array.isArray(xForwardedProto) ? xForwardedProto[0] : xForwardedProto;
    if (raw) {
      const xNormalized = raw.trim().toLowerCase();
      if (originNormalized !== xNormalized) {
        return {
          ok: false,
          reason: `origin protocol (${originProto}) does not match X-Forwarded-Proto (${raw})`,
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Detect contradictions between `X-Forwarded-For` and `Forwarded` headers.
 * When both are present, resolve the rightmost untrusted hop from each and
 * verify they agree. Call after `validateSensitiveHeaders` to catch header
 * contradiction attacks where a client forges one proxy header to disagree
 * with the other.
 */
export function validateForwardedHeaderConsistency(
  headers: Record<string, string | string[] | undefined>,
  trustedProxies?: string[],
): { ok: true } | { ok: false; reason: string } {
  const xff = headerValue(headers["x-forwarded-for"]);
  const fwd = headerValue(headers["forwarded"]);

  if (!xff || !fwd) {
    return { ok: true };
  }

  const xffIp = forwardedForClientIp(xff, trustedProxies);
  const fwdIp = resolveForwardedHeaderClientIp({ forwarded: fwd, trustedProxies });

  if (xffIp && fwdIp && xffIp !== fwdIp) {
    return {
      ok: false,
      reason: `forwarded header inconsistency: X-Forwarded-For resolves to ${xffIp} but Forwarded resolves to ${fwdIp}`,
    };
  }

  return { ok: true };
}
