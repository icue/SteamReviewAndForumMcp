import {
  appendForumCommentChunk,
  cleanupExpiredForumTopicExports,
  createInitialForumTopicExportManifest,
  deleteForumTopicExport,
  ensureForumExportRootExists,
  forumTopicExportExists,
  loadForumExportManifest,
  readForumCommentChunk,
  readPendingForumCommentBuffer,
  readPersistedForumCommentChunk,
  saveForumExportManifest,
  savePendingForumCommentBuffer,
  type ForumTopicExportManifest,
  type ForumTopicExportRequest,
} from "./forum-topic-export-store.js";
import {
  getSteamForumTopic,
  type SteamForumComment,
  waitBeforeNextForumPageFetch,
} from "./forum-scraper.js";

export interface SteamForumTopicExportParams {
  topic_url: string;
  chunk_size_comments: number;
  max_comments: number | null;
}

const activeForumTopicExportJobs = new Map<string, Promise<void>>();

function buildForumTopicExportRequest(
  params: SteamForumTopicExportParams,
): ForumTopicExportRequest {
  return {
    topic_url: params.topic_url,
    chunk_size_comments: params.chunk_size_comments,
    max_comments: params.max_comments,
  };
}

function normalizeExportError(
  error: unknown,
): { message: string; code: string | null } {
  if (error instanceof Error) {
    const code =
      "code" in error && typeof error.code === "string" ? error.code : null;

    return {
      message: error.message,
      code,
    };
  }

  return {
    message: String(error),
    code: null,
  };
}

function buildForumTopicExportSummary(
  manifest: ForumTopicExportManifest,
): Record<string, unknown> {
  return {
    corpus_id: manifest.export_id,
    status: manifest.status,
    appid: manifest.appid,
    forum_url: manifest.forum_url,
    topic: manifest.topic,
    request: manifest.request,
    progress: manifest.progress,
    chunk_count: manifest.chunks.length,
    chunks: manifest.chunks.map((chunk) => ({
      chunk_index: chunk.chunk_index,
      comment_count: chunk.comment_count,
      start_offset: chunk.start_offset,
      end_offset: chunk.end_offset,
    })),
    error: manifest.error,
  };
}

async function loadSeenCommentIds(
  manifest: ForumTopicExportManifest,
): Promise<Set<string>> {
  const seenCommentIds = new Set<string>();

  for (const chunk of manifest.chunks) {
    const comments = await readPersistedForumCommentChunk(
      manifest.export_id,
      chunk.chunk_index,
    );

    for (const comment of comments) {
      seenCommentIds.add(comment.comment_id);
    }
  }

  return seenCommentIds;
}

async function flushForumTopicExportBuffer(
  manifest: ForumTopicExportManifest,
  buffer: SteamForumComment[],
  chunkIndex: number,
): Promise<number> {
  if (buffer.length === 0) {
    return chunkIndex;
  }

  const chunkMeta = await appendForumCommentChunk(
    manifest.export_id,
    chunkIndex,
    manifest.progress.total_comments_exported,
    buffer,
  );

  manifest.chunks.push(chunkMeta);
  manifest.progress.total_comments_exported += buffer.length;
  buffer.length = 0;

  await savePendingForumCommentBuffer(manifest.export_id, buffer);
  await saveForumExportManifest(manifest);

  return chunkIndex + 1;
}

async function runForumTopicExport(
  manifest: ForumTopicExportManifest,
): Promise<ForumTopicExportManifest> {
  const seenCommentIds = await loadSeenCommentIds(manifest);
  const buffer = await readPendingForumCommentBuffer(manifest.export_id);
  for (const comment of buffer) {
    seenCommentIds.add(comment.comment_id);
  }
  let chunkIndex = manifest.chunks.length;
  let nextPage = manifest.progress.next_page ?? 1;

  manifest.status = "running";
  manifest.error = null;
  manifest.completed_at = null;
  manifest.progress.stopped_reason = "in_progress";
  await saveForumExportManifest(manifest);

  try {
    while (true) {
      if (manifest.progress.pages_fetched > 0) {
        await waitBeforeNextForumPageFetch();
      }

      const totalBufferedComments =
        manifest.progress.total_comments_exported + buffer.length;

      if (
        manifest.request.max_comments !== null &&
        totalBufferedComments >= manifest.request.max_comments
      ) {
        manifest.progress.stopped_reason = "max_comments";
        break;
      }

      const topicPage = await getSteamForumTopic(
        manifest.request.topic_url,
        nextPage,
        false,
      );

      manifest.progress.pages_fetched += 1;

      if (manifest.topic === null) {
        manifest.topic = topicPage.topic;
        manifest.appid = topicPage.appid;
        manifest.forum_url = topicPage.forum_url;
      }

      if (manifest.progress.total_comments_expected === null) {
        manifest.progress.total_comments_expected = topicPage.comments.total_count;
      }

      const pageComments = topicPage.comments.items;
      manifest.progress.last_successful_page = nextPage;

      if (pageComments.length === 0) {
        manifest.progress.next_page = null;
        manifest.progress.stopped_reason = "exhausted";
        break;
      }

      let stoppedMidPage = false;

      for (const comment of pageComments) {
        if (seenCommentIds.has(comment.comment_id)) {
          manifest.progress.duplicate_comments_removed += 1;
          continue;
        }

        if (
          manifest.request.max_comments !== null &&
          manifest.progress.total_comments_exported + buffer.length >=
            manifest.request.max_comments
        ) {
          manifest.progress.stopped_reason = "max_comments";
          manifest.progress.next_page = nextPage;
          stoppedMidPage = true;
          break;
        }

        seenCommentIds.add(comment.comment_id);
        buffer.push(comment);

        if (buffer.length >= manifest.request.chunk_size_comments) {
          chunkIndex = await flushForumTopicExportBuffer(
            manifest,
            buffer,
            chunkIndex,
          );
        }
      }

      if (stoppedMidPage) {
        await savePendingForumCommentBuffer(manifest.export_id, buffer);
        await saveForumExportManifest(manifest);
        break;
      }

      manifest.progress.next_page =
        nextPage < topicPage.comments.total_pages ? nextPage + 1 : null;

      if (manifest.progress.next_page === null) {
        manifest.progress.stopped_reason = "exhausted";
        break;
      }

      nextPage = manifest.progress.next_page;
      await savePendingForumCommentBuffer(manifest.export_id, buffer);
      await saveForumExportManifest(manifest);
    }

    chunkIndex = await flushForumTopicExportBuffer(manifest, buffer, chunkIndex);
    void chunkIndex;

    manifest.status = "completed";
    manifest.completed_at = new Date().toISOString();
    manifest.error = null;
    await saveForumExportManifest(manifest);

    return manifest;
  } catch (error) {
    manifest.status = "failed";
    manifest.error = normalizeExportError(error);
    await savePendingForumCommentBuffer(manifest.export_id, buffer);
    await saveForumExportManifest(manifest);
    return manifest;
  }
}

