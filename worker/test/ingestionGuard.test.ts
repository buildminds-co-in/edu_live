import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  collapseRepeatedRuns,
  isRunawayPage,
  parseEnrichedPages,
  enrichmentMaxTokens,
  countEnrichedPages,
  enrichPdfToMarkdown,
  RUNAWAY_PAGE_MIN_CHARS,
} from "../src/ingestionEnrichment";
import { chunkText, jsonMetadataBytes, MAX_CHUNK_METADATA_BYTES } from "../src/chunker";
import type { Env } from "../src/index";
import type { PageText } from "../src/types";

// Real replies captured from google/gemini-2.5-flash while enriching a 7-page
// question paper (trimmed). Both are runaway replies the guard must survive.
const fixture = (name: string) => readFileSync(join(__dirname, "..", "test-fixtures", "enrichment", name), "utf8");
const SEPARATOR_REPLY = fixture("runaway-table-separator.md"); // one ~48,000-character ":-----" token
const PADDED_REPLY = fixture("runaway-padded-table-row.md"); // a table row padded with ~58,000 spaces

// Plain-text pages of a similar size to the real paper's (about 2,500 characters each).
const PLAIN_PAGES: PageText[] = Array.from({ length: 7 }, (_, i) => ({
  page: i + 1,
  text: `Plain text of page ${i + 1}. ` + "Question text and options for this page. ".repeat(60),
}));

afterEach(() => vi.restoreAllMocks());

describe("collapseRepeatedRuns", () => {
  it("shortens long table separators, blanks and dot leaders to three characters", () => {
    expect(collapseRepeatedRuns("| :----------: | ---------- |")).toBe("| :---: | --- |");
    expect(collapseRepeatedRuns("Student name: ______________")).toBe("Student name: ___");
    expect(collapseRepeatedRuns("Contents ........ 4")).toBe("Contents ... 4");
    expect(collapseRepeatedRuns("Name: \\_\\_\\_\\_\\_\\_")).toBe("Name: \\_\\_\\_");
  });

  it("collapses padding of 20+ spaces to one space", () => {
    expect(collapseRepeatedRuns(`| Q. No. |${" ".repeat(500)}| Marks |`)).toBe("| Q. No. | | Marks |");
  });

  it("keeps a line repeated back to back at most twice, ignoring blank lines in between", () => {
    const looped = ["Header", "| | |", "| | |", "", "| | |", "| | |", "Next"].join("\n");
    expect(collapseRepeatedRuns(looped)).toBe(["Header", "| | |", "| | |", "", "Next"].join("\n"));
  });

  it("leaves normal content alone: short separators, LaTeX, ellipses and indentation", () => {
    const normal = [
      "| Q. | Answer |",
      "|---|---|",
      "| 1. | $\\frac{1}{f} = \\frac{1}{v} + \\frac{1}{u}$ |",
      "Wait... then -- continue",
      "    - nested list item",
      "Same line",
      "Same line",
    ].join("\n");
    expect(collapseRepeatedRuns(normal)).toBe(normal);
  });
});

describe("isRunawayPage", () => {
  it("flags a page that is over 6,000 characters and over 4x its plain text", () => {
    expect(isRunawayPage("x ".repeat(RUNAWAY_PAGE_MIN_CHARS), "short plain page")).toBe(true);
  });

  it("does not flag a large page that is close to its plain-text size", () => {
    const plain = "word ".repeat(2000); // 10,000 characters
    expect(isRunawayPage("word ".repeat(2400), plain)).toBe(false);
  });

  it("does not flag a small page that grew a lot (a figure description on a mostly-image page)", () => {
    expect(isRunawayPage("[Figure: a labelled diagram of the human heart] ".repeat(30), "Fig. 1")).toBe(false);
  });

  it("ignores padding spaces when measuring", () => {
    expect(isRunawayPage(`| Q. No. |${" ".repeat(60000)}| Marks |`, "Q. No. Marks")).toBe(false);
  });
});

