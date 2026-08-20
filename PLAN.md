# Pi Graph UI — 项目计划

## 概述
基于 Pi Agent Harness 后端 + React 前端的可视化工作流编排系统：自然语言 → 动态生成 DAG → 拓扑调度执行 → 实时监控。

## 技术栈
- **后端**: Node.js + Hono + @earendil-works/pi-agent-core + pi-ai（多供应商 LLM）
- **持久化**: pi-session-backend-sqlite-node (SQLite)
- **前端**: React + React Flow (@xyflow/react) + dagre 自动布局
- **共享**: packages/dag-schema（Zod DAG 类型 + 环检测）

## 仓库结构
```
apps/server     # Hono API + DAG 调度器 + Pi Agent 集成
apps/web        # React Flow 画布 + 实时监控
packages/dag-schema
```

## 里程碑
1. **M1 (W1)** 骨架: pnpm monorepo, dag-schema (类型+校验), CI
2. **M2 (W2)** 后端 MVP: /api/dag/generate (LLM 生成 DAG), /api/dag/:id/run, 调度器, WebSocket 事件流
3. **M3 (W3)** 前端 MVP: DAG 渲染 + 自动布局 + 节点状态实时同步 + 详情面板
4. **M4 (W4)** 持久化: SQLite 会话, 执行历史, 重试/重跑
5. **M5+** 增强: 手动编辑 DAG, Docker 沙箱, 多用户

## 关键设计
- LLM 通过 `build_dag` 工具结构化输出 DAG → Zod 校验 + 拓扑排序防环
- 每个节点 = 独立 Pi Agent（独立 system prompt / 工具集），无依赖节点并行
- Pi 事件流 → 节点状态映射 → WebSocket 推送前端
- 安全: Pi 无内置权限系统, 执行层容器化隔离

## 参考
- https://pi.dev/docs/latest
- https://github.com/badlogic/pi-mono
- https://github.com/earendil-works/pi-chat
- https://xyflow.com
