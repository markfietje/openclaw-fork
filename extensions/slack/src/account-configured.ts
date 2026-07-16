// Slack helper module supports account configured behavior.
import { hasConfiguredAccountValue } from "openclaw/plugin-sdk/account-resolution";
import type { ResolvedSlackAccount } from "./accounts.js";

export function isSlackPluginAccountConfigured(account: ResolvedSlackAccount): boolean {
  const mode = account.config.mode ?? "socket";
  const hasActiveIdentity =
    account.config.identityMode === "user"
      ? account.config.userTokenReadOnly === false && Boolean(account.userToken?.trim())
      : Boolean(account.botToken?.trim());
  if (!hasActiveIdentity || (account.config.identityMode === "user" && mode === "relay")) {
    return false;
  }
  if (mode === "http") {
    return (
      hasConfiguredAccountValue(account.config.signingSecret) &&
      (account.config.identityMode !== "user" || Boolean(account.appToken?.trim()))
    );
  }
  if (mode === "relay") {
    const relay = account.config.relay;
    return (
      hasConfiguredAccountValue(relay?.url) &&
      hasConfiguredAccountValue(relay?.authToken) &&
      hasConfiguredAccountValue(relay?.gatewayId)
    );
  }
  return Boolean(account.appToken?.trim());
}
