"use strict";
const test = require("node:test");
const assert = require("node:assert");

test("client credentials token is fetched once, cached, and renewed after invalidation", async () => {
  process.env.SHOPIFY_STORE_DOMAIN = "example.myshopify.com";
  process.env.SHOPIFY_CLIENT_ID = "id";
  process.env.SHOPIFY_CLIENT_SECRET = "secret";
  delete process.env.SHOPIFY_ADMIN_TOKEN;
  const auth = require("../server/shopify-admin-auth");
  let calls = 0, lastBody = "";
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls += 1; lastBody = opts.body;
    assert.strictEqual(url, "https://example.myshopify.com/admin/oauth/access_token");
    return { ok: true, status: 200, json: async () => ({ access_token: "tok" + calls, expires_in: 86399 }) };
  };
  try {
    assert.strictEqual(auth.authMode(), "client_credentials");
    assert.ok(auth.adminConfigured());
    assert.strictEqual(await auth.getAdminToken(), "tok1");
    assert.strictEqual(await auth.getAdminToken(), "tok1");
    assert.strictEqual(calls, 1);
    assert.match(lastBody, /grant_type=client_credentials/);
    auth.invalidateAdminToken();
    assert.strictEqual(await auth.getAdminToken(), "tok2");
  } finally {
    global.fetch = realFetch;
    delete process.env.SHOPIFY_CLIENT_ID; delete process.env.SHOPIFY_CLIENT_SECRET;
  }
});

test("falls back to a static token and reports not configured when nothing is set", async () => {
  const auth = require("../server/shopify-admin-auth");
  process.env.SHOPIFY_ADMIN_TOKEN = "shpat_x";
  assert.strictEqual(auth.authMode(), "static_token");
  assert.strictEqual(await auth.getAdminToken(), "shpat_x");
  delete process.env.SHOPIFY_ADMIN_TOKEN;
  assert.strictEqual(auth.authMode(), "not configured");
  assert.strictEqual(auth.adminConfigured(), false);
});
