"use strict";

/*
 * Turns Shopify webhook topics into the same event names the existing
 * Stripe/Square payment layer uses, so Make and the ICP agents see one format.
 *
 *   orders/create        -> order_created
 *   orders/paid          -> payment_succeeded
 *   refunds/create       -> refunded
 *   disputes/create      -> disputed          (Shopify Payments stores)
 *   orders/cancelled     -> order_cancelled
 *   fulfillments/create  -> fulfillment_update (tracking from USAdrop / Trendsi / Collective)
 *   fulfillments/update  -> fulfillment_update
 *
 * Note: Shopify does not send a webhook for a declined card at checkout, so
 * "payment_failed" only arrives from the Stripe/Square layer.
 */
const TOPIC_MAP = {
  "orders/create": "order_created",
  "orders/paid": "payment_succeeded",
  "refunds/create": "refunded",
  "disputes/create": "disputed",
  "orders/cancelled": "order_cancelled",
  "fulfillments/create": "fulfillment_update",
  "fulfillments/update": "fulfillment_update",
};

function attr(list, key) {
  if (!Array.isArray(list)) return null;
  const hit = list.find((a) => a && (a.name === key || a.key === key));
  return hit ? String(hit.value) : null;
}

function money(v) {
  return v == null || v === "" ? null : Number(v);
}

function normalizeShopifyEvent(topic, body, meta) {
  const event = TOPIC_MAP[topic];
  if (!event) return null;

  const base = {
    type: "commerce_event",
    provider: "shopify",
    event,
    topic,
    webhook_id: meta.webhookId,
    shop: meta.shopDomain,
    triggered_at: meta.triggeredAt,
    received_at: new Date().toISOString(),
    received_ts_ms: Date.now(),
  };

  if (topic.startsWith("orders/")) {
    return {
      ...base,
      order_id: body.id,
      order_name: body.name,
      created_at: body.created_at,
      financial_status: body.financial_status,
      currency: body.currency,
      total: money(body.total_price),
      subtotal: money(body.subtotal_price),
      // Set by the storefront when the cart is created; links the order to its browsing session.
      icp_session_id: attr(body.note_attributes, "icp_session_id"),
      landing_site: body.landing_site || null,
      referring_site: body.referring_site || null,
      customer_city: body.shipping_address ? body.shipping_address.city : null,
      customer_state: body.shipping_address ? body.shipping_address.province_code : null,
      items: (body.line_items || []).map((l) => ({
        title: l.title,
        variant: l.variant_title,
        sku: l.sku,
        vendor: l.vendor, // shows which supplier (USAdrop, Trendsi, Collective) carries the item
        qty: l.quantity,
        price: money(l.price),
      })),
    };
  }

  if (topic === "refunds/create") {
    const amount = (body.transactions || []).reduce((s, t) => s + (Number(t.amount) || 0), 0);
    return { ...base, order_id: body.order_id, refund_id: body.id, amount, created_at: body.created_at };
  }

  if (topic === "disputes/create") {
    return { ...base, order_id: body.order_id, dispute_id: body.id, amount: money(body.amount), currency: body.currency, reason: body.reason, status: body.status };
  }

  if (topic.startsWith("fulfillments/")) {
    return {
      ...base,
      order_id: body.order_id,
      fulfillment_id: body.id,
      status: body.status,
      shipment_status: body.shipment_status || null,
      tracking_company: body.tracking_company || null,
      tracking_numbers: body.tracking_numbers || [],
      tracking_urls: body.tracking_urls || [],
    };
  }

  return base;
}

module.exports = { normalizeShopifyEvent, TOPIC_MAP };
