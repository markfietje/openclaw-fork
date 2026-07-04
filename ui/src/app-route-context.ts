import type { RouteId } from "./app-route-id.ts";

export type AppNavigate = (
  routeId: RouteId,
  options?: { history?: "push" | "replace" | "none" },
) => void;

export type RouteRenderContext<TState> = {
  state: TState;
  navigate: AppNavigate;
};
