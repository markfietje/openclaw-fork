import { createHash } from "node:crypto";

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

export const canonicalJson = (value) => JSON.stringify(sortJson(value));
export const canonicalJsonSha256 = (value) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
