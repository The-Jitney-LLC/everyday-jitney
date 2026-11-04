"use strict";

/*
 * Stripe → Shopify → Make (Sales Worksheet)
 * ------------------------------------------------------------------
 * POST /webhooks/stripe receives Stripe's signed events and:
 *
 *   checkout.session.completed (paid) / checkout.session.async_payment_succeeded
 *     1. Pulls the full session from Stripe: items, shipping, tax, the charge,
 *        Stripe's fee and the net amount.
 *     2. Creates the matching PAID order in Shopify, so USAdrop / Trendsi /
 *        Collective see it and ship it. (Skipped if this payment already has one.)
 *     3. Writes the Shopify order number back onto the Stripe payment.
 *     4. Sends one "Sale" ledger record to the Make sales webhook, which adds
 *        a row to the Sales Worksheet V1 "Stripe Sales Ledger" tab.
 *
 *   charge.refunded        → "Refund" ledger record (+ tags the Shopify order)
 *   charge.dispute.created → "Dispute" ledger record (+ tags the Shopify order)
 *
 * Every ledger record carries the IDs an accountant needs to trace it:
 * Shopify order, Stripe session, payment, charge and balance transaction.
 */

const crypto = require("crypto");
const { forward } = require("./forward");

const STRIPE_SECRET_KEY = () => process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = () => process.env.STRIPE_WEBHOOK_SECRET || "";
const SHOP = () => process.env.SHOPIFY_STORE_DOMAIN || "";
const SHOP_ADMIN_TOKEN = () => process.env.SHOPIFY_ADMIN_TOKEN || "";
const SHOP_API_VERSION = () => process.env.SHOPIFY_API_VERSION || "2026-07";
const MAKE_SALES_WEBHOOK_URL = () => process.env.MAKE_SALES_WEBHOOK_URL || "";
const MAKE_ORDERS_WEBHOOK_URL = () => process.env.MAKE_ORDERS_WEBHOOK_URL || "";
const BUSINESS_TZ = "America/Detroit";

/* ================================================================
   Signature check (Stripe's documented scheme, no SDK needed)
   ================================================================ */
function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || !header) return false;
  const parts = {};
  const v1 = [];
  for (const piece of String(header).split(",")) {
    const [k, v] = piece.split("=");
    if (k === "t") parts.t = v;
    if (k === "v1" && v) v1.push(v);
  }
  if (!parts.t || !v1.length) return false;
  if (Math.abs(nowSec - Number(parts.t)) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${rawBody.toString("utf8")}`).digest("hex");
  const exp = Buffer.from(expected, "hex");
  return v1.some((sig) => {
    const got = Buffer.from(sig, "hex");
    return got.length === exp.length && crypto.timingSafeEqual(got, exp);
  });
}

/* ================================================================
   Stripe API helpers
   ================================================================ */
function toForm(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") toForm(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join("&");
}
async function stripeGet(path) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY()}` },
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error((json.error && json.error.message) || `Stripe ${res.status}`);
  return json;
}
async function stripePost(path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY()}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: toForm(params),
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error((json.error && json.error.message) || `Stripe ${res.status}`);
  return json;
}

/* ================================================================
   Shopify Admin API helpers
   ================================================================ */
async function shopifyAdmin(query, variables) {
  const res = await fetch(`https://${SHOP()}/admin/api/${SHOP_API_VERSION()}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOP_ADMIN_TOKEN() },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Shopify Admin ${res.status}`);
  const json = await res.json();
  if (json.errors && json.errors.length) throw new Error(json.errors[0].message);
  return json.data;
}

async function variantCosts(variantIds) {
  if (!SHOP_ADMIN_TOKEN() || !variantIds.length) return {};
  try {
    const d = await shopifyAdmin(
      `query($ids:[ID!]!){ nodes(ids:$ids){ ... on ProductVariant { id sku inventoryItem { unitCost { amount } } } } }`,
      { ids: variantIds }
    );
    const out = {};
    for (const n of d.nodes || []) {
      if (n && n.id) out[n.id] = { sku: n.sku || "", cost: n.inventoryItem && n.inventoryItem.unitCost ? Number(n.inventoryItem.unitCost.amount) : null };
    }
    return out;
  } catch (err) {
    console.warn("[stripe-webhook] cost lookup failed:", err.message);
    return {};
  }
}

