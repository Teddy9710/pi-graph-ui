# pi-graph-ui 测试用例（M-C 对话式编排）

覆盖范围：实时页「对话为主」布局、聊天面板、⚡ 自动编排、编排卡片与结果注入、服务端注入管线、失败/中止路径、历史回放与恢复、安全边界、人工门控（HITL）。

每条用例均从源码提取并经对抗性复核（预期结果与代码行为逐条核对，`代码` 列为依据位置）。

## 使用说明

**优先级**：P0 = 冒烟/核心路径（每次发版必测）；P1 = 重要功能与边界；P2 = 低频/极端场景。

**类型**：
- `手测` — 浏览器可观察，按步骤操作核对预期；
- `契约` — 内部契约（时序/守卫/容错），需单测或 e2e 覆盖，标注「已自动化」的无需手测。

**环境准备**：

```bash
node scripts/dev.mjs          # 启动 dev 栈：server :8787 / web :5173（Ctrl+C 全停）
node scripts/stop.mjs         # 兜底清理：dev.mjs 被硬杀后残留的 server/vite（pidfile + 端口扫描）
# 浏览器打开 http://localhost:5173
pnpm -r test                  # 全部单测（shared 95 + server 142）
pnpm -r typecheck             # 三个包类型检查
node scripts/e2e-orch.mjs     # e2e 三模式：默认 chain / PLAN=1 / CHAT=1（可选 ABORT=1）
node scripts/e2e-gate.mjs     # 门控 e2e：挂起 → 非法决策四连拒 → 批准注入下游 → 归档/重放/孤儿
```

**自动化覆盖现状**（与本文件的「契约」类对应）：

| 层 | 内容 | 状态 |
|---|---|---|
| shared 单测 95 | chat.test 15（时间线合并/sentinel 识别）、orchestration.test 59（validateGraph 含节点能力档案与门控规则/assemblePrompt/buildSynthPrompt/capBytes 截断/label 防伪造/fold attempts/门控事件折叠与长效计数）、fold 13、graph 8 | ✅ 全绿 |
| server 单测 142 | run-manager 25（含 chat 钩子 6 条 + 门控备注防伪造）、planner 30（label 归一 + 能力档案归一 + 风险门控提取/降级/防伪）、orchestrator 22（含 attempts/capBytes/门控挂起·决策·中止·槽位旁路）、pi-node-executor 14（质量门 salvage/超时/workdir/工具档案）、session-store/snake/bridge 等 | ✅ 全绿 |
| e2e | chain（注入/归档/重放）、PLAN（规划全流程；**规划器若自提门控自动放行**，门控全契约归 GATE 模式）、CHAT（sentinel 注入+整合回复+hello 重放）、**GATE（挂起→4 类非法决策仅回请求方→批准备注注入下游→归档/重放）**；ABORT 模式孤儿检查为 **PID 集合快照差**（基线之前存在的进程不计泄漏，PowerShell 查询失败即报错不静默通过） | ✅ 四模式绿 |
| web | 仅 typecheck（无组件测试）→ 本文 MC-CHAT / MC-BAR / MC-LAY 的手测用例即为 Web 层主要防线 | ⚠️ 靠手测 |

---

## 1. 布局与导航（MC-LAY）

| 编号 | P | 类型 | 前置 | 步骤 | 预期 | 代码 |
|---|---|---|---|---|---|---|
| LAY-01 | P0 | 手测 | 已连接，非历史回放 | 打开实时页观察主区 | ①主区左列为聊天面板（`.pg-chat` flex:1 占满剩余宽度）；②右列 `.pg-side` 固定 400px 不可压缩（flex-shrink:0），纵向排列带左分隔线；③**默认整列为迷你实时图**（节点详情不常驻、无占位文案）；④点击节点后右列上方**按需**出现详情面板（`.pg-side .pg-panel` 覆盖 width:auto、flex:1 1 55%），迷你图压至 45%；再点节点或 × 关闭后恢复 | App.tsx 实时页布局, app.css:459-510 |
| LAY-02 | P0 | 手测 | 实时页非回放 | 观察右列迷你图；逐步压缩窗口高度 | ①`.pg-mini` 为右列唯一子项时占满整列高度；与详情并存时 55/45 分配且 **min-height:160px**——窗口再矮也不被压没；②顶部有「实时图」小标题（大写样式）；③画布容器 flex:1+min-height:0，ReactFlow 填满剩余高度；④详情挂载时与迷你图间有 1px 分隔线 | App.tsx 实时页布局, app.css:480-503 |
| LAY-03 | P0 | 手测 | 未选中任何节点，迷你图已有节点 | 点击迷你图节点观察右列；点面板 ×；再点该节点 | ①点击前右列无详情面板（仅迷你图）；②点击后详情面板按需挂载于迷你图上方：状态圆点、kind、node id 与右上 × 按钮；③按 kind 渲染详情（session/agent-tool→JSON、user/assistant→消息体、tool→args/result、agent→子代理结果）；④× 或再点节点→select(null)→面板卸载、迷你图恢复整列；⑤selectedNodeId 全局联动 | App.tsx 实时页布局, GraphCanvas.tsx:83-85, DetailPanel.tsx |
| LAY-04 | P1 | 手测 | 迷你图有选中节点 | 再次点击同一节点 | 取消选中（select(null)），**详情面板卸载**（不显示占位文案），迷你图恢复整列 | GraphCanvas.tsx:84 |
| LAY-05 | P1 | 手测 | 迷你图有选中节点 | 点击画布空白处 | selectedNodeId 置 null，详情面板卸载、迷你图恢复整列 | GraphCanvas.tsx:93 |
| LAY-06 | P1 | 契约 | 会话流式运行中 | 发送触发多节点的任务，观察迷你图视口 | ①节点数变化触发 fitView（对比 lastCount）；②fitView 延迟 50ms、动画 300ms、padding 0.15；③节点数不变（仅状态更新）时视口不重置 | GraphCanvas.tsx:73-81 |
| LAY-07 | P2 | 手测 | 迷你图已渲染 | 迷你图内滚轮缩放、拖节点、操作小地图 | ①缩放范围 0.15–2；②MiniMap 可拖可缩放；③节点拖拽禁用（nodesDraggable=false）、边不可选中 | GraphCanvas.tsx:94-101 |
| LAY-08 | P2 | 手测 | 有 spawn 边与运行中节点 | 观察边样式 | ①目标节点 running 时入边加 pg-edge-live、animated、箭头 #3b82f6、CSS 加粗 2.5px；②spawn 边虚线(6 4) #7ba4e0 且 smoothstep；spawn 边目标 running 时双 class——描边变蓝但虚线保留；③普通边 #9aa3b5 为**贝塞尔曲线**（default 类型，非直线）；④所有边带闭合箭头且颜色随边 | GraphCanvas.tsx:48-71, app.css:157-178 |
| LAY-09 | P1 | 手测 | 已连接 | 点头部「编排」tab 再点「实时」 | ①主区整体替换为编排页，tab active 样式；②切回实时回到对话布局；③tab 为本地 state，切换不触发重连 | App.tsx:44-49, 207-209 |
| LAY-10 | P2 | 手测 | 可控连接状态 | 观察 header 连接点四态 | ①open→「● connected」绿；②connecting→「● connecting…」琥珀；③closed→「● disconnected」红；④reconnecting→「● reconnecting…」（无专用颜色规则，默认前景色） | App.tsx:33-40, app.css:44-55 |
| LAY-11 | P2 | 手测 | pi 子进程异常退出 | 观察 header 错误横幅并悬停 | ①红色「pi exited (code N) — 检查 bridge server」（code 缺省显示 ?）；②悬停见 stderr 尾部 500 字符；③lastError 截前 80 字符，回放模式下隐藏 | App.tsx:71-76, store.ts:226-228 |
| LAY-12 | P2 | 手测 | 会话产生 token 用量 | 观察 header 用量 | <1000 原样显示；≥1000 为 x.xk；≥1e6 为 x.xM | App.tsx:18-22, 66-68 |
| LAY-13 | P1 | 契约 | ⚡ 编排发起 | plan_started 事件到达后查看编排页 | 编排页强制切到 run 视图并清空编辑器节点/边选中（影响聊天卡「查看编排 →」落地后的视图） | orch-store.ts:368-370 |

## 2. 普通对话（MC-CHAT）

