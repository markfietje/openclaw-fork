// Shutter image-egress gate: the single decision point shared by remote
// markdown images and inline data-URI images. Hosts fetch only when the
// operator allowlists them; data-URIs render only inside a decoded budget.
// Both checks are pure so the parser and unit tests exercise the same rule.

export const MAX_INLINE_DATA_IMAGE_BYTES = 64 * 1024;

const DATA_IMAGE_BASE64_RE = /^data:image\/[a-z0-9.+-]+;base64,(.*)$/i;
const BASE64_CHARSET_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decoded byte length of a base64 data-URI image payload (0 when unparsable). */
export function decodedDataImageByteLength(src: string): number {
  const match = DATA_IMAGE_BASE64_RE.exec(src);
  const raw = match?.[1].replace(/[\s,]/g, "");
  if (!raw || raw.length % 4 !== 0 || !BASE64_CHARSET_RE.test(raw)) {
    return 0;
  }
  const unpadded = raw.replace(/=+$/, "");
  return Math.floor((unpadded.length * 3) / 4);
}

/** A data-URI image may render only inside the decoded budget. */
export function isBoundedDataImage(src: string): boolean {
  const length = decodedDataImageByteLength(src);
  return length > 0 && length <= MAX_INLINE_DATA_IMAGE_BYTES;
}

export function normalizeTrustedHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/** Exact-host allowlist: subdomains are never implied (trust is explicit). */
export function isRemoteImageHostAllowlisted(hosts: readonly string[], src: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(src);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return false;
  }
  const host = normalizeTrustedHost(parsed.hostname);
  return host !== "" && hosts.some((candidate) => normalizeTrustedHost(candidate) === host);
}
