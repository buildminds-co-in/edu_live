import { describe, it, expect, vi, afterEach } from "vitest";
import { handleAdminRecentTransactions, handleAdminTransactionDetail, handleAdminCosting } from "../src/admin";
import { recordTransaction, recordUsage } from "../src/transactionLog";
import type { Env } from "../src/index";

afterEach(() => vi.restoreAllMocks());

/** A D1 mock that records each statement and its bound values, answering by SQL text. */
function mockDb(answer: (sql: string, args: unknown[]) => { first?: unknown; results?: unknown[] }) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        calls.push({ sql, args });
        return {
          first: async () => answer(sql, args).first ?? null,
          all: async () => ({ results: answer(sql, args).results ?? [] }),
          run: async () => ({}),
        };
      },
    }),
  } as unknown as Env["EDU_LIVE_DB"];
  return { db, calls };
}

const ROW = {
  id: 7,
  timestamp: "2026-11-15T10:00:00.000Z",
  question: "explain myopia",
  provider: "openrouter",
  model: "google/gemini-2.5-flash",
  path_taken: "concept_explainer",
  confidence: 0.8,
  input_tokens: 1862,
  output_tokens: 786,
  llm_cost_usd: 0.002,
  jev_cost_usd: 0.0005,
  jev_model: "~typesafe/jev-latest",
  answer_style: null,
  grounded_in: "both",
  retrieval_mode: "rag_plus_llm",
  retrieval_json: JSON.stringify([{ rank: 1, source: "eye.pdf", page: 3, chunkId: 2, cosineScore: 0.8, rerankScore: 0.8, jevRelevance: 5, status: "kept" }]),
  llm_input: "Context: ...",
  llm_output: "Myopia is ...",
  jev_input_json: null,
  jev_output_json: null,
};

describe("GET /admin/transactions/recent", () => {
  it("returns newest-first summaries with input/output tokens and total cost, without the heavy fields", async () => {
    const { db, calls } = mockDb(() => ({ results: [ROW] }));
    const res = await handleAdminRecentTransactions(new Request("https://w/admin/transactions/recent"), { EDU_LIVE_DB: db } as Env);
    const body = (await res.json()) as { transactions: Record<string, unknown>[] };
    expect(calls[0].args).toEqual([50]);
    expect(body.transactions[0]).toMatchObject({
      id: 7,
      pathTaken: "concept_explainer",
      inputTokens: 1862,
      outputTokens: 786,
      groundedIn: "both",
      retrievalMode: "rag_plus_llm",
    });
    expect(body.transactions[0].costUsd).toBeCloseTo(0.0025);
    expect(body.transactions[0]).not.toHaveProperty("llmInput");
  });

  it("caps the limit at 200", async () => {
    const { db, calls } = mockDb(() => ({ results: [] }));
    await handleAdminRecentTransactions(new Request("https://w/admin/transactions/recent?limit=5000"), { EDU_LIVE_DB: db } as Env);
    expect(calls[0].args).toEqual([200]);
  });
});

describe("GET /admin/transactions/:id", () => {
  it("returns the full trace for one transaction", async () => {
    const { db } = mockDb(() => ({ first: ROW }));
    const res = await handleAdminTransactionDetail("7", { EDU_LIVE_DB: db } as Env);
    const body = (await res.json()) as { transaction: { retrieval: unknown[]; llmOutput: string } };
    expect(res.status).toBe(200);
    expect(body.transaction.retrieval).toHaveLength(1);
    expect(body.transaction.llmOutput).toBe("Myopia is ...");
  });

  it("rejects a non-numeric id and reports a missing one", async () => {
    const { db } = mockDb(() => ({ first: null }));
    expect((await handleAdminTransactionDetail("abc", { EDU_LIVE_DB: db } as Env)).status).toBe(400);
    expect((await handleAdminTransactionDetail("99", { EDU_LIVE_DB: db } as Env)).status).toBe(404);
  });
});

