import type { AppNavigate, RouteRenderContext } from "./app-route-context.ts";
import type { RouteId } from "./app-route-id.ts";
import { normalizePath, pathForRoute, routeIdFromPath } from "./app-route-paths.ts";
import type { SettingsAppHost, SettingsHost } from "./app/app-host.ts";
import type { RouterOutletSnapshotStore } from "./app/router-outlet.ts";
import { page as activityPage } from "./pages/activity/route.ts";
import { page as agentsPage } from "./pages/agents/route.ts";
import { page as channelsPage } from "./pages/channels/route.ts";
import { page as chatPage } from "./pages/chat/route.ts";
import { pages as configPages } from "./pages/config/route.ts";
import { page as cronPage } from "./pages/cron/route.ts";
import { page as debugPage } from "./pages/debug/route.ts";
import { page as dreamsPage } from "./pages/dreams/route.ts";
import { page as instancesPage } from "./pages/instances/route.ts";
import { page as logsPage } from "./pages/logs/route.ts";
import { page as nodesPage } from "./pages/nodes/route.ts";
import { page as overviewPage } from "./pages/overview/route.ts";
import { page as sessionsPage } from "./pages/sessions/route.ts";
import { page as skillWorkshopPage } from "./pages/skill-workshop/route.ts";
import { page as skillsPage } from "./pages/skills/route.ts";
import { page as usagePage } from "./pages/usage/route.ts";
import { page as workboardPage } from "./pages/workboard/route.ts";
// Application route catalog consumed by the generic router.
import { createRouter } from "./router/index.ts";
import type { PageDefinition } from "./router/index.ts";
import type { RouteLocation, RouterHistory } from "./router/index.ts";
import type { AppViewState } from "./ui/app-view-state.ts";

export type RouteLoadContext = {
  host: SettingsHost;
  app: SettingsAppHost;
};

type ApplicationHost = SettingsHost & {
  activeRouteId: RouteId | null;
  navDrawerOpen: boolean;
  sessionKey: string;
  setChatMobileControlsOpen: (
    open: boolean,
    options?: { trigger?: HTMLElement | null; restoreFocus?: boolean },
  ) => void;
};

export type ApplicationContext = {
  routeLoadContext: RouteLoadContext;
  routeSnapshot: RouterOutletSnapshotStore<RouteId, AppRouteModule>;
  navigate: AppNavigate;
  notifyStateChange: (state: AppViewState, changed: ReadonlyMap<PropertyKey, unknown>) => void;
  dispose: () => void;
};

export function routeLoadContext(host: SettingsHost): RouteLoadContext {
  return { host, app: host as SettingsAppHost };
}

export type AppRouteModule = {
  render: (context: RouteRenderContext<AppViewState>, data: unknown) => unknown;
  onStateChange?: (
    context: RouteRenderContext<AppViewState>,
    changed: ReadonlyMap<PropertyKey, unknown>,
  ) => void;
  shell?: "chat" | "page";
  header?: boolean;
  contentClass?: string;
};

export const APP_ROUTE_TREE = [
  agentsPage,
  activityPage,
  overviewPage,
  workboardPage,
  channelsPage,
  instancesPage,
  sessionsPage,
  usagePage,
  cronPage,
  skillsPage,
  skillWorkshopPage,
  nodesPage,
  chatPage,
  ...configPages,
  dreamsPage,
  debugPage,
  logsPage,
] as const;

const appRoutes = APP_ROUTE_TREE as readonly PageDefinition<
  RouteId,
  RouteLoadContext,
  AppRouteModule
>[];

export const appRouter = createRouter<RouteId, RouteLoadContext, AppRouteModule>({
  routes: appRoutes,
});

export function createApplicationContext(
  host: SettingsHost,
  routeSnapshot: RouterOutletSnapshotStore<RouteId, AppRouteModule>,
): ApplicationContext {
  const applicationHost = host as ApplicationHost;
  const loadContext = routeLoadContext(host);
  const syncVisibleRoute = () => {
    const selection = routeSnapshot.get();
    applicationHost.activeRouteId = (selection.pending ?? selection.active)?.routeId ?? null;
  };
  syncVisibleRoute();
  const stopRouteSync = routeSnapshot.subscribe(syncVisibleRoute);
  const navigate: AppNavigate = (next, options) => {
    const location = {
      pathname: pathForRoute(next, host.basePath),
      search:
        next === "chat" && applicationHost.sessionKey
          ? `?session=${encodeURIComponent(applicationHost.sessionKey)}`
          : "",
      hash: "",
    };
    const currentLocation = appRouter.getState().location;
    const sameLocation =
      currentLocation.pathname === location.pathname &&
      currentLocation.search === location.search &&
      currentLocation.hash === location.hash;
    void appRouter
      .navigate(
        next,
        loadContext,
        { history: options?.history ?? (sameLocation ? "none" : "push") },
        location,
      )
      .catch(() => undefined);
    if (next !== "chat") {
      applicationHost.setChatMobileControlsOpen(false);
    }
    applicationHost.navDrawerOpen = false;
  };
  return {
    routeLoadContext: loadContext,
    routeSnapshot,
    navigate,
    notifyStateChange: (state, changed) => {
      const active = routeSnapshot.get().active?.module;
      if (active && "onStateChange" in active && typeof active.onStateChange === "function") {
        active.onStateChange({ state, navigate }, changed);
      }
    },
    dispose: () => {
      stopRouteSync();
      routeSnapshot.dispose();
    },
  };
}

export function getVisibleRouteId(): RouteId | null {
  const state = appRouter.getState();
  return state.pendingMatches[0]?.routeId ?? state.matches[0]?.routeId ?? null;
}

export function resolveAppNotFound(context: RouteLoadContext): Promise<void> {
  return appRouter.navigate("chat", context, { history: "replace" });
}

export function startAppRouter(
  history: RouterHistory,
  basePath: string,
  context: RouteLoadContext,
  onLocation?: (location: RouteLocation) => void,
): Promise<void> {
  const resolveLocation = (location: RouteLocation): RouteLocation => {
    const isBasePath = normalizePath(location.pathname) === normalizePath(basePath);
    if (!isBasePath && routeIdFromPath(location.pathname, basePath) !== null) {
      return location;
    }
    const fallback = {
      ...location,
      pathname: pathForRoute("chat", basePath),
    };
    history.replace(fallback);
    return fallback;
  };
  const initialLocation = resolveLocation(history.location());
  onLocation?.(initialLocation);
  const appHistory: RouterHistory = {
    location: () => initialLocation,
    push: history.push,
    replace: history.replace,
    listen: (listener) =>
      history.listen((location) => {
        const resolvedLocation = resolveLocation(location);
        onLocation?.(resolvedLocation);
        listener(resolvedLocation);
      }),
  };
  return appRouter.start(appHistory, basePath, context);
}
