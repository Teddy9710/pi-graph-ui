# PiNodeExecutor 调研：每节点独立 `pi --mode rpc` 子进程

**核心文件**：`apps/server/src/pi-node-executor.ts`（280 行），配套 `apps/server/src/pi-bridge.ts`、`apps/server/src/orchestrator.ts`、`apps/server/src/run-manager.ts`、`packages/shared/src/orchestration.ts`、`packages/shared/src/fold.ts`、`packages/shared/src/types.ts`。

> 设计总纲（文件头注释，L1–26）：`PiNodeExecutor` 镜像 pi 官方 subagent fan-out 模式 —— 每节点一个 `--no-session` 内存态 pi 实例；persona 正文经**临时文件 + `--append-system-prompt`** 注入；cmd.exe 的 argv 上限 8191 字符，因此 **TASK 走 stdin RPC，绝不走命令行**。节点事件流用共享 `foldEvent` 本地折叠；完成以 **agent_settled / 进程 exit / 超时** 三方竞速，任一路径都**必杀 bridge（无孤儿进程树）**。

---

## 1. 注入方式：persona 临时文件 + 上游产出 → 节点 prompt

### 1.1 person 临时文件注入

流程在 `runOnce()` 内（L134–152）：

- 仅当 `node.agent` 存在时启用。读取 `resolvePath(this.agentsDir, `${node.agent}.md`)`（默认 `~/.pi/agent/agents`，构造函数 L119 注入）。
- 缓存未命中 → 快速失败，错误 `未找到 agent「xx」（查找目录 …）`（L139–141）。
- 写临时文件：
  ```ts
  tempDir = mkdtempSync(resolvePath(tmpdir(), "pi-orch-"));          // L145
  writeFileSync(resolvePath(tempDir, "persona.md"), personaBody(raw) + "\n", "utf8");  // L146
  ```
- `personaBody()`（L77–80）用正则 `^---\r?\n[\s\S]*?\r?\n---\r?\n?` 剥掉 YAML frontmatter，**persona = markdown 正文**。
- argv 注入：`extraArgs.push("--append-system-prompt", resolvePath(tempDir, "persona.md"))`（L170）。路径可能含空格，由 `PiBridge.shellArgs()` 给含空格参数加引号（pi-bridge.ts L166–171）。

**临时文件生命周期**：`cleanup()`（L192–204）里 `rmSync(tempDir, {recursive, force})` 兜底删除（best-effort）。

**cmd.exe 转义安全**：Windows 下 pi 是 `.cmd` shim，Node 用 shell 拉起，且 shell 参数**逐字拼接**——任何含空白的参数必须自带引号否则被 cmd 拆分。所以 persona 临时文件路径经 `shellArgs` 加引号（pi-bridge.ts L165–171）；用户文本则**永不进 argv**（走 stdin）。

### 1.2 上游节点产出 → 节点 prompt（assemblePrompt）

由 orchestrator 的 `launch()`（orchestrator.ts L224–247）调用共享纯函数 `assemblePrompt(node, upstream)`（orchestration.ts L269–283）：

```ts
export function assemblePrompt(node, upstream): string {
  if (upstream.length === 0) return node.task;
  const sections = upstream.map(({ nodeId, text, type, label, capBytes }) => {
    const { text: capped, capped: wasCapped } = truncateBytes(text, capBytes ?? MAX_INJECTED_OUTPUT_BYTES);
    const badge = EDGE_TYPE_LABELS[type ?? "input"];
    const note = label ? `（${label}）` : "";
    return `### from ${nodeId} —— ${badge}${note}\n${capped}${wasCapped ? "\n\n（输出过长，已截断）" : ""}`;
  });
  return `${node.task}\n\n---\n## 上游输入\n\n${sections.join("\n\n")}`;
}
```

要点：
- **输出是纯文本拼接**（非 base64/结构化 JSON）——任务正文在前，`## 上游输入` 区段在后，每个上游产出带确定性头 `### from <nodeId> —— <类型徽标>（<备注>）`（L267–278）。
- **截断函数 `truncateBytes`**（L230–239）：`TextEncoder().encode` 计算字节；超 `capBytes ?? MAX_INJECTED_OUTPUT_BYTES`（全局 50KB，L6）则 `TextDecoder` 从头切到预算。缺省 capBytes 来自**上游节点自己的 `outputCapBytes`**（launch() L238 传 `this.nodeById.get(uid)?.outputCapBytes`），属于上一跳的输出预算。
- 截断标记：末尾附 `（输出过长，已截断）`。

