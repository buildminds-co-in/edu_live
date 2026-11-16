import { describe, it, expect, vi } from "vitest";
import {
  renderPaperHtml,
  renderAnswerKeyHtml,
  renderHtmlToPdf,
  isFormulaInText,
  renderMathText,
  cleanGeneratedText,
} from "../src/questionPaperPdf";
import type { GeneratedPaper } from "../src/questionPaperGeneration";
import type { AnswerKey } from "../src/questionPaperAnswerKey";
import type { Env } from "../src/index";

const paper: GeneratedPaper = {
  subject: "Science",
  marksTotal: 40,
  blueprintVersion: "science-40-v1",
  sections: [{ section: "A", questions: [{ section: "A", questionType: "mcq", marks: 1, text: "What is catenation?" }] }],
};

function envWithImages(images: Record<string, Uint8Array>): Env {
  return {
    PDF_BUCKET: {
      get: vi.fn(async (key: string) =>
        images[key] ? ({ arrayBuffer: async () => images[key].buffer } as unknown as R2ObjectBody) : null
      ),
    },
  } as unknown as Env;
}

const richPaper: GeneratedPaper = {
  subject: "Science",
  marksTotal: 40,
  blueprintVersion: "science-40-v1",
  sections: [
    {
      section: "B",
      questions: [
        {
          section: "B",
          questionType: "short_answer",
          marks: 3,
          text: "Use <b>Ohm's</b> law & the table",
          latex: "V = IR < 5",
          table: { headers: ["V", "I<x>"], rows: [["2", "0.5"]] },
          generatedImageKey: "question-papers/p1/gen-B-1.png",
          imageSource: "generated",
        },
        {
          section: "B",
          questionType: "short_answer",
          marks: 3,
          text: "Label the figure",
          pageImageKey: "page-images/ch.pdf/2.png",
          imageSource: "ingested",
        },
        {
          section: "B",
          questionType: "short_answer",
          marks: 3,
          text: "Missing image question",
          pageImageKey: "page-images/ch.pdf/missing.png",
          imageSource: "ingested",
        },
      ],
    },
  ],
};

describe("renderPaperHtml", () => {
  it("includes the subject, marks total, section heading, and question text", async () => {
    const html = await renderPaperHtml(paper, envWithImages({}));
    expect(html).toContain("Science");
    expect(html).toContain("40");
    expect(html).toContain("Section A");
    expect(html).toContain("What is catenation?");
  });

  it("renders tables, LaTeX blocks, and embeds images as base64 data URLs fetched from R2", async () => {
    const env = envWithImages({
      "question-papers/p1/gen-B-1.png": new Uint8Array([1, 2, 3]),
      "page-images/ch.pdf/2.png": new Uint8Array([4, 5, 6]),
    });
    const html = await renderPaperHtml(richPaper, env);

    expect(html).toContain("<table>");
    expect(html).toContain("<th>I&lt;x&gt;</th>");
    expect(html).toContain("<td>0.5</td>");
    // Not in the question text, so shown once, as display maths (MathML).
    expect(html).toContain('<div class="qp-formula"><span class="katex"><math');
    expect(html).toContain('display="block"');
    expect(html).not.toContain("qp-latex");
    expect(html).not.toContain("$$");
    expect(html).toContain(`src="data:image/png;base64,${btoa(String.fromCharCode(1, 2, 3))}"`);
    expect(html).toContain(`src="data:image/png;base64,${btoa(String.fromCharCode(4, 5, 6))}"`);
    // A missing R2 object just omits that image (fails open).
    expect(html.match(/<img /g)).toHaveLength(2);
  });

  it("escapes interpolated question text", async () => {
    const html = await renderPaperHtml(richPaper, envWithImages({}));
    expect(html).toContain("Use &lt;b&gt;Ohm&#39;s&lt;/b&gt; law &amp; the table");
    expect(html).not.toContain("<b>Ohm");
  });
});

