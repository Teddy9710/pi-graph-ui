# PiBridge RPC 子进程桥接调研

调研对象：`apps/server/src/pi-bridge.ts`（服务端主会话 pi 子进程管理）。
参考协议文档：pi 官方 `README.md`（§RPC Mode）与 `docs/rpc.md`。
线格式定义（shared 侧）：`packages/shared/src/types.ts`（`RpcCommand` / `RpcResponse` / `JsonAgentSessionEvent`）。
广播宿主：`apps/server/src/main.ts`，事件漏斗：`apps/server/src/event-hub.ts`。

---

## 1. PiBridge 启动、send / request、事件订阅与内部等待机制

### 1.1 构造与启动（`start()`）

线序号：`pi-bridge.ts:74-114`（`start`），`:64-66`（`get running`）。

- 构造：`constructor(options)`（`:62-68`）只保存 `options`，不 spawn 进程。
- 状态字段：`proc`（子进程句柄 ）、`nextId`（自增请求 id 计数器 ）、`pending`（等待响应表 `Map<id, {resolve,reject}>` ）、`stdoutBuffer`（跨 chunk 的 JSONL 拼接缓冲 ）、`stderrTail`（最近 4KB stderr 诊断，用于 exit 报错 ）、`exited`（进程退出标志 ）。
- `running` getter（`:59-61`）：`proc !== null && !exited`。
- `start()`：
  - 已运行则空操作（幂等）。
  - bin 解析（`:82`）：Win32 默认 `pi.cmd`，否则 `pi`；可从 `options.bin` 覆盖。
  - 参数拼接（`:83-87`）：先 `extraArgs`（如 `PI_ARGS="--model ..."`），再 `--mode rpc`，末尾按 `noSession !== false` 追加 `--no-session`（pi 默认持久化会话，桥接方想自行掌控 session 生命周期）。
  - `spawn`（`:89-103`）：`cwd` 取自 `options.cwd ?? process.cwd()`；stdio 三方全 `pipe`。
  - **Windows shell 语义**（`:94-102`）：`.cmd/.bat` shim 必须经 `shell: true` 才能被 Node spawn。此时 Node 会把 argv 用空格连接成一条 cmd 命令行，因此 `shellArgs()`（`:255-260`）会对含空格的参数手动加引号，防止 cmd.exe 拆词。而用户提示词永远走 stdin 而非 argv（cmd 命令行长上限 8191 字符）。
  - 流接线：
    - stdout `data` → `onStdout`（`:105-107`）。
    - stderr `data` → 追加到 `stderrTail`（截留 4096 字符）并 `emit("stderr", chunk)`（`:108-111`）。
    - `error`（spawn 失败）→ `emit("exit", null, "spawn failed: ...")` + `cleanup()`（`:112-115`）。
    - `close`（正常/被杀）→ `rejectAllPending("pi exited with code ...")` → `emit("exit", code, stderrTail)` → `cleanup()`（`:117-121`）。

**重要语义**：源文件头部注释（`:16-19` / `:20-21`）与 `classifyLine` 共同确立了 stdout 的两种形态识别规则——`RpcResponse` 是唯一 `type === "response"` 的行；其余裸对象一律视为 `JsonAgentSessionEvent`（无信封）。

### 1.2 `classifyLine`（stdout 行解析/分流）

线序号：`pi-bridge.ts:53-70`。

```ts
if (obj && typeof obj === "object" && obj.type === "response")
    return { kind: "response", response: obj };
return { kind: "event", event: obj };
```

- 空行、非 JSON、或 JSON 但非对象 → `null`（丢弃；真实诊断走 stderr）。
- 据此把后续处理分成 event / response 两条支线。

### 1.3 `onStdout` / JSONL 缓冲与等待表解析

线序号：`pi-bridge.ts:123-137`。

- `stdoutBuffer += chunk`，`split("\n")`，末尾段保留为 `stdoutBuffer` 等下一 chunk（**严格以 `\n` 为唯一分隔符**，与 rpc.md 「Framing」一致——Node `readline` 会把 JSON 字符串内的 `U+2028/U+2029` 误当换行，故不用）。
- 每条完整行 `classifyLine`：
  - `event` → `emit("event", event)`。
  - `response` → 若 `id !== undefined`，去 `pending` 表取出 waiter：`pending.delete(id)` 后 `waiter.resolve(response)`；随后无论是否命中 waiter，都 `emit("response", response)` 广播。