### 1.3 TASK 的 encode/解码（stdin RPC JSONL）

组装后的 prompt（含上游注入）作为 `ExecutorCall.assembledPrompt` 传给 `runOnce`，最后经 `PiBridge.request({type:"prompt", message})` 发送：

- **encode**：pi-bridge.ts `request()`（L118–140）拼 `const full = {…command, id}` 后用 `JSON.stringify(full) + "\n"` 写子进程 stdin（L137）。类型定义 types.ts L242–249 `RpcCommand = … | {type:"prompt"; message:string; …}`。
- **解码**：pi 进程在 stdout 发回 JSONL；`onStdout()` 按 `\n` 分帧（L95），`classifyLine()`（L45–61）用 `JSON.parse` 解析并区分两种线型：
  - 事件：裸 `JsonAgentSessionEvent`（无 envelope）；
  - 响应：`{id, type:"response", command, success, data}`（唯一带 `type==="response"` 的线型）——按 `id` 关联回 `pending` Map 里的 waiter（L112–118）。
- **送达错误**：`request().then()` 若 `!res.success` → `finish({ok:false, error:"prompt 被拒绝: …"})`（L276–277）；catch 则 `err.message`（L278）。**注意：这里的解码是 JSONL 协议解析，不是对 prompt 文本做 base64**——文本本身不编码，直接以 UTF-8 字符串经 JSON 序列化后落到 stdin（cmd 8191 字符限制只约束 argv，不约束 stdin）。

### 1.4 返回输出解码（finalOutput）

- 事件经共享 `foldEvent(state, ev)` 折叠进 `initState()`（与前端同一折叠逻辑，L249、L86）；
- 完成时取 `finalOutput(state)`（L64–78 / orchestration.ts `finalOutput`）：从**最后一条 assistant 消息**逆序，过滤掉 thinking 与 toolCall 块，只取 `text` 块 join + trim；
- `lastAssistant()`（L83–90）取最后一个 assistant 消息以拿 stopReason / model。

---

## 2. 三方竞争终止 + Windows 进程树必杀

### 2.1 竞速路径

`runOnce` 内 (L205–280)：提交 `bridge.start()` → `request(prompt)`，随后三个终结点哪个先到谁胜，由 `finish()` 幂等门闩保证**只落地一次**：

```ts
let settled = false;
const finish = (result: NodeResult): void => {
  if (settled) return;
  settled = true;
  cleanup();
  resolve(result);
};
```
- **agent_settled**（成功/最终路径）：`bridge.on("event")` 里 `ev.type === "agent_settled"`：
  - 若此前已折叠到 `state.lastError`（终态错误）→ `finish({ok:false, text:finalOutput, error:lastError})`；
  - 否则 `finish({ok:true, text:finalOutput(state), stopReason: last?.stopReason ?? "stop", model: last?.model, usage: usageOf(state)})`（L258–266）。
- **进程 exit**（失败路径）：`bridge.on("exit", (code, stderr))` → stderr 尾部 500 字符 + `pi 进程退出 (code xxx): <tail>`，`ok:false`（L269–272）。→ 真实失败，**不重试**（见 §3）。
- **节点级超时**（失败路径）：`timer = setTimeout(() => finish({ok:false, error:"节点超时（${timeoutMs}ms）"}), timeoutMs)`，并 `unref()`（L275–276）。timeoutMs 取 `node.timeoutMs ?? this.timeoutMs`（默认 10 分钟，L70 / L116）。
- **用户中止**（失败路径）：`ctx.signal` 的 `abort` 事件 → `finish({ok:false, error:"已中止"})`（L183/L277）。

