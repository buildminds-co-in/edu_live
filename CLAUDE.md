# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Cloudflare-native RAG chatbot for science/maths Q&A, aimed at 16-17 year old students. Free-tier stack: Workers, Vectorize, Workers AI, R2, D1, Pages. Two independently deployed pieces:

- `worker/` — the API (one Cloudflare Worker, `edu-live-worker`): `POST /ingest` (upload + index a PDF), `POST /chat` (ask a question), `POST /explain` (Concept Explainer), `/question-paper/*` (generate a question paper + answer key from indexed chapters), `GET /images/:key` (serve a captured page screenshot), and `/admin/*` (dashboard data + config).
- `frontend/` — two independent static Cloudflare Pages sites, deployed separately:
  - `index.html`/`app.js`/`style.css` — the student-facing chat app. No upload UI.
  - `dashboard.html`/`dashboard.js`/`dashboard.css` — the admin-only operator dashboard (Data Ingestion Dashboard / TransactionTracker / Costing / Settings tabs). PDF uploads happen here, not on the chat page.

## Commands

All commands run from `worker/` unless noted.

```bash
npm install                 # installs @cloudflare/puppeteer, unpdf, etc.
npx wrangler login           # once per machine; same account for worker/ and frontend/

npx vitest run                              # full test suite
npx vitest run test/chat.test.ts            # single test file
npx vitest run test/chat.test.ts -t "name"  # single test by name substring
npx tsc --noEmit                            # type-check (test/chat.test.ts has known
                                             # pre-existing mock-type errors unrelated to
                                             # real code — confirmed present on main;
                                             # any OTHER file erroring is a real regression)

npx wrangler dev --persist-to=.wrangler/state   # local dev — cannot emulate Vectorize,
                                                 # Workers AI, or Browser Rendering; all
                                                 # three hit the real free-tier services
                                                 # even in local dev
npm run deploy:staging                          # deploy Worker AND frontend to staging, tagged (scripts/deploy.js)
npm run deploy:prod                             # same for prod; only from a clean vX.Y.Z tag. Bare `wrangler deploy`
                                                 # goes to your personal dev name, never prod.
npx wrangler tail --env production --format pretty   # stream live production logs
npm run db:check                                # migrations must be additive (no DROP/RENAME)
npm run db:migrate:staging | db:migrate:prod    # apply migrations BEFORE deploying code
npm run db:backup:prod                          # Time Travel restore point before a prod migration
npm run eval:golden -- --worker-url=<staging URL>   # golden suite (staging only)
npm run eval:client -- --worker-url=<staging URL>   # client-papers suite (needs evals/reference-papers/)

# Secrets are set per environment: add `--env staging` or `--env production`.
npx wrangler secret put OPENROUTER_API_KEY   # chat generation (default provider) + JEV + PDF enrichment
npx wrangler secret put ADMIN_API_KEY        # protects /admin/*
npx wrangler secret put INGEST_API_KEY       # protects /ingest (optional)
```

From `frontend/`:

```bash
npx serve .          # local static serving; app.js's WORKER_URL const must point at
                      # a reachable worker (local wrangler dev or deployed)
# Staging/prod frontend deploys go through `npm run deploy:*` in worker/ (tags both)
# (it deploys BOTH index.html and dashboard.html with the Worker)
# Environments, data rules, and the migration order: docs/ENVIRONMENTS.md
```

**There are two deploy targets** (`worker/` and `frontend/`) and no CI/CD. Staging and prod always deploy **both together**, tagged with the same version, via `npm run deploy:staging` / `deploy:prod` (see docs/ENVIRONMENTS.md, "Deploys and version labels"), even if only one changed. Nothing auto-deploys on merge to `main`.

Binding-dependent behavior (ingestion, chat pipeline, screenshot capture) is covered by unit tests with mocked bindings; there is no integration test suite against real Vectorize/Workers AI/Browser Rendering — verify those manually via `wrangler tail` + the deployed app after a deploy.

## Architecture

### Request flow

`worker/src/index.ts` is the sole entry point — a flat `if` chain routing by method+path, wrapping every response in CORS (`cors.ts`). It defines the `Env` interface: every binding and secret the worker has (`AI`, `VECTORIZE`, `PDF_BUCKET`, `EDU_LIVE_DB`, `BROWSER`, `OPENROUTER_API_KEY`, `INGEST_API_KEY`, `ADMIN_API_KEY`).