- 这段是本文件的核心标定匹配点（详见 §4）。

### 1.4 写命令的两条路径：`send` vs `request`

**`send(command)` —— fire-and-forget**（`:139-143`）：

```ts
if (!this.proc || this.exited) throw new Error("pi bridge is not running");
this.proc.stdin.write(JSON.stringify(command) + "\n");
```

- 仅校验运行态并写入 stdin（JSONL，LF 结尾），不等任何回包。
- 失败通过抛异常反映（调用方如 `main.ts` 捕获后回给客户端 error 帧）。
- 无 id 注入——是否带 id 由调用方自理（如 `onChatRunComplete` 里的 `bridge.send({type:"prompt", ...})` 就不带 id）。

**`request(command)` —— 带标定响应 promise**（`:146-161`）：

```ts
const id = String(this.nextId++);
const full = { ...command, id } as RpcCommand;
return new Promise<RpcResponse>((resolve, reject) => {
    this.pending.set(id, { resolve, reject });
    try {
        this.proc!.stdin.write(JSON.stringify(full) + "\n");
    } catch (err) {
        this.pending.delete(id);
        reject(err);
    }
});
```

- 自动分配递增 `id`（`nextId`），注入后写入 stdin。
- 在 `pending` 表登记 `{resolve, reject}`，等待未来某条 `onStdout` 落回相同 `id`。
- 若写盘即抛错（如管道已断），立刻从 `pending` 撤销并 reject。
- **类型收窄**：`RpcCommandWithoutId`（`:31-37`）做分布式的 `Omit<"id">`，保证调用方不传 id（id 由 bridge 生成），同时保留可选 `id?` 字段可共存。

### 1.5 事件订阅（`event` / `response` / `exit` / `stderr`）

`PiBridge extends EventEmitter`（`:45`），对外暴露四类事件（全部经由 EventEmitter 分发）：

| 事件 | 触发处 | 载荷 | 语义 |
|------|--------|------|------|
| `event` | `onStdout` 命中 event 行（`:130`） | `JsonAgentSessionEvent` | 一次会话事件流（prompt 接受、消息增量、tool 进度等） |
| `response` | `onStdout` 命中 response 行（`:135`） | `RpcResponse` | 带 id 的命令回包（成功/失败） |
| `exit` | `start` 的 error/close（`:114,:119`） | `(code, stderrTail)`；spawn 失败时 code 为 `null` | 子进程终结，附带最近诊断 |
| `stderr` | stderr `data`（`:110`） | `string` chunk | 实时诊断（模型错误、扩展加载失败），供主流程记录 |

内部 `pending` waiter 的 resolve 与 `response` 事件广播是**并行**的两件事：申请方拿到自己的应答，同时全部监听者看到回包（见 §4）。

---

## 2. 广播语义：`bridge.on("response")` 如何转发到所有 WS 客户端

宿主在 `main.ts`。

- `onStdout` 对每条 response 行，无论是否命中 waiter，都 `emit("response", response)`（`:135`）。
- `main.ts` 注册（`:257-261`）：

```ts
bridge.on("response", (response) => {
    for (const ws of wsClients()) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "response", response }));
    }
});
```

- 访问者集合：`clients: Map<WebSocket, ClientInfo>`（`:197`），`wsClients()` 返回 `[...clients.keys()]`（`:204-206`）。
- 语义点：
  - 服务器把每一条 RPC 回包包成 WS 帧 `{type:"response", response}` **广播给所有在线的 OPEN 客户端**，而不只回给发起请求的那个连接。
  - `readyState === ws.OPEN` 守卫防止向关闭中的 socket 写入。
  - 这样任何一个客户端发起的 `request`（`{type:"request", command}`），其应答都能被任意刷新/多开的客户端看到——web 端靠 `response.id` 自己关联到请求。
- 与之对照的通用事件广播走 `EventHub`（见 `main.ts:160-163` 的 `bridge.on("event")` → `foldEvent` + `hub.ingest` + `store.append`；以及 `hub.subscribe`（`:219-221`）把事件逐帧推给每个 socket）。`response` 不经过 EventHub（不走重放与节流），是直连广播。

---

## 3. `new_session` 的竞态处理：resetSession 等 pi 确认再清状态

### 3.1 问题/原因