function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/);
  if (parts.length <= 1) return { firstName: parts[0] || "", lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

function mailingAddress(details, phone) {
  if (!details || !details.address) return null;
  const a = details.address;
  return {
    ...splitName(details.name),
    address1: a.line1 || "",
    address2: a.line2 || null,
    city: a.city || "",
    provinceCode: a.state || null,
    countryCode: a.country || "US",
    zip: a.postal_code || "",
    phone: phone || null,
  };
}

async function createShopifyOrder(sale) {
  const money = (amt) => ({ shopMoney: { amount: amt.toFixed(2), currencyCode: sale.currency } });
  const order = {
    currency: sale.currency,
    email: sale.customer_email || null,
    phone: sale.customer_phone || null,
    lineItems: sale.items.filter((i) => i.variant_id).map((i) => ({
      variantId: i.variant_id,
      quantity: i.qty,
      priceSet: money(i.unit_price),
    })),
    shippingAddress: sale._shippingAddress,
    billingAddress: sale._billingAddress || sale._shippingAddress,
    financialStatus: "PAID",
    transactions: [{
      kind: "SALE",
      status: "SUCCESS",
      gateway: "Stripe",
      authorizationCode: sale.stripe_charge_id || undefined,
      amountSet: money(sale.gross_amount),
    }],
    shippingLines: sale.shipping > 0 ? [{ title: "Standard shipping", priceSet: money(sale.shipping) }] : [],
    taxLines: sale.sales_tax > 0 ? [{
      title: "Sales tax",
      rate: Number((sale.sales_tax / Math.max(0.01, sale.merchandise_subtotal - sale.discounts)).toFixed(4)),
      priceSet: money(sale.sales_tax),
    }] : [],
    note: `Paid on Stripe. Checkout session ${sale.stripe_checkout_session_id}.`,
    customAttributes: [
      { key: "stripe_checkout_session", value: sale.stripe_checkout_session_id },
      { key: "stripe_payment_intent", value: sale.stripe_payment_intent_id || "" },
      { key: "stripe_charge", value: sale.stripe_charge_id || "" },
      { key: "icp_session_id", value: sale.icp_session_id || "" },
    ],
    sourceIdentifier: sale.stripe_checkout_session_id,
    tags: ["everydayjitney", "stripe"],
  };
  const d = await shopifyAdmin(
    `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput){
       orderCreate(order: $order, options: $options){ order { id name } userErrors { field message } }
     }`,
    { order, options: { sendReceipt: false, sendFulfillmentReceipt: false, inventoryBehaviour: "DECREMENT_OBEYING_POLICY" } }
  );
  const r = d.orderCreate;
  if (r.userErrors && r.userErrors.length) throw new Error(r.userErrors.map((e) => e.message).join("; "));
  return r.order;
}

async function tagShopifyOrder(orderId, tags) {
  if (!SHOP_ADMIN_TOKEN() || !orderId) return;
  try {
    await shopifyAdmin(`mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id, tags:$tags){ userErrors { message } } }`, { id: orderId, tags });
  } catch (err) {
    console.warn("[stripe-webhook] tagging failed:", err.message);
  }
}

/* ================================================================
   Ledger record (one row in the Sales Worksheet)
   ================================================================ */
const cents = (n) => Math.round(Number(n || 0)) / 100;
function localTime(epochSec) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date(epochSec * 1000)).replace(",", "");
}
function availableOn(bt) {
  return bt && bt.available_on ? new Date(bt.available_on * 1000).toISOString().slice(0, 10) : "";
}

