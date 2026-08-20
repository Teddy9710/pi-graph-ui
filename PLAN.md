# Pi Graph UI — 项目计划

## 概述
**Pi Agent 会话过程的实时图可视化**：后端驱动一个真实的 pi coding agent，前端用 React Flow 把 agent 的完整动作过程渲染成活动图 —— 主 agent 是根节点，每次工具调用是一个节点，调研类任务中并行 spawn 的多个子 agent 及其汇总过程形象地展开为图中的分支与汇聚。不是 DAG 编排引擎，而是 **agent trace 的实时图渲染器**。

## 源码调研结论（pi-mono @ b7bb00b93，编码本项目前必读）

### 1. 事件模型
- 核心联合类型 `AgentEvent`（`packages/agent/src/types.ts`）：
  `agent_start / agent_end / turn_start / turn_end / message_start / message_update / message_end / tool_execution_start / tool_execution_update / tool_execution_end`
- 会话级 `AgentSessionEvent`（`packages/coding-agent/src/core/agent-session.ts`）额外含 `agent_settled / queue_update / compaction_* / auto_retry_* / entry_appended / session_info_changed` 等
- **工具事件只按 `toolCallId` 关联，事件上没有 agentId / parentId** —— 父子关系必须由我们派生：
  - 工具节点 ↔ 所属 assistant 消息：`tool_execution_start.toolCallId` 与此前 `message_end` 消息 content 里的 `toolCall.id` 匹配
  - 子 agent ↔ 父：见下

### 2. 子 agent 机制（图的核心）
- pi **核心没有内置 subagent**；它是示例扩展 `packages/coding-agent/examples/extensions/subagent/index.ts`，注册名为 `subagent` 的工具，参数支持 `single / parallel(最多8个, 并发4) / chain` 三种模式
- 每个子任务是独立 `pi --mode json -p --no-session` 子进程；子进程事件**不进入**父事件流，而是聚合成 `SubagentDetails`：
  ```
  SubagentDetails { mode, results: SingleResult[] }
  SingleResult    { agent, task, exitCode(-1=运行中), messages: Message[], usage, model, stopReason }
  ```
  通过 `tool_execution_update.partialResult.details` 实时流回父流，`tool_execution_end.result` 为终态
- 子 agent 的 `messages` 里含其内部 toolCall 块与 toolResult —— 足以把子 agent 内部工具活动渲染成二级节点
- ⚠️ 该扩展**默认不加载**（resource-loader 只扫描 `~/.pi/agent/extensions` 与 `<cwd>/.pi/extensions`），需手动安装
- ⚠️ 扩展源码里有处理 `tool_result_end` 的死分支（当前事件联合中无此类型），子工具结果实际走 `message_end`

### 3. 传输（浏览器 ⇄ pi）
- pi 本体**无 HTTP/WebSocket**；pi-server 只有 Unix socket + CBOR（Windows 浏览器不可直接用）
- **推荐桥接**：Node 后端 spawn `pi --mode rpc`，stdin/stdout 为 JSONL：
  - 下行 `RpcCommand`（`rpc-types.ts`）：`prompt / steer / follow_up / abort / new_session / get_state / set_entries / get_messages / set_model / bash...`，可选 `id` 关联
  - 上行：所有 `AgentSessionEvent` 经 `toJsonEvent` 无过滤逐行输出；响应带匹配 `id`
- ⚠️ 线上 `message_update` 是 **delta-only**（只含 `assistantMessageEvent` 增量），需从 `message_start` 开始折叠增量重建消息；`message_end` 为权威终态
- 备选：进程内 `createAgentSession()`（`packages/coding-agent/src/core/sdk.ts`），`session.subscribe/prompt/steer/abort`，事件含累计快照，且可自定义带 parent toolCallId 标记的 in-process 子会话 —— v2 再考虑

