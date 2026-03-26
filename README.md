# TreeMemory

基于 **双树状结构** 的智能 AI 对话记忆系统。通过知识树存储结构化语义知识，时间树管理时间序列对话历史，实现高效的长期记忆召回与上下文管理。

## 核心特性

- **双树记忆架构**：知识树 + 时间树，分离存储语义知识与对话历史
- **活跃度衰减模型**：基于访问频率的智能记忆优先级管理
- **多阶段记忆召回**：在 token 预算内最优检索相关上下文
- **自动知识提取**：从对话中自动识别并存储事实信息
- **后台自动汇总**：定时压缩历史消息，生成层级摘要
- **OpenAI 兼容 API**：支持流式/非流式响应，可作为 LLM 代理使用
- **支持本地 LLM**：兼容 Ollama 等 OpenAI API 格式的服务

## 架构概览

### 双树记忆设计

```
┌─────────────────────────────────────────────────────────────────┐
│                         TreeMemory                              │
├─────────────────────────────┬───────────────────────────────────┤
│        知识树 (Knowledge)    │         时间树 (Temporal)          │
│                             │                                   │
│  Root                       │  day 2026-03-25 (level=2)        │
│  ├── 个人信息/              │  ├── hour 14:00 (level=1)        │
│  │   ├── 姓名: "小魏"       │  │   ├── [user] msg (level=0)    │
│  │   └── 邮箱: "..."        │  │   └── [assistant] msg         │
│  └── 工作/                  │  └── hour 15:00 (level=1)        │
│      └── 公司: "杭州智诺"    │      └── ...                     │
│                             │                                   │
│  · 路径格式: Root/工作/公司  │  · 三级层级: 叶节点→小时→天摘要    │
│  · 节点类型: category/fact  │  · 后台自动汇总旧消息              │
└─────────────────────────────┴───────────────────────────────────┘
```

### 活跃度衰减

```
effectiveScore = activityScore × (decayRate ^ daysSinceActivation)
```

频繁访问的知识保持高优先级，旧知识逐渐衰减但不删除。访问时同步提升节点及其祖先的活跃度。

### 记忆召回流程

在给定 token 预算内按优先级检索：
1. **知识召回** (~25%)：关键词搜索知识树
2. **最近消息**：获取未摘要的叶节点
3. **时间范围搜索**：识别"昨天"/"上周"等时间引用
4. **历史摘要**：高活跃度摘要填充剩余预算

## 快速开始

### 环境要求

- Node.js >= 18
- npm

### 安装

```bash
git clone <repository-url>
cd TreeMemory
npm install
```

### 配置

复制环境变量模板并配置：

```bash
cp .env.example .env
```

编辑 `.env` 文件，至少配置 LLM API 密钥：

```env
LLM_API_KEY=your-api-key-here
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o
```

### 运行

**CLI 模式**（交互式命令行）：

```bash
npm run dev:cli
```

**Server 模式**（HTTP API）：

```bash
npm run dev:server
```

## CLI 使用指南

启动 CLI 后，直接输入消息即可开始对话：

```
> 你好，我是小魏
[assistant] 你好小魏！很高兴认识你...

> /memory
Root
├── 个人信息
│   └── 姓名: "小魏"
```

### 可用命令

| 命令 | 说明 |
|------|------|
| `<消息>` | 发送消息对话 |
| `/new` | 开始新对话 |
| `/memory` | 显示整个知识树 |
| `/memory <关键词>` | 搜索知识树 |
| `/history` | 显示最近 20 条消息 |
| `/stats` | 显示统计信息 |
| `/recall <查询>` | 测试记忆召回 |
| `/add <路径> <内容>` | 手动添加知识（如 `/add 姓名 小魏`） |
| `/help` | 显示帮助 |
| `/quit` | 退出程序 |

## API 参考

Server 模式提供 OpenAI 兼容的 HTTP API。

### 聊天补全

