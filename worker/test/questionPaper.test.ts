import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleQuestionPaperCatalog,
  handleQuestionPaperGenerate,
  handleQuestionPaperAnswerKey,
  handleQuestionPaperPdf,
  paperPdfKey,
  answerKeyPdfKey,
} from "../src/questionPaper";
import type { Env } from "../src/index";
import * as cache from "../src/questionPaperCache";
import * as retrieval from "../src/questionPaperRetrieval";
import * as generation from "../src/questionPaperGeneration";
import * as config from "../src/config";
import * as llm from "../src/llm";

function baseEnv(): Env {
  return {
    PDF_BUCKET: { list: vi.fn().mockResolvedValue({ objects: [] }) },
  } as unknown as Env;
}

describe("handleQuestionPaperCatalog", () => {
  it("returns subject/chapter/filename for ingested documents, excluding admin-only fields", async () => {
    const env = {
      PDF_BUCKET: {
        list: vi.fn().mockResolvedValue({
          objects: [
            { key: "ch.pdf", customMetadata: { subject: "Science", chapter: "Carbon", chunkCount: "5", enriched: "true" } },
          ],
        }),
      },
    } as unknown as Env;

    const response = await handleQuestionPaperCatalog(env);
    const body = (await response.json()) as any;
    expect(body.documents[0]).toEqual({ filename: "ch.pdf", subject: "Science", chapter: "Carbon" });
    expect(body.documents[0].chunkCount).toBeUndefined();
    expect(body.documents[0].enriched).toBeUndefined();
  });
});