### 4. 其他事实
- 事件**无时间戳**，前端在收到时本地打点（TUI 同样做法）
- 会话持久化为 JSONL（`~/.pi/agent/sessions/<cwd>/<ts>_<id>.jsonl`，首行 header，后续 SessionMutation），SQLite backend 存在但两者都无 watch API；历史回放 v1 用 RPC `get_messages/get_entries` 拉取
- TUI（interactive-mode.ts，6.7k 行）是参考消费端：`pendingTools: Map<toolCallId, Component>` 的模式值得照搬到 React

## 架构
```
Browser (React + React Flow)
   │  WebSocket (JSON)
Node 桥接服务 (Hono)
   │  stdin/stdout JSONL
pi --mode rpc  (加载 subagent 扩展)
   └─ 并行 spawn 子 pi 进程（调研任务）
```

## 图模型（React Flow 节点/边派生规则）
| 节点类型 | 来源事件 | 说明 |
|---|---|---|
| `session` | 连接建立 | 根节点 |
| `user` | `prompt` 命令 / user 消息 | 用户输入 |
| `assistant` | `message_start/update/end` | 流式文本，delta 折叠 |
| `tool` | `tool_execution_start/update/end` | read/bash/edit 等；状态 running→ok/error；按 toolCallId 挂到所属 assistant 下 |
| `subagent-call` | `toolName === "subagent"` 的工具事件 | 分支枢纽节点 |
| `agent` | `partialResult.details.results[]` | 每个 SingleResult 一个节点；exitCode=-1 运行中；显示 agent 名/task/usage |
| `agent-tool` | agent 节点 messages 内的 toolCall 块 | 子 agent 内部工具活动（二级展开，可折叠） |

边：`session→user→assistant→tool…`，`assistant→subagent-call→agent(s)→agent-tool…`，结果回流体现为节点状态变化与 token/usage 汇总。布局用 dagre（或 elkjs）自动排布，流式更新时局部重排。

## 技术栈
- **桥接服务**: Node.js + Hono + ws；spawn `pi --mode rpc`
- **前端**: React + Vite + @xyflow/react + dagre + zustand（事件→图状态 reducer）
- **共享**: 事件类型 + delta 折叠器 + 图派生逻辑（同构复用，便于测试）

## 仓库结构
```
apps/server     # Hono + WS 桥接：pi rpc 子进程管理、JSONL↔WS 转发、事件打点
apps/web        # React Flow 画布、节点组件、详情面板、时间线
packages/shared # 事件类型（对齐 pi）、delta 折叠、图派生纯函数
```
注：`pi/`（pi-mono 参考克隆）加入 .gitignore，仅作源码参考，不作运行时依赖。

## 里程碑
1. **M1** 骨架：monorepo（pnpm）、shared 事件类型 + delta 折叠器 + 图派生（纯函数 + 单测）
2. **M2** 桥接服务：pi rpc 子进程生命周期、WS 双向转发、`prompt/steer/abort` 透传；subagent 扩展安装脚本
3. **M3** 前端 MVP：画布 + 自动布局 + 节点状态实时同步 + assistant 流式文本 + 工具节点详情
4. **M4** 子 agent 图：解析 SubagentDetails、并行分支动画、agent 内部工具二级展开、汇总节点
5. **M5** 持久化与回放：历史会话列表、加载重放成图；steer/abort 控件
6. **M6+** 增强：多会话画布、导出 PNG/SVG、token 费用统计、elkjs 复杂布局

## 风险与对策
- pi 版本升级改动事件形状 → shared 包用快照测试锁定事件结构，升级时显式更新
- `pi` CLI 未安装/不在 PATH → server 启动自检并给出指引；支持 `PI_BIN` 环境变量
- 子进程 stdout 大量 partial 全量 details → server 端做 diff/节流（≥100ms 合并）再推前端
- 大会话节点数爆炸 → 图派生做窗口化（只展开最近 N 轮），旧轮次折叠成摘要节点

## 参考
- pi-mono 源码（本仓库 `pi/` 目录）
- RPC 模式: `packages/coding-agent/src/modes/rpc/`；JSON 事件: `modes/json-event.ts`
- subagent 扩展: `packages/coding-agent/examples/extensions/subagent/index.ts`
- SDK: `packages/coding-agent/src/core/sdk.ts`（docs/sdk.md）
- https://xyflow.com
