# @pi-graph/server

pi-graph 的桥接服务器（bridge server）：把浏览器与 `pi --mode rpc` 子进程连接起来，并承载整套**图编排执行引擎**。

```
Browser --WebSocket/HTTP--> this server --stdin/stdout JSONL--> pi --mode rpc   （主会话）
                                │
                                ├─ orchestrator ──> 每节点一个 pi --mode rpc --no-session 子进程
                                └─ planner ───────> AI 规划器（goal → 任务 DAG，也是 pi 实例）
```

## 目录结构

```
apps/server
├── src/
│   ├── main.ts              # 入口：HTTP + WS 服务、编排 WS 消息、只读 API（CORS）、装配
│   ├── event-hub.ts         # 会话事件扇出：回放缓冲 + tool_execution_update 节流
│   ├── pi-bridge.ts         # 主会话 pi 子进程管理，转发标定响应
│   ├── orchestrator.ts      # 纯 DAG 调度引擎：AND-join、失败沿下游传染 skip、AbortController
│   ├── pi-node-executor.ts  # 编排节点执行器：每节点一个独立 pi --no-session 实例
│   │                        # （persona 临时文件注入、上游产出注入、settled/exit/timeout 三方竞争、必杀进程树、
│   │                        #  质量门 minOutputChars + salvage 原题重跑、节点级超时/workdir/工具档案）
│   ├── planner.ts           # AI 规划器：goal → 任务图（严格 JSON 提示词 + 解析归一 + 失败重试一次）
│   ├── run-manager.ts       # 全局单 run 生命周期、150ms 连接式 delta 合并、chat 完成钩子（结果注入主会话）
│   ├── run-store.ts         # run 归档：~/.pi-graph-ui/runs/*.jsonl
│   ├── session-store.ts     # 会话归档：~/.pi-graph-ui/sessions/*.jsonl
│   └── snake/               # 贪吃蛇 demo（game.ts / leaderboard.ts / routes.ts，挂在 / 与 /snake）
├── test/                    # 9 个测试文件 127 个用例（引擎/规划器/执行器/run-manager/事件/归档/贪吃蛇）
├── snake.html               # 贪吃蛇 demo 静态页
├── package.json / tsconfig.json / README.md
```

## HTTP API

| 路由 | 说明 |
|---|---|
| `GET /health` | 存活探针 + pi 子进程状态 + WS 客户端数 |
| `GET /api/state` | 折叠的会话摘要（shared 的 `deriveGraph`） |
| `GET /api/sessions`、`GET /api/sessions/:id/events` | 历史会话列表与事件（历史抽屉回放数据源） |
| `GET /api/agents` | 列出 `~/.pi/agent/agents/*.md` 文件名（编排节点 @agent 下拉） |
| `GET /api/runs`、`GET /api/runs/:id` | 编排 run 归档列表与详情 |
| `GET /`、`GET /snake` | 贪吃蛇 demo 页 |

只读 API（`/api/sessions*`、`/api/agents`、`/api/runs*`）挂 `hono/cors`：前端由 Vite :5173 提供、API 在 :8787，跨源 fetch 不开 CORS 会被浏览器静默拦截。

## WS 协议

server → client：

- `{type:"hello", snapshot, run?}` 连接时发送完整历史事件；有进行中/最近一次 run 时一并重放
- `{type:"event", event}` 实时会话事件（经节流）
- `{type:"run_event", event}` 编排事件（plan_*/run_started/node delta/run_finished，150ms 合并）
- `{type:"run_error", error}` 编排校验/引擎错误
- `{type:"response", response}` 标定的 RPC 响应
- `{type:"pi-exit", code, stderr}` 子进程退出

client → server：

- `{type:"command", command}` 会话命令透传（prompt / steer / abort / new_session，fire-and-forget）
- `{type:"request", command}` 同上但回传标定响应
- `{type:"run_graph", graph}` 运行手动编排图
- `{type:"plan_run", goal, chat?}` AI 自动拆图执行（`chat:true` = 完成后注入主会话整理回答）
- `{type:"abort_run"}` 中止编排/规划
- `{type:"ping"}` 心跳

## 运行

```bash
pnpm install     # 通常在 monorepo 根目录
pnpm dev         # 开发
pnpm start       # 运行
pnpm typecheck   # 类型检查
pnpm test        # 单测（127 个用例）
```

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | HTTP/WS 监听端口 | `8787` |
| `PI_BIN` | pi 可执行文件 | `pi` / `pi.cmd` |
| `PI_CWD` | pi 子进程工作目录 | `process.cwd()` |
| `PI_ARGS` | 额外 pi 参数（空格分隔），如模型配置 | 空 |
| `ORCH_MAX_PARALLEL` | 编排节点并行上限 | `4` |
| `ORCH_MODEL` | 编排节点默认模型 | `deepseek/deepseek-chat` |
| `ORCH_NODE_TIMEOUT_MS` | 单节点超时 | `600000` |
| `ORCH_MIN_OUTPUT_CHARS` | 质量门（字符数）：节点输出短于此值视为违规 | `0`（关闭） |
| `ORCH_NODE_RETRY` | 质量门违规时是否原题重跑一次（两答取长）；`0` 关闭 | 开启 |
| `ORCH_PLANNER_MODEL` | 规划器模型 | = `ORCH_MODEL` |
| `ORCH_PLAN_TIMEOUT_MS` | 规划超时 | `180000` |

## 节点能力档案（node-level capability profile）

除全局环境变量外，`NodeDef` 支持逐节点覆盖（编辑器 JSON / 规划器输出均可携带，`validateGraph` 统一校验）：

| 字段 | 说明 | 范围 |
| --- | --- | --- |
| `minOutputChars` | 节点级质量门，优先于 `ORCH_MIN_OUTPUT_CHARS` | `0–1000000` |
| `timeoutMs` | 节点级墙钟超时，优先于 `ORCH_NODE_TIMEOUT_MS` | `≥1000ms` |
| `outputCapBytes` | 该节点输出注入下游/汇总时的字节预算（归档保留完整原文） | `1–1000000` |
| `workdir` | 节点子进程独立工作目录（相对 `PI_CWD` 的安全相对路径；并行节点互不踩文件） | 受 `isSafeWorkdir` 约束 |
| `tools` | 工具白名单（`--tools`，逗号拼接） | ≤32 个合法工具名 |
| `excludeTools` | 工具黑名单（`--exclude-tools`） | 同上 |

质量门 + salvage 语义（对齐 pi-graph-tool v0.2.3）：

- 输出（trim 后）低于阈值 = 违规；默认**原题不改写重跑一次**，两次成功回答**取长者**；
- 两次均为空 → 节点判失败（空转不再静默算成功）；真实失败（进程退出/超时/拒绝）不重试；
- **中止后绝不重试**；重跑发生时预览流会插入「—— 输出仅 N 字符（< 质量门 M），用原题重跑一次 ——」标记，
  `node_completed` 事件带 `attempts: 2`。

## 依赖

- `hono` / `@hono/node-server` —— HTTP 服务 + CORS
- `ws` / `@types/ws` —— WebSocket
- `@pi-graph/shared` —— 共享类型、状态折叠、编排纯函数（workspace）
- `typescript` / `vitest` / `@types/node` —— 开发依赖
