// P4-01 (fourth pass 2026-09-12): the four-tree invisible-set drift alarm,
// FORK-HOST lane. The fixture (extensions/brain-server/fixtures/
// invisible-classes.json, parity-synced from brain-server plugin/fixtures/) is
// the canonical Rust truth — the server lane proves it exhaustively against
// `is_invisible`, the plugin + client lanes probe it per codepoint, and THIS
// lane holds the host's `stripInvisibleUnicode` to it.
//
// HONEST CONTRACT: the host set is a deliberate SUPERSET of the Rust canonical
// set (it keeps the previously-covered extras U+2064 and U+206A–U+206F — see
// the INVISIBLE_UNICODE_RE comment). So this lane asserts SUBSET coverage:
// every canonical codepoint must be stripped; the host may strip more; the
// visible samples must survive. A canonical class regressing HERE (the exact
// drift the .65 Meridian fix had to close on the bidi isolates) fails this
// test before it ships.
import { describe, expect, test } from "vitest";
import fixture from "../../extensions/brain-server/fixtures/invisible-classes.json";
import { stripInvisibleUnicode } from "./unicode-visibility.js";

describe("invisible set fixture parity (fork host lane)", () => {
  test("stripInvisibleUnicode strips EVERY canonical fixture codepoint", () => {
    const expand = (hex: string): number => parseInt(hex, 16);
    let checked = 0;
    for (const cls of fixture.classes as Array<{ name: string; ranges: string[][] }>) {
      for (const [loHex, hiHex] of cls.ranges) {
        const lo = expand(loHex);
        const hi = expand(hiHex);
        for (let cp = lo; cp <= hi; cp++) {
          const ch = String.fromCodePoint(cp);
          expect(
            stripInvisibleUnicode(ch),
            `U+${cp.toString(16).toUpperCase()} (${cls.name}) must be stripped host-side`,
          ).toBe("");
          checked++;
        }
      }
    }
    // Anti-vacuity: the canonical population is a few hundred codepoints.
    expect(checked).toBeGreaterThan(300);
    for (const v of fixture["visible-samples"] as string[]) {
      expect(
        stripInvisibleUnicode(String.fromCodePoint(expand(v))),
        `U+${v} must survive host-side stripping`,
      ).toBe(String.fromCodePoint(expand(v)));
    }
  });
});
