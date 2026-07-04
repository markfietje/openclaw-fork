import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_ROUTE_PATHS } from "./app-route-id.ts";
import {
  APP_ROUTE_TREE,
  appRouter,
  createApplicationContext,
  startAppRouter,
  type RouteLoadContext,
} from "./app-routes.ts";
import type { RouterOutletSnapshotStore } from "./app/router-outlet.ts";
import type { RouteLocation, RouterHistory } from "./router/index.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

it("keeps route definitions aligned with the leaf path contract", () => {
  expect(Object.fromEntries(APP_ROUTE_TREE.map((route) => [route.id, route.path]))).toEqual(
    APP_ROUTE_PATHS,
  );
});

describe("startAppRouter", () => {
  it("publishes the initial location before its route starts loading", async () => {
    const initialLocation: RouteLocation = {
      pathname: "/chat",
      search: "?session=agent%3Asupport%3Amain",
      hash: "",
    };
    const history: RouterHistory = {
      location: () => initialLocation,
      push: vi.fn(),
      replace: vi.fn(),
      listen: vi.fn(() => vi.fn()),
    };
    const onLocation = vi.fn();
    vi.spyOn(appRouter, "start").mockImplementation(async (resolvedHistory) => {
      expect(onLocation).toHaveBeenCalledWith(initialLocation);
      expect(resolvedHistory.location()).toEqual(initialLocation);
    });

    await startAppRouter(history, "", {} as RouteLoadContext, onLocation);

    expect(onLocation).toHaveBeenCalledOnce();
  });

  it.each([
    { basePath: "", pathname: "/", expected: "/chat" },
    { basePath: "/ui", pathname: "/ui", expected: "/ui/chat" },
  ])("redirects $pathname to the routed chat path", async ({ basePath, pathname, expected }) => {
    const initialLocation: RouteLocation = { pathname, search: "", hash: "" };
    const replace = vi.fn();
    const history: RouterHistory = {
      location: () => initialLocation,
      push: vi.fn(),
      replace,
      listen: vi.fn(() => vi.fn()),
    };
    vi.spyOn(appRouter, "start").mockImplementation(async (resolvedHistory) => {
      expect(resolvedHistory.location().pathname).toBe(expected);
    });

    await startAppRouter(history, basePath, {} as RouteLoadContext);

    expect(replace).toHaveBeenCalledWith({ pathname: expected, search: "", hash: "" });
  });
});

describe("createApplicationContext", () => {
  it("carries the visible route onto the application state", () => {
    let visibleRouteId: "sessions" | null = null;
    let notifyRouteChange: () => void = () => undefined;
    const routeSnapshot = {
      get: () => ({
        status: "success" as const,
        active: visibleRouteId ? ({ routeId: visibleRouteId } as never) : undefined,
        pending: undefined,
        showPending: false,
      }),
      subscribe: (listener: () => void) => {
        notifyRouteChange = listener;
        return vi.fn();
      },
      dispose: vi.fn(),
    } as unknown as RouterOutletSnapshotStore;
    const host = {
      activeRouteId: null,
      basePath: "",
      navDrawerOpen: false,
      sessionKey: "agent:main:main",
      setChatMobileControlsOpen: vi.fn(),
    };
    const application = createApplicationContext(host as never, routeSnapshot as never);

    visibleRouteId = "sessions";
    notifyRouteChange();

    expect(host.activeRouteId).toBe("sessions");
    application.dispose();
  });
});
