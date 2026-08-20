# @pi-graph/server

pi-graph 的桥接服务器（bridge server）：把浏览器与 `pi --mode rpc` 子进程连接起来。

## 架构

```
Browser --WebSocket--> this server --stdin/stdout JSONL--> pi --mode rpc
```

浏览器通过 WebSocket 连接本服务，本服务再把命令通过 JSONL 转发给 `pi --mode rpc` 子进程，并把 pi 产生的事件/响应回传给浏览器。

## 目录结构

```
apps/server
├── src/
│   ├── main.ts          # 入口：HTTP + WebSocket 服务，装配 PiBridge 与 EventHub
│   ├── event-hub.ts     # 事件扇出：回放缓冲 + tool_execution_update 节流
│   └── pi-bridge.ts     # 管理 pi --mode rpc 子进程，转发标定响应
├── test/
│   └── event-hub.test.ts  # classifyLine 与 EventHub 的单元测试
├── snake.html           # 贪吃蛇 demo 页面（返回主页按钮跳转到服务器根路径）
├── package.json
├── tsconfig.json
└── README.md
```

## 模块说明

### src/main.ts

服务入口，负责：

- **HTTP** —— 基于 [Hono](https://hono.dev) + `@hono/node-server`：
  - `GET /health`：存活探针 + pi 子进程状态 + 当前 WS 客户端数
  - `GET /api/state`：折叠的会话摘要（由 `@pi-graph/shared` 的 `deriveGraph` 生成）
- **WebSocket** —— 基于 `ws`：
  - 新客户端连接时回放完整历史（`hello` 消息）
  - 转发 `command` / `request` 给 pi，标定响应扇出给所有客户端
  - `ping` → `pong`
- **生命周期** —— 优雅关闭（SIGINT / SIGTERM）

WS 协议（server → client）：
- `{type:"hello", snapshot}` 连接时发送完整历史
- `{type:"event", event}` 实时事件（经过节流）
- `{type:"response", response}` 标定的 RPC 响应
- `{type:"pi-exit", code, stderr}` 子进程退出

WS 协议（client → server）：
- `{type:"command", command}` 转发命令（fire-and-forget，回 ack）
- `{type:"request", command}` 转发并回传标定响应
- `{type:"ping"}` 心跳

### src/event-hub.ts

`EventHub` 负责把 pi 事件扇出给多个 WS 客户端，具备：
- **回放缓冲**：新客户端连接时能补全完整会话历史
- **节流**：对于同一 `toolCallId` 的 `tool_execution_update`，按 `intervalMs` 合并，避免 subagent 部分输出洪水刷屏

### src/pi-bridge.ts

`PiBridge` 管理 `pi --mode rpc` 子进程：

- stdin 写 JSONL `RpcCommand`（prompt / steer / abort / get_state …）
- stdout 每行是 `JsonAgentSessionEvent`（裸对象）或 `RpcResponse`
  （唯一 `type === "response"` 的行，用于区分两种形态）
- stderr 保存尾部 4KB 用于诊断 / 退出报告
- 提供 `send`（fire-and-forget）与 `request`（按 id 标定、Promise 返回）
- 导出 `classifyLine` 工具函数

## 运行

```bash
# 安装依赖（通常在 monorepo 根目录，使用 workspace）
pnpm install

# 开发：监听文件变化自动重启
pnpm dev

# 运行
pnpm start

# 类型检查
pnpm typecheck

# 运行测试
pnpm test
```

## 环境变量

| 变量       | 说明                                   | 默认值            |
| ---------- | -------------------------------------- | ----------------- |
| `PORT`     | HTTP/WS 监听端口                       | `8787`            |
| `PI_BIN`   | pi 可执行文件                           | `pi` / `pi.cmd`   |
| `PI_CWD`   | pi 子进程工作目录                      | `process.cwd()`   |
| `PI_ARGS`  | 额外 pi 参数（空格分隔），如模型配置    | 空                |

## 依赖

- `hono` / `@hono/node-server` —— HTTP 服务
- `ws` / `@types/ws` —— WebSocket
- `@pi-graph/shared` —— 共享类型与状态折叠逻辑（workspace）
- `typescript` / `vitest` / `@types/node` —— 开发依赖
