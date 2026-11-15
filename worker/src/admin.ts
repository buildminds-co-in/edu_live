import type { Env } from "./index";
import { getRuntimeConfig, setRuntimeConfig, validateConfigUpdate } from "./config";
import { chunkVectorId } from "./vectorId";

export function isAdminAuthorized(request: Request, env: Env): boolean {
  if (!env.ADMIN_API_KEY) return true;
  return request.headers.get("x-admin-key") === env.ADMIN_API_KEY;
}

function adminErrorResponse(routeName: string, err: unknown): Response {
  console.error(`${routeName} failed`, err);
  return Response.json({ error: "Something went wrong loading this data - please try again." }, { status: 500 });
}

export async function handleAdminDocuments(env: Env): Promise<Response> {
  try {
    const listed = await env.PDF_BUCKET.list({ include: ["customMetadata"] });
    // page-images/ objects are captured page screenshots and cleaned/
    // objects are standalone enriched-text artifacts (see pageScreenshot.ts
    // and ingestion.ts) - neither is a source document, so both share this
    // bucket but must not show up as "documents" in the admin list.
    // question-papers/ holds rendered paper/answer-key PDFs and generated
    // images - also not source documents.
    const sourceObjects = listed.objects.filter(
      (obj) =>
        !obj.key.startsWith("page-images/") &&
        !obj.key.startsWith("cleaned/") &&
        !obj.key.startsWith("question-papers/")
    );

    const documents = sourceObjects.map((obj) => ({
      name: obj.key,
      sizeBytes: obj.size,
      indexedAt: obj.customMetadata?.indexedAt ?? null,
      chunkCount: obj.customMetadata?.chunkCount ? Number(obj.customMetadata.chunkCount) : null,
      pageCount: obj.customMetadata?.pageCount ? Number(obj.customMetadata.pageCount) : null,
      enriched: obj.customMetadata?.enriched === undefined ? null : obj.customMetadata.enriched === "true",
      subject: obj.customMetadata?.subject ?? null,
      chapter: obj.customMetadata?.chapter ?? null,
    }));

    const eligible = documents.filter((d) => d.indexedAt && d.chunkCount);
    const newest = [...eligible].sort((a, b) => (b.indexedAt! > a.indexedAt! ? 1 : -1)).slice(0, 3);
    const newestNames = new Set(newest.map((d) => d.name));

    const documentsWithChunks = await Promise.all(
      documents.map(async (doc) => {
        if (!newestNames.has(doc.name) || !doc.chunkCount) {
          return { ...doc, chunks: null as { chunkId: number; page: number; text: string }[] | null };
        }
        const ids = Array.from({ length: doc.chunkCount }, (_, i) => chunkVectorId(doc.name, i));
        const idToChunkId = new Map(ids.map((id, i) => [id, i]));
        try {
          const vectors = await env.VECTORIZE.getByIds(ids);
          const chunks = vectors
            .map((v) => ({
              chunkId: idToChunkId.get(v.id) ?? 0,
              page: Number(v.metadata?.page ?? 0),
              text: String(v.metadata?.text ?? ""),
            }))
            .sort((a, b) => a.chunkId - b.chunkId);
          return { ...doc, chunks };
        } catch (err) {
          console.error(`failed to fetch chunk preview for ${doc.name}`, err);
          return { ...doc, chunks: null as { chunkId: number; page: number; text: string }[] | null };
        }
      })
    );

    return Response.json({ documents: documentsWithChunks, chunkPreviewCount: newest.length });
  } catch (err) {
    return adminErrorResponse("/admin/documents", err);
  }
}

export async function handleAdminTransactions(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const requested = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 10) : 3;

    const result = await env.EDU_LIVE_DB.prepare("SELECT * FROM transactions ORDER BY timestamp DESC LIMIT ?")
      .bind(limit)
      .all<Record<string, unknown>>();

    const transactions = result.results.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      question: row.question,
      provider: row.provider,
      model: row.model,
      pathTaken: row.path_taken,
      confidence: row.confidence,
      retrieval: JSON.parse(row.retrieval_json as string),
      llmInput: row.llm_input,
      llmOutput: row.llm_output,
      jevInput: row.jev_input_json ? JSON.parse(row.jev_input_json as string) : null,
      jevOutput: row.jev_output_json ? JSON.parse(row.jev_output_json as string) : null,
      jevModel: row.jev_model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      jevCostUsd: row.jev_cost_usd,
      llmCostUsd: row.llm_cost_usd,
    }));

    return Response.json({ transactions });
  } catch (err) {
    return adminErrorResponse("/admin/transactions", err);
  }
}

