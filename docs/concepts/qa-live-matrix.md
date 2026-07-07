---
summary: "Maintainer reference for Matrix live QA through the canonical QA Lab scenario host and transport adapter."
read_when:
  - Running pnpm openclaw qa matrix locally
  - Adding or selecting Matrix QA scenarios
  - Triaging Matrix QA lifecycle or scenario failures
title: "QA Lab Matrix"
---

QA Lab runs the bundled `@openclaw/matrix` plugin against a disposable Tuwunel homeserver in Docker. The Matrix transport adapter provisions temporary driver, SUT, and observer accounts, starts the gateway, and exposes the same lifecycle contract used by the shared QA Lab scenario host.

Maintainer-only tooling. Packaged OpenClaw releases omit `qa-lab`, so `openclaw qa` only runs from a source checkout.

For broader QA framework context, see [QA overview](/concepts/qa-e2e-automation).

## Quick start

The focused selector is a thin QA Lab-owned delegate:

```bash
pnpm openclaw qa matrix \
  --profile release \
  --provider-mode mock-openai \
  --model mock-openai/gpt-5.5 \
  --alt-model mock-openai/gpt-5.5-alt \
  --fast
```

It resolves the selected profile to canonical QA Lab scenario ids, then invokes the same suite host as:

```bash
pnpm openclaw qa suite \
  --channel-driver live \
  --channel matrix \
  --scenario channel-chat-baseline \
  --scenario matrix-allowlist-hot-reload \
  --provider-mode mock-openai \
  --model mock-openai/gpt-5.5 \
  --alt-model mock-openai/gpt-5.5-alt \
  --fast
```

There is no separate Matrix runner, scenario catalog, artifact format, or compatibility fallback.

## Profiles

| Profile     | Scenarios                                                                                                               | Use                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `release`   | `channel-chat-baseline`, `matrix-allowlist-hot-reload`                                                                  | Release-critical focused proof       |
| `fast`      | Same as `release`                                                                                                       | Short local or CI proof              |
| `transport` | Release scenarios plus `matrix-restart-resume`, `matrix-restart-replay-dedupe`, and `matrix-post-restart-room-continue` | Full maintained Matrix scenario set  |
| `all`       | Same as `transport`                                                                                                     | Default comprehensive Matrix profile |

Repeat `--scenario <id>` to bypass profile selection and run only named canonical QA Lab scenarios.

## CLI flags

`pnpm openclaw qa matrix` uses the shared QA Lab live-transport CLI surface:

- `--profile <profile>`: select `all`, `fast`, `release`, or `transport`; default `all`.
- `--scenario <id>`: run a named scenario; repeatable and takes precedence over the profile.
- `--provider-mode <mode>`: choose the QA Lab provider mode.
- `--model <ref>` and `--alt-model <ref>`: select primary and alternate models.
- `--fast`: enable provider fast mode where supported.
- `--allow-failures`: write evidence without returning a failing exit code for scenario failures.
- `--output-dir <path>`: choose the QA Lab artifact directory.
- `--repo-root <path>`: target a source checkout from another working directory.
- `--sut-account <id>`: choose the temporary Matrix account id in the gateway config.

The disposable Matrix homeserver does not use credential leases or credential roles.

## Lifecycle ownership

`live:matrix` is registered through QA Lab's transport registry. Its channel-driver lifecycle owns Tuwunel provisioning and teardown through the Matrix adapter, while the QA Lab suite host owns scenario selection, execution, retries, failure semantics, and evidence generation.

The focused lifecycle test exercises provision, start, scenario execution, restart, evidence collection, and cleanup for both the live Matrix adapter and the Crabline Matrix adapter.

## Output artifacts

The selector writes the standard QA Lab suite artifacts to `--output-dir`:

- `qa-suite-report.md`: human-readable scenario and step results.
- `qa-suite-summary.json`: structured suite status and timing data.
- `qa-evidence.json`: normalized QA evidence consumed by CI and release checks.

Matrix transport logs and lifecycle evidence referenced by the suite are stored beneath the same run directory. The lane does not maintain a second Matrix-specific report or summary format.

## Workflow use

`QA-Lab - All Lanes` and `OpenClaw Release Checks` call the focused selector through the reusable QA Live workflow. Scheduled and release gates use `--profile release`; manual dispatch can select `all`, `fast`, `release`, or `transport` without creating a separate execution path.

## Related

- [QA overview](/concepts/qa-e2e-automation): overall QA stack and live transport contract
- [QA Channel](/channels/qa-channel): synthetic channel adapter for repo-backed scenarios
- [Testing](/help/testing): running tests and adding QA coverage
- [Matrix](/channels/matrix): the channel plugin under test
