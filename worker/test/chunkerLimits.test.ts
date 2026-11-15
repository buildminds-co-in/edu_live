import { describe, it, expect } from "vitest";
import { chunkText, jsonMetadataBytes, MAX_CHUNK_METADATA_BYTES, MAX_WORD_CHARS } from "../src/chunker";

describe("jsonMetadataBytes", () => {
  it("counts escaped quotes and backslashes as 2 bytes and non-ASCII as 6", () => {
    expect(jsonMetadataBytes("ab")).toBe(4); // 2 + surrounding quotes
    expect(jsonMetadataBytes('a"b\\c')).toBe(2 + 1 + 2 + 1 + 2 + 1);
    expect(jsonMetadataBytes("√")).toBe(2 + 6);
    expect(jsonMetadataBytes("😀")).toBe(2 + 12);
  });
});

describe("chunk size limits (Vectorize metadata cap)", () => {
  it("does not change normal text: 300-word chunks with a 50-word overlap", () => {
    const text = Array.from({ length: 700 }, (_, i) => `w${i}`).join(" ");
    const chunks = chunkText([{ page: 1, text }], "doc.pdf");
    expect(chunks.map((c) => [c.wordStart, c.wordEnd])).toEqual([
      [0, 300],
      [250, 550],
      [500, 700],
    ]);
  });

  it("splits a single huge token and keeps every chunk under the cap", () => {
    const pages = [{ page: 1, text: `intro words :${"-".repeat(48000)} more words` }];
    const chunks = chunkText(pages, "doc.pdf");
    for (const c of chunks) {
      expect(jsonMetadataBytes(c.text)).toBeLessThanOrEqual(MAX_CHUNK_METADATA_BYTES);
      for (const word of c.text.split(" ")) expect(word.length).toBeLessThanOrEqual(MAX_WORD_CHARS);
    }
  });

  it("ends a chunk early when backslash-heavy LaTeX would overflow the cap once escaped", () => {
    const latex = Array.from({ length: 600 }, () => "$\\frac{\\sqrt{a^{2}+b^{2}}}{\\left(\\alpha+\\beta\\right)}$").join(" ");
    const chunks = chunkText([{ page: 1, text: latex }], "doc.pdf");
    expect(chunks[0].wordEnd - chunks[0].wordStart).toBeLessThan(300);
    for (const c of chunks) expect(jsonMetadataBytes(c.text)).toBeLessThanOrEqual(MAX_CHUNK_METADATA_BYTES);
  });

  it("keeps symbol-heavy maths under the cap", () => {
    const symbols = Array.from({ length: 900 }, () => "√3×θ²÷Σ").join(" ");
    const chunks = chunkText([{ page: 1, text: symbols }], "doc.pdf");
    for (const c of chunks) expect(jsonMetadataBytes(c.text)).toBeLessThanOrEqual(MAX_CHUNK_METADATA_BYTES);
  });

  it("covers every word, always moves forward, and overlaps a cut-short chunk by at most half", () => {
    const text = Array.from({ length: 400 }, (_, i) => `${i}${"x".repeat(150)}`).join(" ");
    const chunks = chunkText([{ page: 1, text }], "doc.pdf");
    expect(chunks[0].wordStart).toBe(0);
    expect(chunks[chunks.length - 1].wordEnd).toBe(400);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      expect(chunks[i].wordStart).toBeGreaterThan(prev.wordStart);
      expect(chunks[i].wordStart).toBeLessThanOrEqual(prev.wordEnd);
      expect(prev.wordEnd - chunks[i].wordStart).toBeLessThanOrEqual(Math.floor((prev.wordEnd - prev.wordStart) / 2));
    }
  });
});
