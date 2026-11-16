// katex 0.16.9 ships no TypeScript types; this covers the one call used in
// questionPaperPdf.ts (avoids adding @types/katex as another dependency).
declare module "katex" {
  interface KatexOptions {
    output?: "html" | "mathml" | "htmlAndMathml";
    displayMode?: boolean;
    throwOnError?: boolean;
    strict?: boolean | "ignore" | "warn" | "error";
  }
  const katex: {
    renderToString(tex: string, options?: KatexOptions): string;
  };
  export default katex;
}
