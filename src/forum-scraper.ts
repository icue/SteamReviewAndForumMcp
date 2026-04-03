import { fetchWithRetry, sleep } from "./http-utils.js";

const STEAM_COMMUNITY_BASE = "https://steamcommunity.com/";
const USER_AGENT = "steam-review-and-forum-mcp/1.0.0";
const DEFAULT_FORUM_MULTI_PAGE_DELAY_MS = 300;

interface ForumConfig {
  forum_display_name?: string;
  forum_url?: string;
  forum_search_url?: string;
  appid?: number;
  start?: number;
  total_count?: number;
  pagesize?: number;
}

interface CommentThreadConfig {
  total_count?: number;
  start?: number;
  pagesize?: number;
  comments_raw?: Record<
    string,
    {
      text?: string;
      author?: string;
    }
  >;
}

interface TopicDetailsConfig {
  author?: string;
  text?: string;
}

interface SteamAnnouncementBody {
  gid?: string;
  headline?: string;
  posttime?: number;
  updatetime?: number;
  body?: string;
  forum_topic_id?: string;
  event_gid?: string;
  tags?: string[];
}

export const STEAM_FORUM_KEYS = [
  "discussions",
  "eventcomments",
  "tradingforum",
] as const;

export type SteamForumKey = (typeof STEAM_FORUM_KEYS)[number];

export interface SteamForumTopicSummary {
  topic_id: string;
  url: string;
  title: string;
  author: string | null;
  preview: string | null;
  reply_count: number;
  last_post_timestamp: number | null;
  last_post_display: string | null;
  unread: boolean;
}

export interface SteamForumComment {
  comment_id: string;
  author: string | null;
  author_profile_url: string | null;
  timestamp: number | null;
  permalink: string | null;
  content: string;
  is_developer: boolean;
  page: number;
}

export interface SteamForumTopicDetails {
  topic_id: string;
  topic_url: string;
  title: string;
  author: string | null;
  author_profile_url: string | null;
  timestamp: number | null;
  content: string;
  source_type?: "forum_topic" | "announcement_detail";
  source_url?: string | null;
}

export interface SteamForumSectionSummary {
  forum_key: SteamForumKey;
  section_id: number | null;
  name: string;
  url: string;
  topic_count: number | null;
  is_default: boolean;
}

export interface SteamForumTopicListResult {
  appid: string;
  forum_key: SteamForumKey;
  forum_section_id: number | null;
  forum_name: string | null;
  forum_url: string;
  forum_search_url: string | null;
  page: number;
  pagesize: number;
  total_topics: number;
  total_pages: number;
  next_page_url: string | null;
  previous_page_url: string | null;
  topics: SteamForumTopicSummary[];
}

export interface SteamForumTopicResult {
  appid: string | null;
  forum_url: string | null;
  topic: SteamForumTopicDetails;
  request: {
    topic_url: string;
    page: number;
    fetch_all_pages: boolean;
  };
  comments: {
    total_count: number;
    pagesize: number;
    total_pages: number;
    pages_fetched: number;
    current_page: number;
    items: SteamForumComment[];
  };
}

function decodeHtmlEntities(text: string): string {
  const namedEntities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": "\"",
    "&#39;": "'",
    "&nbsp;": " ",
  };

  let decoded = text.replace(
    /&(amp|lt|gt|quot|#39|nbsp);/g,
    (match) => namedEntities[match] ?? match,
  );

  decoded = decoded.replace(/&#(\d+);/g, (_match, value: string) =>
    String.fromCodePoint(Number(value)),
  );

  decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (_match, value: string) =>
    String.fromCodePoint(parseInt(value, 16)),
  );

  return decoded;
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanForumHtml(html: string): string {
  const withLinks = html.replace(
    /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, text: string) => `${text} (${href})`,
  );

  const cleanText = withLinks
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/li>|<\/blockquote>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<blockquote[^>]*>/gi, "\n> ")
    .replace(/<\/?[^>]+(>|$)/g, "");

  return normalizeWhitespace(decodeHtmlEntities(cleanText));
}

