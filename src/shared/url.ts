/** Appends a path while preserving any path prefix already present on the base URL. */
export function appendUrlPath(baseUrl: string | URL, path: string): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  url.pathname = `${basePath}${suffix}`;
  return url;
}
