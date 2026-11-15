import type { Env } from "./index";
import { chunkVectorId } from "./vectorId";

/**
 * Removes everything indexing produced for one document except the source
 * PDF itself: its Vectorize chunks (ids recomputed from the stored
 * chunkCount), its page screenshots and its cleaned text. Shared by force
 * re-ingest (which then writes the new version) and the admin delete.
 */
export async function deleteIndexedContent(env: Env, name: string, chunkCount: number): Promise<number> {
  if (chunkCount > 0) {
    const ids = Array.from({ length: chunkCount }, (_, i) => chunkVectorId(name, i));
    await env.VECTORIZE.deleteByIds(ids);
  }
  const pageImages = await env.PDF_BUCKET.list({ prefix: `page-images/${name}/` });
  if (pageImages.objects.length > 0) {
    await env.PDF_BUCKET.delete(pageImages.objects.map((o) => o.key));
  }
  await env.PDF_BUCKET.delete(`cleaned/${name}.md`);
  return pageImages.objects.length;
}

/**
 * Cached question papers built from this document would otherwise keep
 * being served (the cache key is the chapter list). Deletes the cache rows
 * and their rendered PDFs / generated images under question-papers/<id>.
 */
async function deleteCachedPapersUsing(env: Env, name: string): Promise<number> {
  const { results } = await env.EDU_LIVE_DB.prepare(
    "SELECT id, chapter_filenames FROM question_papers WHERE chapter_filenames LIKE ?"
  )
    .bind(`%${JSON.stringify(name).slice(1, -1)}%`)
    .all<{ id: string; chapter_filenames: string }>();

  // LIKE is only a prefilter (it can over-match, e.g. a name that's a
  // substring of another); the exact check is on the parsed list.
  const ids = (results ?? [])
    .filter((row) => {
      try {
        return (JSON.parse(row.chapter_filenames) as string[]).includes(name);
      } catch {
        return false;
      }
    })
    .map((row) => row.id);

  for (const id of ids) {
    const files = await env.PDF_BUCKET.list({ prefix: `question-papers/${id}` });
    if (files.objects.length > 0) await env.PDF_BUCKET.delete(files.objects.map((o) => o.key));
    await env.EDU_LIVE_DB.prepare("DELETE FROM question_papers WHERE id = ?").bind(id).run();
  }
  return ids.length;
}

function isSourceDocumentKey(name: string): boolean {
  return !name.startsWith("page-images/") && !name.startsWith("cleaned/") && !name.startsWith("question-papers/");
}

/**
 * DELETE /admin/documents?name=<filename>
 *
 * The source PDF is deleted LAST: if any earlier step fails, the document
 * is still listed in the dashboard and the delete can simply be retried
 * (every step is idempotent). The transactions audit log is never touched.
 */
export async function handleAdminDeleteDocument(request: Request, env: Env): Promise<Response> {
  const name = new URL(request.url).searchParams.get("name");
  if (!name || !isSourceDocumentKey(name)) {
    return Response.json({ error: "Expected a 'name' query parameter naming an uploaded document" }, { status: 400 });
  }

  try {
    const existing = await env.PDF_BUCKET.head(name);
    if (!existing) {
      return Response.json({ error: "No document with this name" }, { status: 404 });
    }
    const chunkCount = Number(existing.customMetadata?.chunkCount ?? 0);
    const pageImages = await deleteIndexedContent(env, name, chunkCount);
    const cachedPapers = await deleteCachedPapersUsing(env, name);
    await env.PDF_BUCKET.delete(name);

    return Response.json({ status: "deleted", name, chunks: chunkCount, pageImages, cachedPapers });
  } catch (err) {
    console.error("DELETE /admin/documents failed", err);
    return Response.json(
      { error: "Delete did not finish - the document is still listed, please try again." },
      { status: 500 }
    );
  }
}