function cleanForumBbCode(text: string): string {
  const withLinks = text
    .replace(
      /\[dynamiclink\s+href=(?:"([^"]+)"|([^\]]+))\]\s*\[\/dynamiclink\]/gi,
      (_match, quotedHref: string | undefined, bareHref: string | undefined) =>
        quotedHref ?? bareHref ?? "",
    )
    .replace(
      /\[url=(?:"([^"]+)"|([^\]]+))\]([\s\S]*?)\[\/url\]/gi,
      (
        _match,
        quotedHref: string | undefined,
        bareHref: string | undefined,
        label: string,
      ) => {
        const href = quotedHref ?? bareHref ?? "";
        const cleanedLabel = label
          .replace(/\[(?:\/)?u\]/gi, "")
          .trim();

        return cleanedLabel ? `${cleanedLabel} (${href})` : href;
      },
    )
    .replace(
      /\[img(?:\s+src=(?:"([^"]+)"|([^\]]+)))?\](?:[\s\S]*?)\[\/img\]/gi,
      "",
    );

  const normalized = withLinks
    .replace(/\[p\]/gi, "")
    .replace(/\[\/p\]/gi, "\n\n")
    .replace(/\[h[1-6]\]/gi, "\n\n")
    .replace(/\[\/h[1-6]\]/gi, "\n\n")
    .replace(/\[list\]/gi, "\n")
    .replace(/\[\/list\]/gi, "\n")
    .replace(/\[\*\]/g, "\n- ")
    .replace(/\[\/\*\]/g, "")
    .replace(/\[(?:\/)?(?:b|i|u)\]/gi, "")
    .replace(/\[(?:\/)?quote(?:=[^\]]+)?\]/gi, "")
    .replace(/\[[^\]]+\]/g, "");

  return normalizeWhitespace(normalized);
}

function extractJsonObjectAfter(
  text: string,
  marker: string,
  occurrence = 1,
): string | null {
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  let searchIndex = markerIndex;

  for (let currentOccurrence = 1; currentOccurrence <= occurrence; currentOccurrence += 1) {
    const objectStart = text.indexOf("{", searchIndex);
    if (objectStart === -1) {
      return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = objectStart; index < text.length; index += 1) {
      const character = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }

        if (character === "\\") {
          escaped = true;
          continue;
        }

        if (character === "\"") {
          inString = false;
        }

        continue;
      }

      if (character === "\"") {
        inString = true;
        continue;
      }

      if (character === "{") {
        depth += 1;
        continue;
      }

      if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          if (currentOccurrence === occurrence) {
            return text.slice(objectStart, index + 1);
          }

          searchIndex = index + 1;
          break;
        }
      }
    }
  }

  return null;
}

function parseJsonObjectAfter<T>(
  text: string,
  marker: string,
  occurrence = 1,
): T | null {
  const jsonText = extractJsonObjectAfter(text, marker, occurrence);
  if (!jsonText) {
    return null;
  }

  try {
    return JSON.parse(jsonText) as T;
  } catch {
    return null;
  }
}

function parseAnnouncementBodiesFromHtml(
  html: string,
): SteamAnnouncementBody[] {
  const announcementMarker = "&quot;announcement_body&quot;:";
  const announcementBodies: SteamAnnouncementBody[] = [];
  let searchIndex = 0;

  while (searchIndex < html.length) {
    const markerIndex = html.indexOf(announcementMarker, searchIndex);
    if (markerIndex === -1) {
      break;
    }

    const decodedSlice = decodeHtmlEntities(html.slice(markerIndex));
    const announcementBody = parseJsonObjectAfter<SteamAnnouncementBody>(
      decodedSlice,
      "\"announcement_body\":",
    );

    if (announcementBody) {
      announcementBodies.push(announcementBody);
    }

    searchIndex = markerIndex + announcementMarker.length;
  }

  return announcementBodies;
}

function extractAnnouncementDetailUrl(text: string): string | null {
  const match =
    /(https?:\/\/(?:steamcommunity\.com\/(?:ogg|games)\/\d+\/announcements\/detail\/\d+|store\.steampowered\.com\/news\/app\/\d+\/view\/\d+))/i.exec(
      text,
    );

  return match?.[1] ?? null;
}

function normalizeForumSectionId(sectionId: number): number {
  return sectionId <= 0 ? 0 : Math.floor(sectionId);
}

function getDefaultForumName(forumKey: SteamForumKey): string {
  switch (forumKey) {
    case "eventcomments":
      return "Events & Announcements";
    case "tradingforum":
      return "Trading";
    case "discussions":
    default:
      return "General Discussions";
  }
}

function buildForumDirectoryUrl(appid: string): URL {
  return new URL(`app/${appid}/discussions/`, STEAM_COMMUNITY_BASE);
}

