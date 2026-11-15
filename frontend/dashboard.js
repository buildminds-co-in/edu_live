// Set by env.js from the page's hostname (local / staging / production).
const WORKER_URL = window.EDU_ENV.workerUrl;

const THEME_STORAGE_KEY = "edukripa-theme";
const themeToggle = document.getElementById("theme-toggle");

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") || "auto";
}

themeToggle.addEventListener("click", () => {
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const isDark = currentTheme() === "dark" || (currentTheme() === "auto" && prefersDark);
  const next = isDark ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch (e) {}
});

const adminKeyInput = document.getElementById("admin-key-input");
adminKeyInput.value = localStorage.getItem("edukripa-admin-key") ?? "";
adminKeyInput.addEventListener("input", () => {
  localStorage.setItem("edukripa-admin-key", adminKeyInput.value);
});

function adminHeaders() {
  const key = adminKeyInput.value.trim();
  return key ? { "x-admin-key": key } : {};
}

async function fetchAdmin(path) {
  const response = await fetch(`${WORKER_URL}${path}`, { headers: adminHeaders() });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return response.json();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderLoading(el) {
  el.innerHTML = `<div class="loading-state">Loading...</div>`;
}

function renderError(el, message) {
  el.innerHTML = `<div class="card error-state">Could not load this tab: ${escapeHtml(message)}</div>`;
}

// --- Tab: PDFs & Chunks ---

const INGEST_KEY_STORAGE = "edukripa-ingest-key";

function uploadCardHtml() {
  const savedKey = localStorage.getItem(INGEST_KEY_STORAGE) ?? "";
  return `
    <div class="card" id="upload-card">
      <h2>Upload notes (PDF)</h2>
      <div class="upload-row">
        <input type="password" id="ingest-key-input" placeholder="x-ingest-key (if configured)" autocomplete="off" value="${escapeHtml(savedKey)}" />
      </div>
      <label class="checkbox-row upload-force-row">
        <input type="checkbox" id="qp-eligible-input" checked />
        Include in Question Paper generation
      </label>
      <div class="upload-row" id="upload-subject-row">
        <label>Subject</label>
        <div class="subject-toggle" id="upload-subject-toggle">
          <button type="button" class="subject-toggle-btn active" data-subject="Science">Science</button>
          <button type="button" class="subject-toggle-btn" data-subject="Maths">Maths</button>
        </div>
      </div>
      <div class="upload-row" id="upload-chapter-row">
        <label for="upload-chapter">Chapter (required)</label>
        <input type="text" id="upload-chapter" name="chapter" placeholder="e.g. Carbon and its Compounds" required aria-required="true" />
      </div>
      <div class="upload-row">
        <input type="file" id="file-input" accept="application/pdf" />
        <button id="upload-btn">Upload</button>
      </div>
      <label class="checkbox-row upload-force-row">
        <input type="checkbox" id="force-reingest-input" />
        Force re-ingest (replace an already-indexed document with this filename)
      </label>
      <p id="upload-status" class="txn-meta"></p>
    </div>`;
}

function wireUploadCard(onUploaded) {
  const ingestKeyInput = document.getElementById("ingest-key-input");
  const qpEligibleInput = document.getElementById("qp-eligible-input");
  const subjectRow = document.getElementById("upload-subject-row");
  const subjectToggle = document.getElementById("upload-subject-toggle");
  const chapterRow = document.getElementById("upload-chapter-row");
  const chapterInput = document.getElementById("upload-chapter");
  const fileInput = document.getElementById("file-input");
  const forceReingestInput = document.getElementById("force-reingest-input");
  const uploadBtn = document.getElementById("upload-btn");
  const uploadStatus = document.getElementById("upload-status");

  let selectedSubject = "Science";

  function syncQpFieldsVisibility() {
    const eligible = qpEligibleInput.checked;
    subjectRow.hidden = !eligible;
    chapterRow.hidden = !eligible;
  }
  qpEligibleInput.addEventListener("change", syncQpFieldsVisibility);
  syncQpFieldsVisibility();

  subjectToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".subject-toggle-btn");
    if (!btn) return;
    selectedSubject = btn.dataset.subject;
    subjectToggle.querySelectorAll(".subject-toggle-btn").forEach((b) => b.classList.toggle("active", b === btn));
  });

  ingestKeyInput.addEventListener("input", () => {
    localStorage.setItem(INGEST_KEY_STORAGE, ingestKeyInput.value);
  });

  uploadBtn.addEventListener("click", async () => {
    const file = fileInput.files[0];
    if (!file) {
      uploadStatus.textContent = "Choose a PDF first.";
      return;
    }
    // The chapter name is what appears in the question-paper chapter list, so
    // a question-paper document can't be uploaded without one.
    if (qpEligibleInput.checked && !chapterInput.value.trim()) {
      uploadStatus.textContent =
        "Enter a chapter name. It's the name shown when choosing chapters for a question paper.";
      uploadStatus.classList.remove("upload-status-success");
      uploadStatus.classList.add("upload-status-error");
      chapterInput.focus();
      return;
    }

    uploadBtn.disabled = true;
    uploadStatus.textContent = "Uploading...";
    uploadStatus.classList.remove("upload-status-success", "upload-status-error");
    const formData = new FormData();
    formData.append("file", file);
    if (forceReingestInput.checked) formData.append("force", "true");
    // Leaving subject unset is what makes a document invisible to Question
    // Paper generation (worker/src/questionPaper.ts filters on it) - so a
    // chat/explainer-only upload must send nothing here, not empty strings.
    if (qpEligibleInput.checked) {
      formData.append("subject", selectedSubject);
      formData.append("chapter", chapterInput.value.trim());
    }
    const ingestKey = ingestKeyInput.value.trim();

    try {
      const response = await fetch(`${WORKER_URL}/ingest`, {
        method: "POST",
        headers: ingestKey ? { "x-ingest-key": ingestKey } : {},
        body: formData,
      });
      const result = await response.json();
      const succeeded = response.ok && result.status === "indexed";

      uploadStatus.textContent = response.ok
        ? `${result.status}: ${result.source}${result.chunkCount ? ` (${result.chunkCount} chunks)` : ""}`
        : `Error: ${result.error}`;
      uploadStatus.classList.toggle("upload-status-success", succeeded);
      uploadStatus.classList.toggle("upload-status-error", !response.ok);

      // Reloading the tab immediately would wipe this message the instant
      // it appears (the reload rebuilds this whole card, including a fresh,
      // blank status paragraph) - pausing first gives the admin a chance to
      // actually read it.
      if (succeeded) setTimeout(onUploaded, 1800);
    } catch (err) {
      uploadStatus.textContent = `Error: could not reach the server (${err.message})`;
      uploadStatus.classList.add("upload-status-error");
    } finally {
      uploadBtn.disabled = false;
    }
  });
}

