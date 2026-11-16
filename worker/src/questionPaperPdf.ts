import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "./index";
import type { GeneratedPaper, GeneratedQuestion } from "./questionPaperGeneration";
import type { AnswerKey } from "./questionPaperAnswerKey";
import { isServableImageKey } from "./images";
import katex from "katex";

function escapeHtml(text: unknown): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BASE_STYLE =
  "body{font-family:Georgia,serif;padding:32px;} h1{font-size:20px;} h2{font-size:16px;margin-top:24px;} " +
  "ol{padding-left:20px;} li{margin-bottom:12px;white-space:pre-wrap;} " +
  "table{border-collapse:collapse;margin:8px 0;} th,td{border:1px solid #444;padding:4px 8px;font-size:13px;} " +
  "div.qp-formula{margin:6px 0;} " +
  "img.qp-diagram{display:block;max-width:100%;max-height:360px;margin:8px 0;}";

function htmlHead(): string {
  return `<head><meta charset="utf-8"><style>${BASE_STYLE}</style></head>`;
}

// Maths in the PDF is converted here, in the Worker, to MathML, which the
// PDF browser (Chromium) draws natively: no scripts, fonts or downloads are
// needed inside Browser Rendering. (Loading KaTeX from a CDN in the PDF page
// was tried first and never ran there.) Same library version and the same
// $...$ / $$...$$ delimiters as the student app, which renders with KaTeX
// in the browser. A formula KaTeX can't parse is shown as its source text.
const FRACTION_MACROS: Record<string, string> = { "\\frac": "\\dfrac" };

function texToMathml(tex: string, displayMode: boolean): string {
  try {
    // \frac as \dfrac: fractions inside a line of working otherwise render
    // small and cramped. Same macro as the student app's question papers.
    return katex.renderToString(tex, {
      output: "mathml",
      displayMode,
      throwOnError: false,
      strict: "ignore",
      macros: { ...FRACTION_MACROS },
    });
  } catch {
    const d = displayMode ? "$$" : "$";
    return escapeHtml(`${d}${tex}${d}`);
  }
}

// LaTeX commands that start with "\n" - left alone by cleanGeneratedText.
const LATEX_N_COMMANDS = new Set([
  "ne", "neq", "nu", "nabla", "not", "notin", "neg", "newline", "nmid", "ngeq", "ngtr", "nleq", "nless",
  "nexists", "nsubseteq", "nsupseteq", "nparallel", "nleftarrow", "nrightarrow", "natural", "nearrow",
  "nwarrow", "nolimits", "normalsize", "nobreak", "noindent", "nsim", "ncong",
]);

// Character sequences produced when UTF-8 text is decoded as Latin-1/Windows-1252
// somewhere upstream (seen on staging: "1184 mÂ²" for "1184 m²").
const MOJIBAKE: [RegExp, string][] = [
  [/Â(?=[ -¿])/g, ""], // Â² Â° Â½ ... -> ² ° ½
  [/Ã—/g, "×"], // Ã— -> ×
  [/âˆ’/g, "−"], // âˆ’ -> −
  [/â€™/g, "’"], // â€™ -> ’
  [/â€œ/g, "“"], // â€œ -> “
  [/â€\u009D/g, "”"], // â€ + 0x9D -> ”
  [/â€“/g, "–"], // â€“ -> –
  [/â€”/g, "—"], // â€” -> —
];

/**
 * Repairs generated text before display. Answer keys come back with line
 * breaks written as the two characters "\" "n" (169 in one prod Maths answer
 * key, zero real breaks), so the working ran together on one line and KaTeX
 * showed red "\n" errors. A "\n" becomes a real line break unless it starts a
 * LaTeX command such as \neq or \nu. Also repairs common mojibake. Applied at
 * display time so papers and answers already saved are fixed too. Mirrored in
 * frontend/app.js.
 */
export function cleanGeneratedText(raw: unknown): string {
  let s = String(raw ?? "");
  s = s.replace(/\\n([A-Za-z]*)/g, (match, letters: string) =>
    LATEX_N_COMMANDS.has(`n${letters}`) ? match : `\n${letters}`
  );
  for (const [pattern, replacement] of MOJIBAKE) s = s.replace(pattern, replacement);
  s = closeInlineMathPerLine(s);
  return replaceBareLatexOutsideMath(s);
}

