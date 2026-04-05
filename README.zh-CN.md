# Steam Review and Forum MCP

语言： [English](README.md) | 简体中文

这是一个用于探索 Steam 商店评测与社区讨论串的 MCP 服务器，核心是为了解答：

> 排除商店页面上的包装，玩家到底怎么看一款游戏？

你可以试着询问这些问题：

- “总结XXX这款Steam游戏近期差评里最主要的点。”
- “大家如何吐槽游戏的优化？这些问题普遍存在吗？”
- “对比发售期的差评和近期的好评，发生了什么变化？”
- “按月展示自发售以来的好评率。”
- “列出最近的官方公告，总结更新日志和玩家反馈。”
- “在写评测时已经游玩至少 10 小时的玩家里，有多少给了差评？”
- “游玩时长较长的差评玩家们主要在抱怨什么？”
- “对比中文评测与全语言评测，看看它们有什么差异。”
- “读取最近的论坛帖子，并判断手柄支持有没有问题。”
- “根据DLC页面的评测，这个游戏哪些DLC值得购买？”

## 核心特性

1. **服务端过滤与聚合**

   不需要一次把成千上万条评测都塞进模型上下文。服务端会先创建一个评测数据集，再在服务端完成大部分筛选工作。比如只查询提到 `"优化"` 或 `"崩溃"` 的评测，再按好评/差评、日期范围、语言或游玩时长来过滤，把聊天上下文留给真正有价值的信息。

2. **时间维度分析**

   支持做基于时间的分析，例如把发售初期的评测单独切出来，再和后期的评测对比，观察玩家关注点如何变化，或是按月/按周聚合，观察评测趋势。

3. **不只是原始评测文本，还保留元数据**

   借助 `timestamp_created`、`voted_up`、`author.playtime_at_review`、`author.playtime_forever` 这类元数据，你可以区分浅尝辄止就离开的玩家和真正长期游玩的玩家，也更容易判断哪些批评更有代表性。

4. **评测、论坛、官方公告可以放在同一条工作流里分析**

   同时查看一个游戏的 Steam 评测区、讨论区，以及社区公告。

## 快速开始

### 环境要求

- Node.js `22.19+`
- `npm`

### 安装与构建

```bash
npm install
npm run build
```

### 仅支持本地 `stdio` 传输

这是一个本地 `stdio` MCP 服务器，不是托管在公网的远程 MCP。因此没有 `https://.../mcp` 这样的地址可直接粘贴到远程连接器中。你的 MCP 客户端需要在本机启动 `node build/server.js`。

### Claude Desktop

Claude Desktop 现在更偏向通过本地 desktop extension 来安装本地 MCP。这个仓库目前提供的是原始本地服务，尚未打包成 `.mcpb` desktop extension，所以当前更直接的接入方式是 Claude Code、Cursor、Windsurf 或 MCP Inspector 等。

### Claude Code

```bash
claude mcp add steam-review-and-forum -- node <path-to-repo>/build/server.js
```

把 `<path-to-repo>` 替换成你本地仓库的绝对路径。

### Cursor

在仓库根目录创建 `.cursor/mcp.json`：

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

把下面内容加到 `~/.codeium/windsurf/mcp_config.json`：

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

### 其他支持 `stdio` 的 MCP 客户端

大多数本地 MCP 客户端都接受类似这样的配置：

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

把 `<path-to-repo>` 替换成你本地仓库的绝对路径。

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector node build/server.js
```

请在仓库根目录下运行。

### 手动运行服务

```bash
node build/server.js
```

大多数 MCP 客户端会自动帮你拉起这个进程，所以手动运行通常只在调试时才需要。

## 工具概览

注意：本 MCP 服务器开箱即用，日常使用时无需关心以下技术细节。

完整的 schema 见 [docs/TOOL_SCHEMAS.md](docs/TOOL_SCHEMAS.md)。

### 评测相关

- `get_steam_game_info`: 获取 Steam 商店元数据（英文）
- `get_steam_review`: 交互式拉取单页评测，或拉取一小个批次
- `create_steam_review_corpus`: 后台拉取并保存一个大型评测数据集
- `get_steam_review_corpus_status`: 查看已保存评测数据集的进度与元数据
- `query_steam_review_corpus`: 从已保存评测数据集中按日期、好/差评、语言、游玩时长、文本内容和排序规则筛选评测
- `aggregate_steam_review_corpus`: 对已保存评测数据集做服务端计数、趋势、平均游玩时长和语言分布聚合

### 论坛相关

- `list_steam_forum_sections`: 列出社区讨论分区
- `list_steam_forum_topics`: 列出某个分区下的主题
- `get_steam_forum_topic`: 获取一个主题及其回复
- `create_steam_forum_topic_corpus`: 在后台拉取并保存一个较长的多页讨论串
- `get_steam_forum_topic_corpus_status`: 查看已保存讨论串数据集的进度与元数据
- `read_steam_forum_topic_corpus_chunk`: 读取已保存讨论串中的某个回复分块

## 运行说明

- 已保存的评测数据集默认存放在 `.steam-review-exports/`。
- 已保存的讨论串数据集默认存放在 `.steam-forum-exports/`。
- 这些数据集默认会在 `24` 小时后自动清理。
- 评测和论坛抓取会对瞬时失败以及 `429` 响应做带 backoff 的重试。
- 如果进程在抓取过程中重启，后续的状态查询或分块读取会自动尝试恢复可续传的任务。

## 环境变量

只有在你需要调整存储或抓取行为时，才需要使用这些变量：

- `STEAM_REVIEW_EXPORT_DIR`
- `STEAM_FORUM_EXPORT_DIR`
- `STEAM_REVIEW_EXPORT_TTL_HOURS`
- `STEAM_FORUM_EXPORT_TTL_HOURS`

## 许可证

本项目使用 BSD 3-Clause License。详见 [LICENSE](LICENSE)。