function buildDiscussionSectionUrl(
  appid: string,
  sectionId: number,
  page: number,
): URL {
  const normalizedSectionId = normalizeForumSectionId(sectionId);
  const url = new URL(
    `app/${appid}/discussions/${normalizedSectionId}/`,
    STEAM_COMMUNITY_BASE,
  );

  if (page > 1) {
    url.searchParams.set("fp", page.toString());
  }

  return url;
}

function buildForumSurfaceUrl(
  appid: string,
  forumKey: SteamForumKey,
  sectionId: number,
  page: number,
): URL {
  const url =
    forumKey === "discussions"
      ? buildDiscussionSectionUrl(appid, sectionId, 1)
      : new URL(`app/${appid}/${forumKey}/`, STEAM_COMMUNITY_BASE);

  if (page > 1) {
    url.searchParams.set("fp", page.toString());
  } else {
    url.searchParams.delete("fp");
  }

  return url;
}

function buildTopicPageUrl(topicUrl: string, page: number): URL {
  const url = new URL(topicUrl);
  url.hash = "";

  if (page > 1) {
    url.searchParams.set("ctp", page.toString());
  } else {
    url.searchParams.delete("ctp");
  }

  return url;
}

function getForumMultiPageDelayMs(): number {
  const configuredDelayMs = Number(process.env.STEAM_FORUM_MULTI_PAGE_DELAY_MS);
  if (Number.isFinite(configuredDelayMs) && configuredDelayMs >= 0) {
    return Math.floor(configuredDelayMs);
  }

  return DEFAULT_FORUM_MULTI_PAGE_DELAY_MS;
}

export async function waitBeforeNextForumPageFetch(): Promise<void> {
  await sleep(getForumMultiPageDelayMs());
}

async function fetchCommunityHtml(url: URL | string): Promise<string> {
  const response = await fetchWithRetry(
    url,
    {
      headers: { "User-Agent": USER_AGENT },
    },
    "Failed to fetch Steam Community page",
  );

  return response.text();
}

