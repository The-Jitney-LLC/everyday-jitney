"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { makeHeaders } = require("../server/forward");

test("Make API key is sent only when configured", () => {
  delete process.env.MAKE_WEBHOOK_API_KEY;
  assert.deepStrictEqual(makeHeaders(), { "Content-Type": "application/json" });
  process.env.MAKE_WEBHOOK_API_KEY = "k";
  assert.strictEqual(makeHeaders()["x-make-apikey"], "k");
  delete process.env.MAKE_WEBHOOK_API_KEY;
});
