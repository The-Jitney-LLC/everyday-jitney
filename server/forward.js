"use strict";

/*
 * Sends a JSON payload to a Make webhook URL.
 * - 8-second timeout, one retry after 2 seconds.
 * - With no URL set, logs the payload instead (useful for local testing).
 */
async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function forward(url, payload, label) {
  if (!url) {
    console.log(`[${label}] (no Make URL set)`, JSON.stringify(payload).slice(0, 2000));
    return;
  }
  try {
    await postJson(url, payload);
  } catch (err) {
    console.warn(`[${label}] forward failed (${err.message}); retrying once`);
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await postJson(url, payload);
    } catch (err2) {
      console.error(`[${label}] forward failed twice: ${err2.message}`);
    }
  }
}

module.exports = { forward };