function parseInteger(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/[^\d-]/g, "");
  if (!normalized) {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function extractAttribute(block: string, attributeName: string): string | null {
  const match = new RegExp(`${attributeName}="([^"]*)"`, "i").exec(block);
  return match?.[1] ?? null;
}

function extractText(block: string, pattern: RegExp): string | null {
  const match = pattern.exec(block);
  if (!match?.[1]) {
    return null;
  }

  return cleanForumHtml(match[1]);
}

function parseForumTopics(html: string): SteamForumTopicSummary[] {
  const topics: SteamForumTopicSummary[] = [];
  const topicBlockRegex =
    /<div[^>]+class="forum_topic\b[\s\S]*?<div style="clear: both;"><\/div>\s*<\/div>/gi;

  for (const match of html.matchAll(topicBlockRegex)) {
    const block = match[0];
    const topicId = extractAttribute(block, "data-gidforumtopic");
    const url = extractAttribute(block, "href");

    if (!topicId || !url) {
      continue;
    }

    const previewAttribute = extractAttribute(block, "data-tooltip-forum");
    const decodedPreview = previewAttribute
      ? decodeHtmlEntities(previewAttribute)
      : null;
    const previewMatch = decodedPreview
      ? /topic_hover_text">([\s\S]*?)<\/div>/i.exec(decodedPreview)
      : null;

    topics.push({
      topic_id: topicId,
      url,
      title:
        extractText(
          block,
          /<div class="forum_topic_name[^"]*">\s*(?:<a[^>]*>)?([\s\S]*?)(?:<\/a>)?\s*<\/div>/i,
        ) ?? "",
      author:
        extractText(block, /<div class="forum_topic_op">\s*([\s\S]*?)<\/div>/i) ??
        null,
      preview: previewMatch?.[1] ? cleanForumHtml(previewMatch[1]) : null,
      reply_count:
        parseInteger(
          /<div class="forum_topic_reply_count">[\s\S]*?(\d+)\s*<\/div>/i.exec(
            block,
          )?.[1],
        ) ?? 0,
      last_post_timestamp: parseInteger(extractAttribute(block, "data-timestamp")),
      last_post_display:
        extractText(
          block,
          /<div class="forum_topic_lastpost"[^>]*>\s*([\s\S]*?)<\/div>/i,
        ) ?? null,
      unread: /\bforum_topic\b[^"]*\bunread\b/i.test(block),
    });
  }

  return topics;
}

function normalizeForumSectionHref(href: string): string {
  return decodeHtmlEntities(href).replace(/&amp;/g, "&");
}

function parseForumKeyFromUrl(href: string, appid: string): SteamForumKey | null {
  const normalizedHref = normalizeForumSectionHref(href);

  if (
    new RegExp(
      `(?:https?:\\/\\/steamcommunity\\.com)?\\/app\\/${appid}\\/eventcomments\\/?(?:[?#][^"]*)?$`,
      "i",
    ).test(normalizedHref)
  ) {
    return "eventcomments";
  }

  if (
    new RegExp(
      `(?:https?:\\/\\/steamcommunity\\.com)?\\/app\\/${appid}\\/tradingforum\\/?(?:[?#][^"]*)?$`,
      "i",
    ).test(normalizedHref)
  ) {
    return "tradingforum";
  }

  if (
    new RegExp(
      `(?:https?:\\/\\/steamcommunity\\.com)?\\/app\\/${appid}\\/discussions(?:\\/\\d+)?\\/?(?:[?#][^"]*)?$`,
      "i",
    ).test(normalizedHref)
  ) {
    return "discussions";
  }

  return null;
}

function parseForumSectionIdFromUrl(href: string, appid: string): number | null {
  const normalizedHref = normalizeForumSectionHref(href);
  const match = new RegExp(
    `(?:https?:\\/\\/steamcommunity\\.com)?\\/app\\/${appid}\\/discussions\\/(\\d+)\\/?(?:[?#][^"]*)?$`,
    "i",
  ).exec(normalizedHref);

  if (!match) {
    return null;
  }

  return Number.parseInt(match[1], 10);
}

function buildAbsoluteSteamCommunityUrl(href: string): string {
  return new URL(normalizeForumSectionHref(href), STEAM_COMMUNITY_BASE).toString();
}

function parseForumSections(
  html: string,
  appid: string,
): SteamForumSectionSummary[] {
  const sections = new Map<string, SteamForumSectionSummary>();
  let fallbackRootSection: SteamForumSectionSummary | null = null;
  const sectionLinkRegex =
    /<a\b[^>]*href="([^"]*\/app\/\d+\/(?:discussions(?:\/\d+)?|eventcomments|tradingforum)\/?[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(sectionLinkRegex)) {
    const href = match[1];
    const normalizedHref = normalizeForumSectionHref(href);
    const forumKey = parseForumKeyFromUrl(href, appid);
    const name = cleanForumHtml(match[2]);

    if (!name || forumKey === null) {
      continue;
    }

    if (forumKey !== "discussions") {
      if (sections.has(forumKey)) {
        continue;
      }

      sections.set(forumKey, {
        forum_key: forumKey,
        section_id: null,
        name,
        url: buildAbsoluteSteamCommunityUrl(href),
        topic_count: null,
        is_default: false,
      });
      continue;
    }

    const sectionId = parseForumSectionIdFromUrl(href, appid);
    if (sectionId === null) {
      const isRootDiscussionsUrl = new RegExp(
        `(?:https?:\\/\\/steamcommunity\\.com)?\\/app\\/${appid}\\/discussions\\/?(?:[?#][^"]*)?$`,
        "i",
      ).test(normalizedHref);

      if (!isRootDiscussionsUrl || fallbackRootSection) {
        continue;
      }

      fallbackRootSection = {
        forum_key: "discussions",
        section_id: 0,
        name,
        url: buildForumSurfaceUrl(appid, "discussions", 0, 1).toString(),
        topic_count: null,
        is_default: true,
      };
      continue;
    }

    const sectionMapKey = `discussions:${sectionId}`;
    const existingSection = sections.get(sectionMapKey);
    if (existingSection) {
      continue;
    }

    sections.set(sectionMapKey, {
      forum_key: "discussions",
      section_id: sectionId,
      name,
      url: buildAbsoluteSteamCommunityUrl(href),
      topic_count: null,
      is_default: sectionId === 0,
    });
  }

  if (!sections.has("discussions:0") && fallbackRootSection) {
    sections.set("discussions:0", fallbackRootSection);
  }

  return Array.from(sections.values()).sort((left, right) => {
    if (left.forum_key === right.forum_key) {
      return (left.section_id ?? Number.MAX_SAFE_INTEGER) -
        (right.section_id ?? Number.MAX_SAFE_INTEGER);
    }

    if (left.forum_key === "discussions") {
      return -1;
    }

    if (right.forum_key === "discussions") {
      return 1;
    }

    return left.name.localeCompare(right.name);
  });
}

