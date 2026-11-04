/*
 * Everyday Jitney — back end
 * ------------------------------------------------------------------
 * Routes
 *   GET  /api/health          quick "is it up" check
 *   POST /api/checkout        creates a Stripe Checkout Session from the cart
 *                             (prices checked against Shopify) and returns its URL
 *   POST /webhooks/stripe     Stripe payment events: creates the paid Shopify order,
 *                             then sends a ledger row to Make (Sales Worksheet)
 *   POST /api/icp             receives ICP beacon batches (site + checkout pixel),
 *                             cleans them, forwards to your Make webhook
 *   POST /webhooks/shopify    receives Shopify order webhooks, verifies the
 *                             HMAC signature, normalizes the event, forwards to Make
 *
 * Optional: set SERVE_STATIC=true to also serve the storefront from ../public,
 * so one host runs both the site and the API.
 *
 * Settings come from environment variables (see .env.example).
 */
"use strict";

const path = require("path");

// Load .env for local runs without adding a dependency (must run before the other modules read settings).
try { process.loadEnvFile(path.join(__dirname, "..", ".env")); } catch (_) { /* no .env file: use real env vars */ }

const crypto = require("crypto");
const express = require("express");
const { forward } = require("./forward");
const { normalizeShopifyEvent } = require("./shopify-events");
const stripeCheckout = require("./stripe-checkout");
const { stripeWebhookHandler } = require("./stripe-webhook");

const PORT = Number(process.env.PORT || 8787);
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || "";
const MAKE_ICP_WEBHOOK_URL = process.env.MAKE_ICP_WEBHOOK_URL || "";
const MAKE_ORDERS_WEBHOOK_URL = process.env.MAKE_ORDERS_WEBHOOK_URL || "";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // behind Render / Railway / Fly proxies

/* ---------------- CORS (only for the beacon route) ---------------- */
function cors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes("*"))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}

/* ---------------- tiny in-memory rate limit ---------------- */
const hits = new Map();
function rateLimit(limitPerMinute) {
  return (req, res, next) => {
    const key = req.ip || "unknown";
    const now = Date.now();
    const rec = hits.get(key) || { n: 0, reset: now + 60_000 };
    if (now > rec.reset) { rec.n = 0; rec.reset = now + 60_000; }
    rec.n += 1;
    hits.set(key, rec);
    if (rec.n > limitPerMinute) return res.sendStatus(429);
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now > v.reset) hits.delete(k); }, 60_000).unref();

/* ---------------- health ---------------- */
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    checkout: stripeCheckout.configured() ? "stripe" : "not configured",
    stripeWebhookSecretSet: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    shopifyAdminTokenSet: Boolean(process.env.SHOPIFY_ADMIN_TOKEN),
    salesLedgerForwarding: Boolean(process.env.MAKE_SALES_WEBHOOK_URL),
    icpForwarding: Boolean(MAKE_ICP_WEBHOOK_URL),
    orderForwarding: Boolean(MAKE_ORDERS_WEBHOOK_URL),
    webhookSecretSet: Boolean(SHOPIFY_WEBHOOK_SECRET),
    time: new Date().toISOString(),
  });
});

/* ---------------- ICP beacon ---------------- */
const MAX_EVENTS = 50;
function clip(v, depth = 0) {
  if (v == null) return v;
  if (typeof v === "string") return v.slice(0, 500);
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (depth > 3) return undefined;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clip(x, depth + 1));
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).slice(0, 40)) out[k.slice(0, 60)] = clip(v[k], depth + 1);
    return out;
  }
  return undefined;
}

