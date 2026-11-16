import type { Env } from "./index";
import { getRuntimeConfig } from "./config";
import { isAdminAuthorized } from "./admin";
import { getBlueprint, distributeSlotsAcrossChapters } from "./questionPaperBlueprints";
import { fetchAllChapterChunks } from "./questionPaperRetrieval";
import { generatePaper, GenerationError, QUESTION_PAPER_PROMPT_VERSION } from "./questionPaperGeneration";
import { generateAnswerKey } from "./questionPaperAnswerKey";
import { renderPaperHtml, renderAnswerKeyHtml, renderHtmlToPdf } from "./questionPaperPdf";
import { computeCacheKey, findCachedPaper, saveNewPaper, findPaperById, saveAnswerKey, savePdfKey } from "./questionPaperCache";

// GenerationError's own .message is a technical detail for the server log
// (e.g. "LLM returned invalid JSON: Bad escaped character at position 412")
// - useful for debugging, meaningless and alarming to a student. Every
// GenerationError site means the same thing to a user: the model's response
// for this paper couldn't be used. Log the real message, show one friendly,
// actionable one instead of leaking it into the response.
function errorResponse(routeName: string, err: unknown, status = 500): Response {
  console.error(`${routeName} failed`, err);
  const message =
    err instanceof GenerationError
      ? "We couldn't generate this question paper - the AI model's response came back incomplete or malformed. This is usually temporary: please try again, or try a smaller Total Marks value."
      : "Something went wrong - please try again.";
  return Response.json({ error: message }, { status });
}

/**
 * True for a file named like an answer key: "..._WithAnswers.pdf",
 * "...WithAnswers.pdf", "Answer Key", "Marking Scheme", "Answers", "Solutions".
 */
export function isAnswerKeyFilename(filename: string): boolean {
  return /with[\s_-]*answers?|answer[\s_-]*key|marking[\s_-]*scheme|(^|[^a-z])(answers|solutions)([^a-z]|$)/i.test(filename);
}

export async function handleQuestionPaperCatalog(env: Env): Promise<Response> {
  try {
    const listed = await env.PDF_BUCKET.list({ include: ["customMetadata"] });
    const documents = listed.objects
      .filter((obj) => !obj.key.startsWith("page-images/") && !obj.key.startsWith("cleaned/") && !obj.key.startsWith("question-papers/"))
      .filter((obj) => obj.customMetadata?.subject)
      .map((obj) => ({
        filename: obj.key,
        subject: obj.customMetadata!.subject!,
        chapter: obj.customMetadata!.chapter ?? "",
      }));
    return Response.json({ documents });
  } catch (err) {
    return errorResponse("/question-paper/catalog", err);
  }
}

const MIN_MARKS_TOTAL = 1;
const MAX_MARKS_TOTAL = 500;

interface GenerateRequestBody {
  subject: string;
  chapterFilenames: string[];
  marksTotal: number;
  modelOverride?: string;
}

export async function handleQuestionPaperGenerate(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as GenerateRequestBody | null;
    if (
      !body ||
      typeof body.subject !== "string" ||
      !body.subject ||
      !Array.isArray(body.chapterFilenames) ||
      body.chapterFilenames.length === 0 ||
      body.marksTotal === undefined ||
      body.marksTotal === null
    ) {
      return Response.json({ error: "Expected subject, chapterFilenames[], and marksTotal" }, { status: 400 });
    }
    // Public route: bound marksTotal before it reaches getBlueprint's scaling
    // so absurd/negative/fractional values can't buy a doomed-but-paid LLM call.
    if (
      typeof body.marksTotal !== "number" ||
      !Number.isInteger(body.marksTotal) ||
      body.marksTotal < MIN_MARKS_TOTAL ||
      body.marksTotal > MAX_MARKS_TOTAL
    ) {
      return Response.json(
        { error: `marksTotal must be a whole number between ${MIN_MARKS_TOTAL} and ${MAX_MARKS_TOTAL}` },
        { status: 400 }
      );
    }
    const blueprint = getBlueprint(body.subject, body.marksTotal);
    if (!blueprint) {
      return Response.json({ error: `No question paper template is available yet for ${body.subject}` }, { status: 400 });
    }

    // modelOverride exists for the manual eval harness (worker/evals/) to test
    // a candidate model without touching the live config real traffic uses -
    // gated behind the same admin key as /admin/*. The cache key folds the
    // override in (rather than bypassing the cache entirely) so an eval rerun
    // against the same model reuses its own result instead of re-paying for
    // generation, while never colliding with or overwriting the real
    // production cache entry for this subject/chapters/marks combination.
    const modelOverride =
      typeof body.modelOverride === "string" && body.modelOverride.trim() && isAdminAuthorized(request, env)
        ? body.modelOverride.trim()
        : null;
    const cacheKeySubject = modelOverride ? `${body.subject}::eval::${modelOverride}` : body.subject;
    // The prompt version is part of the key so a prompt change regenerates
    // papers instead of serving ones cached under the old prompts.
    const cacheKey = computeCacheKey(
      cacheKeySubject,
      body.marksTotal,
      body.chapterFilenames,
      `${blueprint.version}|${QUESTION_PAPER_PROMPT_VERSION}`
    );
    const cached = await findCachedPaper(env, cacheKey);
    if (cached) {
      return Response.json({ id: cached.id, paper: cached.paperJson, cached: true });
    }

    const { found, missing } = await fetchAllChapterChunks(env, body.chapterFilenames);
    if (missing.length > 0) {
      return Response.json({ error: `These chapters aren't available: ${missing.join(", ")}` }, { status: 400 });
    }

    // An answer key gives answers, not questions. When it's selected with a
    // question paper or notes, its text still goes into the prompt (as the
    // source of answers) but it gets no slots - slots assigned to it were
    // left unfilled and papers came back short (measured: 32 of 38 questions,
    // 56 of 80 marks, the whole of section C missing).
    const slotSources = found.some((c) => !isAnswerKeyFilename(c.filename))
      ? found.filter((c) => !isAnswerKeyFilename(c.filename))
      : found;
    const chapterChunkCounts = Object.fromEntries(slotSources.map((c) => [c.filename, c.chunkCount]));
    const slotsByChapter = distributeSlotsAcrossChapters(blueprint, chapterChunkCounts);
    const chaptersWithSlots = found.map((chunks) => ({ chunks, slots: slotsByChapter[chunks.filename] ?? [] }));

    const config = await getRuntimeConfig(env);
    const id = crypto.randomUUID();
    const generated = await generatePaper(env, blueprint, chaptersWithSlots, id, {
      llmProvider: config.llmProvider,
      questionPaperModelSlug: modelOverride ?? config.questionPaperModelSlug,
      questionPaperImageGenEnabled: config.questionPaperImageGenEnabled,
    });

    const row = await saveNewPaper(env, {
      id,
      cacheKey,
      subject: body.subject,
      marksTotal: body.marksTotal,
      chapterFilenames: body.chapterFilenames,
      blueprintVersion: blueprint.version,
      paperJson: generated,
      answerKeyJson: null,
      pdfR2Key: null,
      answerKeyPdfR2Key: null,
    });

    // If a concurrent request for the same cache_key won the insert,
    // saveNewPaper returns that row - return its paper so both callers see
    // the same, persisted paper (and the same id for answer-key/PDF calls).
    if (row.id !== id) {
      return Response.json({ id: row.id, paper: row.paperJson, cached: true });
    }
    return Response.json({ id: row.id, paper: generated, cached: false });
  } catch (err) {
    return errorResponse("/question-paper/generate", err);
  }
}

