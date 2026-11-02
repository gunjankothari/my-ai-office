import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Vault } from "./vault";
import { CredentialBroker } from "./broker";
import { tmp } from "../test/helpers";

const key = () => randomBytes(32);

test("secrets are encrypted on disk, file is owner-only, values are not in the file", () => {
  const f = join(tmp(), "vault.json");
  const v = new Vault(f, key());
  v.put("mobile", "github", "super-secret-value-123");
  assert.ok(!readFileSync(f, "utf8").includes("super-secret-value-123"));
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(v.has("mobile", "github"), true);
  assert.deepEqual(v.handles("mobile"), ["github"]);
});

test("a project cannot read another project's secret", () => {
  const v = new Vault(join(tmp(), "vault.json"), key());
  v.put("mobile", "github", "mobile-token-aaaaaa");
  v.put("site", "github", "site-token-bbbbbb");
  assert.equal(v.readSecret("mobile", "github"), "mobile-token-aaaaaa");
  assert.equal(v.readSecret("site", "github"), "site-token-bbbbbb");
  assert.equal(v.readSecret("pipeline", "github"), undefined);
});

test("moving ciphertext between handles or projects fails to decrypt", () => {
  const f = join(tmp(), "vault.json");
  const k = key();
  const v = new Vault(f, k);
  v.put("mobile", "a", "value-a-111111");
  v.put("mobile", "b", "value-b-222222");
  v.put("site", "a", "value-a-333333");
  const data = JSON.parse(readFileSync(f, "utf8"));
  data.projects.mobile.entries.b = data.projects.mobile.entries.a; // swap handle
  data.projects.site.entries.a = data.projects.mobile.entries.a; // move project (different key too)
  writeFileSync(f, JSON.stringify(data));
  const tampered = new Vault(f, k);
  assert.throws(() => tampered.readSecret("mobile", "b"));
  assert.throws(() => tampered.readSecret("site", "a"));
  assert.equal(tampered.readSecret("mobile", "a"), "value-a-111111");
});

test("the wrong master key cannot decrypt", () => {
  const f = join(tmp(), "vault.json");
  new Vault(f, key()).put("mobile", "github", "value-xxxxxx");
  assert.throws(() => new Vault(f, key()).readSecret("mobile", "github"));
});

test("deleteProject removes every credential of that project only", () => {
  const v = new Vault(join(tmp(), "vault.json"), key());
  v.put("a", "x", "value-1-aaaa");
  v.put("b", "x", "value-2-bbbb");
  v.deleteProject("a");
  assert.deepEqual(v.handles("a"), []);
  assert.equal(v.readSecret("b", "x"), "value-2-bbbb");
});

test("invalid handles are rejected", () => {
  const v = new Vault(join(tmp(), "vault.json"), key());
  for (const h of ["", "Has Space", "../x", "UPPER"]) assert.throws(() => v.put("p", h, "value-zzzzzz"), /invalid handle/);
});

test("the broker never returns the secret, it only hands it to a callback", async () => {
  const v = new Vault(join(tmp(), "vault.json"), key());
  v.put("p", "tok", "hand-me-over-1234");
  const b = new CredentialBroker(v);
  const out = await b.withCredential("p", "tok", (s) => s.length);
  assert.equal(out, 17);
  await assert.rejects(() => b.withCredential("other", "tok", () => 1), /no credential/);
});

test("only the broker reads secrets: readSecret/allSecrets are not called anywhere else in src", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const offenders: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f === "vault.ts" || f === "broker.ts") continue;
    if (/\b(readSecret|allSecrets)\s*\(/.test(readFileSync(join(dir, f), "utf8"))) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});
