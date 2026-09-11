# pi-graph-ui

![Node](https://img.shields.io/badge/Node-%E2%89%A5%2020-339933) ![pnpm](https://img.shields.io/badge/pnpm-workspace-F69220) ![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white) ![React Flow](https://img.shields.io/badge/React_Flow-12-FF0072?logo=react&logoColor=white) ![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white) ![tests](https://img.shields.io/badge/tests-407%20passed-2DA44E)

把 [pi coding agent](https://github.com/badlogic/pi-mono) 会话的完整动作过程**实时可视化成图**，并在同一界面里做**图编排执行**：主 agent 的每次工具调用是一个节点，并行 spawn 的子 agent 扇出与汇聚在 React Flow 画布上展开；编排页既可手画任务 DAG，也可输入一个目标让 AI 自动拆图——**每个节点都是一个真实独立运行的 pi agent 实例**。

## 界面一览

### 实时页 · 对话为主线，图在侧翼

![实时页：聊天流 + 迷你实时图](docs/images/live-session.png)

- 聊天流是主界面：用户/助手气泡、工具调用计数、流式光标；右栏迷你实时图把会话动作派生成节点（用户消息 → 工具调用 → 助手回复），点节点按需弹出详情面板
- **⚡ 开关**把输入框变成「自动编排目标」入口：编排卡片实时出现在聊天流，完成后节点产出自动注入主会话、由主 agent 整理出最终回答
- 运行中输入即转向（steer），断线自动重连、历史不丢

### 会话管理 · 常驻侧栏，上下文完整恢复

![会话栏：多会话列表 + 重命名 + 当前标记](docs/images/sessions-sidebar.png)

- 左侧常驻会话栏：**＋新对话**、点击恢复、行内 ✎ 重命名、✕ 删除（带确认）；当前会话置顶并带「当前」标记，折叠成 40px 细栏也不离场
- 恢复的不只是视图——pi 的**模型上下文一并切回**（RPC `switch_session`），切回旧会话问「我叫什么名字」它还记得
- 无 pi 会话文件的旧存档自动降级为「仅回放」（▶ 按钮进只读历史视图，不改变当前对话）；agent 运行中恢复会被拒绝并提示原因

### 编排编辑器 · 手画 DAG，边有语义

![编排编辑器：模板画布 + 节点检查器](docs/images/orch-editor.png)

- 节点/边增删改、自动整理、校验 issue 提示；内置模板：**并行调研 + 汇总**（AND-join 演示）、**三级流水线**（数据注入与失败传染演示）、空白画布
- 边是**类型化语义边**：输入 / 参考 / 审校 / 修订 / 汇总 / 决策 六类 + 可选 20 字内短备注——语义注入下游提示词头，图因此可推理
- 每个节点对应一个真实 pi 子进程；@agent 下拉来自 `~/.pi/agent/agents/*.md`（frontmatter 不写 `model` 则继承主会话模型）
- **门控节点**（＋门控）：运行到此挂起，人工批准（批注原样注入下游）/ 驳回（按失败传染跳过下游）后才继续

### 运行视图 · 只读、稳定布局、可复盘

![运行视图：DAG 执行完成，chips 汇总与节点产出](docs/images/orch-run.png)

- **⚡ 自动编排**：目标条输入一个目标 → AI 规划器拆成任务 DAG（规划 JSON 流式预览）→ 立即执行
- 生成图按内容签名布局，流式期间**绝不重排**；顶部 chips 实时汇总 ok / 失败 / 跳过、token 与用时
- 生成图可「转入编辑器」，改完手动重跑

### 模型配置页 · provider / 密钥 / 默认模型，免手改文件

- 左列 provider 台账，右侧编辑器：Base URL、API 类型、模型列表（id/显示名/推理标记）；不认识的字段（compat、headers…）原样保留
- **「＋ 内置」**：pi 内置 provider 目录（随仓库提交的快照，40 个）直接选、只填密钥——`models.json` 里只写 `{apiKey:"$VAR"}`（pi 官方挂载形态，内置 Base URL/模型原样生效）；OAuth/特殊认证型置灰（`pi auth login`），要改 URL/模型就「以此为基础自定义」换个 id
- **撞名守卫**：自建 id 撞上内置 id 且覆盖 baseUrl/models/api 等 → 保存被拦（pi 的选择性合并正是 minimax 撞名 404 事故的机制）；只挂密钥的挂载条目与磁盘上已有的覆盖条目（出 ⚠ 警告）不受影响
- 密钥只进仓库根 `.env`（gitignore）+ 进程环境，`models.json` 永远只存 `$VAR` 引用（内置 id 折到目录的 env 名——google → `$GEMINI_API_KEY`）；「测试连接」对端点发一次零 token 的列模型请求，验证 URL 与密钥
- 「应用」一键切换：主会话 `set_model` + 编排节点/AI 规划器默认 + `settings.json` 持久默认（重启后仍是它）
- pi 在启动时快照可用模型——**新增 provider / 新密钥需要勾选「重启 pi」**（对话上下文自动恢复），页面会就此提示；升级 pi 后目录快照重新生成：`node scripts/generate-builtin-providers.mjs`

## 快速开始

### 一次性环境准备

1. **Node ≥ 20 + pnpm**，仓库根目录 `pnpm install`
2. **pi CLI**：`npm install -g @earendil-works/pi-coding-agent`（Windows 上即 `pi.cmd`）
3. **模型配置**（两种方式，二选一）：
   - **页面配置（推荐）**：首次可跳过本步——启动后打开 http://localhost:5173 的「模型」tab：pi 内置的 provider（MiniMax、Moonshot、Google…）「＋ 内置」选一个、粘密钥即可；OpenAI 兼容的自建端点「＋ 新增」填 Base URL + 密钥 + 模型列表。测试连接、保存并应用，全程不碰文件。密钥明文只写入仓库根 `.env`（gitignore），`models.json` 只存 `$VAR` 引用。
   - **手写文件**：`~/.pi/agent/models.json` 定义 OpenAI 格式的自定义 provider（示例为 DeepSeek，key 走环境变量不落盘）：
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
   自定义 agent 定义放 `~/.pi/agent/agents/*.md`（编排节点的 @agent 下拉来自这里）
5. **自检**：`node scripts/check-env.mjs` —— pi / rpc / 模型 / 扩展全绿即就绪

### 日常启动

**一键（推荐）**：仓库根目录建 `.env`（已被 gitignore；也可以不建，直接在页面「模型」tab 里粘贴密钥，保存时会自动创建）：

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

浏览器打开 **http://localhost:5173**，底部输入框发任务即可（⚡ 开关切换普通对话 / 自动编排）。桥接服务根路径另挂一个独立的贪吃蛇 demo（纯演示用途，`SNAKE_DEMO=0` 可整体摘除）：http://localhost:8787/。

## 工作原理

```mermaid
flowchart LR
    UI["浏览器 · apps/web<br/>实时页 + 编排页 + 模型配置页<br/>(React 19 + React Flow)"]

    subgraph SRV["桥接服务 · apps/server（Hono + ws，:8787）"]
        BR["pi-bridge<br/>主会话管理"]
        RM["orchestrator + run-manager<br/>编排引擎 · 归档"]
        PL["planner<br/>AI 规划器"]
    end

    MAIN["pi --mode rpc<br/>主会话 agent"]
    NODES["pi --mode rpc --no-session<br/>节点 agent × N（并行上限内）"]

    UI <-->|"WebSocket 事件流/命令<br/>HTTP（会话/模型配置）"| BR
    UI -->|"run_graph / plan_run"| RM
    PL -->|"goal → 任务 DAG（流式）"| RM
    RM -->|"每节点一进程：persona + 上游产出注入<br/>超时必杀 · 失败传染 · 质量门"| NODES
    BR <-->|"stdin/stdout JSONL"| MAIN
```

**执行引擎**

- AND-join（等全部上游）、失败沿下游传染跳过（不浪费 token）、并行上限、每节点超时与进程树必杀；中止即刻生效且不留孤儿进程
- 节点质量门：输出短于阈值自动原题重跑一次、两答取长（`ORCH_MIN_OUTPUT_CHARS`）

**持久化与会话管理**

- 会话与 run 全量落盘；三份状态各司其职——**桥接归档**（视图源，`~/.pi-graph-ui/sessions/*.jsonl`）、**pi 会话文件**（上下文源，`~/.pi/agent/sessions/`）、**index.json**（两者映射 + 用户标题）。切换 = pi RPC `switch_session` 换上下文 + 归档重放重建视图，一次 `hello` 广播原子完成
- 刷新 / 断线重连自动恢复（含进行中的 run）；侧栏 ▶ 只读回放（冻结历史图，可点选看详情）不触碰当前对话

**界面工程**

- 暗色设计系统（四级海拔 + 语义色 + 统一焦点语言）
- 所有面板分界**可拖拽调宽窄**（比例记在 localStorage，双击重置，方向键可调）

## 验证 / 测试

```bash
pnpm -r test         # 407 个单测全过（shared 96 + server 311）
pnpm -r typecheck    # 全仓类型检查（web 无单测，typecheck 即门禁）

# 以下 e2e 需要桥接服务在跑（dev.mjs）且模型 key 可用，会真实调 LLM：
node scripts/e2e-smoke.mjs            # 实时页冒烟：一条真实任务 → 事件流 → 图
node scripts/e2e-orch.mjs             # 编排 e2e：2 节点链注入/归档/重放
ABORT=1 node scripts/e2e-orch.mjs     # 中止路径 + 无孤儿进程检查
PLAN=1  node scripts/e2e-orch.mjs     # AI 规划 → 同 runId 执行 → 全节点完成
CHAT=1  node scripts/e2e-orch.mjs     # PLAN 全套 + 结果注入主会话 + 整理回答 + hello 重放
node scripts/e2e-parallel.mjs         # 多路并行 e2e：4 分支扇出 + AND-join 汇聚，断言真并发（窗口重叠 + 用时缩短）
PLAN=1  node scripts/e2e-parallel.mjs # 多路并行自动编排：AI 拆图成并行 DAG → 并行执行 → 复用同一套并发断言
node scripts/e2e-gate.mjs             # 门控 HITL e2e：挂起/批准注入/驳回传染/畸形决策报错/重连重放
node scripts/e2e-reset.mjs            # 新任务重置流：图清空后可继续对话
node scripts/e2e-sessions.mjs         # 多会话 e2e：建档/切换/上下文恢复黄金断言（切回后还记得小明）/重命名/删除
node scripts/verify-sessions-ui.mjs   # 浏览器端实操（playwright-core + 本地 chromium）：侧栏切换/重命名 + 截图
```

## WS 协议

<details>
<summary>展开 server ⇄ browser 消息与只读 HTTP API</summary>

server → browser：

| 消息 | 说明 |
|---|---|
| `{type:"hello", snapshot, run?, sessionId}` | 连接建立 / `new_session` / `switch_session` 后重放世界：`snapshot` 为全部历史事件，`sessionId` 为当前会话（null = 全新会话）；有进行中/最近一次 run 时一并重放其事件 |
| `{type:"session_bound", sessionId}` | 惰性建档落定时的轻量通知（首条事件到达时广播，客户端据此刷新会话列表，无需重建视图） |
| `{type:"event", event}` | 实时会话事件（`tool_execution_update` 按 toolCallId 100ms 合并） |
| `{type:"run_event", event}` | 编排 run 事件（plan_started/delta/completed、run_started、node deltas、run_finished…，150ms 连接式合并） |
| `{type:"run_error", error}` | 编排错误（校验 issue / 引擎异常） |
| `{type:"error", message}` | 会话操作被拒（切换/新建失败原因，中文），客户端在会话栏内提示 |
| `{type:"response", response}` | RPC 响应（id 关联） |
| `{type:"pi-exit", code, stderr}` | pi 子进程退出告警 |

browser → server：

| 消息 | 说明 |
|---|---|
| `{type:"command", command:{type:"prompt"\|"steer"\|"abort"\|"new_session", ...}}` | 会话命令透传（`new_session` 由服务端接管：重置世界并广播 hello） |
| `{type:"switch_session", id}` | 恢复归档会话：守卫（非当前/空闲/pi 文件在）→ RPC `switch_session` → 归档重放 → 广播 hello（拒绝则回 error） |
| `{type:"request", command}` | 同 command 但等待标定响应 |
| `{type:"run_graph", graph}` | 运行手动编辑器里的图 |
| `{type:"plan_run", goal, chat?}` | AI 自动拆图执行；`chat:true` 完成后把节点产出注入主会话整理回答 |
| `{type:"abort_run"}` | 中止编排/规划 |
| `{type:"ping"}` | 心跳 |

HTTP API（带 CORS）：只读 `GET /api/sessions`（含 `title`/`resumable`）、`/api/sessions/:id/events`、`/api/agents`、`/api/runs`、`/api/runs/:id`、`/api/state`、`/health`；会话管理 `PATCH /api/sessions/:id`（body `{title}`，200/400）、`DELETE /api/sessions/:id`（204；400 非法 id / 404 不存在 / 409 当前活跃会话，删除归档 + 索引 + 经路径安全校验的 pi 会话文件）。

</details>

## 配置

### 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 模型 key（`.env`，gitignore） | — |
| `PI_BIN` / `PI_CWD` / `PI_ARGS` | pi 可执行文件 / 工作目录 / 额外参数 | `pi` / cwd / 空 |
| `PI_NO_SESSION` | 置 `1` 回到旧行为：主桥以 `--no-session` 运行（pi 不落会话文件，所有存档仅回放、不可恢复上下文） | 未设置（持久化多会话） |
| `PORT` | 桥接端口 | `8787` |
| `VITE_WS_URL` | 前端 WS 地址覆盖 | 同源推导 |
| `ORCH_MAX_PARALLEL` | 编排节点并行上限 | `4` |
| `ORCH_MODEL` | 编排节点默认模型 | `deepseek/deepseek-chat` |
| `ORCH_NODE_TIMEOUT_MS` | 单节点超时 | `600000`（10min） |
| `ORCH_MIN_OUTPUT_CHARS` | 节点质量门：输出短于此值触发原题重跑一次（两答取长） | `0`（关闭） |
| `ORCH_NODE_RETRY` | 质量门违规重跑开关（`0` 关闭；空输出则直接判失败） | 开启 |
| `ORCH_PLANNER_MODEL` | 规划器模型 | = `ORCH_MODEL` |
| `ORCH_PLAN_TIMEOUT_MS` | 规划超时 | `180000`（3min） |

### 节点级覆盖

`NodeDef` 可选字段（编辑器 JSON 可直接携带）：`minOutputChars` / `timeoutMs` / `outputCapBytes`（注入下游的字节预算）/ `workdir`（子进程独立工作目录，并行节点互不踩文件）/ `tools` / `excludeTools`（工具白/黑名单）。详见 `apps/server/README.md`。

## 仓库结构

```
packages/shared   # pi 事件类型 + delta 折叠器 + 图派生/编排纯函数 + 聊天时间线 + 内置模板（前后端同构，含单测）
apps/server       # Hono + ws 桥接：主会话 pi 子进程、编排引擎/规划器/节点执行器、run 与会话归档、只读 API（CORS）+ 贪吃蛇 demo
apps/web          # React 前端：实时页（聊天+图+会话侧栏）+ 编排页（编辑器+运行图）、可拖拽分栏
scripts/          # dev / check-env / stop / e2e-{smoke,orch,parallel,gate,reset,sessions} / verify-sessions-ui
docs/             # 设计与调研文档；README 截图在 docs/images/
pi/               # pi-mono 参考克隆（gitignore，仅源码参考）
```

更多文档：[`apps/server/README.md`](apps/server/README.md)（server 细节与节点执行器）· [`PLAN.md`](PLAN.md)（设计决策）· [`TESTCASES.md`](TESTCASES.md)（测试用例全集）

## 已知限制 / Roadmap

- 实时 trace 图仍每次事件全量 dagre 重排（编排图已按内容签名稳定布局），大图有跳动 → 计划做位置保持
- 同一会话多次编排只在聊天流保留最新 run 卡片（历史注入消息仍在 transcript）→ v2
- `GET /api/sessions` 每次全量读取所有归档（头几行）来取摘要，存档积累到数百个后会变慢 → 计划在 index.json 里缓存摘要
- 切换进行中到达的 pi 事件只进内存快照、不补写归档尾部（极端断电窗口可能丢一两条）→ 计划补落盘
- 导出 PNG/SVG、按节点/单价的费用统计、多会话画布未做；窄屏（<650px 宽）下面板拖动会接近下限
