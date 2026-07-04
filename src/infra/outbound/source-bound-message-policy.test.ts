import { describe, expect, it } from "vitest";
import {
  assertSourceBoundMessageText,
  SOURCE_BOUND_MESSAGE_MAX_UTF8_BYTES,
} from "./source-bound-message-policy.js";

describe("source-bound message text limits", () => {
  it.each([
    ["ASCII", "a".repeat(SOURCE_BOUND_MESSAGE_MAX_UTF8_BYTES)],
    ["multibyte", "é".repeat(SOURCE_BOUND_MESSAGE_MAX_UTF8_BYTES / 2)],
  ])("accepts exactly the UTF-8 byte limit for %s", (_label, message) => {
    expect(() => assertSourceBoundMessageText(message)).not.toThrow();
  });

  it.each([
    ["ASCII", "a".repeat(SOURCE_BOUND_MESSAGE_MAX_UTF8_BYTES + 1)],
    ["multibyte", "é".repeat(SOURCE_BOUND_MESSAGE_MAX_UTF8_BYTES / 2 + 1)],
    ["surrounding whitespace", ` ${"a".repeat(SOURCE_BOUND_MESSAGE_MAX_UTF8_BYTES)} `],
  ])("rejects text over the UTF-8 byte limit for %s", (_label, message) => {
    expect(() => assertSourceBoundMessageText(message)).toThrow(
      `message exceeds ${SOURCE_BOUND_MESSAGE_MAX_UTF8_BYTES} UTF-8 bytes`,
    );
  });
});
