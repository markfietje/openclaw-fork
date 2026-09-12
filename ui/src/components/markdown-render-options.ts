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
  sessionLinks?: boolean;
  tableInteractions?: MarkdownTableInteractions;
  /** Fork addition — kept at the end of the type to reduce merge conflicts
   * with upstream edits to this shared block. */
  remoteImageHosts?: string[];
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
    sessionLinks: options.sessionLinks ?? false,
    tableInteractions: options.tableInteractions ?? "none",
    // Fork addition — kept at the end to mirror the type order above.
    remoteImageHosts: normalizeRemoteImageHosts(options.remoteImageHosts),
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
