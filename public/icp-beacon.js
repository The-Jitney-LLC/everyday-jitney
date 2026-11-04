/*
 * ICP beacon — Everyday Jitney
 * ------------------------------------------------------------------
 * What it records (and nothing else):
 *   page_view          session ID, landing page, referrer, UTM tags
 *   page_engagement    visible time on the page, deepest scroll %
 *   product_view       which product was opened
 *   product_engagement visible time on that product, scroll depth,
 *                      image clicks, variant selections
 *   add_to_cart, cart_update, checkout_start
 *
 * Timing:
 *   - Every event carries ts_ms: performance.timeOrigin + performance.now(),
 *     i.e. epoch milliseconds with sub-millisecond precision.
 *   - "Visible time" counts only while the tab is visible (Page Visibility API).
 *   - Events are batched and sent every 12 s, and flushed with
 *     navigator.sendBeacon on visibilitychange (hidden) and pagehide.
 *
 * The session ID lives in a first-party cookie (icp_sid). Set
 * EJ_CONFIG.cookieDomain to ".everydayjitney.com" so the Shopify custom
 * pixel on checkout.everydayjitney.com can read the same ID.
 *
 * Shoppers who send the Global Privacy Control signal are not tracked.
 */
(function () {
  "use strict";

  var CFG = window.EJ_CONFIG || {};
  var ENDPOINT = CFG.icpEndpoint || "";
  var COOKIE = "icp_sid";
  var SESSION_IDLE_MS = 30 * 60 * 1000;
  var FLUSH_EVERY_MS = 12000;
  var MAX_BATCH = 50;

  var optedOut = navigator.globalPrivacyControl === true;

  /* ---------- time ---------- */
  function nowMs() {
    var t = performance.timeOrigin + performance.now();
    return Math.round(t * 1000) / 1000; // epoch ms, 3 decimals
  }

  /* ---------- storage helpers (never throw) ---------- */
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }

  function readCookie(name) {
    try {
      var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }
  function writeCookie(name, value, maxAgeSec) {
    try {
      var c = name + "=" + encodeURIComponent(value) + "; Max-Age=" + maxAgeSec + "; Path=/; SameSite=Lax";
      if (CFG.cookieDomain) c += "; Domain=" + CFG.cookieDomain;
      if (location.protocol === "https:") c += "; Secure";
      document.cookie = c;
    } catch (e) {}
  }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  /* ---------- session ---------- */
  var sessionId = readCookie(COOKIE) || ssGet(COOKIE);
  var isNewSession = !sessionId;
  if (!sessionId) sessionId = newId();
  function touchSession() {
    writeCookie(COOKIE, sessionId, SESSION_IDLE_MS / 1000); // rolling 30-min idle window
    ssSet(COOKIE, sessionId);
  }
  touchSession();

  // Landing page, referrer and UTMs are captured once per session.
  var source = null;
  try { source = JSON.parse(ssGet("icp_src") || "null"); } catch (e) {}
  if (!source || isNewSession) {
    var q = new URLSearchParams(location.search);
    source = {
      landing_page: location.pathname + location.search,
      referrer: document.referrer || null,
      utm_source: q.get("utm_source"),
      utm_medium: q.get("utm_medium"),
      utm_campaign: q.get("utm_campaign"),
      utm_term: q.get("utm_term"),
      utm_content: q.get("utm_content"),
    };
    ssSet("icp_src", JSON.stringify(source));
  }

  /* ---------- queue + transport ---------- */
  var queue = [];
  var seq = 0;

  function track(name, data) {
    if (optedOut) return;
    touchSession();
    queue.push({
      event: name,
      seq: ++seq,
      ts_ms: nowMs(),
      iso: new Date().toISOString(),
      session_id: sessionId,
      page: location.pathname + location.hash,
      data: data || {},
    });
    if (queue.length >= MAX_BATCH) flush(false);
  }

  function flush(useBeacon) {
    if (!queue.length) return;
    var batch = queue.splice(0, MAX_BATCH);
    var body = JSON.stringify({ v: 1, site: location.hostname, sent_ts_ms: nowMs(), events: batch });

    if (!ENDPOINT) {
      if (window.console && console.debug) console.debug("[ICP] (no endpoint set)", batch);
      return;
    }
    // text/plain keeps this a "simple" cross-origin request: no CORS preflight,
    // which sendBeacon cannot perform.
    var blob = new Blob([body], { type: "text/plain;charset=UTF-8" });
    var sent = false;
    if (useBeacon && navigator.sendBeacon) {
      try { sent = navigator.sendBeacon(ENDPOINT, blob); } catch (e) { sent = false; }
    }
    if (!sent) {
      try {
        fetch(ENDPOINT, { method: "POST", body: blob, keepalive: true, mode: "cors", credentials: "omit" })
          .catch(function () { queue = batch.concat(queue).slice(0, 500); }); // retry next flush
      } catch (e) {}
    }
    if (queue.length) flush(useBeacon);
  }

  setInterval(function () { flush(false); }, FLUSH_EVERY_MS);

  /* ---------- visible-time clocks ---------- */
  function VisibleClock() {
    this.total = 0;
    this.since = document.visibilityState === "visible" ? performance.now() : null;
  }
  VisibleClock.prototype.pause = function () {
    if (this.since !== null) { this.total += performance.now() - this.since; this.since = null; }
  };
  VisibleClock.prototype.resume = function () { if (this.since === null) this.since = performance.now(); };
  VisibleClock.prototype.read = function () {
    var t = this.total + (this.since !== null ? performance.now() - this.since : 0);
    return Math.round(t * 1000) / 1000; // ms, sub-ms precision
  };

  var pageClock = new VisibleClock();
  var pageMaxScroll = 0;
  var pageReported = false;

  function pageScrollPct() {
    var doc = document.documentElement;
    var max = doc.scrollHeight - window.innerHeight;
    if (max <= 0) return 100;
    return Math.min(100, Math.round((window.scrollY / max) * 100));
  }
  window.addEventListener("scroll", function () {
    var p = pageScrollPct();
    if (p > pageMaxScroll) pageMaxScroll = p;
  }, { passive: true });

  /* ---------- product engagement ---------- */
  var product = null; // { id, title, clock, maxScroll, imageClicks, variants, el }

  function productScrollPct(el) {
    if (!el) return 0;
    var max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return 100;
    return Math.min(100, Math.round((el.scrollTop / max) * 100));
  }
  function onProductScroll() {
    if (!product) return;
    var p = productScrollPct(product.el);
    if (p > product.maxScroll) product.maxScroll = p;
  }

  function productView(p, scrollEl) {
    productEnd("switched");
    product = {
      id: p.id, handle: p.handle, title: p.title,
      clock: new VisibleClock(), maxScroll: 0, imageClicks: [], variants: [], el: scrollEl || null,
      opened_ts_ms: nowMs(),
    };
    if (scrollEl) scrollEl.addEventListener("scroll", onProductScroll, { passive: true });
    onProductScroll();
    track("product_view", { product_id: p.id, handle: p.handle, title: p.title, vendor: p.vendor || null, price: p.price || null });
  }

  function productEnd(reason) {
    if (!product) return;
    product.clock.pause();
    if (product.el) product.el.removeEventListener("scroll", onProductScroll);
    track("product_engagement", {
      product_id: product.id, handle: product.handle, title: product.title,
      visible_ms: product.clock.read(),
      opened_ts_ms: product.opened_ts_ms,
      max_scroll_pct: product.maxScroll,
      image_clicks: product.imageClicks,
      variant_selections: product.variants,
      end_reason: reason || "closed",
    });
    product = null;
  }

  function imageClick(index, src) {
    if (!product) return;
    product.imageClicks.push({ index: index, src: src || null, ts_ms: nowMs(), at_visible_ms: product.clock.read() });
  }
  function variantSelect(variant) {
    if (!product) return;
    product.variants.push({ variant_id: variant.id, title: variant.title, ts_ms: nowMs(), at_visible_ms: product.clock.read() });
  }

  /* ---------- lifecycle ---------- */
  function reportPage(reason) {
    pageClock.pause();
    productEnd(reason);
    if (!pageReported) {
      track("page_engagement", { visible_ms: pageClock.read(), max_scroll_pct: Math.max(pageMaxScroll, pageScrollPct()), end_reason: reason });
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      pageClock.pause();
      if (product) product.clock.pause();
      // Send what we have now: the tab may never come back.
      track("page_hidden", { visible_ms: pageClock.read(), max_scroll_pct: pageMaxScroll });
      flush(true);
    } else {
      pageClock.resume();
      if (product) product.clock.resume();
      track("page_visible", {});
    }
  });

  window.addEventListener("pagehide", function () {
    reportPage("pagehide");
    pageReported = true;
    flush(true);
  });

  /* ---------- first event ---------- */
  track("page_view", {
    new_session: isNewSession,
    landing_page: source.landing_page,
    referrer: source.referrer,
    utm_source: source.utm_source, utm_medium: source.utm_medium, utm_campaign: source.utm_campaign,
    utm_term: source.utm_term, utm_content: source.utm_content,
    viewport: window.innerWidth + "x" + window.innerHeight,
  });

  window.ICP = {
    sessionId: function () { return sessionId; },
    track: track,
    flush: function () { flush(true); },
    productView: productView,
    productEnd: productEnd,
    imageClick: imageClick,
    variantSelect: variantSelect,
    optedOut: optedOut,
  };
})();
