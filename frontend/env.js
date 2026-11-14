// Picks the Worker that this page talks to, from the page's own hostname.
// Loaded before app.js / dashboard.js on every page. See docs/ENVIRONMENTS.md.
//
//   localhost                               -> local dev   (wrangler dev on :8787)
//   edu-live-frontend-staging.<sub>.workers.dev -> staging (edu-live-worker-staging.<sub>...)
//   edu-live-frontend.buildminds-co-in.workers.dev -> production
//   anything else                           -> workerUrl null (no fallback to prod)
(function () {
  "use strict";

  var PROD_HOST = "edu-live-frontend.buildminds-co-in.workers.dev";
  var STAGING_PREFIX = "edu-live-frontend-staging.";
  var PROD_WORKER = "https://edu-live-worker.buildminds-co-in.workers.dev";
  var host = window.location.hostname;

  var name = "unknown";
  var workerUrl = null;

  if (host === "localhost" || host === "127.0.0.1") {
    name = "local";
    workerUrl = "http://localhost:8787";
  } else if (host === PROD_HOST) {
    name = "production";
    workerUrl = PROD_WORKER;
  } else if (host.indexOf(STAGING_PREFIX) === 0) {
    name = "staging";
    workerUrl = "https://edu-live-worker-staging." + host.slice(STAGING_PREFIX.length);
  }

  window.EDU_ENV = { name: name, workerUrl: workerUrl };

  // Non-production pages get a visible banner, so nobody mistakes staging for prod.
  if (name !== "production") {
    var show = function () {
      var bar = document.createElement("div");
      bar.textContent = name === "unknown"
        ? "UNCONFIGURED HOST - no backend connected"
        : name.toUpperCase() + " ENVIRONMENT - not production data";
      bar.setAttribute("style",
        "position:fixed;top:0;left:0;right:0;z-index:99999;padding:4px 8px;" +
        "text-align:center;font:600 12px/1.4 system-ui,sans-serif;" +
        "background:#f59e0b;color:#1f1300;");
      document.body.appendChild(bar);
    };
    if (document.body) show();
    else document.addEventListener("DOMContentLoaded", show);
  }
})();
