// Provider-dispatch observability marks stream functions that honor StreamOptions.onProviderDispatch.
import type { StreamFn } from "./types.js";

const providerDispatchObservableStreamFns = new WeakSet<StreamFn>();
export type ProviderDispatchModelResolver = (params: {
  model: Parameters<StreamFn>[0];
  context: Parameters<StreamFn>[1];
  options: Parameters<StreamFn>[2];
}) => Parameters<StreamFn>[0] | undefined;
export type ProviderDispatchCostMultiplierResolver = (params: {
  model: Parameters<StreamFn>[0];
  context: Parameters<StreamFn>[1];
  options: Parameters<StreamFn>[2];
}) => number | undefined;
export type ProviderDispatchReservationCostMultiplierResolver =
  ProviderDispatchCostMultiplierResolver;
const providerDispatchModelResolvers = new WeakMap<StreamFn, ProviderDispatchModelResolver>();
const providerDispatchCostMultiplierResolvers = new WeakMap<
  StreamFn,
  ProviderDispatchCostMultiplierResolver
>();
const providerDispatchReservationCostMultiplierResolvers = new WeakMap<
  StreamFn,
  ProviderDispatchReservationCostMultiplierResolver
>();

export function markProviderDispatchObservableStreamFn<T extends StreamFn>(streamFn: T): T {
  providerDispatchObservableStreamFns.add(streamFn);
  return streamFn;
}

export function isProviderDispatchObservableStreamFn(streamFn: StreamFn | undefined): boolean {
  return Boolean(streamFn && providerDispatchObservableStreamFns.has(streamFn));
}

export function preserveProviderDispatchObservableStreamFn<T extends StreamFn>(
  wrapped: T,
  source: StreamFn | undefined,
): T {
  const sourceResolver = source ? providerDispatchModelResolvers.get(source) : undefined;
  if (sourceResolver && !providerDispatchModelResolvers.has(wrapped)) {
    providerDispatchModelResolvers.set(wrapped, sourceResolver);
  }
  const sourceCostMultiplierResolver = source
    ? providerDispatchCostMultiplierResolvers.get(source)
    : undefined;
  if (sourceCostMultiplierResolver && !providerDispatchCostMultiplierResolvers.has(wrapped)) {
    providerDispatchCostMultiplierResolvers.set(wrapped, sourceCostMultiplierResolver);
  }
  const sourceReservationCostMultiplierResolver = source
    ? providerDispatchReservationCostMultiplierResolvers.get(source)
    : undefined;
  if (
    sourceReservationCostMultiplierResolver &&
    !providerDispatchReservationCostMultiplierResolvers.has(wrapped)
  ) {
    providerDispatchReservationCostMultiplierResolvers.set(
      wrapped,
      sourceReservationCostMultiplierResolver,
    );
  }
  return isProviderDispatchObservableStreamFn(source)
    ? markProviderDispatchObservableStreamFn(wrapped)
    : wrapped;
}

export function markProviderDispatchModelResolverStreamFn<T extends StreamFn>(
  streamFn: T,
  resolver: ProviderDispatchModelResolver,
): T {
  providerDispatchModelResolvers.set(streamFn, resolver);
  return streamFn;
}

export function markProviderDispatchCostMultiplierResolverStreamFn<T extends StreamFn>(
  streamFn: T,
  resolver: ProviderDispatchCostMultiplierResolver,
): T {
  providerDispatchCostMultiplierResolvers.set(streamFn, resolver);
  return streamFn;
}

export function markProviderDispatchReservationCostMultiplierResolverStreamFn<T extends StreamFn>(
  streamFn: T,
  resolver: ProviderDispatchReservationCostMultiplierResolver,
): T {
  providerDispatchReservationCostMultiplierResolvers.set(streamFn, resolver);
  return streamFn;
}

export function resolveProviderDispatchModelForStreamFn(params: {
  streamFn: StreamFn | undefined;
  model: Parameters<StreamFn>[0];
  context: Parameters<StreamFn>[1];
  options: Parameters<StreamFn>[2];
}): Parameters<StreamFn>[0] {
  const resolver = params.streamFn
    ? providerDispatchModelResolvers.get(params.streamFn)
    : undefined;
  return (
    resolver?.({
      model: params.model,
      context: params.context,
      options: params.options,
    }) ?? params.model
  );
}

export function resolveProviderDispatchCostMultiplierForStreamFn(params: {
  streamFn: StreamFn | undefined;
  model: Parameters<StreamFn>[0];
  context: Parameters<StreamFn>[1];
  options: Parameters<StreamFn>[2];
}): number {
  const resolver = params.streamFn
    ? providerDispatchCostMultiplierResolvers.get(params.streamFn)
    : undefined;
  const multiplier =
    resolver?.({
      model: params.model,
      context: params.context,
      options: params.options,
    }) ?? 1;
  return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
}

export function resolveProviderDispatchReservationCostMultiplierForStreamFn(params: {
  streamFn: StreamFn | undefined;
  model: Parameters<StreamFn>[0];
  context: Parameters<StreamFn>[1];
  options: Parameters<StreamFn>[2];
}): number | undefined {
  const resolver = params.streamFn
    ? providerDispatchReservationCostMultiplierResolvers.get(params.streamFn)
    : undefined;
  const multiplier = resolver
    ? resolver({
        model: params.model,
        context: params.context,
        options: params.options,
      })
    : resolveProviderDispatchCostMultiplierForStreamFn(params);
  return typeof multiplier === "number" && Number.isFinite(multiplier) && multiplier > 0
    ? multiplier
    : undefined;
}