`settled` 门闩还防「settle 后 kill() 残存 stdout 继续转发」：事件回调开头 `if (settled) return;`（L248）。

### 2.2 进程树必杀（Windows taskkill）

`cleanup()`（L192–204）在 `finish()` 每种路径都执行 `bridge.kill()`（注释：幂等，Windows 下树杀）。

`PiBridge.kill()`（pi-bridge.ts L142–163）：
```ts
kill(): void {
  if (this.proc && !this.exited) {
    try { this.proc.stdin.end(); } catch {}
    if (process.platform === "win32" && this.proc.pid !== undefined) {
      // 经 shell(.cmd shim) spawn，this.proc.kill() 只杀 shell，
      // 会 LEAK 跑 pi 的真正 node 子进程 → 必须整树杀
      const killer = spawn("taskkill", ["/pid", String(this.proc.pid), "/T", "/F"], { stdio: "ignore" });
      killer.on("error", (err) => { /* taskkill 失败兜底直接 proc.kill() */ console.error("[pi-bridge] taskkill failed:", err); this.proc?.kill(); });
    } else {
      this.proc.kill();
    }
  }
}
```
- `taskkill /pid <pid> /T /F` 强制整棵进程树（`/T` 杀子树，`/F` 强杀）并 `stdio:"ignore"`；
- **关键细节**：因为 spawn 走 shell，`this.proc.kill()` 只杀 cmd shim 外壳，真正跑 pi 的 node 子进程会泄漏，所以必须 `taskkill /T` 波及全树；
- spawn error 监听器不可省，否则 taskkill spawn 失败会以未处理 `error` 事件把服务器打崩（L154–160）；
- 状态收尾仍由子进程的 `close` 事件触发（`this.emit("exit", code, stderrTail)`，L87–91），从而驱动 executor 的 exit 终局。

---

## 3. 质量门语义（minOutputChars + salvage 重跑）

`run()` 主入口（L126–165）在调用 `runOnce` 之外再包一层质量门。

### 3.1 判定/触发顺序

1. `minChars = call.node.minOutputChars ?? this.minOutputChars`（L129），`<=0` 则直接 `runOnce` —— 门关闭 = 严格 pre-profile 行为（L130）。
2. 首次 `runOnce`；`!first.ok` 直接返回 —— **真实失败（进程退出/超时/拒绝/中止）绝不 salvage**（L132：同一环境同一结果，重跑无意义）。
3. 取 `len = first.text.trim().length`；`len >= minChars` 达标 → 返回 first（L133–134）。
4. `!this.salvageRetry`（`ORCH_NODE_RETRY=0` 关闭时）：**只对真正空输出（`len===0`）判失败** `输出为空（质量门 N）`；短但非空则原样保留（L135–140）。
5. `ctx.signal.aborted` → 直接返回 first —— **中止后绝不重试**（L141）。
6. **salvage**：重跑一次，**用原题（不变），两答取较长者**（L143–165，见下）。

### 3.2 salvage 重跑 + 重跑标记 + attempts

```ts
ctx.onDelta("text", `\n\n—— 输出仅 ${len} 字符（< 质量门 ${minChars}），用原题重跑一次 ——\n\n`);  // L149 预览流标记
const second = await this.runOnce(call, ctx);                                            // L150
const pick = second.ok && second.text.trim().length > len ? second : first;              // L152 取两答较长者
if (pick.text.trim().length === 0) {
  return { ok: false, text: "", error: `两次输出均为空（质量门 ${minOutputChars=${minChars}}）` }; // L156 两次空出口判失败
}
return { ...pick, attempts: 2 };   // L159 node_completed 的 attempts:2
```

