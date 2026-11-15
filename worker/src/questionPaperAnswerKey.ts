import type { Env } from "./index";
import { GenerationError, parseLlmJson, type GeneratedPaper } from "./questionPaperGeneration";
import { generateChatCompletion } from "./llm";

export interface AnswerKeyEntry {
  section: string;
  questionIndex: number;
  answer: string;
}

export interface AnswerKey {
  entries: AnswerKeyEntry[];
}

// A flat 3,000 tokens left about 80 tokens per answer on an 80-mark paper
// (about 38 questions). Maths keys with worked steps measured about 9,500
// tokens and were cut off mid-JSON (finish_reason "length"), so this allows
// 700 per question, bounded. The prompt also asks for answers sized to marks.
export function answerKeyMaxTokens(questionCount: number): number {
  return Math.min(32000, Math.max(3000, questionCount * 700));
}

export async function generateAnswerKey(
  env: Env,
  paper: GeneratedPaper,
  config: { llmProvider: "openrouter" | "workers-ai"; questionPaperModelSlug: string }
): Promise<AnswerKey> {
  const system =
    "You are a CBSE/ICSE class 10 examiner writing a concise, mark-scheme-style answer key. " +
    "For each question, give the key points/model answer only - not a full essay. Where a correctAnswer is given, " +
    "it is the grounded answer, often the official answer from the paper's own answer key. Keep every point, " +
    "value and step it contains, in the same order, and only rephrase it into exam-answer wording: for an option " +
    "letter, also state what that option says. Do not contradict it, drop parts of it, or add facts it does not " +
    "need. For a question with an OR alternative, answer each alternative and label them. Only work out the " +
    "answer yourself for a question with no correctAnswer given. Do not include mark tags such as [1] or [½]. " +
    "Size each answer to its marks (at most about 25 words per mark): do not restate the question or list the " +
    "options. Inside JSON strings, escape every backslash in LaTeX as \\\\ (for example \"\\\\frac{1}{2}\"). " +
    "Return ONLY valid JSON.";

  const questionLines = paper.sections
    .flatMap((s) => s.questions.map((q, i) => ({ section: s.section, questionIndex: i, text: q.text, marks: q.marks, correctAnswer: q.correctAnswer })))
    .map(
      (q) =>
        `section=${q.section} index=${q.questionIndex} marks=${q.marks}` +
        `${q.correctAnswer ? ` correctAnswer=${JSON.stringify(q.correctAnswer)}` : ""}: ${q.text}`
    )
    .join("\n");

  const user =
    `Write answers for each question below.\n${questionLines}\n\n` +
    `Return JSON: {"entries": [{"section": string, "questionIndex": number, "answer": string}]}, one entry per question above.`;

  const questionCount = paper.sections.reduce((n, s) => n + s.questions.length, 0);
  const attempt = async (): Promise<AnswerKey> => {
    const result = await generateChatCompletion(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      answerKeyMaxTokens(questionCount),
      env,
      { llmProvider: config.llmProvider, llmModelSlug: config.questionPaperModelSlug },
      { jsonSchema: { name: "answer_key", schema: answerKeySchema(questionCount) } }
    );
    return validateAnswerKey(parseLlmJson(result.text));
  };

  // Structured output guarantees valid JSON, but the model occasionally stops
  // early (measured: 9 of 38 entries once in 4 runs). One retry when the key
  // is incomplete or unparseable; the more complete result wins.
  let first: AnswerKey | null = null;
  try {
    first = await attempt();
    if (first.entries.length >= questionCount) return first;
    console.error(`answer key had ${first.entries.length}/${questionCount} entries, retrying once`);
  } catch (err) {
    console.error("answer key attempt failed, retrying once", err);
  }
  try {
    const second = await attempt();
    return first && first.entries.length > second.entries.length ? first : second;
  } catch (err) {
    if (first) return first;
    throw err;
  }
}

/** Strict schema: exactly one entry per question. */
export function answerKeySchema(questionCount: number): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["entries"],
    properties: {
      entries: {
        type: "array",
        minItems: questionCount,
        maxItems: questionCount,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["section", "questionIndex", "answer"],
          properties: { section: { type: "string" }, questionIndex: { type: "integer" }, answer: { type: "string" } },
        },
      },
    },
  };
}

/**
 * The caller caches whatever this returns permanently, so anything that
 * isn't a well-formed {entries: [...]} must throw here rather than be cached
 * (a cached {answers: [...]} would break that paper's answer key forever).
 */
export function validateAnswerKey(parsed: unknown): AnswerKey {
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) {
    throw new GenerationError("Answer key response is missing an 'entries' array");
  }
  entries.forEach((e, i) => {
    const entry = e as Partial<AnswerKeyEntry> | null;
    if (
      !entry ||
      typeof entry.section !== "string" ||
      typeof entry.questionIndex !== "number" ||
      !Number.isInteger(entry.questionIndex) ||
      typeof entry.answer !== "string"
    ) {
      throw new GenerationError(`Answer key entry ${i} is malformed (expected section, questionIndex, answer)`);
    }
  });
  return {
    entries: (entries as AnswerKeyEntry[]).map((e) => ({ section: e.section, questionIndex: e.questionIndex, answer: e.answer })),
  };
}