function parseForumConfig(html: string): ForumConfig | null {
  return parseJsonObjectAfter<ForumConfig>(html, "InitializeForum(");
}

function parseForumTopicConfig(html: string): ForumConfig | null {
  return parseJsonObjectAfter<ForumConfig>(html, "InitializeForumTopic(", 1);
}

function parseTopicThreadConfig(html: string): CommentThreadConfig | null {
  return parseJsonObjectAfter<CommentThreadConfig>(
    html,
    'InitializeCommentThread( "ForumTopic"',
  );
}

function parseTopicDetailsConfig(html: string): TopicDetailsConfig | null {
  return parseJsonObjectAfter<TopicDetailsConfig>(
    html,
    "InitializeForumTopic(",
    2,
  );
}

function extractOriginalPostBlock(html: string): string | null {
  const blockMatch =
    /<div[^>]+class="forum_op"[^>]*id="forum_op_[^"]+"[\s\S]*?<div data-featuretarget="community-awards"><\/div>/i.exec(
      html,
    );

  return blockMatch?.[0] ?? null;
}

function parseTopicOriginalPost(
  html: string,
  topicUrl: string,
): SteamForumTopicDetails {
  const originalPostBlock = extractOriginalPostBlock(html) ?? html;
  const title =
    extractText(
      originalPostBlock,
      /<div class="topic">\s*([\s\S]*?)<\/div>\s*<div class="content">/i,
    ) ??
    "";

  const content =
    extractText(
      originalPostBlock,
      /<div class="content">\s*([\s\S]*?)<\/div>\s*<\/div>\s*<div data-featuretarget="community-awards">/i,
    ) ??
    normalizeWhitespace(parseTopicDetailsConfig(html)?.text ?? "") ??
    "";

  const authorBlock =
    /<a class="hoverunderline forum_op_author[^"]*" href="([^"]+)"[\s\S]*?<span class="forum_author_action_pulldown"><\/span><\/a>/i.exec(
      originalPostBlock,
    );

  const authorNameMatch =
    /<a class="hoverunderline forum_op_author[^"]*"[\s\S]*?>\s*([\s\S]*?)<span class="forum_author_action_pulldown"><\/span><\/a>/i.exec(
      originalPostBlock,
    );

  const authorName = authorNameMatch?.[1]
    ? cleanForumHtml(authorNameMatch[1])
    : parseTopicDetailsConfig(html)?.author ?? null;

  const timestampMatch =
    /<span class="date"[^>]*data-timestamp="(\d+)"/i.exec(originalPostBlock);

  const topicId =
    new URL(topicUrl)
      .pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .at(-1)
      ?.match(/^\d+$/)?.[0] ?? "";

  return {
    topic_id: topicId,
    topic_url: buildTopicPageUrl(topicUrl, 1).toString(),
    title,
    author: authorName,
    author_profile_url: authorBlock?.[1] ?? null,
    timestamp: parseInteger(timestampMatch?.[1]),
    content,
    source_type: "forum_topic",
    source_url: null,
  };
}

async function hydrateTopicFromAnnouncementDetail(
  topic: SteamForumTopicDetails,
  topicUrl: string,
): Promise<SteamForumTopicDetails> {
  if (!/\/eventcomments\//i.test(topicUrl)) {
    return topic;
  }

  const announcementUrl = extractAnnouncementDetailUrl(topic.content);
  if (!announcementUrl) {
    return topic;
  }

  try {
    const announcementHtml = await fetchCommunityHtml(announcementUrl);
    const expectedAnnouncementId =
      /\/detail\/(\d+)/i.exec(announcementUrl)?.[1] ?? null;
    const announcementBody =
      parseAnnouncementBodiesFromHtml(announcementHtml).find(
        (candidate) =>
          (expectedAnnouncementId !== null &&
            candidate.gid === expectedAnnouncementId) ||
          candidate.forum_topic_id === topic.topic_id,
      ) ??
      null;
    if (!announcementBody?.body) {
      return {
        ...topic,
        source_type: "announcement_detail",
        source_url: announcementUrl,
      };
    }

    return {
      ...topic,
      title: announcementBody.headline?.trim() || topic.title,
      timestamp:
        typeof announcementBody.posttime === "number"
          ? announcementBody.posttime
          : topic.timestamp,
      content: cleanForumBbCode(announcementBody.body),
      source_type: "announcement_detail",
      source_url: announcementUrl,
    };
  } catch {
    return topic;
  }
}