describe("GET /admin/costing ranges and breakdowns", () => {
  it.each(["2h", "1d", "3d", "7d", "30d"])("accepts range %s and filters by time", async (range) => {
    const { db, calls } = mockDb(() => ({ results: [] }));
    const res = await handleAdminCosting(new Request(`https://w/admin/costing?range=${range}`), { EDU_LIVE_DB: db } as Env);
    expect(((await res.json()) as { range: string }).range).toBe(range);
    const since = calls.find((c) => c.sql.includes("WHERE timestamp > ?"))!.args[0] as string;
    expect(new Date(since).getTime()).toBeLessThan(Date.now());
  });

  it("'all' does not filter by time", async () => {
    const { db, calls } = mockDb(() => ({ results: [] }));
    const res = await handleAdminCosting(new Request("https://w/admin/costing?range=all"), { EDU_LIVE_DB: db } as Env);
    expect(((await res.json()) as { range: string }).range).toBe("all");
    expect(calls.find((c) => c.sql.includes("WHERE timestamp > ?"))!.args[0]).toBe("");
  });

  it("returns totals, a per-model table (with JEV as its own row) and a per-feature table", async () => {
    const { db } = mockDb((sql) => {
      if (sql.includes("COUNT(*) as queryCount")) return { first: { queryCount: 3, inputTokens: 1000, outputTokens: 500, jevCostUsd: 0.001, llmCostUsd: 0.02 } };
      if (sql.includes("GROUP BY model, provider")) return { results: [{ model: "google/gemini-2.5-flash", provider: "openrouter", requests: 3, inputTokens: 1000, outputTokens: 500, costUsd: 0.02 }] };
      if (sql.includes("GROUP BY jev_model")) return { results: [{ model: "~typesafe/jev-latest", requests: 2, costUsd: 0.001 }] };
      if (sql.includes("GROUP BY path_taken")) return { results: [{ pathTaken: "question_paper", requests: 1, inputTokens: 800, outputTokens: 400, costUsd: 0.015 }] };
      return {};
    });
    const res = await handleAdminCosting(new Request("https://w/admin/costing?range=7d"), { EDU_LIVE_DB: db } as Env);
    const body = (await res.json()) as {
      summary: { requests: number; totalTokens: number; costUsd: number };
      byModel: { model: string; role: string; inputTokens: number | null }[];
      byFeature: { pathTaken: string }[];
    };
    expect(body.summary.requests).toBe(3);
    expect(body.summary.totalTokens).toBe(1500);
    expect(body.summary.costUsd).toBeCloseTo(0.021);
    expect(body.byModel.map((m) => m.role)).toEqual(["generation", "jev"]);
    expect(body.byModel[1].inputTokens).toBeNull();
    expect(body.byFeature[0].pathTaken).toBe("question_paper");
  });
});

describe("transaction log", () => {
  it("records the answer style, grounded-in and retrieval mode columns", async () => {
    const { db, calls } = mockDb(() => ({}));
    await recordTransaction({ EDU_LIVE_DB: db } as Env, {
      timestamp: "t", question: "q", provider: "p", model: "m", pathTaken: "concept_explainer", confidence: null,
      retrieval: [], llmInput: "i", llmOutput: "o", jevInput: null, jevOutput: null, jevModel: null,
      inputTokens: 1, outputTokens: 2, jevCostUsd: 0, llmCostUsd: 0, groundedIn: "both", retrievalMode: "rag_plus_llm",
    });
    expect(calls[0].sql).toContain("answer_style, grounded_in, retrieval_mode");
    expect(calls[0].args.slice(-3)).toEqual([null, "both", "rag_plus_llm"]);
  });

  it("records non-chat usage (question papers, answer keys, enrichment) with tokens, cost and a short summary", async () => {
    const { db, calls } = mockDb(() => ({}));
    await recordUsage({ EDU_LIVE_DB: db } as Env, {
      pathTaken: "answer_key", description: "Answer key: Maths 60 marks", provider: "openrouter", model: "google/gemini-2.5-flash",
      inputTokens: 1200, outputTokens: 9000, costUsd: 0.023, outputSummary: "x".repeat(5000),
    });
    const args = calls[0].args;
    expect(args[4]).toBe("answer_key");
    expect((args[8] as string).length).toBe(2000); // output summary trimmed
    expect(args[11]).toBe(1200);
    expect(args[12]).toBe(9000);
    expect(args[14]).toBe(0.023);
  });

  it("never throws when D1 fails", async () => {
    const env = { EDU_LIVE_DB: { prepare: () => { throw new Error("D1 down"); } } } as unknown as Env;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recordUsage(env, { pathTaken: "question_paper", description: "d", provider: "p", model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0 })).resolves.toBeUndefined();
  });
});
