// Control UI tests cover full-document markdown behavior.
import { describe, expect, it } from "vitest";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

function htmlFragment(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

describe("document markdown", () => {
  it("preserves allowlisted remote images while defaulting to fallbacks", () => {
    const allowlisted = htmlFragment(
      toSanitizedMarkdownHtml("![Alt text](https://example.com/img.png)", {
        mode: "document",
        remoteImages: true,
        remoteImageHosts: ["example.com"],
      }),
    );
    const unlisted = htmlFragment(
      toSanitizedMarkdownHtml("![Alt text](https://attacker.example/img.png)", {
        mode: "document",
        remoteImages: true,
      }),
    );
    const unsafe = htmlFragment(
      toSanitizedMarkdownHtml("![Alt text](javascript:alert(1))", { mode: "document" }),
    );

    expect(allowlisted.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/img.png",
    );
    // Fail-safe posture: an explicit opt-in with no curated hosts still
    // renders the fallback instead of any fetchable image.
    expect(unlisted.querySelector("img")).toBeNull();
    expect(unlisted.querySelector(".markdown-external-image")).not.toBeNull();
    expect(unsafe.querySelector("img")).toBeNull();
    const clickToOpen = htmlFragment(
      toSanitizedMarkdownHtml("![Alt text](https://example.com/img.png)", {
        mode: "document",
        remoteImages: false,
      }),
    );
    expect(clickToOpen.querySelector("img")).toBeNull();
    expect(clickToOpen.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/img.png",
    );
  });

  it("parses complete documents above message limits", () => {
    const input = `# Start\n\n${"x".repeat(140_000)}\n\n## End`;
    const fragment = htmlFragment(toSanitizedMarkdownHtml(input, { mode: "document" }));

    expect(fragment.querySelector("h1")?.textContent).toBe("Start");
    expect(fragment.querySelector("h2")?.textContent).toBe("End");
    expect(fragment.textContent).not.toContain("truncated");
  });
});