function parseTopicCommentsFromHtml(
  html: string,
  page: number,
): SteamForumComment[] {
  const comments: SteamForumComment[] = [];
  const commentBlockRegex =
    /<div[^>]+class="commentthread_comment responsive_body_text[\s\S]*?<div class="forum_comment_permlink">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi;

  for (const match of html.matchAll(commentBlockRegex)) {
    const block = match[0];
    const commentId = /id="comment_(\d+)"/i.exec(block)?.[1];

    if (!commentId) {
      continue;
    }

    const authorMatch =
      /<a class="hoverunderline commentthread_author_link([^"]*)" href="([^"]+)"[\s\S]*?<bdi>([\s\S]*?)<span class="forum_author_action_pulldown"><\/span><\/bdi><\/a>/i.exec(
        block,
      );

    const text =
      extractText(
        block,
        /<div class="commentthread_comment_text"[^>]*>\s*([\s\S]*?)<\/div>/i,
      ) ?? "";

    const timestamp = parseInteger(
      /class="commentthread_comment_timestamp"[^>]*data-timestamp="(\d+)"/i.exec(
        block,
      )?.[1],
    );

    const permalinkMatch =
      /<a[^>]*href="(#c\d+)">#\d+<\/a>/i.exec(block);

    comments.push({
      comment_id: commentId,
      author: authorMatch?.[3] ? cleanForumHtml(authorMatch[3]) : null,
      author_profile_url: authorMatch?.[2] ?? null,
      timestamp,
      permalink: permalinkMatch?.[1] ?? null,
      content: text,
      is_developer: /commentthread_author_developer/i.test(authorMatch?.[1] ?? ""),
      page,
    });
  }

  return comments;
}

function fallbackCommentsFromConfig(
  config: CommentThreadConfig | null,
  page: number,
): SteamForumComment[] {
  if (!config?.comments_raw) {
    return [];
  }

  return Object.entries(config.comments_raw).map(([commentId, comment]) => ({
    comment_id: commentId,
    author: comment.author ?? null,
    author_profile_url: null,
    timestamp: null,
    permalink: null,
    content: normalizeWhitespace(comment.text ?? ""),
    is_developer: false,
    page,
  }));
}

function mergeCommentSources(
  htmlComments: SteamForumComment[],
  configComments: SteamForumComment[],
  topicUrl: string,
): SteamForumComment[] {
  const mergedComments = new Map<string, SteamForumComment>();

  for (const comment of configComments) {
    mergedComments.set(comment.comment_id, {
      ...comment,
      permalink: `${buildTopicPageUrl(topicUrl, 1).toString()}#c${comment.comment_id}`,
    });
  }

  for (const comment of htmlComments) {
    const existingComment = mergedComments.get(comment.comment_id);
    mergedComments.set(comment.comment_id, {
      ...(existingComment ?? comment),
      ...comment,
      permalink:
        comment.permalink ??
        existingComment?.permalink ??
        `${buildTopicPageUrl(topicUrl, 1).toString()}#c${comment.comment_id}`,
    });
  }

  return Array.from(mergedComments.values());
}

async function fetchTopicPage(
  topicUrl: string,
  page: number,
): Promise<{
  html: string;
  comments: SteamForumComment[];
  threadConfig: CommentThreadConfig | null;
}> {
  const html = await fetchCommunityHtml(buildTopicPageUrl(topicUrl, page));
  const threadConfig = parseTopicThreadConfig(html);
  const htmlComments = parseTopicCommentsFromHtml(html, page);
  const configComments = fallbackCommentsFromConfig(threadConfig, page);

  return {
    html,
    comments: mergeCommentSources(htmlComments, configComments, topicUrl),
    threadConfig,
  };
}

