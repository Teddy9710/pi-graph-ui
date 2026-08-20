# pi-graph-ui

把一个 [pi coding agent](https://github.com/badlogic/pi-mono) 会话的完整动作过程**实时可视化成图**：主 agent 是根节点，每次工具调用是一个节点，调研任务中并行 spawn 的多个子 agent 及其汇总过程在 React Flow 画布上展开为扇出与汇聚。不是 DAG 编排引擎，而是 **agent trace 的实时图渲染器**。

```
Browser (React + React Flow)  ⇄  WebSocket  ⇄  Node 桥接服务  ⇄  stdin/stdout JSONL  ⇄  pi --mode rpc
```

## 仓库结构

```
packages/shared   # pi 线上事件类型 + delta 折叠器 + 图派生纯函数（前后端同构，含单测）
apps/server       # Hono + ws 桥接：pi rpc 子进程管理、事件节流、快照重放、命令透传
apps/web          # React Flow 画布：7 种节点组件、dagre 自动布局、详情面板、自动重连
scripts/          # dev.mjs 一键启动 / check-env.mjs 环境自检 / e2e-smoke.mjs 冒烟
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
   自定义 agent 定义放 `~/.pi/agent/agents/*.md`（frontmatter 不写 `model` 则继承主会话模型）
5. **自检**：`node scripts/check-env.mjs` —— pi / rpc / 模型 / 扩展全绿即就绪

## 日常启动

**一键（推荐）**：仓库根目录建 `.env`（已被 gitignore）：

```
DEEPSEEK_API_KEY=sk-...
```

然后：

```bash
node scripts/dev.mjs        # 同时起 :8787 桥接 + :5173 前端，Ctrl+C 全退
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

环境变量：`PI_BIN`（pi 可执行文件）、`PI_CWD`（agent 工作目录）、`PORT`（桥接端口，默认 8787）、`VITE_WS_URL`（前端 WS 地址覆盖）。

## 验证 / 测试

```bash
pnpm -r test         # 27 个单测（shared 21 + server 6）
pnpm -r typecheck    # 全仓类型检查
node scripts/e2e-smoke.mjs           # 对运行中的桥接发一条真实任务，校验事件流→图
node scripts/e2e-smoke.mjs "你的任务" # 自定义 prompt
```

## WS 协议（server → browser）

| 消息 | 说明 |
|---|---|
| `{type:"hello", snapshot:[...]}` | 连接建立即重放全部历史事件（断线重连后前端从零重建） |
| `{type:"event", event}` | 实时事件（`tool_execution_update` 按 toolCallId 100ms 合并） |
| `{type:"response", response}` | RPC 响应（id 关联） |
| `{type:"pi-exit", code, stderr}` | pi 子进程退出告警 |

browser → server：`{type:"command", command:{type:"prompt"\|"steer"\|"abort", ...}}`

## 已知限制 / Roadmap

- 节点位置每次事件全量重排（dagre），大图会有跳动 → 计划做位置保持
- 历史会话回放（读取 `~/.pi/agent/sessions/` JSONL）未做
- 导出 PNG/SVG、token 费用统计、多会话画布未做