// Column order matches the "Stripe Sales Ledger" header row exactly.
const LEDGER_COLUMNS = [
  ["record_type", "Record Type"],
  ["event_time_local", "Date & Time (Detroit)"],
  ["event_time_utc", "Date & Time (UTC)"],
  ["shopify_order_name", "Shopify Order #"],
  ["shopify_order_id", "Shopify Order ID"],
  ["customer_name", "Customer Name"],
  ["customer_email", "Customer Email"],
  ["ship_city", "Ship-to City"],
  ["ship_state", "Ship-to State"],
  ["ship_zip", "Ship-to ZIP"],
  ["ship_country", "Ship-to Country"],
  ["items_summary", "Items (qty × name @ price | SKU | supplier)"],
  ["units", "Units"],
  ["suppliers", "Suppliers"],
  ["currency", "Currency"],
  ["merchandise_subtotal", "Merchandise Subtotal"],
  ["discounts", "Discounts"],
  ["shipping", "Shipping Charged"],
  ["sales_tax", "Sales Tax Collected"],
  ["gross_amount", "Gross Amount"],
  ["stripe_fee", "Stripe Fee"],
  ["net_amount", "Net Amount"],
  ["est_cogs", "Est. Cost of Goods"],
  ["est_gross_profit", "Est. Gross Profit"],
  ["payment_method", "Payment Method"],
  ["card_last4", "Card Last 4"],
  ["funds_available_on", "Funds Available On"],
  ["stripe_checkout_session_id", "Stripe Checkout Session"],
  ["stripe_payment_intent_id", "Stripe Payment Intent"],
  ["stripe_charge_id", "Stripe Charge"],
  ["stripe_balance_txn_id", "Stripe Balance Transaction"],
  ["stripe_receipt_url", "Stripe Receipt URL"],
  ["stripe_event_id", "Stripe Event ID"],
  ["icp_session_id", "ICP Session ID"],
  ["shopify_status", "Shopify Order Status"],
  ["notes", "Notes"],
  ["record_id", "Record ID"],
  ["recorded_at", "Recorded At (UTC)"],
];

function ledgerRow(rec) {
  const row = {};
  for (const [key] of LEDGER_COLUMNS) row[key] = rec[key] === undefined || rec[key] === null ? "" : rec[key];
  return { type: "sales_ledger_record", columns: LEDGER_COLUMNS.map(([k, label]) => ({ key: k, label })), row };
}

/* ================================================================
   Event handlers
   ================================================================ */
