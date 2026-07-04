import type { RouteRenderContext } from "../../app-route-context.ts";
import type { SettingsAppHost, SettingsHost } from "../../app/app-host.ts";
import { hasOperatorAdminAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { definePage } from "../../router/index.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { switchChatSession } from "../../ui/chat-session-switch.ts";
import { loadAgents } from "../../ui/controllers/agents.ts";
import { loadConfig } from "../../ui/controllers/config.ts";
import { loadSessions } from "../../ui/controllers/sessions.ts";
import {
  loadWorkboard,
  stopWorkboardLifecycleRefresh,
  stopWorkboardPolling,
} from "../../ui/controllers/workboard.ts";
import { isPluginEnabledInConfigSnapshot } from "../../ui/plugin-activation.ts";

type WorkboardRenderContext = RouteRenderContext<AppViewState>;
type WorkboardLoadContext = { host: SettingsHost; app: SettingsAppHost };

export const page = definePage({
  id: "workboard",
  path: "/workboard",
  loader: ({ host, app }: WorkboardLoadContext) => {
    const requestUpdate = () => host.requestUpdate?.();
    return Promise.all([
      loadConfig(app),
      loadSessions(app),
      loadAgents(app),
      loadWorkboard({
        host,
        client: app.client,
        force: true,
        requestUpdate,
        refreshDiagnostics: hasOperatorWriteAccess(app.hello?.auth ?? null),
      }),
    ]).then(() => undefined);
  },
  onLeave: ({ host }: WorkboardLoadContext) => {
    stopWorkboardPolling(host);
    stopWorkboardLifecycleRefresh(host);
  },
  component: () =>
    import("../../ui/views/workboard.ts").then((module) => ({
      contentClass: "content--workboard",
      render: ({ state, navigate }: WorkboardRenderContext) => {
        const requestUpdate = () => state.requestUpdate?.();
        const auth =
          (state.hello as { auth?: { role?: string; scopes?: string[] } } | null)?.auth ?? null;
        return module.renderWorkboard({
          host: state,
          client: state.client,
          connected: state.connected,
          canWrite: hasOperatorWriteAccess(auth),
          canModelOverride: hasOperatorAdminAccess(auth),
          pluginEnabled: state.configSnapshot
            ? isPluginEnabledInConfigSnapshot(state.configSnapshot, "workboard", {
                enabledByDefault: false,
              })
            : null,
          pluginEnablementError:
            !state.configSnapshot && !state.configLoading ? state.lastError : null,
          agentsList: state.agentsList,
          sessions: state.sessionsResult?.sessions ?? [],
          onOpenSession: (sessionKey) => {
            switchChatSession(state, sessionKey);
            navigate("chat");
          },
          onReloadConfig: () => void loadConfig(state, { discardPendingChanges: true }),
          onRequestUpdate: requestUpdate,
        });
      },
    })),
});