// --- Transactions tab: list of summaries, plus one full trace on demand ---

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function transactionSummary(row: Record<string, unknown>) {
  const llmCostUsd = Number(row.llm_cost_usd ?? 0);
  const jevCostUsd = Number(row.jev_cost_usd ?? 0);
  return {
    id: row.id,
    timestamp: row.timestamp,
    question: row.question,
    provider: row.provider,
    model: row.model,
    pathTaken: row.path_taken,
    confidence: row.confidence,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    llmCostUsd,
    jevCostUsd,
    costUsd: llmCostUsd + jevCostUsd,
    jevModel: row.jev_model ?? null,
    answerStyle: row.answer_style ?? null,
    groundedIn: row.grounded_in ?? null,
    retrievalMode: row.retrieval_mode ?? null,
  };
}

/** GET /admin/transactions/recent?limit=N - newest first, summaries only (default 50, max 200). */
export async function handleAdminRecentTransactions(request: Request, env: Env): Promise<Response> {
  try {
    const requested = Number(new URL(request.url).searchParams.get("limit"));
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 200) : 50;
    const result = await env.EDU_LIVE_DB.prepare(
      `SELECT id, timestamp, question, provider, model, path_taken, confidence, input_tokens, output_tokens,
              llm_cost_usd, jev_cost_usd, jev_model, answer_style, grounded_in, retrieval_mode
       FROM transactions ORDER BY timestamp DESC LIMIT ?`
    )
      .bind(limit)
      .all<Record<string, unknown>>();
    return Response.json({ transactions: result.results.map(transactionSummary) });
  } catch (err) {
    return adminErrorResponse("/admin/transactions/recent", err);
  }
}

/** GET /admin/transactions/:id - one full trace (retrieval, LLM input/output, JEV). */
export async function handleAdminTransactionDetail(id: string, env: Env): Promise<Response> {
  try {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return Response.json({ error: "Invalid transaction id" }, { status: 400 });
    }
    const row = await env.EDU_LIVE_DB.prepare("SELECT * FROM transactions WHERE id = ?")
      .bind(numericId)
      .first<Record<string, unknown>>();
    if (!row) return Response.json({ error: "Transaction not found" }, { status: 404 });
    return Response.json({
      transaction: {
        ...transactionSummary(row),
        retrieval: parseJson(row.retrieval_json) ?? [],
        llmInput: row.llm_input ?? "",
        llmOutput: row.llm_output ?? "",
        jevInput: parseJson(row.jev_input_json),
        jevOutput: parseJson(row.jev_output_json),
      },
    });
  } catch (err) {
    return adminErrorResponse("/admin/transactions/:id", err);
  }
}

// --- Costing tab ---

const RANGE_TO_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "2h": 2 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};
export const COSTING_RANGES = ["2h", "1d", "3d", "7d", "30d", "all"] as const;

