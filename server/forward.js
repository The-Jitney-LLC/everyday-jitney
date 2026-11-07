"use strict";

/*
 * Sends a JSON payload to a Make webhook URL.
 * - 8-second timeout, one retry after 2 seconds.
 * - With no URL set, logs the payload instead (useful for local testing).
 */
// Make webhooks with "API key authentication" turned on reject requests that lack
// the x-make-apikey header (HTTP 401 "Unauthorized."). The key lives only in Render.
function makeHeaders() {
  const h = { "Content-Type": "application/json" };
  const key = process.env.MAKE_WEBHOOK_API_KEY || "";
  if (key) h["x-make-apikey"] = key;
  return h;
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: makeHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function forward(url, payload, label, { required = false } = {}) {
  if (!url) {
    if (required) throw new Error(`[${label}] required Make webhook URL is missing`);
    console.warn(`[${label}] Make webhook URL is missing; event not delivered`);
    return false;
  }
  try {
    await postJson(url, payload);
    return true;
  } catch (err) {
    console.warn(`[${label}] forward failed (${err.message}); retrying once`);
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await postJson(url, payload);
      return true;
    } catch (err2) {
      console.error(`[${label}] forward failed twice: ${err2.message}`);
      if (required) throw err2;
      return false;
    }
  }
}

module.exports = { forward, makeHeaders };
