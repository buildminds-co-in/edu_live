import { describe, it, expect, vi } from "vitest";
import { handleAdminDeleteDocument } from "../src/documentDeletion";
import { chunkVectorId } from "../src/vectorId";
import type { Env } from "../src/index";

const NAME = "light notes.pdf";

type Paper = { id: string; chapter_filenames: string };

function makeEnv({
  exists = true,
  chunkCount = "3",
  objects = [] as string[],
  papers = [] as Paper[],
  failVectorDelete = false,
} = {}) {
  const store = new Set<string>(objects);
  if (exists) store.add(NAME);
  const deletedPapers: string[] = [];
  const steps: string[] = [];

  const env = {
    VECTORIZE: {
      deleteByIds: vi.fn(async (ids: string[]) => {
        steps.push("vectors");
        if (failVectorDelete) throw new Error("vectorize down");
        return { count: ids.length };
      }),
    },
    PDF_BUCKET: {
      head: vi.fn(async (key: string) => (store.has(key) ? { customMetadata: { chunkCount } } : null)),
      list: vi.fn(async ({ prefix }: { prefix: string }) => ({
        objects: [...store].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
      })),
      delete: vi.fn(async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) {
          if (k === NAME) steps.push("pdf");
          store.delete(k);
        }
      }),
    },
    EDU_LIVE_DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          all: async () => ({ results: sql.startsWith("SELECT") ? papers : [] }),
          run: async () => {
            if (sql.startsWith("DELETE")) deletedPapers.push(String(args[0]));
            return {};
          },
        }),
      }),
    },
  } as unknown as Env;
  return { env, store, deletedPapers, steps };
}

function del(name: string | null) {
  const url = name === null ? "https://w/admin/documents" : `https://w/admin/documents?name=${encodeURIComponent(name)}`;
  return new Request(url, { method: "DELETE" });
}

describe("DELETE /admin/documents", () => {
  it("deletes the vectors, screenshots, cleaned text, cached papers and finally the PDF", async () => {
    const { env, store, deletedPapers, steps } = makeEnv({
      objects: [
        `page-images/${NAME}/2.png`,
        `page-images/${NAME}/5.png`,
        `cleaned/${NAME}.md`,
        "question-papers/p1.pdf",
        "question-papers/p1-key.pdf",
        "other.pdf",
        "question-papers/p2.pdf",
      ],
      papers: [
        { id: "p1", chapter_filenames: JSON.stringify([NAME, "other.pdf"]) },
        // LIKE prefilter over-match: a different file whose name contains NAME
        { id: "p2", chapter_filenames: JSON.stringify([`old ${NAME}`]) },
      ],
    });

    const res = await handleAdminDeleteDocument(del(NAME), env);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "deleted", name: NAME, chunks: 3, pageImages: 2, cachedPapers: 1 });
    expect(env.VECTORIZE.deleteByIds).toHaveBeenCalledWith([0, 1, 2].map((i) => chunkVectorId(NAME, i)));
    expect(deletedPapers).toEqual(["p1"]);
    expect([...store].sort()).toEqual(["other.pdf", "question-papers/p2.pdf"]);
    expect(steps.at(-1)).toBe("pdf");
  });

  it("returns 404 for an unknown document and deletes nothing", async () => {
    const { env } = makeEnv({ exists: false });
    const res = await handleAdminDeleteDocument(del(NAME), env);
    expect(res.status).toBe(404);
    expect(env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
    expect(env.PDF_BUCKET.delete).not.toHaveBeenCalled();
  });

  it.each([null, "", `cleaned/${NAME}.md`, `page-images/${NAME}/1.png`, "question-papers/p1.pdf"])(
    "rejects %j as a name with 400",
    async (name) => {
      const { env } = makeEnv();
      const res = await handleAdminDeleteDocument(del(name), env);
      expect(res.status).toBe(400);
      expect(env.PDF_BUCKET.delete).not.toHaveBeenCalled();
    }
  );

  it("keeps the PDF listed when an earlier step fails, so the delete can be retried", async () => {
    const { env, store } = makeEnv({ failVectorDelete: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleAdminDeleteDocument(del(NAME), env);
    expect(res.status).toBe(500);
    expect(store.has(NAME)).toBe(true);
  });

  it("skips the vector delete when the document has no stored chunk count", async () => {
    const { env, store } = makeEnv({ chunkCount: "" });
    const res = await handleAdminDeleteDocument(del(NAME), env);
    expect(res.status).toBe(200);
    expect(env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
    expect(store.has(NAME)).toBe(false);
  });
});
