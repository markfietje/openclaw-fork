// Verifies PDF tool factory output is included in OpenClaw tool registration.
import { describe, expect, it } from "vitest";
import { collectPresentOpenClawTools } from "./openclaw-tools.registration.js";
import { createPdfTool } from "./tools/pdf-tool.js";

describe("createOpenClawTools PDF registration", () => {
  it("includes the pdf tool when the pdf factory returns a tool", () => {
    const pdfTool = createPdfTool({
      agentDir: "/tmp/openclaw-agent-main",
      config: {
        agents: {
          defaults: {
            pdfModel: { primary: "openai/gpt-5.4-mini" },
          },
        },
      },
    });

    expect(pdfTool?.name).toBe("pdf");
    expect(collectPresentOpenClawTools([pdfTool]).map((tool) => tool.name)).toEqual(["pdf"]);
  });

  it("fails closed before model-backed PDF analysis when usage budgets are active", async () => {
    const pdfTool = createPdfTool({
      agentDir: "/tmp/openclaw-agent-main",
      deferAutoModelResolution: true,
      usageBudgetUnsupportedReason: "Budgeted agents cannot use this tool.",
    });

    const result = await pdfTool?.execute("call-1", { pdf: "/tmp/report.pdf" });

    expect(result?.content?.[0]).toEqual({
      type: "text",
      text: "Budgeted agents cannot use this tool.",
    });
    expect(result?.details).toEqual({
      error: "usage_budget_unsupported_model_tool",
      tool: "pdf",
    });
  });
});
