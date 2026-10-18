import assert from "node:assert/strict";
import { test } from "node:test";
import { outline, requestTerms } from "./lib/outline.ts";

test("request terms drop short words and stopwords and strip suffixes", () => {
  assert.deepEqual(requestTerms("the proration test fails because of rounding"), ["proration", "round"]);
});

test("outline keeps shallow lines and lines near a term, collapses the rest", () => {
  const src = ["/**", " * Billing.", " */", "import x from 'y';", "export function a() {", "  const p = 1;", "  const q = 2;",
    "  return Math.round(p);", "}", "export function b() {", "  const hidden = 1;", "  return hidden;", "}"].join("\n");
  const out = outline(src, ["round"], { context: 1 });
  assert.equal(out, ["/**", " * Billing.", " */", "import x from 'y';", "export function a() {", "…", "  const q = 2;",
    "  return Math.round(p);", "}", "export function b() {", "…", "}"].join("\n"));
  assert.doesNotMatch(outline(src, []), /hidden/);
  assert.match(outline(src, [], { maxDepth: 1 }), /hidden/);
});