文档（rpc.md `new_session`）：`new_session` 清空会话，可被 `session_before_switch` 扩展取消；回包 `success:true, data:{cancelled:boolean}`。**`success:true` 只表示命令被接受/处理**，不代表旧 prompt 已清空。若客户端发 `new_session` 后**紧接着**又发 `prompt`，pi 仍旧按旧会话上下文处理该 prompt——即 prompt 的时序可能跑到 reset 生效之前，出现「prompt 被旧态吞掉 / 顺序错乱」的竞态。

### 3.2 main.ts 的解法（`:174-190`）

接线在 WS `message` 处理器内，针对 `command.type === "new_session"` 走专门分支：

```ts
if (command?.type === "new_session") {
    bridge
        .request({ type: "new_session" })
        .then((response) => {
            if (response.success) resetSession();
            else ws.send(... "new_session 失败");
        })
        .catch((err) => ws.send(... err.message));
    return;   // 立即 return，不再 fallthrough 到 bridge.send
}
```

- **改用 `request` 而非 `send`**：注入自增 id，返回 promise，等 pi 的 `onStdout` 按 id 回包后才执行后续。
- **`.then` 里才清状态**：只有当 `response.success === true`（pi 已确认新会话真正建立，旧 prompt 已被处理/排队完毕）才调用 `resetSession()`。
- `resetSession()`（`:153-159`）：

```ts
function resetSession(): void {
    hub.clear();              // 清 EventHub 重放缓冲 + 取消被节流的 tool_execution_update
    session = initState();    // 重置 fold 状态机
    store.finalize();         // 落盘归档旧 session
    for (const client of wsClients()) client.send(JSON.stringify({ type: "reset" }));
    console.log("[session] reset");
}
```

- 所有客户端收到 `{type:"reset"}` 后重建视图；`hub.clear()`（event-hub `:73-78`）同时清掉 `withheld`/`lastSentAt`/`replay`，避免旧 tool 节流定时器在新会话里误触发。
- **这就是「等 pi 确认再清状态」的实现**：状态清空（前端 `reset` 帧、hub、session、store）全部发生在 pi 的 `request` resolve 之后，从而杜绝「prompt 赶在新会话前被旧上下文吃掉」的竞态。若 pi 回 `success:false`（或子进程退出导致 reject），则把错误回给该客户端，且**不清状态**（避免丢失用户还没见到的历史）。

### 3.3 与 `resetSession` 的并发/一致性注意

- `resetSession` 是同步函数，在 promise 回调里执行，此时该 ws 连接后续的 `prompt` 仍是异步送入 `bridge.send`，但由于状态已在 pi 确认后被清空，随后的事件流（fold 到新 `session`）不会污染旧 `session`。
- EventHub `clear()` 也保证了 `hello` 重放（新连接拿到 `hub.history()`）在新会话后不会带上旧事件。

---

## 4. 标定（correlated）RPC 响应的匹配原理

### 4.1 协议约定

rpc.md：所有命令支持可选 `id` 做请求/响应关联；**若提供 `id`，对应响应 `type:"response"` 会回带相同 `id`**。（`bash_execution_update` 事件也会带其所属 `bash` 命令的 `id`，但那是事件，不参与 response 匹配。）

### 4.2 bridge 侧两处对称部件

**发送侧（request）**（`:146-161`）：

- `nextId` 自增生成唯一 `id`（`c1, c2, ...`）。
- 在 `pending.set(id, {resolve,reject})` 登记未来应答的接续。

**接收侧（onStdout）**（`:129-135`）：

```ts
const id = response.id;
if (id !== undefined) {
    const waiter = this.pending.get(id);
    if (waiter) {
        this.pending.delete(id);
        waiter.resolve(response);
    }
}
this.emit("response", response);
```

- 用响应里的 `id` 查 `pending` 表。
- 命中 → **删除**该条目并 `resolve`（一命一销，避免重复 resolve）；未命中（无对应请求，如外来/已失效 id）→ 静默跳过。
- 无论命中与否都广播 `response`（§2）。

### 4.3 匹配边界与并发性

