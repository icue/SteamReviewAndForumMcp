import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  SteamForumComment,
  SteamForumTopicDetails,
} from "./forum-scraper.js";

export const FORUM_TOPIC_EXPORT_SCHEMA_VERSION = 1 as const;

export type ForumTopicExportStatus = "running" | "completed" | "failed";

export interface ForumTopicExportRequest {
  topic_url: string;
  chunk_size_comments: number;
  max_comments: number | null;
}

export interface ForumTopicExportChunkMeta {
  chunk_index: number;
  file_name: string;
  comment_count: number;
  start_offset: number;
  end_offset: number;
}

export interface ForumTopicExportProgress {
  pages_fetched: number;
  total_comments_expected: number | null;
  total_comments_exported: number;
  duplicate_comments_removed: number;
  next_page: number | null;
  last_successful_page: number | null;
  stopped_reason: string | null;
}

export interface ForumTopicExportManifest {
  schema_version: typeof FORUM_TOPIC_EXPORT_SCHEMA_VERSION;
  export_id: string;
  status: ForumTopicExportStatus;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  appid: string | null;
  forum_url: string | null;
  topic: SteamForumTopicDetails | null;
  request: ForumTopicExportRequest;
  progress: ForumTopicExportProgress;
  chunks: ForumTopicExportChunkMeta[];
  error: { message: string; code: string | null } | null;
}

const DEFAULT_FORUM_EXPORT_TTL_HOURS = 24;

function getForumExportRootDir(): string {
  const configuredRoot = process.env.STEAM_FORUM_EXPORT_DIR;
  if (configuredRoot && configuredRoot.trim().length > 0) {
    return path.resolve(configuredRoot);
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, "..", ".steam-forum-exports");
}

function getForumExportDir(exportId: string): string {
  return path.join(getForumExportRootDir(), exportId);
}

function getForumExportTtlMs(): number {
  const configuredTtlHours = Number(process.env.STEAM_FORUM_EXPORT_TTL_HOURS);

  if (Number.isFinite(configuredTtlHours) && configuredTtlHours > 0) {
    return configuredTtlHours * 60 * 60 * 1000;
  }

  return DEFAULT_FORUM_EXPORT_TTL_HOURS * 60 * 60 * 1000;
}

function getManifestPath(exportId: string): string {
  return path.join(getForumExportDir(exportId), "manifest.json");
}

function getChunksDir(exportId: string): string {
  return path.join(getForumExportDir(exportId), "chunks");
}

function getChunkFileName(chunkIndex: number): string {
  return `${chunkIndex.toString().padStart(6, "0")}.jsonl`;
}

function getChunkPath(exportId: string, chunkIndex: number): string {
  return path.join(getChunksDir(exportId), getChunkFileName(chunkIndex));
}

function getPendingChunkPath(exportId: string): string {
  return path.join(getForumExportDir(exportId), "pending.jsonl");
}

function nowIso(): string {
  return new Date().toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serializeChunkRecords(records: SteamForumComment[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function parseChunkRecords(text: string): SteamForumComment[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SteamForumComment);
}

export function createForumTopicExportId(): string {
  return `forum_exp_${randomUUID().replace(/-/g, "")}`;
}

export function createInitialForumTopicExportManifest(
  request: ForumTopicExportRequest,
): ForumTopicExportManifest {
  const timestamp = nowIso();

  return {
    schema_version: FORUM_TOPIC_EXPORT_SCHEMA_VERSION,
    export_id: createForumTopicExportId(),
    status: "running",
    created_at: timestamp,
    updated_at: timestamp,
    started_at: timestamp,
    completed_at: null,
    appid: null,
    forum_url: null,
    topic: null,
    request,
    progress: {
      pages_fetched: 0,
      total_comments_expected: null,
      total_comments_exported: 0,
      duplicate_comments_removed: 0,
      next_page: 1,
      last_successful_page: null,
      stopped_reason: "in_progress",
    },
    chunks: [],
    error: null,
  };
}

export async function ensureForumExportRootExists(): Promise<void> {
  await mkdir(getForumExportRootDir(), { recursive: true });
}

export async function saveForumExportManifest(
  manifest: ForumTopicExportManifest,
): Promise<void> {
  const exportDir = getForumExportDir(manifest.export_id);
  await mkdir(exportDir, { recursive: true });

  manifest.updated_at = nowIso();

  await writeFile(
    getManifestPath(manifest.export_id),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
}

export async function loadForumExportManifest(
  exportId: string,
): Promise<ForumTopicExportManifest> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const manifestJson = await readFile(getManifestPath(exportId), "utf8");
      return JSON.parse(manifestJson) as ForumTopicExportManifest;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await delay(25);
      }
    }
  }

  throw lastError;
}