### Ingestion (`POST /ingest`, `ingestion.ts`)

Admin-only (via the dashboard's upload card), gated by `x-ingest-key`. Sequence:

1. Dedup check: `PDF_BUCKET.head(filename)` — skips if already indexed, unless a `force` form field is set (then the old document's vectors, `page-images/`, and `cleaned/` text are deleted first via the OLD `chunkCount` read from R2 customMetadata, before re-ingesting fresh).
2. `extractPdfPages()` (`pdf.ts`) — plain per-page text via `unpdf` (PDF.js-based, pure JS, no Python). **Copies the input buffer before handing it to PDF.js** — PDF.js transfers (detaches) whatever ArrayBuffer it's given, which would otherwise make `pdfBytes` unusable for every step after it.
3. If `config.ingestionEnrichmentEnabled` (default true): `enrichPdfToMarkdown()` (`ingestionEnrichment.ts`) sends the **whole PDF in one call** to a PDF-capable OpenRouter model (default `google/gemini-2.5-flash`), prompted to re-emit every page as Markdown — formulas as LaTeX, tables as Markdown tables, figures/diagrams tagged `[Figure: description]` — each page prefixed with a `<<<PAGE n>>>` marker using the real page number. `parseEnrichedPages()` is the pure function that merges this back onto the PDF.js page list **by label, not position**: it looks up each real page number in the model's markers, and any page with no matching marker (or a truncated/missing response entirely) silently falls back to that page's plain-text extraction. Never throws; a bad OpenRouter call just means no enrichment for that document.
   - **Runaway-reply guards** (added in v1.1.1, after a prod upload failed with `VECTOR_UPSERT_ERROR … oversized metadata … 46834 bytes`): the model sometimes loops on tables, padding a row with hundreds of KB of spaces or growing one separator into a 48,000-character `:-----` token (about 4 in 5 runs on one Science paper before the prompt fix). So: the prompt forbids table padding and long separators; `max_tokens` is `enrichmentMaxTokens(pages)` (1,500 per page, 8,000–60,000); `collapseRepeatedRuns()` shortens filler runs (`----`, `____`, `....`), padding of 20+ spaces, and lines repeated back to back; `isRunawayPage()` sends any page still over 6,000 characters **and** over 4× its plain text back to plain text (real pages measured at most 4,316 characters and 3.05×). If fewer than half the pages came back usable and the first attempt took under 60 s, it retries once (120 s limit) and keeps the better attempt. `parseEnrichedPages()` returns the fallback array itself when no page was used, so the `enriched` flag is accurate.
4. Any page whose (possibly enriched) text contains `[Figure:` gets a real screenshot: `launchScreenshotBrowser()` + `capturePageScreenshot()` (`pageScreenshot.ts`) use Cloudflare Browser Rendering (`@cloudflare/puppeteer`) — one browser launched per ingest, reused across every figure page, PDF viewer toolbar/sidebar hidden via URL params so the capture is just page content. Stored at R2 `page-images/<filename>/<page>.png`. Fails open (no image, not a failure) on any error — known limitation: the `data:` URL approach has a practical ~2MB size ceiling, so very large PDFs may not get images even though text enrichment still works.
5. `chunkText()` (`chunker.ts`) — 300-word chunks, 50-word overlap, continuous across page boundaries (operates on the enriched text when enrichment applied). Each chunk's Vectorize metadata carries `pageImageKey` when its page range includes a captured screenshot. **The full chunk text is stored in Vectorize metadata (capped at 10,240 bytes of JSON) and read back by chat, explain, question papers and the admin preview.** Safety net: tokens over 200 characters are split, and a chunk ends early if its worst-case JSON-escaped size (`jsonMetadataBytes()`) would pass 8,000 bytes. Normal chunks are about 2 KB, so this never changes them. Note: the embedder and reranker read only the first 512 tokens; dense answer keys and LaTeX-heavy notes reach about 690 tokens per chunk, so the end of some chunks isn't embedded (the 50-word overlap covers most of it). Token-aware chunk sizes are a known follow-up.
6. Embed (Workers AI) → `VECTORIZE.upsert()` → **then, only on success**, `R2.put()` the source PDF with `{chunkCount, pageCount, indexedAt, enriched}` customMetadata, and (if enrichment actually changed the content) `R2.put('cleaned/<filename>.md', ...)` the full enriched text as a standalone viewable artifact.

**Why R2/cleaned-text writes happen last, not first**: an earlier version wrote R2 first; a failed retry would find the file "already there" and skip re-indexing forever (a poisoned filename with zero real chunks). Validating and writing last means a failed ingest leaves nothing behind.

### Chat (`POST /chat`, `chat.ts`)

Public, no auth. Fixed pipeline, `config` read fresh from D1 on every call (`config.ts`):

1. **Guardrail** (`guardrailCheck.ts`/`guardrail.ts`, if `guardrailEnabled`) — keyword blocklist + embedding-similarity scope check. **Fails closed** (blocks on error) — the only stage that does.
2. Embed question (Workers AI) → `VECTORIZE.query(topK)`.
3. **Rerank** (`rerank.ts`) — cross-encoder re-score. Falls back to cosine order on failure.
4. **JEV** (`jev.ts`, if `jevEnabled`) — OpenRouter relevance + prompt-injection check per chunk. **Fails open** (passes chunks through unfiltered) on error — a third-party outage shouldn't silently discard every chunk. Kept if relevance `≥ jevRelevanceThreshold` (configurable, default 1.5).
5. Confidence gate — `confidenceThreshold` (default 0 = off, deliberately: the reranker's raw scores aren't guaranteed non-negative, so "≥ 0" wouldn't reliably mean "always pass").
6. Web fallback (`webSearch.ts`, DuckDuckGo scrape, no API key) if `docSources` empty and `webSearchMode ≠ rag_only`. Never throws, degrades to empty results.
7. **Generation** via `generateChatCompletion()` (`llm.ts`) — the single entry point for answer generation, routes to `config.llmProvider`:
   - `openrouter` (**default**) — model from `config.llmModelSlug` (default `qwen/qwen3-235b-a22b:free`). Chosen specifically to reduce reliance on Workers AI's paid tier.
   - `workers-ai` — fixed `@cf/meta/llama-3.1-8b-instruct-fp8`, manual fallback option.
   - **Does not fail open** — a bad model slug or OpenRouter outage throws, so it's immediately visible rather than silently degrading quality/cost. This is deliberately different from every other stage in this pipeline.
   - `answerStyle` (`auto`/`short`/`detailed`) is a prompt fragment appended to one shared `SYSTEM_PROMPT`, not a separate prompt — plus a `max_tokens` cap per style (512/100/500). The system prompt also enforces source-fidelity: quote/closely paraphrase retrieved context, never add outside facts even ones the model "knows" are true. It also covers exam papers in the context (same rules in the explainer prompt): a question, option or assertion/reason statement from a question paper is not a fact (they are often deliberately wrong); answers to a specific paper question come from the same paper's answer key by question number; flawed questions are reported as flawed; mark tags (`[1]`, `[½]`) and tutor notes are left out.
8. `buildTransactionTrace()` (`transactionTrace.ts`) assembles one full record (every chunk's scores + kept/discarded, LLM I/O, provider/model, JEV model, token estimates) → inserted into D1 via `ctx.waitUntil()` (fire-and-forget, never delays the response).
9. Response includes `docSources` (each with `pageImageKey` when available) — the frontend renders the actual page screenshot as an `<img>` below the answer when present, not just the `[Figure: ...]` text description.

### Concept Explainer (`POST /explain`, `explain.ts`)

Public, no auth, gated only by `config.conceptExplainerEnabled`. Separate pipeline from `/chat` — retrieval is the same shape (embed → `VECTORIZE.query` → rerank → JEV → confidence gate) but generation and output are different:

- Same **guardrail** as chat (fails closed), run on the `concept` string instead of a question.
- Response is **structured JSON**, not prose: `{ concept, simpleExplanation, steps, formula, definition, table, realWorldExample }`, parsed tolerantly from a fenced ```json block (`parseExplainLlmResponse()` never throws — a truncated/malformed LLM response falls back to raw text in `simpleExplanation` with every other field `null`, same "never throws" posture as `parseEnrichedPages()` in ingestion).
- **Source-fidelity policy is a dashboard-configurable toggle**, `config.explainRetrievalMode` — this is the one place in the whole pipeline where "stay grounded in the documents" is *not* a fixed rule:
  - `rag_fallback` — strictly grounded when context was retrieved ("do not add outside facts... even ones you know to be true"); only falls back to the LLM's general knowledge when retrieval found *nothing* for the concept.
  - `rag_plus_llm` (**default**) — context (if any) is the primary source of truth for facts/formulas/definitions, but the LLM is explicitly told it "may and should complete the explanation (steps, plain-language framing, a real-world example)" from its own general knowledge, as long as it doesn't contradict the retrieved context.
  - Response carries `groundedIn: "documents" | "general_knowledge" | "both"` so the frontend/eval tooling can tell which policy applied to a given answer.
- No `modelOverride` support and no admin-key gate (unlike `/chat` and `/question-paper/generate`) — it always generates with whatever `config.llmProvider`/`llmModelSlug` is live in production, which matters for eval tooling (see Testing conventions below).
- Same transaction-trace-on-`ctx.waitUntil()` pattern as chat, `pathTaken: "concept_explainer"`.

### Question paper generation (`/question-paper/*`, `questionPaperGeneration.ts` + friends)

- `GET /question-paper/catalog` — lists indexed chapters available to build a paper from.
- `POST /question-paper/generate` — builds a paper against a blueprint of question-type "slots" (`questionPaperBlueprints.ts`) from one or more ingested chapters; admin-key-gated `modelOverride` lets eval tooling test a candidate model without touching the live config.
- `POST /question-paper/:id/answer-key` — generates the answer key for a previously generated paper.
- `GET /question-paper/:id/pdf` / `/answer-key-pdf` — rendered PDF downloads (`questionPaperPdf.ts`). Maths written as `$…$` / `$$…$$` is converted to **MathML in the Worker** (`renderMathText`, `katex` 0.16.9, the same version the student app loads), because Browser Rendering never ran KaTeX loaded from a CDN; the PDF HTML is self-contained (images as `data:` URLs). The optional `latex` field is shown only when the question text doesn't already contain it (`isFormulaInText`, mirrored in `frontend/app.js`). Rendered PDFs are stored in R2 under `question-papers/<id>-<PDF_RENDER_VERSION>.pdf` / `<id>-key-<version>.pdf` (`questionPaper.ts`); **bump `PDF_RENDER_VERSION` whenever PDF rendering changes**, or old stored PDFs keep being served. In the student app the buttons are "Generate Question Paper", "Download Question Paper", "Generate Answers", "Download Answers"; answers are listed by section so their numbers match the paper. Generated question and answer text is cleaned at display time by `cleanGeneratedText` (Worker, mirrored in `frontend/app.js`; a test keeps the two identical): answer keys arrive with line breaks as the characters backslash-n, so they become real breaks (LaTeX commands such as `\neq` kept), inline maths left open before a line break is closed, common LaTeX outside `$…$` becomes a symbol, and common mojibake is repaired. Question papers render `\frac` as `\dfrac`.
- **Deliberately allowed to use outside knowledge, unlike every other generation path in this codebase**: the prompt says "Prefer the provided source text; where it's thin, use your own syllabus knowledge rather than inventing facts" — if the source chapter is itself a ready-made question paper (a past CBSE test with an official answer key), reuse its question wording and official answer verbatim rather than re-deriving one.
- **Papers and answer keys are usually separate PDFs** (e.g. `X.pdf` and `X_WithAnswers.pdf`), and keys list answers by question number without repeating the question. The generation prompt matches answers **by question number within the same paper's key** (never another paper's key), checks the topic fits, never reuses a question twice, skips questions a key marks as flawed, and keeps mark tags out of the text. `correctAnswer` carries the key's full points and steps for written questions, because **the answer-key step (`questionPaperAnswerKey.ts`) never sees the source text** — only each question and its `correctAnswer`. Its `max_tokens` scales with the paper (`answerKeyMaxTokens`). Pairing is manual: the user selects both the paper and its key. The prompt treats any change to a reused question (wording, numbers, options, scenario, type) as a new question whose answer must be worked out, never copied. Code backstop `usableCorrectAnswer()`: placeholder answers (`---`, blank) are dropped, and an MCQ/assertion-reason answer that isn't a single option letter is dropped, so the answer-key step works it out instead. Known residual risk (measured): the model sometimes reorders or edits MCQ options and keeps the official letter (1–3 per 80-mark Maths paper); a deterministic check would need the original options, which the generator doesn't keep. In the sample Maths paper both remaining errors came from **enrichment misreading the source** (option 1/3 read as 3/4; a graph's x-axis crossings), not from generation.
- **JSON reliability:** the answer key uses strict structured output (`generateChatCompletion(..., { jsonSchema })`, OpenRouter `response_format: json_schema`, exactly one entry per question) and retries once if incomplete — Maths answer keys failed to parse 4/4 before (raw LaTeX escapes, raw newlines, quotes, structural slips), 4/4 complete after. Paper generation sends `jsonMode` (`json_object`), which this route did not enforce. `parseLlmJson()` repair path (only after a plain parse fails): pairwise escape repair (`sanitizeInvalidJsonEscapes`, keeps `\\sqrt`, fixes `\sqrt`, `\frac`, `\theta`, bad `\u`), then raw control characters and in-text quotes inside strings (`escapeRawControlCharsInStrings`). The prompt also states the exact question count.
- Results are cached (`questionPaperCache.ts`) keyed by inputs including any `modelOverride`, so an eval rerun against a candidate model doesn't collide with or reuse the real production cache entry for the same chapters. The key also includes `QUESTION_PAPER_PROMPT_VERSION`: **bump it whenever the generation or answer-key prompts change**, or old cached papers keep being served.

### Admin (`/admin/*`, `admin.ts`)

Gated by `x-admin-key` (optional — unauthenticated if unset, e.g. local dev). Routes: `GET /admin/documents` (lists R2 objects, excluding `page-images/`, `cleaned/` and `question-papers/` prefixes; includes the `enriched` flag), `GET /admin/documents/cleaned?name=` (fetches one document's enriched text on demand), `DELETE /admin/documents?name=` (`documentDeletion.ts`, the dashboard's per-row Delete button after a confirm dialog: removes the document's vectors by its stored `chunkCount`, `page-images/`, `cleaned/`, cached `question_papers` rows that used it plus their `question-papers/<id>*` files, and the source PDF **last** so a failed delete stays listed and can be retried; `transactions` are never touched), `GET /admin/transactions` (legacy: last N full traces), `GET /admin/transactions/recent?limit=` (summaries for the Transactions tab, max 200), `GET /admin/transactions/:id` (one full trace, loaded when a row is expanded), `GET /admin/costing?range=2h|1d|3d|7d|30d|all` (totals plus `byModel`, with JEV as its own row, and `byFeature`), `GET`/`PUT /admin/config`.

### Runtime config (`config.ts`)

D1-backed (`config` table, key/value), typed, validated, with safe defaults if D1 is unreachable. Every field is editable from the dashboard's Settings tab and takes effect on the **next** request — no redeploy (Workers have no long-running process to restart). Fields: `topK`, `confidenceThreshold`, `webSearchMode`, `hardFailNoDocument`, `jevEnabled`, `jevRelevanceThreshold`, `guardrailEnabled`, `llmProvider`, `llmModelSlug`, `ingestionEnrichmentEnabled`, `ingestionModelSlug`, `explainRetrievalMode`, `conceptExplainerEnabled`, `questionPaperModelSlug` (falls back to `llmModelSlug` at read time if unset — lets question papers follow a separate model from chat), `questionPaperImageGenEnabled` (off by default — image-gen models produce unreliable output for technical diagrams), `evalModelSlug` (not read by any production code path — purely a convenience default for `--model` in the manual eval script, see Testing conventions).

### Storage

- **R2** `edu-live-pdfs` — four prefixes sharing one bucket: source PDFs (bare filename), `page-images/<filename>/<page>.png` (screenshots), `cleaned/<filename>.md` (enriched text), `question-papers/<id>.pdf`, `<id>-key.pdf` and `<id>/gen-*.png` (rendered papers and generated images). The last three are deliberately excluded from `/admin/documents` listing.
- **Vectorize** `edu-live-chunks` — one vector per chunk. Deterministic IDs via `chunkVectorId()` (`vectorId.ts`, hash(filename)::chunkId) — re-ingestion overwrites rather than duplicates, and lets `force` re-ingest delete exactly the old document's chunks by recomputing IDs from its old `chunkCount`.
- **D1** `edu-live-db` — `transactions` (audit log and cost record: one row per chat answer, explanation, question paper, answer key and PDF enrichment attempt, written by `transactionLog.ts` — `recordTransaction` for chat/explain, `recordUsage` for the rest), `config` (runtime settings) and `question_papers` (cache). `path_taken` values: `pdf_only`, `web_fallback`, `concept_explainer`, `question_paper`, `answer_key`, `ingestion_enrichment`. Migrations in `worker/migrations/` (0006 added `answer_style`, `grounded_in`, `retrieval_mode`); apply them before deploying code that writes new columns.

### Failure philosophy (intentional, varies by stage)

Most stages fail open (degrade gracefully): reranker → cosine order, JEV → unfiltered passthrough, web search → empty results, PDF enrichment → plain-text fallback per page, screenshot capture → no image. Two stages are deliberate exceptions: the **guardrail fails closed** (blocks on error — better to over-block than expose a minor to an unchecked question), and the **LLM generation call throws** rather than silently falling back to a different provider (a cost/quality regression should never be invisible).

### Testing conventions

Vitest, mocked `Env` bindings (`AI`, `VECTORIZE`, `PDF_BUCKET`, `EDU_LIVE_DB`, `BROWSER` all stubbed per-test). `worker/test/*.test.ts` mirrors `worker/src/*.ts` one-to-one. Fail-open/fail-closed contracts are the thing most worth testing explicitly when touching any pipeline stage — every stage above has a test asserting its specific failure behavior, not just its happy path.

**Manual eval harness** (`worker/evals/`, `npm run eval`, never CI-triggered) — a separate golden-set regression suite that runs real HTTP calls against a deployed worker, for before/after comparisons around a model swap, prompt rewrite, or retrieval change. `golden-cases.json` cases carry a `mode`: `"chat"`, `"explain"`, or `"questionPaper"`, each dispatched to its own `run*Case()` function in `run-evals.js`. Grading is an LLM judge by default (`openai/gpt-4o-mini` — deliberately a different model than whatever's under test, which is `google/gemini-2.5-flash` for chat, explainer and question papers, so it isn't grading its own homework); it checks each case's `keyFacts` are conveyed *in meaning* against the generated output, paraphrase/extra-detail tolerant, only failing on a missing/contradicted/wrong fact. **The judge never reads the source PDFs or retrieved chunks** — it only sees the hand-authored `keyFacts` list and the generated answer, so it's a closed-book check against facts a human verified ahead of time, not an automated groundedness/hallucination check. `--no-judge` falls back to a cheap literal `cheapKeywords` substring check for a zero-LLM-call sanity pass. Per-mode grounding expectations differ and the harness's `keyFacts` should reflect them: `chat` is strictly grounded (no answer style permits adding outside facts, see Chat section above); `explain` depends on the live `explainRetrievalMode` (strict under `rag_fallback`-with-context, more lenient under the default `rag_plus_llm`); `questionPaper` deliberately allows syllabus-knowledge fill-in where source text is thin. `explain` cases always reflect whatever model is live in production config — `/explain` has no `modelOverride` support, unlike `/chat` and `/question-paper/generate`.

**Two eval suites**, picked with `--suite` (default `golden`): `npm run eval:golden` runs `golden-cases.json` (the general regression set above); `npm run eval:client` runs `client-papers-cases.json` (15 client acceptance cases from the four Edukripa sample papers: Science Test Paper 1 and Maths Paper 1, each with its answer key; every expected answer comes from the official key). Both take `-- --worker-url=<staging URL>`. Client `questionPaper` cases carry `referenceFiles`: the generated paper and answer key are checked structurally (one usable answer per question, no duplicates, no mark tags) and then compared with the official paper and key by a reference judge (`--reference-judge-model`, default `openai/gpt-4.1`; `gpt-4o-mini` gave many wrong verdicts on paper answers). The four official PDFs are not committed: put them in `worker/evals/reference-papers/` (gitignored) or pass `--reference-dir`. Which model generates answers is unchanged: `--model`, else the Settings `evalModelSlug`.

### Design history

`docs/superpowers/specs/` and `docs/superpowers/plans/` hold the full design rationale and implementation plans for each major feature, in chronological order — useful for "why was this built this way" questions beyond what's summarized above.