| 编号 | P | 类型 | 前置 | 步骤 | 预期 | 代码 |
|---|---|---|---|---|---|---|
| CHAT-01 | P0 | 手测 | 会话无消息且无进行中编排 run | 打开实时页观察聊天列；发一条消息再观察 | ①空时显示灰色提示「对话还没有开始——在下方输入框发第一条消息，或打开 ⚡ 直接用自动编排。」；②时间线有任一条目（哪怕仅一张编排卡）文案即消失（items.length===0）；③顶部固定小号大写标题「对话」；④**「＋新任务」reset 后仅当 orch run 也为 idle 时才回空态**——若此前有已完成的编排 run（status 停留 completed），清空消息但编排卡残留（见 KNOWN-1） | ChatPanel.tsx:114,121, store.ts:192-196 |
| CHAT-02 | P0 | 手测 | — | 输入多行文本发送；再发超长无空格串 | ①用户消息为右侧蓝色气泡（蓝底白字、右对齐）；②字符串原样显示不 trim，换行按 pre-wrap 保留；③超长无空格按 overflow-wrap:anywhere 折行，气泡最大宽 92% | ChatPanel.tsx:29-31, chat.ts:43-46, app.css:532-559 |
| CHAT-03 | P1 | 手测 | 消息含图片块 | 发带图片消息；发纯图片消息 | ①文本块与「[图片]」占位按顺序用 \n 拼接；②纯图片只显示「[图片]」 | chat.ts:43-46 |
| CHAT-04 | P0 | 手测 | assistant 回复含多段内容 | 提问使回复含 thinking/toolCall/多段 text | ①气泡只拼 text 块，thinking/toolCall 不出现；②多 text 块以 \n 连接；③结果 trim（与用户消息不 trim 对照） | chat.ts:72-79, ChatPanel.tsx:32-35 |
| CHAT-05 | P0 | 手测 | 回复只有工具调用无文本 | 触发纯工具调用的回复 | 已完成且空文本→灰色「（无文本回复）」；流式中空文本→不显示该提示 | ChatPanel.tsx:35 |
| CHAT-06 | P0 | 手测 | 流式回复中 | 观察气泡尾部；等完成再看 | ①流式条目尾部绿色方块光标 1s steps(2,start) 闪烁；②光标 aria-hidden；③完成后消失 | ChatPanel.tsx:36, app.css:567-580 |
| CHAT-07 | P0 | 手测 | 回复含工具调用 | 触发含 2 次工具调用的回复；再触发纯文本回复对照 | ①气泡下方「🔧 N 个工具调用」小字（N=toolCall 块数）；②N=0 时该行不渲染；③流式草稿同样实时计数 | ChatPanel.tsx:38, chat.ts:118,132 |
| CHAT-08 | P1 | 契约 | — | 单测：assistant 消息塞 thinking+text 块 | ①thinking 过滤出 text；②hasThinking 正确置位（完成与流式两路径）；③渲染层不消费 hasThinking（纯数据标记）。**已自动化**（chat.test） | chat.ts:73-76,119,133 |
| CHAT-09 | P0 | 手测 | 会话有工具执行回显 | 触发若干工具调用 | toolResult 消息在时间线完全跳过、不产生条目（内容由图画布展示） | chat.ts:96-124 |
| CHAT-10 | P0 | 手测 | 内容超可视高度 | 发消息触发长回复，不碰滚动条 | items 变化且处于跟随态时自动贴底；流式每次增长都跟随 | ChatPanel.tsx:105-110 |
| CHAT-11 | P0 | 手测 | 内容超长有滚动条 | 流式中上滚明显距离；再滚回底部 | ①距底 >40px 停止跟随（新内容不拽视口）；②≤40px 恢复跟随；③恰好 40px 仍算跟随（<=） | ChatPanel.tsx:104-119 |
| CHAT-12 | P0 | 契约 | — | 审查订阅选择器 | ①ingest() 每事件浅拷贝 session 对象但 messages 数组引用永不变；②ChatPanel 必须订阅 `s.session`（对象）——订阅数组会漏 message_end 追加（用户气泡迟到）；③时间线 useMemo 依赖 [session, run]。**防回归契约，已自动化**（chat.test 订阅语义注释） | ChatPanel.tsx:88-102, store.ts:74-81 |
| CHAT-13 | P2 | 契约 | 流式异常结算 | 构造 agent_settled 而无 message_end | streamingAssistant 被清、草稿条目与光标直接消失、该回复不进入 messages（消息丢失）。与 message_end 正常接替路径不同 | fold.ts:260-264 |
| CHAT-14 | P2 | 契约 | 同毫秒连发两条同角色消息 | 构造同 ts 两条 user 消息 | 消息 key 为 `role:timestamp`——同毫秒同角色产生重复 React key（渲染边界行为，无崩溃） | fold.ts:125-130 |
| CHAT-15 | P2 | 契约 | 注入卡已展开 | hello 重放/状态变化 | injected 条目 key 含数组下标（`inj:${index}:${id}`），重放下标变化时 key 变、React 重挂载 details——用户已展开的注入卡折叠回去 | chat.ts:104 |

## 3. 输入栏与 ⚡ 开关（MC-BAR）

