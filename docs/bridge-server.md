# pi-graph 桥接服务器（apps/server）全局装配调研

调研对象：`apps/server/README.md` 与 `apps/server/src/main.ts`（辅以 `src/` 目录各模块名与注释交叉印证）。

---

## 1. 整体架构图

```
        ┌───────────── 浏览器 (Browser) ─────────────┐
        │  Vite 前端 (:5173, fetch)   WS 客户端       │
        │  编辑器 / 历史抽屉 / 贪吃蛇                 │
        └───────────────┬────────────────────────────┘
                        │  WebSocket (双向 JSONL)  +  HTTP fetch (CORS)
                        ▼
        ┌─────────────────────────────────────────────────────────┐
        │             桥接服务器 apps/server (Hono + ws)          │
        │  main.ts 的装配中心（HTTP 路由 / WS 分发 / 模块装配）    │
        │                                                        │
        │  ┌────────────── EventHub ─────────────────────────────┐ │
        │  │  会话事件扇出：回放缓冲 + tool_execution_update 节流  │ │
        │  └─────────────────────────────────────────────────────┘ │
        │            │  stdout/stdin JSONL                        │
        │            ▼                                             │
        │   ┌───────────────── pi --mode rpc ───────────────┐     │
        │   │   主会话子进程（bridge；标定响应、事件、退出）   │     │
        │   └────────────────────────────────────────────────┘     │
        │            │                                             │
        │  ┌──────────┴──────────┐                                 │
        │  │  orchestrator       │  纯 DAG 调度引擎               │
        │  │  （AND-join、失败    │  planner = AI 规划器           │
        │  │   下游传染 skip、    │  (goal→任务DAG)                │
        │  │   AbortController）  │                                 │
        │  └──────────┬──────────┴──────────┐                      │
        │             ▼                     ▼                      │
        │  每节点一个 pi --mode rpc      pi --mode rpc             │
        │  --no-session 子进程          (planner 实例)             │
        │  (PiNodeExecutor)             (PiPlanner)               │
        └─────────────────────────────────────────────────────────┘
```

要点：
- **Browser ──WS/HTTP──> server**：WS 承载实时双向协议；HTTP 提供只读归档 API、状态折叠、健康探针与贪吃蛇 demo 页。
- **server ──stdin/stdout JSONL──> pi --mode rpc 主会话子进程**：`PiBridge` 管理，桥接主会话。
- **orchestrator 每节点独立子进程**：`PiNodeExecutor` 为每个节点 spawn 一个 `pi --mode rpc --no-session` 实例（无会话、独立工作目录、可杀进程树），互不踩文件，可并行。
- **planner 为 AI 规划器**：`PiPlanner` 也是一个 pi 实例，把用户 goal 拆成任务 DAG，再用 orchestrator 执行。

---

## 2. 全部 HTTP 路由及其职责

| 路由 | 职责 | 备注 |
|---|---|---|
| `GET /health` | 存活探针；返回 pi 子进程状态（`bridge.running`、`cwd`）与当前 WS 客户端数 | 无鉴权 |
| `GET /api/state` | 折叠的会话摘要（`deriveGraph(session)` + `agentStatus` + `usage` + 消息数/工具数/`lastError`/节点/边计数） | 只读 |
| `GET /api/sessions` | 历史会话列表（`store.list()`） | 只读 + CORS |
| `GET /api/sessions/:id/events` | 单个历史会话的事件流（`store.read(id)`），历史抽屉回放数据源 | 只读 + CORS |
| `GET /api/agents` | 列出 `~/.pi/agent/agents/*.md` 文件名（去掉 `.md` 后缀），供编排节点 `@agent` 下拉（datalist） | 只读 + CORS；目录不存在时返回 `[]` |
| `GET /api/runs` | 编排 run 归档列表（`runStore.list()`） | 只读 + CORS |
| `GET /api/runs/:id` | 单个 run 归档详情（`runStore.read(id)`） | 只读 + CORS |
| `GET /api/snake` | 贪吃蛇子 API（`snakeRoutes`，含排行榜 + token 发放），同源策略、**不开放 CORS** | 经 `app.route` 挂载 |
| `GET /` | 返回贪吃蛇 demo 静态页 HTML（`snakeHtml()` 缓存读取 `snake.html`） | 带 CSP |
| `GET /snake` | 同上，贪吃蛇 demo 页 | 带 CSP |

命名对应源码位置（main.ts）：
- 安全中间件：`app.use("*", ...)`（`X-Content-Type-Options`/`X-Frame-Options`/`Referrer-Policy`，仅 `/snake` 与 `/` 附加 CSP）。
- CORS 中间件：`app.use("/api/sessions*"...)`、`/api/agents`、`/api/runs*`（读取 `hono/cors`）。

---

## 3. WS 双向协议完整消息类型清单

### server → client

