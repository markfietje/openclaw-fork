/**
 * v1.28.65 "Meridian" (X-S1): the host-side content-hygiene layer applied to
 * every plugin-supplied prompt-context segment at the ONE merge seam
 * (`mergeBeforePromptBuild` — the convergence point both the embedded and CLI
 * runners ride).
 *
 * What it does (the cheap structural layer — NOT a taint lattice, NOT
 * per-plugin origin classification; X-S2 origin labels land with the Origin
 * line):
 *   1. `stripInvisibleUnicode` — the unicode-smuggling class (U+E0000 tag
 *      block, bidi overrides/isolates, zero-width set, variation selectors)
 *      dies at the merge point;
 *   2. the host's own context markers are NEUTRALIZED (split with ZWSP,
 *      mirroring `neutralizeMarkdownFences` in auto-reply): a plugin segment
 *      can no longer emit the literal `⟦openclaw:ctx⟧` provenance marker or
 *      the built-in active-memory fence tags, so a forged marker cannot borrow
 *      the host's provenance and a plugin cannot close the built-in's fence to
 *      inherit its trust. Splitting the built-in's own emitted tags too is
 *      deliberate and uniform (no per-plugin logic): the model reads the
 *      rendered text identically (ZWSP is invisible), while no literal tag can
 *      re-form from any plugin-supplied text.
 *
 * Well-fenced plugins are NOT re-fenced: the brain plugin's
 * `=== BRAIN_UNTRUSTED_CONTEXT BEGIN/END ===` sentinels pass through untouched
 * (stripping invisible chars inside them is semantics-preserving — the plugin
 * strips the same class itself before rendering).
 */
import { INBOUND_CONTEXT_MARKER } from "../auto-reply/reply/inbound-context-marker.js";
import { stripInvisibleUnicode } from "../infra/unicode-visibility.js";

const ZWSP = "\u200b";
// The built-in active-memory fence tags. No core canonical export exists (the
// extension owns the emission); keep in sync with extensions/active-memory and
// the strip-inbound-meta metadata constants.
const ACTIVE_MEMORY_OPEN_TAG = "<active_memory_plugin>";
const ACTIVE_MEMORY_CLOSE_TAG = "</active_memory_plugin>";

/**
 * Splits every literal occurrence with a ZWSP so the exact literal can never
 * re-form from sanitized text (visually identical; mechanically unmatchable).
 */
function splitLiteral(text: string, literal: string): string {
  const cut = Math.floor(literal.length / 2);
  return text.split(literal).join(`${literal.slice(0, cut)}${ZWSP}${literal.slice(cut)}`);
}

export function sanitizePluginContextSegment(text: string): string {
  // Strip FIRST (removes any ZWSP a previous pass inserted — the split forms
  // below re-insert it), then neutralize the host-owned literals. The order
  // makes the function idempotent under the merge's repeated re-sanitization
  // of the joined accumulator, and kills cross-segment synthesis because the
  // merge sanitizes the JOINED text, not each plugin's slice.
  let out = stripInvisibleUnicode(text);
  out = splitLiteral(out, INBOUND_CONTEXT_MARKER);
  out = splitLiteral(out, ACTIVE_MEMORY_OPEN_TAG);
  return splitLiteral(out, ACTIVE_MEMORY_CLOSE_TAG);
}

/** Merge-seam adapter: undefined passes through (no context = no segment). */
export function sanitizePluginContext(text: string | undefined): string | undefined {
  return text === undefined ? undefined : sanitizePluginContextSegment(text);
}
