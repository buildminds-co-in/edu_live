import type { Env } from "./index";
import type { PageText } from "./types";

// PDF-capable OpenRouter model - separate from the chat llmModelSlug since
// document understanding and chat generation have different model
// requirements (native PDF/vision input is not universal across models).
export const DEFAULT_INGESTION_MODEL = "google/gemini-2.5-flash";

const PAGE_MARKER = /<<<PAGE (\d+)>>>/g;

// The ingestion model occasionally degenerates mid-reply and repeats one
// character, space or line until it runs out of output tokens. Seen on a
// 7-page question paper (about 2 in 5 runs): a table alignment row grew into
// a single 47,948-character ":-----..." token, and on another run a table
// header row was padded with hundreds of kilobytes of spaces. The first kind
// produced a 46 KB chunk, which Vectorize rejected (metadata is capped at
// 10,240 bytes), failing the whole upload. The guards below keep enrichment
// fail-open per page instead.

// 4+ of the same filler character (table rules, blanks, dot leaders,
// separators) collapse to 3. Markdown tables stay valid ("|---|" is enough)
// and blanks still read as blanks.
const REPEATED_CHAR_RUN = /([-_=.*~])\1{3,}/g;
// The same, for backslash-escaped Markdown blanks such as "\_\_\_\_".
const REPEATED_ESCAPED_RUN = /(\\[-_*])\1{3,}/g;
// 20+ spaces or tabs in a row are padding (normal indentation is far shorter).
const PADDING_RUN = /[ \t]{20,}/g;
// A non-blank line repeated back to back (blank lines in between ignored) is
// kept at most this many times in a row.
const MAX_REPEATED_LINE = 2;