| 编号 | P | 类型 | 前置 | 步骤 | 预期 | 代码 |
|---|---|---|---|---|---|---|
| BAR-01 | P0 | 手测 | 实时页非回放 | 点 ⚡ 开启→复查；再关闭→复查 | ①开启 class 加 pg-bolt-on（蓝），aria-pressed=true，title「⚡ 开启中：发送的内容将作为编排目标」；②关闭恢复，title「开启 ⚡ 自动编排：发送目标 → 自动拆图执行 → 结果整理回对话」；③任何状态都不 disabled；④切换不清空已输入文字 | App.tsx:98-99,146-153 |
| BAR-02 | P0 | 手测 | ⚡OFF | 会话空闲时看 placeholder；运行中再看 | idle→「给 pi agent 发一个任务…」；running→「运行中… 输入内容可插入转向指令 (steer)」；input 始终不禁用 | App.tsx:120-126 |
| BAR-03 | P0 | 手测 | ⚡ON | 无编排时看 placeholder；编排 planning/running 时再看 | 无编排→「描述一个目标，⚡ 自动拆图编排并执行…」；busy→「编排进行中… 可中止后重新发起」（仍可输入文字，不禁用 input） | App.tsx:110,120-126 |
| BAR-04 | P0 | 手测 | ⚡ON 无编排 | 输入目标按 Enter（或点「⚡ 编排」） | ①提交后输入框清空；②不走 steer/sendPrompt；③**会话 running 时同样允许发起**（bolt 分支不检查 running，注入靠 pi 队列排队）；④纯空格 Enter 静默无动作 | App.tsx:128-142 |
| BAR-05 | P0 | 手测 | ⚡ON 编排 busy | 输入文字反复按 Enter | ①无任何提交（orchBusy 分支静默 return）；②**文字完整保留不被清空**；③无错误提示；④此时尾部只渲染「⏹ 中止编排」——「⚡ 编排」按钮被整体替换而非置灰，该静默守卫仅 Enter 路径可达 | App.tsx:131-134,170-177 |
| BAR-06 | P0 | 手测 | ⚡OFF 会话 running | 输入文字按 Enter | 走 steer（转向）非 sendPrompt；提交后清空；纯空格静默 | App.tsx:136-141 |
| BAR-07 | P0 | 手测 | ⚡OFF 会话空闲 | 输入文字按 Enter / 点 send | 走 sendPrompt；提交后清空；纯空格静默 | App.tsx:138-141 |
| BAR-08 | P0 | 手测 | 中文拼音输入法 | 组字状态按 Enter 选词；组字结束后再按 Enter | ①isComposing 期间 Enter 不提交不清空（Safari 选词 Enter 同样被拦）；②组字结束后 Enter 正常提交 | App.tsx:163-168 |
| BAR-09 | P1 | 手测 | 各状态 | 观察「＋ 新任务」显隐；点击它 | ①仅 !running && !bolt 时显示（与输入框是否有字无关），title「清空当前会话，开始全新任务（pi 上下文一并重置）」；②点击发 new_session，服务端确认后广播 reset，客户端清空 session/graph/选中/piExit；③点击不清输入草稿 | App.tsx:154-158, store.ts:83-85,192-195 |
| BAR-10 | P0 | 手测 | 可控 bolt/running/orchBusy | 构造五组合观察尾部按钮 | ①orchBusy&&bolt→「⏹ 中止编排」(danger)；②bolt&&!orchBusy→「⚡ 编排」（空白或纯空格时 disabled）；③!bolt&&running→abort(danger)；④!bolt&&!running→send（空白 disabled）；⑤优先级：⚡ON 且会话 running 且编排空闲→显示⚡编排非 abort；⚡ON 且编排 busy→即使会话也在运行仍显示 ⏹ | App.tsx:170-193 |
| BAR-11 | P0 | 手测 | 编排 planning/running | 点「⏹ 中止编排」 | ①无确认弹窗直接发 abort_run，可反复点击；②abortRun 不改任何本地状态；③⏹ 按钮与 busy placeholder 不立即消失，等服务端 run 事件回包翻转 | App.tsx:170-173, orch-store.ts:304 |
| BAR-12 | P1 | 手测 | 编排运行中，⚡OFF | 编排期间输入文字按 Enter（会话 idle/running 各一次） | orchBusy 只在 bolt 分支检查：⚡OFF 时照常 running→steer / idle→sendPrompt；编排不受影响；提交后照常清空 | App.tsx:131-140,178-192 |
| BAR-13 | P0 | 手测 | 历史回放模式 | 观察底部输入栏；点「返回实时」 | ①回放时 footer 只有禁用 input，placeholder「正在查看历史回放，返回实时后可继续对话」；②⚡/＋新任务/send 等全不渲染；③返回实时后完整输入栏恢复 | App.tsx:112-118,54-56 |
| BAR-14 | P1 | 手测 | ⚡ON 或有草稿 | 切到编排 tab 再切回 | ①编排 tab 下整个输入栏不渲染；②切回后 ⚡ 重置为 OFF、草稿丢失（组件卸载丢 state） | App.tsx:98-99,207-237 |
| BAR-15 | P2 | 手测 | 编排运行中 | 关闭 ⚡ 观察按钮；再重开 | ①关 ⚡ 后退回普通聊天模式（send/abort），从输入栏无法再中止该编排（⏹ 仅 orchBusy&&bolt 渲染）；②重开 ⚡ 后 ⏹ 再次出现 | App.tsx:146-153,170 |
| BAR-16 | P0 | 契约 | — | 直调 planRun 于 busy/空目标 | ①run running/planning 时直接 return 不发 WS；②goal 纯空白同样 return（与 PromptBar 先 trim 构成双层保险）；③被拒调用不消耗 1s 防重窗口。**已自动化**（orch-store 契约） | orch-store.ts:306-312, App.tsx:129 |
| BAR-17 | P0 | 契约 | — | 连续两次 planRun（同毫秒/999ms/1001ms/切 tab 后） | ①1000ms 内的后续调用静默 return；②lastPlanSentAt 为模块级变量，跨挂载不清零；③窗口内被拦的调用不误清上次的 orchError（拦截发生在 set({orchError:null}) 之前） | orch-store.ts:33-37,311-313 |
| BAR-18 | P0 | 契约 | — | 捕获 WS 出站 plan_run 消息 | ①PromptBar 固定 {chat:true}；②store 规范化 chat: opts?.chat===true（非 true→false，不出 undefined）；③消息体 {type:"plan_run", goal(trim后), chat}；④本地无长度截断（超长目标原样整体发送，服务端拦） | App.tsx:135, orch-store.ts:309,314-315 |
| BAR-19 | P1 | 契约 | — | planRun 后立即读 run.status | ①planRun 只清 orchError+sendWs，不本地置 busy；②plan_started 回包才翻状态、切 run 视图、清选中；③往返窗口内 orchBusy 仍 false，重复提交仅由 1s 守卫兜底 | orch-store.ts:313-315,368-369 |
| BAR-20 | P0 | 契约 | — | idle 时调 abortRun；连点两次 | ①abortRun 仅 sendWs({type:"abort_run"})，任何状态可发、无本地守卫、不改本地状态；②可重复发送（每次点击一条） | orch-store.ts:304 |
| BAR-21 | P1 | 契约 | — | 注入 run_error 信封 | ①orchError={message,issues}，message 缺省回退 "run failed"、issues 非数组回退 []；②下一次通过守卫的 planRun 发送前清为 null；③**run_error 不改变 run.status**（卡片状态不变，见 CARD-18） | orch-store.ts:313,376-379 |
| BAR-22 | P1 | 契约 | 会话 running + ⚡ON | 发起编排等完成 | 注入 prompt 依赖 pi 队列排在当前轮次之后（queue_update 既有机制），无需等会话空闲 | App.tsx:91-93,131-135 |
| BAR-23 | P2 | 契约 | 竞态窗口 | 渲染 send 后 agentStatus 翻 running 不重渲染，点 send | send 按钮 onClick 直连 sendPrompt 绕过 submit 的 running→steer 判断（竞态窗口内作为新 prompt 发送）。已知接受项 KNOWN-3 | App.tsx:182-192 |
| BAR-24 | P2 | 手测 | 任意状态 | 按 Shift+Enter / Ctrl+Enter | onKeyDown 只判 e.key==="Enter"——修饰键组合同样触发提交（单行输入无换行语义） | App.tsx:167 |
| BAR-25 | P2 | 契约 | WS 非 OPEN | 断连时输入文字按 Enter / 点 send | send 静默丢弃消息，但 Enter/send 点击仍执行 setText("")——**消息未发出而草稿被清空**。已知接受项 KNOWN-4 | store.ts:65-67, App.tsx:141,188 |
| BAR-26 | P1 | 契约 | — | busy/校验不过时调 runGraph | 与 planRun 守卫对称：busy 直接 return、issues 非空不发、发送前清 orchError、不本地置 busy（run_graph 回包翻转） | orch-store.ts:295-302 |

## 4. 编排卡片与注入卡（MC-CARD）

| 编号 | P | 类型 | 前置 | 步骤 | 预期 | 代码 |
|---|---|---|---|---|---|---|
| CARD-01 | P0 | 手测 | ⚡ 编排完成注入后 | 查看聊天流中注入消息 | ①不显示为用户气泡，而是左侧竖线卡片；②`<details>` 默认折叠，summary「⚙ 编排结果已注入会话（N 节点）」（N=meta.nodeCount）；③可展开/再折叠 | ChatPanel.tsx:43-53, chat.ts:98-108, app.css:623-638 |
| CARD-02 | P1 | 手测 | 注入卡有 goal | 分别用 >30 字、恰好 30 字、≤30 字的 goal | summary 追加「 — 」+ goal 前 30 字；仅 goal.length>30 加「…」；goal 空不追加 | ChatPanel.tsx:45,50 |
| CARD-03 | P1 | 手测 | meta 解析失败 | 查看该注入卡 | 节点数显示「?」、无 goal 后缀；展开仍可见原文 | ChatPanel.tsx:44, chat.ts:106 |
| CARD-04 | P0 | 手测 | 注入 prompt 很长（~120KB） | 展开注入卡 | ①等宽 `<pre>` 显示全文；②注入卡内限高 **240px**（覆盖默认 320）、字号 10.5px、可滚动不撑破布局；③无论多大永远走注入卡路径不气泡化 | ChatPanel.tsx:52, app.css:91-103,635-638 |
| CARD-05 | P2 | 契约 | — | 单测：块数组注入消息 | raw 只拼文本块，图片等非文本块丢弃；字符串原样。**已自动化** | chat.ts:63-70 |
| CARD-06 | P0 | 契约 | — | 单测：string 与块数组两种 content | sentinel 识别两形状均 true（pi 以 BLOCK 形式回显 prompt）；非 user 角色同内容 false。**已自动化**（chat.test 含 BLOCK 包裹用例） | chat.ts:49-61 |
| CARD-07 | P2 | 手测 | 知晓 sentinel 前缀 | 手动输入以 `[pi-graph:orch-results]` 开头的文本发送 | 被误判渲染为注入卡（meta 大概率失败显示 ?）。化妆品级已知项 KNOWN-2 | chat.ts:53-61, ChatPanel.tsx:43-53 |
| CARD-08 | P0 | 契约 | — | 单测三种 run | ①仅 status!=="idle" && goal!==null && startedAt!==null 才有卡；②编辑器手动 run（goal=null）无卡；③条目 id `orch:${runId??"current"}`；④卡片内容直接读 RunState，时间线条目只是排序锚点；⑤仅最新 planned run 有卡。**已自动化** | chat.ts:81-95,104, ChatPanel.tsx:61-63 |
| CARD-09 | P1 | 手测 | ⚡ 编排启动 | 观察编排交互 | goal 蓝色用户样式气泡但位于 assistant 行内（左对齐）——视觉为「用户目标 + 左侧状态卡」组合 | ChatPanel.tsx:68-69, app.css:539-559 |
| CARD-10 | P0 | 手测 | 编排各状态 | 依次经历 planning→running→completed；另做失败与中止 | ①规划中（黄）/运行中（蓝）/完成（绿）/失败（红）；②**已中止复用黄色**（与失败红可区分） | ChatPanel.tsx:20-26,71, app.css:595-614 |
| CARD-11 | P2 | 契约 | — | 构造未知 status="weird" | 原样显示「⚡ weird」，class 无颜色后缀 | ChatPanel.tsx:63 |
| CARD-12 | P0 | 手测 | 各计数场景 | running 时看 chips；有失败/跳过时看 | ①chips 仅 status!=="planning" 且 total>0 时渲染；②✓ 恒显示「✓ {ok} / {total}」（ok=0 也显示）；③✗ 仅 failed>0；④⏭ 仅 skipped>0；⑤planning 或 total=0 整行不出现 | ChatPanel.tsx:64,72-78 |
| CARD-13 | P0 | 手测 | planning 流式中 | 规划输出中看卡片；进 running 后再看 | ①planning 且 planText 非空才显示 planText.slice(-120) 预览；②离开 planning 立即消失 | ChatPanel.tsx:65-66,79 |
| CARD-14 | P0 | 手测 | 存在编排卡/注入卡 | 分别点两张卡上的「查看编排 →」 | 均为 ghost 小按钮，点击均切到编排 tab（共用 onOpenOrch=setTab("orch")） | ChatPanel.tsx:54-56,80-82, App.tsx:219 |
| CARD-15 | P0 | 契约 | — | 单测同毫秒四类条目 | ①timestamp 升序；②同毫秒 user(0)<orch(1)<injected(2)<assistant(3)；③同 ts 同 kind 保持输入序（sort 稳定）。**已自动化** | chat.ts:8-12,40,137 |
| CARD-16 | P0 | 契约 | — | 单测 streamingAssistant | 追加 streaming:true 的 assistant 条目（id `stream:${...}`），按自身 ts 参与排序；完成后由 message_end 条目接替。**已自动化** | chat.ts:125-136 |
| CARD-17 | P1 | 手测 | 曾发起过编排（含失败/中止） | F5 刷新看卡片 | hello 重放恢复卡片状态/计数/chips；planning 时显示 planText 尾部预览 | orch-store.ts:339-343, ChatPanel.tsx:63-79 |
| CARD-18 | P1 | 手测 | 编排失败/中止 | 触发 plan_failed 或点中止 | ①**run_error 信封本身不改卡片状态**（只落 orchError，显示在编排页运行条红字）；②卡片红「失败」来自 run_event 折叠的 plan_failed / run_finished(failed)；③中止后琥珀「已中止」 | orch-store.ts:376-379, orchestration.ts:565-568,631-638, run-manager.ts:301-318 |