async function handleSale(event) {
  const sessionId = event.data.object.id;
  const s = await stripeGet(
    `checkout/sessions/${sessionId}?expand[]=line_items.data.price.product&expand[]=payment_intent.latest_charge.balance_transaction&expand[]=payment_intent.payment_method`
  );
  if (s.payment_status !== "paid") return { skipped: "not paid yet" };

  const pi = s.payment_intent && typeof s.payment_intent === "object" ? s.payment_intent : null;
  const charge = pi && pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  const bt = charge && charge.balance_transaction && typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
  const currency = String(s.currency || "usd").toUpperCase();

  // Map Stripe line items back to Shopify variants
  const fallback = {};
  String((s.metadata && s.metadata.shopify_variants) || "").split(",").forEach((pair) => {
    const [num, qty] = pair.split(":");
    if (num) fallback[num] = Number(qty);
  });
  const lines = ((s.line_items && s.line_items.data) || []).map((li) => {
    const product = li.price && typeof li.price.product === "object" ? li.price.product : {};
    const meta = product.metadata || {};
    return {
      variant_id: meta.shopify_variant_id || null,
      vendor: meta.vendor || "",
      title: li.description || product.name || "Item",
      qty: li.quantity,
      unit_price: cents(li.price ? li.price.unit_amount : li.amount_subtotal / Math.max(1, li.quantity)),
      line_total: cents(li.amount_subtotal),
    };
  });
  // If product metadata was missing, fill variant IDs from the session's compact list (same order)
  const fbKeys = Object.keys(fallback);
  lines.forEach((l, i) => { if (!l.variant_id && fbKeys[i]) l.variant_id = `gid://shopify/ProductVariant/${fbKeys[i]}`; });

  const costs = await variantCosts(lines.map((l) => l.variant_id).filter(Boolean));
  let cogs = 0, cogsKnown = true;
  lines.forEach((l) => {
    const c = costs[l.variant_id];
    l.sku = c ? c.sku : "";
    if (c && c.cost != null) cogs += c.cost * l.qty; else cogsKnown = false;
  });

  const shipDetails = (s.collected_information && s.collected_information.shipping_details) || s.shipping_details || null;
  const cust = s.customer_details || {};
  const td = s.total_details || {};
  const pm = pi && pi.payment_method && typeof pi.payment_method === "object" ? pi.payment_method : null;
  const card = (charge && charge.payment_method_details && charge.payment_method_details.card) || (pm && pm.card) || null;

  const sale = {
    record_type: "Sale",
    event_time_utc: new Date(event.created * 1000).toISOString(),
    event_time_local: localTime(event.created),
    customer_name: (shipDetails && shipDetails.name) || cust.name || "",
    customer_email: cust.email || "",
    customer_phone: cust.phone || "",
    ship_city: shipDetails && shipDetails.address ? shipDetails.address.city : "",
    ship_state: shipDetails && shipDetails.address ? shipDetails.address.state : "",
    ship_zip: shipDetails && shipDetails.address ? shipDetails.address.postal_code : "",
    ship_country: shipDetails && shipDetails.address ? shipDetails.address.country : "",
    items: lines,
    items_summary: lines.map((l) => `${l.qty} × ${l.title} @ ${l.unit_price.toFixed(2)}${l.sku ? " | " + l.sku : ""}${l.vendor ? " | " + l.vendor : ""}`).join("; "),
    units: lines.reduce((n, l) => n + l.qty, 0),
    suppliers: [...new Set(lines.map((l) => l.vendor).filter(Boolean))].join(", "),
    currency,
    merchandise_subtotal: cents(s.amount_subtotal),
    discounts: cents(td.amount_discount),
    shipping: cents(td.amount_shipping),
    sales_tax: cents(td.amount_tax),
    gross_amount: cents(s.amount_total),
    stripe_fee: bt ? cents(bt.fee) : "",
    net_amount: bt ? cents(bt.net) : "",
    est_cogs: cogsKnown && lines.length ? Number(cogs.toFixed(2)) : "",
    est_gross_profit: cogsKnown && bt ? Number((cents(bt.net) - cogs - cents(td.amount_tax)).toFixed(2)) : "",
    payment_method: card ? `${card.brand || "card"}${card.funding ? " " + card.funding : ""}` : (charge && charge.payment_method_details ? charge.payment_method_details.type : ""),
    card_last4: card ? card.last4 : "",
    funds_available_on: availableOn(bt),
    stripe_checkout_session_id: s.id,
    stripe_payment_intent_id: pi ? pi.id : (typeof s.payment_intent === "string" ? s.payment_intent : ""),
    stripe_charge_id: charge ? charge.id : "",
    stripe_balance_txn_id: bt ? bt.id : "",
    stripe_receipt_url: charge ? charge.receipt_url || "" : "",
    stripe_event_id: event.id,
    icp_session_id: (s.metadata && s.metadata.icp_session_id) || s.client_reference_id || "",
    record_id: `SALE-${s.id}`,
    recorded_at: new Date().toISOString(),
    notes: [],
    _shippingAddress: mailingAddress(shipDetails, cust.phone),
    _billingAddress: cust.address ? mailingAddress({ name: cust.name, address: cust.address }, cust.phone) : null,
  };
  if (!cogsKnown) sale.notes.push("Add supplier cost per item in Shopify to fill Cost of Goods");

  // Shopify order: create once per payment
  const existing = pi && pi.metadata ? pi.metadata.shopify_order_id : null;
  if (existing) {
    sale.shopify_order_id = existing;
    sale.shopify_order_name = pi.metadata.shopify_order_name || "";
    sale.shopify_status = "Already created";
  } else if (!SHOP_ADMIN_TOKEN()) {
    sale.shopify_status = "NOT CREATED: Shopify admin token not set";
  } else if (!sale.items.some((i) => i.variant_id)) {
    sale.shopify_status = "NOT CREATED: no Shopify variants on this payment";
  } else {
    try {
      const order = await createShopifyOrder(sale);
      sale.shopify_order_id = order.id;
      sale.shopify_order_name = order.name;
      sale.shopify_status = "Created (paid)";
      if (pi) {
        await stripePost(`payment_intents/${pi.id}`, { metadata: { shopify_order_id: order.id, shopify_order_name: order.name } })
          .catch((e) => console.warn("[stripe-webhook] could not stamp payment:", e.message));
      }
    } catch (err) {
      console.error("[stripe-webhook] Shopify order failed:", err.message);
      sale.shopify_status = "FAILED: " + err.message.slice(0, 180);
      sale.notes.push("Create this order in Shopify by hand so the supplier ships it");
    }
  }
  sale.notes = sale.notes.join(". ");

  await forward(MAKE_SALES_WEBHOOK_URL(), ledgerRow(sale), "sales-ledger");
  forward(MAKE_ORDERS_WEBHOOK_URL(), {
    type: "commerce_event", provider: "stripe", event: "payment_succeeded",
    stripe_checkout_session_id: sale.stripe_checkout_session_id, stripe_payment_intent_id: sale.stripe_payment_intent_id,
    shopify_order_id: sale.shopify_order_id || null, shopify_order_name: sale.shopify_order_name || null, shopify_status: sale.shopify_status,
    icp_session_id: sale.icp_session_id, currency, gross: sale.gross_amount, net: sale.net_amount,
    items: sale.items, received_at: sale.recorded_at,
  }, "orders");
  return { recorded: sale.record_id, shopify: sale.shopify_status };
}

