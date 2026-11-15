import { describe, it, expect, vi, afterEach } from "vitest";
import { generateAnswerKey, validateAnswerKey } from "../src/questionPaperAnswerKey";
import { GenerationError, type GeneratedPaper } from "../src/questionPaperGeneration";
import type { Env } from "../src/index";
import * as llm from "../src/llm";

afterEach(() => vi.restoreAllMocks());

const paper: GeneratedPaper = {
  subject: "Science",
  marksTotal: 40,
  blueprintVersion: "science-40-v1",
  sections: [{ section: "A", questions: [{ section: "A", questionType: "mcq", marks: 1, text: "What is catenation?" }] }],
};

describe("generateAnswerKey", () => {
  it("calls generateChatCompletion exactly once and returns one entry per question", async () => {
    const spy = vi.spyOn(llm, "generateChatCompletion").mockResolvedValue({
      text: JSON.stringify({ entries: [{ section: "A", questionIndex: 0, answer: "Carbon's ability to bond with itself." }] }),
      provider: "openrouter",
      model: "x",
    });

    const env = {} as Env;
    const key = await generateAnswerKey(env, paper, { llmProvider: "openrouter", questionPaperModelSlug: "some/model" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(key.entries).toHaveLength(1);
    expect(key.entries[0].answer).toContain("Carbon");
  });

  it("passes each question's correctAnswer (captured at generation time) into the prompt when present", async () => {
    const paperWithAnswers: GeneratedPaper = {
      ...paper,
      sections: [
        {
          section: "A",
          questions: [{ section: "A", questionType: "mcq", marks: 1, text: "What is catenation?", correctAnswer: "(B) self-linking" }],
        },
      ],
    };
    const spy = vi
      .spyOn(llm, "generateChatCompletion")
      .mockResolvedValue({ text: JSON.stringify({ entries: [{ section: "A", questionIndex: 0, answer: "x" }] }), provider: "openrouter", model: "x" });

    await generateAnswerKey({} as Env, paperWithAnswers, { llmProvider: "openrouter", questionPaperModelSlug: "some/model" });

    const userMessage = spy.mock.calls[0][0].find((m) => m.role === "user")!.content;
    expect(userMessage).toContain("(B) self-linking");
  });

  it("does not include the source chunk text in the prompt (reuses paper questions only)", async () => {
    const spy = vi
      .spyOn(llm, "generateChatCompletion")
      .mockResolvedValue({ text: JSON.stringify({ entries: [{ section: "A", questionIndex: 0, answer: "x" }] }), provider: "openrouter", model: "x" });

    const env = {} as Env;
    await generateAnswerKey(env, paper, { llmProvider: "openrouter", questionPaperModelSlug: "some/model" });

    const callArgs = spy.mock.calls[0][0];
    const userMessage = callArgs.find((m) => m.role === "user")!.content;
    expect(userMessage).toContain("What is catenation?");
  });

  it("throws GenerationError (instead of returning data to be cached) when JSON parses but has no entries array", async () => {
    vi.spyOn(llm, "generateChatCompletion").mockResolvedValue({
      text: JSON.stringify({ answers: [{ section: "A", questionIndex: 0, answer: "x" }] }),
      provider: "openrouter",
      model: "x",
    });
    await expect(
      generateAnswerKey({} as Env, paper, { llmProvider: "openrouter", questionPaperModelSlug: "m" })
    ).rejects.toThrow(GenerationError);
  });

  it("throws GenerationError when an entry is missing required fields", async () => {
    vi.spyOn(llm, "generateChatCompletion").mockResolvedValue({
      text: JSON.stringify({ entries: [{ section: "A", answer: "no index" }] }),
      provider: "openrouter",
      model: "x",
    });
    await expect(
      generateAnswerKey({} as Env, paper, { llmProvider: "openrouter", questionPaperModelSlug: "m" })
    ).rejects.toThrow(GenerationError);
  });

  it("accepts a fenced JSON response and strips unexpected extra fields", async () => {
    vi.spyOn(llm, "generateChatCompletion").mockResolvedValue({
      text: "```json\n" + JSON.stringify({ entries: [{ section: "A", questionIndex: 0, answer: "ok", extra: 1 }] }) + "\n```",
      provider: "openrouter",
      model: "x",
    });
    const key = await generateAnswerKey({} as Env, paper, { llmProvider: "openrouter", questionPaperModelSlug: "m" });
    expect(key).toEqual({ entries: [{ section: "A", questionIndex: 0, answer: "ok" }] });
  });
});

describe("validateAnswerKey", () => {
  it("rejects null, non-objects, and non-array entries", () => {
    expect(() => validateAnswerKey(null)).toThrow(GenerationError);
    expect(() => validateAnswerKey("x")).toThrow(GenerationError);
    expect(() => validateAnswerKey({ entries: {} })).toThrow(GenerationError);
  });
});

describe("answer key prompt and size", () => {
  it("keeps every point of the given correctAnswer and leaves out mark tags", async () => {
    let system = "";
    vi.spyOn(llm, "generateChatCompletion").mockImplementation(async (messages) => {
      system = messages.find((m) => m.role === "system")?.content ?? "";
      return { text: JSON.stringify({ entries: [{ section: "A", questionIndex: 0, answer: "x" }] }), provider: "openrouter", model: "x" };
    });
    await generateAnswerKey({} as Env, paper, { llmProvider: "openrouter", questionPaperModelSlug: "x" });
    expect(system).toMatch(/keep every point, value and step/i);
    expect(system).toMatch(/OR alternative/);
    expect(system).toMatch(/\[1\]/);
  });

  it("scales max tokens with the number of questions, within bounds", async () => {
    const { answerKeyMaxTokens } = await import("../src/questionPaperAnswerKey");
    expect(answerKeyMaxTokens(1)).toBe(3000);
    expect(answerKeyMaxTokens(38)).toBe(26600);
    expect(answerKeyMaxTokens(1000)).toBe(32000);
  });

  it("passes the scaled limit to the model", async () => {
    const { answerKeyMaxTokens } = await import("../src/questionPaperAnswerKey");
    const spy = vi.spyOn(llm, "generateChatCompletion").mockResolvedValue({
      text: JSON.stringify({ entries: [{ section: "A", questionIndex: 0, answer: "x" }] }),
      provider: "openrouter",
      model: "x",
    });
    await generateAnswerKey({} as Env, paper, { llmProvider: "openrouter", questionPaperModelSlug: "x" });
    expect(spy.mock.calls[0][1]).toBe(answerKeyMaxTokens(1));
  });
});

describe("answer key structured output and retry", () => {
  const twoQuestionPaper: GeneratedPaper = {
    ...paper,
    sections: [{ section: "A", questions: [
      { section: "A", questionType: "mcq", marks: 1, text: "Q1" },
      { section: "A", questionType: "mcq", marks: 1, text: "Q2" },
    ] }],
  };
  const reply = (n: number) => ({
    text: JSON.stringify({ entries: Array.from({ length: n }, (_, i) => ({ section: "A", questionIndex: i, answer: `a${i}` })) }),
    provider: "openrouter" as const,
    model: "x",
  });

  it("requests a strict schema with exactly one entry per question", async () => {
    const spy = vi.spyOn(llm, "generateChatCompletion").mockResolvedValue(reply(2));
    await generateAnswerKey({} as Env, twoQuestionPaper, { llmProvider: "openrouter", questionPaperModelSlug: "x" });
    const options = spy.mock.calls[0][4] as { jsonSchema?: { schema: { properties: { entries: { minItems: number; maxItems: number } } } } };
    expect(options.jsonSchema?.schema.properties.entries.minItems).toBe(2);
    expect(options.jsonSchema?.schema.properties.entries.maxItems).toBe(2);
  });

  it("retries once when the key is incomplete and keeps the complete result", async () => {
    const spy = vi.spyOn(llm, "generateChatCompletion").mockResolvedValueOnce(reply(1)).mockResolvedValueOnce(reply(2));
    const key = await generateAnswerKey({} as Env, twoQuestionPaper, { llmProvider: "openrouter", questionPaperModelSlug: "x" });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(key.entries).toHaveLength(2);
  });

  it("keeps the partial first key if the retry fails", async () => {
    vi.spyOn(llm, "generateChatCompletion").mockResolvedValueOnce(reply(1)).mockRejectedValueOnce(new Error("upstream"));
    const key = await generateAnswerKey({} as Env, twoQuestionPaper, { llmProvider: "openrouter", questionPaperModelSlug: "x" });
    expect(key.entries).toHaveLength(1);
  });
});
