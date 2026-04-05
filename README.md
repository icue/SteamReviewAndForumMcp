# Steam Review and Forum MCP

Languages: English | [简体中文](README.zh-CN.md)

MCP server for exploring Steam store reviews and community discussion threads, built for the question behind most Steam research:

> What do players actually think about this game once you get past the store page noise?

It can answer questions like:

- "Summarize the biggest complaints in recent negative reviews for Steam game XXX."
- "Query reviews that talks about performance, and tell me whether the issue sounds widespread."
- "Compare launch-period negative reviews with recent positive reviews. What changed?"
- "Show month-by-month sentiment since release."
- "List recent Events & Announcements threads, and summarize both the patch notes and player reaction."
- "How many negative reviews come from players with at least 10 hours at review time?"
- "What do long-playtime negative reviewers complain about?"
- "Compare English reviews with all-language reviews and tell me what differs."
- "Read recent forum threads and tell me whether controller support is broken."
- "Based on the reviews from the DLC pages, which DLCs of this game are worth buying?"

## Key Features

1. **Server-side filtering and aggregation**

   Instead of pulling thousands of reviews into the model at once, you can create a saved review dataset once and let the server do the heavy lifting. Query only the reviews that mention `"performance"` or `"crash"`, filter by sentiment, date range, language, or playtime, and keep chat context focused on the signal.

2. **Temporal precision**

   This MCP is good at time-based analysis. You can isolate launch-period noise, compare it against a later period, and see how player priorities shift over time. Monthly and weekly trend buckets make that easy to quantify. This is especially effective when the real question is not just "what are people saying?" but "what changed, when did it change, and which players are saying it?"

3. **Metadata context in addition to raw review text**

   With metadata like `timestamp_created`, `voted_up`, `author.playtime_at_review`, `author.playtime_forever`, it's possible to separate quick bounce-offs from long-term players and identify which complaints were genuinely influential.

4. **Reviews, forums, and official announcements in one workflow**

   The same server can inspect Steam reviews, public discussion sections, multi-page threads, and Events & Announcements.

## Quick Start

### Requirements

- Node.js `22.19+`
- `npm`

### Install and Build

```bash
npm install
npm run build
```

### Local Transport Only

This server runs locally over `stdio`. Unlike hosted MCP servers, there is no `https://.../mcp` endpoint to paste into a remote connector field. Your MCP client needs to launch `node build/server.js` on your machine.

### Claude Desktop

Claude Desktop now favors local desktop extensions for local MCP installs. This repo currently ships a raw local server, not a packaged `.mcpb` desktop extension, so the most direct options today are Claude Code, Cursor, Windsurf, or MCP Inspector.

### Claude Code

```bash
claude mcp add steam-review-and-forum -- node <path-to-repo>/build/server.js
```

Replace `<path-to-repo>` with the absolute path to your local checkout.

### Cursor

Create `.cursor/mcp.json` in this repo:

```json
{
  "mcpServers": {
    "steam-review-and-forum": {
      "type": "stdio",
      "command": "node",
      "args": ["<path-to-repo>/build/server.js"]
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "steam-review-and-forum": {
      "command": "node",
      "args": ["<path-to-repo>/build/server.js"]
    }
  }
}
```

### Other Stdio-Compatible MCP Clients

Most local MCP clients accept a config shaped like this:

```json
{
  "mcpServers": {
    "steam-review-and-forum": {
      "command": "node",
      "args": ["<path-to-repo>/build/server.js"]
    }
  }
}
```

Replace `<path-to-repo>` with the absolute path to your local checkout.

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector node build/server.js
```

Run that from the repo root.

### Run the Server Manually

```bash
node build/server.js
```

Most MCP clients will start the server for you, so manual launch is mainly useful for debugging.

## Tools at a Glance

Note that the mcp server should already work out of the box, and you don't need to know the technical details below to use it.

For the exact MCP tool input schemas, see [docs/TOOL_SCHEMAS.md](docs/TOOL_SCHEMAS.md).

### Reviews

- `get_steam_game_info`: cleaned Steam store metadata in English
- `get_steam_review`: interactive review fetch for one page or a small bounded batch
- `create_steam_review_corpus`: background fetch for a large review dataset you want to save on the server
- `get_steam_review_corpus_status`: progress and metadata for a saved review dataset
- `query_steam_review_corpus`: filtered review retrieval from a saved review dataset by date, sentiment, language, playtime, text, and sort order
- `aggregate_steam_review_corpus`: server-side counts, trends, playtime averages, and language breakdowns from a saved review dataset

### Forums

- `list_steam_forum_sections`: discover available discussion forum sections
- `list_steam_forum_topics`: list topics in a section
- `get_steam_forum_topic`: fetch a topic and its replies
- `create_steam_forum_topic_corpus`: background fetch for a long multi-page thread you want to save on the server
- `get_steam_forum_topic_corpus_status`: progress and metadata for a saved forum thread dataset
- `read_steam_forum_topic_corpus_chunk`: read one stored reply chunk from a saved long thread

## Operational Notes

- Saved review datasets are stored in `.steam-review-exports/` by default.
- Saved forum thread datasets are stored in `.steam-forum-exports/` by default.
- Stored exports are cleaned up automatically after `24` hours by default.
- Review and forum fetches retry transient failures and `429` responses with backoff.
- If the process restarts mid-fetch, later status or chunk reads can restart resumable jobs automatically.

## Environment Variables

Use these only if you need to tune storage or fetch behavior:

- `STEAM_REVIEW_EXPORT_DIR`
- `STEAM_FORUM_EXPORT_DIR`
- `STEAM_REVIEW_EXPORT_TTL_HOURS`
- `STEAM_FORUM_EXPORT_TTL_HOURS`

## License

This project is licensed under the BSD 3-Clause License. See [LICENSE](LICENSE).
