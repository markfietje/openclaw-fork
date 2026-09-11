import { describe, expect, it } from "vitest";
import { wrapUntrustedToolText } from "./tool-results.js";

describe("wrapUntrustedToolText", () => {
  it("envelopes raw output once and never double-wraps", () => {
    const once = wrapUntrustedToolText("hello");
    expect(once).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(wrapUntrustedToolText(once)).toBe(once);
  });

  it("strips markdown images and tag-smuggling in the envelope", () => {
    const out = wrapUntrustedToolText("see ![x](https://evil.example/a.png?k=1) and \u{E0041}hi");
    expect(out).toContain("[Image omitted]");
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("\u{E0041}");
  });
});
