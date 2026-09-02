# pi-graph-ui

把 [pi coding agent](https://github.com/badlogic/pi-mono) 会话的完整动作过程**实时可视化成图**，并在同一界面里做**图编排执行**：主 agent 的每次工具调用是一个节点，并行 spawn 的子 agent 扇出与汇聚在 React Flow 画布上展开；编排页既可手画任务 DAG，也可输入一个目标让 AI 自动拆图，每个节点都是一个**真实独立运行的 pi agent 实例**。

```
Browser (React + React Flow)  ⇄  WebSocket/HTTP  ⇄  Node 桥接服务  ⇄  stdin/stdout JSONL  ⇄  pi --mode rpc
                                                      │
                                                      ├─ 每个编排节点：pi --mode rpc --no-session 子进程（persona/上游产出注入）
                                                      └─ AI 规划器：goal → 任务 DAG（同样是 pi 实例）
```

## 功能总览

- **实时页（对话为主）**：聊天流是主界面（用户/助手气泡、工具调用计数、流式光标），右栏是迷你实时图；点节点按需弹出详情面板；⚡ 开关把输入框变成「自动编排目标」入口，编排卡片实时出现在聊天流，完成后节点产出自动注入主会话、由主 agent 整理出最终回答
- **编排页**：可拖拽编辑器（节点/边增删改、自动整理、内置模板、校验 issue 提示）；边是**类型化语义边**（输入/参考/审校等六类 + 可选短备注）；「⚡ 自动编排」目标条（规划 JSON 流式预览）+ 只读运行视图（生成图按内容签名布局，流式期间绝不重排），生成图可转入编辑器改后重跑
- **执行引擎**：AND-join（等全部上游）、失败沿下游传染跳过（不浪费 token）、并行上限、每节点超时与进程树必杀；中止即刻生效且不留孤儿进程
- **持久化与回放**：会话与 run 全量落盘（`~/.pi-graph-ui/`），历史抽屉点开即回放成图；刷新/断线重连自动恢复（含进行中的 run）
- **界面**：暗色设计系统（四级海拔 + 语义色 + 统一焦点语言），所有面板分界**可拖拽调宽窄**（比例记在 localStorage，双击重置，方向键可调）
- 另有一个独立的贪吃蛇 demo 页挂在桥接服务根路径（`http://localhost:8787/`）

## 仓库结构

```
packages/shared   # pi 事件类型 + delta 折叠器 + 图派生/编排纯函数 + 聊天时间线（前后端同构，含单测）
apps/server       # Hono + ws 桥接：主会话 pi 子进程、编排引擎/规划器/节点执行器、run 与会话归档、只读 API（CORS）
apps/web          # React 前端：实时页（聊天+图）+ 编排页（编辑器+运行图）、可拖拽分栏、历史抽屉
scripts/          # dev.mjs 一键启动 / check-env.mjs 环境自检 / e2e-smoke.mjs 冒烟 / e2e-orch.mjs 编排 e2e / e2e-reset.mjs 重置流 e2e
pi/               # pi-mono 参考克隆（gitignore，仅源码参考）
```

## 一次性环境准备

1. **Node ≥ 20 + pnpm**，仓库根目录 `pnpm install`
2. **pi CLI**：`npm install -g @earendil-works/pi-coding-agent`（Windows 上即 `pi.cmd`）
3. **模型配置**：`~/.pi/agent/models.json` 定义 OpenAI 格式的自定义 provider（示例为 DeepSeek，key 走环境变量不落盘）：
   ```json
   {
     "providers": {
       "deepseek": {
         "baseUrl": "https://api.deepseek.com/v1",
         "api": "openai-completions",
         "apiKey": "$DEEPSEEK_API_KEY",
         "models": [{ "id": "deepseek-chat" }, { "id": "deepseek-reasoner" }]
       }
     }
   }
   ```
4. **subagent 扩展**（并行扇出的数据来源）：
   ```bash
   cp -r "$(npm root -g)/@earendil-works/pi-coding-agent/examples/extensions/subagent" \
     ~/.pi/agent/extensions/
   ```
   自定义 agent 定义放 `~/.pi/agent/agents/*.md`（编排节点的 @agent 下拉来自这里；frontmatter 不写 `model` 则继承主会话模型）
5. **自检**：`node scripts/check-env.mjs` —— pi / rpc / 模型 / 扩展全绿即就绪

## 日常启动

**一键（推荐）**：仓库根目录建 `.env`（已被 gitignore）：

```
DEEPSEEK_API_KEY=sk-...
```

然后：

```bash
node scripts/dev.mjs        # 同时起 :8787 桥接 + :5173 前端，Ctrl+C 全退
node scripts/stop.mjs       # 兜底清理：dev.mjs 被硬杀后残留的 server/vite（pidfile + 端口扫描）
```

**分开两个终端**（需要单独看日志时）：

```bash
# 终端 1 —— 桥接服务（必须先起）
cd apps/server
PI_ARGS="--model deepseek/deepseek-chat" DEEPSEEK_API_KEY=sk-... node src/main.ts

# 终端 2 —— 前端
cd apps/web && pnpm dev
```

浏览器打开 **http://localhost:5173**，底部输入框发任务即可。

## 验证 / 测试

```bash
pnpm -r test         # 214 个单测（shared 87 + server 127）
pnpm -r typecheck    # 全仓类型检查（web 无单测，typecheck 即门禁）

# 以下 e2e 需要桥接服务在跑（dev.mjs）且模型 key 可用，会真实调 LLM：
node scripts/e2e-smoke.mjs            # 实时页冒烟：一条真实任务 → 事件流 → 图
node scripts/e2e-orch.mjs             # 编排 e2e：2 节点链注入/归档/重放
ABORT=1 node scripts/e2e-orch.mjs     # 中止路径 + 无孤儿进程检查
PLAN=1  node scripts/e2e-orch.mjs     # AI 规划 → 同 runId 执行 → 全节点完成
CHAT=1  node scripts/e2e-orch.mjs     # PLAN 全套 + 结果注入主会话 + 整理回答 + hello 重放
node scripts/e2e-parallel.mjs         # 多路并行 e2e：4 分支扇出 + AND-join 汇聚，断言真并发（窗口重叠 + 用时缩短）
PLAN=1  node scripts/e2e-parallel.mjs # 多路并行自动编排：AI 拆图成并行 DAG → 并行执行 → 复用同一套并发断言
node scripts/e2e-reset.mjs            # 新任务重置流：图清空后可继续对话
```

## WS 协议

server → browser：

| 消息 | 说明 |
|---|---|
| `{type:"hello", snapshot, run?}` | 连接建立即重放全部历史事件；有进行中/最近一次 run 时一并重放其事件 |
| `{type:"event", event}` | 实时会话事件（`tool_execution_update` 按 toolCallId 100ms 合并） |
| `{type:"run_event", event}` | 编排 run 事件（plan_started/delta/completed、run_started、node deltas、run_finished…，150ms 连接式合并） |
| `{type:"run_error", error}` | 编排错误（校验 issue / 引擎异常） |
| `{type:"response", response}` | RPC 响应（id 关联） |
| `{type:"pi-exit", code, stderr}` | pi 子进程退出告警 |

browser → server：

| 消息 | 说明 |
|---|---|
| `{type:"command", command:{type:"prompt"\|"steer"\|"abort"\|"new_session", ...}}` | 会话命令透传 |
| `{type:"request", command}` | 同上但等待标定响应 |
| `{type:"run_graph", graph}` | 运行手动编辑器里的图 |
| `{type:"plan_run", goal, chat?}` | AI 自动拆图执行；`chat:true` 完成后把节点产出注入主会话整理回答 |
| `{type:"abort_run"}` | 中止编排/规划 |
| `{type:"ping"}` | 心跳 |

只读数据走 HTTP（带 CORS）：`GET /api/sessions`、`/api/sessions/:id/events`、`/api/agents`、`/api/runs`、`/api/runs/:id`、`/api/state`、`/health`。

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 模型 key（`.env`，gitignore） | — |
| `PI_BIN` / `PI_CWD` / `PI_ARGS` | pi 可执行文件 / 工作目录 / 额外参数 | `pi` / cwd / 空 |
| `PORT` | 桥接端口 | `8787` |
| `VITE_WS_URL` | 前端 WS 地址覆盖 | 同源推导 |
| `ORCH_MAX_PARALLEL` | 编排节点并行上限 | `4` |
| `ORCH_MODEL` | 编排节点默认模型 | `deepseek/deepseek-chat` |
| `ORCH_NODE_TIMEOUT_MS` | 单节点超时 | `600000`（10min） |
| `ORCH_MIN_OUTPUT_CHARS` | 节点质量门：输出短于此值触发原题重跑一次（两答取长） | `0`（关闭） |
| `ORCH_NODE_RETRY` | 质量门违规重跑开关（`0` 关闭；空输出则直接判失败） | 开启 |
| `ORCH_PLANNER_MODEL` | 规划器模型 | = `ORCH_MODEL` |
| `ORCH_PLAN_TIMEOUT_MS` | 规划超时 | `180000`（3min） |

节点级覆盖（`NodeDef` 可选字段，编辑器 JSON 可直接携带）：`minOutputChars` / `timeoutMs` / `outputCapBytes`（注入下游的字节预算）/ `workdir`（子进程独立工作目录，并行节点互不踩文件）/ `tools` / `excludeTools`（工具白/黑名单）。详见 `apps/server/README.md`。

## 已知限制 / Roadmap

- 实时 trace 图仍每次事件全量 dagre 重排（编排图已按内容签名稳定布局），大图有跳动 → 计划做位置保持
- 同一会话多次编排只在聊天流保留最新 run 卡片（历史注入消息仍在 transcript）→ v2
- 导出 PNG/SVG、按节点/单价的费用统计、多会话画布未做；窄屏（<650px 宽）下面板拖动会接近下限

## License

[MIT](./LICENSE)
