"use strict";

/*
 * Shopify Admin API access token
 * ------------------------------------------------------------------
 * Shopify retired legacy "Develop apps" custom apps. Apps built in the Dev
 * Dashboard never show a permanent token; the server exchanges the app's
 * Client ID + Client secret for a token (client credentials grant). Each
 * token lasts 24 hours, so it is cached and renewed automatically.
 *
 * Render settings (preferred):
 *   SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET   from Dev Dashboard > app > Settings
 * Fallback (legacy only):
 *   SHOPIFY_ADMIN_TOKEN                        a permanent shpat_ token
 */

const SHOP = () => process.env.SHOPIFY_STORE_DOMAIN || "";
const CLIENT_ID = () => process.env.SHOPIFY_CLIENT_ID || "";
const CLIENT_SECRET = () => process.env.SHOPIFY_CLIENT_SECRET || "";
const STATIC_TOKEN = () => process.env.SHOPIFY_ADMIN_TOKEN || "";

let cached = null; // { token, expiresAt }
let pending = null;

function usesClientCredentials() {
  return Boolean(CLIENT_ID() && CLIENT_SECRET());
}

function adminConfigured() {
  return Boolean(SHOP() && (usesClientCredentials() || STATIC_TOKEN()));
}

function authMode() {
  if (usesClientCredentials()) return "client_credentials";
  if (STATIC_TOKEN()) return "static_token";
  return "not configured";
}

async function requestToken() {
  const res = await fetch(`https://${SHOP()}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID(),
      client_secret: CLIENT_SECRET(),
    }).toString(),
    signal: AbortSignal.timeout(10000),
  });
  let json = {};
  try { json = await res.json(); } catch (_) { /* non-JSON error body */ }
  if (!res.ok || !json.access_token) {
    const why = json.error_description || json.error || `HTTP ${res.status}`;
    throw new Error(`Shopify token request failed: ${why}`);
  }
  const lifetimeSec = Number(json.expires_in) || 86399;
  // Renew five minutes early so a token never expires mid-request.
  cached = { token: json.access_token, expiresAt: Date.now() + Math.max(60, lifetimeSec - 300) * 1000 };
  return cached.token;
}

async function getAdminToken() {
  if (!usesClientCredentials()) return STATIC_TOKEN();
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  if (!pending) pending = requestToken().finally(() => { pending = null; });
  return pending;
}

// Call after Shopify answers 401 so the next call fetches a fresh token.
function invalidateAdminToken() { cached = null; }

module.exports = { getAdminToken, invalidateAdminToken, adminConfigured, authMode, usesClientCredentials };
