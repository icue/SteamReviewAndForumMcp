#!/usr/bin/env node

import {
  appendReviewChunk,
  cleanupExpiredExports,
  createInitialExportManifest,
  ensureExportRootExists,
  exportExists,
  loadExportManifest,
  markRunningExportsFailed,
  readPendingReviewBuffer,
  readPersistedReviewChunk,
  readReviewChunk,
  savePendingReviewBuffer,
  saveExportManifest,
  type PersistedReviewRecord,
  type ReviewExportManifest,
  type ReviewExportRequest,
  type StoredReviewRecord,
} from "./export-store.js";
import {
  createForumTopicExportResponse,
  getForumTopicExportStatusResponse,
  readForumTopicExportChunkResponse,
} from "./forum-topic-export.js";
import {
  cleanupExpiredForumTopicExports,
  ensureForumExportRootExists,
  markRunningForumTopicExportsFailed,
} from "./forum-topic-export-store.js";
import {
  STEAM_FORUM_KEYS,
  getSteamForumTopic,
  listSteamForumSections,
  listSteamForumTopics,
} from "./forum-scraper.js";
import { fetchWithRetry } from "./http-utils.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { z } from "zod";

const STEAM_API_BASE = "https://store.steampowered.com/";
const USER_AGENT = "steam-review-and-forum-mcp/1.0.0";

const REVIEW_FILTERS = ["recent", "updated", "all"] as const;
const EXPORT_TRAVERSAL_MODES = ["recent", "updated"] as const;
const REVIEW_TYPES = ["all", "positive", "negative"] as const;
const PURCHASE_TYPES = ["all", "non_steam_purchase", "steam"] as const;
const REVIEW_CORPUS_FIELDS = [
  "recommendationid",
  "language",
  "review",
  "timestamp_created",
  "timestamp_updated",
  "voted_up",
  "votes_up",
  "votes_funny",
  "weighted_vote_score",
  "comment_count",
  "steam_purchase",
  "received_for_free",
  "written_during_early_access",
  "developer_response",
  "timestamp_dev_responded",
  "primarily_steam_deck",
  "author",
  "author.steamid",
  "author.num_games_owned",
  "author.num_reviews",
  "author.playtime_forever",
  "author.playtime_last_two_weeks",
  "author.playtime_at_review",
  "author.deck_playtime_at_review",
  "author.last_played",
] as const;
const REVIEW_TIME_FIELDS = ["timestamp_created", "timestamp_updated"] as const;
const REVIEW_QUERY_SORT_FIELDS = ["timestamp_created", "timestamp_updated"] as const;
const SORT_DIRECTIONS = ["asc", "desc"] as const;
const REVIEW_AGGREGATION_GRAINS = ["none", "day", "week", "month"] as const;
const LANGUAGE_CODES = [
  "all",
  "arabic",
  "bulgarian",
  "schinese",
  "tchinese",
  "czech",
  "danish",
  "dutch",
  "english",
  "finnish",
  "french",
  "german",
  "greek",
  "hungarian",
  "indonesian",
  "italian",
  "japanese",
  "koreana",
  "norwegian",
  "polish",
  "portuguese",
  "brazilian",
  "romanian",
  "russian",
  "spanish",
  "latam",
  "swedish",
  "thai",
  "turkish",
  "ukrainian",
  "vietnamese",
] as const;

function enableSystemCertificates(): void {
  try {
    const mergedCertificates = Array.from(
      new Set([
        ...getCACertificates("default"),
        ...getCACertificates("system"),
      ]),
    );

    if (mergedCertificates.length > 0) {
      setDefaultCACertificates(mergedCertificates);
    }
  } catch {
    // Ignore environments that do not expose OS certificate stores.
  }
}

enableSystemCertificates();

type ReviewFilter = (typeof REVIEW_FILTERS)[number];
type ExportTraversalMode = (typeof EXPORT_TRAVERSAL_MODES)[number];
type ReviewType = (typeof REVIEW_TYPES)[number];
type PurchaseType = (typeof PURCHASE_TYPES)[number];
type ReviewCorpusField = (typeof REVIEW_CORPUS_FIELDS)[number];
type ReviewTimeField = (typeof REVIEW_TIME_FIELDS)[number];
type ReviewQuerySortField = (typeof REVIEW_QUERY_SORT_FIELDS)[number];
type SortDirection = (typeof SORT_DIRECTIONS)[number];
type ReviewAggregationGrain = (typeof REVIEW_AGGREGATION_GRAINS)[number];
type LanguageCode = (typeof LANGUAGE_CODES)[number];
type PaginationStopReason =
  | "exhausted"
  | "max_reviews"
  | "repeated_cursor"
  | "missing_cursor";

interface SteamReviewAuthor {
  steamid?: string;
  num_games_owned?: number;
  num_reviews?: number;
  playtime_forever?: number;
  playtime_last_two_weeks?: number;
  playtime_at_review?: number;
  deck_playtime_at_review?: number;
  last_played?: number;
}

interface SteamReviewItem {
  recommendationid?: string;
  author?: SteamReviewAuthor;
  language?: string;
  review?: string;
  timestamp_created?: number;
  timestamp_updated?: number;
  voted_up?: boolean;
  votes_up?: number;
  votes_funny?: number;
  weighted_vote_score?: string;
  comment_count?: number;
  steam_purchase?: boolean;
  received_for_free?: boolean;
  written_during_early_access?: boolean;
  developer_response?: string;
  timestamp_dev_responded?: number;
  primarily_steam_deck?: boolean;
}

interface SteamQuerySummary {
  num_reviews?: number;
  review_score?: number;
  review_score_desc?: string;
  total_positive?: number;
  total_negative?: number;
  total_reviews?: number;
}

interface SteamReviewsResponse {
  success: number;
  query_summary?: SteamQuerySummary;
  cursor?: string;
  reviews?: SteamReviewItem[];
}

interface AppDetailsEntry {
  data?: {
    name?: string;
    detailed_description?: string;
    release_date?: {
      coming_soon?: boolean;
      date?: string;
    };
    developers?: string[];
    publishers?: string[];
    genres?: Array<{
      id?: string;
      description?: string;
    }>;
    price_overview?: {
      currency?: string;
      initial?: number;
      final?: number;
      discount_percent?: number;
      initial_formatted?: string;
      final_formatted?: string;
    };
  };
}

type AppDetailsResponse = Record<string, AppDetailsEntry>;

interface SteamReviewParams {
  appid: string;
  filter: ReviewFilter;
  language: LanguageCode;
  day_range: number;
  cursor: string;
  review_type: ReviewType;
  purchase_type: PurchaseType;
  num_per_page: number;
  filter_offtopic_activity?: 0;
  fetch_all: boolean;
  max_reviews?: number;
  include_review_metadata: boolean;
}

interface ReviewsRequestConfig {
  filter: ReviewFilter;
  language: LanguageCode;
  day_range: number;
  cursor: string;
  review_type: ReviewType;
  purchase_type: PurchaseType;
  num_per_page: number;
  filter_offtopic_activity?: 0;
}

interface ReviewCollectionResult {
  success: number;
  query_summary: SteamQuerySummary | null;
  reviews: string[];
  review_details?: StoredReviewRecord[];
  pagination: {
    fetch_all: boolean;
    requested_cursor: string;
    next_cursor: string | null;
    requested_filter: ReviewFilter;
    effective_filter: ReviewFilter;
    auto_switched_filter: boolean;
    page_size: number;
    pages_fetched: number;
    total_reviews_retrieved: number;
    max_reviews: number | null;
    stopped_reason: PaginationStopReason | "page_complete";
    duplicate_reviews_removed: number;
  };
}

interface GameInfoResult {
  appid: string;
  name: string | null;
  release_date_display: string | null;
  release_date_coming_soon: boolean | null;
  developers: string[];
  publishers: string[];
  genres: string[];
  price_overview: {
    currency: string | null;
    initial: number | null;
    final: number | null;
    discount_percent: number | null;
    initial_formatted: string | null;
    final_formatted: string | null;
  } | null;
  detailed_description: string | null;
}

interface SteamReviewExportParams {
  appid: string;
  language: LanguageCode;
  review_type: ReviewType;
  purchase_type: PurchaseType;
  include_offtopic_activity: boolean;
  traversal_mode: ExportTraversalMode;
  page_size: number;
  chunk_size_reviews: number;
  include_review_metadata: boolean;
  max_reviews: number | null;
}

interface ReviewCorpusQueryParams {
  corpus_id: string;
  date_field: ReviewTimeField;
  date_from?: string;
  date_to?: string;
  voted_up?: boolean;
  min_playtime_at_review?: number;
  max_playtime_at_review?: number;
  min_playtime_forever?: number;
  max_playtime_forever?: number;
  languages?: LanguageCode[];
  text_contains?: string;
  offset: number;
  limit: number;
  fields?: ReviewCorpusField[];
  sort_by?: ReviewQuerySortField;
  sort_direction: SortDirection;
}

