"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { buildSessionParams, toForm } = require("../server/stripe-checkout");

const items = [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1, unitCents: 5499, currency: "USD", title: "Chopper", variantTitle: "Ivory", vendor: "USAdrop", image: null }];

test("no tax settings: no tax fields", () => {
  delete process.env.STRIPE_AUTOMATIC_TAX; delete process.env.STRIPE_TAX_RATE_IDS;
  const { params } = buildSessionParams(items, "s");
  assert.strictEqual(params.automatic_tax, undefined);
  assert.strictEqual(params.line_items[0].dynamic_tax_rates, undefined);
});

test("STRIPE_TAX_RATE_IDS adds dynamic tax rates to every line, ignores junk", () => {
  delete process.env.STRIPE_AUTOMATIC_TAX;
  process.env.STRIPE_TAX_RATE_IDS = " txr_MI6abc , not-a-rate ";
  const { params } = buildSessionParams(items, "s");
  assert.deepStrictEqual(params.line_items[0].dynamic_tax_rates, { 0: "txr_MI6abc" });
  const f = toForm(params); const form = Array.isArray(f) ? f.join("&") : String(f);
  assert.match(form, /line_items%5B0%5D%5Bdynamic_tax_rates%5D%5B0%5D=txr_MI6abc|line_items\[0\]\[dynamic_tax_rates\]\[0\]=txr_MI6abc/);
  delete process.env.STRIPE_TAX_RATE_IDS;
});

test("automatic tax wins and never combines with tax rates", () => {
  process.env.STRIPE_AUTOMATIC_TAX = "true"; process.env.STRIPE_TAX_RATE_IDS = "txr_MI6abc";
  const { params } = buildSessionParams(items, "s");
  assert.deepStrictEqual(params.automatic_tax, { enabled: true });
  assert.strictEqual(params.line_items[0].dynamic_tax_rates, undefined);
  delete process.env.STRIPE_AUTOMATIC_TAX; delete process.env.STRIPE_TAX_RATE_IDS;
});
