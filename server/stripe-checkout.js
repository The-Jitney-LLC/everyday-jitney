"use strict";

/*
 * Stripe Checkout for Everyday Jitney
 * ------------------------------------------------------------------
 * POST /api/checkout  { lines: [{ variantId, quantity }], icpSessionId }
 *   1. Looks up every item's real price, name, photo and supplier in Shopify
 *      (never trusts prices sent by the browser).
 *   2. Creates a Stripe Checkout Session and returns its URL.
 *   3. The browser goes to Stripe's hosted payment page. Card numbers are
 *      typed only there, so they never touch this site, this server, or Make.
 *   4. Sends a "checkout_created" event (items, suppliers, ICP session) to the
 *      Make orders webhook. Stripe itself reports the payment result to your
 *      Stripe "Watch Events" webhook in Make.
 */

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || "";
const SHOPIFY_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN || "";
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const SITE_URL = (process.env.SITE_URL || "https://www.everydayjitney.com").replace(/\/$/, "");
const SHIP_COUNTRIES = String(process.env.SHIP_COUNTRIES || "US").split(",").map((s) => s.trim()).filter(Boolean);
const FLAT_SHIPPING_CENTS = Number(process.env.FLAT_SHIPPING_CENTS || 0);
const FREE_SHIPPING_OVER_CENTS = Number(process.env.FREE_SHIPPING_OVER_CENTS || 0);

const MAX_LINES = 40;
const MAX_QTY = 20;

function configured() {
  return Boolean(SHOPIFY_DOMAIN && SHOPIFY_TOKEN && STRIPE_SECRET_KEY);
}

/* ---------- Shopify: trusted product data ---------- */
async function lookupVariants(ids) {
  const query = `query($ids:[ID!]!){ nodes(ids:$ids){ ... on ProductVariant {
    id title availableForSale
    price { amount currencyCode }
    image { url(transform:{maxWidth:600}) }
    product { title handle vendor featuredImage { url(transform:{maxWidth:600}) } }
  } } }`;
  const res = await fetch(`https://${SHOPIFY_DOMAIN}/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Storefront-Access-Token": SHOPIFY_TOKEN },
    body: JSON.stringify({ query, variables: { ids } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Shopify ${res.status}`);
  const json = await res.json();
  if (json.errors && json.errors.length) throw new Error(json.errors[0].message);
  return json.data.nodes;
}

/* ---------- Stripe: form-encoded API without an SDK ---------- */
function toForm(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") toForm(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join("&");
}

async function stripePost(path, params, idempotencyKey) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": idempotencyKey,
    },
    body: toForm(params),
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error((json.error && json.error.message) || `Stripe ${res.status}`);
  return json;
}

/* ---------- build the session ---------- */
function buildSessionParams(items, icpSessionId) {
  const subtotalCents = items.reduce((s, i) => s + i.unitCents * i.quantity, 0);
  const currency = items[0].currency.toLowerCase();

  const lineItems = {};
  items.forEach((i, n) => {
    lineItems[n] = {
      quantity: i.quantity,
      price_data: {
        currency,
        unit_amount: i.unitCents,
        product_data: {
          name: i.variantTitle && i.variantTitle !== "Default Title" ? `${i.title} (${i.variantTitle})` : i.title,
          images: i.image ? { 0: i.image } : undefined,
          metadata: { shopify_variant_id: i.variantId, vendor: i.vendor || "" },
        },
      },
    };
  });

  // Compact list Make can split: "variantNumber:qty,variantNumber:qty"
  const compact = items.map((i) => `${String(i.variantId).split("/").pop()}:${i.quantity}`).join(",").slice(0, 500);
  const metadata = { icp_session_id: icpSessionId || "", shopify_variants: compact, source: "everydayjitney.com" };

  const params = {
    mode: "payment",
    line_items: lineItems,
    success_url: `${SITE_URL}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${SITE_URL}/?checkout=cancelled`,
    client_reference_id: (icpSessionId || "").slice(0, 200) || undefined,
    metadata,
    payment_intent_data: { metadata },
    shipping_address_collection: { allowed_countries: Object.fromEntries(SHIP_COUNTRIES.map((c, n) => [n, c])) },
    phone_number_collection: { enabled: true },
    billing_address_collection: "auto",
  };

  // Sales tax, two ways (never both; Stripe rejects the combination):
  //  1. STRIPE_AUTOMATIC_TAX=true  -> Stripe Tax (paid add-on; add registrations in Dashboard > Tax).
  //  2. STRIPE_TAX_RATE_IDS=txr_... -> your own tax rates (e.g. "Michigan 6%", country US, state MI).
  //     Passed as dynamic tax rates, so Stripe applies a rate only when the customer's
  //     shipping address matches that rate's state. Out-of-state orders are not charged it.
  const taxRateIds = dynamicTaxRateIds();
  if (String(process.env.STRIPE_AUTOMATIC_TAX).toLowerCase() === "true") {
    params.automatic_tax = { enabled: true };
  } else if (taxRateIds.length) {
    Object.values(lineItems).forEach((li) => {
      li.dynamic_tax_rates = Object.fromEntries(taxRateIds.map((id, n) => [n, id]));
    });
  }

  if (FLAT_SHIPPING_CENTS > 0) {
    const free = FREE_SHIPPING_OVER_CENTS > 0 && subtotalCents >= FREE_SHIPPING_OVER_CENTS;
    params.shipping_options = {
      0: {
        shipping_rate_data: {
          type: "fixed_amount",
          display_name: free ? "Free shipping" : "Standard shipping",
          fixed_amount: { amount: free ? 0 : FLAT_SHIPPING_CENTS, currency },
        },
      },
    };
  }
  return { params, subtotalCents, currency };
}

