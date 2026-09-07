import type { HumanMention } from "@openclaw/gateway-protocol";
import type {
  MarkdownGitHubRepository,
  MarkdownGitHubRepositoryAliases,
} from "./markdown-github-repositories.ts";

export type MarkdownHumanMentionToken = { marker: string; profileId: string; label: string };

// Larger message-mode inputs use the literal-text fallback instead of Markdown parsing.
export const MARKDOWN_PARSE_LIMIT = 40_000;

type MarkdownCodeBlockChrome = "copy" | "none";
type MarkdownCodeBlockInteraction = "interactive" | "static";
type MarkdownTableInteractions = "enabled" | "none";
type MarkdownRenderMode = "document" | "message";

export type MarkdownRenderOptions = {
  assistantTranscriptRoleHeaders?: boolean;
  codeBlockChrome?: MarkdownCodeBlockChrome;
  codeBlockInteraction?: MarkdownCodeBlockInteraction;
  fileLinks?: boolean;
  githubRepo?: MarkdownGitHubRepository | null;
  githubRepositories?: readonly MarkdownGitHubRepositoryAliases[];
  humanMentions?: readonly HumanMention[];
  interactiveImages?: boolean;
  linkFavicons?: boolean;
  progressBars?: boolean;
  mode?: MarkdownRenderMode;
  remoteImages?: boolean;
  remoteImageHosts?: string[];
  sessionLinks?: boolean;
  tableInteractions?: MarkdownTableInteractions;
};

export type MarkdownGitHubContext = Pick<
  MarkdownRenderOptions,
  "githubRepo" | "githubRepositories"
>;

export type MarkdownRenderEnv = Required<MarkdownRenderOptions> & {
  streamingOpenFence?: boolean;
  humanMentionTokens?: readonly MarkdownHumanMentionToken[];
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
    humanMentions: options.humanMentions ?? [],
    githubRepositories: options.githubRepositories ?? [],
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
