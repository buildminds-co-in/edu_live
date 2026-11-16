import { describe, it, expect, vi } from "vitest";
import { renderPaperHtml, renderAnswerKeyHtml, renderHtmlToPdf, isFormulaInText } from "../src/questionPaperPdf";
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
    // Not in the question text, so shown once as display maths for KaTeX.
    expect(html).toContain('<div class="qp-formula">$$V = IR &lt; 5$$</div>');
    expect(html).not.toContain("qp-latex");
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

  it("loads KaTeX with the same delimiters as the student app and signals when done", async () => {
    for (const html of [
      await renderPaperHtml(paper, envWithImages({})),
      await renderAnswerKeyHtml(paper, { entries: [] }, envWithImages({})),
    ]) {
      expect(html).toContain("KaTeX/0.16.9/katex.min.css");
      expect(html).toContain("KaTeX/0.16.9/contrib/auto-render.min.js");
      expect(html).toContain('{left:"$",right:"$",display:false}');
      expect(html).toContain("window.__mathDone=true");
      expect(html).toContain('<meta charset="utf-8">');
    }
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