## 5. 服务端注入管线（MC-SRV，契约为主）

| 编号 | P | 类型 | 前置 | 步骤 | 预期 | 代码 |
|---|---|---|---|---|---|---|
| SRV-01 | P0 | e2e | dev 栈 + pi 可用 | ⚡ 发起多步目标，观察全流程 | ①plan_started→plan_delta 流式草稿→plan_completed **同一 runId 续接** run_started；②节点依次执行产出；③run_finished completed **先广播**、注入后发生；④聊天出现 `[pi-graph:orch-results]` 开头注入消息→整合回答流式回到聊天。**已自动化（CHAT=1）** | run-manager.ts:126-167,236, main.ts:84-97 |
| SRV-02 | P1 | 手测 | 编排页有合法图 | 编排页手动运行完成后切回实时 | 聊天无注入卡、主会话无注入消息（start() 不传 chat，钩子不触发） | run-manager.ts:99-106,221,236 |
| SRV-03 | P0 | 契约 | devtools 直发 WS | 发空/纯空白 goal；发 goal:123（非字符串） | 均 run_error「目标不能为空」（非字符串被降级空串），无 plan_started | run-manager.ts:118-119, main.ts:296,299 |
| SRV-04 | P1 | 契约 | — | 发 >4000 字符目标 | run_error「目标过长（超过 4000 字符）」；planner 内还有二道截断防线 | run-manager.ts:123-125, planner.ts:209-210 |
| SRV-05 | P0 | 契约 | 编排进行中 | 再发 plan_run 或 run_graph | 第二次 run_error「已有一次运行正在进行，请先中止」；第一次运行不受影响；完成后注入只对第一次 runId 发生一次 | run-manager.ts:100,115, main.ts:285,299 |
| SRV-06 | P0 | 契约 | — | 分别发 chat:true / "true" / 1 / 省略 | 仅严格 ===true 走注入；其余正常规划执行广播但**完成后不注入** | main.ts:297, run-manager.ts:156,236 |
| SRV-07 | P0 | 契约 | fake executor | 录制事件序与钩子时刻 | ①run_finished 在 run() 内同步广播，钩子在 .then——订阅者先见 run_finished 注入才开始；②.finally 清引擎在 .then 之后，钩子执行时 run 簿记仍在（runId 不可能 stale）；③下一次 run 的 nextRunId 不可能插到钩子前。**已自动化**（run-manager chat hook） | run-manager.ts:229-236,254-260 |
| SRV-08 | P0 | 契约 | — | chat run 后立即再跑；engine.run() reject | ①钩子唯一调用点是 .then（promise 只 resolve 一次）→每 run 至多注入一次；②retained 仅在 nextRunId 清空→钩子读到的必是本 run 事件；③异常路径（.catch 合成 failed）不触发钩子。**已自动化** | run-manager.ts:209-217,236,238-253,268-290 |
| SRV-09 | P0 | 契约 | 并行节点交错完成 | 捕获 ChatRunResult | ①nodes 仅来自 node_completed 且 runId 匹配，顺序=完成序；②label 从 run_started 图构建（仅存在才记，缺失→undefined→prompt 回退 nodeId）；③node_failed/skipped 不进 nodes；④**0 节点直接 return 不调钩子**；⑤goal 为入口 trim 后值。**已自动化** | run-manager.ts:118,156,274-290 |
| SRV-10 | P0 | 契约 | 钩子必抛错 | 构造 throwing hook | ①RunManager 侧 try/catch 仅 console.error，run_finished completed 不被推翻；②main.ts 侧 bridge.send 抛错（pi 死）同样只打日志；③均不产生第二次 run_finished。**已自动化** | run-manager.ts:291-297, main.ts:92-96 |
| SRV-11 | P0 | 契约 | — | 直接调 buildSynthPrompt 逐行断言 | ①第 1 行恒为 sentinel；②第 2 行单行 JSON {runId,goal,nodeCount}；③空行+「用户的原始目标：」+goal；④固定指令段（含 N=nodes.length、「不要逐条复述节点输出」）；⑤节头 `### n1 —— 调研`，label 缺失回退 `### n2 —— n2`。**已自动化** | orchestration.ts:281,318-342 |
| SRV-12 | P0 | 契约 | 极端输入 | 1/16/60/500 节点+中文 emoji 超长文本 | ①perNode = max(2048, min(51200, floor(122880/n)))：n=1→50KB、n=16→7.5KB、n=60→2048 触底；②超限头部保留截断+尾部「（输出过长，已截断）」；③按 UTF-8 字节截断，宽字符切开由 TextDecoder 替换符兜底；④空 nodes 防御分支 cap 取 50KB（生产被 0 节点早退挡住）。**已自动化** | orchestration.ts:30,234-240,283-285,319-322,325 |
| SRV-13 | P1 | 契约 | — | parseOrchSynthMeta 各垃圾输入 | 非 sentinel 前缀/坏 JSON/字段类型错/缺字段→null；合法→{runId,goal,nodeCount}；整体 total 不抛。**已自动化** | orchestration.ts:349-361 |
| SRV-14 | P0 | 契约 | e2e 监听 WS+落盘 | chat run 完成后核对传播 | ①注入走 bridge.send 命令通道（无关联 response）；②pi 事件经统一入口 foldEvent+hub.ingest+store.append→广播/落盘/hello 重放全免费；③**文本流事件即时广播**——hub 仅对 tool_execution_update 按 toolCallId 100ms 节流（latest-wins，tool_execution_end 提前 flush）；④注入本身仅 console.log 无额外协议消息 | main.ts:69,88-97,120-124,239, event-hub.ts:31-66 |
| SRV-15 | P1 | 契约 | 固定 now 连跑两次 | 比较 runId | orch-${base36(now)}-${自增序号}：同毫秒两次 startPlanned 得不同 runId；nextRunId 同时清 retained+flush 陈旧缓冲 | run-manager.ts:82,209-217 |
| SRV-16 | P1 | 契约 | fake planner 同步 throw / reject | startPlanned 订阅事件 | 同步 throw→「规划器异常: <msg>」plan_failed+run_finished failed，返回 {ok:true,runId} 不 wedge；finishPlanning 先 flush delta 再发终止事件；两路径都不注入。**已自动化** | run-manager.ts:136-146,162-165,301-318 |
| SRV-17 | P1 | 契约 | 慢 planner+中途 abort | planner 事后 resolve 合法图 | `if (!this.planning) return` 直接返回：不 flush、不发 plan_completed、不 launchEngine——中止的 run 永不事后注入。**已自动化** | run-manager.ts:148-152,170-176 |
| SRV-18 | P1 | 契约 | — | 各形状 planner 输出过 extractGraph | ①围栏/散文包裹取首{末}子串；无 JSON/缺数组→对应错误；②>16 节点 / >512 边拒绝；③归一：id 截 64、task 截 8000、model 128、agent 64、label 归一截 100；④畸形条目透传给 validateGraph 按规则报；⑤错误串最多列 3 条+「（等 N 项）」；⑥缺边 id 自动合成 `source->target`；**未知/缺失边 type 静默丢弃**（下游按 input），丢 type 不连带丢 note。**已自动化**（planner.test） | planner.ts:74-148 |
| SRV-19 | P1 | 契约 | fake bridgeFactory | 坏图重试 | ①第一次坏→onDelta 注入「—— 第 1 次规划无效：<feedback>，正在重试 ——」提示（规划预览可见）；②第二次 prompt 带 feedback；③两次都坏→失败；④进程级失败（exit/timeout/拒 prompt）不消耗重试。**已自动化** | planner.ts:194,217-227 |
| SRV-20 | P0 | 契约 | e2e 录制事件流 | chat 成功 run + 规划期中止各一次 | ①序列 plan_started→plan_delta*→plan_completed→run_started→node_*→run_finished，同一 runId 贯穿；②plan_delta 150ms 窗口合并为**拼接**非 latest-wins；③注入 meta.runId 与事件流一致。**已自动化** | run-manager.ts:108-157,320-339 |
| SRV-21 | P2 | 契约 | 无 planner 构造 | startPlanned / WS plan_run | {ok:false,"服务器未配置规划器"}；请求方收 run_error 同文案，无广播 | run-manager.ts:116, main.ts:297-300 |
| SRV-22 | P2 | 契约 | 注入会抛错的 stub | 发恶意 plan_run | 异常被捕获→请求方 run_error「goal 无法解析: <msg>」；服务器与连接存活 | main.ts:292-305 |
| SRV-23 | P2 | 契约 | 结算后尾部 delta + 立即下一 run | 观察尾部 delta 归属 | ①delta 缓冲携带到达时 runId，flush 按缓冲内 runId 发布——迟到尾巴不串到下一个 run；②nextRunId 先 flushAllDeltas+flushPlanDelta；③launchEngine .finally 也先 flush 再清；④**结构事件（node_completed/failed/skipped）先 flush 该节点 delta 再发布，run_finished 前 flushAllDeltas**——delta 严格先于终结事件 | run-manager.ts:76-78,209-217,254-260,341-363 |
| SRV-24 | P1 | 契约 | 一个上游节点失败 | 观察下游闭包 | node_skipped reason="upstream failed: <id>"，不等仍在运行的兄弟上游；run_finished 状态优先级 aborted > failed（任一 node_failed）> completed | orchestrator.ts:143,267-292 |
| SRV-25 | P1 | 契约 | — | 断言 node_started.assembledPrompt | 无上游=node.task；有上游按图序 `### from <id> —— <类型徽章>（备注）` 分节，每路上游输出上限 50KB 头部截断+「（输出过长，已截断）」 | orchestration.ts:260-269, orchestrator.ts:202-215 |
| SRV-26 | P1 | 契约 | 并行图 | 观察 running 节点数 | maxParallel 默认 4（env ORCH_MAX_PARALLEL）；ready 队列按图序调度，同时 running 不超过上限 | orchestrator.ts:104,135-139, main.ts:56,81 |
| SRV-27 | P1 | 契约 | 非法引擎图（重复 id/未知端点/自环/环） | 直接 start | 构造期抛错落入 launchEngine .catch：flushAllDeltas+合成 run_finished failed——客户端不会卡在 running | orchestrator.ts:127,177-200, run-manager.ts:238-253 |
| SRV-28 | P1 | 契约 | ORCH_PLANNER_MODEL 含元字符 | 发起规划 | 「规划模型「X」含非法字符」直接 plan_failed（MODEL_RE argv 防护）；节点执行侧同防线 | planner.ts:211-214, pi-node-executor.ts:82-84 |
| SRV-29 | P1 | 契约 | — | 断言 finalOutput | 取最后一条 assistant 消息的纯 text 块 join（跳过 thinking/toolCall）——节点与规划器输出提取语义 | orchestration.ts:367-378 |
| SRV-30 | P0 | 契约 | 跨两次运行的常驻连接 | 构造 stale runId 事件 | ①plan_started/run_started 是唯一重置点（跨 run 连接必须重置而非忽略新 run）；②run_started 带不同 runId 时清空 goal；③其余 runId 不匹配事件被忽略。**已自动化**（foldRunEvent stale 用例） | orchestration.ts:532-539,570-583 |
| SRV-31 | P1 | 契约 | 提交无效图 run_graph | 观察 run_error | message=「图校验未通过」+ **issues 数组**（客户端可展示具体校验问题）；图结构非对象/缺数组报「图结构无效（缺少 nodes/edges 数组）」 | run-manager.ts:101-102, main.ts:284-285, orchestration.ts:128-129 |
| SRV-32 | P1 | 契约 | 空闲时 abort_run；引擎 finished 后再 abort | 观察事件 | 两处均 no-op：空闲返回 false 无事件；引擎已结束后 abort 不重复发事件 | run-manager.ts:190-192, main.ts:306-308, orchestrator.ts:159-160 |
| SRV-33 | P1 | 契约 | kill() 后 trickle stdout | 观察事件 | planner/executor 的 post-settle 守卫：kill 后 trickle 事件不再 fold、不再转发 delta（已结算节点不事后补发） | planner.ts:254-257, pi-node-executor.ts:137-140 |
| SRV-34 | P0 | 契约 | server 运行，带 `Origin: http://localhost:5173` 请求 | `curl -i -H "Origin: …" :8787/api/sessions`（及 `/api/sessions/:id/events`、`/api/agents`、`/api/runs*`） | 响应带 `access-control-allow-origin: *`（web 由 Vite :5173 提供、API 在 :8787，**fetch 跨源**；WS 不受 CORS 限但 fetch 会被浏览器静默拦截——修复前历史抽屉永远显示「暂无存档」）；`/api/snake/*` **不**带（维持同源） | main.ts:142-154 |
| SRV-35 | P0 | 契约 | fake bridge 脚本回放 | 质量门违规触发 salvage | ①门关（默认 minOutputChars=0）短输出一次通过、无 attempts；②违规→**原题不改写重跑一次**（两次 prompt 完全一致），两答取长，`attempts:2`；③重跑标记「—— 输出仅 N 字符（< 质量门 M），用原题重跑一次 ——」走 delta 流（预览可见）；④两次均空→节点判失败「两次输出均为空」；⑤真实失败（进程退出/超时/prompt 被拒）**不重试**；⑥中止后不重试（第二次 spawn 不发生）。**已自动化**（pi-node-executor.test） | pi-node-executor.ts:115-146 |
| SRV-36 | P0 | 契约 | ORCH_NODE_RETRY=0 | 空输出 + 短输出各一次 | 关闭重跑后：空输出直接判失败「输出为空（质量门 minOutputChars=N）」；短而非空照常通过——**空转不再静默算成功**（对齐 tool 的显式违规语义） | pi-node-executor.ts:127-132, main.ts:68-69 |
| SRV-37 | P0 | 契约 | 节点带能力档案字段 | 逐项验证覆盖优先级 | ①`node.minOutputChars` 优先于 `ORCH_MIN_OUTPUT_CHARS`；②`node.timeoutMs` 优先于 `ORCH_NODE_TIMEOUT_MS`（超时报「节点超时（Nms）」）；③`node.outputCapBytes` 只影响注入下游/汇总的预算，归档输出保持完整。**已自动化** | pi-node-executor.ts:119,204, orchestrator.ts:214, run-manager.ts:279-293 |
| SRV-38 | P0 | 契约 | 节点带 workdir / tools | 观察 spawn 参数与 cwd | ①workdir=相对安全路径→解析到 base 之下、目录自动创建、bridge cwd 指向它（并行节点互不踩文件）；②越界路径（含 ../、绝对路径、反斜杠）在 validateGraph 拒绝 + 执行器 resolve 包含检查双防线（「workdir 越界」，不 spawn）；③tools/excludeTools 以逗号拼接进 `--tools`/`--exclude-tools` argv（TOOL_NAME_RE 保证无 cmd 元字符）。**已自动化** | pi-node-executor.ts:181-202, orchestration.ts:79,246-258 |
| SRV-39 | P0 | 契约 | — | 单测 validateGraph 能力档案规则 | minOutputChars 0–1000000、timeoutMs 1000–86400000、outputCapBytes 1–1000000 的整数范围校验；isSafeWorkdir 拒绝空/超 200/控制字符/`\\`/`:`/前导 `/`/空段/`..`；tools 数组 ≤32 个合法名。**已自动化**（orchestration.test） | orchestration.ts:232-258 |
| SRV-40 | P0 | 契约 | — | 断言 node_completed 事件与 RunNodeState | ①executor 返回 attempts>1 → orchestrator 在 node_completed.output 带 `attempts`（未 salvage 则无该字段）；②foldRunEvent 把 attempts 落进节点状态（历史回放可见重跑标记）。**已自动化** | orchestrator.ts:42,266, orchestration.ts:542,732 |
| SRV-41 | P1 | 契约 | 规划器输出带能力字段 | 过 extractGraph | 数字夹取到范围内（负→min、超大→max、小数四舍五入）；不安全 workdir 丢弃；tools 数组过滤非法名后 ≤32；空 tools 视为缺省——**归一不报错**（不消耗规划器唯一一次重试）。**已自动化**（planner.test） | planner.ts:121-137 |

