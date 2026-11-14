import type { PageText, Chunk } from "./types";

// Each chunk's full text is stored in its Vectorize vector's metadata, which
// Vectorize caps at 10,240 bytes of compact JSON. This is a safety net only:
// normal chunks (300 words) measure about 2 KB, and enrichment guards in
// ingestionEnrichment.ts stop the runaway replies that once produced a 46 KB
// chunk. The cap leaves about 2 KB for the other metadata fields.
export const MAX_CHUNK_METADATA_BYTES = 8000;
// A single unbroken token longer than this (a runaway separator, a pasted
// URL, a long LaTeX run) is split into pieces before chunking, so one token
// can never exceed the cap on its own. Real words, formulas and table cells
// measured at most 160 characters.
export const MAX_WORD_CHARS = 200;

/**
 * Worst-case size of `text` inside compact JSON: quotes and backslashes are
 * escaped (2 bytes), other control characters become \uXXXX (6 bytes), and
 * non-ASCII is counted as \uXXXX (6 bytes, 12 for a surrogate pair) in case
 * the store escapes it rather than writing UTF-8. Overestimates on purpose.
 */
export function jsonMetadataBytes(text: string): number {
  let size = 2; // surrounding quotes
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '"' || ch === "\\") size += 2;
    else if (code < 0x20) size += 6;
    else if (code < 0x80) size += 1;
    else if (code > 0xffff) size += 12;
    else size += 6;
  }
  return size;
}

function splitLongWord(word: string): string[] {
  if (word.length <= MAX_WORD_CHARS) return [word];
  const codePoints = Array.from(word);
  const pieces: string[] = [];
  for (let i = 0; i < codePoints.length; i += MAX_WORD_CHARS) {
    pieces.push(codePoints.slice(i, i + MAX_WORD_CHARS).join(""));
  }
  return pieces;
}

/**
 * Splits extracted page text into overlapping word-count chunks. Direct
 * port of chunker.py's chunk_text: chunking flows across the whole
 * document (not restarted per page) so page boundaries don't produce
 * weak, small chunks. A chunk also ends early if its text would exceed
 * MAX_CHUNK_METADATA_BYTES, so it always fits in Vectorize metadata.
 */
export function chunkText(
  pages: PageText[],
  source: string,
  chunkSize = 300,
  overlap = 50
): Chunk[] {
  if (overlap >= chunkSize) {
    throw new Error("overlap must be smaller than chunkSize");
  }

  const words: string[] = [];
  const wordPages: number[] = [];
  for (const page of pages) {
    const pageWords = page.text.split(/\s+/).filter(Boolean).flatMap(splitLongWord);
    words.push(...pageWords);
    wordPages.push(...new Array(pageWords.length).fill(page.page));
  }

  if (words.length === 0) {
    return [];
  }

  const chunks: Chunk[] = [];
  let chunkId = 0;
  let start = 0;

  while (start < words.length) {
    // Up to chunkSize words, stopping early only if the text would no longer
    // fit in metadata. Always takes at least one word, so this always ends.
    let end = start;
    let size = 2;
    while (end < words.length && end - start < chunkSize) {
      const wordSize = jsonMetadataBytes(words[end]) - 2 + (end > start ? 1 : 0); // +1 for the joining space
      if (end > start && size + wordSize > MAX_CHUNK_METADATA_BYTES) break;
      size += wordSize;
      end += 1;
    }

    chunks.push({
      text: words.slice(start, end).join(" "),
      page: wordPages[start],
      pageEnd: wordPages[end - 1],
      chunkId,
      source,
      wordStart: start,
      wordEnd: end,
      chunkSize,
      overlap,
    });
    chunkId += 1;

    if (end >= words.length) break;
    // Normal chunks keep the full overlap. A chunk cut short by the size cap
    // overlaps by at most half its length, so the next chunk always moves on.
    start = end - Math.min(overlap, Math.floor((end - start) / 2));
  }

  return chunks;
}
