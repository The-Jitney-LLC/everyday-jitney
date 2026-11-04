# Everyday Jitney

Storefront and back end for **www.everydayjitney.com**, a store of The Jitney LLC.

- **Front end** (`public/`): plain HTML, CSS and JavaScript. No build step. Loads every product from your Shopify store through the Storefront API, so items imported by **USAdrop**, **Trendsi** and **Shopify Collective** all appear automatically.
- **Payments**: the cart's "Check out securely" button asks the back end for a **Stripe Checkout** page. Shoppers type their card only on Stripe's hosted page, so card numbers never touch this site, the server, or Make.
- **Back end** (`server/`): a small Node/Express service. It checks every price against Shopify, creates the Stripe Checkout Session, receives the ICP beacon, and forwards events to Make.
- **Checkout tracking**: the site records every step up to the hand-off to Stripe and the return afterward. Stripe reports the payment itself to your Stripe "Watch Events" webhook in Make.

```
everyday-jitney/
├── public/                  ← the website (published to GitHub Pages)
│   ├── index.html
│   ├── styles.css
│   ├── app.js               catalog, product details, cart, checkout hand-off
│   ├── icp-beacon.js        ICP tracking (ms timing, visible time, scroll, clicks)
│   ├── config.js            ← the only file you edit to go live
│   ├── CNAME                www.everydayjitney.com
│   └── assets/jitney-logo.svg
├── server/                  ← the back end (host on Render, Railway, etc.)
│   ├── index.js             routes: /api/health, /api/icp, /webhooks/shopify
│   ├── stripe-checkout.js   builds Stripe Checkout Sessions from Shopify prices
│   ├── stripe-webhook.js    payment → paid Shopify order → Sales Worksheet row
│   ├── forward.js           sends to Make with timeout + one retry
│   └── shopify-events.js    maps Shopify topics to your event names
├── shopify/custom-pixel.js  only if you switch checkoutProvider to "shopify"
├── test/server.test.js      npm test
├── .github/workflows/pages.yml
├── render.yaml
├── .env.example
└── CHANGES.md               everything that was changed and why
```

---

## How an order flows

```
Shopper ─ browses www.everydayjitney.com ─ ICP beacon ──▶ /api/icp ──▶ Make (ICP webhook)
   │
   └─ "Check out securely" ──▶ /api/checkout
         │  prices checked in Shopify
         │  Stripe Checkout Session created ──▶ Make (orders webhook: checkout_created)
         ▼
   Stripe hosted payment page  (card typed here only)
         │
         ├─ Stripe ──▶ /webhooks/stripe ──▶ paid Shopify order ──▶ USAdrop / Trendsi ship it
         │                         └─ ledger row ──▶ Make ──▶ Sales Worksheet V1 (Stripe Sales Ledger)
         ▼
   Back to www.everydayjitney.com/?checkout=success
```

## Launch checklist

### 1. Shopify: products and access
1. Install the **USAdrop** and **Trendsi** apps and import the products you want to sell.
2. Create **collections** for your departments. Each one becomes a tab in the navy department bar.
3. Install the **Headless** sales channel, create a storefront, and copy its **public Storefront API token**. Turn on product listings and inventory access.
4. **Publish your products to the Headless channel.**
5. Confirm your store's `.myshopify.com` address under Settings → Domains. It's prefilled as `sihxha-06.myshopify.com`.
6. Swap `public/assets/jitney-logo.svg` for your original logo if you have a sharper file (or upload a PNG and change the three `jitney-logo.svg` references in `public/index.html`).

### 2. Fill in `public/config.js`
```js
shopifyDomain: "sihxha-06.myshopify.com",
storefrontToken: "public token from step 1.3",
checkoutProvider: "stripe",
apiBase: "https://api.everydayjitney.com",
icpEndpoint: "https://api.everydayjitney.com/api/icp",
cookieDomain: ".everydayjitney.com",
```

