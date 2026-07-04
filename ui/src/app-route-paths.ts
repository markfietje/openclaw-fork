import { APP_ROUTE_PATHS, type RouteId } from "./app-route-id.ts";
import { normalizeRouteBasePath, normalizeRoutePath } from "./router/matches.ts";

const ROUTE_IDS_BY_PATH = new Map<string, RouteId>([
  ...Object.entries(APP_ROUTE_PATHS).map(
    ([routeId, path]) => [normalizeRoutePath(path).toLowerCase(), routeId as RouteId] as const,
  ),
  ["/dreams", "dreams"],
]);

export function normalizeBasePath(basePath: string): string {
  return normalizeRouteBasePath(basePath);
}

export function normalizePath(path: string): string {
  return normalizeRoutePath(path);
}

export function pathForRoute(routeId: RouteId, basePath = ""): string {
  const base = normalizeBasePath(basePath);
  const path = APP_ROUTE_PATHS[routeId];
  return base ? `${base}${path}` : path;
}

export function routeIdFromPath(pathname: string, basePath = ""): RouteId | null {
  const base = normalizeBasePath(basePath);
  const path = normalizePath(pathname);
  if (base && path !== base && !path.startsWith(`${base}/`)) {
    return null;
  }
  const relativePath =
    path === base ? "/" : base && path.startsWith(`${base}/`) ? path.slice(base.length) : path;
  const normalized = relativePath.toLowerCase().endsWith("/index.html")
    ? normalizePath(relativePath.slice(0, -"/index.html".length))
    : normalizePath(relativePath);
  return normalized === "/" ? "chat" : (ROUTE_IDS_BY_PATH.get(normalized.toLowerCase()) ?? null);
}

export function inferBasePathFromPathname(pathname: string): string {
  const normalizedPath = normalizePath(pathname);
  const normalized = normalizedPath.toLowerCase().endsWith("/index.html")
    ? normalizePath(normalizedPath.slice(0, -"/index.html".length))
    : normalizedPath;
  if (normalized === "/") {
    return "";
  }
  const segments = normalized.split("/").filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    if (routeIdFromPath(`/${segments.slice(index).join("/")}`)) {
      return index ? `/${segments.slice(0, index).join("/")}` : "";
    }
  }
  return normalized;
}
