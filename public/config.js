/*
 * Everyday Jitney — site settings
 * ------------------------------------------------------------------
 * This is the ONLY file you need to edit to go live.
 *
 * Leave shopifyDomain or storefrontToken empty and the site runs in
 * PREVIEW MODE: it shows labeled sample products and checkout is off.
 *
 * The Storefront API token is a PUBLIC token (Shopify designs it to be
 * used in the browser). Never put an Admin API token or a webhook
 * secret in this file — those go in the server's .env file.
 */
window.EJ_CONFIG = {
  // Your Shopify store's myshopify address, e.g. "everyday-jitney.myshopify.com"
  shopifyDomain: "zd-store-01m6bmrz5nygffs23a0hskcaa8.myshopify.com", // confirm in Shopify Admin > Settings > Domains

  // Shopify Admin > Sales channels > Headless > your storefront > Storefront API token
  storefrontToken: "",

  // Storefront API version. Shopify supports each version for about 12 months;
  // check https://shopify.dev/docs/api/usage/versioning and bump when needed.
  apiVersion: "2026-07",

  // How shoppers pay:
  //   "stripe"  = your back end creates a Stripe Checkout Session and the shopper
  //               pays on Stripe's hosted page (card numbers never touch this site).
  //   "shopify" = Shopify's hosted checkout (needed for automatic Collective forwarding).
  checkoutProvider: "stripe",

  // Your back end's address, used for Stripe checkout. No trailing slash.
  //   e.g. "https://api.everydayjitney.com"
  apiBase: "",

  // Where the ICP beacon sends events. Point this at your back end:
  //   "https://api.everydayjitney.com/api/icp"  (recommended)
  // Leave empty to keep the beacon off (events are still logged to the console).
  icpEndpoint: "",

  // Cookie domain for the ICP session, so checkout.everydayjitney.com can read it.
  // Use ".everydayjitney.com" in production; leave empty for local testing.
  cookieDomain: "",

  // Shown in the cart. Set to the amount your store actually offers, or 0 to hide.
  freeShippingThreshold: 0,

  // Contact shown in the footer
  supportEmail: "thejitney4u@gmail.com",
};
