import { describe, expect, it } from "vitest";
import { appendUrlPath } from "./url.js";

describe("appendUrlPath", () => {
  it("preserves base path prefixes and URL state", () => {
    expect(
      appendUrlPath("https://example.com/proxy/?mode=1#section", "/v1/models").toString(),
    ).toBe("https://example.com/proxy/v1/models?mode=1#section");
  });

  it("normalizes the path boundary without changing path contents", () => {
    expect(appendUrlPath("https://example.com/proxy///", "v1/models").toString()).toBe(
      "https://example.com/proxy/v1/models",
    );
  });
});