function dynamicTaxRateIds() {
  return String(process.env.STRIPE_TAX_RATE_IDS || "")
    .split(",").map((x) => x.trim()).filter((x) => /^txr_[A-Za-z0-9]+$/.test(x)).slice(0, 5);
}

async function createCheckout(body) {
  if (!configured()) {
    const err = new Error("Checkout is not configured yet.");
    err.status = 503;
    throw err;
  }
  const raw = Array.isArray(body && body.lines) ? body.lines : [];
  const merged = new Map();
  for (const l of raw.slice(0, MAX_LINES)) {
    if (!l || typeof l.variantId !== "string" || !l.variantId.startsWith("gid://shopify/ProductVariant/")) continue;
    const q = Math.max(1, Math.min(MAX_QTY, parseInt(l.quantity, 10) || 1));
    merged.set(l.variantId, Math.min(MAX_QTY, (merged.get(l.variantId) || 0) + q));
  }
  if (!merged.size) { const e = new Error("Your cart is empty."); e.status = 400; throw e; }

  const nodes = await lookupVariants([...merged.keys()]);
  const items = [];
  for (const v of nodes) {
    if (!v || !v.id) continue;
    if (!v.availableForSale) { const e = new Error(`${v.product.title} is sold out. Remove it to continue.`); e.status = 409; throw e; }
    items.push({
      variantId: v.id,
      quantity: merged.get(v.id),
      unitCents: Math.round(Number(v.price.amount) * 100),
      currency: v.price.currencyCode,
      title: v.product.title,
      variantTitle: v.title,
      vendor: v.product.vendor,
      image: (v.image && v.image.url) || (v.product.featuredImage && v.product.featuredImage.url) || null,
    });
  }
  if (!items.length) { const e = new Error("Those items are no longer available."); e.status = 409; throw e; }
  // Never charge for an incomplete catalog listing with a zero/invalid price.
  if (items.some((i) => !Number.isSafeInteger(i.unitCents) || i.unitCents < 50)) {
    const e = new Error("An item has an invalid checkout price. Please remove it and try again.");
    e.status = 409;
    throw e;
  }
  if (new Set(items.map((i) => i.currency)).size > 1) { const e = new Error("Mixed currencies in cart."); e.status = 400; throw e; }

  const icpSessionId = typeof body.icpSessionId === "string" ? body.icpSessionId.slice(0, 80) : "";
  const { params, subtotalCents, currency } = buildSessionParams(items, icpSessionId);
  // A cart-based idempotency key would make two unrelated shoppers share one
  // Stripe Checkout Session if they purchase the same items in the same minute.
  // Use a distinct key for each initiated checkout instead.
  const idem = require("crypto").randomUUID();
  const session = await stripePost("checkout/sessions", params, idem);

  return {
    url: session.url,
    event: {
      type: "commerce_event",
      provider: "stripe",
      event: "checkout_created",
      stripe_checkout_session_id: session.id,
      icp_session_id: icpSessionId || null,
      currency,
      subtotal: subtotalCents / 100,
      created_at: new Date().toISOString(),
      created_ts_ms: Date.now(),
      items: items.map((i) => ({
        shopify_variant_id: i.variantId,
        title: i.title,
        variant: i.variantTitle,
        vendor: i.vendor, // which supplier app carries it (USAdrop, Trendsi, Collective)
        qty: i.quantity,
        price: i.unitCents / 100,
      })),
    },
  };
}

module.exports = { createCheckout, buildSessionParams, toForm, configured };
