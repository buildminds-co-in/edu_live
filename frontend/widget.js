(function () {
  "use strict";

  var CHAT_URL = "https://frontend.naveed-ks.workers.dev/?embed=true";
  var DEFAULT_WIDTH = 400;
  var MIN_WIDTH = 300;
  var STORAGE_KEY = "edukripa-widget";

  var cfg = {
    width: parseInt(document.currentScript?.getAttribute("data-default-width")) || DEFAULT_WIDTH,
    position: document.currentScript?.getAttribute("data-position") || "right"
  };

  function loadState() {
    try {
      var s = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return s || {};
    } catch (e) { return {}; }
  }
  function saveState(s) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) {}
  }

  var state = loadState();
  var isOpen = false;
  var panelWidth = state.width || cfg.width;
  var isMobile = window.innerWidth < 768;

  // --- Styles ---
  var style = document.createElement("style");
  style.textContent = [
    ".ek-widget-btn{",
    "  position:fixed;bottom:24px;right:24px;z-index:2147483646;",
    "  width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;",
    "  background:conic-gradient(from 180deg,#ee7c5c,#a86bd8,#2fae8f,#ee7c5c);",
    "  box-shadow:0 4px 16px rgba(0,0,0,0.18);transition:transform .15s ease;",
    "  display:flex;align-items:center;justify-content:center;",
    "}",
    ".ek-widget-btn:hover{transform:scale(1.08);}",
    ".ek-widget-btn svg{width:26px;height:26px;fill:#fff;pointer-events:none;}",
    ".ek-widget-panel{",
    "  position:fixed;top:0;right:0;z-index:2147483645;",
    "  height:100vh;height:100dvh;background:#fff;",
    "  box-shadow:-4px 0 24px rgba(0,0,0,0.12);",
    "  transform:translateX(100%);transition:transform .25s ease;",
    "  display:flex;flex-direction:column;",
    "}",
    ".ek-widget-panel.ek-open{transform:translateX(0);}",
    ".ek-widget-header{",
    "  display:flex;align-items:center;height:40px;padding:0 6px 0 12px;flex-shrink:0;",
    "  border-bottom:1px solid #e4e1d8;background:#f6f4ef;font-family:Inter,sans-serif;",
    "}",
    ".ek-widget-header span{flex:1;font-size:13px;font-weight:600;color:#221f1a;}",
    ".ek-widget-close{",
    "  background:none;border:none;cursor:pointer;font-size:20px;color:#7a7568;",
    "  width:32px;height:32px;display:flex;align-items:center;justify-content:center;",
    "  border-radius:6px;transition:background .1s;",
    "}",
    ".ek-widget-close:hover{background:#e4e1d8;}",
    ".ek-widget-iframe{border:none;flex:1;width:100%;}",
    ".ek-widget-resize{",
    "  position:absolute;top:0;left:0;width:5px;height:100%;cursor:col-resize;",
    "  background:transparent;z-index:1;",
    "}",
    ".ek-widget-resize:hover{background:rgba(238,124,92,0.25);}",
    "@media(max-width:767px){",
    "  .ek-widget-panel{width:100vw!important;}",
    "  .ek-widget-resize{display:none;}",
    "  .ek-widget-btn{bottom:16px;right:16px;width:50px;height:50px;}",
    "  .ek-widget-btn svg{width:22px;height:22px;}",
    "}"
  ].join("\n");
  document.head.appendChild(style);

  // --- Toggle Button ---
  var btn = document.createElement("button");
  btn.className = "ek-widget-btn";
  btn.setAttribute("aria-label", "Open Edukripa chat");
  btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 00-2 2v12a2 2 0 002 2h4l4 4 4-4h4a2 2 0 002-2V4a2 2 0 00-2-2zm-8 13h-2v-2h2v2zm0-4h-2V7h2v4z"/></svg>';
  document.body.appendChild(btn);

  // --- Panel ---
  var panel = document.createElement("div");
  panel.className = "ek-widget-panel";
  panel.style.width = (isMobile ? window.innerWidth : panelWidth) + "px";

  var header = document.createElement("div");
  header.className = "ek-widget-header";
  header.innerHTML = '<span>Edukripa</span>';
  var closeBtn = document.createElement("button");
  closeBtn.className = "ek-widget-close";
  closeBtn.setAttribute("aria-label", "Close chat");
  closeBtn.textContent = "×";
  header.appendChild(closeBtn);

  var resizeHandle = document.createElement("div");
  resizeHandle.className = "ek-widget-resize";

  var iframe = document.createElement("iframe");
  iframe.className = "ek-widget-iframe";
  iframe.setAttribute("loading", "lazy");
  iframe.setAttribute("allow", "clipboard-write");

  panel.appendChild(resizeHandle);
  panel.appendChild(header);
  panel.appendChild(iframe);
  document.body.appendChild(panel);

  // --- Open / Close ---
  function open() {
    if (!iframe.src) iframe.src = CHAT_URL;
    panel.classList.add("ek-open");
    btn.style.display = "none";
    isOpen = true;
  }
  function close() {
    panel.classList.remove("ek-open");
    btn.style.display = "";
    isOpen = false;
  }
  btn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);

  // --- Drag Resize ---
  resizeHandle.addEventListener("mousedown", function (e) {
    e.preventDefault();
    var startX = e.clientX;
    var startW = panel.offsetWidth;
    function onMove(ev) {
      var delta = startX - ev.clientX;
      var newW = Math.max(MIN_WIDTH, Math.min(window.innerWidth * 0.5, startW + delta));
      panel.style.width = newW + "px";
      panelWidth = newW;
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      saveState({ width: panelWidth });
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // --- Escape to close ---
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isOpen) close();
  });

  // --- Responsive ---
  window.addEventListener("resize", function () {
    isMobile = window.innerWidth < 768;
    if (isMobile && isOpen) panel.style.width = "100vw";
    else if (isOpen) panel.style.width = panelWidth + "px";
  });
})();