interface ReviewCorpusAggregateParams {
  corpus_id: string;
  date_field: ReviewTimeField;
  date_from?: string;
  date_to?: string;
  voted_up?: boolean;
  min_playtime_at_review?: number;
  max_playtime_at_review?: number;
  min_playtime_forever?: number;
  max_playtime_forever?: number;
  languages?: LanguageCode[];
  text_contains?: string;
  group_by: ReviewAggregationGrain;
}

const activeReviewExportJobs = new Map<string, Promise<void>>();

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function normalizeLlmWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Helper function to clean and format review text for JSON
function cleanReviewText(text: string): string {
  if (!text) return "";

  const cleanText = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/p>|<\/div>|<\/li>/gi, "\n")
    .replace(/<\/?[^>]+(>|$)/g, "");

  return normalizeLlmWhitespace(decodeHtmlEntities(cleanText));
}

function cleanGameDescription(html: string | undefined): string | null {
  if (!html) return null;

  const cleanText = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<video\b[^>]*>[\s\S]*?<\/video>/gi, " ")
    .replace(/<(img|source)\b[^>]*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<h[1-6][^>]*>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/section>|<\/article>|<\/ul>|<\/ol>/gi, "\n\n")
    .replace(/<\/?[^>]+(>|$)/g, "");

  return normalizeLlmWhitespace(decodeHtmlEntities(cleanText));
}

function getReviewKey(review: SteamReviewItem): string {
  const recommendationId = review.recommendationid?.trim();
  if (recommendationId) {
    return recommendationId;
  }

  return [
    review.author?.steamid ?? "unknown",
    review.timestamp_created ?? "0",
    review.timestamp_updated ?? "0",
    cleanReviewText(review.review ?? ""),
  ].join(":");
}

function formatReviewMetadata(review: SteamReviewItem): StoredReviewRecord {
  return {
    recommendationid: review.recommendationid ?? null,
    language: review.language ?? null,
    review: cleanReviewText(review.review ?? ""),
    timestamp_created: review.timestamp_created ?? null,
    timestamp_updated: review.timestamp_updated ?? null,
    voted_up: review.voted_up ?? null,
    votes_up: review.votes_up ?? null,
    votes_funny: review.votes_funny ?? null,
    weighted_vote_score: review.weighted_vote_score ?? null,
    comment_count: review.comment_count ?? null,
    steam_purchase: review.steam_purchase ?? null,
    received_for_free: review.received_for_free ?? null,
    written_during_early_access: review.written_during_early_access ?? null,
    developer_response: review.developer_response
      ? cleanReviewText(review.developer_response)
      : null,
    timestamp_dev_responded: review.timestamp_dev_responded ?? null,
    primarily_steam_deck: review.primarily_steam_deck ?? null,
    author: {
      steamid: review.author?.steamid ?? null,
      num_games_owned: review.author?.num_games_owned ?? null,
      num_reviews: review.author?.num_reviews ?? null,
      playtime_forever: review.author?.playtime_forever ?? null,
      playtime_last_two_weeks: review.author?.playtime_last_two_weeks ?? null,
      playtime_at_review: review.author?.playtime_at_review ?? null,
      deck_playtime_at_review: review.author?.deck_playtime_at_review ?? null,
      last_played: review.author?.last_played ?? null,
    },
  };
}

function formatExportReviewRecord(
  review: SteamReviewItem,
  includeReviewMetadata: boolean,
): PersistedReviewRecord {
  const reviewText = cleanReviewText(review.review ?? "");

  if (!includeReviewMetadata) {
    return {
      review_key: getReviewKey(review),
      recommendationid: review.recommendationid ?? null,
      language: review.language ?? null,
      review: reviewText,
      timestamp_created: null,
      timestamp_updated: null,
      voted_up: null,
      votes_up: null,
      votes_funny: null,
      weighted_vote_score: null,
      comment_count: null,
      steam_purchase: null,
      received_for_free: null,
      written_during_early_access: null,
      developer_response: null,
      timestamp_dev_responded: null,
      primarily_steam_deck: null,
      author: null,
    };
  }

  return {
    review_key: getReviewKey(review),
    ...formatReviewMetadata(review),
  };
}

function buildReviewsUrl(
  appid: string,
  config: ReviewsRequestConfig,
): URL {
  const reviewsUrl = new URL(`appreviews/${appid}`, STEAM_API_BASE);
  reviewsUrl.searchParams.set("json", "1");
  reviewsUrl.searchParams.set("filter", config.filter);
  reviewsUrl.searchParams.set("language", config.language);
  reviewsUrl.searchParams.set("day_range", config.day_range.toString());
  reviewsUrl.searchParams.set("cursor", config.cursor);
  reviewsUrl.searchParams.set("review_type", config.review_type);
  reviewsUrl.searchParams.set("purchase_type", config.purchase_type);
  reviewsUrl.searchParams.set("num_per_page", config.num_per_page.toString());

  if (config.filter_offtopic_activity !== undefined) {
    reviewsUrl.searchParams.set(
      "filter_offtopic_activity",
      config.filter_offtopic_activity.toString(),
    );
  }

  return reviewsUrl;
}

async function fetchReviewPage(
  appid: string,
  config: ReviewsRequestConfig,
): Promise<SteamReviewsResponse> {
  const reviewsResponse = await fetchWithRetry(
    buildReviewsUrl(appid, config),
    {
      headers: { "User-Agent": USER_AGENT },
    },
    "Failed to fetch reviews",
  );

  return (await reviewsResponse.json()) as SteamReviewsResponse;
}

async function fetchGameInfo(appid: string): Promise<AppDetailsEntry["data"]> {
  const infoUrl = new URL("api/appdetails", STEAM_API_BASE);
  infoUrl.searchParams.set("appids", appid);
  infoUrl.searchParams.set("l", "english");

  const infoResponse = await fetchWithRetry(
    infoUrl,
    {
      headers: { "User-Agent": USER_AGENT },
    },
    "Failed to fetch game info",
  );

  const infoData = (await infoResponse.json()) as AppDetailsResponse;
  return infoData[appid]?.data;
}

async function fetchCleanGameInfo(appid: string): Promise<GameInfoResult> {
  const gameInfo = await fetchGameInfo(appid);

  return {
    appid,
    name: gameInfo?.name ?? null,
    release_date_display: gameInfo?.release_date?.date?.trim() || null,
    release_date_coming_soon:
      typeof gameInfo?.release_date?.coming_soon === "boolean"
        ? gameInfo.release_date.coming_soon
        : null,
    developers: Array.isArray(gameInfo?.developers)
      ? gameInfo.developers.filter((value): value is string => typeof value === "string")
      : [],
    publishers: Array.isArray(gameInfo?.publishers)
      ? gameInfo.publishers.filter((value): value is string => typeof value === "string")
      : [],
    genres: Array.isArray(gameInfo?.genres)
      ? gameInfo.genres
          .map((genre) => genre?.description?.trim() ?? "")
          .filter((genre) => genre.length > 0)
      : [],
    price_overview: gameInfo?.price_overview
      ? {
          currency: gameInfo.price_overview.currency ?? null,
          initial: gameInfo.price_overview.initial ?? null,
          final: gameInfo.price_overview.final ?? null,
          discount_percent: gameInfo.price_overview.discount_percent ?? null,
          initial_formatted: gameInfo.price_overview.initial_formatted ?? null,
          final_formatted: gameInfo.price_overview.final_formatted ?? null,
        }
      : null,
    detailed_description: cleanGameDescription(gameInfo?.detailed_description),
  };
}

function buildReviewPayload(
  reviews: SteamReviewItem[],
  includeReviewMetadata: boolean,
): Pick<ReviewCollectionResult, "reviews" | "review_details"> {
  return {
    reviews: reviews.map((review) => cleanReviewText(review.review ?? "")),
    ...(includeReviewMetadata
      ? {
          review_details: reviews.map((review) => formatReviewMetadata(review)),
        }
      : {}),
  };
}

