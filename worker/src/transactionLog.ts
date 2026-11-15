import type { Env } from "./index";
import type { PathTaken, TransactionTrace } from "./transactionTrace";

/**
 * Writes one row to the D1 `transactions` table: the audit log behind the
 * dashboard's Transactions and Costing tabs. Never throws - a failed write is
 * logged and dropped, so recording never breaks the request it describes.
 * (Before migration 0006 is applied, the three newest columns don't exist and
 * every insert fails this way; apply migrations before deploying code.)
 */
export async function recordTransaction(env: Env, trace: TransactionTrace): Promise<void> {
  try {
    await env.EDU_LIVE_DB.prepare(
      `INSERT INTO transactions
        (timestamp, question, provider, model, path_taken, confidence, retrieval_json,
         llm_input, llm_output, jev_input_json, jev_output_json, input_tokens, output_tokens,
         jev_cost_usd, llm_cost_usd, jev_model, answer_style, grounded_in, retrieval_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        trace.timestamp,
        trace.question,
        trace.provider,
        trace.model,
        trace.pathTaken,
        trace.confidence,
        JSON.stringify(trace.retrieval),
        trace.llmInput,
        trace.llmOutput,
        trace.jevInput ? JSON.stringify(trace.jevInput) : null,
        trace.jevOutput ? JSON.stringify(trace.jevOutput) : null,
        trace.inputTokens,
        trace.outputTokens,
        trace.jevCostUsd,
        trace.llmCostUsd,
        trace.jevModel,
        trace.answerStyle ?? null,
        trace.groundedIn ?? null,
        trace.retrievalMode ?? null
      )
      .run();
  } catch (err) {
    console.error(`failed to record ${trace.pathTaken} transaction`, err);
  }
}

// Stored inputs/outputs for non-chat calls are short summaries, not the full
// prompt: question-paper prompts carry up to 30,000 characters of source text
// per chapter, and the full output is already kept with the paper itself.
const MAX_SUMMARY_CHARS = 2000;

/**
 * Records a model call that isn't a chat or explainer answer (question-paper
 * generation, answer keys, PDF enrichment), so Costing covers all spend.
 */
export async function recordUsage(
  env: Env,
  usage: {
    pathTaken: Extract<PathTaken, "question_paper" | "answer_key" | "ingestion_enrichment">;
    description: string;
    provider: string;
    model: string;
    inputTokens: number | null | undefined;
    outputTokens: number | null | undefined;
    costUsd: number | null | undefined;
    inputSummary?: string;
    outputSummary?: string;
  }
): Promise<void> {
  await recordTransaction(env, {
    timestamp: new Date().toISOString(),
    question: usage.description,
    provider: usage.provider,
    model: usage.model,
    pathTaken: usage.pathTaken,
    confidence: null,
    retrieval: [],
    llmInput: (usage.inputSummary ?? "").slice(0, MAX_SUMMARY_CHARS),
    llmOutput: (usage.outputSummary ?? "").slice(0, MAX_SUMMARY_CHARS),
    jevInput: null,
    jevOutput: null,
    jevModel: null,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    jevCostUsd: 0,
    llmCostUsd: usage.costUsd ?? 0,
  });
}
