import {
  isProviderDispatchObservableStreamFn,
  markProviderDispatchObservableStreamFn,
  preserveProviderDispatchObservableStreamFn,
  resolveProviderDispatchCostMultiplierForStreamFn as resolveProviderDispatchCostMultiplierForStreamFnBase,
  resolveProviderDispatchModelForStreamFn as resolveProviderDispatchModelForStreamFnBase,
  resolveProviderDispatchReservationCostMultiplierForStreamFn as resolveProviderDispatchReservationCostMultiplierForStreamFnBase,
} from "../../packages/llm-core/src/provider-dispatch-observable-stream.js";
import { getApiProvider } from "../llm/api-registry.js";
import { streamSimple } from "../llm/stream.js";
import type { Model } from "../llm/types.js";
import type { StreamFn } from "./runtime/index.js";

function isProviderRegistryDispatchObservable(model: Model): boolean {
  return isProviderDispatchObservableStreamFn(getApiProvider(model.api)?.streamSimple as StreamFn);
}

export function isModelProviderDispatchObservableStreamFn(params: {
  streamFn: StreamFn | undefined;
  model: Model;
}): boolean {
  if (isProviderDispatchObservableStreamFn(params.streamFn)) {
    return true;
  }
  return params.streamFn === streamSimple && isProviderRegistryDispatchObservable(params.model);
}

export function markModelProviderDispatchObservableStreamFn<T extends StreamFn>(streamFn: T): T {
  return markProviderDispatchObservableStreamFn(streamFn);
}

export function preserveModelProviderDispatchObservableStreamFn<T extends StreamFn>(params: {
  wrapped: T;
  source: StreamFn | undefined;
  model: Model;
}): T {
  const source = resolveDispatchResolverStreamFn({
    streamFn: params.source,
    model: params.model,
  });
  const preserved = preserveProviderDispatchObservableStreamFn(params.wrapped, source);
  return isModelProviderDispatchObservableStreamFn({ streamFn: params.source, model: params.model })
    ? markProviderDispatchObservableStreamFn(preserved)
    : preserved;
}

function resolveRegisteredProviderStreamFn(model: Model): StreamFn | undefined {
  return getApiProvider(model.api)?.streamSimple as StreamFn | undefined;
}

function resolveDispatchResolverStreamFn(params: {
  streamFn: StreamFn | undefined;
  model: Model;
}): StreamFn | undefined {
  return params.streamFn === streamSimple
    ? resolveRegisteredProviderStreamFn(params.model)
    : params.streamFn;
}

export function resolveProviderDispatchModelForStreamFn(params: {
  streamFn: StreamFn | undefined;
  model: Model;
  context: Parameters<StreamFn>[1];
  options: Parameters<StreamFn>[2];
}): Model {
  return resolveProviderDispatchModelForStreamFnBase({
    ...params,
    streamFn: resolveDispatchResolverStreamFn(params),
  });
}

export function resolveProviderDispatchCostMultiplierForStreamFn(params: {
  streamFn: StreamFn | undefined;
  model: Model;
  context: Parameters<StreamFn>[1];
  options: Parameters<StreamFn>[2];
}): number {
  return resolveProviderDispatchCostMultiplierForStreamFnBase({
    ...params,
    streamFn: resolveDispatchResolverStreamFn(params),
  });
}

export function resolveProviderDispatchReservationCostMultiplierForStreamFn(params: {
  streamFn: StreamFn | undefined;
  model: Model;
  context: Parameters<StreamFn>[1];
  options: Parameters<StreamFn>[2];
}): number | undefined {
  return resolveProviderDispatchReservationCostMultiplierForStreamFnBase({
    ...params,
    streamFn: resolveDispatchResolverStreamFn(params),
  });
}