要点：
- **重跑标记**走 delta 流（`onDelta("text")`），让预览端看到节点为何「抽动」，与 planner 的「第 N 次规划无效」同构（L146–148 注释）。该 delta 经 engine.onDelta → `node_delta` 事件 → client 预览；其文本被 `foldRunEvent` 追加到 `node.preview`。
- **两答取较长者**：只在 `second.ok` 且 `second.text.trim().length > len` 时用 second，否则保留 first。
- **attempts 字段**：全局返回 `{...pick, attempts: 2}`；orchestrator `complete()` 只在 `r.attempts !== undefined` 时把它并入 `node_completed.output.attempts`（orchestrator.ts L291–299）；foldRunEvent 存到 `node.attempts`（前端可显示「重跑一次」徽标）。类型定义 L78 / orchestration.ts `RunEvent.node_completed.output.attempts`。
- **两次空出口**：`pick.text.trim().length === 0` 判失败 —— 覆盖「第一次空、第二次空/第一次即失败」两种，错误 `两次输出均为空…`。
- **中止后绝不重试**：L141 前置 `ctx.signal.aborted` 短路；但若重跑进行中被中止，第二次 `runOnce` 会走 abort 终局 `ok:false`，此时 `pick = first`（second 非 ok），于是仍返回 first。

---

## 4. 节点能力档案字段传入子进程

构造 `extraArgs` 逻辑在 `runOnce` L168–179。

