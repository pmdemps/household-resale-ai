import { test } from "node:test";
import assert from "node:assert/strict";
import { toCsv } from "./csv.ts";

test("escapes quotes, commas, newlines", () => {
  const out = toCsv(["a", "b"], [['say "hi"', "x,y"], ["line\nbreak", null]]);
  assert.equal(out, '﻿a,b\r\n"say ""hi""","x,y"\r\n"line\nbreak",\r\n');
});

test("neutralizes formulas but keeps negative numbers", () => {
  const out = toCsv(["v"], [["=HYPERLINK(\"x\")"], ["@SUM(A1)"], [-4.5]]);
  assert.ok(out.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(out.includes("'@SUM(A1)"));
  assert.ok(out.includes("\r\n-4.5\r\n"));
});