| type | 字段 | 职责 |
|---|---|---|
| `hello` | `snapshot: JsonAgentSessionEvent[]`，可选 `run: RunEvent[]` | 连接建立时发送；回放完整历史事件快照，若有进行中/最近一次编排 run 则附带重放，使刷新页面可重建同一会话/run |
| `event` | `event: JsonAgentSessionEvent` | 实时会话事件（经 EventHub 节流后推送） |
| `run_event` | `event: RunEvent` | 编排事件流（plan_*/run_started/节点 delta/run_finished，由 RunManager 150ms 合并） |
| `run_error` | `message: string`，可选 `issues` | 编排校验/引擎错误（`run_graph`/`plan_run` 被拒绝时，仅回给请求者） |
| `response` | `response: RpcResponse` | 标定的 RPC 响应（收到 `request` 后回传，广播给所有已连接客户端） |
| `pi-exit` | `code: number`, `stderr: string` | 主会话 pi 子进程退出/死亡通知，广播给全部客户端 |

补充（实现中出现的额外下行消息，确保完整）：
- `reset`：`new_session` 确认后广播，令所有客户端重建状态。
- `ack`：对 `command` 的即时确认（`commandType`）。
- `error`：本地错误（如 `new_session` 失败、命令解析错误）。
- `pong`：响应客户端 `ping` 心跳。

### client → server

| type | 字段 | 职责 |
|---|---|---|
| `command` | `command: RpcCommand` | 会话命令透传（`prompt`/`steer`/`abort`/`new_session`），fire-and-forget，不等待标定响应；收到后回 `ack` |
| `request` | `command: RpcCommand` | 同 command 但会回传标定的 RPC 响应（响应经 server→client 的 `response` 转发） |
| `run_graph` | `graph: GraphDef` | 运行手动编排图；由 `runManager.start()` 解析校验，失败回 `run_error` |
| `plan_run` | `goal: string`, 可选 `chat?: true` | AI 自动拆图执行；`chat:true` 表示完成后把节点输出注入主会话 agent 整理成回答推入聊天面板 |
| `abort_run` | — | 中止当前编排/规划（`runManager.abort()`，空闲时为空操作） |
| `ping` | — | 心跳，server 回 `pong` |

特殊处理：`new_session` 命令不会直接透传——主进程先 `bridge.request({type:"new_session"})` 等待 pi 确认成功，再 `resetSession()`（清空 hub/replay + 重建状态 + 归档归还 + 广播 `reset`），避免 prompt 竞速被 pi 吞掉。

---

## 4. main.ts 模块实例化与装配顺序、相互引用

### 装配顺序（自上而下）

1. **环境变量读取**：`PORT`、`PI_BIN`、`PI_CWD`、`PI_ARGS`、`ORCH_MAX_PARALLEL`、`ORCH_MODEL`、`ORCH_NODE_TIMEOUT_MS`、`ORCH_MIN_OUTPUT_CHARS`、`ORCH_NODE_RETRY`、`ORCH_AGENTS_DIR`（内部派生态）、`ORCH_PLANNER_MODEL`、`ORCH_PLAN_TIMEOUT_MS`。

2. **核心对象实例化**：
   - `bridge = new PiBridge({bin, cwd, extraArgs: PI_ARGS})` —— 主会话 pi 子进程。
   - `hub = new EventHub({intervalMs: 100})` —— 会话事件扇出/回放/节流。
   - `store = new SessionStore()`、`runStore = new RunStore()` —— 归档存储。
   - `runManager = new RunManager({...})` — 注入的三个依赖：
     - `executor: new PiNodeExecutor({bin, cwd, defaultModel, agentsDir, timeoutMs, minOutputChars, salvageRetry})` —— 每节点独立 pi 子进程执行器；
     - `planner: new PiPlanner({bin, cwd, model, timeoutMs})` —— AI 规划器；
     - `store: runStore`、`maxParallel: ORCH_MAX_PARALLEL`；
     - `onChatRunComplete` 回调 → **反向引用 bridge**：run 完成时 `bridge.send({type:"prompt", message: buildSynthPrompt(...)})` 把编排结果注入主会话 agent。
   - `let session = initState()` —— 当前会话折叠状态。

3. **事件订阅装配**（结构上形成引用图）：
   - `runManager.subscribe((event) => 广播 run_event)` —— 向外广播编排事件。
   - `bridge.on("event", (event) => { foldEvent(session, event); hub.ingest(event); store.append(event); })` —— 主会话事件三写：折叠进状态 + 进 hub 扇出 + 归档。
   - `bridge.on("exit", (code, stderr) => 广播 pi-exit + store.finalize())`。

4. **HTTP 装配**：安全中间件 → CORS → `app.route("/api/snake", snakeRoutes({leaderboard: new Leaderboard()}))` → `/snake`、`/`、`/health`、`/api/sessions*`、`/api/agents`、`/api/runs*`、`/api/state`。

