---
summary: "MCP catalog pins: rug-pull drift blocking and acknowledgment"
read_when:
  - You are approving MCP tools and want drift to stay blocked until re-approved
  - A run was blocked by catalog drift and you need to acknowledge it
  - You are setting or unsetting BRAIN_MCP_PINS_ACK
title: "MCP catalog pins"
---

# MCP catalog pins

Every MCP tool is fingerprinted per run (name + description + schema). A tool
whose fingerprint moves after approval (the rug pull) is hard-blocked until
re-acknowledged; brand-new tools stay usable-but-flagged (`pendingAck`).

To acknowledge the current catalog for one run:

```sh
BRAIN_MCP_PINS_ACK=1  # one run only, then UNSET it
```

The ACK is one-shot per process: a stale second use logs `pins_ack_stale`
and diffs normally, so a forgotten env var can never silence drift.

Pins live beside the agent bundle (`mcp-catalog-pins.json` + `.sig` + key).
Deleting the pins file while `.sig`/key survive is a loud error; deleting all
three warns once and falls back to flagged-but-usable (the documented
ceiling). Keep the pins dir operator-only (group/world-writable warns).

Ceiling: the ack signature proves ack-path authorship (TOFU keypair), not
operator identity — guard the agent dir like config.
