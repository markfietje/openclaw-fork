// Signal transport URLs are canonicalized before config writes and network use.
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