async function fetchSingleReviewPage(
  params: SteamReviewParams,
  effectiveFilter: ReviewFilter,
): Promise<ReviewCollectionResult> {
  const page = await fetchReviewPage(params.appid, {
    filter: effectiveFilter,
    language: params.language,
    day_range: params.day_range,
    cursor: params.cursor,
    review_type: params.review_type,
    purchase_type: params.purchase_type,
    num_per_page: params.num_per_page,
    filter_offtopic_activity: params.filter_offtopic_activity,
  });

  const reviews = page.reviews ?? [];

  return {
    success: page.success,
    query_summary: page.query_summary ?? null,
    ...buildReviewPayload(reviews, params.include_review_metadata),
    pagination: {
      fetch_all: false,
      requested_cursor: params.cursor,
      next_cursor: page.cursor ?? null,
      requested_filter: params.filter,
      effective_filter: effectiveFilter,
      auto_switched_filter: effectiveFilter !== params.filter,
      page_size: params.num_per_page,
      pages_fetched: 1,
      total_reviews_retrieved: reviews.length,
      max_reviews: null,
      stopped_reason: "page_complete",
      duplicate_reviews_removed: 0,
    },
  };
}

async function fetchAllReviewPages(
  params: SteamReviewParams,
  effectiveFilter: ReviewFilter,
): Promise<ReviewCollectionResult> {
  const collectedReviews: SteamReviewItem[] = [];
  const seenReviewKeys = new Set<string>();
  const seenCursors = new Set<string>();

  let querySummary: SteamQuerySummary | null = null;
  let nextCursor = params.cursor;
  let pagesFetched = 0;
  let duplicateReviewsRemoved = 0;
  let stoppedReason: PaginationStopReason = "exhausted";
  let resumeCursor: string | null = null;

  while (true) {
    if (seenCursors.has(nextCursor)) {
      stoppedReason = "repeated_cursor";
      resumeCursor = nextCursor;
      break;
    }

    seenCursors.add(nextCursor);

    if (
      params.max_reviews !== undefined &&
      collectedReviews.length >= params.max_reviews
    ) {
      stoppedReason = "max_reviews";
      resumeCursor = nextCursor;
      break;
    }

    const remainingReviews =
      params.max_reviews !== undefined
        ? params.max_reviews - collectedReviews.length
        : params.num_per_page;

    const pageSize =
      params.max_reviews !== undefined
        ? Math.min(params.num_per_page, remainingReviews)
        : params.num_per_page;

    const page = await fetchReviewPage(params.appid, {
      filter: effectiveFilter,
      language: params.language,
      day_range: params.day_range,
      cursor: nextCursor,
      review_type: params.review_type,
      purchase_type: params.purchase_type,
      num_per_page: pageSize,
      filter_offtopic_activity: params.filter_offtopic_activity,
    });

    pagesFetched += 1;

    if (!querySummary && page.query_summary) {
      querySummary = page.query_summary;
    }

    const pageReviews = page.reviews ?? [];
    if (pageReviews.length === 0) {
      resumeCursor = null;
      stoppedReason = "exhausted";
      break;
    }

    for (const review of pageReviews) {
      const reviewKey = getReviewKey(review);
      if (seenReviewKeys.has(reviewKey)) {
        duplicateReviewsRemoved += 1;
        continue;
      }

      seenReviewKeys.add(reviewKey);
      collectedReviews.push(review);
    }

    const pageCursor = page.cursor ?? null;

    if (
      params.max_reviews !== undefined &&
      collectedReviews.length >= params.max_reviews
    ) {
      stoppedReason = "max_reviews";
      resumeCursor = pageCursor;
      break;
    }

    if (!pageCursor) {
      stoppedReason = "missing_cursor";
      resumeCursor = null;
      break;
    }

    nextCursor = pageCursor;
  }

  return {
    success: 1,
    query_summary: querySummary,
    ...buildReviewPayload(collectedReviews, params.include_review_metadata),
    pagination: {
      fetch_all: true,
      requested_cursor: params.cursor,
      next_cursor: resumeCursor,
      requested_filter: params.filter,
      effective_filter: effectiveFilter,
      auto_switched_filter: effectiveFilter !== params.filter,
      page_size: params.num_per_page,
      pages_fetched: pagesFetched,
      total_reviews_retrieved: collectedReviews.length,
      max_reviews: params.max_reviews ?? null,
      stopped_reason: stoppedReason,
      duplicate_reviews_removed: duplicateReviewsRemoved,
    },
  };
}

async function fetchReviewCollection(
  params: SteamReviewParams,
): Promise<ReviewCollectionResult> {
  const effectiveFilter =
    params.fetch_all && params.filter === "all" ? "recent" : params.filter;

  if (params.fetch_all) {
    return fetchAllReviewPages(params, effectiveFilter);
  }

  return fetchSingleReviewPage(params, effectiveFilter);
}

async function buildReviewToolResponse(
  params: SteamReviewParams,
): Promise<string> {
  const gameReviews = await fetchReviewCollection(params);

  const formattedJsonData = JSON.stringify(
    {
      request: {
        appid: params.appid,
        filter: params.filter,
        language: params.language,
        day_range: params.day_range,
        cursor: params.cursor,
        review_type: params.review_type,
        purchase_type: params.purchase_type,
        num_per_page: params.num_per_page,
        filter_offtopic_activity: params.filter_offtopic_activity ?? null,
        fetch_all: params.fetch_all,
        max_reviews: params.max_reviews ?? null,
        include_review_metadata: params.include_review_metadata,
      },
      game_reviews: gameReviews,
    },
    null,
    2,
  );

  return formattedJsonData;
}

async function buildGameInfoToolResponse(appid: string): Promise<string> {
  const gameInfo = await fetchCleanGameInfo(appid);

  return JSON.stringify(
    {
      game_info: gameInfo,
    },
    null,
    2,
  );
}

function buildExportRequest(
  params: SteamReviewExportParams,
): ReviewExportRequest {
  return {
    appid: params.appid,
    language: params.language,
    review_type: params.review_type,
    purchase_type: params.purchase_type,
    include_offtopic_activity: params.include_offtopic_activity,
    traversal_mode: params.traversal_mode,
    page_size: params.page_size,
    chunk_size_reviews: params.chunk_size_reviews,
    include_review_metadata: params.include_review_metadata,
    max_reviews: params.max_reviews,
  };
}

function buildExportSummary(manifest: ReviewExportManifest): Record<string, unknown> {
  return {
    corpus_id: manifest.export_id,
    status: manifest.status,
    appid: manifest.appid,
    game_name: manifest.game_name,
    request: manifest.request,
    progress: manifest.progress,
    chunk_count: manifest.chunks.length,
    chunks: manifest.chunks.map((chunk) => ({
      chunk_index: chunk.chunk_index,
      review_count: chunk.review_count,
      start_offset: chunk.start_offset,
      end_offset: chunk.end_offset,
    })),
    error: manifest.error,
  };
}

const TEXT_ONLY_CORPUS_FIELDS = new Set<ReviewCorpusField>([
  "recommendationid",
  "language",
  "review",
]);

type NormalizedReviewCorpusFilter = {
  date_field: ReviewTimeField;
  min_timestamp: number | null;
  max_timestamp: number | null;
  voted_up?: boolean;
  min_playtime_at_review: number | null;
  max_playtime_at_review: number | null;
  min_playtime_forever: number | null;
  max_playtime_forever: number | null;
  languages: Set<string> | null;
  text_contains: string | null;
};

type AggregateAccumulator = {
  review_count: number;
  positive_count: number;
  negative_count: number;
  sum_playtime_at_review: number;
  count_playtime_at_review: number;
  sum_playtime_forever: number;
  count_playtime_forever: number;
};

type LanguageAccumulator = {
  language: string;
  review_count: number;
  positive_count: number;
  negative_count: number;
};

function dedupeRequestedFields(
  fields?: ReviewCorpusField[],
): ReviewCorpusField[] | undefined {
  if (!fields || fields.length === 0) {
    return undefined;
  }

  return Array.from(new Set(fields));
}

function getReviewTimestamp(
  review: StoredReviewRecord,
  field: ReviewTimeField,
): number | null {
  return field === "timestamp_created"
    ? review.timestamp_created
    : review.timestamp_updated;
}

function getReviewNumericField(
  review: StoredReviewRecord,
  field: "playtime_at_review" | "playtime_forever",
): number | null {
  if (!review.author) {
    return null;
  }

  return field === "playtime_at_review"
    ? review.author.playtime_at_review
    : review.author.playtime_forever;
}

function parseDateBoundary(
  value: string,
  boundary: "start" | "end",
): number {
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    const timestampMs = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      boundary === "start" ? 0 : 23,
      boundary === "start" ? 0 : 59,
      boundary === "start" ? 0 : 59,
      boundary === "start" ? 0 : 999,
    );
    return Math.floor(timestampMs / 1000);
  }

  const timestampMs = Date.parse(value);
  if (Number.isNaN(timestampMs)) {
    throw new Error(
      `Invalid date value "${value}". Use ISO 8601 or YYYY-MM-DD.`,
    );
  }

  return Math.floor(timestampMs / 1000);
}