describe("parseEnrichedPages on real runaway replies", () => {
  it("keeps the usable pages of the 48,000-character separator reply and every chunk fits Vectorize metadata", () => {
    const pages = parseEnrichedPages(SEPARATOR_REPLY, PLAIN_PAGES, true);
    const chunks = chunkText(pages, "Edukripa_Science_Test_Paper_1.pdf");
    for (const chunk of chunks) {
      expect(jsonMetadataBytes(chunk.text)).toBeLessThanOrEqual(MAX_CHUNK_METADATA_BYTES);
      expect(chunk.text).not.toMatch(/-{4,}/);
    }
    expect(Math.max(...pages.map((p) => p.text.length))).toBeLessThan(RUNAWAY_PAGE_MIN_CHARS);
  });

  it("keeps the padded table reply's real content without the padding", () => {
    const pages = parseEnrichedPages(PADDED_REPLY, PLAIN_PAGES);
    expect(pages[0].text).toContain("CBSE CLASS X TEST SERIES");
    expect(pages[0].text).not.toMatch(/ {20,}/);
    // Pages the reply never reached fall back to plain text.
    expect(pages.slice(1)).toEqual(PLAIN_PAGES.slice(1));
  });

  it("falls back to plain text for a page that is still a runaway after cleaning", () => {
    const looped = "<<<PAGE 1>>>\n" + Array.from({ length: 3000 }, (_, i) => `loop line ${i}`).join("\n");
    const pages = parseEnrichedPages(looped, PLAIN_PAGES.slice(0, 1));
    expect(pages[0].text).toBe(PLAIN_PAGES[0].text);
  });

  it("returns the fallback array itself when no page could be used, so enrichment reads as not applied", () => {
    expect(parseEnrichedPages("no markers at all", PLAIN_PAGES)).toBe(PLAIN_PAGES);
    const looped = "<<<PAGE 1>>>\n" + Array.from({ length: 3000 }, (_, i) => `loop line ${i}`).join("\n");
    expect(parseEnrichedPages(looped, PLAIN_PAGES.slice(0, 1))).not.toBe(PLAIN_PAGES);
    const onlyPage = PLAIN_PAGES.slice(0, 1);
    expect(parseEnrichedPages(looped, onlyPage)).toBe(onlyPage);
  });
});

describe("enrichmentMaxTokens", () => {
  it("allows 1,500 output tokens per page, at least 8,000 and at most 60,000", () => {
    expect(enrichmentMaxTokens(1)).toBe(8000);
    expect(enrichmentMaxTokens(7)).toBe(10500);
    expect(enrichmentMaxTokens(1000)).toBe(60000);
  });
});

describe("countEnrichedPages", () => {
  it("counts pages whose text differs from the plain-text fallback", () => {
    const pages = PLAIN_PAGES.map((p, i) => (i < 3 ? { ...p, text: "enriched" } : p));
    expect(countEnrichedPages(pages, PLAIN_PAGES)).toBe(3);
    expect(countEnrichedPages(PLAIN_PAGES, PLAIN_PAGES)).toBe(0);
  });
});

describe("enrichPdfToMarkdown request and retry", () => {
  const env = { OPENROUTER_API_KEY: "test-key" } as unknown as Env;
  const config = { ingestionModelSlug: "vendor/model" };
  const reply = (content: string, finish = "stop") =>
    new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }), { status: 200 });
  const fullReply = PLAIN_PAGES.map((p) => `<<<PAGE ${p.page}>>>\nEnriched page ${p.page}`).join("\n");
  const partialReply = "<<<PAGE 1>>>\nEnriched page 1";

  it("sends max_tokens sized to the page count", async () => {
    let body: { max_tokens?: number } = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return reply(fullReply);
    });
    await enrichPdfToMarkdown(new ArrayBuffer(8), PLAIN_PAGES, env, config);
    expect(body.max_tokens).toBe(enrichmentMaxTokens(PLAIN_PAGES.length));
  });

  it("makes one call when the first reply covers at least half the pages", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => reply(fullReply));
    const pages = await enrichPdfToMarkdown(new ArrayBuffer(8), PLAIN_PAGES, env, config);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(countEnrichedPages(pages, PLAIN_PAGES)).toBe(7);
  });

  it("retries once when fewer than half the pages came back, and keeps the better attempt", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => reply(partialReply))
      .mockImplementationOnce(async () => reply(fullReply));
    const pages = await enrichPdfToMarkdown(new ArrayBuffer(8), PLAIN_PAGES, env, config);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(countEnrichedPages(pages, PLAIN_PAGES)).toBe(7);
  });

  it("keeps the first attempt when the retry is no better", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => reply(partialReply))
      .mockImplementationOnce(async () => new Response("upstream error", { status: 500 }));
    const pages = await enrichPdfToMarkdown(new ArrayBuffer(8), PLAIN_PAGES, env, config);
    expect(countEnrichedPages(pages, PLAIN_PAGES)).toBe(1);
  });

  it("does not retry when the first attempt was slow", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      now += 61_000;
      return reply(partialReply);
    });
    await enrichPdfToMarkdown(new ArrayBuffer(8), PLAIN_PAGES, env, config);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
