# MCP Tool Schemas

These are the input schemas for the exposed MCP tools.

- Numeric fields accept numbers or numeric strings unless noted otherwise.
- `date_from` and `date_to` accept ISO 8601 or `YYYY-MM-DD`.

## Shared Enums

```ts
type ReviewFilter = "recent" | "updated" | "all";
type ReviewType = "all" | "positive" | "negative";
type PurchaseType = "all" | "non_steam_purchase" | "steam";
type TraversalMode = "recent" | "updated";
type ReviewTimeField = "timestamp_created" | "timestamp_updated";
type ReviewSortField = "timestamp_created" | "timestamp_updated";
type SortDirection = "asc" | "desc";
type ReviewAggregationGrain = "none" | "day" | "week" | "month";
type ForumKey = "discussions" | "eventcomments" | "tradingforum";

type LanguageCode =
  | "all"
  | "arabic"
  | "bulgarian"
  | "schinese"
  | "tchinese"
  | "czech"
  | "danish"
  | "dutch"
  | "english"
  | "finnish"
  | "french"
  | "german"
  | "greek"
  | "hungarian"
  | "indonesian"
  | "italian"
  | "japanese"
  | "koreana"
  | "norwegian"
  | "polish"
  | "portuguese"
  | "brazilian"
  | "romanian"
  | "russian"
  | "spanish"
  | "latam"
  | "swedish"
  | "thai"
  | "turkish"
  | "ukrainian"
  | "vietnamese";

type ReviewCorpusField =
  | "recommendationid"
  | "language"
  | "review"
  | "timestamp_created"
  | "timestamp_updated"
  | "voted_up"
  | "votes_up"
  | "votes_funny"
  | "weighted_vote_score"
  | "comment_count"
  | "steam_purchase"
  | "received_for_free"
  | "written_during_early_access"
  | "developer_response"
  | "timestamp_dev_responded"
  | "primarily_steam_deck"
  | "author"
  | "author.steamid"
  | "author.num_games_owned"
  | "author.num_reviews"
  | "author.playtime_forever"
  | "author.playtime_last_two_weeks"
  | "author.playtime_at_review"
  | "author.deck_playtime_at_review"
  | "author.last_played";
```

## `get_steam_review`

```ts
{
  appid: string;
  filter?: ReviewFilter; // default: "all"
  language?: LanguageCode; // default: "all"
  day_range?: number; // 1..365, default: 365
  cursor?: string; // default: "*"
  review_type?: ReviewType; // default: "all"
  purchase_type?: PurchaseType; // default: "all"
  num_per_page?: number; // 1..100, default: 100
  filter_offtopic_activity?: 0; // default: 0
  fetch_all?: boolean; // default: false
  max_reviews?: number;
  include_review_metadata?: boolean; // default: false
}
```

## `get_steam_game_info`

```ts
{
  appid: string;
}
```

## `list_steam_forum_sections`

```ts
{
  appid: string;
}
```

## `list_steam_forum_topics`

```ts
{
  appid: string;
  forum_key?: ForumKey; // default: "discussions"
  section_id?: number; // min: 0, default: 0
  page?: number; // min: 1, default: 1
}
```

## `get_steam_forum_topic`

```ts
{
  topic_url: string; // absolute Steam Community topic URL
  page?: number; // min: 1, default: 1
  fetch_all_pages?: boolean; // default: false
}
```

## `create_steam_forum_topic_corpus`

```ts
{
  topic_url: string; // absolute Steam Community topic URL
  chunk_size_comments?: number; // 1..1000, default: 250
  max_comments?: number | null; // default: null
}
```

## `get_steam_forum_topic_corpus_status`

```ts
{
  corpus_id: string;
}
```

## `read_steam_forum_topic_corpus_chunk`

```ts
{
  corpus_id: string;
  chunk_index: number; // min: 0
}
```

## `create_steam_review_corpus`

```ts
{
  appid: string;
  language?: LanguageCode; // default: "all"
  review_type?: ReviewType; // default: "all"
  purchase_type?: PurchaseType; // default: "all"
  include_offtopic_activity?: boolean; // default: true
  traversal_mode?: TraversalMode; // default: "recent"
  page_size?: number; // 1..100, default: 100
  chunk_size_reviews?: number; // 1..1000, default: 250
  include_review_metadata?: boolean; // default: true
  max_reviews?: number | null; // default: null
}
```

## `get_steam_review_corpus_status`

```ts
{
  corpus_id: string;
}
```

## `query_steam_review_corpus`

```ts
{
  corpus_id: string;
  date_field?: ReviewTimeField; // default: "timestamp_created"
  date_from?: string;
  date_to?: string;
  voted_up?: boolean;
  min_playtime_at_review?: number; // min: 0
  max_playtime_at_review?: number; // min: 0
  min_playtime_forever?: number; // min: 0
  max_playtime_forever?: number; // min: 0
  languages?: LanguageCode[];
  text_contains?: string;
  offset?: number; // min: 0, default: 0
  limit?: number; // 1..500, default: 50
  fields?: ReviewCorpusField[];
  sort_by?: ReviewSortField;
  sort_direction?: SortDirection; // default: "desc"
}
```

## `aggregate_steam_review_corpus`

```ts
{
  corpus_id: string;
  date_field?: ReviewTimeField; // default: "timestamp_created"
  date_from?: string;
  date_to?: string;
  voted_up?: boolean;
  min_playtime_at_review?: number; // min: 0
  max_playtime_at_review?: number; // min: 0
  min_playtime_forever?: number; // min: 0
  max_playtime_forever?: number; // min: 0
  languages?: LanguageCode[];
  text_contains?: string;
  group_by?: ReviewAggregationGrain; // default: "month"
}
```
