import { loadConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { resolveGatewayConnectionAuth } from "../gateway/connection-auth.js";
import { isLoopbackHost } from "../gateway/net.js";
import { normalizeStringifiedOptionalString } from "../shared/string-coerce.js";

export type DirectLoopbackGatewayAuthOpts = {
  url?: string;
  token?: string;
  password?: string;
  config?: OpenClawConfig;
};

async function isConfiguredSharedGatewayToken(params: {
  token: string | undefined;
  config?: OpenClawConfig;
}): Promise<boolean> {
  if (!params.token) {
    return false;
  }
  const config = params.config ?? loadConfigForDirectAuthProbe();
  const auth = resolveGatewayAuth({
    authConfig: config?.gateway?.auth,
    tailscaleMode: config?.gateway?.tailscale?.mode,
    env: process.env,
  });
  if (auth.mode !== "token") {
    return false;
  }
  if (auth.token === params.token) {
    return true;
  }
  if (!config) {
    return false;
  }
  try {
    const credentials = await resolveGatewayConnectionAuth({
      config,
      env: process.env,
    });
    return credentials.token === params.token;
  } catch {
    return false;
  }
}

function loadConfigForDirectAuthProbe(): OpenClawConfig | undefined {
  try {
    return loadConfig({ skipPluginValidation: true, pin: false });
  } catch {
    return undefined;
  }
}

export async function shouldUseDirectLoopbackGatewayAuth(
  opts: DirectLoopbackGatewayAuthOpts,
): Promise<boolean> {
  const token = normalizeStringifiedOptionalString(opts.token);
  const password = normalizeStringifiedOptionalString(opts.password);
  if (!token && !password) {
    return false;
  }
  const explicitUrl = normalizeStringifiedOptionalString(opts.url);
  const gatewayUrl = explicitUrl ?? buildGatewayConnectionDetails({ config: opts.config }).url;
  try {
    if (!isLoopbackHost(new URL(gatewayUrl).hostname)) {
      return false;
    }
  } catch {
    return false;
  }
  return Boolean(
    password || (await isConfiguredSharedGatewayToken({ token, config: opts.config })),
  );
}