### 3. Back end
1. **render.com → New → Blueprint** → pick this repository.
2. Enter these values in Render's Environment settings (never in GitHub):
   - `STRIPE_SECRET_KEY`: start with your `sk_test_` key
   - `SHOPIFY_STOREFRONT_TOKEN`: same token as config.js
   - `MAKE_ORDERS_WEBHOOK_URL`: the Compass Rose custom webhook
   - `MAKE_ICP_WEBHOOK_URL`: a separate custom webhook for ICP events
   - optional `FLAT_SHIPPING_CENTS` and `FREE_SHIPPING_OVER_CENTS`
3. Add the custom domain `api.everydayjitney.com` (CNAME record at your registrar, as Render shows).
4. Open `https://api.everydayjitney.com/api/health`: it should show `"checkout": "stripe"`.

### 4. GitHub: publish the site
1. Create a repository and upload everything **except** `node_modules` and any `.env` file.
2. **Settings → Pages → Source: GitHub Actions.** The workflow publishes `public/` on every push to `main`.
3. **Custom domain**: `www.everydayjitney.com`, then add the CNAME record `www` → `<your-github-username>.github.io` and tick **Enforce HTTPS**.

### 5. Stripe webhook (payments → Shopify → Sales Worksheet)
1. Stripe Dashboard → Developers → Webhooks → **Add endpoint**: `https://api.everydayjitney.com/webhooks/stripe`.
2. Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.created`.
3. Copy its **signing secret** (`whsec_…`) into Render as `STRIPE_WEBHOOK_SECRET`.
4. Optional: to collect Michigan sales tax, add your registration under Stripe Dashboard → Tax, then set `STRIPE_AUTOMATIC_TAX=true`.

### 6. Shopify admin token (so paid orders reach your suppliers)
1. Shopify Admin → Settings → Apps and sales channels → **Develop apps** → Create app "Everyday Jitney orders".
2. Admin API scopes: `write_orders`, `read_products`, `read_inventory`. Install the app.
3. Copy the **Admin API access token** (`shpat_…`) into Render as `SHOPIFY_ADMIN_TOKEN`. It's shown only once.
4. On each product in Shopify, fill in **Cost per item** so the ledger can show cost of goods and profit.

What happens on every payment, automatically:

1. Stripe tells `/webhooks/stripe` the payment succeeded (signature checked).
2. The server creates the **paid Shopify order** (same items, address and amount). USAdrop and Trendsi pick it up and ship. The Shopify order number is written back onto the Stripe payment, so a retry never makes a second order.
3. The server sends one ledger record to the Make webhook **Everyday Jitney - Sales Ledger**, and the scenario **Everyday Jitney - Stripe Sales to Sales Worksheet** adds a row to **Sales Worksheet V1 → Stripe Sales Ledger**.
4. Refunds and disputes add their own negative rows and tag the Shopify order.

Shopify Collective forwards orders placed through Shopify checkout. Test one Collective item end to end before selling Collective products this way.

The Make blueprint is saved in `make/sales-ledger-blueprint.json`.

### 7. Test before announcing
1. With `sk_test_` keys, add an item, check out with Stripe's test card `4242 4242 4242 4242`, and return to the site.
2. In Make, confirm: ICP events, `checkout_created`, then Stripe's `checkout.session.completed`, all carrying the same ICP session ID (`client_reference_id` on the Stripe session).
3. Confirm the Shopify order appeared (tag `stripe`), the supplier app received it, and a row landed on **Stripe Sales Ledger** with the **Pilot Summary** totals updated.
4. Swap in your live Stripe key.

## Run it locally

```bash
npm install
cp .env.example .env      # fill in what you have; blank values are fine for a look
npm run dev               # site + API at http://localhost:8787
npm test                  # back-end tests
```

With blank Make URLs, the server prints events to the console instead of forwarding them.

## Privacy

The beacon records page views, time on page, scroll depth, product image clicks and option choices against a random session ID. It does not record names, emails or card details. Shoppers whose browser sends the Global Privacy Control signal are not tracked. Mention this tracking in the privacy policy you set in Shopify; the footer links to it automatically.