async function loadDocumentsTab() {
  const el = document.getElementById("tab-documents");
  renderLoading(el);
  try {
    const { documents, chunkPreviewCount } = await fetchAdmin("/admin/documents");
    if (documents.length === 0) {
      el.innerHTML = `${uploadCardHtml()}<div class="card empty-state">No documents indexed yet.</div>`;
      wireUploadCard(loadDocumentsTab);
      return;
    }

    const totalChunks = documents.reduce((sum, d) => sum + (d.chunkCount ?? 0), 0);

    const rawRows = documents
      .map(
        (doc) => `
        <tr>
          <td>${escapeHtml(doc.name)}</td>
          <td>${(doc.sizeBytes / 1024).toFixed(1)} KB</td>
          <td>${doc.indexedAt ? new Date(doc.indexedAt).toLocaleString() : "—"}</td>
          <td>${doc.pageCount ?? "—"}</td>
          <td>${doc.chunkCount ?? "—"}</td>
          <td>${doc.enriched === null ? "—" : doc.enriched ? "Yes" : "No"}</td>
          <td>${doc.subject ? `Yes (${escapeHtml(doc.subject)})` : "No"}</td>
          <td><button type="button" class="delete-doc-btn" data-doc-name="${escapeHtml(doc.name)}" data-chunks="${doc.chunkCount ?? 0}">Delete</button></td>
        </tr>`
      )
      .join("");

    const cleanedRows = documents
      .map((doc) =>
        doc.enriched
          ? `<details class="io-block cleaned-text" data-doc-name="${escapeHtml(doc.name)}">
               <summary>${escapeHtml(doc.name)}</summary>
               <div class="cleaned-text-body txn-meta">Loading...</div>
             </details>`
          : `<div class="chunk-item"><div class="chunk-meta">${escapeHtml(doc.name)}</div><span class="txn-meta">Not available - enrichment did not run or produced no changes for this document</span></div>`
      )
      .join("");

    const chunkSections = documents
      .filter((doc) => doc.chunks)
      .map(
        (doc) => `
        <details class="io-block chunk-preview">
          <summary>${escapeHtml(doc.name)} - ${doc.chunks.length} chunk(s)</summary>
          ${doc.chunks
            .map(
              (c) => `<div class="chunk-item"><div class="chunk-meta">Chunk ${c.chunkId} · page ${c.page}</div><pre>${escapeHtml(c.text)}</pre></div>`
            )
            .join("")}
        </details>`
      )
      .join("");

    el.innerHTML = `
      ${uploadCardHtml()}
      <div class="card">
        <div class="metric-row">
          <div class="metric"><div class="label">Documents</div><div class="value">${documents.length}</div></div>
          <div class="metric"><div class="label">Total chunks</div><div class="value">${totalChunks}</div></div>
        </div>
      </div>
      <div class="card">
        <h2>Raw PDFs</h2>
        <p class="txn-meta">The original uploaded PDF files, as stored.</p>
        <table>
          <thead><tr><th>File</th><th>Size</th><th>Indexed</th><th>Pages</th><th>Chunks</th><th>Enriched</th><th>Question papers</th><th></th></tr></thead>
          <tbody>${rawRows}</tbody>
        </table>
        <p id="delete-status" class="txn-meta" role="status"></p>
      </div>
      <div class="card">
        <h2>Cleaned PDFs</h2>
        <p class="txn-meta">The enriched content produced by the ingestion clean-up layer - formulas, tables, and figure descriptions - for documents where enrichment applied.</p>
        ${cleanedRows}
      </div>
      <div class="card">
        <h2>Chunks</h2>
        <p class="txn-meta">Chunk text shown for the ${chunkPreviewCount ?? 0} most recently indexed document(s) only.</p>
        ${chunkSections || `<p class="txn-meta">No chunk previews available.</p>`}
      </div>`;
    wireUploadCard(loadDocumentsTab);
    wireCleanedTextToggles();
    wireDeleteButtons();
  } catch (err) {
    renderError(el, err.message);
  }
}