export function collapseRepeatedRuns(text: string): string {
  const collapsed = text
    .replace(REPEATED_CHAR_RUN, "$1$1$1")
    .replace(REPEATED_ESCAPED_RUN, "$1$1$1")
    .replace(PADDING_RUN, " ");
  const out: string[] = [];
  let previous = "";
  let repeats = 0;
  for (const line of collapsed.split("\n")) {
    const key = line.trim();
    if (key !== "") {
      repeats = key === previous ? repeats + 1 : 1;
      previous = key;
      if (repeats > MAX_REPEATED_LINE) continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// Measured on real enriched notes, question papers and answer keys: the
// largest page was 4,316 characters and the highest growth over plain text
// was 3.05x (a small figure page). Runaway pages were 48,000+ characters. A
// page that is both over 6,000 characters and over 4x its plain text is a
// runaway reply, not richer content, so that page falls back to plain text.
// Sizes are compared with whitespace runs collapsed: padding spaces never
// reach a chunk (the chunker splits on whitespace), so they don't count.
export const RUNAWAY_PAGE_MIN_CHARS = 6000;
export const RUNAWAY_PAGE_GROWTH = 4;

const compactLength = (text: string): number => text.replace(/\s+/g, " ").trim().length;

export function isRunawayPage(enrichedText: string, plainText: string): boolean {
  const enriched = compactLength(enrichedText);
  return enriched > RUNAWAY_PAGE_MIN_CHARS && enriched > RUNAWAY_PAGE_GROWTH * compactLength(plainText);
}

// Bounds a looping reply in time and cost: normal replies use about 700-800
// output tokens per page, so 1,500 per page (minimum 8,000) leaves headroom
// while stopping a loop after seconds instead of minutes. A reply that hits
// the limit is treated as truncated (its last page is dropped).
export function enrichmentMaxTokens(pageCount: number): number {
  return Math.min(60000, Math.max(8000, 1500 * pageCount));
}

function base64FromArrayBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function buildPrompt(): string {
  return (
    "You will be given a PDF document. For EVERY page in the document, output its content as " +
    "Markdown, preserving meaning precisely:\n" +
    "- Mathematical formulas and equations (algebra, calculus, physics equations - real typeset math): " +
    "write as LaTeX, delimited with $...$ (inline) or $$...$$ (block).\n" +
    "- Chemical structural or skeletal formulas, molecular structure drawings, and reaction mechanism " +
    "diagrams (bond-line drawings, displayed/skeletal formulas with atoms and bonds drawn as a shape) are " +
    "NOT math and must NOT be transcribed as text or LaTeX - describe them like any other figure, prefixed " +
    "with '[Figure: ' (e.g. '[Figure: skeletal structural formula of 1-chloropropane, a three-carbon chain " +
    "with a chlorine on the end carbon]'). Only a plain inline notation the source text itself writes as " +
    "running text (e.g. 'CH3COOH' typed in a sentence) should be reproduced verbatim as text.\n" +
    "- Tables: reproduce as Markdown tables (with header row and alignment row). If a table cell contains a " +
    "diagram, structural formula, or image rather than plain text, that cell's content is still '[Figure: " +
    "...]' using the same rule as any other figure - never attempt to draw or transcribe it as table text.\n" +
    "- Keep tables compact: never pad cells or columns with extra spaces to line them up, write every " +
    "alignment-row cell as exactly --- (or :--- / :---:), and keep each row on one line.\n" +
    "- Write a fill-in blank or answer line as ___ (three underscores), however long it is printed.\n" +
    "- Never repeat a character, word, or line to fill space; if you notice you are repeating yourself, move on " +
    "to the next part of the page.\n" +
    "- Images, diagrams, charts, or figures: describe their content in enough detail to answer a " +
    "question about them, prefixed with '[Figure: '.\n" +
    "- All other text: reproduce as close to verbatim as possible.\n\n" +
    "Separate each page's output with a line containing exactly <<<PAGE n>>> where n is the 1-indexed " +
    "page number, immediately before that page's content. Do not add any other commentary, headers, or " +
    "summary text outside of what the page itself contains."
  );
}

/**
 * Parses the model's <<<PAGE n>>>-delimited response into PageText[]. Pure
 * function (no I/O) so parsing edge cases can be tested without mocking
 * fetch. Any page number from fallbackPages with no matching marker in the
 * response - or any marker whose page number isn't in fallbackPages at all -
 * falls back to that page's plain-text content, so a partially-broken
 * response never loses a page outright. Repeated filler runs are collapsed,
 * and any page that still looks like a runaway reply falls back too.
 * Returns the fallbackPages reference itself when no page was taken from
 * the response, so callers can tell enrichment did not apply.
 */
export function parseEnrichedPages(responseText: string, fallbackPages: PageText[], truncated = false): PageText[] {
  const fallbackPageNumbers = new Set(fallbackPages.map((p) => p.page));
  const fallbackText = new Map(fallbackPages.map((p) => [p.page, p.text]));
  const parsed = new Map<number, string>();

  const matches = [...responseText.matchAll(PAGE_MARKER)];
  for (let i = 0; i < matches.length; i++) {
    // A truncated response was cut off mid-output-limit - its last page is
    // likely incomplete, so drop it and let that page fall back to its
    // plain-text content rather than index a half-written fragment.
    if (truncated && i === matches.length - 1) continue;
    const pageNum = Number(matches[i][1]);
    if (!fallbackPageNumbers.has(pageNum)) continue; // discard out-of-range markers
    const contentStart = matches[i].index! + matches[i][0].length;
    const contentEnd = i + 1 < matches.length ? matches[i + 1].index! : responseText.length;
    const text = collapseRepeatedRuns(responseText.slice(contentStart, contentEnd).trim());
    if (isRunawayPage(text, fallbackText.get(pageNum) ?? "")) {
      console.error(`ingestion enrichment page ${pageNum} looks like a runaway reply (${text.length} chars), using its plain text`);
      parsed.delete(pageNum);
      continue;
    }
    parsed.set(pageNum, text);
  }

  if (parsed.size === 0) return fallbackPages;

  return fallbackPages.map((fallback) => ({
    page: fallback.page,
    text: parsed.get(fallback.page) ?? fallback.text,
  }));
}

// A whole-PDF vision call normally takes about 20-25 s. The first attempt may
// take up to 180 s (60 s was cutting multi-page papers off in prod). A retry
// is only made after a quick first attempt, and gets a shorter limit, so the
// worst case stays close to the single-attempt 180 s.
const FIRST_ATTEMPT_TIMEOUT_MS = 180_000;
const RETRY_ONLY_IF_FIRST_UNDER_MS = 60_000;
const RETRY_TIMEOUT_MS = 120_000;

/** Number of pages whose text came from the model rather than the plain-text fallback. */
export function countEnrichedPages(pages: PageText[], fallbackPages: PageText[]): number {
  if (pages === fallbackPages) return 0;
  return pages.filter((p, i) => p.text !== fallbackPages[i]?.text).length;
}

/**
 * Sends the whole PDF to a PDF-capable OpenRouter model and returns
 * per-page enriched Markdown. Never throws: any failure (network error,
 * non-OK response, unparseable output) returns fallbackPages unchanged, so
 * ingestion always has text to chunk even when enrichment doesn't work.
 * If fewer than half the pages came back usable (the model looped or
 * stopped early) and the first attempt was quick, it retries once and keeps
 * whichever attempt enriched more pages.
 */
export async function enrichPdfToMarkdown(
  pdfBytes: ArrayBuffer,
  fallbackPages: PageText[],
  env: Env,
  config: { ingestionModelSlug: string }
): Promise<PageText[]> {
  const started = Date.now();
  const first = await enrichOnce(pdfBytes, fallbackPages, env, config, FIRST_ATTEMPT_TIMEOUT_MS);
  const firstCount = countEnrichedPages(first, fallbackPages);
  if (firstCount * 2 >= fallbackPages.length || Date.now() - started > RETRY_ONLY_IF_FIRST_UNDER_MS) {
    return first;
  }
  console.error(`ingestion enrichment covered ${firstCount}/${fallbackPages.length} pages, retrying once`);
  const second = await enrichOnce(pdfBytes, fallbackPages, env, config, RETRY_TIMEOUT_MS);
  return countEnrichedPages(second, fallbackPages) > firstCount ? second : first;
}

async function enrichOnce(
  pdfBytes: ArrayBuffer,
  fallbackPages: PageText[],
  env: Env,
  config: { ingestionModelSlug: string },
  timeoutMs: number
): Promise<PageText[]> {
  try {
    const base64Pdf = base64FromArrayBuffer(pdfBytes);
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.ingestionModelSlug,
        max_tokens: enrichmentMaxTokens(fallbackPages.length),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: buildPrompt() },
              { type: "file", file: { filename: "document.pdf", file_data: `data:application/pdf;base64,${base64Pdf}` } },
            ],
          },
        ],
      }),
      // A hung upstream call would otherwise hold the synchronous /ingest
      // request open indefinitely.
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      console.error(`ingestion enrichment failed (${response.status}), falling back to plain text`);
      return fallbackPages;
    }

    const body = (await response.json()) as { choices: { message: { content: string }; finish_reason?: string }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      console.error("ingestion enrichment returned no content, falling back to plain text");
      return fallbackPages;
    }

    const truncated = body.choices?.[0]?.finish_reason === "length";
    if (truncated) {
      console.error("ingestion enrichment response was truncated (finish_reason: length), dropping its last page");
    }
    return parseEnrichedPages(content, fallbackPages, truncated);
  } catch (err) {
    console.error("ingestion enrichment call failed, falling back to plain text", err);
    return fallbackPages;
  }
}
