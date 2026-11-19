(function () {
  "use strict";

  // Chat iframe = the index.html this widget script was served from, so the
  // widget always talks to the same environment as its own host.
  var CHAT_URL = new URL("./?embed=true", document.currentScript ? document.currentScript.src : window.location.href).href;
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
  var isExpanded = state.expanded === true;
  var isMobile = window.innerWidth < 768;

  // The panel can be dragged as wide as the page; "expanded" fills it.
  // Visible width (excludes the host page's scrollbar).
  function maxWidth() { return document.documentElement.clientWidth || window.innerWidth; }
  function clampWidth(w) { return Math.max(MIN_WIDTH, Math.min(maxWidth(), w)); }
  panelWidth = clampWidth(panelWidth);

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
    ".ek-widget-expand{font-size:16px;}",
    ".ek-widget-iframe{border:none;flex:1;width:100%;}",
    // Pinned to both edges (not 100vw) so a host-page scrollbar never hides
    // the panel's left edge.
    ".ek-widget-panel.ek-expanded{left:0;width:auto!important;}",
    ".ek-widget-panel.ek-expanded .ek-widget-resize{display:none;}",
    ".ek-widget-panel.ek-dragging{transition:none;user-select:none;}",
    ".ek-widget-panel.ek-dragging .ek-widget-iframe{pointer-events:none;}",
    ".ek-widget-resize{",
    "  position:absolute;top:0;left:0;width:5px;height:100%;cursor:col-resize;",
    "  background:transparent;z-index:1;",
    "}",
    ".ek-widget-resize:hover{background:rgba(238,124,92,0.25);}",
    "@media(max-width:767px){",
    "  .ek-widget-panel{left:0;width:auto!important;}",
    "  .ek-widget-resize{display:none;}",
    "  .ek-widget-expand{display:none!important;}",
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

  var header = document.createElement("div");
  header.className = "ek-widget-header";
  header.innerHTML = '<span>Edukripa</span>';
  var expandBtn = document.createElement("button");
  expandBtn.className = "ek-widget-close ek-widget-expand";
  var closeBtn = document.createElement("button");
  closeBtn.className = "ek-widget-close";
  closeBtn.setAttribute("aria-label", "Close chat");
  closeBtn.title = "Close";
  closeBtn.textContent = "×";
  header.appendChild(expandBtn);
  header.appendChild(closeBtn);

  // Width: full screen on phones, the whole page when expanded, otherwise
  // the dragged width (up to the full page).
  function applyWidth() {
    // Phones and "expanded" are pinned to both edges by CSS (left:0;right:0),
    // which, unlike 100vw, never slides under a host-page scrollbar.
    panel.style.width = isMobile || isExpanded ? "" : panelWidth + "px";
    panel.classList.toggle("ek-expanded", isExpanded);
    expandBtn.textContent = isExpanded ? "⤡" : "⤢";
    expandBtn.title = isExpanded ? "Restore size" : "Expand to full page";
    expandBtn.setAttribute("aria-label", expandBtn.title);
    expandBtn.setAttribute("aria-pressed", isExpanded ? "true" : "false");
  }
  function toggleExpanded() {
    isExpanded = !isExpanded;
    applyWidth();
    saveState({ width: panelWidth, expanded: isExpanded });
  }
  applyWidth();

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
  expandBtn.addEventListener("click", toggleExpanded);

  // --- Drag Resize (up to the full page width) ---
  resizeHandle.addEventListener("mousedown", function (e) {
    e.preventDefault();
    var startX = e.clientX;
    var startW = panel.offsetWidth;
    // While dragging, the chat iframe must not swallow mouse events, or the
    // drag stops as soon as the pointer crosses into the panel.
    panel.classList.add("ek-dragging");
    function onMove(ev) {
      var delta = startX - ev.clientX;
      panelWidth = clampWidth(startW + delta);
      panel.style.width = panelWidth + "px";
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      panel.classList.remove("ek-dragging");
      saveState({ width: panelWidth, expanded: isExpanded });
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
    panelWidth = clampWidth(panelWidth);
    applyWidth();
  });
})();
