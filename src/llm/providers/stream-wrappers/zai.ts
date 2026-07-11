// Z.ai stream wrapper normalizes Z.ai provider stream chunks.
import { preserveProviderDispatchObservableStreamFn } from "../../../../packages/llm-core/src/provider-dispatch-observable-stream.js";
import type { StreamFn } from "../../../agents/runtime/index.js";
import { streamSimple } from "../../stream.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

/**
 * Inject `tool_stream=true` so tool-call deltas stream in real time.
 * Providers can disable this by setting `params.tool_stream=false`.
 *
 * @deprecated Provider-owned stream helper; do not use from third-party plugins.
 */
export function createToolStreamWrapper(
  baseStreamFn: StreamFn | undefined,
  enabled: boolean,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  const wrapped: StreamFn = (model, context, options) => {
    if (!enabled) {
      return underlying(model, context, options);
    }

    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      payloadObj.tool_stream = true;
    });
  };
  return preserveProviderDispatchObservableStreamFn(wrapped, underlying);
}

/** @deprecated Z.ai provider-owned stream helper; do not use from third-party plugins. */
export const createZaiToolStreamWrapper = createToolStreamWrapper;
