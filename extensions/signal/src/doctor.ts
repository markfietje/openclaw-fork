// Signal doctor resolves ambiguous shipped auto-mode endpoints once and persists a concrete kind.
import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import { normalizeCompatibilityConfig } from "../doctor-contract-api.js";
import {
  hasPendingLegacySignalTransportDetection,
  migrateLegacySignalTransportConfig,
} from "./config-compat.js";
import { detectSignalTransport } from "./setup-transport.js";

export const signalDoctor: ChannelDoctorAdapter = {
  normalizeCompatibilityConfig,
  collectPreviewWarnings: ({ cfg, doctorFixCommand }) =>
    hasPendingLegacySignalTransportDetection(cfg)
      ? [
          `- channels.signal: legacy auto transport needs a reachable daemon before it can be migrated; start the configured endpoint, then run ${doctorFixCommand}.`,
        ]
      : [],
  cleanStaleConfig: async ({ cfg }) =>
    await migrateLegacySignalTransportConfig({ cfg, detect: detectSignalTransport }),
};