- 匹配关键就是 `id` 字符串相等；`Map` 查询 O(1)。因为 id 由 `nextId++` 单调生成且从不复用（进程生命周期内），不会歧义。
- 多请求可并发在 `pending` 中挂起：每条命令自持 id，`onStdout` 逐一按 id 领回各自 waiter，互不干扰。
- **不设定超时**：若 pi 不回包，waiter 会一直挂着，直到进程 `close` 时 `rejectAllPending`（`:114,:119,:126-128`）统一 `reject(new Error("pi exited with code ..."))` 并 `pending.clear()` 兜底。
- **失败路径**：`success:false` 的响应同样会被 resolve（不是 reject）——rpc.md 规定命令被拒（如 parse 错误、模型不存在）回 `success:false,error`。因此调用方需检查 `response.success`（如 §3.2 的 new_session 分支就是这么做的）；只有在 pi 退出/写出错时才走 reject。

---

## 5. shutdown 时 `bridge.kill` 的清理

### 5.1 宿主关闭流程（`main.ts:288-299`）

```ts
function shutdown(): void {
    runManager.abort();       // 先终止编排：planner + 各 per-node pi 子进程（Windows taskkill 树）
    bridge.kill();            // 再杀主会话 pi
    for (const ws of wsClients()) ws.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

- 顺序：先 orchestration 层（避免子 agent 失活后再被主会话 prompt 引用），再主会话 `bridge.kill()`，最后关 WS + HTTP，双保险 `setTimeout(exit,2000).unref()` 兜底。

### 5.2 `kill()` 的深度清理（`pi-bridge.ts:163-214`）

```ts
kill(): void {
    if (this.proc && !this.exited) {
        if (this.proc.stdin.end());            // 优雅 EOF，让 pi 自行退出
        if (win32 && pid !== undefined) {
            // shell shim：proc.kill() 只会杀 shell，node 子进程会泄漏
            const killer = spawn("taskkill", ["/pid", pid, "/T", "/F"], { stdio: "ignore" });
            killer.on("error", (err) => { ...; this.proc?.kill(); });   // taskkill 失败时的兜底
        } else {
            this.proc.kill();
        }
    }
}
```

- `stdin.end()`：向 pi 发送 EOF，请求它走正常关停。
- **Windows 关键点**（`:174-208`）：主会话经 `cmd.exe` shim spawn，`this.proc` 指向 shell 而非真正跑 pi 的 node 进程。直接 `this.proc.kill()` 只会杀死 shell，**实际的 node 子进程会泄漏**继续烧 token。因此：
  - 用 `taskkill /pid <shell pid> /T /F` 递归杀掉整个进程树（`/T` 递归后代，`/F` 强制）。
  - `killer` spawn 本身也要挂 `error` 监听——否则 taskkill spawn 失败会以未处理 `error` 事件让服务器 crash。
  - taskkill 失败时回退到 `this.proc.kill()`（尽力而为）。
- **清理收敛由 `close` 事件驱动**：无论走哪条杀路径，子进程 `close` 必然触发 `start` 里注册的处理器（`:117-121`）→ `rejectAllPending`（让所有挂起 waiter 以「pi exited with code …」reject）+ `emit("exit", ...)`（宿主广播 `pi-exit` 帧给各 WS，`main.ts:165-169`）+ `cleanup()`（置 `exited=true`、`proc=null`）。此后 `running` 变 false、`send`/`request` 抛「not running」错误，bridge 状态机彻底收敛，无悬挂引用。

---

## 附：关键代码行速查

| 关注点 | 位置（极近似） |
|--------|------|
| 构造 / 状态字段 | `pi-bridge.ts:45-68` |
| `get running` | `:59-61` |
| `start()` spawn 与流接线 | `:74-121` |
| Windows shell 语义 | `:94-102`、`:255-260` |
| `classifyLine` | `:53-70` |
| `onStdout` JSONL 拼接 + 匹配 | `:123-137` |
| `send`（fire-and-forget） | `:139-143` |
| `request`（id 注入 + pending） | `:146-161` |
| `kill` / taskkill 树杀 | `:163-214` |
| `rejectAllPending` | `:126-128`、`:190-194` |
| shared `RpcCommand` / `RpcResponse` | `packages/shared/src/types.ts:242`, `:249` |
| 宿主 `bridge.on("response")` 广播 | `main.ts:257-261` |
| `new_session` 竞态（等确认再 reset） | `main.ts:174-190` |
| `resetSession()` | `main.ts:153-159` |
| EventHub 重放/节流/clear | `event-hub.ts:42-83` |
| shutdown 清理顺序 | `main.ts:288-299` |