function wireDeleteButtons() {
  const status = document.getElementById("delete-status");
  document.querySelectorAll(".delete-doc-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.docName;
      const confirmed = window.confirm(
        `Delete "${name}"?\n\n` +
          `This removes the PDF, its ${btn.dataset.chunks} chunk(s), page screenshots, cleaned text, ` +
          `and any saved question papers built from it. Students will no longer get answers from it.\n\n` +
          `This cannot be undone - you would need to upload the PDF again.`
      );
      if (!confirmed) return;

      document.querySelectorAll(".delete-doc-btn").forEach((b) => (b.disabled = true));
      status.textContent = `Deleting ${name}...`;
      status.classList.remove("upload-status-success", "upload-status-error");
      try {
        const response = await fetch(`${WORKER_URL}/admin/documents?name=${encodeURIComponent(name)}`, {
          method: "DELETE",
          headers: adminHeaders(),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
        status.textContent = `Deleted ${name}.`;
        status.classList.add("upload-status-success");
        setTimeout(loadDocumentsTab, 1500);
      } catch (err) {
        status.textContent = `Error: ${err.message}`;
        status.classList.add("upload-status-error");
        document.querySelectorAll(".delete-doc-btn").forEach((b) => (b.disabled = false));
      }
    });
  });
}

function wireCleanedTextToggles() {
  document.querySelectorAll(".cleaned-text").forEach((details) => {
    details.addEventListener(
      "toggle",
      async () => {
        if (!details.open) return;
        const body = details.querySelector(".cleaned-text-body");
        const name = details.dataset.docName;
        try {
          const { text } = await fetchAdmin(`/admin/documents/cleaned?name=${encodeURIComponent(name)}`);
          body.outerHTML = `<pre class="cleaned-text-body">${escapeHtml(text)}</pre>`;
          if (window.renderMathInElement) {
            window.renderMathInElement(details, {
              delimiters: [
                { left: "$$", right: "$$", display: true },
                { left: "$", right: "$", display: false },
              ],
              throwOnError: false,
            });
          }
        } catch (err) {
          body.textContent = `Error loading cleaned text: ${err.message}`;
        }
      },
      { once: true }
    );
  });
}

// --- Tab: Transactions ---

const PATH_LABELS = {
  pdf_only: "Chat",
  web_fallback: "Chat (web)",
  concept_explainer: "Explainer",
  question_paper: "Question paper",
  answer_key: "Answer key",
  ingestion_enrichment: "Enrichment",
};
const PATH_FILTERS = [
  ["all", "All"],
  ["chat", "Chat"],
  ["concept_explainer", "Explainer"],
  ["question_paper", "Question papers"],
  ["answer_key", "Answer keys"],
  ["ingestion_enrichment", "Enrichment"],
];