```http
POST /v1/chat/completions
Content-Type: application/json

{
  "messages": [{ "role": "user", "content": "你好" }],
  "model": "gpt-4o",
  "stream": false,
  "conversation_id": "optional-ulid"
}
```

支持 `stream: true` 返回 SSE 流式响应。

### 记忆查询

```http
# 关键词搜索知识
GET /v1/memory/knowledge?q=<关键词>

# 路径前缀搜索
GET /v1/memory/knowledge?path=<前缀>

# 时间范围查询
GET /v1/memory/temporal?from=<ISO>&to=<ISO>

# 最近 50 条消息
GET /v1/memory/temporal
```

### 记忆写入

```http
POST /v1/memory/knowledge
Content-Type: application/json

{
  "path": ["工作", "公司"],
  "content": "杭州智诺"
}
```

### 会话管理

```http
GET    /v1/conversations         # 列出所有会话
GET    /v1/conversations/{id}    # 获取会话详情
DELETE /v1/conversations/{id}    # 删除会话
```

### 健康检查

```http
GET /health  →  { "status": "ok" }
```

## 配置说明

所有配置通过环境变量管理：

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `LLM_BASE_URL` | `https://api.openai.com/v1` | LLM API 端点 |
| `LLM_API_KEY` | (必需) | API 密钥 |
| `LLM_MODEL` | `gpt-4o` | 使用的模型 |
| `MAX_CONTEXT_TOKENS` | `8192` | 单次请求 token 限制 |
| `SUMMARIZE_THRESHOLD_RATIO` | `0.75` | 缓冲区摘要触发阈值 |
| `DB_PATH` | `./treememory.db` | 数据库文件路径 |
| `HTTP_PORT` | `3000` | 服务器端口 |
| `BACKGROUND_INTERVAL_MS` | `60000` | 后台任务间隔(ms) |
| `ACTIVITY_DECAY_RATE` | `0.95` | 活跃度衰减率 |
| `ACTIVITY_BOOST` | `1.0` | 访问增幅值 |

### 使用本地 LLM

兼容任何 OpenAI API 格式的服务，如 Ollama：

```env
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=dummy
LLM_MODEL=neural-chat
```

## 技术栈

| 依赖 | 版本 | 用途 |
|------|------|------|
| Node.js | >=18 | 运行时 |
| TypeScript | 6.0.2 | 编程语言 |
| Fastify | 5.8.4 | HTTP 服务框架 |
| better-sqlite3 | 12.8.0 | 嵌入式数据库 (WAL 模式) |
| OpenAI SDK | 6.32.0 | LLM API 客户端 |
| gpt-tokenizer | 3.4.0 | Token 计数 |
| pino | 10.3.1 | 日志库 |
| ulid | 3.0.2 | ID 生成 |
| Vitest | 4.1.1 | 测试框架 |

## 测试

```bash
# 单次运行
npm run test

# 监听模式
npm run test:watch
```

## 项目结构

```
src/
├── config/          # 配置管理（环境变量驱动）
├── db/              # 数据库层（SQLite, WAL 模式, 版本迁移）
├── engine/          # 对话引擎（会话管理、上下文组装、缓冲区摘要）
├── memory/          # 记忆系统（知识树、时间树、活跃度、召回）
├── llm/             # LLM 集成（OpenAI 兼容 API、token 计数）
├── background/      # 后台任务（时间树汇总、知识提取）
├── utils/           # 工具函数（日志、时间）
├── cli.ts           # CLI 入口
├── server.ts        # HTTP 服务器入口
└── index.ts         # 应用主入口
tests/
├── engine/          # 引擎测试
└── memory/          # 记忆系统测试
```

## NPM 脚本

```bash
npm install          # 安装依赖
npm run dev:cli      # CLI 模式运行
npm run dev:server   # Server 模式运行
npm run build        # 构建生产版本
npm run typecheck    # 类型检查
npm run test         # 运行测试
npm run test:watch   # 监听模式测试
```

## 许可证

[MIT](LICENSE)
