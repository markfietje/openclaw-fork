import { wrapExternalContent } from "../../security/external-content.js";
import type { AgentToolResult } from "../../../packages/agent-core/src/types.js";

export function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function jsonResult<TDetails>(payload: TDetails): AgentToolResult<TDetails> {
  return textResult(JSON.stringify(payload, null, 2), payload);
}

/**
 * ponytail: single shared wrapper for untrusted tool outputs (exec/file/pdf/transcript).
 * Skips already-wrapped text to avoid double envelopes. One runnable check lives in tool-results.test.ts.
 */
export function wrapUntrustedToolText(text: string, source: "unknown" = "unknown"): string {
  if (text.includes("EXTERNAL_UNTRUSTED_CONTENT")) {
    return text;
  }
  return wrapExternalContent(text, { source, includeWarning: false });
}
