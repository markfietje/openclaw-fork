// Signal transport policy centralizes local endpoint collision handling.
import type { SignalTransportConfig } from "./account-types.js";
import { normalizeSignalTransportUrl } from "./transport-url.js";

type SignalManagedNativeTransport = Extract<SignalTransportConfig, { kind: "managed-native" }>;

export const DEFAULT_SIGNAL_MANAGED_NATIVE_PORT = 8080;
export const DEFAULT_SIGNAL_MANAGED_NATIVE_HOST = "127.0.0.1";
const SIGNAL_LOOPBACK_HOST_ALIASES = new Set(["localhost", "127.0.0.1", "::1"]);

export function isValidSignalManagedNativePort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535;
}

export function allocateSignalManagedNativePort(params: {
  reservedPorts: ReadonlySet<number>;
  preferredPort?: number;
}): number {
  if (params.preferredPort !== undefined) {
    if (!isValidSignalManagedNativePort(params.preferredPort)) {
      throw new Error("Signal managed native port must be an integer between 1 and 65535.");
    }
    if (!params.reservedPorts.has(params.preferredPort)) {
      return params.preferredPort;
    }
  }
  let port = DEFAULT_SIGNAL_MANAGED_NATIVE_PORT;
  while (port <= 65_535 && params.reservedPorts.has(port)) {
    port += 1;
  }
  if (port > 65_535) {
    throw new Error("No available Signal managed native port remains.");
  }
  return port;
}

export function resolveLocalSignalTransportPort(baseUrl: string): number | undefined {
  try {
    const parsed = new URL(baseUrl);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const local =
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "::1" ||
      hostname === "::" ||
      hostname === "0.0.0.0" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (!local) {
      return undefined;
    }
    if (parsed.port) {
      return Number.parseInt(parsed.port, 10);
    }
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return undefined;
  }
}

export function isSignalManagedNativeConnectionUrlForBind(
  transport: SignalTransportConfig,
): boolean {
  if (transport.kind !== "managed-native" || !transport.url) {
    return false;
  }
  const connectionPort = resolveLocalSignalTransportPort(transport.url);
  const bindPort = transport.httpPort ?? DEFAULT_SIGNAL_MANAGED_NATIVE_PORT;
  if (connectionPort !== bindPort) {
    return false;
  }
  const connectionHost = new URL(transport.url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const bindHost = (transport.httpHost ?? DEFAULT_SIGNAL_MANAGED_NATIVE_HOST)
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (connectionHost === bindHost) {
    return true;
  }
  if (bindHost === "0.0.0.0") {
    return connectionHost === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(connectionHost);
  }
  if (bindHost === "::") {
    return connectionHost === "localhost" || connectionHost === "::1";
  }
  return (
    SIGNAL_LOOPBACK_HOST_ALIASES.has(bindHost) && SIGNAL_LOOPBACK_HOST_ALIASES.has(connectionHost)
  );
}

export function assignSignalManagedNativePort(
  transport: SignalManagedNativeTransport,
  httpPort: number,
): SignalManagedNativeTransport {
  if (!isValidSignalManagedNativePort(httpPort)) {
    throw new Error("Signal managed native port must be an integer between 1 and 65535.");
  }
  const connectionUrlValue = transport.url;
  if (!connectionUrlValue || !isSignalManagedNativeConnectionUrlForBind(transport)) {
    return { ...transport, httpPort };
  }
  const connectionUrl = new URL(connectionUrlValue);
  connectionUrl.port = String(httpPort);
  return {
    ...transport,
    url: normalizeSignalTransportUrl(connectionUrl.toString()),
    httpPort,
  };
}