| 字段 | 传播方式 | 代码行 |
|---|---|---|
| **model** | `extraArgs.push("--model", node.model ?? this.defaultModel)`；默认 `"deepseek/deepseek-chat"`（L119） | L168 |
| **minOutputChars** | **不进 argv**，仅本地质量门（见 §3） | L129 |
| **timeoutMs** | **不进 argv**，本地 `setTimeout`；`node.timeoutMs ?? this.timeoutMs`；校验约束 1000–86400000ms | L174/L275 |
| **outputCapBytes** | 不进 argv —— 作用于**下游**的 `assemblePrompt`/`buildSynthPrompt` 注入预算（launch() L238；orchestration.ts 注释 L42–49）；存档输出本身不截断 | orchestrator L224–247 |
| **workdir / isSafeWorkdir** | `bridgeCwd = resolvePath(this.cwd, node.workdir)`，先 `mkdirSync(recursive)` 再作 spawn cwd（L154–166）。**隔离约束**：`isSafeWorkdir`（orchestration.ts L78–94）只允许服务目录内相对路径（≤200 字符、无 `\`、无 `:`、不以 `/` 开头、无空/`..` 段）；executor 再 `resolve()` + 包含性检查兜底（L158–164：越界报 `workdir「..」越界`）。隔离动机：并行节点共享 cwd 会互相踩文件 | L154–166 |
| **tools** | `node.tools?.length && extraArgs.push("--tools", node.tools.join(","))` —— **严格 allowlist** | L172 |
| **excludeTools** | `extraArgs.push("--exclude-tools", node.excludeTools.join(","))` —— allowlist 之后的 denylist | L173 |

- **cmd 安全**：工具名与 model 都经 RE 预校验（`TOOL_NAME_RE` / `MODEL_RE`，orchestration.ts L44–51、L98–117），逗号拼接后不含 cmd 元字符，可安全作单个 argv 项。executor 仍对 model 做二次 `MODEL_RE` 兜底（runOnce L129–132，`model「..」含非法字符`）。
- 各字段上限（validateGraph）：minOutputChars 0–1e6、timeoutMs 1000–86400000、outputCapBytes 1–1e6、tools/excludeTools ≤32 项（orchestration.ts L151–176）。

---

## 5. node_group / node_delta → run-manager 150ms 连接式合并

`node_delta` 事件在 **RunManager.retain()** 中做窗口合并（run-manager.ts L251–285）：

- 无真正的 `node_group` 类型；这里的「合并」指 `node_delta` 的 **150ms 连接式(coalesce)批处理**。
- `deltaIntervalMs` 默认 **150**（构造 L79 `options.deltaIntervalMs ?? 150`）。
- 结构：`deltaBuffers: Map<nodeId, {runId, text}>` + `deltaTimers: Map<nodeId, timer>`（L46–48）。`retainEvent`——实际函数名 `retain`（L251）:
  ```ts
  if (event.type === "node_delta") {
    const prev = this.deltaBuffers.get(event.nodeId);
    this.deltaBuffers.set(event.nodeId, {
      runId: prev?.runId ?? event.runId,          // 保留最初 runId
      text: (prev?.text ?? "") + event.delta,      // 连接式 CONCATENATE，非 latest-wins
    });
    if (!this.deltaTimers.has(event.nodeId)) {
      const timer = setTimeout(() => this.flushNode(event.nodeId), this.deltaIntervalMs);
      timer.unref?.();                             // 不因合并窗口挂起进程
      this.deltaTimers.set(event.nodeId, timer);
    }
    return;
  }
  ```
- **结构事件优先 flush**：遇到 `node_completed / node_failed / node_skipped` 先 `flushNode(nodeId)` 再发该事件，保证 **delta 严格先于终态事件**（L266–268）；`run_finished` 则 `flushAllDeltas()`（L269）。
- `flushNode`（L288–297）：清 timer，取出 buffer，发一条合并后的 `node_delta`（`runId` 保留**该缓冲首次到达时**的 runId，避免 settle 后尾流被盖章为下个 run）。
- `flushAllDeltas` 在 run 结束时（`.finally` L135、`nextRunId` L120）强制冲刷，确保收尾无残留。

`kind` 合并成 `"text"`（tool delta 也并入 text 流，preview 统一按文本追加；type `node_delta.kind` 在 `foldRunEvent` 均进 `node.preview`，orchestration.ts L411–416）。

---

## 附：关键代码行索引（行号以当前文件为准）

| 关注点 | 文件:行 |
|---|---|
| 整体设计注释 | pi-node-executor.ts: L1–26 |
| persona 临时文件写入 | runOnce L145–146 |
| personaBody 去 YAML | personaBody L77–80 |
| agent 缺失快速失败 | L139–141 |
| `--append-system-prompt` | L170 |
| workdir resolve+containment | L154–166 / L158–164 |
| model/tools/excludeTools argv | L168–173 |
| 质量门 run() 主流程 | L126–165 |
| 重跑标记 delta | L149 |
| attempts:2 | L159 |
| foldEvent/initState/news | L86/L249/L289 / orchestration.ts finalOutput L64–78 |
| settled 竞速 finish() | L205–222 / L258–266(L266?) |
| exit 失败路径 | L269–272 |
| 超时 | L275–276 |
| abort 路径 | L183 / L277 |
| taskkill 树杀 | pi-bridge.ts L142–163 |
| stdin JSONL encode | pi-bridge.ts request L118–140 |
| stdout 解码 classifyLine | L45–61 / onStdout L93–120 |
| assemblePrompt | orchestration.ts L269–283 |
| truncateBytes | orchestration.ts L230–239 |
| isSafeWorkdir | orchestration.ts L78–94 |
| node_delta 150ms coalesce | run-manager.ts retain L251–285 / flush L288–297 |
| node_delta 结构事件 flush | L266–269 |
| delta 连接式 CONCATENATE | L254–263 |
| RpcCommand 类型 | types.ts L242–249 |
| NodeResult.attempts | orchestration.ts L60–66(approx) |

> 补充说明：调研中无独立「node_group」事件，模型将 delta 统一为 `node_delta` 并按 nodeId 连接式缓冲；「group」若指上游注入分组，则为 §1.2 的 `assemblePrompt` 区段头，属注入层而非运行期事件。