function buildReviewCorpusFilter(options: {
  date_field?: ReviewTimeField;
  date_from?: string;
  date_to?: string;
  voted_up?: boolean;
  min_playtime_at_review?: number;
  max_playtime_at_review?: number;
  min_playtime_forever?: number;
  max_playtime_forever?: number;
  languages?: LanguageCode[];
  text_contains?: string;
}): NormalizedReviewCorpusFilter {
  const normalizedLanguages =
    options.languages && options.languages.length > 0
      ? options.languages.includes("all")
        ? null
        : new Set(options.languages.map((language) => language.toLowerCase()))
      : null;
  const normalizedText = options.text_contains?.trim().toLowerCase() ?? "";
  if (
    options.min_playtime_at_review !== undefined &&
    options.max_playtime_at_review !== undefined &&
    options.min_playtime_at_review > options.max_playtime_at_review
  ) {
    throw new Error(
      "min_playtime_at_review cannot be greater than max_playtime_at_review.",
    );
  }

  if (
    options.min_playtime_forever !== undefined &&
    options.max_playtime_forever !== undefined &&
    options.min_playtime_forever > options.max_playtime_forever
  ) {
    throw new Error(
      "min_playtime_forever cannot be greater than max_playtime_forever.",
    );
  }

  return {
    date_field: options.date_field ?? "timestamp_created",
    min_timestamp: options.date_from
      ? parseDateBoundary(options.date_from, "start")
      : null,
    max_timestamp: options.date_to
      ? parseDateBoundary(options.date_to, "end")
      : null,
    voted_up: options.voted_up,
    min_playtime_at_review: options.min_playtime_at_review ?? null,
    max_playtime_at_review: options.max_playtime_at_review ?? null,
    min_playtime_forever: options.min_playtime_forever ?? null,
    max_playtime_forever: options.max_playtime_forever ?? null,
    languages: normalizedLanguages,
    text_contains: normalizedText.length > 0 ? normalizedText : null,
  };
}

function reviewMatchesCorpusFilter(
  review: StoredReviewRecord,
  filter: NormalizedReviewCorpusFilter,
): boolean {
  const timestamp = getReviewTimestamp(review, filter.date_field);

  if (filter.min_timestamp !== null) {
    if (timestamp === null || timestamp < filter.min_timestamp) {
      return false;
    }
  }

  if (filter.max_timestamp !== null) {
    if (timestamp === null || timestamp > filter.max_timestamp) {
      return false;
    }
  }

  if (filter.voted_up !== undefined && review.voted_up !== filter.voted_up) {
    return false;
  }

  const playtimeAtReview = getReviewNumericField(review, "playtime_at_review");
  if (filter.min_playtime_at_review !== null) {
    if (
      playtimeAtReview === null ||
      playtimeAtReview < filter.min_playtime_at_review
    ) {
      return false;
    }
  }

  if (filter.max_playtime_at_review !== null) {
    if (
      playtimeAtReview === null ||
      playtimeAtReview > filter.max_playtime_at_review
    ) {
      return false;
    }
  }

  const playtimeForever = getReviewNumericField(review, "playtime_forever");
  if (filter.min_playtime_forever !== null) {
    if (
      playtimeForever === null ||
      playtimeForever < filter.min_playtime_forever
    ) {
      return false;
    }
  }

  if (filter.max_playtime_forever !== null) {
    if (
      playtimeForever === null ||
      playtimeForever > filter.max_playtime_forever
    ) {
      return false;
    }
  }

  if (
    filter.languages &&
    !filter.languages.has((review.language ?? "unknown").toLowerCase())
  ) {
    return false;
  }

  if (
    filter.text_contains &&
    !review.review.toLowerCase().includes(filter.text_contains)
  ) {
    return false;
  }

  return true;
}

function metadataUnavailableWarning(
  manifest: ReviewExportManifest,
): string | null {
  if (manifest.request.include_review_metadata) {
    return null;
  }

  return "This corpus was created without review metadata. Timestamp, sentiment, vote, and playtime fields are unavailable in stored records.";
}

function queryRequiresMetadata(params: ReviewCorpusQueryParams): boolean {
  return (
    params.date_from !== undefined ||
    params.date_to !== undefined ||
    params.voted_up !== undefined ||
    params.min_playtime_at_review !== undefined ||
    params.max_playtime_at_review !== undefined ||
    params.min_playtime_forever !== undefined ||
    params.max_playtime_forever !== undefined ||
    params.sort_by !== undefined
  );
}

function createAggregateAccumulator(): AggregateAccumulator {
  return {
    review_count: 0,
    positive_count: 0,
    negative_count: 0,
    sum_playtime_at_review: 0,
    count_playtime_at_review: 0,
    sum_playtime_forever: 0,
    count_playtime_forever: 0,
  };
}

function updateAggregateAccumulator(
  accumulator: AggregateAccumulator,
  review: StoredReviewRecord,
): void {
  accumulator.review_count += 1;

  if (review.voted_up === true) {
    accumulator.positive_count += 1;
  } else if (review.voted_up === false) {
    accumulator.negative_count += 1;
  }

  const playtimeAtReview = review.author?.playtime_at_review;
  if (playtimeAtReview !== null && playtimeAtReview !== undefined) {
    accumulator.sum_playtime_at_review += playtimeAtReview;
    accumulator.count_playtime_at_review += 1;
  }

  const playtimeForever = review.author?.playtime_forever;
  if (playtimeForever !== null && playtimeForever !== undefined) {
    accumulator.sum_playtime_forever += playtimeForever;
    accumulator.count_playtime_forever += 1;
  }
}

function finalizeAggregateAccumulator(
  accumulator: AggregateAccumulator,
): Record<string, number | null> {
  return {
    review_count: accumulator.review_count,
    positive_count: accumulator.positive_count,
    negative_count: accumulator.negative_count,
    positive_ratio:
      accumulator.review_count > 0
        ? accumulator.positive_count / accumulator.review_count
        : null,
    avg_playtime_at_review:
      accumulator.count_playtime_at_review > 0
        ? accumulator.sum_playtime_at_review /
          accumulator.count_playtime_at_review
        : null,
    avg_playtime_forever:
      accumulator.count_playtime_forever > 0
        ? accumulator.sum_playtime_forever / accumulator.count_playtime_forever
        : null,
  };
}

function updateLanguageAccumulator(
  accumulator: Map<string, LanguageAccumulator>,
  review: StoredReviewRecord,
): void {
  const language = review.language ?? "unknown";
  const current =
    accumulator.get(language) ?? {
      language,
      review_count: 0,
      positive_count: 0,
      negative_count: 0,
    };

  current.review_count += 1;
  if (review.voted_up === true) {
    current.positive_count += 1;
  } else if (review.voted_up === false) {
    current.negative_count += 1;
  }

  accumulator.set(language, current);
}

