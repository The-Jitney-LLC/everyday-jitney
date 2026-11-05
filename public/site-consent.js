/* Unified entry acknowledgment; stored locally, not a server-side signature receipt. */
(function () {
  'use strict';
  var version = '2026-11-05-unified-1', saved = null;
  function privacySignal() { return navigator.globalPrivacyControl === true || navigator.doNotTrack === '1'; }
  function clearAnalytics() {
    try {
      var domain = (window.EJ_CONFIG || {}).cookieDomain;
      document.cookie = 'icp_sid=; Max-Age=0; Path=/; SameSite=Lax';
      if (domain) document.cookie = 'icp_sid=; Max-Age=0; Path=/; SameSite=Lax; Domain=' + domain;
      sessionStorage.removeItem('icp_sid'); sessionStorage.removeItem('icp_src');
    } catch (_) {}
  }
  try { saved = JSON.parse(localStorage.getItem('ej_consent') || 'null'); } catch (_) {}
  var valid = Boolean(saved && saved.version === version && saved.terms === true);
  window.EJ_CONSENT = valid ? Object.assign({}, saved, {analytics: saved.analytics === true && !privacySignal()}) : {version: version, analytics: false};
  if (!window.EJ_CONSENT.analytics) clearAnalytics();
  function show() {
    var old = document.getElementById('ejConsent'); if (old) old.remove();
    var d = document.createElement('dialog'); d.id = 'ejConsent'; d.className = 'consent-dialog';
    d.setAttribute('aria-labelledby', 'ejConsentTitle');
    d.innerHTML = '<form method="dialog"><img src="assets/jitney-logo.svg" alt="The Jitney LLC" width="173" height="81">' +
      '<h2 id="ejConsentTitle">Everyday Jitney access agreement</h2>' +
      '<p>One agreement covers access to our store, browsing products, and the analytics described below. Review the <a href="enterprise-agreement.html" target="_blank" rel="noopener">enterprise agreement and analytics notice</a>.</p>' +
      '<h3>Browsing analytics included</h3><p>When you choose “Agree &amp; enter,” you also allow The Jitney LLC to use ICP analytics to record a random session identifier, page and product views, clicks, cart activity, referral and campaign information, and visible browsing time. Events are sent to our Make.com analytics workflow to understand shopping activity and improve the store. We do not record what you type or your card details.</p>' +
      '<label class="consent-check"><input type="checkbox" required id="ejTerms"> <span>I have read and accept the enterprise agreement and the analytics notice shown here.</span></label>' +
      '<p class="fine">Analytics starts only after acceptance. Browser privacy signals take precedence. You can change your choice using Privacy choices in the footer.</p>' +
      (privacySignal() ? '<p role="status"><strong>Your browser privacy signal is active. Analytics will remain off.</strong></p>' : '') +
      '<div class="consent-actions"><button class="btn btn-primary" value="analytics">Agree &amp; enter</button>' +
      '<button class="btn btn-ghost" value="essential">Accept terms without analytics</button></div></form>';
    document.body.append(d);
    d.addEventListener('cancel', function (e) { e.preventDefault(); });
    d.addEventListener('close', function () {
      if (d.returnValue !== 'analytics' && d.returnValue !== 'essential') return;
      var choice = {version: version, accepted_at: new Date().toISOString(), terms: true,
        analytics: d.returnValue === 'analytics' && !privacySignal(), choice: d.returnValue};
      try { localStorage.setItem('ej_consent', JSON.stringify(choice)); } catch (_) {
        // No reload loop when browser storage is blocked: keep terms visible and explain.
        d.querySelector('.fine').textContent = 'Your browser could not save this choice. Enable site storage and try again. Analytics remains off.';
        d.showModal(); return;
      }
      window.EJ_CONSENT = choice; if (!choice.analytics) clearAnalytics(); location.reload();
    });
    d.showModal();
  }
  window.EJConsent = {open: show, revoke: function () {
    try { localStorage.removeItem('ej_consent'); } catch (_) {}
    clearAnalytics(); location.reload();
  }};
  document.addEventListener('DOMContentLoaded', function () { if (!valid) show(); });
})();
