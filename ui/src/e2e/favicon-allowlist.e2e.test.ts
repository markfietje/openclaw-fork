// Control UI tests pin the Shutter favicon posture: the fetcher stays silent
// unless the operator enables it AND allowlists the host; unlisted hosts fall
// back to the letter tile without any same-origin proxy request.
import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zb0YAAAAASUVORK5CYII=",
  "base64",
);
const LINK_MESSAGE = {
  content: [{ type: "text", text: "Read [the docs](https://docs.example.com/guide)." }],
  role: "assistant",
  timestamp: Date.now(),
};

suite.define(() => {
  it("makes zero favicon requests when fetching is not enabled", async () => {
    const context = await suite.newBrowserContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    let faviconRequests = 0;
    await page.route("**/__openclaw__/link-favicon/**", async (route) => {
      faviconRequests += 1;
      await route.abort();
    });
    await installMockGateway(page, { historyMessages: [LINK_MESSAGE] });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator('a[href="https://docs.example.com/guide"]').waitFor();
      await page.waitForTimeout(150);
      expect(faviconRequests).toBe(0);
      expect(await page.locator("img.markdown-link-favicon").count()).toBe(0);
      expect(await page.locator(".markdown-link-favicon-tile").count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("fetches allowlisted favicons through the authenticated same-origin route when enabled", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 600, width: 900 },
    });
    const page = await context.newPage();
    let faviconRequests = 0;
    await page.route("**/__openclaw__/link-favicon/docs.example.com", async (route) => {
      faviconRequests += 1;
      expect(route.request().headers()["authorization"]).toBe("Bearer e2e-device-token");
      await route.fulfill({ body: ONE_PIXEL_PNG, contentType: "image/png", status: 200 });
    });
    await installMockGateway(page, {
      automaticallyFetchFavicons: true,
      remoteImageHosts: ["docs.example.com"],
      historyMessages: [LINK_MESSAGE],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const icon = page.locator(
        'img.markdown-link-favicon[data-link-favicon-host="docs.example.com"]',
      );
      await expect.poll(() => icon.getAttribute("class")).toContain("is-loaded");
      expect(faviconRequests).toBe(1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("shows the letter tile and never fetches for unlisted hosts", async () => {
    const context = await suite.newBrowserContext({
      serviceWorkers: "block",
      viewport: { height: 600, width: 900 },
    });
    const page = await context.newPage();
    let faviconRequests = 0;
    await page.route("**/__openclaw__/link-favicon/**", async (route) => {
      faviconRequests += 1;
      await route.abort();
    });
    await installMockGateway(page, {
      automaticallyFetchFavicons: true,
      remoteImageHosts: ["other.example"],
      historyMessages: [LINK_MESSAGE],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const tile = page.locator(".markdown-link-favicon-tile");
      await expect.poll(() => tile.count()).toBe(1);
      await expect.poll(() => tile.textContent()).toBe("D");
      await page.waitForTimeout(150);
      expect(faviconRequests).toBe(0);
      expect(await page.locator("img.markdown-link-favicon").count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