function finalizeLanguageBreakdown(
  accumulator: Map<string, LanguageAccumulator>,
): Array<Record<string, number | string | null>> {
  return Array.from(accumulator.values())
    .sort((left, right) => right.review_count - left.review_count)
    .map((entry) => ({
      language: entry.language,
      review_count: entry.review_count,
      positive_count: entry.positive_count,
      negative_count: entry.negative_count,
      positive_ratio:
        entry.review_count > 0 ? entry.positive_count / entry.review_count : null,
    }));
}

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatBucketKey(
  timestamp: number,
  grain: Exclude<ReviewAggregationGrain, "none">,
): string {
  const date = new Date(timestamp * 1000);

  if (grain === "day") {
    return formatUtcDate(date);
  }

  if (grain === "month") {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  const weekDate = new Date(timestamp * 1000);
  const weekday = weekDate.getUTCDay() === 0 ? 7 : weekDate.getUTCDay();
  weekDate.setUTCDate(weekDate.getUTCDate() - weekday + 1);
  weekDate.setUTCHours(0, 0, 0, 0);
  return formatUtcDate(weekDate);
}

function timestampToIso(timestamp: number | null): string | null {
  if (timestamp === null) {
    return null;
  }

  return new Date(timestamp * 1000).toISOString();
}

function compareNullableNumbers(
  left: number | null,
  right: number | null,
  direction: SortDirection,
): number {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return direction === "asc" ? left - right : right - left;
}

function sortReviewsInPlace(
  reviews: StoredReviewRecord[],
  sortBy: ReviewQuerySortField,
  direction: SortDirection,
): void {
  reviews.sort((left, right) =>
    compareNullableNumbers(
      getReviewTimestamp(left, sortBy),
      getReviewTimestamp(right, sortBy),
      direction,
    ),
  );
}

function projectReviewRecord(
  review: StoredReviewRecord,
  fields?: ReviewCorpusField[],
): Record<string, unknown> | StoredReviewRecord {
  if (!fields || fields.length === 0) {
    return review;
  }

  const projected: Record<string, unknown> = {};

  for (const field of fields) {
    switch (field) {
      case "author":
        projected.author = review.author;
        break;
      case "author.steamid":
      case "author.num_games_owned":
      case "author.num_reviews":
      case "author.playtime_forever":
      case "author.playtime_last_two_weeks":
      case "author.playtime_at_review":
      case "author.deck_playtime_at_review":
      case "author.last_played": {
        const authorKey = field.slice("author.".length);
        const existingAuthor =
          projected.author &&
          typeof projected.author === "object" &&
          !Array.isArray(projected.author)
            ? (projected.author as Record<string, unknown>)
            : {};
        existingAuthor[authorKey] = review.author
          ? review.author[authorKey as keyof NonNullable<StoredReviewRecord["author"]>]
          : null;
        projected.author = existingAuthor;
        break;
      }
      default:
        projected[field] = review[field as keyof StoredReviewRecord];
        break;
    }
  }

  return projected;
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

async function loadSeenReviewKeys(
  manifest: ReviewExportManifest,
): Promise<Set<string>> {
  const seenReviewKeys = new Set<string>();

  for (const chunk of manifest.chunks) {
    const records = await readPersistedReviewChunk(
      manifest.export_id,
      chunk.chunk_index,
    );

    for (const record of records) {
      seenReviewKeys.add(record.review_key);
    }
  }

  return seenReviewKeys;
}

async function flushExportBuffer(
  manifest: ReviewExportManifest,
  buffer: PersistedReviewRecord[],
  chunkIndex: number,
): Promise<number> {
  if (buffer.length === 0) {
    return chunkIndex;
  }

  const chunkMeta = await appendReviewChunk(
    manifest.export_id,
    chunkIndex,
    manifest.progress.total_reviews_exported,
    buffer,
  );

  manifest.chunks.push(chunkMeta);
  manifest.progress.total_reviews_exported += buffer.length;
  buffer.length = 0;

  await savePendingReviewBuffer(manifest.export_id, buffer);
  await saveExportManifest(manifest);

  return chunkIndex + 1;
}

async function runReviewExport(
  manifest: ReviewExportManifest,
): Promise<ReviewExportManifest> {
  const seenReviewKeys = await loadSeenReviewKeys(manifest);
  const buffer = await readPendingReviewBuffer(manifest.export_id);
  for (const record of buffer) {
    seenReviewKeys.add(record.review_key);
  }
  let chunkIndex = manifest.chunks.length;
  let nextCursor = manifest.progress.next_cursor ?? "*";

  manifest.status = "running";
  manifest.error = null;
  manifest.completed_at = null;
  manifest.progress.stopped_reason = "in_progress";
  await saveExportManifest(manifest);

  try {
    if (manifest.game_name === null) {
      try {
        const gameInfo = await fetchGameInfo(manifest.appid);
        manifest.game_name = gameInfo?.name ?? null;
        await saveExportManifest(manifest);
      } catch {
        // Keep the export running even if the metadata lookup fails.
      }
    }

    while (true) {
      const totalBufferedReviews =
        manifest.progress.total_reviews_exported + buffer.length;

      if (
        manifest.request.max_reviews !== null &&
        totalBufferedReviews >= manifest.request.max_reviews
      ) {
        manifest.progress.stopped_reason = "max_reviews";
        break;
      }

      const remainingReviews =
        manifest.request.max_reviews !== null
          ? manifest.request.max_reviews - totalBufferedReviews
          : manifest.request.page_size;

      const pageSize = Math.min(manifest.request.page_size, remainingReviews);

      const currentCursor = nextCursor;
      const page = await fetchReviewPage(manifest.appid, {
        filter: manifest.request.traversal_mode as ReviewFilter,
        language: manifest.request.language as LanguageCode,
        day_range: 365,
        cursor: currentCursor,
        review_type: manifest.request.review_type as ReviewType,
        purchase_type: manifest.request.purchase_type as PurchaseType,
        num_per_page: pageSize,
        filter_offtopic_activity: manifest.request.include_offtopic_activity
          ? 0
          : undefined,
      });

      manifest.progress.pages_fetched += 1;

      if (
        manifest.progress.total_reviews_expected === null &&
        page.query_summary?.total_reviews !== undefined
      ) {
        manifest.progress.total_reviews_expected = page.query_summary.total_reviews;
      }

      const pageReviews = page.reviews ?? [];

      if (pageReviews.length === 0) {
        manifest.progress.next_cursor = null;
        manifest.progress.last_successful_cursor = currentCursor;
        manifest.progress.stopped_reason = "exhausted";
        break;
      }

      for (const review of pageReviews) {
        const reviewKey = getReviewKey(review);

        if (seenReviewKeys.has(reviewKey)) {
          manifest.progress.duplicate_reviews_removed += 1;
          continue;
        }

        seenReviewKeys.add(reviewKey);
        buffer.push(
          formatExportReviewRecord(
            review,
            manifest.request.include_review_metadata,
          ),
        );

        if (buffer.length >= manifest.request.chunk_size_reviews) {
          chunkIndex = await flushExportBuffer(manifest, buffer, chunkIndex);
        }
      }

      manifest.progress.last_successful_cursor = currentCursor;
      manifest.progress.next_cursor = page.cursor ?? null;

      if (!page.cursor) {
        manifest.progress.stopped_reason = "missing_cursor";
        break;
      }

      nextCursor = page.cursor;
      await savePendingReviewBuffer(manifest.export_id, buffer);
      await saveExportManifest(manifest);
    }

    chunkIndex = await flushExportBuffer(manifest, buffer, chunkIndex);
    void chunkIndex;

    manifest.status = "completed";
    manifest.completed_at = new Date().toISOString();
    manifest.error = null;
    await saveExportManifest(manifest);

    return manifest;
  } catch (error) {
    manifest.status = "failed";
    manifest.error = normalizeExportError(error);
    await savePendingReviewBuffer(manifest.export_id, buffer);
    await saveExportManifest(manifest);
    return manifest;
  }
}

async function cleanupReviewExports(): Promise<void> {
  await cleanupExpiredExports(activeReviewExportJobs.keys());
}

function scheduleReviewExport(manifest: ReviewExportManifest): void {
  if (activeReviewExportJobs.has(manifest.export_id)) {
    return;
  }

  const job = runReviewExport(manifest)
    .then(() => undefined)
    .catch((error) => {
      console.error(
        `Review export ${manifest.export_id} failed unexpectedly.`,
        error,
      );
    })
    .finally(() => {
      activeReviewExportJobs.delete(manifest.export_id);
    });

  activeReviewExportJobs.set(manifest.export_id, job);
}

async function buildCreateExportToolResponse(
  params: SteamReviewExportParams,
): Promise<string> {
  await ensureExportRootExists();
  await cleanupReviewExports();

  const manifest = createInitialExportManifest(
    params.appid,
    null,
    buildExportRequest(params),
  );

  await saveExportManifest(manifest);
  scheduleReviewExport(manifest);

  return JSON.stringify(buildExportSummary(manifest), null, 2);
}

async function ensureReviewExportIsRunning(
  exportId: string,
): Promise<ReviewExportManifest | null> {
  await cleanupReviewExports();

  if (!(await exportExists(exportId))) {
    return null;
  }

  const manifest = await loadExportManifest(exportId);

  if (activeReviewExportJobs.has(exportId)) {
    return manifest;
  }

  if (manifest.status === "completed") {
    return manifest;
  }

  if (manifest.progress.next_cursor === null) {
    return manifest;
  }

  manifest.status = "running";
  manifest.error = null;
  manifest.completed_at = null;
  manifest.progress.stopped_reason = "in_progress";
  await saveExportManifest(manifest);
  scheduleReviewExport(manifest);

  return manifest;
}

async function buildExportStatusToolResponse(exportId: string): Promise<string> {
  const manifest = await ensureReviewExportIsRunning(exportId);
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

  return JSON.stringify(buildExportSummary(manifest), null, 2);
}

async function buildQueryCorpusToolResponse(
  params: ReviewCorpusQueryParams,
): Promise<string> {
  const manifest = await ensureReviewExportIsRunning(params.corpus_id);
  if (!manifest) {
    return JSON.stringify(
      {
        corpus_id: params.corpus_id,
        status: "not_found",
      },
      null,
      2,
    );
  }

  if (!manifest.request.include_review_metadata && queryRequiresMetadata(params)) {
    return JSON.stringify(
      {
        corpus_id: params.corpus_id,
        status: manifest.status,
        error: {
          message:
            "This corpus was created without review metadata. Recreate it with include_review_metadata=true to filter or sort by timestamp, sentiment, or playtime.",
          code: "MISSING_REVIEW_METADATA",
        },
      },
      null,
      2,
    );
  }

  const filter = buildReviewCorpusFilter(params);
  const normalizedFields = dedupeRequestedFields(params.fields);
  const matchedReviews: StoredReviewRecord[] = [];
  let scannedReviewCount = 0;

  for (const chunk of manifest.chunks) {
    const reviews = await readReviewChunk(params.corpus_id, chunk.chunk_index);
    for (const review of reviews) {
      scannedReviewCount += 1;
      if (reviewMatchesCorpusFilter(review, filter)) {
        matchedReviews.push(review);
      }
    }
  }

  if (params.sort_by) {
    sortReviewsInPlace(matchedReviews, params.sort_by, params.sort_direction);
  }

  const totalMatchingReviews = matchedReviews.length;
  const safeOffset = Math.max(0, params.offset);
  const limitedReviews = matchedReviews.slice(
    safeOffset,
    safeOffset + params.limit,
  );
  const projectedReviews = limitedReviews.map((review) =>
    projectReviewRecord(review, normalizedFields),
  );
  const warning = metadataUnavailableWarning(manifest);

  return JSON.stringify(
    {
      corpus_id: params.corpus_id,
      status: manifest.status,
      corpus_complete: manifest.status === "completed",
      scanned_review_count: scannedReviewCount,
      total_matching_reviews: totalMatchingReviews,
      returned_review_count: projectedReviews.length,
      offset: safeOffset,
      limit: params.limit,
      has_more: safeOffset + projectedReviews.length < totalMatchingReviews,
      fields: normalizedFields ?? null,
      filters: {
        date_field: params.date_field,
        date_from: params.date_from ?? null,
        date_to: params.date_to ?? null,
        voted_up: params.voted_up ?? null,
        min_playtime_at_review: params.min_playtime_at_review ?? null,
        max_playtime_at_review: params.max_playtime_at_review ?? null,
        min_playtime_forever: params.min_playtime_forever ?? null,
        max_playtime_forever: params.max_playtime_forever ?? null,
        languages: params.languages ?? null,
        text_contains: params.text_contains ?? null,
      },
      sort: {
        by: params.sort_by ?? null,
        direction: params.sort_by ? params.sort_direction : null,
      },
      ...(warning ? { warning } : {}),
      reviews: projectedReviews,
    },
    null,
    2,
  );
}

async function buildAggregateCorpusToolResponse(
  params: ReviewCorpusAggregateParams,
): Promise<string> {
  const manifest = await ensureReviewExportIsRunning(params.corpus_id);
  if (!manifest) {
    return JSON.stringify(
      {
        corpus_id: params.corpus_id,
        status: "not_found",
      },
      null,
      2,
    );
  }

  if (!manifest.request.include_review_metadata) {
    return JSON.stringify(
      {
        corpus_id: params.corpus_id,
        status: manifest.status,
        error: {
          message:
            "This corpus was created without review metadata. Recreate it with include_review_metadata=true to aggregate by sentiment, timestamp, or playtime.",
          code: "MISSING_REVIEW_METADATA",
        },
      },
      null,
      2,
    );
  }

  const filter = buildReviewCorpusFilter(params);
  const overallAccumulator = createAggregateAccumulator();
  const languageAccumulator = new Map<string, LanguageAccumulator>();
  const bucketAccumulators = new Map<string, AggregateAccumulator>();
  let scannedReviewCount = 0;
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;
  let ungroupedReviewCount = 0;

  for (const chunk of manifest.chunks) {
    const reviews = await readReviewChunk(params.corpus_id, chunk.chunk_index);
    for (const review of reviews) {
      scannedReviewCount += 1;
      if (!reviewMatchesCorpusFilter(review, filter)) {
        continue;
      }

      updateAggregateAccumulator(overallAccumulator, review);
      updateLanguageAccumulator(languageAccumulator, review);

      const timestamp = getReviewTimestamp(review, params.date_field);
      if (timestamp !== null) {
        firstTimestamp =
          firstTimestamp === null ? timestamp : Math.min(firstTimestamp, timestamp);
        lastTimestamp =
          lastTimestamp === null ? timestamp : Math.max(lastTimestamp, timestamp);
      }

      if (params.group_by === "none") {
        continue;
      }

      if (timestamp === null) {
        ungroupedReviewCount += 1;
        continue;
      }

      const bucketKey = formatBucketKey(timestamp, params.group_by);
      const currentBucket =
        bucketAccumulators.get(bucketKey) ?? createAggregateAccumulator();
      updateAggregateAccumulator(currentBucket, review);
      bucketAccumulators.set(bucketKey, currentBucket);
    }
  }

  const buckets =
    params.group_by === "none"
      ? []
      : Array.from(bucketAccumulators.entries())
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([bucket, accumulator]) => ({
            bucket,
            ...finalizeAggregateAccumulator(accumulator),
          }));

  return JSON.stringify(
    {
      corpus_id: params.corpus_id,
      status: manifest.status,
      corpus_complete: manifest.status === "completed",
      scanned_review_count: scannedReviewCount,
      filters: {
        date_field: params.date_field,
        date_from: params.date_from ?? null,
        date_to: params.date_to ?? null,
        voted_up: params.voted_up ?? null,
        min_playtime_at_review: params.min_playtime_at_review ?? null,
        max_playtime_at_review: params.max_playtime_at_review ?? null,
        min_playtime_forever: params.min_playtime_forever ?? null,
        max_playtime_forever: params.max_playtime_forever ?? null,
        languages: params.languages ?? null,
        text_contains: params.text_contains ?? null,
      },
      overall: {
        ...finalizeAggregateAccumulator(overallAccumulator),
        first_review_at: timestampToIso(firstTimestamp),
        last_review_at: timestampToIso(lastTimestamp),
        language_breakdown: finalizeLanguageBreakdown(languageAccumulator),
      },
      grouping: {
        by: params.group_by,
        bucket_count: buckets.length,
        ungrouped_review_count: ungroupedReviewCount,
        buckets,
      },
    },
    null,
    2,
  );
}

async function buildForumTopicListToolResponse(
  appid: string,
  sectionId: number,
  page: number,
  forumKey: (typeof STEAM_FORUM_KEYS)[number],
): Promise<string> {
  const topics = await listSteamForumTopics(appid, sectionId, page, forumKey);

  return JSON.stringify(
    {
      forum_topics: topics,
    },
    null,
    2,
  );
}

async function buildForumSectionsToolResponse(appid: string): Promise<string> {
  const sections = await listSteamForumSections(appid);

  return JSON.stringify(
    {
      forum_sections: sections,
    },
    null,
    2,
  );
}

async function buildForumTopicToolResponse(
  topicUrl: string,
  page: number,
  fetchAllPages: boolean,
): Promise<string> {
  const topic = await getSteamForumTopic(topicUrl, page, fetchAllPages);

  return JSON.stringify(
    {
      forum_topic: topic,
    },
    null,
    2,
  );
}

// Create server instance
const server = new McpServer({
  name: "steam-review-and-forum-mcp",
  version: "1.0.0",
});

const NumberLikeInputSchema = z.union([z.number(), z.string().trim().min(1)]);

function coerceNumericStrings<TSchema extends z.ZodTypeAny>(schema: TSchema) {
  return NumberLikeInputSchema.pipe(z.coerce.number()).pipe(schema);
}

// Define the schema for the input parameters
const SteamReviewParamsSchema = {
  appid: z.string().describe("Steam application ID"),
  filter: z
    .enum(REVIEW_FILTERS)
    .default("all")
    .describe(
      'recent: sorted by creation time, updated: sorted by last updated time, all: sorted by helpfulness. Note that Steam\'s "all" filter does not naturally terminate when paging.',
    ),
  language: z
    .enum(LANGUAGE_CODES)
    .default("all")
    .describe(
      "Language filter (e.g. english, french, schinese). Default is all languages.",
    ),
  day_range: coerceNumericStrings(
    z.number().int().min(1).max(365),
  )
    .default(365)
    .describe(
      'Range from now to n days ago to look for helpful reviews. Only applicable for the "all" filter.',
    ),
  cursor: z
    .string()
    .default("*")
    .describe(
      'Cursor for paging. Pass "*" for the first page, then pass the returned next cursor for the next request.',
    ),
  review_type: z
    .enum(REVIEW_TYPES)
    .default("all")
    .describe(
      "all: all reviews, positive: only positive reviews, negative: only negative reviews",
    ),
  purchase_type: z
    .enum(PURCHASE_TYPES)
    .default("all")
    .describe(
      "all: all reviews, non_steam_purchase: users who did not pay on Steam, steam: paid on Steam",
    ),
  num_per_page: coerceNumericStrings(
    z.number().int().min(1).max(100),
  )
    .default(100)
    .describe("Number of reviews per page. Steam allows up to 100."),
  filter_offtopic_activity: coerceNumericStrings(
    z.literal(0),
  )
    .default(0)
    .describe(
      "Off-topic review activity is included by default. This parameter is set to 0 unless explicitly overridden in future versions.",
    ),
  fetch_all: z
    .boolean()
    .default(false)
    .describe(
      'When true, automatically follow cursors until all matching reviews are collected. If filter="all", the server automatically switches to filter="recent" because Steam\'s "all" filter does not terminate when paging.',
    ),
  max_reviews: coerceNumericStrings(
    z.number().int().positive(),
  )
    .optional()
    .describe(
      "Optional cap when fetch_all is true. Useful to avoid pulling very large review sets into the model context.",
    ),
  include_review_metadata: z
    .boolean()
    .default(false)
    .describe(
      "When true, return review_details in addition to the cleaned review text. review_details includes per-review metadata such as timestamp_created, timestamp_updated, timestamp_dev_responded, and author playtime fields like playtime_at_review and last_played.",
    ),
};

const SteamReviewExportParamsSchema = {
  appid: z.string().describe("Steam application ID"),
  language: z
    .enum(LANGUAGE_CODES)
    .default("all")
    .describe("Language filter for the corpus fetch. Defaults to all languages."),
  review_type: z
    .enum(REVIEW_TYPES)
    .default("all")
    .describe("Review polarity to retrieve. Defaults to all reviews."),
  purchase_type: z
    .enum(PURCHASE_TYPES)
    .default("all")
    .describe("Purchase source to retrieve. Defaults to all purchase types."),
  include_offtopic_activity: z
    .boolean()
    .default(true)
    .describe("When true, include off-topic/review-bomb activity in the corpus fetch."),
  traversal_mode: z
    .enum(EXPORT_TRAVERSAL_MODES)
    .default("recent")
    .describe(
      'Cursor traversal mode for exhaustive corpus retrieval. Use "recent" or "updated"; Steam\'s "all" helpfulness mode does not terminate reliably for full traversal.',
    ),
  page_size: coerceNumericStrings(
    z.number().int().min(1).max(100),
  )
    .default(100)
    .describe("Steam page size per fetch. Steam allows up to 100."),
  chunk_size_reviews: coerceNumericStrings(
    z.number().int().min(1).max(1000),
  )
    .default(250)
    .describe("How many reviews to store per persisted chunk."),
  include_review_metadata: z
    .boolean()
    .default(true)
    .describe(
      "When true, server-stored review chunks keep per-review metadata such as timestamp_created, timestamp_updated, timestamp_dev_responded, and author playtime fields like playtime_at_review and last_played, instead of only review text.",
    ),
  max_reviews: coerceNumericStrings(
    z.number().int().positive(),
  )
    .nullable()
    .default(null)
    .describe("Optional cap for the background fetch. Use null to retrieve the full corpus."),
};

const SteamReviewExportIdSchema = {
  corpus_id: z
    .string()
    .describe("Opaque identifier returned by the review corpus tools."),
};

const ReviewCorpusFieldSchema = z.enum(REVIEW_CORPUS_FIELDS);

const SteamReviewCorpusQuerySchema = {
  corpus_id: z
    .string()
    .describe("Opaque identifier returned by the review corpus tools."),
  date_field: z
    .enum(REVIEW_TIME_FIELDS)
    .default("timestamp_created")
    .describe("Which timestamp field to use for date filtering."),
  date_from: z
    .string()
    .optional()
    .describe("Inclusive start date filter. Use ISO 8601 or YYYY-MM-DD."),
  date_to: z
    .string()
    .optional()
    .describe("Inclusive end date filter. Use ISO 8601 or YYYY-MM-DD."),
  voted_up: z
    .boolean()
    .optional()
    .describe("Optional sentiment filter. true for positive reviews, false for negative reviews."),
  min_playtime_at_review: coerceNumericStrings(
    z.number().int().min(0),
  )
    .optional()
    .describe("Optional minimum author.playtime_at_review filter, in minutes."),
  max_playtime_at_review: coerceNumericStrings(
    z.number().int().min(0),
  )
    .optional()
    .describe("Optional maximum author.playtime_at_review filter, in minutes."),
  min_playtime_forever: coerceNumericStrings(
    z.number().int().min(0),
  )
    .optional()
    .describe("Optional minimum author.playtime_forever filter, in minutes."),
  max_playtime_forever: coerceNumericStrings(
    z.number().int().min(0),
  )
    .optional()
    .describe("Optional maximum author.playtime_forever filter, in minutes."),
  languages: z
    .array(z.enum(LANGUAGE_CODES))
    .optional()
    .describe(
      "Optional language filter. Omit or include 'all' to search across all languages.",
    ),
  text_contains: z
    .string()
    .optional()
    .describe("Optional case-insensitive substring match against cleaned review text."),
  offset: coerceNumericStrings(
    z.number().int().min(0),
  )
    .default(0)
    .describe("Zero-based offset within the filtered result set."),
  limit: coerceNumericStrings(
    z.number().int().positive().max(500),
  )
    .default(50)
    .describe("Maximum number of matching reviews to return."),
  fields: z
    .array(ReviewCorpusFieldSchema)
    .optional()
    .describe(
      "Optional field selection for returned reviews. Omit to return the full stored review records.",
    ),
  sort_by: z
    .enum(REVIEW_QUERY_SORT_FIELDS)
    .optional()
    .describe("Optional sort field for the filtered reviews."),
  sort_direction: z
    .enum(SORT_DIRECTIONS)
    .default("desc")
    .describe("Sort direction when sort_by is provided."),
};

const SteamReviewCorpusAggregateSchema = {
  corpus_id: z
    .string()
    .describe("Opaque identifier returned by the review corpus tools."),
  date_field: z
    .enum(REVIEW_TIME_FIELDS)
    .default("timestamp_created")
    .describe("Which timestamp field to use for date filtering and bucketing."),
  date_from: z
    .string()
    .optional()
    .describe("Inclusive start date filter. Use ISO 8601 or YYYY-MM-DD."),
  date_to: z
    .string()
    .optional()
    .describe("Inclusive end date filter. Use ISO 8601 or YYYY-MM-DD."),
  voted_up: z
    .boolean()
    .optional()
    .describe("Optional sentiment filter. true for positive reviews, false for negative reviews."),
  min_playtime_at_review: coerceNumericStrings(
    z.number().int().min(0),
  )
    .optional()
    .describe("Optional minimum author.playtime_at_review filter, in minutes."),
  max_playtime_at_review: coerceNumericStrings(
    z.number().int().min(0),
  )
    .optional()
    .describe("Optional maximum author.playtime_at_review filter, in minutes."),
  min_playtime_forever: coerceNumericStrings(
    z.number().int().min(0),
  )
    .optional()
    .describe("Optional minimum author.playtime_forever filter, in minutes."),
  max_playtime_forever: coerceNumericStrings(
    z.number().int().min(0),
  )
    .optional()
    .describe("Optional maximum author.playtime_forever filter, in minutes."),
  languages: z
    .array(z.enum(LANGUAGE_CODES))
    .optional()
    .describe(
      "Optional language filter. Omit or include 'all' to aggregate across all languages.",
    ),
  text_contains: z
    .string()
    .optional()
    .describe("Optional case-insensitive substring match against cleaned review text."),
  group_by: z
    .enum(REVIEW_AGGREGATION_GRAINS)
    .default("month")
    .describe("Aggregation grain for the returned trend buckets."),
};

const SteamForumTopicListParamsSchema = {
  appid: z.string().describe("Steam application ID"),
  forum_key: z
    .enum(STEAM_FORUM_KEYS)
    .default("discussions")
    .describe(
      "Forum surface to inspect. Use discussions for the normal boards, eventcomments for Events & Announcements, or tradingforum for Trading.",
    ),
  section_id: coerceNumericStrings(
    z.number().int().min(0),
  )
    .default(0)
    .describe(
      "Forum section id. Only used when forum_key is discussions. 0 maps to the main /discussions/0/ board; other sections use the numeric id from the section URL.",
    ),
  page: coerceNumericStrings(
    z.number().int().min(1),
  )
    .default(1)
    .describe("Forum listing page number. Steam uses ?fp=N for forum listing pages."),
};

const SteamForumTopicParamsSchema = {
  topic_url: z
    .string()
    .url()
    .describe(
      "Absolute Steam Community topic URL from a game's discussions board or compatible forum-like app hub surface such as Events & Announcements.",
    ),
  page: coerceNumericStrings(
    z.number().int().min(1),
  )
    .default(1)
    .describe("Reply page number for the topic. Steam uses ?ctp=N for multi-page topic replies."),
  fetch_all_pages: z
    .boolean()
    .default(false)
    .describe("When true, fetch all reply pages for the topic instead of only the requested page."),
};

const SteamForumTopicExportParamsSchema = {
  topic_url: z
    .string()
    .url()
    .describe(
      "Absolute Steam Community topic URL from a game's discussions board or compatible forum-like app hub surface such as Events & Announcements.",
    ),
  chunk_size_comments: coerceNumericStrings(
    z.number().int().min(1).max(1000),
  )
    .default(250)
    .describe("How many forum replies to store per persisted chunk."),
  max_comments: coerceNumericStrings(
    z.number().int().positive(),
  )
    .nullable()
    .default(null)
    .describe("Optional cap for the background fetch. Use null to retrieve the full thread."),
};

const SteamForumTopicExportIdSchema = {
  corpus_id: z
    .string()
    .describe("Opaque identifier returned by the forum topic corpus tools."),
};

const SteamForumTopicExportChunkSchema = {
  corpus_id: z
    .string()
    .describe("Opaque identifier returned by the forum topic corpus tools."),
  chunk_index: coerceNumericStrings(
    z.number().int().min(0),
  )
    .describe("Zero-based chunk index to read from the persisted server-side forum corpus."),
};

// Add the tool to get steam reviews
server.tool(
  "get_steam_review",
  "Retrieves Steam reviews for a specific app. Supports manual cursor pagination and automatic multi-page collection. Off-topic review activity is included by default. The response always includes a cleaned reviews text array, and can optionally include review_details with timestamps and playtime metadata when include_review_metadata is true.",
  SteamReviewParamsSchema,
  async (params) => {
    try {
      const formattedJsonData = await buildReviewToolResponse(params);

      return {
        content: [
          {
            type: "text",
            text: formattedJsonData,
          },
        ],
      };
    } catch (error) {
      console.error(error);
      throw error;
    }
  },
);

server.tool(
  "get_steam_game_info",
  "Retrieves English game metadata for a specific app, including release date, developers, publishers, genres, and price overview. The detailed description is cleaned into plain text for LLM consumption.",
  { appid: z.string().describe("Steam application ID") },
  async ({ appid }) => {
    try {
      const formattedJsonData = await buildGameInfoToolResponse(appid);

      return {
        content: [
          {
            type: "text",
            text: formattedJsonData,
          },
        ],
      };
    } catch (error) {
      console.error(error);
      throw error;
    }
  },
);

server.tool(
  "list_steam_forum_sections",
  "Lists the available public Steam Community discussion sections and forum-like app hub surfaces for a game's hub, including each section's numeric id when applicable and URL.",
  { appid: z.string().describe("Steam application ID") },
  async ({ appid }) => {
    try {
      const formattedJsonData = await buildForumSectionsToolResponse(appid);

      return {
        content: [
          {
            type: "text",
            text: formattedJsonData,
          },
        ],
      };
    } catch (error) {
      console.error(error);
      throw error;
    }
  },
);

server.tool(
  "list_steam_forum_topics",
  "Lists topics from a game's public Steam Community discussion section or compatible app hub forum surface. Supports section selection for discussions and listing pagination via ?fp=N. On some app hub surfaces such as Events & Announcements, Steam omits row-level author and preview markup, so those fields may be null in listing results.",
  SteamForumTopicListParamsSchema,
  async ({ appid, forum_key, section_id, page }) => {
    try {
      const formattedJsonData = await buildForumTopicListToolResponse(
        appid,
        section_id,
        page,
        forum_key,
      );

      return {
        content: [
          {
            type: "text",
            text: formattedJsonData,
          },
        ],
      };
    } catch (error) {
      console.error(error);
      throw error;
    }
  },
);

server.tool(
  "get_steam_forum_topic",
  "Fetches a public Steam Community topic, including the original post and replies. Supports General Discussions topics and compatible app hub forum surfaces such as Events & Announcements, with reply pagination via ?ctp=N. When an Events & Announcements thread only contains a stub that links to the real announcement article, the server follows that link and returns the announcement body as the topic content when possible.",
  SteamForumTopicParamsSchema,
  async ({ topic_url, page, fetch_all_pages }) => {
    try {
      const formattedJsonData = await buildForumTopicToolResponse(
        topic_url,
        page,
        fetch_all_pages,
      );

      return {
        content: [
          {
            type: "text",
            text: formattedJsonData,
          },
        ],
      };
    } catch (error) {
      console.error(error);
      throw error;
    }
  },
);

server.tool(
  "create_steam_forum_topic_corpus",
  "Starts a server-side background fetch for a public Steam Community topic, stores replies in server-managed chunks, and returns an opaque identifier immediately for later status checks and chunk reads. Supports discussion topics and compatible app hub forum surfaces. When an Events & Announcements thread only contains a stub that links to the real announcement article, the server follows that link and stores the announcement body as the topic content when possible. Data stays on the server and is not exported to the caller as files.",
  SteamForumTopicExportParamsSchema,
  async (params) => {
    try {
      const formattedJsonData = await createForumTopicExportResponse(params);

      return {
        content: [
          {
            type: "text",
            text: formattedJsonData,
          },
        ],
      };
    } catch (error) {
      console.error(error);
      throw error;
    }
  },
);

server.tool(
  "get_steam_forum_topic_corpus_status",
  "Returns the persisted manifest and progress summary for a server-side Steam Community topic fetch.",
  SteamForumTopicExportIdSchema,
  async ({ corpus_id }) => {
    try {
      const formattedJsonData = await getForumTopicExportStatusResponse(
        corpus_id,
      );

      return {
        content: [
          {
            type: "text",
            text: formattedJsonData,
          },
        ],
      };
    } catch (error) {
      console.error(error);
      throw error;
    }
  },
);

server.tool(
  "read_steam_forum_topic_corpus_chunk",
  "Reads one stored reply chunk from a previously created server-side Steam Community topic fetch.",
  SteamForumTopicExportChunkSchema,
  async ({ corpus_id, chunk_index }) => {
    try {
      const formattedJsonData = await readForumTopicExportChunkResponse(
        corpus_id,
        chunk_index,
      );

      return {
        content: [
          {
            type: "text",
            text: formattedJsonData,
          },
        ],
      };
    } catch (error) {
      console.error(error);
      throw error;
    }
  },
);

server.tool(
  "create_steam_review_corpus",
  "Starts a server-side background review fetch, stores results in a server-managed corpus, and returns an opaque identifier immediately for later status checks, server-side queries, and aggregates. Data stays on the server and is not exported to the caller as files. Stored review records keep per-review metadata such as timestamps and playtime fields by default.",
  SteamReviewExportParamsSchema,
  async (params) => {
    try {
      const formattedJsonData = await buildCreateExportToolResponse(params);

      return {
        content: [
          {
            type: "text",
            text: formattedJsonData,
          },
        ],
      };
    } catch (error) {
      console.error(error);
      throw error;
    }
  },
);

server.tool(
  "get_steam_review_corpus_status",
  "Returns the persisted manifest and progress summary for a server-side Steam review fetch.",
  SteamReviewExportIdSchema,
  async ({ corpus_id }) => {
    try {
      const formattedJsonData = await buildExportStatusToolResponse(corpus_id);

      return {
        content: [
          {
            type: "text",
            text: formattedJsonData,
          },
        ],
      };
    } catch (error) {
      console.error(error);
      throw error;
    }
  },
);

server.tool(
  "query_steam_review_corpus",
  "Queries a stored Steam review corpus with server-side filtering, pagination, and optional field selection. Use it to retrieve only the subset of reviews you actually need for analysis. Date, sentiment, and playtime threshold filters require a corpus created with review metadata enabled.",
  SteamReviewCorpusQuerySchema,
  async (params) => {
    try {
      const formattedJsonData = await buildQueryCorpusToolResponse(params);

      return {
        content: [
          {
            type: "text",
            text: formattedJsonData,
          },
        ],
      };
    } catch (error) {
      console.error(error);
      throw error;
    }
  },
);

server.tool(
  "aggregate_steam_review_corpus",
  "Aggregates a stored Steam review corpus server-side. Supports overall counts, positive versus negative review breakdowns, monthly or weekly trend buckets, average playtime, playtime-threshold filtered counts, and language breakdowns. Requires a corpus created with review metadata enabled.",
  SteamReviewCorpusAggregateSchema,
  async (params) => {
    try {
      const formattedJsonData = await buildAggregateCorpusToolResponse(params);

      return {
        content: [
          {
            type: "text",
            text: formattedJsonData,
          },
        ],
      };
    } catch (error) {
      console.error(error);
      throw error;
    }
  },
);

async function startServer(): Promise<void> {
  await ensureExportRootExists();
  await markRunningExportsFailed();
  await cleanupExpiredExports();

  await ensureForumExportRootExists();
  await markRunningForumTopicExportsFailed();
  await cleanupExpiredForumTopicExports();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

startServer().catch(console.error);