describe("handleQuestionPaperGenerate", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns 400 when marksTotal has no matching blueprint", async () => {
    vi.spyOn(config, "getRuntimeConfig").mockResolvedValue({ llmProvider: "openrouter", questionPaperModelSlug: "x", questionPaperImageGenEnabled: false } as any);
    const env = baseEnv();
    const request = new Request("http://worker/question-paper/generate", {
      method: "POST",
      body: JSON.stringify({ subject: "History", chapterFilenames: ["a.pdf"], marksTotal: 40 }),
    });
    const response = await handleQuestionPaperGenerate(request, env);
    expect(response.status).toBe(400);
  });

  it("returns 400 when a chapter filename doesn't exist", async () => {
    vi.spyOn(config, "getRuntimeConfig").mockResolvedValue({ llmProvider: "openrouter", questionPaperModelSlug: "x", questionPaperImageGenEnabled: false } as any);
    vi.spyOn(cache, "findCachedPaper").mockResolvedValue(null);
    vi.spyOn(retrieval, "fetchAllChapterChunks").mockResolvedValue({ found: [], missing: ["missing.pdf"] });
    const env = baseEnv();
    const request = new Request("http://worker/question-paper/generate", {
      method: "POST",
      body: JSON.stringify({ subject: "Science", chapterFilenames: ["missing.pdf"], marksTotal: 40 }),
    });
    const response = await handleQuestionPaperGenerate(request, env);
    expect(response.status).toBe(400);
  });

  it("returns a cached paper directly without calling generatePaper", async () => {
    vi.spyOn(config, "getRuntimeConfig").mockResolvedValue({ llmProvider: "openrouter", questionPaperModelSlug: "x", questionPaperImageGenEnabled: false } as any);
    vi.spyOn(cache, "findCachedPaper").mockResolvedValue({
      id: "p1",
      cacheKey: "k1",
      subject: "Science",
      marksTotal: 40,
      chapterFilenames: ["a.pdf"],
      blueprintVersion: "science-40-v1",
      paperJson: { sections: [] },
      answerKeyJson: null,
      pdfR2Key: null,
      answerKeyPdfR2Key: null,
      createdAt: "2026-10-03T00:00:00.000Z",
    });
    const generateSpy = vi.spyOn(generation, "generatePaper");

    const env = baseEnv();
    const request = new Request("http://worker/question-paper/generate", {
      method: "POST",
      body: JSON.stringify({ subject: "Science", chapterFilenames: ["a.pdf"], marksTotal: 40 }),
    });
    const response = await handleQuestionPaperGenerate(request, env);
    const body = (await response.json()) as any;

    expect(body.id).toBe("p1");
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it.each([10000000, 501, 0, -40, 40.5, "40"])(
    "rejects out-of-bound or non-integer marksTotal=%s with 400 before any lookup or LLM call",
    async (marksTotal) => {
      const findSpy = vi.spyOn(cache, "findCachedPaper").mockResolvedValue(null);
      const generateSpy = vi.spyOn(generation, "generatePaper");
      const request = new Request("http://worker/question-paper/generate", {
        method: "POST",
        body: JSON.stringify({ subject: "Science", chapterFilenames: ["a.pdf"], marksTotal }),
      });
      const response = await handleQuestionPaperGenerate(request, baseEnv());
      expect(response.status).toBe(400);
      expect(((await response.json()) as any).error).toMatch(/marksTotal/);
      expect(findSpy).not.toHaveBeenCalled();
      expect(generateSpy).not.toHaveBeenCalled();
    }
  );

  it("returns the concurrent winner's paper and id when saveNewPaper reports a cache_key conflict", async () => {
    vi.spyOn(config, "getRuntimeConfig").mockResolvedValue({ llmProvider: "openrouter", questionPaperModelSlug: "x", questionPaperImageGenEnabled: false } as any);
    vi.spyOn(cache, "findCachedPaper").mockResolvedValue(null);
    vi.spyOn(retrieval, "fetchAllChapterChunks").mockResolvedValue({
      found: [{ filename: "a.pdf", chunkCount: 1, chunks: [{ chunkId: 0, page: 1, text: "t", pageImageKey: null }] }],
      missing: [],
    });
    vi.spyOn(generation, "generatePaper").mockResolvedValue({
      subject: "Science",
      marksTotal: 40,
      blueprintVersion: "science-40-v1",
      sections: [{ section: "A", questions: [] }],
    });
    const winnerPaper = { subject: "Science", marksTotal: 40, blueprintVersion: "science-40-v1", sections: [] };
    const saveSpy = vi.spyOn(cache, "saveNewPaper").mockImplementation(async (_env, row) => ({
      ...row,
      id: "winner-id",
      paperJson: winnerPaper,
      createdAt: "2026-10-03T00:00:00.000Z",
    }));

    const response = await handleQuestionPaperGenerate(
      new Request("http://worker/question-paper/generate", {
        method: "POST",
        body: JSON.stringify({ subject: "Science", chapterFilenames: ["a.pdf"], marksTotal: 40 }),
      }),
      baseEnv()
    );
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.id).toBe("winner-id");
    expect(body.paper).toEqual(winnerPaper);
    expect(body.cached).toBe(true);
    expect(saveSpy.mock.calls[0][1].subject).toBe("Science");
  });
});