export async function handleQuestionPaperAnswerKey(request: Request, env: Env, paperId: string): Promise<Response> {
  try {
    const row = await findPaperById(env, paperId);
    if (!row) return Response.json({ error: "Question paper not found" }, { status: 404 });

    if (row.answerKeyJson) {
      return Response.json({ answerKey: row.answerKeyJson, cached: true });
    }

    const config = await getRuntimeConfig(env);
    const answerKey = await generateAnswerKey(env, row.paperJson as any, {
      llmProvider: config.llmProvider,
      questionPaperModelSlug: config.questionPaperModelSlug,
    });
    await saveAnswerKey(env, paperId, answerKey);

    return Response.json({ answerKey, cached: false });
  } catch (err) {
    return errorResponse("/question-paper/:id/answer-key", err);
  }
}

// Bump when the PDF rendering changes. r4 (v1.1.4): maths as MathML,
// duplicate formula box removed, answer text cleaned (real line breaks,
// mojibake). PDFs stored under an older name are not served again; they are
// re-rendered on the next download.
const PDF_RENDER_VERSION = "r4";
export const paperPdfKey = (paperId: string) => `question-papers/${paperId}-${PDF_RENDER_VERSION}.pdf`;
export const answerKeyPdfKey = (paperId: string) => `question-papers/${paperId}-key-${PDF_RENDER_VERSION}.pdf`;

export async function handleQuestionPaperPdf(env: Env, paperId: string): Promise<Response> {
  try {
    const row = await findPaperById(env, paperId);
    if (!row) return Response.json({ error: "Question paper not found" }, { status: 404 });

    if (row.pdfR2Key && row.pdfR2Key === paperPdfKey(paperId)) {
      const object = await env.PDF_BUCKET.get(row.pdfR2Key);
      if (object) return new Response(object.body, { headers: { "content-type": "application/pdf" } });
    }

    const html = await renderPaperHtml(row.paperJson as any, env);
    const pdf = await renderHtmlToPdf(env, html);
    if (!pdf) return Response.json({ error: "PDF generation failed, paper still available in-chat" }, { status: 500 });

    const key = paperPdfKey(paperId);
    await env.PDF_BUCKET.put(key, pdf, { httpMetadata: { contentType: "application/pdf" } });
    await savePdfKey(env, paperId, "pdfR2Key", key);

    return new Response(pdf, { headers: { "content-type": "application/pdf" } });
  } catch (err) {
    return errorResponse("/question-paper/:id/pdf", err);
  }
}

export async function handleQuestionPaperAnswerKeyPdf(env: Env, paperId: string): Promise<Response> {
  try {
    const row = await findPaperById(env, paperId);
    if (!row) return Response.json({ error: "Question paper not found" }, { status: 404 });
    if (!row.answerKeyJson) {
      return Response.json({ error: "Generate the answer key before requesting its PDF" }, { status: 400 });
    }

    if (row.answerKeyPdfR2Key && row.answerKeyPdfR2Key === answerKeyPdfKey(paperId)) {
      const object = await env.PDF_BUCKET.get(row.answerKeyPdfR2Key);
      if (object) return new Response(object.body, { headers: { "content-type": "application/pdf" } });
    }

    const html = await renderAnswerKeyHtml(row.paperJson as any, row.answerKeyJson as any, env);
    const pdf = await renderHtmlToPdf(env, html);
    if (!pdf) return Response.json({ error: "PDF generation failed, answer key still available in-chat" }, { status: 500 });

    const key = answerKeyPdfKey(paperId);
    await env.PDF_BUCKET.put(key, pdf, { httpMetadata: { contentType: "application/pdf" } });
    await savePdfKey(env, paperId, "answerKeyPdfR2Key", key);

    return new Response(pdf, { headers: { "content-type": "application/pdf" } });
  } catch (err) {
    return errorResponse("/question-paper/:id/answer-key-pdf", err);
  }
}