export async function listSteamForumTopics(
  appid: string,
  sectionId: number,
  page: number,
  forumKey: SteamForumKey = "discussions",
): Promise<SteamForumTopicListResult> {
  const html = await fetchCommunityHtml(
    buildForumSurfaceUrl(appid, forumKey, sectionId, page),
  );
  const forumConfig = parseForumConfig(html);
  const pagesize = forumConfig?.pagesize ?? 15;
  const totalTopics = forumConfig?.total_count ?? parseForumTopics(html).length;
  const totalPages =
    totalTopics > 0 ? Math.ceil(totalTopics / pagesize) : 1;
  const normalizedSectionId =
    forumKey === "discussions" ? normalizeForumSectionId(sectionId) : null;
  const forumUrl = buildForumSurfaceUrl(
    appid,
    forumKey,
    normalizedSectionId ?? 0,
    1,
  ).toString();

  return {
    appid,
    forum_key: forumKey,
    forum_section_id: normalizedSectionId,
    forum_name: forumConfig?.forum_display_name ?? getDefaultForumName(forumKey),
    forum_url: forumUrl,
    forum_search_url: forumConfig?.forum_search_url ?? null,
    page,
    pagesize,
    total_topics: totalTopics,
    total_pages: totalPages,
    next_page_url:
      page < totalPages
        ? buildForumSurfaceUrl(
            appid,
            forumKey,
            normalizedSectionId ?? 0,
            page + 1,
          ).toString()
        : null,
    previous_page_url:
      page > 1
        ? buildForumSurfaceUrl(
            appid,
            forumKey,
            normalizedSectionId ?? 0,
            page - 1,
          ).toString()
        : null,
    topics: parseForumTopics(html),
  };
}

export async function listSteamForumSections(
  appid: string,
): Promise<{
  appid: string;
  forum_url: string;
  sections: SteamForumSectionSummary[];
}> {
  const html = await fetchCommunityHtml(buildForumDirectoryUrl(appid));

  return {
    appid,
    forum_url: buildForumDirectoryUrl(appid).toString(),
    sections: parseForumSections(html, appid),
  };
}

export async function getSteamForumTopic(
  topicUrl: string,
  page: number,
  fetchAllPages: boolean,
): Promise<SteamForumTopicResult> {
  const firstPage = await fetchTopicPage(topicUrl, page);
  const originalPost = await hydrateTopicFromAnnouncementDetail(
    parseTopicOriginalPost(firstPage.html, topicUrl),
    topicUrl,
  );
  const threadConfig = firstPage.threadConfig;
  const pagesize = threadConfig?.pagesize ?? 15;
  const totalComments = threadConfig?.total_count ?? firstPage.comments.length;
  const totalPages = totalComments > 0 ? Math.ceil(totalComments / pagesize) : 1;
  const topicPages = fetchAllPages
    ? Array.from({ length: totalPages }, (_value, index) => index + 1)
    : [page];

  const comments: SteamForumComment[] = [];
  const seenCommentIds = new Set<string>();
  let pagesFetched = 0;
  let appid: string | null = null;
  let forumUrl: string | null = null;

  for (const topicPageNumber of topicPages) {
    if (fetchAllPages && topicPageNumber !== page) {
      await waitBeforeNextForumPageFetch();
    }

    const pageResult =
      topicPageNumber === page ? firstPage : await fetchTopicPage(topicUrl, topicPageNumber);
    pagesFetched += 1;

    if (appid === null) {
      appid =
        parseForumTopicConfig(pageResult.html)?.appid?.toString() ??
        /\/app\/(\d+)\//i.exec(pageResult.html)?.[1] ??
        null;
    }

    if (forumUrl === null) {
      forumUrl =
        parseForumTopicConfig(pageResult.html)?.forum_url ??
        null;
    }

    for (const comment of pageResult.comments) {
      if (seenCommentIds.has(comment.comment_id)) {
        continue;
      }

      seenCommentIds.add(comment.comment_id);
      comments.push({
        ...comment,
        permalink: comment.permalink
          ? `${buildTopicPageUrl(topicUrl, 1).toString()}${comment.permalink.replace(/^.*(#c\d+)$/, "$1")}`
          : `${buildTopicPageUrl(topicUrl, 1).toString()}#c${comment.comment_id}`,
      });
    }
  }

  return {
    appid,
    forum_url: forumUrl,
    topic: originalPost,
    request: {
      topic_url: buildTopicPageUrl(topicUrl, 1).toString(),
      page,
      fetch_all_pages: fetchAllPages,
    },
    comments: {
      total_count: totalComments,
      pagesize,
      total_pages: totalPages,
      pages_fetched: pagesFetched,
      current_page: page,
      items: comments,
    },
  };
}