## 6. 失败 / 中止 / 异常（MC-FAIL）

| 编号 | P | 类型 | 前置 | 步骤 | 预期 | 代码 |
|---|---|---|---|---|---|---|
| FAIL-01 | P0 | 手测 | 坏规划环境（坏模型/断网） | ⚡ 发起编排 | ①plan_failed（含原因）→run_finished failed（planning 也计为一次 run）；②聊天卡片显示「失败」，**无注入卡、无整合回答**（失败路径不 launchEngine，钩子仅 completed 触发） | run-manager.ts:159-160,236,301-318 |
| FAIL-02 | P0 | 手测 | 编排可发起 | 规划阶段点中止；再次发起在执行阶段点中止 | ①规划期中止：abort 规划器→flush plan delta→run_finished aborted；②执行期中止：engine.abort()，引擎发终止事件；③两种情况聊天都无注入、无整合回答 | run-manager.ts:170-193,236 |
| FAIL-03 | P1 | 手测 | 一个节点会失败 | ⚡ 多节点目标 | run_finished 非 completed（failed）；聊天无注入卡无整合回答（`chat && status==="completed"` 门控） | run-manager.ts:236 |
| FAIL-04 | P1 | 手测 | 能杀主会话 pi 进程 | 编排执行期间杀主 pi（节点/规划器是独立 spawn） | ①编排 run 正常完成（不依赖主 bridge）；②所有客户端收 pi-exit 信封；③聊天显示完成卡片但**无注入无整合回答**（bridge.send 抛错被 try/catch，仅 console.error）；④ run 生命周期不受影响，后续会话消息见 pi 已死表现 | main.ts:73-80,89-96,125-131 |
| FAIL-05 | P2 | 手测 | 两个标签连接 | 任一标签发起 ⚡ 编排至注入 | 两标签同时收到整合回答流式事件（统一 ingest 入口+每连接独立订阅）；**文本流即时到达**（仅工具类 update 有 100ms 节流），最终一致 | main.ts:120-124,242-244, event-hub.ts:31-66 |

