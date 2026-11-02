import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubText, scrubValue, HIDDEN } from "./scrub";

test("exact secret values are removed in plain, URL-encoded and base64 form", () => {
  const secret = "s3cr3t/value+with=chars";
  const text = `plain ${secret} url ${encodeURIComponent(secret)} b64 ${btoa(secret)}`;
  const out = scrubText(text, [secret]);
  assert.ok(!out.includes(secret));
  assert.ok(!out.includes(encodeURIComponent(secret)));
  assert.ok(!out.includes(btoa(secret)));
  assert.equal(out.split(HIDDEN).length - 1, 3);
});

test("well-known token formats are removed even if the value is unknown", () => {
  const cases = [
    "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
    "github_pat_" + "11ABCDEFG0abcdefghijklmnop",
    "xoxb-123456789012-abcdefghijkl",
    "AKIAIOSFODNN7EXAMPLE",
    "Bearer abcdefghijklmnopqrstuvwxyz012345",
  ];
  for (const c of cases) assert.ok(!scrubText(`token: ${c} end`, []).includes(c.slice(8)), c);
});

test("long random strings are hidden but git SHAs and normal prose are kept", () => {
  const random = "qZ8vK2mXw9RtL4pYb7NcHd3SfGj6UaEoVi1TxBn0MkWz5";
  assert.ok(!scrubText(`value ${random}`, []).includes(random));
  const sha = "3f786850e387550fdab836ed7e6dc881de23001b";
  assert.ok(scrubText(`commit ${sha}`, []).includes(sha));
  const prose = "The deploy finished in 3 minutes and health checks passed.";
  assert.equal(scrubText(prose, []), prose);
});

test("short secrets are not used as search terms", () => {
  assert.equal(scrubText("a b c abc", ["abc"]), "a b c abc");
});

test("scrubValue cleans nested JSON", () => {
  const out = scrubValue({ a: { b: ["token=hunter2hunter2"] } }, ["hunter2hunter2"]);
  assert.deepEqual(out, { a: { b: [`token=${HIDDEN}`] } });
});
