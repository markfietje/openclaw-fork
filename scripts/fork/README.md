# fork/ — fork-owned scripts (zero upstream merge surface)

Everything in this directory is NEW relative to `openclaw/openclaw` upstream:
no file here can ever merge-conflict with an upstream pull. Fork fixes that
would otherwise require editing upstream-owned scripts live here as
wrappers/gates instead.

## package-mac-app-gated.sh

Wraps upstream's `scripts/package-mac-app.sh` (never edited). Upstream's
script defaults `SPARKLE_PUBLIC_ED_KEY` and `SPARKLE_FEED_URL` to **upstream's**
values; an app packaged from this fork with those defaults would verify
upstream's Ed25519 over an upstream zip via Sparkle's ordinary update UX —
silently replacing the fork binary (and every fork hardening in it) with an
upstream one.

The gate refuses to package a **diverged** tree (commits upstream does not
carry) unless a fork feed + key are explicitly set, and refuses even then if
the configured feed names upstream's appcast. A pure upstream checkout passes
through untouched — upstream's defaults are correct there.

```sh
# drill the decision without building:
scripts/fork/package-mac-app-gated.sh --gate-only

# package a fork build (exports flow through to upstream's script):
SPARKLE_FEED_URL="https://<fork-host>/appcast.xml" \
SPARKLE_PUBLIC_ED_KEY="<fork Ed25519 base64>" \
  scripts/fork/package-mac-app-gated.sh
```

Honest ceiling: invoking upstream's `scripts/package-mac-app.sh` _directly_
bypasses this gate — point every fork build path (CI, docs, muscle memory)
at the wrapper.

## install-cli-gated.sh

Wraps upstream's `scripts/install-cli.sh` (never edited). Upstream's
installer hardcodes `repo_url="https://github.com/openclaw/openclaw.git"`
and defaults to the upstream npm package — a fork operator following the
install docs gets a perfectly green install of UPSTREAM, with every fork
commit and hardening silently absent (register K4-12).

The gate: on a DIVERGED tree, an upstream-sourced install (npm default, or
the git path) REFUSES until the operator passes
`--allow-upstream-source`; a built `.tgz` (the fork's own artifact) passes;
a pure upstream checkout passes untouched. Ceiling, stated: invoking
upstream's installer DIRECTLY bypasses this gate — fork install docs must
point at the wrapper.

Drilled: `--gate-only` four arms (fork+default exit 1; allow-upstream exit
0; git exit 1 naming the hardcoded URL; tgz exit 0) + the upstream-checkout
pass-through.