async function orderFromPaymentIntent(piId) {
  if (!piId) return {};
  try {
    const pi = await stripeGet(`payment_intents/${piId}`);
    return { id: pi.metadata.shopify_order_id || "", name: pi.metadata.shopify_order_name || "", icp: pi.metadata.icp_session_id || "", ours: pi.metadata.source === "everydayjitney.com" };
  } catch (_) { return {}; }
}

async function handleRefund(event) {
  const ch = event.data.object;
  const prev = event.data.previous_attributes && event.data.previous_attributes.amount_refunded;
  const refundedNow = prev != null ? ch.amount_refunded - prev : ch.amount_refunded;
  const refunds = await stripeGet(`refunds?charge=${ch.id}&limit=1&expand[]=data.balance_transaction`).catch(() => ({ data: [] }));
  const rf = refunds.data[0] || null;
  const bt = rf && typeof rf.balance_transaction === "object" ? rf.balance_transaction : null;
  const order = await orderFromPaymentIntent(ch.payment_intent);
  if (!order.ours) return { skipped: "refund is not from the Everyday Jitney store" };
  const rec = {
    record_type: ch.refunded ? "Refund (full)" : "Refund (partial)",
    event_time_utc: new Date(event.created * 1000).toISOString(),
    event_time_local: localTime(event.created),
    shopify_order_name: order.name, shopify_order_id: order.id,
    customer_name: ch.billing_details ? ch.billing_details.name : "",
    customer_email: ch.billing_details ? ch.billing_details.email : "",
    currency: String(ch.currency).toUpperCase(),
    gross_amount: -cents(refundedNow),
    stripe_fee: bt ? cents(bt.fee) : "",
    net_amount: bt ? cents(bt.net) : -cents(refundedNow),
    payment_method: ch.payment_method_details && ch.payment_method_details.card ? ch.payment_method_details.card.brand : "",
    card_last4: ch.payment_method_details && ch.payment_method_details.card ? ch.payment_method_details.card.last4 : "",
    stripe_payment_intent_id: ch.payment_intent || "",
    stripe_charge_id: ch.id,
    stripe_balance_txn_id: bt ? bt.id : "",
    stripe_receipt_url: ch.receipt_url || "",
    stripe_event_id: event.id,
    icp_session_id: order.icp,
    shopify_status: order.id ? "Tagged stripe-refunded" : "No linked Shopify order",
    notes: rf && rf.reason ? `Reason: ${rf.reason}. Cancel or refund the Shopify order and tell the supplier if it hasn't shipped.` : "Cancel or refund the Shopify order and tell the supplier if it hasn't shipped.",
    record_id: `REFUND-${rf ? rf.id : event.id}`,
    recorded_at: new Date().toISOString(),
  };
  await tagShopifyOrder(order.id, ["stripe-refunded"]);
  await forward(MAKE_SALES_WEBHOOK_URL(), ledgerRow(rec), "sales-ledger");
  forward(MAKE_ORDERS_WEBHOOK_URL(), { type: "commerce_event", provider: "stripe", event: "refunded", amount: cents(refundedNow), stripe_charge_id: ch.id, shopify_order_id: order.id || null }, "orders");
  return { recorded: rec.record_id };
}

