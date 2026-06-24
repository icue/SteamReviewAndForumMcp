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

### Use from npm

```bash
npx -y steam-review-and-forum-mcp
```

That command starts the MCP server over `stdio`. Most MCP clients will run it for you from their config, so you usually do not need to launch it manually.

### Storage

The server writes saved review and forum datasets to local disk. If `STEAM_REVIEW_EXPORT_DIR` and `STEAM_FORUM_EXPORT_DIR` are not set, the defaults are package-relative:

- `.steam-review-exports/`
- `.steam-forum-exports/`

When using `npx`, that means the npm/npx-installed package copy. When running from a source checkout, that means the checkout root. The package-relative default works, but for durable storage you should set explicit absolute paths in your MCP client config.

For JSON-based MCP configs, add `env`:

```json
{
  "mcpServers": {
    "steam-review-and-forum": {
      "command": "npx",
      "args": ["-y", "steam-review-and-forum-mcp"],
      "env": {
        "STEAM_REVIEW_EXPORT_DIR": "<absolute-path-to-review-exports>",
        "STEAM_FORUM_EXPORT_DIR": "<absolute-path-to-forum-exports>"
      }
    }
  }
}
```

For Codex `config.toml`, add an environment table:

```toml
[mcp_servers.steam-review-and-forum]
command = "npx"
args = ["-y", "steam-review-and-forum-mcp"]

[mcp_servers.steam-review-and-forum.env]
STEAM_REVIEW_EXPORT_DIR = "<absolute-path-to-review-exports>"
STEAM_FORUM_EXPORT_DIR = "<absolute-path-to-forum-exports>"
```

### Claude Desktop

Open Claude Desktop Settings > Developer > Edit Config, add this server to `claude_desktop_config.json`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "steam-review-and-forum": {
      "command": "npx",
      "args": ["-y", "steam-review-and-forum-mcp"]
    }
  }
}
```

### Codex CLI

```bash
codex mcp add steam-review-and-forum -- npx -y steam-review-and-forum-mcp
```

### Codex App

In the Codex app, open Settings > Integrations & MCP and add a custom server, or edit `~/.codex/config.toml`:

```toml
[mcp_servers.steam-review-and-forum]
command = "npx"
args = ["-y", "steam-review-and-forum-mcp"]
```

### Claude Code

```bash
claude mcp add steam-review-and-forum -- npx -y steam-review-and-forum-mcp
```

### Cursor

Create or update `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "steam-review-and-forum": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "steam-review-and-forum-mcp"]
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
      "command": "npx",
      "args": ["-y", "steam-review-and-forum-mcp"]
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
      "command": "npx",
      "args": ["-y", "steam-review-and-forum-mcp"]
    }
  }
}
```

### MCP Inspector

```bash
npx -y @modelcontextprotocol/inspector -- npx -y steam-review-and-forum-mcp
```

### Run the Server Manually

```bash
npx -y steam-review-and-forum-mcp
```

Most MCP clients will start the server for you, so manual launch is mainly useful for debugging.

### Development from Source

If you want to run a local checkout instead of the published npm package:

```bash
npm install
npm run build
node build/server.js
```

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

- Saved review datasets are stored in `STEAM_REVIEW_EXPORT_DIR` when set; otherwise they are stored in `.steam-review-exports/` next to the installed package.
- Saved forum thread datasets are stored in `STEAM_FORUM_EXPORT_DIR` when set; otherwise they are stored in `.steam-forum-exports/` next to the installed package.
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
