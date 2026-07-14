// Signal transport detection is a setup and compatibility-only network probe.
import type { SignalTransportConfig } from "./account-types.js";
import { containerCheck } from "./client-container.js";
import { signalCheck as nativeCheck } from "./client.js";

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export type SignalTransportProbeResult = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
};

export type SignalNativeTransportProbe = (
  url: string,
  timeoutMs?: number,
) => Promise<SignalTransportProbeResult>;

export type SignalContainerTransportProbe = (
  url: string,
  timeoutMs?: number,
  account?: string,
) => Promise<SignalTransportProbeResult>;

export function normalizeSignalTransportUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Signal transport URL is required");
  }
  const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Signal transport URL unsupported protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Signal transport URL must not include credentials");
  }
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

export async function detectSignalTransport(params: {
  url: string;
  account?: string;
  timeoutMs?: number;
  probeNative?: SignalNativeTransportProbe;
  probeContainer?: SignalContainerTransportProbe;
}): Promise<SignalTransportConfig> {
  const url = normalizeSignalTransportUrl(params.url);
  const timeoutMs = params.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probeNative = params.probeNative ?? nativeCheck;
  const probeContainer = params.probeContainer ?? containerCheck;
  const [native, container] = await Promise.all([
    probeNative(url, timeoutMs).catch(() => ({ ok: false })),
    probeContainer(url, timeoutMs, params.account).catch(() => ({ ok: false })),
  ]);
  if (native.ok) {
    return { kind: "external-native", url };
  }
  if (container.ok) {
    return { kind: "container", url };
  }
  throw new Error(`Signal transport not reachable at ${url}`);
}
