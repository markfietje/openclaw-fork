// Control UI route identifiers and paths stay independent from the route catalog.
export const APP_ROUTE_PATHS = {
  agents: "/agents",
  activity: "/activity",
  overview: "/overview",
  workboard: "/workboard",
  channels: "/channels",
  instances: "/instances",
  sessions: "/sessions",
  usage: "/usage",
  cron: "/cron",
  skills: "/skills",
  "skill-workshop": "/skills/workshop",
  nodes: "/nodes",
  chat: "/chat",
  config: "/config",
  communications: "/communications",
  appearance: "/appearance",
  automation: "/automation",
  mcp: "/mcp",
  infrastructure: "/infrastructure",
  "ai-agents": "/ai-agents",
  dreams: "/dreaming",
  debug: "/debug",
  logs: "/logs",
} as const;

export type RouteId = keyof typeof APP_ROUTE_PATHS;