## 7. 历史回放与刷新恢复（MC-HIST）

| 编号 | P | 类型 | 前置 | 步骤 | 预期 | 代码 |
|---|---|---|---|---|---|---|
| HIST-01 | P0 | 手测 | 抽屉已有会话 | 点「历史」→点某会话 | ①整页进入历史模式：**主栏仍是 ChatPanel，但渲染归档对话**（折叠态 SessionState 同一纯 fold）；②右列「历史图」始终在（key="history"，graphOverride 冻结快照不随实时更新）；③布局与实时页同一套（主/侧、详情/图均可拖拽，布局记忆共用） | App.tsx LivePage/MiniGraph, store.ts loadHistory |
| HIST-02 | P0 | 手测 | 历史回放中 | 观察并尝试输入 | 输入框 disabled「正在查看历史会话（对话与图均为存档），返回实时后可继续对话」；⚡/send 等全不渲染 | App.tsx PromptBar |
| HIST-03 | P0 | 手测 | 历史回放中 | 观察 header | 琥珀「📜 历史回放」横幅（加载中追加「（加载中…）」）；连接状态点/agent 状态/用量/lastError 全隐藏；横幅内有「返回实时」 | App.tsx:50-71, app.css:202-208 |
| HIST-04 | P0 | 手测 | 历史回放中 | 点「返回实时」 | history 置 null+清选中（exitHistory 递增 historyReq 取消在途加载）；主栏回到实时对话、右列恢复「实时图」、输入栏可用 | App.tsx:54-56, store.ts exitHistory |
| HIST-05 | P0 | 手测 | bridge 可用 | 点头部「历史」 | 全屏半透明 overlay+左侧 380px 抽屉；每项显示首条用户文本（无则「(无文本输入)」）+「M-DD HH:mm · N events · ↓N tok」；关闭后不占 DOM | HistoryDrawer.tsx:21-47, store.ts:104-113 |
| HIST-06 | P1 | 手测 | 无存档；另测接口失败（停 server） | 打开抽屉 | ①无存档且 fetch 成功 →「暂无存档（发过任务后这里会出现）」；②fetch 抛错/非 2xx → 红字「历史加载失败 — 检查 bridge server 是否在运行，关掉抽屉重开可重试」（sessionsError 标记，不再把失败伪装成空列表）；loadHistory 失败同样置标（重开抽屉可见） | HistoryDrawer.tsx:32-40, store.ts:107-125 |
| HIST-07 | P0 | 手测 | 有可加载会话 | 点击会话项 | ①立即进入 history 模式：聊天头「历史对话（加载中…）」+「正在载入该会话的归档…」占位、历史图空；②完成后主栏渲染归档对话、选中清空、聊天头变「历史对话」；③该会话项 active 蓝框 | store.ts loadHistory, ChatPanel.tsx |
| HIST-08 | P1 | 手测 | 已加载回放 | 在历史图点节点 | 可点选/再点取消/点空白清除；详情按**归档图**解析选中 id（非实时图同 id 节点），挂右列历史图上方（同实时布局） | GraphCanvas.tsx:27-31, DetailPanel.tsx:114-119, App.tsx LivePage |
| HIST-09 | P1 | 手测 | 回放中开着抽屉 | 点 overlay 空白 / 点 × | 均只收起抽屉（historyOpen=false），回放横幅与冻结图保留；抽屉面板内点击 stopPropagation 不误关 | HistoryDrawer.tsx:24-30 |
| HIST-10 | P1 | 手测 | 可使 events 请求失败 | 点会话项并使其失败 | catch 把 history 置 null 自动退回实时布局；仅当请求仍是最新令牌（req===historyReq）才清空，避免过期响应误清 | store.ts:126,148-150 |
| HIST-11 | P1 | 契约 | 会话 A、B | 快速连点 A→B；点 A 后立刻返回实时 | req!==historyReq 时 set 被跳过；exitHistory 也递增令牌使在途作废；失败分支同样受保护 | store.ts:62-63,114-115,131-132,148-155 |
| HIST-12 | P0 | 契约 | 已完成过注入 | F5 刷新等 hello | ①先 resetSession 再全量 fold 重建（不叠加旧状态）；②sentinel 注入消息重新渲染为注入卡；③envelope.run 非空时重 fold 出 RunState 恢复卡片；从未跑过图时 run 保持 idle。**已自动化（CHAT=1 hello 校验）** | store.ts:197-208, orch-store.ts:339-354 |
| HIST-13 | P1 | 契约 | 运行中途断网重连 | 触发自动重连观察视图 | 仅冷启动（本地 idle）且快照 planning/running 且 goal 非空才切 run 视图；重连 hello（本地非 idle）不覆盖用户手动视图；终态快照不强切 | orch-store.ts:345-353 |
| HIST-14 | P2 | 手测 | 回放中 | 切编排 tab 再切回 | 编排页正常显示、切回实时回放状态保留（冻结图/禁用输入/横幅仍在）；**清 history 的途径有二**——exitHistory 与最新一次 loadHistory 失败的 catch | App.tsx:207-238, store.ts:148-155 |
| HIST-15 | P2 | 契约 | 存档缺 startedAt/首文本 | 核对抽屉元信息 | 时间「M-DD HH:mm」（月不补零，日时分补零），startedAt=0 不显示时间；列表查不到 id 时 meta 兜底 eventCount/outputTokens | HistoryDrawer.tsx:8-13,40, store.ts:135-142 |
| HIST-16 | P1 | 契约 | WS 状态可控 | 非 OPEN 时 sendPrompt | send 仅 OPEN 时发，否则静默丢弃；四类命令载荷 {type:"command",command:{type:"prompt"|"steer"|"abort"|"new_session",message?}}；默认地址可被 VITE_WS_URL/VITE_API_BASE 覆盖 | store.ts:26-27,65-67,99-102 |
| HIST-17 | P1 | 契约 | 注入各类信封 | 坏 JSON/缺字段 | ①坏 JSON 被吞直接 return；②event 信封 ingest；③run_event 驱动卡片不产生聊天消息；④run_error 只落 orchError；⑤pi-exit 置 piExit（聊天侧仅表现为事件流停止）；⑥hello 缺 snapshot 整条静默忽略 | store.ts:174-191,197-228 |
| HIST-18 | P2 | 契约 | 杀 bridge 再重启 | 观察重连 | onopen 重置退避 1000ms+open；onclose：open→reconnecting、connecting→closed；延迟 1s 起翻倍封顶 15s；成功后经 hello 全量重建；**hello 与 reset 都会清 piExit 横幅** | store.ts:61,83-85,163-170,192-207,232-240 |
| HIST-19 | P0 | 手测 | 会话含对话+编排注入 | 打开该会话历史 | ①归档对话完整渲染：用户/助手气泡 + 「⚙ 编排结果已注入会话」折叠卡（meta 从 sentinel 重解析）；②**无 ⚡ 编排状态卡**——历史时间线以 idle run 构建（run 事件存于 runs/ 独立归档，v1 不并入会话回放）；③工具轨迹不进时间线（canvas 侧看）；④时间线为纯只读快照，不随 WS 实时事件变化（live session 的流式 tick 不污染浏览视图） | ChatPanel.tsx browsing, store.ts loadHistory |
| HIST-20 | P1 | 手测 | 打开有内容的会话历史 | 观察滚动 | ①**打开定位到顶部**（记录从头读，非跟尾）；②无自动跟随——向上滚动不回弹；③滚离底部 >40px 出现「↓ 回到最新」；④**浏览中切换会话 A→B 同样回顶**（滚动复位按归档身份键控，不继承 A 的偏移）；⑤「返回实时」回到实时对话并重新跟尾 | ChatPanel.tsx 滚动效应 |
| HIST-21 | P1 | 手测 | 实时有 run 挂在门控 awaiting | 同时打开历史会话浏览 | 对话栏**不出现**琥珀门控审校卡（那是 live 态，绝不混入归档时间线）；关闭历史后门控卡回到实时对话尾部 | ChatPanel.tsx `{!browsing && <GateAwaitingCards/>}` |
| HIST-22 | P2 | 手测 | 存档只含工具轨迹（无 user/assistant 消息） | 打开该会话历史 | 时间线显示空态「该存档只有工具轨迹，没有对话消息（图在右侧『历史图』）」；历史图正常可点 | ChatPanel.tsx 空态 |