export async function handleAdminCosting(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const requestedRange = url.searchParams.get("range") ?? "1d";
    const range = requestedRange === "all" || RANGE_TO_MS[requestedRange] ? requestedRange : "1d";
    // "all" compares against the empty string, which every ISO timestamp passes.
    const since = range === "all" ? "" : new Date(Date.now() - RANGE_TO_MS[range]).toISOString();

    const lastTransaction = await env.EDU_LIVE_DB.prepare(
      "SELECT model, jev_model, input_tokens, output_tokens, jev_cost_usd, llm_cost_usd, timestamp FROM transactions ORDER BY timestamp DESC LIMIT 1"
    )
      .bind()
      .first();

    const summary = await env.EDU_LIVE_DB.prepare(
      `SELECT COUNT(*) as queryCount,
              COALESCE(SUM(input_tokens), 0) as inputTokens,
              COALESCE(SUM(output_tokens), 0) as outputTokens,
              COALESCE(SUM(jev_cost_usd), 0) as jevCostUsd,
              COALESCE(SUM(llm_cost_usd), 0) as llmCostUsd
       FROM transactions WHERE timestamp > ?`
    )
      .bind(since)
      .first<Record<string, number>>();

    // Answer-generating models (chat, explainer, question papers, answer keys,
    // enrichment), with the cost OpenRouter reported for each call.
    const byModelRows = await env.EDU_LIVE_DB.prepare(
      `SELECT model, provider, COUNT(*) as requests,
              COALESCE(SUM(input_tokens), 0) as inputTokens,
              COALESCE(SUM(output_tokens), 0) as outputTokens,
              COALESCE(SUM(llm_cost_usd), 0) as costUsd
       FROM transactions WHERE timestamp > ?
       GROUP BY model, provider ORDER BY costUsd DESC`
    )
      .bind(since)
      .all<Record<string, unknown>>();

    // JEV relevance checks run on their own model; only their cost is stored.
    const jevRows = await env.EDU_LIVE_DB.prepare(
      `SELECT jev_model as model, COUNT(*) as requests, COALESCE(SUM(jev_cost_usd), 0) as costUsd
       FROM transactions WHERE timestamp > ? AND jev_model IS NOT NULL AND jev_cost_usd > 0
       GROUP BY jev_model`
    )
      .bind(since)
      .all<Record<string, unknown>>();

    const byFeatureRows = await env.EDU_LIVE_DB.prepare(
      `SELECT path_taken as pathTaken, COUNT(*) as requests,
              COALESCE(SUM(input_tokens), 0) as inputTokens,
              COALESCE(SUM(output_tokens), 0) as outputTokens,
              COALESCE(SUM(llm_cost_usd + jev_cost_usd), 0) as costUsd
       FROM transactions WHERE timestamp > ?
       GROUP BY path_taken ORDER BY costUsd DESC`
    )
      .bind(since)
      .all<Record<string, unknown>>();

    const byModel = [
      ...byModelRows.results.map((r) => ({ ...r, role: "generation" })),
      ...jevRows.results.map((r) => ({ ...r, provider: "openrouter", inputTokens: null, outputTokens: null, role: "jev" })),
    ];
    const inputTokens = Number(summary?.inputTokens ?? 0);
    const outputTokens = Number(summary?.outputTokens ?? 0);
    const llmCostUsd = Number(summary?.llmCostUsd ?? 0);
    const jevCostUsd = Number(summary?.jevCostUsd ?? 0);

    return Response.json({
      range,
      since: since || null,
      lastTransaction: lastTransaction ?? null,
      summary: {
        ...summary,
        requests: Number(summary?.queryCount ?? 0),
        totalTokens: inputTokens + outputTokens,
        costUsd: llmCostUsd + jevCostUsd,
      },
      byModel,
      byFeature: byFeatureRows.results,
    });
  } catch (err) {
    return adminErrorResponse("/admin/costing", err);
  }
}

export async function handleAdminGetConfig(env: Env): Promise<Response> {
  try {
    const config = await getRuntimeConfig(env);
    return Response.json({ config });
  } catch (err) {
    return adminErrorResponse("/admin/config", err);
  }
}

export async function handleAdminPutConfig(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Expected a JSON object body" }, { status: 400 });
    }

    const errors = validateConfigUpdate(body);
    if (errors.length > 0) {
      return Response.json({ error: "Invalid config update", details: errors }, { status: 400 });
    }

    await setRuntimeConfig(env, body);
    const config = await getRuntimeConfig(env);
    return Response.json({ config });
  } catch (err) {
    return adminErrorResponse("/admin/config", err);
  }
}

export async function handleAdminGetCleanedDocument(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const name = url.searchParams.get("name");
    if (!name) {
      return Response.json({ error: "Expected a 'name' query parameter" }, { status: 400 });
    }

    const object = await env.PDF_BUCKET.get(`cleaned/${name}.md`);
    if (!object) {
      return Response.json({ error: "No cleaned text available for this document" }, { status: 404 });
    }

    return Response.json({ name, text: await object.text() });
  } catch (err) {
    return adminErrorResponse("/admin/documents/cleaned", err);
  }
}
