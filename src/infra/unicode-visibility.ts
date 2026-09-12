// Zero-width and bidi control characters used to conceal text or change its visual order.
// v1.28.65 "Meridian" (X-S1): widened to the Rust canonical set
// (brain-server `src/strip_invisible.rs` `is_invisible`) — adds the bidi
// isolates (U+2066–2069, previously skipped between the two adjacent ranges),
// ALM (U+061C), variation selectors (U+FE00–FE0F + U+E0100–E01EF), and the
// legacy/residual members (soft hyphen, combining grapheme joiner, Mongolian
// vowel separator, Hangul fillers, interlinear annotation).
//
// v1.28.83 "Recall" (S5-01, honest contract): this host set is a deliberate
// SUPERSET of the canonical fixture (`plugin/fixtures/invisible-classes.json`)
// — it additionally strips U+2064 + U+206A–206F (invisible format controls
// the server/plugin/client lanes keep). Extra stripping is invisible-chars
// only, so user-visible drift is nil by construction; the fixture lane pins
// the canonical SUBSET (every canonical class stripped here), never exact
// equality — host extras are documented here, not asserted there.
const INVISIBLE_UNICODE_RE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}\uFE00-\uFE0F\u061C\u00AD\u034F\u180E\u115F\u1160\uFFF9-\uFFFB]/gu;

export function stripInvisibleUnicode(text: string): string {
  return text.replace(INVISIBLE_UNICODE_RE, "");
}