async function handleDispute(event) {
  const d = event.data.object;
  let piId = d.payment_intent || "";
  if (!piId && d.charge) { const ch = await stripeGet(`charges/${d.charge}`).catch(() => null); piId = ch ? ch.payment_intent : ""; }
  const order = await orderFromPaymentIntent(piId);
  if (!order.ours) return { skipped: "dispute is not from the Everyday Jitney store" };
  const rec = {
    record_type: "Dispute opened",
    event_time_utc: new Date(event.created * 1000).toISOString(),
    event_time_local: localTime(event.created),
    shopify_order_name: order.name, shopify_order_id: order.id,
    currency: String(d.currency).toUpperCase(),
    gross_amount: -cents(d.amount),
    stripe_payment_intent_id: piId,
    stripe_charge_id: typeof d.charge === "string" ? d.charge : "",
    stripe_event_id: event.id,
    icp_session_id: order.icp,
    shopify_status: order.id ? "Tagged stripe-dispute" : "No linked Shopify order",
    notes: `Reason: ${d.reason}. Status: ${d.status}. Respond in Stripe before the evidence deadline.`,
    record_id: `DISPUTE-${d.id}`,
    recorded_at: new Date().toISOString(),
  };
  await tagShopifyOrder(order.id, ["stripe-dispute"]);
  await forward(MAKE_SALES_WEBHOOK_URL(), ledgerRow(rec), "sales-ledger");
  forward(MAKE_ORDERS_WEBHOOK_URL(), { type: "commerce_event", provider: "stripe", event: "disputed", amount: cents(d.amount), reason: d.reason, shopify_order_id: order.id || null }, "orders");
  return { recorded: rec.record_id };
}

const HANDLERS = {
  "checkout.session.completed": handleSale,
  "checkout.session.async_payment_succeeded": handleSale,
  "charge.refunded": handleRefund,
  "charge.dispute.created": handleDispute,
};

/* ================================================================
   Express handler
   ================================================================ */
const seen = new Set();
function stripeWebhookHandler(req, res) {
  if (!verifyStripeSignature(req.body, req.get("Stripe-Signature"), STRIPE_WEBHOOK_SECRET())) return res.sendStatus(400);
  let event;
  try { event = JSON.parse(req.body.toString("utf8")); } catch (_) { return res.sendStatus(400); }

  // Only events from this store's own checkout (other Stripe traffic is ignored)
  const handler = HANDLERS[event.type];
  if (!handler || seen.has(event.id)) return res.sendStatus(200);
  if (event.type.startsWith("checkout.session") && !(event.data.object.metadata && event.data.object.metadata.source === "everydayjitney.com")) {
    return res.sendStatus(200);
  }
  seen.add(event.id);
  if (seen.size > 5000) seen.delete(seen.values().next().value);

  res.sendStatus(200); // acknowledge fast; Stripe retries otherwise
  handler(event)
    .then((r) => console.log(`[stripe-webhook] ${event.type} ${event.id}`, r))
    .catch((err) => {
      seen.delete(event.id);
      console.error(`[stripe-webhook] ${event.type} ${event.id} failed:`, err.message);
    });
}

module.exports = { stripeWebhookHandler, verifyStripeSignature, ledgerRow, LEDGER_COLUMNS, localTime };