// The model sometimes opens inline maths and never closes it before a line
// break (seen: "... = 1 - 2\sin\theta + \sin^2\theta.\nRectification ..."),
// so the renderer swallows the following text into maths. Inline $...$ never
// legitimately spans lines, so a line with an odd number of single "$" gets
// one closed at its end - but only when the unclosed part looks like maths
// (a \command, ^, _ or =), so a lone "$" used as money is left as text.
// Lines that open or close a multi-line $$...$$ block are left alone.
function closeInlineMathPerLine(s: string): string {
  return s
    .split("\n")
    .map((line) => {
      const displayDelims = (line.match(/\$\$/g) || []).length;
      if (displayDelims % 2 === 1) return line;
      const singles = line.replace(/\$\$/g, "  ");
      if (((singles.match(/\$/g) || []).length) % 2 === 0) return line;
      const unclosed = singles.slice(singles.lastIndexOf("$") + 1);
      return /\\[A-Za-z]|[\^_=]/.test(unclosed) ? `${line}$` : line;
    })
    .join("\n");
}

// Common LaTeX commands the model sometimes writes outside $...$ (seen:
// "34 m \times 24 m", "\alpha"). Outside maths they would show as raw text,
// so they become the plain symbol. Only these exact command names; anything
// else (e.g. \sqrt{2}, \circ) is left as it is.
const BARE_LATEX_SYMBOLS: Record<string, string> = {
  times: "×", div: "÷", pm: "±", cdot: "·", alpha: "α", beta: "β", gamma: "γ",
  delta: "δ", Delta: "Δ", theta: "θ", lambda: "λ", mu: "μ", pi: "π", rho: "ρ",
  sigma: "σ", omega: "ω", Omega: "Ω", phi: "φ", le: "≤", leq: "≤", ge: "≥",
  geq: "≥", ne: "≠", neq: "≠", approx: "≈", infty: "∞", degree: "°",
  rightarrow: "→", to: "→", Rightarrow: "⇒", therefore: "∴", because: "∵",
  angle: "∠", triangle: "△", parallel: "∥", perp: "⊥",
};
const MATH_SEGMENT = /(\$\$[\s\S]+?\$\$|\$[^$]+?\$)/;

function replaceBareLatexOutsideMath(s: string): string {
  return s
    .split(MATH_SEGMENT)
    .map((part, i) =>
      i % 2 === 1
        ? part // a $...$ or $$...$$ segment: left for the maths renderer
        : part.replace(/\\([A-Za-z]+)(?![A-Za-z])/g, (match, name: string) => BARE_LATEX_SYMBOLS[name] ?? match)
    )
    .join("");
}

/** HTML-escapes text and turns $...$ (inline) and $$...$$ (display) into MathML. */
export function renderMathText(raw: unknown): string {
  const s = cleanGeneratedText(raw);
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "$") {
      const delim = s.startsWith("$$", i) ? "$$" : "$";
      const end = s.indexOf(delim, i + delim.length);
      const tex = end === -1 ? "" : s.slice(i + delim.length, end);
      if (end !== -1 && tex.trim() !== "") {
        out += texToMathml(tex, delim === "$$");
        i = end + delim.length;
        continue;
      }
      // An unmatched or empty $ is ordinary text (e.g. a price).
      out += escapeHtml(s[i]);
      i += 1;
      continue;
    }
    const next = s.indexOf("$", i);
    const stop = next === -1 ? s.length : next;
    out += escapeHtml(s.slice(i, stop));
    i = stop;
  }
  return out;
}

/**
 * The generator often repeats a formula that is already in the question text
 * in the optional "latex" field. Shown again it is just a duplicate (and was
 * printed as raw code), so it is dropped when its letters and digits already
 * appear, in order, in the question text. Mirrored in frontend/app.js.
 */
export function isFormulaInText(text: string, latex: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const formula = norm(latex);
  if (formula.length === 0 || norm(text).includes(formula)) return true;
  // Also compare without LaTeX command names, so "50 \text{ m} \times 40 \text{ m}"
  // matches "50 m × 40 m" in the text. Only for formulas with enough content
  // left (5+ letters/digits), so a short one can't match by accident.
  const noCommands = (s: string) => norm(s.replace(/\\[A-Za-z]+/g, " "));
  const bare = noCommands(latex);
  return bare.length >= 5 && noCommands(text).includes(bare);
}