export async function touchForumExportManifest(
  exportId: string,
): Promise<ForumTopicExportManifest> {
  const manifest = await loadForumExportManifest(exportId);
  await saveForumExportManifest(manifest);
  return manifest;
}

export async function appendForumCommentChunk(
  exportId: string,
  chunkIndex: number,
  startOffset: number,
  comments: SteamForumComment[],
): Promise<ForumTopicExportChunkMeta> {
  const chunksDir = getChunksDir(exportId);
  await mkdir(chunksDir, { recursive: true });

  const fileName = getChunkFileName(chunkIndex);
  await writeFile(
    path.join(chunksDir, fileName),
    serializeChunkRecords(comments),
    "utf8",
  );

  return {
    chunk_index: chunkIndex,
    file_name: fileName,
    comment_count: comments.length,
    start_offset: startOffset,
    end_offset: startOffset + comments.length - 1,
  };
}

export async function readPersistedForumCommentChunk(
  exportId: string,
  chunkIndex: number,
): Promise<SteamForumComment[]> {
  const chunkText = await readFile(getChunkPath(exportId, chunkIndex), "utf8");
  return parseChunkRecords(chunkText);
}

export async function readForumCommentChunk(
  exportId: string,
  chunkIndex: number,
): Promise<SteamForumComment[]> {
  return readPersistedForumCommentChunk(exportId, chunkIndex);
}

export async function savePendingForumCommentBuffer(
  exportId: string,
  comments: SteamForumComment[],
): Promise<void> {
  const exportDir = getForumExportDir(exportId);
  await mkdir(exportDir, { recursive: true });

  const pendingChunkPath = getPendingChunkPath(exportId);
  if (comments.length === 0) {
    await rm(pendingChunkPath, { force: true });
    return;
  }

  await writeFile(pendingChunkPath, serializeChunkRecords(comments), "utf8");
}

export async function readPendingForumCommentBuffer(
  exportId: string,
): Promise<SteamForumComment[]> {
  try {
    const pendingChunkText = await readFile(getPendingChunkPath(exportId), "utf8");
    return parseChunkRecords(pendingChunkText);
  } catch {
    return [];
  }
}

export async function deleteForumTopicExport(exportId: string): Promise<void> {
  await rm(getForumExportDir(exportId), { recursive: true, force: true });
}

export async function forumTopicExportExists(exportId: string): Promise<boolean> {
  try {
    await stat(getManifestPath(exportId));
    return true;
  } catch {
    return false;
  }
}

export async function markRunningForumTopicExportsFailed(
  message = "Export was interrupted because the MCP server process restarted.",
): Promise<string[]> {
  try {
    await ensureForumExportRootExists();
  } catch {
    return [];
  }

  const updatedExportIds: string[] = [];
  const entries = await readdir(getForumExportRootDir(), { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const exportId = entry.name;
    try {
      const manifest = await loadForumExportManifest(exportId);
      if (manifest.status !== "running") {
        continue;
      }

      manifest.status = "failed";
      manifest.completed_at = null;
      manifest.error = {
        message,
        code: "PROCESS_RESTARTED",
      };
      manifest.progress.stopped_reason = "interrupted";
      await saveForumExportManifest(manifest);
      updatedExportIds.push(exportId);
    } catch {
      continue;
    }
  }

  return updatedExportIds;
}

export async function cleanupExpiredForumTopicExports(
  excludedExportIds: Iterable<string> = [],
): Promise<string[]> {
  try {
    await ensureForumExportRootExists();
  } catch {
    return [];
  }

  const ttlMs = getForumExportTtlMs();
  const now = Date.now();
  const deletedExportIds: string[] = [];
  const excluded = new Set(excludedExportIds);
  const entries = await readdir(getForumExportRootDir(), { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const exportId = entry.name;
    if (excluded.has(exportId)) {
      continue;
    }

    try {
      const manifest = await loadForumExportManifest(exportId);
      const updatedAtMs = Date.parse(manifest.updated_at);

      if (!Number.isFinite(updatedAtMs) || now - updatedAtMs > ttlMs) {
        await deleteForumTopicExport(exportId);
        deletedExportIds.push(exportId);
      }
    } catch {
      await deleteForumTopicExport(exportId);
      deletedExportIds.push(exportId);
    }
  }

  return deletedExportIds;
}