function pathLabel(path) {
  return PATH_LABELS[path] ?? path ?? "—";
}
function pathBadge(path) {
  return `<span class="path-badge path-${escapeHtml(String(path ?? "unknown"))}">${escapeHtml(pathLabel(path))}</span>`;
}
function fmtInt(n) {
  return n == null ? "—" : Number(n).toLocaleString();
}
function fmtTokensShort(n) {
  if (n == null) return "—";
  const v = Number(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return String(v);
}
function fmtUsd(n) {
  if (n == null) return "—";
  const v = Number(n);
  if (v === 0) return "$0";
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}
function totalTokens(t) {
  return Number(t.inputTokens ?? 0) + Number(t.outputTokens ?? 0);
}

function statusPill(status) {
  return status === "kept" ? `<span class="pill pill-kept">kept</span>` : `<span class="pill pill-discarded">discarded</span>`;
}

function renderRetrievalTable(retrieval) {
  const rows = retrieval
    .map(
      (r) => `
      <tr>
        <td>${r.rank}</td>
        <td class="mono">${escapeHtml(r.source)}</td>
        <td>${r.page}</td>
        <td>${r.chunkId}</td>
        <td class="mono">${Number(r.cosineScore).toFixed(4)}</td>
        <td class="mono">${r.rerankScore == null ? "—" : Number(r.rerankScore).toFixed(4)}</td>
        <td class="mono">${r.jevRelevance == null ? "—" : Number(r.jevRelevance).toFixed(2)}</td>
        <td>${statusPill(r.status)}</td>
      </tr>`
    )
    .join("");
  return `
    <table class="compact-table">
      <thead><tr><th>Rank</th><th>Source</th><th>Page</th><th>Chunk</th><th>Cosine</th><th>Rerank</th><th>JEV</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function txnChips(t) {
  const chips = [
    ["Path", pathBadge(t.pathTaken)],
    ["Model", `<span class="mono">${escapeHtml(t.model)}</span>`],
    ["Tokens", `<span class="mono">${fmtInt(totalTokens(t))}</span> <span class="muted">(in: ${fmtInt(t.inputTokens)}, out: ${fmtInt(t.outputTokens)})</span>`],
    ["Cost", `<span class="mono">${fmtUsd(t.costUsd)}</span>`],
  ];
  if (t.answerStyle) chips.push(["Style", escapeHtml(t.answerStyle)]);
  if (t.groundedIn) chips.push(["Grounded in", escapeHtml(t.groundedIn)]);
  if (t.retrievalMode) chips.push(["Retrieval mode", escapeHtml(t.retrievalMode)]);
  if (t.jevModel) chips.push(["JEV", `<span class="mono">${escapeHtml(t.jevModel)}</span>`]);
  return `<div class="txn-chips">${chips.map(([k, v]) => `<span class="txn-chip"><span class="k">${k}</span> ${v}</span>`).join("")}</div>`;
}

function renderTxnDetail(t) {
  const retrieval = Array.isArray(t.retrieval) ? t.retrieval : [];
  const kept = retrieval.filter((r) => r.status === "kept").length;
  let step = 0;
  const retrievalStep = retrieval.length
    ? `<div class="txn-step"><h4><span class="step-no">${++step}</span> VectorDB Retrieval &amp; Ranking (${retrieval.length} chunks → ${kept} kept)</h4>${renderRetrievalTable(retrieval)}</div>`
    : "";
  const llmStep = `
    <div class="txn-step">
      <h4><span class="step-no">${++step}</span> LLM Generation — <span class="mono">${escapeHtml(t.model)}</span> (${fmtInt(totalTokens(t))} tokens)</h4>
      <div class="io-grid">
        <div><div class="io-label">Input (context + question)</div><pre class="io-pane">${escapeHtml(t.llmInput || "")}</pre></div>
        <div class="io-arrow" aria-hidden="true">→</div>
        <div><div class="io-label">Output (LLM answer)</div><pre class="io-pane">${escapeHtml(t.llmOutput || "")}</pre></div>
      </div>
    </div>`;
  const jevStep = t.jevInput
    ? `<details class="io-block"><summary>JEV input and output</summary><pre>${escapeHtml(JSON.stringify({ input: t.jevInput, output: t.jevOutput }, null, 2))}</pre></details>`
    : "";
  return txnChips(t) + retrievalStep + llmStep + jevStep;
}

const txnDetailCache = new Map();

async function loadTransactionsTab(state = { limit: 50, filter: "all" }) {
  const el = document.getElementById("tab-transactions");
  renderLoading(el);
  try {
    const { transactions } = await fetchAdmin(`/admin/transactions/recent?limit=${state.limit}`);
    const matches = (t) =>
      state.filter === "all" ||
      (state.filter === "chat" ? t.pathTaken === "pdf_only" || t.pathTaken === "web_fallback" : t.pathTaken === state.filter);
    const shown = transactions.filter(matches);

    const filterButtons = PATH_FILTERS.map(
      ([value, label]) => `<button type="button" class="seg-btn${state.filter === value ? " active" : ""}" data-filter="${value}">${label}</button>`
    ).join("");
    const limitOptions = [50, 100, 200]
      .map((n) => `<option value="${n}"${state.limit === n ? " selected" : ""}>Last ${n}</option>`)
      .join("");

    const rows = shown
      .map(
        (t) => `
        <tr class="txn-row" data-id="${escapeHtml(String(t.id))}" tabindex="0" aria-expanded="false">
          <td class="muted nowrap">${escapeHtml(new Date(t.timestamp).toLocaleString())}</td>
          <td>${pathBadge(t.pathTaken)}</td>
          <td class="txn-question">${escapeHtml(t.question ?? "")}</td>
          <td class="mono nowrap">${escapeHtml(t.model ?? "")}</td>
          <td class="mono nowrap" title="input ${fmtInt(t.inputTokens)} / output ${fmtInt(t.outputTokens)}">${fmtInt(totalTokens(t))} <span class="muted">(${fmtTokensShort(t.inputTokens)} / ${fmtTokensShort(t.outputTokens)})</span></td>
          <td class="mono nowrap">${fmtUsd(t.costUsd)}</td>
        </tr>
        <tr class="txn-detail-row" data-detail-for="${escapeHtml(String(t.id))}" hidden><td colspan="6"><div class="txn-detail"></div></td></tr>`
      )
      .join("");

    el.innerHTML = `
      <div class="card">
        <div class="tab-toolbar">
          <h2>Transactions</h2>
          <div class="seg-group" role="group" aria-label="Filter by feature">${filterButtons}</div>
          <select id="txn-limit" aria-label="How many transactions">${limitOptions}</select>
        </div>
        <p class="txn-meta">Every chat answer, explanation, question paper, answer key and PDF enrichment, newest first. Tokens are total (input / output). Click a row for details.</p>
        ${
          shown.length === 0
            ? `<div class="empty-state">No transactions${state.filter === "all" ? " yet" : " of this kind in the selected range"}.</div>`
            : `<div class="table-scroll"><table class="compact-table txn-list">
                <thead><tr><th>Time</th><th>Path</th><th>Question</th><th>Model</th><th>Tokens (in / out)</th><th>Cost</th></tr></thead>
                <tbody>${rows}</tbody>
              </table></div>`
        }
      </div>`;

    el.querySelectorAll(".seg-btn").forEach((btn) =>
      btn.addEventListener("click", () => loadTransactionsTab({ ...state, filter: btn.dataset.filter }))
    );
    document.getElementById("txn-limit").addEventListener("change", (e) =>
      loadTransactionsTab({ ...state, limit: Number(e.target.value) })
    );

    const toggle = async (row) => {
      const id = row.dataset.id;
      const detailRow = el.querySelector(`tr[data-detail-for="${CSS.escape(id)}"]`);
      const open = detailRow.hidden;
      detailRow.hidden = !open;
      row.setAttribute("aria-expanded", String(open));
      row.classList.toggle("open", open);
      if (!open) return;
      const box = detailRow.querySelector(".txn-detail");
      if (txnDetailCache.has(id)) {
        box.innerHTML = renderTxnDetail(txnDetailCache.get(id));
        return;
      }
      box.innerHTML = `<p class="txn-meta">Loading…</p>`;
      try {
        const { transaction } = await fetchAdmin(`/admin/transactions/${encodeURIComponent(id)}`);
        txnDetailCache.set(id, transaction);
        box.innerHTML = renderTxnDetail(transaction);
      } catch (err) {
        box.innerHTML = `<p class="txn-meta">Could not load this transaction: ${escapeHtml(err.message)}</p>`;
      }
    };
    el.querySelectorAll(".txn-row").forEach((row) => {
      row.addEventListener("click", () => toggle(row));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle(row);
        }
      });
    });
  } catch (err) {
    renderError(el, err.message);
  }
}

// --- Tab: Costing ---

const COST_RANGES = [
  ["all", "All time"],
  ["2h", "Last 2 hours"],
  ["1d", "Last 1 day"],
  ["3d", "Last 3 days"],
  ["7d", "Last 7 days"],
  ["30d", "Last 1 month"],
];

// OpenRouter list prices per 1M tokens (USD), for reference only - the costs
// shown above them are what OpenRouter reported for each call. Check
// openrouter.ai/models for current prices.
const MODEL_PRICING = {
  "google/gemini-2.5-flash": { name: "Gemini 2.5 Flash", in: 0.3, out: 2.5 },
  "google/gemini-2.5-pro": { name: "Gemini 2.5 Pro", in: 1.25, out: 10 },
  "openai/gpt-4o-mini": { name: "GPT-4o Mini", in: 0.15, out: 0.6 },
  "openai/gpt-4o": { name: "GPT-4o", in: 2.5, out: 10 },
  "openai/gpt-4.1": { name: "GPT-4.1", in: 2, out: 8 },
};

function modelDisplayName(model, role) {
  if (role === "jev") return "JEV relevance check";
  return MODEL_PRICING[model]?.name ?? model ?? "—";
}
function rate(model, key) {
  const p = MODEL_PRICING[model];
  return p ? `$${p[key]}/M` : "—";
}

async function loadCostingTab(range = "7d") {
  const el = document.getElementById("tab-costing");
  renderLoading(el);
  try {
    const data = await fetchAdmin(`/admin/costing?range=${encodeURIComponent(range)}`);
    const s = data.summary ?? {};
    const totalCost = Number(s.costUsd ?? 0);

    const rangeButtons = COST_RANGES.map(
      ([value, label]) => `<button type="button" class="seg-btn${data.range === value ? " active" : ""}" data-range="${value}">${label}</button>`
    ).join("");

    const cards = [
      ["Total requests", fmtInt(s.requests ?? s.queryCount ?? 0)],
      ["Total tokens", fmtTokensShort(s.totalTokens ?? 0)],
      ["Input tokens", fmtTokensShort(s.inputTokens ?? 0)],
      ["Output tokens", fmtTokensShort(s.outputTokens ?? 0)],
      ["Estimated cost", fmtUsd(totalCost)],
    ]
      .map(([label, value]) => `<div class="cost-card"><div class="label">${label}</div><div class="value mono">${value}</div></div>`)
      .join("");

    const modelRows = (data.byModel ?? [])
      .map((m) => {
        const tokens = m.inputTokens == null ? null : Number(m.inputTokens) + Number(m.outputTokens ?? 0);
        return `
        <tr>
          <td><div class="strong">${escapeHtml(modelDisplayName(m.model, m.role))}</div><div class="mono muted small">${escapeHtml(m.model ?? "")}</div></td>
          <td>${escapeHtml(m.provider ?? "—")}</td>
          <td class="mono">${fmtInt(m.requests)}</td>
          <td class="mono">${fmtTokensShort(tokens)}</td>
          <td class="mono">${fmtTokensShort(m.inputTokens)}</td>
          <td class="mono">${fmtTokensShort(m.outputTokens)}</td>
          <td class="mono">${m.role === "jev" ? "—" : rate(m.model, "in")}</td>
          <td class="mono">${m.role === "jev" ? "—" : rate(m.model, "out")}</td>
          <td class="mono strong">${fmtUsd(m.costUsd)}</td>
        </tr>`;
      })
      .join("");

    const featureRows = (data.byFeature ?? [])
      .map((f) => {
        const cost = Number(f.costUsd ?? 0);
        const share = totalCost > 0 ? `${Math.round((cost / totalCost) * 100)}%` : "—";
        return `
        <tr>
          <td>${pathBadge(f.pathTaken)}</td>
          <td class="mono">${fmtInt(f.requests)}</td>
          <td class="mono">${fmtTokensShort(Number(f.inputTokens ?? 0) + Number(f.outputTokens ?? 0))}</td>
          <td class="mono">${fmtTokensShort(f.inputTokens)}</td>
          <td class="mono">${fmtTokensShort(f.outputTokens)}</td>
          <td class="mono strong">${fmtUsd(cost)}</td>
          <td class="mono">${share}</td>
        </tr>`;
      })
      .join("");

    const pricingCards = Object.values(MODEL_PRICING)
      .map((p) => `<div class="price-card"><div class="strong">${p.name}</div><div class="mono muted small">$${p.in}/M in · $${p.out}/M out</div></div>`)
      .concat([`<div class="price-card"><div class="strong">Workers AI</div><div class="muted small">Embeddings, reranker, guardrail — included in the Workers plan</div></div>`])
      .join("");

    const empty = `<div class="empty-state">No usage recorded in this range.</div>`;
    el.innerHTML = `
      <div class="card">
        <div class="tab-toolbar">
          <h2>Costing</h2>
          <div class="seg-group" role="group" aria-label="Time range">${rangeButtons}</div>
        </div>
        <div class="cost-cards">${cards}</div>
      </div>
      <div class="card">
        <h3>By model</h3>
        ${
          modelRows
            ? `<div class="table-scroll"><table class="compact-table">
                <thead><tr><th>Model</th><th>Provider</th><th>Requests</th><th>Tokens</th><th>Input</th><th>Output</th><th>Input rate</th><th>Output rate</th><th>Est. cost</th></tr></thead>
                <tbody>${modelRows}</tbody>
              </table></div>`
            : empty
        }
      </div>
      <div class="card">
        <h3>By feature</h3>
        ${
          featureRows
            ? `<div class="table-scroll"><table class="compact-table">
                <thead><tr><th>Feature</th><th>Requests</th><th>Tokens</th><th>Input</th><th>Output</th><th>Est. cost</th><th>Share</th></tr></thead>
                <tbody>${featureRows}</tbody>
              </table></div>`
            : empty
        }
        <p class="txn-meta small">Costs are what OpenRouter reported for each call. Question papers, answer keys and PDF enrichment are recorded from this release on; earlier usage of those features isn't included. Chat token counts are estimates when the provider doesn't report them.</p>
      </div>
      <div class="card">
        <h3>Pricing reference (OpenRouter, per 1M tokens)</h3>
        <div class="price-cards">${pricingCards}</div>
      </div>`;

    el.querySelectorAll(".seg-btn").forEach((btn) => btn.addEventListener("click", () => loadCostingTab(btn.dataset.range)));
  } catch (err) {
    renderError(el, err.message);
  }
}

// --- Tab: Settings ---

async function loadSettingsTab() {
  const el = document.getElementById("tab-settings");
  renderLoading(el);
  try {
    const { config } = await fetchAdmin("/admin/config");
    el.innerHTML = `
      <div class="card">
        <h2>Runtime settings</h2>
        <p class="txn-meta">Changes apply to the next question asked - Cloudflare Workers have no long-running process to restart.</p>
        <form id="settings-form" class="settings-form">
          <label title="How many chunks are retrieved from Vectorize per question before reranking and filtering.">Top K chunks retrieved
            <input type="number" name="topK" min="1" step="1" value="${config.topK}" />
          </label>
          <label title="Minimum reranker/cosine score a question's top chunk must reach to be used. 0 disables this gate - the reranker's score scale isn't guaranteed non-negative.">Confidence threshold (0-1)
            <input type="number" name="confidenceThreshold" min="0" max="1" step="0.01" value="${config.confidenceThreshold}" />
          </label>
          <fieldset>
            <legend>Web search mode</legend>
            <label class="checkbox-row" title="Never fall back to a web search when no document chunks are found."><input type="radio" name="webSearchMode" value="rag_only" ${config.webSearchMode === "rag_only" ? "checked" : ""} /> RAG only</label>
            <label class="checkbox-row" title="Fall back to a DuckDuckGo web search when no document chunks are found."><input type="radio" name="webSearchMode" value="rag_web_fallback" ${config.webSearchMode === "rag_web_fallback" ? "checked" : ""} /> RAG + web fallback</label>
          </fieldset>
          <label class="checkbox-row" title="Refuse to answer (instead of using web results or general knowledge) when no document chunks are found."><input type="checkbox" name="hardFailNoDocument" ${config.hardFailNoDocument ? "checked" : ""} /> Hard fail when no document found</label>
          <label class="checkbox-row" title="Use the JEV relevance/injection check to filter retrieved chunks before answering."><input type="checkbox" name="jevEnabled" ${config.jevEnabled ? "checked" : ""} /> JEV relevance filtering enabled</label>
          <label title="Minimum JEV relevance score (0-3) a chunk must reach to be kept. Lower = less strict.">JEV relevance threshold (0-3, lower = less strict)
            <input type="number" name="jevRelevanceThreshold" min="0" max="3" step="0.1" value="${config.jevRelevanceThreshold}" />
          </label>
          <label class="checkbox-row" title="Block out-of-scope or age-inappropriate questions before retrieval runs."><input type="checkbox" name="guardrailEnabled" ${config.guardrailEnabled ? "checked" : ""} /> Guardrail enabled</label>
          <button type="submit">Save</button>
        </form>
        <p id="settings-status" class="txn-meta"></p>
      </div>
      <div class="card">
        <h2>LLM provider</h2>
        <p class="txn-meta">Controls which model answers chat questions. Changes apply to the next question asked.</p>
        <form id="llm-form" class="settings-form">
          <label>Provider
            <input type="text" value="OpenRouter" disabled />
          </label>
          <label>Model (slug)
            <input type="text" name="llmModelSlug" value="${escapeHtml(config.llmModelSlug)}" placeholder="qwen/qwen-2.5-72b-instruct:free" />
          </label>
          <label title="Model used for Question Paper generation and answer keys. Leave blank to follow the chat model above.">Question Paper Model (slug, optional)
            <input type="text" name="questionPaperModelSlug" value="${config.questionPaperModelSlug === config.llmModelSlug ? "" : escapeHtml(config.questionPaperModelSlug)}" placeholder="(same as chat model above)" />
          </label>
          <button type="submit">Save</button>
        </form>
        <p id="llm-status" class="txn-meta"></p>
      </div>
      <div class="card">
        <h2>Evals</h2>
        <p class="txn-meta">Not used by live chat or question papers. Sets the default model slug the manual eval script (worker/evals/run-evals.js) tests against when no --model flag is passed on the command line.</p>
        <form id="eval-form" class="settings-form">
          <label>Eval model (slug)
            <input type="text" name="evalModelSlug" value="${escapeHtml(config.evalModelSlug)}" placeholder="e.g. a candidate model you're about to try" />
          </label>
          <button type="submit">Save</button>
        </form>
        <p id="eval-status" class="txn-meta"></p>
      </div>
      <div class="card">
        <h2>Ingestion enrichment</h2>
        <p class="txn-meta">Extracts formulas, tables, and figures from uploaded PDFs via a vision-capable model before chunking. Applies to documents uploaded after this is enabled - ingestion skips a filename it already has, so an already-indexed document won't get enrichment just by re-uploading it under the same name.</p>
        <form id="ingestion-form" class="settings-form">
          <label class="checkbox-row"><input type="checkbox" name="ingestionEnrichmentEnabled" ${config.ingestionEnrichmentEnabled ? "checked" : ""} /> Enrichment enabled</label>
          <label>Model (slug)
            <input type="text" name="ingestionModelSlug" value="${escapeHtml(config.ingestionModelSlug)}" placeholder="google/gemini-2.5-flash" />
          </label>
          <button type="submit">Save</button>
        </form>
        <p id="ingestion-status" class="txn-meta"></p>
      </div>
      <div class="card">
        <h2>Concept Explainer</h2>
        <p class="txn-meta">Controls the student-facing Concept Explainer mode on the chat page.</p>
        <form id="explainer-form" class="settings-form">
          <label class="checkbox-row" title="When off, the Concept Explainer endpoint returns 404 and the student-facing toggle is hidden.">
            <input type="checkbox" name="conceptExplainerEnabled" ${config.conceptExplainerEnabled ? "checked" : ""} /> Concept Explainer enabled
          </label>
          <fieldset>
            <legend>Retrieval mode</legend>
            <label class="checkbox-row" title="Explain strictly from retrieved course material; fall back to general knowledge only when nothing relevant was retrieved.">
              <input type="radio" name="explainRetrievalMode" value="rag_fallback" ${config.explainRetrievalMode === "rag_fallback" ? "checked" : ""} /> RAG only, fallback to general knowledge
            </label>
            <label class="checkbox-row" title="Always combine retrieved course material (as the primary source of truth) with general knowledge to complete the explanation. Recommended - retrieved chunks are often too fragmentary alone to fully explain a concept.">
              <input type="radio" name="explainRetrievalMode" value="rag_plus_llm" ${config.explainRetrievalMode === "rag_plus_llm" ? "checked" : ""} /> RAG + general knowledge, consolidated
            </label>
          </fieldset>
          <button type="submit">Save</button>
        </form>
        <p id="explainer-status" class="txn-meta"></p>
      </div>`;

    document.getElementById("settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target;
      const status = document.getElementById("settings-status");
      const update = {
        topK: Number(form.topK.value),
        confidenceThreshold: Number(form.confidenceThreshold.value),
        webSearchMode: form.webSearchMode.value,
        hardFailNoDocument: form.hardFailNoDocument.checked,
        jevEnabled: form.jevEnabled.checked,
        jevRelevanceThreshold: Number(form.jevRelevanceThreshold.value),
        guardrailEnabled: form.guardrailEnabled.checked,
      };
      status.textContent = "Saving...";
      try {
        const response = await fetch(`${WORKER_URL}/admin/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...adminHeaders() },
          body: JSON.stringify(update),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
        status.textContent = "Saved - takes effect on the next question.";
      } catch (err) {
        status.textContent = `Error: ${err.message}`;
      }
    });

    document.getElementById("llm-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target;
      const status = document.getElementById("llm-status");
      const update = {
        llmModelSlug: form.llmModelSlug.value.trim(),
        questionPaperModelSlug: form.questionPaperModelSlug.value.trim(),
      };
      status.textContent = "Saving...";
      try {
        const response = await fetch(`${WORKER_URL}/admin/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...adminHeaders() },
          body: JSON.stringify(update),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
        status.textContent = "Saved - takes effect on the next question.";
      } catch (err) {
        status.textContent = `Error: ${err.message}`;
      }
    });

    document.getElementById("eval-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target;
      const status = document.getElementById("eval-status");
      const update = { evalModelSlug: form.evalModelSlug.value.trim() };
      status.textContent = "Saving...";
      try {
        const response = await fetch(`${WORKER_URL}/admin/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...adminHeaders() },
          body: JSON.stringify(update),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
        status.textContent = "Saved.";
      } catch (err) {
        status.textContent = `Error: ${err.message}`;
      }
    });

    document.getElementById("ingestion-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target;
      const status = document.getElementById("ingestion-status");
      const update = {
        ingestionEnrichmentEnabled: form.ingestionEnrichmentEnabled.checked,
        ingestionModelSlug: form.ingestionModelSlug.value.trim(),
      };
      status.textContent = "Saving...";
      try {
        const response = await fetch(`${WORKER_URL}/admin/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...adminHeaders() },
          body: JSON.stringify(update),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
        status.textContent = "Saved - applies to documents uploaded from now on.";
      } catch (err) {
        status.textContent = `Error: ${err.message}`;
      }
    });

    document.getElementById("explainer-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target;
      const status = document.getElementById("explainer-status");
      const update = {
        conceptExplainerEnabled: form.conceptExplainerEnabled.checked,
        explainRetrievalMode: form.explainRetrievalMode.value,
      };
      status.textContent = "Saving...";
      try {
        const response = await fetch(`${WORKER_URL}/admin/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...adminHeaders() },
          body: JSON.stringify(update),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
        status.textContent = "Saved - takes effect on the next question.";
      } catch (err) {
        status.textContent = `Error: ${err.message}`;
      }
    });
  } catch (err) {
    renderError(el, err.message);
  }
}

// --- Tab switching ---

const tabLoaders = {
  documents: loadDocumentsTab,
  transactions: () => loadTransactionsTab(),
  costing: () => loadCostingTab(),
  settings: loadSettingsTab,
};

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));

    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    const panel = document.getElementById(`tab-${btn.dataset.tab}`);
    panel.classList.add("active");
    tabLoaders[btn.dataset.tab]();
  });
});

loadDocumentsTab();