## 8. 安全与边界加固（MC-SEC）

| 编号 | P | 类型 | 前置 | 步骤 | 预期 | 代码 |
|---|---|---|---|---|---|---|
| SEC-01 | P0 | 契约 | label 含 \n/\t/DEL(0x7f) | 三层分别验证 | ①第一层 validateGraph：LABEL_UNSAFE_RE=/[\u0000-\u001f\u007f]/（**含 DEL 0x7f**）命中即报「节点/边 label 不能包含换行或控制字符」，图被拒→plan_failed 不执行不注入；②第二层 extractGraph 归一：控制字符替换空格+trim，非空才留、节点截 100/边截 20——归一后不会因换行被拒；③第三层 safeLabel 兜底：构节头时再替换，空则回退 nodeId——注入 prompt 中任何 `###` 分节头不可能由 label 伪造。**已自动化**（三层各有用例） | orchestration.ts:61,158-159,186-187,329, planner.ts:105-108,127-128 |
| SEC-02 | P0 | 契约 | 超长节点输出 | buildSynthPrompt 极端输入 | 120KB 总预算/每节点 cap 公式/截断标记/字节级截断。**已自动化**（同 SRV-12） | orchestration.ts:283-285,319-322 |
| SEC-03 | P1 | 契约 | env 模型 id 含元字符 | 发起规划/运行 | MODEL_RE 拒绝 argv 注入：「规划模型「X」含非法字符」/节点侧同防线（同 SRV-28） | planner.ts:211-214, pi-node-executor.ts:82-84 |
| SEC-04 | P1 | 契约 | 各类超限输入 | 逐项验证 | goal>4000 拒；节点>16/边>512 拒；id 截 64、task 截 8000、model 128、agent 64、label 100、边 note 20；规划输出围栏/散文包裹可提取（同 SRV-03/04/18） | planner.ts:33-40,74-148, run-manager.ts:123-125 |

## 9. 人工门控 / human-in-the-loop（MC-GATE）

门控节点（`NodeDef.gate === true`）不执行 pi：就绪时把 run 挂起等人工「批准/驳回」。批准 → 备注成为节点输出注入下游；驳回 → 下游按 `upstream failed` 跳过。门控有**两个来源**：编辑器「＋门控」手工放置；规划器对不可逆/影响外部的动作**自提风险门控**（上限 3 个、剥执行配置、超限降级，见 GATE-10）。线级契约由 `scripts/e2e-gate.mjs` 端到端锁定（挂起 → 4 类非法决策仅回请求方 → 批准备注注入下游 → 归档/重放/孤儿检查）。

