import { describe, expect, it } from "vitest";
import { normalizeMarkdownRenderOptions } from "./markdown-render-options.ts";

describe("markdown render options normalization", () => {
  it("defaults remote images off in every mode", () => {
    expect(normalizeMarkdownRenderOptions().remoteImages).toBe(false);
    expect(normalizeMarkdownRenderOptions({ mode: "document" }).remoteImages).toBe(false);
    expect(normalizeMarkdownRenderOptions({ mode: "message" }).remoteImages).toBe(false);
  });

  it("keeps an explicit remote-image opt-in", () => {
    expect(normalizeMarkdownRenderOptions({ remoteImages: true }).remoteImages).toBe(true);
    expect(
      normalizeMarkdownRenderOptions({ mode: "document", remoteImages: true }).remoteImages,
    ).toBe(true);
  });

  it("defaults the trusted host list to empty", () => {
    expect(normalizeMarkdownRenderOptions().remoteImageHosts).toEqual([]);
    expect(normalizeMarkdownRenderOptions({ mode: "document" }).remoteImageHosts).toEqual([]);
  });

  it("normalizes trusted hosts case, whitespace, and trailing dots; dedupes", () => {
    expect(
      normalizeMarkdownRenderOptions({
        remoteImageHosts: [" Docs.Example.com. ", "docs.example.com", "", "OTHER.example"],
      }).remoteImageHosts,
    ).toEqual(["docs.example.com", "other.example"]);
  });
});
