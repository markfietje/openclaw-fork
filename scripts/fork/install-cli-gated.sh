#!/usr/bin/env bash
# install-cli-gated.sh — the fork's install-source gate (zero-conflict).
#
# WHY THIS EXISTS: upstream's scripts/install-cli.sh hardcodes
# repo_url="https://github.com/openclaw/openclaw.git" (its git-install path)
# and defaults to the upstream npm package. A fork operator following the
# install docs therefore installs UPSTREAM — every fork commit and every
# fork hardening silently absent, with a perfectly green install.
#
# WHY A WRAPPER: this file is FORK-OWNED and new; upstream's installer is
# never edited, so no future upstream change can merge-conflict with this
# fix. The gate only decides whether the install SOURCE is safe to inherit,
# then execs the real installer verbatim.
#
# THE LAW: a DIVERGED tree may not be installed from an upstream source
# (npm registry default, or the git path's hardcoded upstream URL) without
# the operator's explicit --allow-upstream-source. A pure upstream checkout
# passes through untouched — upstream's installer is correct there.
#
# Usage: scripts/fork/install-cli-gated.sh [--gate-only] [--allow-upstream-source]
#        [--upstream-ref REF] [install-cli.sh args...]
#   --gate-only               evaluate the gate, print the decision, exit.
#   --allow-upstream-source   the loud opt-in: install upstream anyway.
#   --upstream-ref            override the ref divergence is measured against.
set -euo pipefail

GATE_ONLY=0
ALLOW_UPSTREAM=0
UPSTREAM_REF="upstream/main"
while [[ $# -gt 0 ]]; do
	case "$1" in
		--gate-only) GATE_ONLY=1; shift ;;
		--allow-upstream-source) ALLOW_UPSTREAM=1; shift ;;
		--upstream-ref) UPSTREAM_REF="${2:?--upstream-ref needs a value}"; shift 2 ;;
		--) shift; break ;;
		*) break ;;
	esac
done
REMAINING_ARGS=("$@")

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
REAL="$ROOT_DIR/scripts/install-cli.sh"
[[ -f "$REAL" ]] || { echo "gate: $REAL missing" >&2; exit 2; }

# Is this tree diverged from upstream? No upstream remote at all is treated
# as a fork too (conservative — the only tree with nothing to measure
# against is one that has already left upstream).
DIVERGED=1
if git -C "$ROOT_DIR" rev-parse --verify -q "$UPSTREAM_REF^{commit}" >/dev/null; then
	AHEAD="$(git -C "$ROOT_DIR" rev-list --count "$UPSTREAM_REF..HEAD" 2>/dev/null || echo 1)"
	[[ "$AHEAD" -eq 0 ]] && DIVERGED=0
fi

if [[ "$DIVERGED" -eq 0 ]]; then
	echo "gate: tree matches $UPSTREAM_REF — upstream's installer is correct here"
	[[ "$GATE_ONLY" -eq 1 ]] && exit 0
	exec bash "$REAL" "${REMAINING_ARGS[@]}"
fi

if [[ "$ALLOW_UPSTREAM" -eq 1 ]]; then
	echo "gate: ALLOW-UPSTREAM acknowledged — installing upstream over a diverged fork" >&2
	echo "      (every fork commit is absent from what this installs)" >&2
	[[ "$GATE_ONLY" -eq 1 ]] && exit 0
	exec bash "$REAL" "${REMAINING_ARGS[@]}"
fi

# What would the real installer source? The git path names upstream's URL
# directly; the npm default resolves upstream's registry package. A built
# .tgz the operator hands it is the fork's OWN artifact — allowed through.
SOURCE_KIND="npm-registry (upstream package)"
for arg in "${REMAINING_ARGS[@]:-}"; do
	case "$arg" in
		--install-method=git|--install-method\ git|git)
			SOURCE_KIND="git (upstream repo_url, hardcoded at scripts/install-cli.sh:1123)" ;;
		--install-method=tgz*|*.tgz)
			SOURCE_KIND="tgz (operator-built package — allowed)" ;;
	esac
done

if [[ "$SOURCE_KIND" == tgz* ]]; then
	echo "gate: tgz source is the operator's own artifact — allowed through"
	[[ "$GATE_ONLY" -eq 1 ]] && exit 0
	exec bash "$REAL" "${REMAINING_ARGS[@]}"
fi

echo "gate: REFUSING — a DIVERGED fork cannot be installed from: $SOURCE_KIND" >&2
echo "       The install would be perfectly green and silently discard every" >&2
echo "       fork commit and hardening (register K4-12)." >&2
echo "       Remedies: build the fork package and install that (.tgz), or" >&2
echo "       re-run with --allow-upstream-source to acknowledge upstream." >&2
exit 1