describe("handleQuestionPaperAnswerKey / handleQuestionPaperPdf", () => {
  it("answer key returns 404 for an unknown paper id", async () => {
    vi.spyOn(cache, "findPaperById").mockResolvedValue(null);
    const env = baseEnv();
    const request = new Request("http://worker/question-paper/unknown/answer-key", { method: "POST" });
    const response = await handleQuestionPaperAnswerKey(request, env, "unknown");
    expect(response.status).toBe(404);
  });

  it("does not cache a malformed answer key - returns an error and never calls saveAnswerKey", async () => {
    vi.spyOn(cache, "findPaperById").mockResolvedValue({
      id: "p1",
      cacheKey: "k1",
      subject: "Science",
      marksTotal: 40,
      chapterFilenames: ["a.pdf"],
      blueprintVersion: "science-40-v1",
      paperJson: { subject: "Science", marksTotal: 40, blueprintVersion: "v", sections: [{ section: "A", questions: [{ section: "A", questionType: "mcq", marks: 1, text: "Q" }] }] },
      answerKeyJson: null,
      pdfR2Key: null,
      answerKeyPdfR2Key: null,
      createdAt: "2026-10-03T00:00:00.000Z",
    });
    vi.spyOn(config, "getRuntimeConfig").mockResolvedValue({ llmProvider: "openrouter", questionPaperModelSlug: "x" } as any);
    vi.spyOn(llm, "generateChatCompletion").mockResolvedValue({ text: '{"answers": []}', provider: "openrouter", model: "x" });
    const saveSpy = vi.spyOn(cache, "saveAnswerKey").mockResolvedValue(undefined);

    const response = await handleQuestionPaperAnswerKey(
      new Request("http://worker/question-paper/p1/answer-key", { method: "POST" }),
      baseEnv(),
      "p1"
    );

    expect(response.status).toBe(500);
    expect(saveSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("does not serve a PDF stored by an older renderer, and serves one stored by the current renderer", async () => {
    const row = {
      id: "p1",
      cacheKey: "k1",
      subject: "Maths",
      marksTotal: 40,
      chapterFilenames: ["a.pdf"],
      blueprintVersion: "maths-40-v1",
      paperJson: { subject: "Maths", marksTotal: 40, blueprintVersion: "v", sections: [] },
      answerKeyJson: { entries: [] },
      answerKeyPdfR2Key: null,
      createdAt: "2026-11-16T00:00:00.000Z",
    };
    const get = vi.fn(async () => ({ body: "stored-pdf" }));
    const env = { ...baseEnv(), PDF_BUCKET: { get, put: vi.fn() }, BROWSER: {} } as unknown as Env;

    // Old name (raw-LaTeX PDF): not read back; a fresh render is attempted
    // (fails in tests: no Browser Rendering), so the old file is not served.
    vi.spyOn(cache, "findPaperById").mockResolvedValue({ ...row, pdfR2Key: "question-papers/p1.pdf" } as any);
    const stale = await handleQuestionPaperPdf(env, "p1");
    expect(get).not.toHaveBeenCalledWith("question-papers/p1.pdf");
    expect(stale.status).toBe(500);

    vi.spyOn(cache, "findPaperById").mockResolvedValue({ ...row, pdfR2Key: paperPdfKey("p1") } as any);
    const current = await handleQuestionPaperPdf(env, "p1");
    expect(get).toHaveBeenCalledWith("question-papers/p1-r2.pdf");
    expect(current.status).toBe(200);
    expect(await current.text()).toBe("stored-pdf");

    expect(answerKeyPdfKey("p1")).toBe("question-papers/p1-key-r2.pdf");
    vi.restoreAllMocks();
  });

  it("pdf returns 404 for an unknown paper id", async () => {
    vi.spyOn(cache, "findPaperById").mockResolvedValue(null);
    const env = baseEnv();
    const response = await handleQuestionPaperPdf(env, "unknown");
    expect(response.status).toBe(404);
  });
});

describe("question paper cache key", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("includes the prompt version, so papers cached under older prompts are regenerated", async () => {
    vi.spyOn(config, "getRuntimeConfig").mockResolvedValue({ llmProvider: "openrouter", questionPaperModelSlug: "x", questionPaperImageGenEnabled: false } as any);
    const keySpy = vi.spyOn(cache, "computeCacheKey");
    vi.spyOn(cache, "findCachedPaper").mockResolvedValue(null);
    vi.spyOn(retrieval, "fetchAllChapterChunks").mockResolvedValue({ found: [], missing: ["missing.pdf"] });
    const request = new Request("http://worker/question-paper/generate", {
      method: "POST",
      body: JSON.stringify({ subject: "Science", chapterFilenames: ["missing.pdf"], marksTotal: 40 }),
    });
    await handleQuestionPaperGenerate(request, baseEnv());
    expect(keySpy).toHaveBeenCalled();
    expect(String(keySpy.mock.calls[0][3])).toContain(generation.QUESTION_PAPER_PROMPT_VERSION);
  });
});

describe("answer keys get no slots when a question paper is selected", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("recognises answer-key file names", async () => {
    const { isAnswerKeyFilename } = await import("../src/questionPaper");
    expect(isAnswerKeyFilename("Edukripa_CBSE10_Maths_Paper1_WithAnswers.pdf")).toBe(true);
    expect(isAnswerKeyFilename("Edukripa_Science_Test_Paper_1WithAnswers.pdf")).toBe(true);
    expect(isAnswerKeyFilename("Physics Answer Key.pdf")).toBe(true);
    expect(isAnswerKeyFilename("Marking Scheme 2025.pdf")).toBe(true);
    expect(isAnswerKeyFilename("Edukripa_Science_Test_Paper_1.pdf")).toBe(false);
    expect(isAnswerKeyFilename("carbon compound notes.pdf")).toBe(false);
    expect(isAnswerKeyFilename("control coordination test.pdf")).toBe(false);
  });

  it("gives every slot to the question paper and none to its answer key, but still passes the key's text", async () => {
    vi.spyOn(config, "getRuntimeConfig").mockResolvedValue({ llmProvider: "openrouter", questionPaperModelSlug: "x", questionPaperImageGenEnabled: false } as any);
    vi.spyOn(cache, "findCachedPaper").mockResolvedValue(null);
    const chunk = (t: string) => [{ chunkId: 0, page: 1, text: t, pageImageKey: null }];
    vi.spyOn(retrieval, "fetchAllChapterChunks").mockResolvedValue({
      found: [
        { filename: "Paper1.pdf", chunkCount: 13, chunks: chunk("questions") },
        { filename: "Paper1_WithAnswers.pdf", chunkCount: 10, chunks: chunk("answers") },
      ],
      missing: [],
    });
    const genSpy = vi.spyOn(generation, "generatePaper").mockResolvedValue({ subject: "Science", marksTotal: 80, blueprintVersion: "v", sections: [] });
    vi.spyOn(cache, "saveNewPaper").mockImplementation(async (_env, row) => ({ ...row, createdAt: "t" }) as any);
    await handleQuestionPaperGenerate(
      new Request("http://worker/question-paper/generate", {
        method: "POST",
        body: JSON.stringify({ subject: "Science", chapterFilenames: ["Paper1.pdf", "Paper1_WithAnswers.pdf"], marksTotal: 80 }),
      }),
      baseEnv()
    );
    const chapters = genSpy.mock.calls[0][2] as { chunks: { filename: string }; slots: unknown[] }[];
    const paper = chapters.find((c) => c.chunks.filename === "Paper1.pdf")!;
    const key = chapters.find((c) => c.chunks.filename === "Paper1_WithAnswers.pdf")!;
    expect(key.slots).toHaveLength(0);
    expect(paper.slots.length).toBeGreaterThan(0);
  });

  it("still gives slots to an answer key when it is the only file selected", async () => {
    vi.spyOn(config, "getRuntimeConfig").mockResolvedValue({ llmProvider: "openrouter", questionPaperModelSlug: "x", questionPaperImageGenEnabled: false } as any);
    vi.spyOn(cache, "findCachedPaper").mockResolvedValue(null);
    vi.spyOn(retrieval, "fetchAllChapterChunks").mockResolvedValue({
      found: [{ filename: "Paper1_WithAnswers.pdf", chunkCount: 10, chunks: [{ chunkId: 0, page: 1, text: "answers", pageImageKey: null }] }],
      missing: [],
    });
    const genSpy = vi.spyOn(generation, "generatePaper").mockResolvedValue({ subject: "Science", marksTotal: 80, blueprintVersion: "v", sections: [] });
    vi.spyOn(cache, "saveNewPaper").mockImplementation(async (_env, row) => ({ ...row, createdAt: "t" }) as any);
    await handleQuestionPaperGenerate(
      new Request("http://worker/question-paper/generate", {
        method: "POST",
        body: JSON.stringify({ subject: "Science", chapterFilenames: ["Paper1_WithAnswers.pdf"], marksTotal: 80 }),
      }),
      baseEnv()
    );
    const chapters = genSpy.mock.calls[0][2] as { slots: unknown[] }[];
    expect(chapters[0].slots.length).toBeGreaterThan(0);
  });
});
