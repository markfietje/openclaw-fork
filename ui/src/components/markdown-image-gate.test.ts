import { describe, expect, it } from "vitest";
import {
  MAX_INLINE_DATA_IMAGE_BYTES,
  decodedDataImageByteLength,
  isBoundedDataImage,
  isRemoteImageHostAllowlisted,
} from "./markdown-image-gate.ts";

// 1x1 transparent PNG as a data URI (70 base64 chars → 67 decoded bytes... the
// canonical signature is 70 bytes decoded; exact size is irrelevant, only that
// it is far under budget).
const SMALL_DATA_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zb0YAAAAASUVORK5CYII=";

function dataImageWithDecodedBytes(bytes: number): string {
  return `data:image/png;base64,${Buffer.alloc(bytes, 7).toString("base64")}`;
}

describe("data-URI image budget", () => {
  it("measures decoded byte length, not payload string length", () => {
    const png = Buffer.alloc(1000, 1).toString("base64");
    expect(decodedDataImageByteLength(`data:image/png;base64,${png}`)).toBe(1000);
  });

  it("allows small data images and the exact 64 KiB boundary", () => {
    expect(decodedDataImageByteLength(SMALL_DATA_IMAGE)).toBeGreaterThan(0);
    expect(isBoundedDataImage(SMALL_DATA_IMAGE)).toBe(true);
    expect(isBoundedDataImage(dataImageWithDecodedBytes(MAX_INLINE_DATA_IMAGE_BYTES))).toBe(true);
  });

  it("refuses data images over the decoded budget", () => {
    expect(isBoundedDataImage(dataImageWithDecodedBytes(MAX_INLINE_DATA_IMAGE_BYTES + 1))).toBe(
      false,
    );
  });

  it("refuses malformed data image payloads", () => {
    expect(decodedDataImageByteLength("data:image/png;base64,")).toBe(0);
    expect(decodedDataImageByteLength("data:image/png;base64,!!!")).toBe(0);
    expect(decodedDataImageByteLength("data:image/svg+xml,<svg/>")).toBe(0);
    expect(decodedDataImageByteLength("not a data uri")).toBe(0);
    expect(isBoundedDataImage("data:image/png;base64,!!!")).toBe(false);
  });
});

describe("remote image host allowlist", () => {
  it("allows exact allowlisted hosts", () => {
    expect(
      isRemoteImageHostAllowlisted(["docs.example.com"], "https://docs.example.com/a.png"),
    ).toBe(true);
    expect(
      isRemoteImageHostAllowlisted(["DOCS.example.com"], "https://docs.example.com/a.png"),
    ).toBe(true);
  });

  it("never implies subdomains", () => {
    expect(isRemoteImageHostAllowlisted(["example.com"], "https://docs.example.com/a.png")).toBe(
      false,
    );
  });

  it("refuses unlisted, malformed, and non-http sources", () => {
    expect(
      isRemoteImageHostAllowlisted(["docs.example.com"], "https://attacker.example/a.png"),
    ).toBe(false);
    expect(isRemoteImageHostAllowlisted([], "https://docs.example.com/a.png")).toBe(false);
    expect(isRemoteImageHostAllowlisted(["docs.example.com"], "not a url")).toBe(false);
    expect(isRemoteImageHostAllowlisted(["docs.example.com"], "data:image/png;base64,AAAA")).toBe(
      false,
    );
    expect(isRemoteImageHostAllowlisted(["docs.example.com"], "javascript:alert(1)")).toBe(false);
  });
});