| 编号 | P | 类型 | 前置 | 步骤 | 预期 | 代码 |
|---|---|---|---|---|---|---|
| GATE-01 | P0 | 手测 | 编排页编辑器 | 点「＋门控」；选中该节点 | ①画布新增节点带 mono「门」小标、pending 虚线边；②面板 task 字段标签为「审校要点」，**执行配置（model/agent/tools/workdir/能力档案）全部不渲染**；③按钮 title 说明挂起语义 | OrchestratePage.tsx, OrchNodePanel.tsx |
| GATE-02 | P0 | 契约 | — | 单测 validateGraph | ①gate 带任一执行配置（model/agent/tools/excludeTools/workdir/minOutputChars/timeoutMs/outputCapBytes）→ issue「门控节点不能带执行配置…」；②gate 非布尔 → issue；③gate 的 task 仍必填；④gate 无出边/全 gate 图合法。**已自动化**（orchestration.test） | orchestration.ts validateGraph |
| GATE-03 | P0 | 契约 | fake executor | 门控 + 并行任务混合图 | ①gate ready 时**不调 executor、不占 maxParallel 槽**；②发 `node_awaiting`（assembledPrompt = assemblePrompt(gate, 上游输入)）；③并行任务照常推进不被门控阻塞。**已自动化**（orchestrator.test） | orchestrator.ts |
| GATE-04 | P0 | 契约 | — | 图中仅剩 awaiting 门控 | run **不发 run_finished**——awaiting 非终态，直到决定或中止。**已自动化**（orchestrator.test） | orchestrator.ts 完成判定 |
| GATE-05 | P0 | 契约 | — | 对 awaiting 门控 decideNode(true, "备注") | ①`node_decided` approved=true，durationMs 从进入 awaiting 起算；②折叠 status=ok、output=备注（空→「（已批准）」）；③下游解锁，其 prompt 含 `### from <gateId> —— 输入` 分节携带备注。**已自动化**（orchestrator.test + orchestration.test + e2e-gate） | orchestrator.ts, orchestration.ts fold |
| GATE-06 | P0 | 契约 | — | decideNode(false, "原因") | ①折叠 status=error、error=`人工驳回：原因`（空备注→「无备注」）；②下游 `node_skipped` reason=`upstream failed: <id>`，与执行失败同语义。**已自动化**（orchestrator.test） | orchestrator.ts |
| GATE-07 | P0 | 契约 | devtools 直发 WS | 对非 awaiting 节点/过期 runId/结束后发 `approve_node`；发 approved:"true"（非布尔）、note 带换行/控制字符、note>2000 | 均被拒：decideNode 返回 false 无事件；非法载荷只向请求方回 run_error（广播流不受污染）。**已自动化**（run-manager.test + e2e-gate 四连拒） | main.ts, run-manager.ts decideNode |
| GATE-08 | P0 | 契约 | — | 两个客户端同时批准同一门控；批准与 abort 同时到达 | ①仅第一次 decide 生效（第二次 false 无事件）；②竞态下不双重结算、不发矛盾事件。**已自动化**（orchestrator.test + e2e-gate 迟到驳回） | orchestrator.ts decideNode 守卫 |
| GATE-09 | P1 | 契约 | 门控 awaiting 中 | 点中止 | awaiting 门控按 running 节点同款 abort 结算（跳过），run_finished aborted。**已自动化**（orchestrator.test） | orchestrator.ts abort |
| GATE-10 | P0 | 契约 | — | 规划器输出 JSON 带节点 gate 字段（含滥用形态） | extractGraph **保留**规划器自提的风险门控，但收紧为：仅 `gate === true` 的裸布尔（"true"/1 不算）才生效；门控节点**剥除全部执行配置**（model/agent/能力档案/workdir/tools——不报错不耗重试）；**上限 3 个**（超限节点降级为普通任务节点照常执行）；**死胡同门控（无出边）整个丢弃**（含入边）——AND-join 下它管不住任何节点：风险动作的直连下游照跑、审批形同虚设、run 却照样挂起（提示词已要求 风险→门控→下游 改接线，此处为兜底）；空 task 门控（有下游者）仍走校验报错。**已自动化**（planner.test：裸布尔/剥配置/上限降级/死胡同丢弃/链形保留/混合 + 提示词契约） | planner.ts extractGraph |
| GATE-11 | P0 | 手测 | 运行至门控 awaiting | 选中 awaiting 门控节点 | ①面板显示 assembledPrompt 预览（等宽 pre）+ 备注 input +「批准」（主按钮）/「驳回」（danger）；②非 awaiting 时两钮禁用；③批准后节点变绿、按钮禁用；④驳回后节点红 ✗、下游琥珀跳过。（Playwright 走查 + 截图已核验：`D:/pip_temp/gate-shots/01→03`） | OrchNodePanel.tsx |
| GATE-12 | P1 | 手测 | 门控各状态 | 观察节点视觉 | ①pending=虚线+空心点（未勘测习语）；②awaiting=琥珀描边 + 琥珀方点 + 缓慢呼吸；③无新色相、无 glow——门控用四色系的琥珀，绝不用洋红。（截图已核验） | nodes.css, orch-nodes.tsx |
| GATE-13 | P1 | 契约 | 门控 awaiting/已决 | F5 刷新 / 历史重放 | node_awaiting/node_decided 进归档与 hello 全量重建——awaiting 态、决策备注、驳回错误均完整复原。**已自动化**（e2e-gate 归档/重放断言） | orchestration.ts foldRunEvent |
| GATE-14 | P1 | 手测 | ⚡ 发起一个含写文件/发布类动作的目标 | 观察生成图与运行 | 规划器把风险动作的下游**改接成经过**门控（写入→🚧放行审校→读回核验，下游输入边从门控发出）：生成图带「门」标节点、运行到此挂起琥珀待审批、批准后下游继续；纯调研/生成类目标**不**应出现门控；无下游的死胡同门控被 extractGraph 丢弃（GATE-10）。「转入编辑器」把门控一并带入可编辑重跑。（e2e PLAN 模式已带自动放行兜底，冒烟目标实测会提门控） | planner.ts, OrchCanvas.tsx |
| GATE-15 | P0 | 契约 | — | fake executor：maxParallel=1，慢节点占满槽位，普通节点排队其后，gate 队尾 | 扫描必须**跨过被槽位阻塞的节点**继续找 gate 并立即挂起（parked 数组保序回填），而不是断在阻塞节点处把 gate 困到槽位释放；中止后 parked 节点从未派发。**已自动化**（orchestrator.test 回归） | orchestrator.ts 排水循环 |
| GATE-16 | P0 | 契约 | — | 门控挂起期间读运行条 chip | ok/失败/跳过/tok **逐节点实时累计**（node_completed/failed/decided/skipped 即刻 +1，usage 累加）——挂起几分钟的 run 不再显示「ok 0」；run_finished 仍以服务端权威计数覆盖兜底。**已自动化**（orchestration.test 长效计数） | orchestration.ts foldRunEvent |
| GATE-17 | P1 | 手测 | 门控 awaiting | ①快速双击「批准」；②填备注后切换选中节点再切回；③awaiting 中按 Backspace/Delete | ①1s 发送防抖窗（`runId:nodeId` 键控）吞掉第二次发送——无重复 decide；②备注随节点切换/状态离开 awaiting/新 run 清空，但点击批准**不**清（发送在途/掉线重试时输入保留）；③运行中删除键已禁用（drag/connect 同锁）。 | orch-store.ts approveNode, OrchNodePanel.tsx, OrchCanvas.tsx |
| GATE-18 | P0 | 手测 | 对话页开 ⚡，直接在输入框发一条含写文件动作的目标 | 等运行推进到门控挂起 | ①**不离开对话页**即可完成审批：列表尾部出现琥珀左边线「门」审校卡（label + 等待人工审校 + assembledPrompt 预览 + 备注 input + 批准/驳回），编排状态卡在其上方实时显示进度；②批准后卡片即刻消失、状态卡走完 → 注入卡（折叠 details）→ 助手综合回复，全程零页面切换；③门控卡对**任何**来源的 live run awaiting 都渲染（编排页发起的挂起 run 切回对话页同样可批），F5 后经 hello 重放重新具现，仍可批；④门控卡是实时态非历史条目——决定落定即从时间线消失，不占位；⑤备注生命周期同 GATE-17 ③（卡片在即保留，决定即弃）。（Playwright 双阶段走查 + 截图已核验：`D:/pip_temp/gate-shots/06→09`——含 F5 前后的挂起 run 对话页放行 + ⚡ 对话发起全流程） | ChatPanel.tsx GateAwaitingCards, app.css .pg-chat-gate-card |
| GATE-19 | P1 | 契约 | 含门控的 chat run 完成后 | 对比状态卡芯片与注入卡节点数 | 芯片 `✓ ok/total` 计**全部图节点**（门控批准计 1 ok，门控不占槽不发 node_started/completed）；注入卡「N 节点」只计 **node_completed**（门控从不发——其备注经 `### from <gateId>` 已进下游输出，随 3 节点间接进入综合）。两数口径不同、各自正确（实测 4/4 与 3 节点并存，存档核对一致）。**已自动化**（orchestrator.test 门控事件对 + run-manager.test nodes 仅收 node_completed） | orchestrator.ts, run-manager.ts fireChatComplete |

## 10. 已知问题 / 接受项（KNOWN）

| 编号 | 描述 | 影响 | 依据 |
|---|---|---|---|
| KNOWN-1 | 「＋新任务」reset 后编排卡残留：reset 信封只清 session/graph，不重置 orch-store 的 run（completed/aborted 卡继续留在时间线） | 化妆品；v1 接受（PLAN.md M-C 已标记 v2） | store.ts:192-196 |
| KNOWN-2 | 用户手打 sentinel 前缀消息被渲染为注入卡（meta 显示 ?） | 化妆品 | chat.ts:53-61 |
| KNOWN-3 | send 按钮直连 sendPrompt，竞态窗口内（渲染后翻 running）不走 steer | 低概率行为差异 | App.tsx:182-192 |
| KNOWN-4 | 断连时 Enter/点 send 仍清空草稿（消息静默丢弃） | 草稿丢失 | store.ts:65-67, App.tsx:141,188 |
| KNOWN-5 | Enter 不区分 Shift/Ctrl 修饰键（单行输入无换行语义） | 交互习惯差异 | App.tsx:167 |
| KNOWN-6 | agent_settled 无 message_end 的异常结算：流式草稿消失且回复不入 messages（消息丢失） | 依赖 pi 事件形状 | fold.ts:260-264 |
| KNOWN-7 | 同毫秒同角色两条消息产生重复 React key | 极端边界无崩溃 | fold.ts:125-130 |
| KNOWN-8 | hello 重放下标变化导致注入卡 details 重挂载折叠 | 展开态丢失 | chat.ts:104 |

---

## 手测冒烟清单（P0 快速过一遍）

1. **布局**：聊天主区 + 右列迷你实时图占满；点节点→详情按需出现、×/再点关闭（LAY-01/02/03）
2. **普通对话**：发消息→流式回复带光标→工具计数→自动跟随（CHAT-02/04/06/07/10）
3. **⚡ 触发**：开⚡→发目标→卡片规划中（含 plan 预览）→运行中 chips→完成（BAR-01/04, CARD-10/12/13）
4. **注入整合**：完成后注入卡（N 节点）→整合回答流式→两处「查看编排」跳转（CARD-01/04, CARD-14）
5. **中止**：运行中 ⏹→卡片「已中止」无注入（BAR-11, FAIL-02）
6. **刷新**：F5→聊天+注入卡+编排卡完整恢复（HIST-12, CARD-17）
7. **回放**：历史→冻结图+禁用输入→返回实时（HIST-01/02/04）
8. **编排页对照**：编排页手动运行完成后**无**注入（SRV-02）