function renderFormula(q: GeneratedQuestion): string {
  if (!q.latex || isFormulaInText(q.text ?? "", q.latex)) return "";
  return `<div class="qp-formula">${texToMathml(q.latex, true)}</div>`;
}

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function questionImageKey(q: GeneratedQuestion): string | undefined {
  return q.pageImageKey || q.generatedImageKey;
}

/**
 * Fetches every question's diagram from R2 and returns key -> data: URL, so
 * the rendered PDF is self-contained (no HTTP fetch from inside Browser
 * Rendering, no CORS/auth concerns). Fails open per image: a missing or
 * unreadable image is simply omitted from the PDF.
 */
async function loadImageDataUrls(env: Env, paper: GeneratedPaper): Promise<Map<string, string>> {
  const keys = [
    ...new Set(
      paper.sections
        .flatMap((s) => s.questions)
        .map(questionImageKey)
        .filter((k): k is string => !!k && isServableImageKey(k))
    ),
  ];
  const entries = await Promise.all(
    keys.map(async (key): Promise<[string, string] | null> => {
      try {
        const object = await env.PDF_BUCKET.get(key);
        if (!object) return null;
        return [key, `data:image/png;base64,${bytesToBase64(await object.arrayBuffer())}`];
      } catch (err) {
        console.error("question paper PDF: failed to load image, omitting it", key, err);
        return null;
      }
    })
  );
  return new Map(entries.filter((e): e is [string, string] => e !== null));
}

function renderTable(table: GeneratedQuestion["table"]): string {
  if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) return "";
  const head = `<tr>${table.headers.map((h) => `<th>${renderMathText(h)}</th>`).join("")}</tr>`;
  const body = table.rows
    .map((row) => `<tr>${(Array.isArray(row) ? row : []).map((c) => `<td>${renderMathText(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function renderQuestionBody(q: GeneratedQuestion, images: Map<string, string>): string {
  const marks = `<em>[${escapeHtml(q.marks)} mark${q.marks === 1 ? "" : "s"}]</em>`;
  const key = questionImageKey(q);
  const dataUrl = key ? images.get(key) : undefined;
  const image = dataUrl ? `<img class="qp-diagram" src="${dataUrl}" alt="diagram" />` : "";
  return `${renderMathText(q.text)} ${marks}${renderFormula(q)}${renderTable(q.table)}${image}`;
}

export async function renderPaperHtml(paper: GeneratedPaper, env: Env): Promise<string> {
  const images = await loadImageDataUrls(env, paper);
  const sections = paper.sections
    .map(
      (s) =>
        `<h2>Section ${escapeHtml(s.section)}</h2><ol>${s.questions
          .map((q) => `<li>${renderQuestionBody(q, images)}</li>`)
          .join("")}</ol>`
    )
    .join("");

  return `<html>${htmlHead()}<body>` +
    `<h1>${escapeHtml(paper.subject)} (${escapeHtml(paper.marksTotal)} Marks)</h1>` +
    sections +
    `</body></html>`;
}

export async function renderAnswerKeyHtml(paper: GeneratedPaper, key: AnswerKey, env: Env): Promise<string> {
  const images = await loadImageDataUrls(env, paper);
  const answerByQuestion = new Map(key.entries.map((e) => [`${e.section}:${e.questionIndex}`, e.answer]));
  const sections = paper.sections
    .map(
      (s) =>
        `<h2>Section ${escapeHtml(s.section)}</h2><ol>${s.questions
          .map((q, i) => {
            const answer = answerByQuestion.get(`${s.section}:${i}`) ?? "";
            return `<li>${renderQuestionBody(q, images)}<br/><strong>Answer:</strong> ${renderMathText(answer)}</li>`;
          })
          .join("")}</ol>`
    )
    .join("");

  return `<html>${htmlHead()}<body>` +
    `<h1>${escapeHtml(paper.subject)} Answers (${escapeHtml(paper.marksTotal)} Marks)</h1>` +
    sections +
    `</body></html>`;
}

/**
 * Fails open: returns null (never throws) on any Browser Rendering error -
 * PDF generation must never block showing the paper itself, per the PDF
 * stage's fail-open contract.
 */
export async function renderHtmlToPdf(env: Env, html: string): Promise<ArrayBuffer | null> {
  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    // Self-contained HTML (maths already MathML, images as data: URLs), so
    // nothing has to load from the network.
    await page.setContent(html);
    const pdf = await page.pdf();
    return pdf as unknown as ArrayBuffer;
  } catch (err) {
    console.error("question paper PDF rendering failed", err);
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}
