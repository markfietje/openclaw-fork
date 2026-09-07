type MarkdownCodeBlockChrome = "copy" | "none";
type MarkdownCodeBlockInteraction = "interactive" | "static";
type MarkdownTableInteractions = "enabled" | "none";
type MarkdownRenderMode = "document" | "message";

export type MarkdownRenderOptions = {
  assistantTranscriptRoleHeaders?: boolean;
  codeBlockChrome?: MarkdownCodeBlockChrome;
  codeBlockInteraction?: MarkdownCodeBlockInteraction;
  fileLinks?: boolean;
  githubRepo?: { owner: string; repo: string } | null;
  interactiveImages?: boolean;
  linkFavicons?: boolean;
  progressBars?: boolean;
  mode?: MarkdownRenderMode;
  remoteImages?: boolean;
  remoteImageHosts?: string[];
  sessionLinks?: boolean;
  tableInteractions?: MarkdownTableInteractions;
};

export type MarkdownRenderEnv = Required<MarkdownRenderOptions> & {
  streamingOpenFence?: boolean;
};

export function normalizeMarkdownRenderOptions(
  options: MarkdownRenderOptions = {},
): MarkdownRenderEnv {
  return {
    assistantTranscriptRoleHeaders: options.assistantTranscriptRoleHeaders ?? false,
    codeBlockChrome: options.codeBlockChrome ?? "copy",
    codeBlockInteraction: options.codeBlockInteraction ?? "static",
    fileLinks: options.fileLinks ?? false,
    githubRepo: options.githubRepo ?? null,
    interactiveImages: options.interactiveImages ?? false,
    linkFavicons: options.linkFavicons ?? false,
    progressBars: options.progressBars ?? false,
    mode: options.mode ?? "message",
    // Remote images are OFF by default in every mode: fetching model-controlled
    // URLs is an exfiltration channel, so document renders opt in explicitly
    // and every fetched host must also be allowlisted (markdown-image-gate).
    remoteImages: options.remoteImages ?? false,
    remoteImageHosts: normalizeRemoteImageHosts(options.remoteImageHosts),
    sessionLinks: options.sessionLinks ?? false,
    tableInteractions: options.tableInteractions ?? "none",
  };
}

function normalizeRemoteImageHosts(hosts: string[] | undefined): string[] {
  const normalized: string[] = [];
  for (const host of hosts ?? []) {
    const trimmed = host.trim().toLowerCase().replace(/\.$/, "");
    if (trimmed !== "" && !normalized.includes(trimmed)) {
      normalized.push(trimmed);
    }
  }
  return normalized;
}
