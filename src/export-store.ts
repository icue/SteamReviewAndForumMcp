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

export const EXPORT_SCHEMA_VERSION = 1 as const;

export type ReviewExportStatus = "running" | "completed" | "failed";

export interface ReviewExportRequest {
  appid: string;
  language: string;
  review_type: string;
  purchase_type: string;
  include_offtopic_activity: boolean;
  traversal_mode: string;
  page_size: number;
  chunk_size_reviews: number;
  include_review_metadata: boolean;
  max_reviews: number | null;
}

export interface StoredReviewAuthor {
  steamid: string | null;
  num_games_owned: number | null;
  num_reviews: number | null;
  playtime_forever: number | null;
  playtime_last_two_weeks: number | null;
  playtime_at_review: number | null;
  deck_playtime_at_review: number | null;
  last_played: number | null;
}

export interface StoredReviewRecord {
  recommendationid: string | null;
  language: string | null;
  review: string;
  timestamp_created: number | null;
  timestamp_updated: number | null;
  voted_up: boolean | null;
  votes_up: number | null;
  votes_funny: number | null;
  weighted_vote_score: string | null;
  comment_count: number | null;
  steam_purchase: boolean | null;
  received_for_free: boolean | null;
  written_during_early_access: boolean | null;
  developer_response: string | null;
  timestamp_dev_responded: number | null;
  primarily_steam_deck: boolean | null;
  author: StoredReviewAuthor | null;
}

export interface PersistedReviewRecord extends StoredReviewRecord {
  review_key: string;
}

export interface ReviewExportChunkMeta {
  chunk_index: number;
  file_name: string;
  review_count: number;
  start_offset: number;
  end_offset: number;
}

export interface ReviewExportProgress {
  pages_fetched: number;
  total_reviews_expected: number | null;
  total_reviews_exported: number;
  duplicate_reviews_removed: number;
  next_cursor: string | null;
  last_successful_cursor: string | null;
  stopped_reason: string | null;
}

export interface ReviewExportManifest {
  schema_version: typeof EXPORT_SCHEMA_VERSION;
  export_id: string;
  status: ReviewExportStatus;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  appid: string;
  game_name: string | null;
  request: ReviewExportRequest;
  progress: ReviewExportProgress;
  chunks: ReviewExportChunkMeta[];
  error: { message: string; code: string | null } | null;
}

const DEFAULT_EXPORT_TTL_HOURS = 24;

function getExportRootDir(): string {
  const configuredRoot = process.env.STEAM_REVIEW_EXPORT_DIR;
  if (configuredRoot && configuredRoot.trim().length > 0) {
    return path.resolve(configuredRoot);
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, "..", ".steam-review-exports");
}

function getExportDir(exportId: string): string {
  return path.join(getExportRootDir(), exportId);
}

function getExportTtlMs(): number {
  const configuredTtlHours = Number(process.env.STEAM_REVIEW_EXPORT_TTL_HOURS);

  if (Number.isFinite(configuredTtlHours) && configuredTtlHours > 0) {
    return configuredTtlHours * 60 * 60 * 1000;
  }

  return DEFAULT_EXPORT_TTL_HOURS * 60 * 60 * 1000;
}

function getManifestPath(exportId: string): string {
  return path.join(getExportDir(exportId), "manifest.json");
}

function getChunksDir(exportId: string): string {
  return path.join(getExportDir(exportId), "chunks");
}

function getChunkFileName(chunkIndex: number): string {
  return `${chunkIndex.toString().padStart(6, "0")}.jsonl`;
}

function getChunkPath(exportId: string, chunkIndex: number): string {
  return path.join(getChunksDir(exportId), getChunkFileName(chunkIndex));
}

function getPendingChunkPath(exportId: string): string {
  return path.join(getExportDir(exportId), "pending.jsonl");
}

function nowIso(): string {
  return new Date().toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serializeChunkRecords(records: PersistedReviewRecord[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function parseChunkRecords(text: string): PersistedReviewRecord[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(
      (line) => JSON.parse(line) as PersistedReviewRecord,
    );
}

export function createExportId(): string {
  return `exp_${randomUUID().replace(/-/g, "")}`;
}

export function createInitialExportManifest(
  appid: string,
  gameName: string | null,
  request: ReviewExportRequest,
): ReviewExportManifest {
  const timestamp = nowIso();

  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    export_id: createExportId(),
    status: "running",
    created_at: timestamp,
    updated_at: timestamp,
    started_at: timestamp,
    completed_at: null,
    appid,
    game_name: gameName,
    request,
    progress: {
      pages_fetched: 0,
      total_reviews_expected: null,
      total_reviews_exported: 0,
      duplicate_reviews_removed: 0,
      next_cursor: "*",
      last_successful_cursor: null,
      stopped_reason: "in_progress",
    },
    chunks: [],
    error: null,
  };
}

export async function ensureExportRootExists(): Promise<void> {
  await mkdir(getExportRootDir(), { recursive: true });
}

export async function saveExportManifest(
  manifest: ReviewExportManifest,
): Promise<void> {
  const exportDir = getExportDir(manifest.export_id);
  await mkdir(exportDir, { recursive: true });

  manifest.updated_at = nowIso();

  await writeFile(
    getManifestPath(manifest.export_id),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
}

export async function loadExportManifest(
  exportId: string,
): Promise<ReviewExportManifest> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const manifestJson = await readFile(getManifestPath(exportId), "utf8");
      return JSON.parse(manifestJson) as ReviewExportManifest;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await delay(25);
      }
    }
  }

  throw lastError;
}

