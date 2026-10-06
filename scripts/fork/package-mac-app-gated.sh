#!/usr/bin/env bash
# package-mac-app-gated.sh — the fork's Sparkle gate (zero-conflict by design).
#
# WHY THIS EXISTS: upstream's scripts/package-mac-app.sh defaults
# SPARKLE_PUBLIC_ED_KEY and SPARKLE_FEED_URL to UPSTREAM's values. A Mac app
# packaged from THIS fork with those defaults carries upstream's Ed25519 key
# and upstream's appcast — so Sparkle's normal update UX silently replaces
# the fork's binary with an upstream one, deleting every fork hardening
# behind a perfectly ordinary "an update is available" click.
#
# WHY A WRAPPER: this file is FORK-OWNED and new; upstream's script is never
# edited, so no future upstream change can merge-conflict with this fix.
# The gate only decides whether the defaults are safe to inherit, then
# execs the real packager verbatim.
#
# THE LAW: a DIVERGED tree (commits upstream does not carry) may only be
# packaged with an explicitly configured fork feed + key. A pure upstream
# checkout inherits upstream's defaults untouched — that is correct there.
#
# Usage: scripts/fork/package-mac-app-gated.sh [--gate-only] [--upstream-ref REF]
#        [package-mac-app.sh args...]
#   --gate-only      evaluate the gate, print the decision, exit — no build.
#   --upstream-ref   override the ref divergence is measured against (tests).
# Env: SPARKLE_FEED_URL / SPARKLE_PUBLIC_ED_KEY — same vars upstream reads;
#      setting them here flows straight through to the real script.
set -euo pipefail

GATE_ONLY=0
UPSTREAM_REF="upstream/main"
while [[ $# -gt 0 ]]; do
	case "$1" in
		--gate-only) GATE_ONLY=1; shift ;;
		--upstream-ref) UPSTREAM_REF="${2:?--upstream-ref needs a value}"; shift 2 ;;
		--) shift; break ;;
		*) break ;;
	esac
done

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
REAL="$ROOT_DIR/scripts/package-mac-app.sh"
[[ -f "$REAL" ]] || { echo "gate: $REAL missing" >&2; exit 2; }

UPSTREAM_APPCAST="https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml"

# Is this tree diverged from upstream? No upstream remote at all is treated
# as a fork too (conservative: the only tree with nothing to measure against
# is one that has already left upstream).
DIVERGED=1
if git -C "$ROOT_DIR" rev-parse --verify -q "$UPSTREAM_REF^{commit}" >/dev/null; then
	AHEAD="$(git -C "$ROOT_DIR" rev-list --count "$UPSTREAM_REF..HEAD" 2>/dev/null || echo 1)"
	[[ "$AHEAD" -eq 0 ]] && DIVERGED=0
fi

if [[ "$DIVERGED" -eq 0 ]]; then
	echo "gate: tree matches $UPSTREAM_REF — upstream Sparkle defaults are correct here"
elif [[ -n "${SPARKLE_FEED_URL:-}" && -n "${SPARKLE_PUBLIC_ED_KEY:-}" ]]; then
	if [[ "$SPARKLE_FEED_URL" == "$UPSTREAM_APPCAST" ]]; then
		echo "gate: REFUSING — SPARKLE_FEED_URL is set but names UPSTREAM's appcast." >&2
		echo "       A fork build updating from upstream's feed replaces itself with" >&2
		echo "       upstream binaries. Point it at the fork's own feed." >&2
		exit 1
	fi
	echo "gate: diverged tree with an explicit fork feed — passing Sparkle config through"
else
	echo "gate: REFUSING to package a diverged tree without a fork Sparkle config." >&2
	echo "  This tree carries commits upstream does not have, but SPARKLE_FEED_URL /" >&2
	echo "  SPARKLE_PUBLIC_ED_KEY are unset — upstream's script would embed UPSTREAM's" >&2
	echo "  feed + key, and the built app would auto-update itself back to upstream" >&2
	echo "  binaries, silently deleting every fork hardening." >&2
	echo "  Fix: set SPARKLE_FEED_URL (the fork's own appcast) and SPARKLE_PUBLIC_ED_KEY" >&2
	echo "       (the fork's own Ed25519 key), or package a clean upstream checkout." >&2
	exit 1
fi

if [[ "$GATE_ONLY" -eq 1 ]]; then
	echo "gate: decision made (--gate-only); not invoking the packager"
	exit 0
fi

exec "$REAL" "$@"
