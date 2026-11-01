import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanServiceKey, serviceKeyProblem } from "./service-key.ts";

const good = "sb_secret_" + "Ab3_x-".repeat(6);

test("a clean key passes, paste noise around it is stripped", () => {
  assert.equal(serviceKeyProblem(cleanServiceKey(good)), null);
  assert.equal(cleanServiceKey(`  "${good}"\n`), good);
  assert.equal(serviceKeyProblem("eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2ln"), null, "legacy JWT keys still work");
});

test("a long dash inside the key is caught, by position, without echoing the key", () => {
  const bad = good.slice(0, 38) + "—" + good.slice(38);
  const msg = serviceKeyProblem(cleanServiceKey(bad));
  assert.match(msg ?? "", /long dash at character 39/);
  assert.ok(!(msg ?? "").includes("sb_secret_"), "never prints the key");
});

test("label text, masked dots and spaces are caught", () => {
  assert.match(serviceKeyProblem("default " + good) ?? "", /a space at character 8/);
  assert.match(serviceKeyProblem("sb_secret_pNaar••••") ?? "", /dot from the hidden display/);
  assert.match(serviceKeyProblem("hello") ?? "", /doesn't look like a Supabase secret key/);
});