app.options("/api/icp", cors);
app.post(
  "/api/icp",
  cors,
  rateLimit(240),
  express.text({ type: ["text/plain", "application/json"], limit: "64kb" }),
  (req, res) => {
    let payload;
    try { payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body; } catch (_) { return res.sendStatus(400); }
    if (!payload || !Array.isArray(payload.events) || !payload.events.length) return res.sendStatus(400);

    const events = payload.events.slice(0, MAX_EVENTS)
      .filter((e) => e && typeof e.event === "string" && typeof e.session_id === "string")
      .map((e) => ({
        event: e.event.slice(0, 40),
        seq: Number(e.seq) || null,
        ts_ms: Number(e.ts_ms) || null,
        iso: typeof e.iso === "string" ? e.iso.slice(0, 40) : null,
        session_id: e.session_id.slice(0, 80),
        page: typeof e.page === "string" ? e.page.slice(0, 300) : null,
        data: clip(e.data) || {},
      }));
    if (!events.length) return res.sendStatus(400);

    // Answer right away; the browser is often leaving the page.
    res.sendStatus(204);

    const batch = {
      type: "icp_batch",
      source: payload.source === "shopify_checkout_pixel" ? "checkout" : "site",
      site: String(payload.site || "").slice(0, 120),
      received_at: new Date().toISOString(),
      received_ts_ms: Date.now(),
      sent_ts_ms: Number(payload.sent_ts_ms) || null,
      count: events.length,
      events,
    };
    forward(MAKE_ICP_WEBHOOK_URL, batch, "icp");
  }
);

/* ---------------- Stripe checkout ---------------- */
app.options("/api/checkout", cors);
app.post("/api/checkout", cors, rateLimit(30), express.json({ limit: "32kb" }), async (req, res) => {
  try {
    const { url, event } = await stripeCheckout.createCheckout(req.body || {});
    res.json({ url });
    forward(MAKE_ORDERS_WEBHOOK_URL, event, "orders");
  } catch (err) {
    const status = err.status || 502;
    if (status >= 500) console.error("[checkout]", err.message);
    res.status(status).json({ error: status >= 500 && !err.status ? "Checkout is unavailable right now. Please try again in a minute." : err.message });
  }
});

/* ---------------- Stripe webhooks ---------------- */
app.post("/webhooks/stripe", express.raw({ type: "*/*", limit: "1mb" }), stripeWebhookHandler);

/* ---------------- Shopify webhooks ---------------- */
const seenWebhookIds = new Set();
function rememberWebhook(id) {
  if (!id) return false;
  if (seenWebhookIds.has(id)) return true;
  seenWebhookIds.add(id);
  if (seenWebhookIds.size > 5000) seenWebhookIds.delete(seenWebhookIds.values().next().value);
  return false;
}

function validShopifyHmac(rawBody, hmacHeader) {
  if (!SHOPIFY_WEBHOOK_SECRET || !hmacHeader) return false;
  const digest = crypto.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET).update(rawBody).digest();
  let given;
  try { given = Buffer.from(hmacHeader, "base64"); } catch (_) { return false; }
  return given.length === digest.length && crypto.timingSafeEqual(given, digest);
}

app.post("/webhooks/shopify", express.raw({ type: "*/*", limit: "2mb" }), (req, res) => {
  if (!validShopifyHmac(req.body, req.get("X-Shopify-Hmac-Sha256"))) return res.sendStatus(401);

  const topic = req.get("X-Shopify-Topic") || "";
  const webhookId = req.get("X-Shopify-Webhook-Id") || "";
  // Shopify retries until it gets a 2xx; ignore repeats of the same delivery.
  if (rememberWebhook(webhookId)) return res.sendStatus(200);

  let body;
  try { body = JSON.parse(req.body.toString("utf8")); } catch (_) { return res.sendStatus(400); }

  res.sendStatus(200); // Shopify expects a fast 2xx

  const event = normalizeShopifyEvent(topic, body, {
    webhookId,
    shopDomain: req.get("X-Shopify-Shop-Domain") || "",
    triggeredAt: req.get("X-Shopify-Triggered-At") || null,
  });
  if (event) forward(MAKE_ORDERS_WEBHOOK_URL, event, "orders");
});

/* ---------------- optional static site ---------------- */
if (String(process.env.SERVE_STATIC).toLowerCase() === "true") {
  app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"], maxAge: "1h" }));
}

app.use((_req, res) => res.sendStatus(404));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Everyday Jitney API on :${PORT}`);
    if (!MAKE_ICP_WEBHOOK_URL) console.warn("MAKE_ICP_WEBHOOK_URL not set: ICP events are logged, not forwarded.");
    if (!MAKE_ORDERS_WEBHOOK_URL) console.warn("MAKE_ORDERS_WEBHOOK_URL not set: order events are logged, not forwarded.");
    if (!SHOPIFY_WEBHOOK_SECRET) console.warn("SHOPIFY_WEBHOOK_SECRET not set: all Shopify webhooks will be rejected.");
  });
}

module.exports = { app, validShopifyHmac };
