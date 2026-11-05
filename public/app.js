/*
 * Everyday Jitney — storefront app
 * ------------------------------------------------------------------
 * Catalog, product details and cart all come from the Shopify
 * Storefront API. Products imported by USAdrop, Trendsi and Shopify
 * Collective all live in your Shopify store, so this one connection
 * shows all three. Checkout goes to Stripe's hosted payment page by
 * default (checkoutProvider: "stripe"); the back end then creates the
 * paid Shopify order so each supplier receives it.
 *
 * With no Shopify settings in config.js the site runs in preview mode
 * with labeled sample products and checkout turned off.
 */
(function () {
  "use strict";

  var CFG = window.EJ_CONFIG || {};
  var LIVE = Boolean(CFG.shopifyDomain && CFG.storefrontToken);
  var ICP = window.ICP || { track: function () {}, productView: function () {}, productEnd: function () {}, imageClick: function () {}, variantSelect: function () {}, sessionId: function () { return ""; }, flush: function () {} };
  var PAGE_SIZE = 24;
  var CART_KEY = "ej_cart_id";
  var PREVIEW_CART_KEY = "ej_preview_cart";

  /* ================================================================
     Small helpers
     ================================================================ */
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(amount, currency) {
    var n = Number(amount || 0);
    try { return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(n); }
    catch (e) { return "$" + n.toFixed(2); }
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  var toastTimer;
  function toast(msg) {
    var t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  // Supplier descriptions can carry messy HTML. Keep only safe, simple tags.
  var SAFE_TAGS = { P: 1, BR: 1, UL: 1, OL: 1, LI: 1, STRONG: 1, B: 1, EM: 1, I: 1, H3: 1, H4: 1, SPAN: 1 };
  function cleanHtml(html) {
    if (!html) return "";
    var doc = new DOMParser().parseFromString("<div>" + html + "</div>", "text/html");
    var root = doc.body.firstChild;
    (function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (child) {
        if (child.nodeType === 1) {
          if (!SAFE_TAGS[child.tagName]) {
            if (/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|FORM|INPUT|BUTTON|LINK|META|IMG|SVG|VIDEO|AUDIO)$/.test(child.tagName)) { child.remove(); return; }
            walk(child);
            while (child.firstChild) node.insertBefore(child.firstChild, child);
            child.remove();
            return;
          }
          Array.prototype.slice.call(child.attributes).forEach(function (a) { child.removeAttribute(a.name); });
          walk(child);
        }
      });
    })(root);
    return root.innerHTML;
  }

  /* ================================================================
     Icons for departments (used as placeholders when a product has no photo)
     ================================================================ */
  var ICONS = {
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M10.5 18.5h3"/>',
    kitchen: '<path d="M4 20 15 9"/><path d="M15 9c1.5-1.5 4.5-3 5.5-2s-.5 4-2 5.5L16 15"/><path d="M8 4v6M6 4v4a2 2 0 0 0 4 0V4"/>',
    home: '<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5h4v5"/>',
    beauty: '<rect x="8" y="9" width="8" height="12" rx="2"/><path d="M10 9V6h4v3"/><path d="M11 3.5h2"/>',
    accessories: '<path d="M5 8h14l-1.2 12H6.2z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    tools: '<path d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z"/>',
    socks: '<path d="M8 3h6v8l3.5 3.5a3 3 0 0 1-4.2 4.2L8 13.4z"/><path d="M8 6h6"/>',
    apparel: '<path d="M8 3 4 6l2 4 2-1v12h8V9l2 1 2-4-4-3a4 4 0 0 1-8 0z"/>',
    shoes: '<path d="M3 16v-6l5 1 3 3 8 1.5a2 2 0 0 1 2 2V18H3z"/><path d="M3 18h18"/>',
    pet: '<circle cx="6" cy="10" r="1.6"/><circle cx="10" cy="6.5" r="1.6"/><circle cx="14" cy="6.5" r="1.6"/><circle cx="18" cy="10" r="1.6"/><path d="M8.5 17c0-2.5 1.6-4.5 3.5-4.5s3.5 2 3.5 4.5c0 1.5-1.5 2.5-3.5 2.5s-3.5-1-3.5-2.5z"/>',
    holiday: '<path d="M12 3 7 10h3l-4 6h4l-2 4h8l-2-4h4l-4-6h3z"/>',
    box: '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>',
  };
  function iconFor(text) {
    var t = String(text || "").toLowerCase();
    var map = [["phone", "phone"], ["tech", "phone"], ["kitchen", "kitchen"], ["home", "home"], ["beauty", "beauty"], ["health", "beauty"],
      ["accessor", "accessories"], ["tool", "tools"], ["sock", "socks"], ["apparel", "apparel"], ["cloth", "apparel"], ["fashion", "apparel"],
      ["shoe", "shoes"], ["pet", "pet"], ["holiday", "holiday"], ["christmas", "holiday"]];
    for (var i = 0; i < map.length; i++) if (t.indexOf(map[i][0]) !== -1) return ICONS[map[i][1]];
    return ICONS.box;
  }
  function placeholder(dept, label) {
    return '<div class="placeholder" aria-hidden="true"><svg viewBox="0 0 24 24">' + iconFor(dept) + "</svg>" +
      (label ? "<span>" + esc(label) + "</span>" : "") + "</div>";
  }

  /* ================================================================
     Shopify Storefront API
     ================================================================ */
  function sf(query, variables) {
    var url = "https://" + CFG.shopifyDomain + "/api/" + (CFG.apiVersion || "2026-07") + "/graphql.json";
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Storefront-Access-Token": CFG.storefrontToken },
      body: JSON.stringify({ query: query, variables: variables || {} }),
    }).then(function (r) {
      if (!r.ok) throw new Error("Shopify returned " + r.status);
      return r.json();
    }).then(function (j) {
      if (j.errors && j.errors.length) throw new Error(j.errors[0].message);
      return j.data;
    });
  }

  var PRODUCT_FIELDS =
    "id handle title vendor productType availableForSale descriptionHtml " +
    "featuredImage { url(transform:{maxWidth:1100}) width height altText } " +
    "images(first: 50) { nodes { url(transform:{maxWidth:1600}) width height altText } } " +
    "options { name optionValues { name } } " +
    "priceRange { minVariantPrice { amount currencyCode } } " +
    "compareAtPriceRange { minVariantPrice { amount currencyCode } } " +
    "variants(first: 100) { nodes { id title availableForSale quantityAvailable " +
    "  price { amount currencyCode } compareAtPrice { amount currencyCode } " +
    "  selectedOptions { name value } image { url(transform:{maxWidth:1100}) altText } } }";

  // quantityAvailable needs the unauthenticated_read_product_inventory scope; if
  // the token lacks it Shopify errors, so we retry once without the field.
  var useQuantity = true;
  function productFields() { return useQuantity ? PRODUCT_FIELDS : PRODUCT_FIELDS.replace(" quantityAvailable", ""); }
  function sfProducts(query, vars) {
    return sf(query.replace("__FIELDS__", productFields()), vars).catch(function (err) {
      if (useQuantity && /quantityAvailable|inventory/i.test(err.message)) { useQuantity = false; return sf(query.replace("__FIELDS__", productFields()), vars); }
      throw err;
    });
  }

  // Supplier photos reviewed November 5. Empty approved lists mean all supplied
  // gallery photos were cropped; keep those products out of browsing until replaced.
  var REVIEWED_MEDIA = {
  "gid://shopify/Product/15508137672924": {
    "approved": [
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/e5b704ae02fcbd2c45db291750df11d3-v3-gen-Max-Origin.webp?v=1793851881",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/2ada6b0a05fe7fab5f51ff0f1fc7af9f-v3-gen-Max-Origin.webp?v=1793851881",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/9ba756211a5dbb54146a96e1b80e4748-v3-gen-Max-Origin.webp?v=1793851880",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/ebabb1686afc179168921518fad312eb-v3-gen-Max-Origin.webp?v=1793851881"
    ],
    "status": "reviewed"
  },
  "gid://shopify/Product/15508137083100": {
    "approved": [
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/d316dd96-ecd9-450d-a337-06b3e835f5f7-Max-Origin.webp?v=1793851870",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/3036f18c-d695-4ee7-99c0-4c65217f7e9a-Max-Origin.webp?v=1793851869",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/39482e6b-7c49-46fe-abff-6c12e94f40f5-Max-Origin.webp?v=1793851869",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/561577f3-69e0-4061-80d4-1b229ba331f3-Max-Origin.webp?v=1793851869",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/3849ecd7-9413-4577-972a-5a69340be8f4-Max-Origin.webp?v=1793851870",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/39cf0ddd-52f2-4d51-b6c3-18e3290a7abc-Max-Origin.webp?v=1793851870",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/18f3b507-b975-43a2-9f06-643670550f19-Max-Origin.webp?v=1793851870",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/f7a1f16f-a32a-4fd2-9422-e924845c2f21-Max-Origin.webp?v=1793851870",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/7c4c65fb-8d19-4f98-9148-df4a884efa03-Max-Origin.webp?v=1793851869",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/486a4d55-6195-474e-b388-62fbcbacd5ee-Max-Origin.webp?v=1793851870",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/e3757034-fdc6-47af-895a-006bcb94706a-Max-Origin.webp?v=1793851869",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/557c33fc-9c39-4685-b7ec-b7f461ea0fc2-Max-Origin.webp?v=1793851869",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/a9c6999b-c5e0-470f-86b2-b5fe9d7470ef-Max-Origin.webp?v=1793851869",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/1c8a574e-4b80-4366-9da6-f78079bd11ff-Max-Origin.webp?v=1793851870",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/e05eeaa5-526b-483a-86f1-12336e342d52-Max-Origin.webp?v=1793851870",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/9482b562-1591-4f44-b2d3-ea4ad3e2f2eb-Max-Origin.webp?v=1793851870",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/57555438-4b96-4ba8-aec4-76ad01a81efc-Max-Origin.webp?v=1793851870",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/7356b1cc-9862-413c-96de-14e18ef6e506-Max-Origin.webp?v=1793851870",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/e9a44eff-1288-4152-9bde-693b98b2b04e-Max-Origin.webp?v=1793851870",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/b1e10e48-893b-4634-8c1f-c5ec38dc3501-Max-Origin.webp?v=1793851870"
    ],
    "status": "reviewed"
  },
  "gid://shopify/Product/15508136558812": {
    "approved": [],
    "status": "reviewed"
  },
  "gid://shopify/Product/15508136165596": {
    "approved": [
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/67da1e9bae4047978776c1ecc7d21fda-Max.jpg?v=1793851850",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/e5f8be862b964398b92c7fb65c2888b6-Max.jpg?v=1793851851",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/8c578117038f48d58764c1c9a1ec2369-Max.jpg?v=1793851851",
      "https://cdn.shopify.com/s/files/1/0867/3899/3372/files/bdd5a255a6974775a0d656d0de3ecd72-Max.jpg?v=1793851851"
    ],
    "status": "reviewed"
  },
  "gid://shopify/Product/15508135248092": {
    "approved": [],
    "status": "reviewed"
  },
  "gid://shopify/Product/15508133052636": {
    "approved": [],
    "status": "reviewed"
  },
  "gid://shopify/Product/15508130005212": {
    "approved": [],
    "status": "reviewed"
  },
  "gid://shopify/Product/15508127121628": {
    "approved": [],
    "status": "reviewed"
  }
};
  function mediaKey(url) { try { return new URL(url).pathname.replace(/_(?:[0-9]+x[0-9]*)(?=\.)/, ""); } catch (_) { return url; } }
  function approvedMedia(id, url) {
    var review = REVIEWED_MEDIA[id];
    return !review || review.approved.some(function (u) { return mediaKey(u) === mediaKey(url); });
  }
  function normalize(p, deptTitle) {
    var review = REVIEWED_MEDIA[p.id];
    if (review) {
      var supplied = (p.images && p.images.nodes) || [];
      var approved = supplied.filter(function (im) { return approvedMedia(p.id, im.url); });
      p.images = { nodes: approved };
      p.featuredImage = approved[0] || null;
    }
    var variants = (p.variants && p.variants.nodes) || [];
    var min = p.priceRange.minVariantPrice;
    var cmp = p.compareAtPriceRange && p.compareAtPriceRange.minVariantPrice;
    return {
      id: p.id, handle: p.handle, title: p.title, vendor: p.vendor,
      dept: deptTitle || p.productType || "",
      available: p.availableForSale,
      descriptionHtml: p.descriptionHtml,
      mediaBlocked: Boolean(review && !review.approved.length),
      image: p.featuredImage ? p.featuredImage.url : null,
      imageAlt: p.title,
      imageWidth: p.featuredImage && p.featuredImage.width,
      imageHeight: p.featuredImage && p.featuredImage.height,
      images: ((p.images && p.images.nodes) || []).map(function (i) { return { url: i.url, width: i.width, height: i.height, alt: p.title }; }),
      options: (p.options || []).map(function (o) { return { name: o.name, values: (o.optionValues || []).map(function (v) { return v.name; }) }; })
        .filter(function (o) { return !(o.name === "Title" && o.values.length === 1 && o.values[0] === "Default Title"); }),
      price: Number(min.amount), currency: min.currencyCode,
      compareAt: cmp && Number(cmp.amount) > Number(min.amount) ? Number(cmp.amount) : null,
      variants: variants.map(function (v) {
        return {
          id: v.id, title: v.title, available: v.availableForSale, qty: v.quantityAvailable == null ? null : v.quantityAvailable,
          price: Number(v.price.amount), currency: v.price.currencyCode,
          compareAt: v.compareAtPrice ? Number(v.compareAtPrice.amount) : null,
          options: v.selectedOptions, image: v.image && approvedMedia(p.id, v.image.url) ? v.image.url : null,
        };
      }),
      sample: false,
    };
  }

  var SORT_MAP = {
    collection: { BEST_SELLING: ["BEST_SELLING", false], CREATED: ["CREATED", true], PRICE_ASC: ["PRICE", false], PRICE_DESC: ["PRICE", true], TITLE: ["TITLE", false] },
    all: { BEST_SELLING: ["BEST_SELLING", false], CREATED: ["CREATED_AT", true], PRICE_ASC: ["PRICE", false], PRICE_DESC: ["PRICE", true], TITLE: ["TITLE", false] },
  };

  function liveFetchProducts(opts) {
    var after = opts.after || null;
    if (opts.collection === "__christmas" || opts.collection === "__black-friday") {
      var seasonal = opts.collection === "__christmas" ? "(tag:christmas OR title:christmas OR tag:holiday)" : '(tag:black-friday OR tag:"Black Friday")';
      return liveFetchProducts({query:seasonal, sort:opts.sort, after:after});
    }
    if (opts.collection) {
      var s = SORT_MAP.collection[opts.sort] || SORT_MAP.collection.BEST_SELLING;
      return sfProducts(
        "query($h:String!,$n:Int!,$a:String,$k:ProductCollectionSortKeys,$r:Boolean){ collection(handle:$h){ title products(first:$n, after:$a, sortKey:$k, reverse:$r){ pageInfo{hasNextPage endCursor} nodes{ __FIELDS__ } } } }",
        { h: opts.collection, n: PAGE_SIZE, a: after, k: s[0], r: s[1] }
      ).then(function (d) {
        if (!d.collection) return { items: [], next: null };
        var c = d.collection;
        return { items: c.products.nodes.map(function (p) { return normalize(p, c.title); }), next: c.products.pageInfo.hasNextPage ? c.products.pageInfo.endCursor : null };
      });
    }
    var s2 = opts.query ? ["RELEVANCE", false] : (SORT_MAP.all[opts.sort] || SORT_MAP.all.BEST_SELLING);
    if (opts.query && opts.sort !== "BEST_SELLING") s2 = SORT_MAP.all[opts.sort];
    var q = opts.query ? opts.query + " available_for_sale:true" : null;
    return sfProducts(
      "query($n:Int!,$a:String,$q:String,$k:ProductSortKeys,$r:Boolean){ products(first:$n, after:$a, query:$q, sortKey:$k, reverse:$r){ pageInfo{hasNextPage endCursor} nodes{ __FIELDS__ } } }",
      { n: PAGE_SIZE, a: after, q: q, k: s2[0], r: s2[1] }
    ).then(function (d) {
      return { items: d.products.nodes.map(function (p) { return normalize(p); }), next: d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null };
    });
  }

  function liveFetchDepartments() {
    return sf("{ collections(first: 30, sortKey: TITLE) { nodes { handle title products(first:1){ nodes { id } } } } }")
      .then(function (d) {
        return d.collections.nodes
          .filter(function (c) { return c.products.nodes.length && c.handle !== "frontpage" && c.handle !== "all"; })
          .map(function (c) { return { handle: c.handle, title: c.title }; });
      });
  }

  function liveFetchShop() {
    return sf("{ shop { name privacyPolicy{title url} refundPolicy{title url} shippingPolicy{title url} termsOfService{title url} } }")
      .then(function (d) { return d.shop; });
  }

  /* ---------- live cart ---------- */
  var CART_FIELDS =
    "id checkoutUrl totalQuantity cost { subtotalAmount { amount currencyCode } } " +
    "lines(first: 100) { nodes { id quantity cost { totalAmount { amount currencyCode } } " +
    "  merchandise { ... on ProductVariant { id title image { url(transform:{maxWidth:160}) } " +
    "    price { amount currencyCode } product { id title handle productType } } } } }";

  function cartFromApi(c) {
    if (!c) return null;
    return {
      id: c.id, checkoutUrl: c.checkoutUrl, count: c.totalQuantity,
      subtotal: Number(c.cost.subtotalAmount.amount), currency: c.cost.subtotalAmount.currencyCode,
      lines: c.lines.nodes.map(function (l) {
        var m = l.merchandise;
        return {
          id: l.id, qty: l.quantity, variantId: m.id, title: m.product.title, dept: m.product.productType,
          variant: m.title === "Default Title" ? "" : m.title, image: m.image && approvedMedia(m.product.id, m.image.url) ? m.image.url : null,
          lineTotal: Number(l.cost.totalAmount.amount), currency: l.cost.totalAmount.currencyCode,
        };
      }),
    };
  }
  function userErr(res) {
    if (res && res.userErrors && res.userErrors.length) throw new Error(res.userErrors[0].message);
    return res;
  }
  var LiveCart = {
    load: function () {
      var id = lsGet(CART_KEY);
      if (!id) return Promise.resolve(null);
      return sf("query($id:ID!){ cart(id:$id){ " + CART_FIELDS + " } }", { id: id }).then(function (d) {
        if (!d.cart) { lsDel(CART_KEY); return null; } // cart finished checkout or expired
        return cartFromApi(d.cart);
      });
    },
    add: function (variantId, qty) {
      var id = lsGet(CART_KEY);
      if (!id) {
        return sf("mutation($i:CartInput!){ cartCreate(input:$i){ cart{ " + CART_FIELDS + " } userErrors{ message } } }", {
          i: {
            lines: [{ merchandiseId: variantId, quantity: qty }],
            // Ties the order back to the ICP session (arrives on the order webhook as a note attribute).
            attributes: [{ key: "icp_session_id", value: ICP.sessionId() }],
          },
        }).then(function (d) {
          userErr(d.cartCreate);
          lsSet(CART_KEY, d.cartCreate.cart.id);
          return cartFromApi(d.cartCreate.cart);
        });
      }
      return sf("mutation($c:ID!,$l:[CartLineInput!]!){ cartLinesAdd(cartId:$c, lines:$l){ cart{ " + CART_FIELDS + " } userErrors{ message } } }", {
        c: id, l: [{ merchandiseId: variantId, quantity: qty }],
      }).then(function (d) {
        if (!d.cartLinesAdd.cart) { lsDel(CART_KEY); return LiveCart.add(variantId, qty); }
        userErr(d.cartLinesAdd);
        return cartFromApi(d.cartLinesAdd.cart);
      });
    },
    update: function (lineId, qty) {
      var id = lsGet(CART_KEY);
      if (qty <= 0) {
        return sf("mutation($c:ID!,$l:[ID!]!){ cartLinesRemove(cartId:$c, lineIds:$l){ cart{ " + CART_FIELDS + " } userErrors{ message } } }", { c: id, l: [lineId] })
          .then(function (d) { userErr(d.cartLinesRemove); return cartFromApi(d.cartLinesRemove.cart); });
      }
      return sf("mutation($c:ID!,$l:[CartLineUpdateInput!]!){ cartLinesUpdate(cartId:$c, lines:$l){ cart{ " + CART_FIELDS + " } userErrors{ message } } }", { c: id, l: [{ id: lineId, quantity: qty }] })
        .then(function (d) { userErr(d.cartLinesUpdate); return cartFromApi(d.cartLinesUpdate.cart); });
    },
  };

  /* ================================================================
     Preview data (only used when Shopify isn't connected yet)
     No ratings or review counts: those must come from real customers.
     ================================================================ */
  var PREVIEW_DEPTS = [
    { handle: "phone-tech", title: "Phone & Tech" },
    { handle: "kitchen", title: "Kitchen" },
    { handle: "home", title: "Home" },
    { handle: "health-beauty", title: "Health & Beauty" },
    { handle: "accessories", title: "Accessories" },
    { handle: "tools", title: "Tools" },
    { handle: "socks-care", title: "Socks & Care" },
    { handle: "apparel", title: "Apparel" },
    { handle: "shoes", title: "Shoes" },
    { handle: "pet", title: "Pet" },
  ];
  function sample(i, dept, title, price, desc, options) {
    var d = PREVIEW_DEPTS.filter(function (x) { return x.handle === dept; })[0];
    var opts = options || [];
    var combos = [[]];
    opts.forEach(function (o) {
      var next = [];
      combos.forEach(function (c) { o.values.forEach(function (v) { next.push(c.concat([{ name: o.name, value: v }])); }); });
      combos = next;
    });
    return {
      id: "sample-" + i, handle: "sample-" + i, title: title, vendor: "Sample", dept: d.title, deptHandle: dept,
      available: true, descriptionHtml: "<p>" + esc(desc) + "</p><p>Sample listing for layout review. Your real product copy and photos load from Shopify.</p>",
      image: null, images: [], options: opts, price: price, currency: "USD", compareAt: null, sample: true,
      variants: combos.map(function (c, k) {
        return { id: "sample-" + i + "-v" + k, title: c.length ? c.map(function (x) { return x.value; }).join(" / ") : "Default Title", available: true, qty: null, price: price, currency: "USD", compareAt: null, options: c, image: null };
      }),
    };
  }
  var PREVIEW_PRODUCTS = [
    sample(1, "phone-tech", "Clear Silicone Phone Case", 24.99, "Soft, transparent case that shows your phone's design while guarding against drops and scratches.", [{ name: "Model", values: ["iPhone 16", "iPhone 16 Pro", "Galaxy S25"] }]),
    sample(2, "phone-tech", "Rugged Dual-Layer Case", 34.99, "Hard outer shell with a soft inner layer. Raised edges protect the screen and camera.", [{ name: "Color", values: ["Black", "Navy", "Olive"] }]),
    sample(3, "phone-tech", "Tempered Glass Screen Protector", 21.99, "9H hardness glass, clear and fingerprint resistant, with an alignment frame for easy install."),
    sample(4, "phone-tech", "Braided USB-C Cable, 2 m", 22.99, "Braided nylon cable with reinforced ends. Supports fast charging."),
    sample(5, "phone-tech", "30W GaN Wall Charger", 39.99, "Compact fast charger built on GaN parts, so it runs cooler and smaller."),
    sample(6, "phone-tech", "Magnetic Car Mount", 29.99, "Strong magnetic mount for dash or air vent. Attach and remove with one hand."),
    sample(7, "kitchen", "Vegetable Chopper", 34.99, "Manual chopper that dices and slices vegetables quickly."),
    sample(8, "kitchen", "Silicone Baking Mat", 24.99, "Reusable non-stick mat that replaces parchment paper. Heat resistant.", [{ name: "Size", values: ["Half sheet", "Quarter sheet"] }]),
    sample(9, "kitchen", "5-Piece Kitchen Knife Set", 89.99, "High-carbon stainless steel knives for everyday cutting and chopping."),
    sample(10, "kitchen", "Bamboo Cutting Board", 29.99, "Bamboo board in a practical everyday size."),
    sample(11, "home", "Stackable Pantry Bins, Set of 4", 44.99, "Clear stackable bins that keep shelves and cabinets organized."),
    sample(12, "health-beauty", "Facial Cleansing Brush", 39.99, "Soft silicone brush with two speeds. Rechargeable and water resistant."),
    sample(13, "accessories", "Canvas Crossbody Bag", 49.99, "Everyday crossbody with an adjustable strap and zip pockets.", [{ name: "Color", values: ["Sand", "Black"] }]),
    sample(14, "socks-care", "Cushioned Crew Socks, 6 Pairs", 24.99, "Soft cotton-blend socks with a cushioned sole.", [{ name: "Size", values: ["S/M", "L/XL"] }]),
    sample(15, "apparel", "Men's Classic Crew T-Shirt", 22.99, "Soft cotton crew neck for everyday wear.", [{ name: "Size", values: ["S", "M", "L", "XL", "2XL"] }, { name: "Color", values: ["White", "Navy", "Heather"] }]),
    sample(16, "pet", "Collapsible Pet Bowl", 21.99, "Folding silicone bowl for walks and travel."),
  ];
  var previewCart = [];
  try { previewCart = JSON.parse(lsGet(PREVIEW_CART_KEY) || "[]"); } catch (e) { previewCart = []; }
  function previewCartView() {
    var subtotal = 0, count = 0;
    var lines = previewCart.map(function (l) {
      var p = PREVIEW_PRODUCTS.filter(function (x) { return x.id === l.productId; })[0];
      if (!p) return null;
      var v = p.variants.filter(function (x) { return x.id === l.variantId; })[0] || p.variants[0];
      subtotal += v.price * l.qty; count += l.qty;
      return { id: l.variantId, qty: l.qty, variantId: v.id, title: p.title, dept: p.dept, variant: v.title === "Default Title" ? "" : v.title, image: null, lineTotal: v.price * l.qty, currency: "USD" };
    }).filter(Boolean);
    return { id: "preview", checkoutUrl: null, count: count, subtotal: subtotal, currency: "USD", lines: lines };
  }
  var PreviewCart = {
    load: function () { return Promise.resolve(previewCartView()); },
    add: function (variantId, qty, product) {
      var line = previewCart.filter(function (l) { return l.variantId === variantId; })[0];
      if (line) line.qty += qty; else previewCart.push({ productId: product.id, variantId: variantId, qty: qty });
      lsSet(PREVIEW_CART_KEY, JSON.stringify(previewCart));
      return Promise.resolve(previewCartView());
    },
    update: function (lineId, qty) {
      previewCart = previewCart.map(function (l) { if (l.variantId === lineId) l.qty = qty; return l; }).filter(function (l) { return l.qty > 0; });
      lsSet(PREVIEW_CART_KEY, JSON.stringify(previewCart));
      return Promise.resolve(previewCartView());
    },
  };
  var Cart = LIVE ? LiveCart : PreviewCart;
  var USE_STRIPE = (CFG.checkoutProvider || "stripe") === "stripe";
  var checkoutBusy = false;

  // Stripe: the server checks every price against Shopify, creates a Checkout
  // Session, and sends back the hosted payment page address.
  function startStripeCheckout(btn) {
    checkoutBusy = true;
    btn.disabled = true;
    btn.textContent = "Opening secure checkout…";
    return fetch(CFG.apiBase.replace(/\/$/, "") + "/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lines: state.cart.lines.map(function (l) { return { variantId: l.variantId, quantity: l.qty }; }),
        icpSessionId: ICP.sessionId(),
      }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j.url) throw new Error(j.error || "Checkout is unavailable right now. Please try again in a minute.");
        return j.url;
      });
    }).then(function (url) {
      ICP.flush();
      window.location.href = url;
    }).catch(function (err) {
      checkoutBusy = false;
      btn.textContent = "Check out securely";
      renderCart();
      toast(err.message);
    });
  }

  /* ================================================================
     State + rendering
     ================================================================ */
  var state = { depts: [], collection: "home-kitchen", collectionTitle: "Home & Kitchen", query: "", sort: "BEST_SELLING", items: [], next: null, loading: false, cart: null };
  var productCache = {};

  function renderRoutes() {
    var priority = ["health-beauty", "home-kitchen", "phone-accessories", "bags-accessories"];
    var ordered = state.depts.slice().sort(function(a,b){ var x=priority.indexOf(a.handle),y=priority.indexOf(b.handle);return (x<0?99:x)-(y<0?99:y); });
    var all = [{ handle: "", title: "All products" }, { handle: "__black-friday", title: "Black Friday Deals" }].concat(ordered);
    $("#routes").innerHTML = all.map(function (d) {
      return '<button class="route" type="button" data-collection="' + esc(d.handle) + '" aria-pressed="' + (d.handle === state.collection && !state.query) + '"><span class="pip" aria-hidden="true"></span>' + esc(d.title) + "</button>";
    }).join("");
    var stops = state.depts.slice(0, 6);
    $("#stops").innerHTML = stops.map(function (d, i) {
      return '<li><button type="button" data-collection="' + esc(d.handle) + '"><span class="node" aria-hidden="true"></span><span class="stop-name">' + esc(d.title) + '</span><span class="stop-num mono">' + String(i + 1).padStart(2, "0") + "</span></button></li>";
    }).join("");
  }

  function priceHtml(price, compareAt, currency) {
    return money(price, currency) + (compareAt ? "<s>" + money(compareAt, currency) + "</s>" : "");
  }

  function cardHtml(p) {
    productCache[p.id] = p;
    var tag = "";
    if (p.sample) tag = '<span class="card-tag">Sample</span>';
    else if (!p.available) tag = '<span class="card-tag">Sold out</span>';
    else if (p.compareAt) tag = '<span class="card-tag sale">Sale</span>';
    var media = p.image
      ? '<img src="' + esc(p.image) + '" alt="' + esc(p.imageAlt) + '" loading="lazy" decoding="async"' + (p.imageWidth && p.imageHeight ? ' width="' + p.imageWidth + '" height="' + p.imageHeight + '"' : '') + ' />'
      : placeholder(p.dept, p.sample ? "Supplier photo" : "No photo yet");
    var single = p.variants.length === 1;
    return '<article class="card" data-product-handle="' + esc(p.handle) + '">' +
      '<button class="card-media" type="button" data-open="' + esc(p.id) + '" aria-label="View ' + esc(p.title) + '">' + media + tag + "</button>" +
      '<div class="card-body">' +
        (p.dept ? '<span class="card-dept">' + esc(p.dept) + "</span>" : "") +
        '<h3 class="card-title"><button type="button" data-open="' + esc(p.id) + '">' + esc(p.title) + "</button></h3>" +
        '<div class="card-foot"><span class="price">' + (p.variants.length > 1 && hasPriceRange(p) ? "From " : "") + priceHtml(p.price, p.compareAt, p.currency) + "</span>" +
          (single
            ? '<button class="add" type="button" data-quick="' + esc(p.id) + '"' + (p.available ? "" : " disabled") + ">" + (p.available ? "Add to cart" : "Sold out") + "</button>"
            : '<button class="add" type="button" data-open="' + esc(p.id) + '"' + (p.available ? "" : " disabled") + ">" + (p.available ? "Choose options" : "Sold out") + "</button>") +
        "</div>" +
      "</div></article>";
  }
  function hasPriceRange(p) {
    var prices = p.variants.map(function (v) { return v.price; });
    return Math.min.apply(null, prices) !== Math.max.apply(null, prices);
  }

  function renderGrid(append) {
    var grid = $("#grid");
    grid.setAttribute("aria-busy", "false");
    if (!state.items.length) {
      grid.innerHTML = '<div class="empty">' + (state.query
        ? "No products match “" + esc(state.query) + "”. Try a shorter word, or browse a department above."
        : "No products in this department yet.") + "</div>";
    } else if (append) {
      grid.insertAdjacentHTML("beforeend", state.items.slice(append).map(cardHtml).join(""));
    } else {
      grid.innerHTML = state.items.map(cardHtml).join("");
    }
    $("#catalogTitle").textContent = state.query ? "Results for “" + state.query + "”" : state.collectionTitle;
    $("#catalogCount").textContent = state.items.length ? state.items.length + (state.next ? "+" : "") + " product" + (state.items.length === 1 ? "" : "s") : "";
    $("#loadMore").hidden = !state.next;
  }

  function showSkeletons() {
    var g = $("#grid");
    g.setAttribute("aria-busy", "true");
    g.innerHTML = new Array(8).join("x").split("x").map(function () { return '<div class="skeleton" aria-hidden="true"></div>'; }).join("");
  }

  function loadProducts(more) {
    if (state.loading) return;
    state.loading = true;
    if (!more) showSkeletons();
    var opts = { collection: state.collection, query: state.query, sort: state.sort, after: more ? state.next : null };
    var job = LIVE ? liveFetchProducts(opts) : Promise.resolve(previewFetch(opts));
    job.then(function (res) {
      var before = state.items.length;
      var lo = Number(CFG.priceMin || 0), hi = Number(CFG.priceMax || 0);
      var fresh = res.items.filter(function (p) { return !p.mediaBlocked && (!lo || p.price >= lo) && (!hi || p.price <= hi); });
      state.items = more ? state.items.concat(fresh) : fresh;
      state.next = res.next;
      renderGrid(more ? before : 0);
    }).catch(function (err) {
      console.error(err);
      $("#grid").innerHTML = '<div class="empty">We couldn’t load products right now. Refresh the page to try again.</div>';
    }).then(function () { state.loading = false; });
  }

  function previewFetch(opts) {
    var items = PREVIEW_PRODUCTS.filter(function (p) {
      if (opts.collection && p.deptHandle !== opts.collection) return false;
      if (opts.query) return (p.title + " " + p.dept).toLowerCase().indexOf(opts.query.toLowerCase()) !== -1;
      return true;
    }).slice();
    var s = opts.sort;
    if (s === "PRICE_ASC") items.sort(function (a, b) { return a.price - b.price; });
    if (s === "PRICE_DESC") items.sort(function (a, b) { return b.price - a.price; });
    if (s === "TITLE") items.sort(function (a, b) { return a.title.localeCompare(b.title); });
    if (s === "CREATED") items.reverse();
    return { items: items, next: null };
  }

  function setCollection(handle) {
    var d = state.depts.filter(function (x) { return x.handle === handle; })[0];
    state.collection = handle || "";
    state.collectionTitle = handle === "__christmas" ? "Christmas Specials" : handle === "__black-friday" ? "Black Friday Deals" : d ? d.title : "All products";
    state.query = "";
    $("#searchInput").value = "";
    renderRoutes();
    ICP.track("department_select", { collection: state.collection || "all" });
    loadProducts(false);
  }

  /* ================================================================
     Product detail
     ================================================================ */
  var pdp = { product: null, selected: {}, qty: 1, imageIndex: 0, returnFocus: null };

  function currentVariant() {
    var p = pdp.product;
    return p.variants.filter(function (v) {
      return v.options.every(function (o) { return pdp.selected[o.name] === o.value; });
    })[0] || p.variants[0];
  }

  function openProduct(id, trigger) {
    var p = productCache[id];
    if (!p) return;
    pdp.product = p;
    pdp.qty = 1;
    pdp.imageIndex = 0;
    pdp.returnFocus = trigger || document.activeElement;
    var first = p.variants.filter(function (v) { return v.available; })[0] || p.variants[0];
    pdp.selected = {};
    (first.options || []).forEach(function (o) { pdp.selected[o.name] = o.value; });
    renderPdp();
    $("#scrim").hidden = false;
    $("#pdp").hidden = false;
    document.body.style.overflow = "hidden";
    $("#pdpClose").focus();
    ICP.productView({ id: p.id, handle: p.handle, title: p.title, vendor: p.vendor, price: p.price }, $("#pdp"));
  }

  function closeProduct() {
    if ($("#pdp").hidden) return;
    ICP.productEnd("closed");
    $("#pdp").hidden = true;
    if ($("#drawer").hidden) { $("#scrim").hidden = true; document.body.style.overflow = ""; }
    if (pdp.returnFocus && pdp.returnFocus.focus) pdp.returnFocus.focus();
  }

  function galleryImages(p, v) {
    var imgs = p.images.slice();
    if (v && v.image && !imgs.some(function (i) { return i.url === v.image; })) imgs.unshift({ url: v.image, alt: p.title });
    return imgs;
  }

  function renderPdp() {
    var p = pdp.product, v = currentVariant();
    var imgs = galleryImages(p, v);
    if (v.image) {
      var idx = imgs.map(function (i) { return i.url; }).indexOf(v.image);
      if (idx >= 0 && pdp.lastVariant !== v.id) pdp.imageIndex = idx;
    }
    pdp.lastVariant = v.id;
    var main = imgs[pdp.imageIndex];
    var stockText = !v.available ? "Sold out" : (v.qty != null && v.qty > 0 && v.qty <= 5 ? "Only " + v.qty + " left" : "In stock");

    $("#pdpBody").innerHTML =
      '<div class="gallery">' +
        '<div class="gallery-main">' + (main ? '<img src="' + esc(main.url) + '" alt="' + esc(main.alt) + '" />' : placeholder(p.dept, p.sample ? "Supplier photo" : "")) + "</div>" +
        (imgs.length > 1 ? '<div class="thumbs">' + imgs.map(function (im, i) {
          return '<button type="button" data-img="' + i + '" aria-label="Show image ' + (i + 1) + '" aria-current="' + (i === pdp.imageIndex) + '"><img src="' + esc(im.url) + '" alt="" /></button>';
        }).join("") + "</div>" : "") +
      "</div>" +
      '<div class="pdp-info">' +
        (p.dept ? '<span class="card-dept">' + esc(p.dept) + "</span>" : "") +
        '<h2 id="pdpTitle">' + esc(p.title) + "</h2>" +
        '<div class="pdp-price">' + priceHtml(v.price, v.compareAt && v.compareAt > v.price ? v.compareAt : null, v.currency) + "</div>" +
        p.options.map(function (o) {
          return '<fieldset class="option"><legend>' + esc(o.name) + ": <span>" + esc(pdp.selected[o.name] || "") + "</span></legend><div class=\"chips\">" +
            o.values.map(function (val) {
              var trial = Object.assign({}, pdp.selected); trial[o.name] = val;
              var match = p.variants.filter(function (vv) { return vv.options.every(function (x) { return trial[x.name] === x.value; }); })[0];
              var avail = match && match.available;
              return '<button type="button" class="chip' + (avail ? "" : " unavailable") + '" data-opt="' + esc(o.name) + '" data-val="' + esc(val) + '" aria-pressed="' + (pdp.selected[o.name] === val) + '">' + esc(val) + "</button>";
            }).join("") + "</div></fieldset>";
        }).join("") +
        '<p class="stock' + (v.available ? "" : " out") + '">' + stockText + "</p>" +
        '<div class="pdp-buy">' +
          '<div class="qty" aria-label="Quantity"><button type="button" data-q="-1" aria-label="Decrease quantity">−</button><span id="pdpQty">' + pdp.qty + '</span><button type="button" data-q="1" aria-label="Increase quantity">+</button></div>' +
          '<button class="btn btn-primary" type="button" id="pdpAdd"' + (v.available ? "" : " disabled") + ">" + (v.available ? "Add to cart · " + money(v.price * pdp.qty, v.currency) : "Sold out") + "</button>" +
        "</div>" +
        '<div class="pdp-desc">' + (cleanHtml(p.descriptionHtml) || "<p>Details coming soon.</p>") + "</div>" +
      "</div>";
  }

  /* ================================================================
     Cart drawer
     ================================================================ */
  function renderCart() {
    var c = state.cart || { count: 0, lines: [], subtotal: 0, currency: "USD" };
    var badge = $("#cartCount");
    if (String(c.count) !== badge.textContent) { badge.classList.remove("bump"); void badge.offsetWidth; badge.classList.add("bump"); }
    badge.textContent = c.count || 0;
    $("#cartOpen").setAttribute("aria-label", "Open cart, " + (c.count || 0) + " item" + (c.count === 1 ? "" : "s"));
    $("#cartLines").innerHTML = c.lines.length ? c.lines.map(function (l) {
      return '<div class="line">' +
        '<div class="line-thumb">' + (l.image ? '<img src="' + esc(l.image) + '" alt="" />' : placeholder(l.dept, "")) + "</div>" +
        "<div><div class=\"line-title\">" + esc(l.title) + "</div>" + (l.variant ? '<div class="line-variant">' + esc(l.variant) + "</div>" : "") +
          '<div class="qty"><button type="button" data-line="' + esc(l.id) + '" data-set="' + (l.qty - 1) + '" aria-label="Decrease quantity">−</button><span>' + l.qty + '</span><button type="button" data-line="' + esc(l.id) + '" data-set="' + (l.qty + 1) + '" aria-label="Increase quantity">+</button></div>' +
          '<div><button class="remove" type="button" data-line="' + esc(l.id) + '" data-set="0">Remove</button></div></div>' +
        '<div class="line-price">' + money(l.lineTotal, l.currency) + "</div></div>";
    }).join("") : '<div class="drawer-empty">Your cart is empty.<br />Pick something from a department to get started.</div>';
    $("#cartSubtotal").textContent = money(c.subtotal, c.currency);

    var th = Number(CFG.freeShippingThreshold || 0), note = $("#shipNote");
    if (th > 0 && c.count) {
      note.hidden = false;
      note.textContent = c.subtotal >= th ? "Your order ships free." : money(th - c.subtotal, c.currency) + " away from free shipping.";
    } else note.hidden = true;

    var btn = $("#checkoutBtn"), hint = $("#checkoutHint");
    var ready = LIVE && (!USE_STRIPE || Boolean(CFG.apiBase));
    btn.disabled = !c.count || !ready || checkoutBusy;
    hint.textContent = !LIVE ? "Checkout turns on once Shopify is connected."
      : !ready ? "Checkout turns on once the payment server is connected."
      : USE_STRIPE ? "You'll pay on Stripe's secure checkout page." : "You'll finish on our secure Shopify checkout.";
  }

  function openCart() {
    $("#scrim").hidden = false;
    $("#drawer").hidden = false;
    document.body.style.overflow = "hidden";
    $("#cartClose").focus();
    ICP.track("cart_open", { items: state.cart ? state.cart.count : 0 });
  }
  function closeCart() {
    if ($("#drawer").hidden) return;
    $("#drawer").hidden = true;
    if ($("#pdp").hidden) { $("#scrim").hidden = true; document.body.style.overflow = ""; }
    $("#cartOpen").focus();
  }

  function addToCart(product, variant, qty, btn) {
    if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = "Adding…"; }
    return Cart.add(variant.id, qty, product).then(function (c) {
      state.cart = c;
      renderCart();
      toast("Added " + product.title + (variant.title !== "Default Title" ? " (" + variant.title + ")" : ""));
      ICP.track("add_to_cart", { product_id: product.id, variant_id: variant.id, title: product.title, variant: variant.title, qty: qty, price: variant.price });
    }).catch(function (err) {
      console.error(err);
      toast("Couldn't add that item. Please try again.");
    }).then(function () {
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label; }
    });
  }

  /* ================================================================
     Events
     ================================================================ */
  document.addEventListener("click", function (e) {
    var t = e.target.closest("button, a");
    if (!t) return;

    if (t.hasAttribute("data-collection")) {
      e.preventDefault();
      setCollection(t.getAttribute("data-collection"));
      if (t.closest(".ticket") || t.closest(".brand")) $("#catalog").scrollIntoView({ behavior: "smooth" });
      return;
    }
    if (t.dataset.open) { openProduct(t.dataset.open, t); return; }
    if (t.dataset.quick) {
      var p = productCache[t.dataset.quick];
      if (p) addToCart(p, p.variants[0], 1, t);
      return;
    }
    if (t.id === "loadMore") { loadProducts(true); return; }
    if (t.id === "cartOpen") { openCart(); return; }
    if (t.id === "cartClose") { closeCart(); return; }
    if (t.id === "pdpClose") { closeProduct(); return; }

    // product detail controls
    if (t.dataset.opt) {
      pdp.selected[t.dataset.opt] = t.dataset.val;
      var v = currentVariant();
      ICP.variantSelect({ id: v.id, title: v.title });
      renderPdp();
      var again = document.querySelector('.chip[data-opt="' + CSS.escape(t.dataset.opt) + '"][data-val="' + CSS.escape(t.dataset.val) + '"]');
      if (again) again.focus();
      return;
    }
    if (t.dataset.img) {
      pdp.imageIndex = Number(t.dataset.img);
      var im = galleryImages(pdp.product, currentVariant())[pdp.imageIndex];
      ICP.imageClick(pdp.imageIndex, im && im.url);
      renderPdp();
      return;
    }
    if (t.dataset.q) {
      pdp.qty = Math.max(1, Math.min(20, pdp.qty + Number(t.dataset.q)));
      renderPdp();
      return;
    }
    if (t.id === "pdpAdd") {
      addToCart(pdp.product, currentVariant(), pdp.qty, t).then(function () { closeProduct(); openCart(); });
      return;
    }

    // cart controls
    if (t.dataset.line) {
      var qty = Number(t.dataset.set);
      t.disabled = true;
      Cart.update(t.dataset.line, qty).then(function (c) {
        state.cart = c; renderCart();
        ICP.track("cart_update", { line: t.dataset.line, qty: qty });
      }).catch(function () { toast("Couldn't update your cart. Please try again."); renderCart(); });
      return;
    }
    if (t.id === "checkoutBtn") {
      if (!LIVE || !state.cart || !state.cart.count || checkoutBusy) return;
      ICP.track("checkout_start", { provider: USE_STRIPE ? "stripe" : "shopify", items: state.cart.count, subtotal: state.cart.subtotal, currency: state.cart.currency });
      if (USE_STRIPE) { startStripeCheckout(t); return; }
      if (!state.cart.checkoutUrl) return;
      ICP.flush();
      window.location.href = state.cart.checkoutUrl;
    }
  });

  // Main gallery image click counts as an image interaction too.
  document.addEventListener("click", function (e) {
    var img = e.target.closest(".gallery-main img");
    if (img) ICP.imageClick(pdp.imageIndex, img.getAttribute("src"));
  });

  $("#scrim").addEventListener("click", function () { closeProduct(); closeCart(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { if (!$("#pdp").hidden) closeProduct(); else closeCart(); }
    if (e.key === "Tab") {
      var box = !$("#pdp").hidden ? $("#pdp") : (!$("#drawer").hidden ? $("#drawer") : null);
      if (!box) return;
      var f = box.querySelectorAll("button:not([disabled]), a[href], input, select");
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });

  var searchTimer;
  $("#searchForm").addEventListener("submit", function (e) { e.preventDefault(); runSearch(); });
  $("#searchInput").addEventListener("input", function () { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 350); });
  function runSearch() {
    var q = $("#searchInput").value.trim();
    if (q === state.query) return;
    state.query = q;
    if (!q) { setCollection(state.collection); return; }
    state.collection = "";
    renderRoutes();
    ICP.track("search", { query_length: q.length });
    loadProducts(false);
  }

  $("#sortSelect").addEventListener("change", function (e) {
    state.sort = e.target.value;
    ICP.track("sort_change", { sort: state.sort });
    loadProducts(false);
  });

  /* ================================================================
     Boot
     ================================================================ */
  $("#year").textContent = new Date().getFullYear();
  $("#supportEmail").textContent = CFG.supportEmail || "";
  $("#previewNote").hidden = LIVE;

  function renderPolicies(shop) {
    var list = shop ? [shop.shippingPolicy, shop.refundPolicy, shop.privacyPolicy, shop.termsOfService].filter(Boolean) : [];
    $("#policyLinks").innerHTML = '<span class="mono">STORE POLICIES</span><a href="enterprise-agreement.html">Enterprise agreement</a><button type="button" id="privacyChoices">Privacy choices</button>' + (list.length
      ? list.map(function (p) { return '<a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.title) + "</a>"; }).join("")
      : "<span>Shipping, returns, privacy and terms appear here once they're set in Shopify.</span>");
    $("#privacyChoices").addEventListener("click", function () { if (window.EJConsent) window.EJConsent.open(); });
  }

  if (LIVE) {
    liveFetchDepartments().then(function (d) { state.depts = d; renderRoutes(); }).catch(function (e) { console.error(e); renderRoutes(); });
    liveFetchShop().then(renderPolicies).catch(function () { renderPolicies(null); });
  } else {
    state.depts = PREVIEW_DEPTS;
    renderRoutes();
    renderPolicies(null);
  }
  // Coming back from Stripe
  (function handleReturn() {
    var q = new URLSearchParams(location.search);
    var status = q.get("checkout");
    if (!status) return;
    if (status === "success") {
      ICP.track("checkout_return", { status: "success", stripe_session_id: q.get("session_id") });
      lsDel(CART_KEY); lsDel(PREVIEW_CART_KEY); previewCart = [];
      setTimeout(function () { toast("Thank you! Your order is in. A receipt is on its way to your email."); }, 300);
    } else {
      ICP.track("checkout_return", { status: "cancelled" });
      setTimeout(function () { toast("Checkout cancelled. Your cart is still here."); }, 300);
    }
    try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) {}
  })();

  loadProducts(false);
  Cart.load().then(function (c) { state.cart = c; renderCart(); }).catch(function () { state.cart = null; renderCart(); });
  renderCart();
})();

