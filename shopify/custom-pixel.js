/*
 * Everyday Jitney — Shopify custom pixel (checkout tracking)
 * ------------------------------------------------------------------
 * Paste this into: Shopify Admin > Settings > Customer events > Add custom pixel.
 * Name it "ICP checkout", paste, Save, then click Connect.
 *
 * It sends each checkout step to the same /api/icp endpoint as the site
 * beacon, using the same session ID, so one customer's trail runs from the
 * first page view to the thank-you page.
 *
 * Shopify runs pixels in a sandbox: there is no access to the checkout page
 * itself, so scroll depth and clicks are not available here. Every event
 * does carry Shopify's own timestamp plus a high-resolution clock reading.
 */

// 1) Set this to your back end's beacon address (same as icpEndpoint in config.js).
const ICP_ENDPOINT = "https://api.everydayjitney.com/api/icp";

let cachedSid = null;
async function sessionId(event) {
  if (cachedSid) return cachedSid;
  // First choice: the cookie the storefront set on .everydayjitney.com
  try { cachedSid = await browser.cookie.get("icp_sid"); } catch (_) {}
  // Backup: the cart attribute the storefront added when the cart was created
  if (!cachedSid) {
    const attrs = (event && event.data && event.data.checkout && event.data.checkout.attributes) || [];
    const hit = attrs.find((a) => a.key === "icp_session_id");
    if (hit) cachedSid = hit.value;
  }
  return cachedSid || "unknown";
}

function nowMs() {
  try { return Math.round((performance.timeOrigin + performance.now()) * 1000) / 1000; } catch (_) { return Date.now(); }
}

function checkoutSummary(checkout) {
  if (!checkout) return {};
  return {
    token: checkout.token || null,
    currency: checkout.currencyCode || null,
    subtotal: checkout.subtotalPrice ? Number(checkout.subtotalPrice.amount) : null,
    total: checkout.totalPrice ? Number(checkout.totalPrice.amount) : null,
    order_id: checkout.order ? checkout.order.id : null,
    items: (checkout.lineItems || []).map((l) => ({
      title: l.title,
      qty: l.quantity,
      variant_id: l.variant ? l.variant.id : null,
      vendor: l.variant && l.variant.product ? l.variant.product.vendor : null,
      price: l.variant && l.variant.price ? Number(l.variant.price.amount) : null,
    })),
  };
}

async function send(name, event) {
  const sid = await sessionId(event);
  const body = JSON.stringify({
    v: 1,
    source: "shopify_checkout_pixel",
    site: event.context && event.context.document ? event.context.document.location.hostname : "checkout",
    sent_ts_ms: nowMs(),
    events: [{
      event: name,
      ts_ms: nowMs(),
      iso: event.timestamp, // Shopify's own event time (ISO 8601, millisecond precision)
      session_id: sid,
      page: event.context && event.context.document ? event.context.document.location.pathname : null,
      data: { shopify_event_id: event.id, checkout: checkoutSummary(event.data && event.data.checkout) },
    }],
  });
  try {
    // text/plain avoids a CORS preflight, the same as the site beacon
    await fetch(ICP_ENDPOINT, { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" } });
  } catch (_) {
    try { await browser.sendBeacon(ICP_ENDPOINT, body); } catch (_) {}
  }
}

const STEPS = {
  checkout_started: "checkout_started",
  checkout_contact_info_submitted: "checkout_contact_submitted",
  checkout_address_info_submitted: "checkout_address_submitted",
  checkout_shipping_info_submitted: "checkout_shipping_submitted",
  payment_info_submitted: "checkout_payment_submitted",
  checkout_completed: "checkout_completed",
};

Object.keys(STEPS).forEach((shopifyName) => {
  analytics.subscribe(shopifyName, (event) => send(STEPS[shopifyName], event));
});
