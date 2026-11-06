/*
 * Everyday Jitney — site settings
 * The Storefront API token is a PUBLIC token (Shopify designs it to be
 * used in the browser). Never put an Admin API token or a webhook
 * secret in this file — those go in Render's Environment settings.
 */
window.EJ_CONFIG = {
  // Shopify Admin > Settings shows this address
  shopifyDomain: "sihxha-06.myshopify.com",

  // Shopify Admin > Headless > storefront > Storefront API > Public access token
  storefrontToken: "88ad50965309e27e130de9083cf2d73f",

  // Storefront API version
  apiVersion: "2026-07",

  // "stripe" = shoppers pay on Stripe's hosted page
  checkoutProvider: "stripe",

  // Your back end's address (filled in after Render is set up). No trailing slash.
  apiBase: "https://everyday-jitney-api.onrender.com",

  // Dedicated public Make analytics webhook. Telemetry only; never proof of payment.
  icpEndpoint: "https://hook.us2.make.com/11n6hwxmgsb3wophsx2phn300d1h3xan",

  // Use ".everydayjitney.com" once the domain is connected
  cookieDomain: "",

  // Only products priced in this range (USD) appear on the site. Use 0 for no limit.
  priceMin: 0,
  priceMax: 0,

  // Shown in the cart. 0 hides the free-shipping note.
  freeShippingThreshold: 0,

  // Contact shown in the footer
  supportEmail: "thejitney4u@gmail.com",
};
