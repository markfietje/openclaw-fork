import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ControlUiBootstrapConfig } from "./control-ui-bootstrap-contract.js";

/** Normalizes operator-allowlisted image hosts: lowercased, no trailing dot, deduped. */
function normalizeRemoteImageHosts(hosts: string[]): string[] {
  const normalized: string[] = [];
  for (const host of hosts) {
    const trimmed = host.trim().toLowerCase().replace(/\.$/, "");
    if (trimmed !== "" && !normalized.includes(trimmed)) {
      normalized.push(trimmed);
    }
  }
  return normalized;
}

/** Public presentation settings of the Gateway serving the UI, never model permissions. */
export function resolveControlUiBootstrapPresentation(config: OpenClawConfig | undefined) {
  return {
    embedSandbox: config?.gateway?.controlUi?.embedSandbox ?? "scripts",
    allowExternalEmbedUrls: config?.gateway?.controlUi?.allowExternalEmbedUrls === true,
    // Shutter default: favicons fetch only when the operator enables them AND
    // curates remoteImageHosts; the empty list is the fail-safe posture.
    automaticallyFetchFavicons: config?.gateway?.controlUi?.automaticallyFetchFavicons === true,
    remoteImageHosts: normalizeRemoteImageHosts(
      config?.gateway?.controlUi?.remoteImageHosts ?? [],
    ),
    seamColor: config?.ui?.seamColor,
    environment: config?.gateway?.controlUi?.environment,
    chatBubblesEnabled: config?.gateway?.controlUi?.experimental?.chatBubbles === true,
    composerPredictionsEnabled:
      config?.gateway?.controlUi?.experimental?.composerPredictions?.enabled === true,
    communityInvite: config?.gateway?.controlUi?.communityInvite !== false,
    newSessionModelDefaults: config?.gateway?.controlUi?.newSessionModelDefaults ?? "last-used",
    uploadsEnabled: config?.gateway?.uploads?.enabled !== false,
  } satisfies Partial<ControlUiBootstrapConfig>;
}
