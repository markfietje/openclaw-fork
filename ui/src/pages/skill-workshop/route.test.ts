import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSkillWorkshopProposals } from "../../ui/controllers/skill-workshop.ts";
import { page } from "./route.ts";

vi.mock("../../ui/controllers/skill-workshop.ts", () => ({
  loadSkillWorkshopProposals: vi.fn(),
}));

vi.mock("./page.ts", () => ({
  renderSkillWorkshopPage: vi.fn(() => undefined),
}));

describe("skill workshop route", () => {
  beforeEach(() => {
    vi.mocked(loadSkillWorkshopProposals).mockReset();
    vi.mocked(loadSkillWorkshopProposals).mockResolvedValue();
  });

  it("forces proposal refreshes when the route loads", async () => {
    const app = {};

    await page.loader?.({ app } as never, {} as never);

    expect(loadSkillWorkshopProposals).toHaveBeenCalledWith(app, { force: true });
  });

  it("refreshes proposals when the active session changes", async () => {
    const module = await page.component();
    const state = { sessionKey: "agent:main:main", assistantAgentId: "main" };
    const context = { state, navigate: vi.fn() } as unknown as Parameters<typeof module.render>[0];

    module.render(context);
    state.sessionKey = "agent:support:main";
    module.onStateChange?.(context, new Map([["sessionKey", "agent:main:main"]]));

    expect(loadSkillWorkshopProposals).toHaveBeenCalledWith(state, { force: true });
  });
});
