// Control UI tests pin the Shutter posture: document-mode renders of
// model-controlled markdown fetch remote images only for operator-allowlisted
// hosts, and never by default.
import { expect, it } from "vitest";
import {
  captureUiProof,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zb0YAAAAASUVORK5CYII=",
  "base64",
);
const POISONED_MARKDOWN = [
  "Incident notes with a poisoned image reference:",
  "",
  "![](https://attacker.example/x.png)",
  "",
  "Reference: https://attacker.example/canary",
].join("\n");

async function expandPoisonedAssistantMessage(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof suite.newBrowserContext>>["newPage"]>>,
  options: { remoteImageHosts?: string[] },
) {
  const attackerRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://attacker.example")) {
      attackerRequests.push(request.url());
    }
  });
  await page.route("https://attacker.example/**", async (route) => {
    await route.fulfill({ body: ONE_PIXEL_PNG, contentType: "image/png", status: 200 });
  });
  const gateway = await installMockGateway(page, {
    deferredMethods: ["chat.message.get"],
    ...(options.remoteImageHosts ? { remoteImageHosts: options.remoteImageHosts } : {}),
    historyMessages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "[chat.history omitted: message too large]" }],
        timestamp: Date.now(),
        __openclaw: {
          id: "assistant-poisoned-doc",
          seq: 1,
          truncated: true,
          reason: "oversized",
        },
      },
    ],
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  const bubble = page.locator('.chat-bubble[data-entry-id="assistant-poisoned-doc"]');
  await bubble.waitFor();
  await gateway.waitForRequest("chat.message.get");
  await gateway.resolveDeferred("chat.message.get", {
    ok: true,
    message: { role: "assistant", content: POISONED_MARKDOWN },
  });
  await expect.poll(() => bubble.locator(".chat-text").textContent()).toContain("Incident notes");
  return { bubble, attackerRequests };
}

suite.define(() => {
  it("fetches nothing for a document-mode render of model-controlled markdown by default", async () => {
    const context = await suite.newBrowserContext({
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    try {
      const { bubble, attackerRequests } = await expandPoisonedAssistantMessage(page, {});
      await expect.poll(() => bubble.locator("img.markdown-inline-image").count()).toBe(0);
      await expect
        .poll(() => bubble.locator(".markdown-external-image").count())
        .toBeGreaterThan(0);
      await expect.poll(() => attackerRequests.length, { timeout: 2_000 }).toBe(0);
      // The bare canary URL stays inert prose: rendered as a link, never fetched.
      await expect
        .poll(() => bubble.locator('a[href="https://attacker.example/canary"]').count())
        .toBe(1);
      expect(attackerRequests).toEqual([]);
      await captureUiProof(
        suite,
        page,
        "remote-images",
        "doc-render-untrusted-host-fetches-nothing.png",
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("loads allowlisted hosts after explicit opt-in via trusted image hosts", async () => {
    const context = await suite.newBrowserContext({
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    try {
      const { bubble, attackerRequests } = await expandPoisonedAssistantMessage(page, {
        remoteImageHosts: ["attacker.example"],
      });
      await expect.poll(() => bubble.locator("img.markdown-inline-image").count()).toBe(1);
      await expect.poll(() => attackerRequests.length).toBeGreaterThanOrEqual(1);
      await captureUiProof(suite, page, "remote-images", "doc-render-allowlisted-host-loads.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("never fetches unlisted hosts even when trusted image hosts are configured", async () => {
    const context = await suite.newBrowserContext({
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    try {
      const { bubble, attackerRequests } = await expandPoisonedAssistantMessage(page, {
        remoteImageHosts: ["docs.example.com"],
      });
      await expect.poll(() => bubble.locator("img.markdown-inline-image").count()).toBe(0);
      await expect
        .poll(() => bubble.locator(".markdown-external-image").count())
        .toBeGreaterThan(0);
      await expect.poll(() => attackerRequests.length, { timeout: 2_000 }).toBe(0);
      expect(attackerRequests).toEqual([]);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps message-mode fallback behavior unchanged", async () => {
    const context = await suite.newBrowserContext({
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    try {
      const attackerRequests: string[] = [];
      page.on("request", (request) => {
        if (request.url().startsWith("https://attacker.example")) {
          attackerRequests.push(request.url());
        }
      });
      await page.route("https://attacker.example/**", async (route) => {
        await route.fulfill({ body: ONE_PIXEL_PNG, contentType: "image/png", status: 200 });
      });
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "See ![](https://attacker.example/x.png) here." }],
            timestamp: Date.now(),
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const bubble = page.locator(".chat-bubble").filter({ hasText: "See" }).first();
      await bubble.waitFor();
      await expect.poll(() => bubble.locator("img.markdown-inline-image").count()).toBe(0);
      await expect
        .poll(() => bubble.locator(".markdown-external-image").count())
        .toBeGreaterThan(0);
      await expect.poll(() => attackerRequests.length, { timeout: 2_000 }).toBe(0);
      expect(attackerRequests).toEqual([]);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