async function cleanupForumTopicExports(): Promise<void> {
  await cleanupExpiredForumTopicExports(activeForumTopicExportJobs.keys());
}

function scheduleForumTopicExport(manifest: ForumTopicExportManifest): void {
  if (activeForumTopicExportJobs.has(manifest.export_id)) {
    return;
  }

  const job = runForumTopicExport(manifest)
    .then(() => undefined)
    .catch((error) => {
      console.error(
        `Forum topic export ${manifest.export_id} failed unexpectedly.`,
        error,
      );
    })
    .finally(() => {
      activeForumTopicExportJobs.delete(manifest.export_id);
    });

  activeForumTopicExportJobs.set(manifest.export_id, job);
}

export async function createForumTopicExportResponse(
  params: SteamForumTopicExportParams,
): Promise<string> {
  await ensureForumExportRootExists();
  await cleanupForumTopicExports();

  const manifest = createInitialForumTopicExportManifest(
    buildForumTopicExportRequest(params),
  );

  await saveForumExportManifest(manifest);
  scheduleForumTopicExport(manifest);

  return JSON.stringify(buildForumTopicExportSummary(manifest), null, 2);
}

export async function ensureForumTopicExportIsRunning(
  exportId: string,
): Promise<ForumTopicExportManifest | null> {
  await cleanupForumTopicExports();

  if (!(await forumTopicExportExists(exportId))) {
    return null;
  }

  const manifest = await loadForumExportManifest(exportId);

  if (activeForumTopicExportJobs.has(exportId)) {
    return manifest;
  }

  if (manifest.status === "completed") {
    return manifest;
  }

  if (manifest.progress.next_page === null) {
    return manifest;
  }

  manifest.status = "running";
  manifest.error = null;
  manifest.completed_at = null;
  manifest.progress.stopped_reason = "in_progress";
  await saveForumExportManifest(manifest);
  scheduleForumTopicExport(manifest);

  return manifest;
}

export async function getForumTopicExportStatusResponse(
  exportId: string,
): Promise<string> {
  const manifest = await ensureForumTopicExportIsRunning(exportId);
  if (!manifest) {
    return JSON.stringify(
      {
        corpus_id: exportId,
        status: "not_found",
      },
      null,
      2,
    );
  }

  return JSON.stringify(buildForumTopicExportSummary(manifest), null, 2);
}

export async function readForumTopicExportChunkResponse(
  exportId: string,
  chunkIndex: number,
): Promise<string> {
  const manifest = await ensureForumTopicExportIsRunning(exportId);
  if (!manifest) {
    return JSON.stringify(
      {
        corpus_id: exportId,
        status: "not_found",
      },
      null,
      2,
    );
  }
  const chunkMeta = manifest.chunks.find(
    (chunk) => chunk.chunk_index === chunkIndex,
  );

  if (!chunkMeta) {
    return JSON.stringify(
      {
        corpus_id: exportId,
        status: manifest.status,
        chunk_index: chunkIndex,
        error: {
          message: "Chunk not found.",
          code: null,
        },
      },
      null,
      2,
    );
  }

  const comments = await readForumCommentChunk(exportId, chunkIndex);

  return JSON.stringify(
    {
      corpus_id: exportId,
      status: manifest.status,
      topic: manifest.topic,
      chunk_index: chunkIndex,
      chunk_count: manifest.chunks.length,
      comment_count: comments.length,
      start_offset: chunkMeta.start_offset,
      end_offset: chunkMeta.end_offset,
      comments,
    },
    null,
    2,
  );
}

export async function deleteForumTopicExportResponse(
  exportId: string,
): Promise<string> {
  await cleanupForumTopicExports();

  if (activeForumTopicExportJobs.has(exportId)) {
    return JSON.stringify(
      {
        export_id: exportId,
        deleted: false,
        status: "running",
        error: {
          message: "Cannot delete a forum topic export while it is still running.",
          code: "EXPORT_RUNNING",
        },
      },
      null,
      2,
    );
  }

  const existed = await forumTopicExportExists(exportId);
  await deleteForumTopicExport(exportId);

  return JSON.stringify(
    {
      export_id: exportId,
      deleted: existed,
    },
    null,
    2,
  );
}