describe("maths in the PDF (v1.1.4)", () => {
  it("drops a formula the question text already contains (the prod cases: 2^3 x 3^a ... and tan theta)", () => {
    expect(
      isFormulaInText(
        "If the prime factorisation of 2520 is $2^3 \\times 3^a \\times b \\times 7$, then the value of $a + 2b$ is:",
        "2^3 \\times 3^a \\times b \\times 7"
      )
    ).toBe(true);
    expect(isFormulaInText("In the given figure, AD = DB, AC = b and AB = a, then tan $\\theta$ is equal to", "\\tan \\theta")).toBe(true);
    expect(isFormulaInText("Use Ohm's law", "V = IR")).toBe(false);
    expect(isFormulaInText("anything", "  ")).toBe(true);
  });

  it("does not print a duplicate formula box", async () => {
    const dup: GeneratedPaper = {
      ...paper,
      sections: [
        {
          section: "A",
          questions: [
            { section: "A", questionType: "mcq", marks: 1, text: "The zeroes of $p(x) = x^2 - x - 6$ are", latex: "p(x) = x^2 - x - 6" },
          ],
        },
      ],
    };
    const html = await renderPaperHtml(dup, envWithImages({}));
    expect(html).not.toContain('<div class="qp-formula">');
    expect(html.match(/x\^2 - x - 6/g)).toHaveLength(1);
  });

  it("turns $...$ in questions, tables and answers into MathML, with nothing loaded from the network", async () => {
    const mathPaper: GeneratedPaper = {
      ...paper,
      sections: [
        {
          section: "A",
          questions: [
            {
              section: "A",
              questionType: "short_answer",
              marks: 2,
              text: "Find $\\frac{1}{2} + \\sqrt{3}$ when x < 5",
              table: { headers: ["$x_i$"], rows: [["$f_i$"]] },
            },
          ],
        },
      ],
    };
    const key: AnswerKey = { entries: [{ section: "A", questionIndex: 0, answer: "It is $\\frac{1}{2}$ & more" }] };
    for (const html of [
      await renderPaperHtml(mathPaper, envWithImages({})),
      await renderAnswerKeyHtml(mathPaper, key, envWithImages({})),
    ]) {
      expect(html).toContain("<mfrac>");
      expect(html).toContain("<msqrt>");
      expect(html).toContain("<msub>");
      expect(html).toContain("when x &lt; 5");
      // No scripts, stylesheets or remote sources (MathML's xmlns is a label, not a fetch).
      expect(html).not.toMatch(/<script|<link|src="https?:/);
      expect(html).toContain('<meta charset="utf-8">');
    }
    expect(await renderAnswerKeyHtml(mathPaper, key, envWithImages({}))).toContain(" &amp; more");
  });

  it("leaves unmatched or empty dollar signs as text, escapes HTML, and renders $$...$$ as display maths", () => {
    expect(renderMathText("costs $5 <b>")).toBe("costs $5 &lt;b&gt;");
    expect(renderMathText("empty $$ here")).toBe("empty $$ here");
    expect(renderMathText("$$a^2$$")).toContain('display="block"');
    expect(renderMathText("$a^2$")).not.toContain('display="block"');
    expect(renderMathText(undefined)).toBe("");
  });

  it("turns backslash-n into real line breaks but keeps LaTeX commands starting with \\n (prod Maths 60 answer)", () => {
    const BS = "\\";
    const prodLike =
      `The correct expansion is $1 - 2${BS}sin ${BS}theta$.${BS}nRectification and correct answer:${BS}n` +
      `$= ${BS}frac{2}{${BS}cos ${BS}theta}$${BS}n(x - 8)(x - 37) = 0${BS}nx = 8 and $a ${BS}neq b$, $${BS}nu$, $${BS}not= 0$`;
    const out = cleanGeneratedText(prodLike);
    expect(out).toBe(
      `The correct expansion is $1 - 2${BS}sin ${BS}theta$.\nRectification and correct answer:\n` +
        `$= ${BS}frac{2}{${BS}cos ${BS}theta}$\n(x - 8)(x - 37) = 0\nx = 8 and $a ${BS}neq b$, $${BS}nu$, $${BS}not= 0$`
    );
    // Rendered: no "\n" left as text, the maths still converts.
    const html = renderMathText(prodLike);
    expect(html).not.toContain(`${BS}nRectification`);
    expect(html).toContain("Rectification and correct answer:\n");
    expect(html).toContain("<mfrac>");
  });

  it("cleans real prod answers, and the student app's copy of the clean-up gives the same result", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
    const fixture = JSON.parse(read("../test-fixtures/question-paper/answers-with-backslash-n.json")) as {
      entries: { answer: string }[];
    };
    // Load cleanGeneratedText from frontend/app.js (the block between its
    // constants and isFormulaInText) so the two copies can't drift apart.
    const app = read("../../frontend/app.js");
    const start = app.indexOf("const LATEX_N_COMMANDS");
    const end = app.indexOf("function isFormulaInText");
    expect(start).toBeGreaterThan(-1);
    const appClean = new Function(`${app.slice(start, end)}; return cleanGeneratedText;`)() as (s: string) => string;

    expect(fixture.entries.length).toBeGreaterThan(0);
    for (const { answer } of fixture.entries) {
      expect(answer).toContain("\\n"); // the raw prod text has backslash-n
      const cleaned = cleanGeneratedText(answer);
      expect(cleaned).not.toMatch(/\\n(?![a-z])/); // no "\n" left except LaTeX commands
      expect(cleaned.split("\n").length).toBeGreaterThan(3); // the working is on separate lines
      expect(appClean(answer)).toBe(cleaned);
    }
  });

  it("turns common LaTeX commands written outside $...$ into symbols, and leaves maths and unknown commands alone", () => {
    const BS = "\\";
    expect(cleanGeneratedText(`the pool is 34 m ${BS}times 24 m`)).toBe("the pool is 34 m × 24 m");
    expect(cleanGeneratedText(`If one root is ${BS}alpha, the other is $1/${BS}alpha$`)).toBe(`If one root is α, the other is $1/${BS}alpha$`);
    expect(cleanGeneratedText(`x ${BS}leq 5 and $a ${BS}times b$`)).toBe(`x ≤ 5 and $a ${BS}times b$`);
    expect(cleanGeneratedText(`${BS}sqrt{2} and ${BS}timesx`)).toBe(`${BS}sqrt{2} and ${BS}timesx`);
  });

  it("renders fractions full size (\\frac as \\dfrac)", () => {
    expect(renderMathText("$\\frac{a}{b}$")).toContain('displaystyle="true"');
  });

  it("repairs common mojibake (staging answer: 1184 mÂ²)", () => {
    expect(cleanGeneratedText("Area = 1184 mÂ², 30Â°, Â½")).toBe("Area = 1184 m², 30°, ½");
    expect(cleanGeneratedText("2 Ã— 3 âˆ’ 1, itâ€™s")).toBe("2 × 3 − 1, it’s");
    expect(cleanGeneratedText("Ångström stays")).toBe("Ångström stays");
  });

  it("shows the source text of a formula KaTeX can't parse instead of failing", () => {
    const out = renderMathText("bad $\\frac{1}{$ end");
    expect(out).toContain("end");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("renderAnswerKeyHtml", () => {
  it("includes each question's answer text", async () => {
    const key: AnswerKey = { entries: [{ section: "A", questionIndex: 0, answer: "Carbon bonds with itself." }] };
    const html = await renderAnswerKeyHtml(paper, key, envWithImages({}));
    expect(html).toContain("Carbon bonds with itself.");
  });

  it("renders tables/LaTeX/images alongside the answers and escapes the answer text", async () => {
    const key: AnswerKey = { entries: [{ section: "B", questionIndex: 0, answer: "I = V/R <script>" }] };
    const env = envWithImages({ "question-papers/p1/gen-B-1.png": new Uint8Array([7]) });
    const html = await renderAnswerKeyHtml(richPaper, key, env);
    expect(html).toContain("<table>");
    expect(html).toContain('<div class="qp-formula">');
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("I = V/R &lt;script&gt;");
  });
});

describe("renderHtmlToPdf", () => {
  it("returns null (fails open) when the browser launch throws", async () => {
    const env = { BROWSER: {} } as unknown as Env;
    const result = await renderHtmlToPdf(env, "<html></html>");
    // In the Vitest environment there's no real Browser Rendering binding,
    // so this always exercises the fail-open path - that's the behavior
    // under test here.
    expect(result).toBeNull();
  });
});
