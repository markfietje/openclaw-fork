// Shared types for OpenClaw claw manifests and read-only plans.

export const CLAW_SCHEMA_VERSION = "openclaw.claw.v1" as const;
export const CLAW_PLAN_SCHEMA_VERSION = "openclaw.clawPlan.v1" as const;
export const CLAW_FEED_SCHEMA_VERSION = "openclaw.clawFeed.v1" as const;

export type ClawSchemaVersion = typeof CLAW_SCHEMA_VERSION;
export type ClawPlanSchemaVersion = typeof CLAW_PLAN_SCHEMA_VERSION;
export type ClawFeedSchemaVersion = typeof CLAW_FEED_SCHEMA_VERSION;

export type ClawDiagnosticLevel = "error" | "warning";

export type ClawDiagnostic = {
  level: ClawDiagnosticLevel;
  code: string;
  path: string;
  message: string;
};

export type ClawEntryKind =
  | "skill"
  | "plugin"
  | "mcpServer"
  | "connector"
  | "workspaceFile"
  | "persona"
  | "heartbeat"
  | "schedule"
  | "automation";

export type ClawEntryBase = {
  kind: ClawEntryKind;
  id: string;
  required?: boolean;
  description?: string;
};

export type ClawPackageEntry = ClawEntryBase & {
  kind: "skill" | "plugin" | "mcpServer" | "connector";
  selector: string;
};

export type ClawFileEntry = ClawEntryBase & {
  kind: "workspaceFile" | "persona";
  path: string;
  source: string;
};

export type ClawAutomationEntry = ClawEntryBase & {
  kind: "heartbeat" | "schedule" | "automation";
  source: string;
  enableDefault?: boolean;
};

export type ClawEntry = ClawPackageEntry | ClawFileEntry | ClawAutomationEntry;

export type ClawUnknownEntry = {
  kind: string;
  id?: string;
  required?: boolean;
  description?: string;
};

export type ClawFeedOwner = {
  type: "publisher" | "clawhub" | "local";
  id: string;
};

export type ClawFeedTrustLevel = "unknown" | "source" | "verified";

export type ClawFeedEntry = {
  id: string;
  name: string;
  version: string;
  source: string;
  publisher?: string;
  description?: string;
  owner?: ClawFeedOwner;
  trust?: {
    level: ClawFeedTrustLevel;
  };
};

export type ClawFeed = {
  schemaVersion: ClawFeedSchemaVersion;
  id: string;
  name: string;
  publisher?: string;
  description?: string;
  generatedAt?: string;
  entries: ClawFeedEntry[];
};

export type ClawFeedReadResult =
  | {
      ok: true;
      feed: ClawFeed;
      diagnostics: ClawDiagnostic[];
    }
  | {
      ok: false;
      diagnostics: ClawDiagnostic[];
    };

export type ClawFeedManifestReadResult =
  | {
      ok: true;
      feed: ClawFeed;
      entry: ClawFeedEntry;
      manifest: ClawManifest;
      manifestPath: string;
      diagnostics: ClawDiagnostic[];
    }
  | {
      ok: false;
      diagnostics: ClawDiagnostic[];
    };

export type ClawManifest = {
  schemaVersion: ClawSchemaVersion;
  id: string;
  name: string;
  version: string;
  publisher?: string;
  description?: string;
  compatibility?: {
    minHostVersion?: string;
    surfaces?: string[];
  };
  update?: {
    mode?: "pinned" | "latest";
  };
  entries: ClawEntry[];
  optionalUnknownEntries: ClawUnknownEntry[];
};

export type ClawReadResult =
  | {
      ok: true;
      manifest: ClawManifest;
      diagnostics: ClawDiagnostic[];
    }
  | {
      ok: false;
      diagnostics: ClawDiagnostic[];
    };

export type ClawPlanEntryDecision =
  | "inspectOnly"
  | "requiresConsent"
  | "blockedUnsupported";

export type ClawPlanEntry = {
  id: string;
  kind: ClawEntryKind | string;
  required: boolean;
  decision: ClawPlanEntryDecision;
  target?: string;
  source?: string;
  reason: string;
};

export type ClawPlan = {
  schemaVersion: ClawPlanSchemaVersion;
  readOnly: true;
  claw: {
    id: string;
    name: string;
    version: string;
    sourcePath?: string;
  };
  summary: {
    totalEntries: number;
    requiredEntries: number;
    optionalEntries: number;
    requiresConsent: number;
    unsupportedOptionalEntries: number;
  };
  entries: ClawPlanEntry[];
  diagnostics: ClawDiagnostic[];
};