5. **服务启动**：`serve({fetch: app.fetch, port}, cb)`，回调内 `bridge.start()`；随后 `new WebSocketServer({server})` 挂到同一 http.Server，注册 `connection`/`message`/`close` 处理。

6. **响应广播装配**：`bridge.on("response", ...)` 广播 `response` 给所有客户端。

7. **关闭钩子**：`shutdown()`（先 `runManager.abort()` 杀编排/规划子进程 → `bridge.kill()` → 关 WS → `server.close` → 兜底 2s `process.exit`），绑定 `SIGINT`/`SIGTERM`。

### 相互引用关系小结

```
                     ┌────────────────────────────────────┐
                     │  PiBridge (主会话 pi)               │
                     │   .send/.request/.kill/.start      │
                     │   .on("event"/"exit"/"response")   │
                     └──────┬───────────┬──────────┬──────┘
                 broadcast   │ 事件折叠    │ 响应广播   │
                     ▼       ▼           ▼            │ (onChatRunComplete 注入
              EventHub    session     WS 客户端      │  prompt 回主会话)
              │ 扇出                               │
              ▼                                    │
         WS 客户端 ◄──────────── bridge.send(prompt)
                     ▲
                     │  runManager.subscribe ──► run_event 广播
        RunManager ◄──── PiNodeExecutor (每节点)
            │          PiPlanner (AI 规划)
            └──── RunStore / SessionStore 归档
```

关键：RunManager 持有 executor + planner + store 三个依赖；`onChatRunComplete` 反向依赖 `bridge`（在 runManager 构造时通过闭包捕获先声明的 bridge）。`session`/`store` 由 `resetSession()`（new_session 成功）重建/归还。

---

## 5. 全局环境变量表

| 变量 | 默认值 | 行为 / 归一逻辑 |
|---|---|---|
| `PORT` | `8787` | `Number(process.env.PORT ?? 8787)`；HTTP/WS 监听端口 |
| `PI_BIN` | 未设（undefined）→ 透传给 PiBridge，由其决策 `pi`/`pi.cmd` | pi 可执行文件路径 |
| `PI_CWD` | `process.cwd()` | pi 子进程工作目录 |
| `PI_ARGS` | `[]` | 额外 pi 参数：`process.env.PI_ARGS?.split(/\s+/).filter(Boolean)`，如 `--model deepseek/deepseek-chat` |
| `ORCH_MAX_PARALLEL` | `4` | `Math.max(1, Number(...) || 4)`；编排节点并行上限（防 0/NaN → 4） |
| `ORCH_MODEL` | `deepseek/deepseek-chat` | 编排节点默认模型 |
| `ORCH_NODE_TIMEOUT_MS` | `600000`（10 分钟） | `Math.max(1_000, Number || 600_000)`；单节点墙钟超时，下限 1000ms |
| `ORCH_MIN_OUTPUT_CHARS` | `0`（关闭） | `Math.max(0, Math.floor(Number || 0))`；质量门——节点 trim 后输出低于此字符数视为违规 |
| `ORCH_NODE_RETRY` | 开启（`"0"` 显式关闭） | `process.env.ORCH_NODE_RETRY !== "0"`；违规时原题改写重跑一次两答取长；`0`=空输出判失败 |
| `ORCH_PLANNER_MODEL` | `= ORCH_MODEL` | 规划器模型（`?? ORCH_MODEL`） |
| `ORCH_PLAN_TIMEOUT_MS` | `180000`（3 分钟） | `Math.max(1_000, Number || 180_000)`；规划超时，下限 1000ms |

额外注意：
- `ORCH_AGENTS_DIR` 非用户配置，恒为 `join(homedir(), ".pi", "agent", "agents")`，供 `/api/agents` 与执行器读取 persona。
- 节点质量门语义（对齐 pi-graph-tool v0.2.3）：低于阈值=违规→默认原题不改写重跑一次、两答**取长**；两次皆空或真实失败（进程退出/超时/拒绝）判失败；**中止后绝不重试**；`node_completed` 事件带 `attempts: 2`，预览流插入重跑标记。
- 除全局变量外，`NodeDef` 支持逐节点覆盖（`validateGraph` 统一校验）：`minOutputChars` / `timeoutMs` / `outputCapBytes` / `workdir`（安全相对路径）/ `tools`（≤32）/ `excludeTools`，分别优先于对应全局变量。

---

## 附：依赖与测试

- 依赖：`hono` / `@hono/node-server`（HTTP+CORS）、`ws` / `@types/ws`（WebSocket）、`@pi-graph/shared`（共享类型/状态折叠/编排纯函数，workspace）、`typescript`/`vitest`/`@types/node`。
- 测试：`test/` 下 9 个文件、127 个用例（引擎/规划器/执行器/run-manager/事件/归档/贪吃蛇）。
- 运行：`pnpm dev` / `pnpm start` / `pnpm typecheck` / `pnpm test`。