export async function touchExportManifest(
  exportId: string,
): Promise<ReviewExportManifest> {
  const manifest = await loadExportManifest(exportId);
  await saveExportManifest(manifest);
  return manifest;
}

export async function appendReviewChunk(
  exportId: string,
  chunkIndex: number,
  startOffset: number,
  records: PersistedReviewRecord[],
): Promise<ReviewExportChunkMeta> {
  const chunksDir = getChunksDir(exportId);
  await mkdir(chunksDir, { recursive: true });

  const fileName = getChunkFileName(chunkIndex);
  await writeFile(
    path.join(chunksDir, fileName),
    serializeChunkRecords(records),
    "utf8",
  );

  return {
    chunk_index: chunkIndex,
    file_name: fileName,
    review_count: records.length,
    start_offset: startOffset,
    end_offset: startOffset + records.length - 1,
  };
}

export async function readPersistedReviewChunk(
  exportId: string,
  chunkIndex: number,
): Promise<PersistedReviewRecord[]> {
  const chunkText = await readFile(getChunkPath(exportId, chunkIndex), "utf8");
  return parseChunkRecords(chunkText);
}

export async function readReviewChunk(
  exportId: string,
  chunkIndex: number,
): Promise<StoredReviewRecord[]> {
  const records = await readPersistedReviewChunk(exportId, chunkIndex);
  return records.map(({ review_key: _reviewKey, ...review }) => review);
}

export async function savePendingReviewBuffer(
  exportId: string,
  records: PersistedReviewRecord[],
): Promise<void> {
  const exportDir = getExportDir(exportId);
  await mkdir(exportDir, { recursive: true });

  const pendingChunkPath = getPendingChunkPath(exportId);
  if (records.length === 0) {
    await rm(pendingChunkPath, { force: true });
    return;
  }

  await writeFile(pendingChunkPath, serializeChunkRecords(records), "utf8");
}

export async function readPendingReviewBuffer(
  exportId: string,
): Promise<PersistedReviewRecord[]> {
  try {
    const pendingChunkText = await readFile(getPendingChunkPath(exportId), "utf8");
    return parseChunkRecords(pendingChunkText);
  } catch {
    return [];
  }
}

export async function deleteReviewExport(exportId: string): Promise<void> {
  await rm(getExportDir(exportId), { recursive: true, force: true });
}

export async function exportExists(exportId: string): Promise<boolean> {
  try {
    await stat(getManifestPath(exportId));
    return true;
  } catch {
    return false;
  }
}

export async function markRunningExportsFailed(
  message = "Export was interrupted because the MCP server process restarted.",
): Promise<string[]> {
  try {
    await ensureExportRootExists();
  } catch {
    return [];
  }

  const updatedExportIds: string[] = [];
  const entries = await readdir(getExportRootDir(), { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const exportId = entry.name;
    try {
      const manifest = await loadExportManifest(exportId);
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
      await saveExportManifest(manifest);
      updatedExportIds.push(exportId);
    } catch {
      continue;
    }
  }

  return updatedExportIds;
}

export async function cleanupExpiredExports(
  excludedExportIds: Iterable<string> = [],
): Promise<string[]> {
  try {
    await ensureExportRootExists();
  } catch {
    return [];
  }

  const ttlMs = getExportTtlMs();
  const now = Date.now();
  const deletedExportIds: string[] = [];
  const excluded = new Set(excludedExportIds);
  const entries = await readdir(getExportRootDir(), { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const exportId = entry.name;
    if (excluded.has(exportId)) {
      continue;
    }

    try {
      const manifest = await loadExportManifest(exportId);
      const updatedAtMs = Date.parse(manifest.updated_at);

      if (!Number.isFinite(updatedAtMs) || now - updatedAtMs > ttlMs) {
        await deleteReviewExport(exportId);
        deletedExportIds.push(exportId);
      }
    } catch {
      await deleteReviewExport(exportId);
      deletedExportIds.push(exportId);
    }
  }

  return deletedExportIds;
}
