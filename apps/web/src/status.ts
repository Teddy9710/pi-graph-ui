/**
 * Chinese labels + tone classes for the status vocabularies that appear in
 * more than one place. One run status used to render as a colored Chinese
 * word in the chat card but a gray English chip in the orchestrate bar —
 * these maps keep every surface speaking the same language. `aborted` gets
 * its own NEUTRAL tone instead of borrowing planning's amber: a user-initiated
 * stop is not a warning.
 */

/** RunState.status — the whole-run lifecycle (chat card, orch bar chip). */
export const RUN_STATUS_LABEL: Record<string, string> = {
	idle: "未运行",
	planning: "规划中",
	running: "运行中",
	completed: "完成",
	failed: "失败",
	aborted: "已中止",
};

/** RunNodeState.status — one node inside a run (orch node panel header). */
export const RUN_NODE_STATUS_LABEL: Record<string, string> = {
	pending: "待运行",
	running: "运行中",
	ok: "完成",
	error: "失败",
	skipped: "已跳过",
};

/** GraphNodeData.status — live-graph nodes (detail panel header). */
export const NODE_STATUS_LABEL: Record<string, string> = {
	pending: "待运行",
	running: "运行中",
	ok: "完成",
	error: "失败",
	skipped: "已跳过",
};

/** Chat-card status tone (chat orch card). */
export function runStatusChatClass(status: string): string {
	switch (status) {
		case "planning":
			return "pg-chat-status pg-chat-status-planning";
		case "running":
			return "pg-chat-status pg-chat-status-running";
		case "completed":
			return "pg-chat-status pg-chat-status-done";
		case "failed":
			return "pg-chat-status pg-chat-status-failed";
		case "aborted":
			return "pg-chat-status pg-chat-status-aborted";
		default:
			return "pg-chat-status";
	}
}

/** Graph-node kinds (live canvas) — icon + Chinese label for the detail panel. */
export const NODE_KIND_LABEL: Record<string, { icon: string; text: string }> = {
	session: { icon: "◆", text: "会话" },
	user: { icon: "👤", text: "用户消息" },
	assistant: { icon: "🤖", text: "助手回复" },
	tool: { icon: "🔧", text: "工具调用" },
	"subagent-call": { icon: "✳", text: "子代理调用" },
	agent: { icon: "🛰", text: "子代理" },
	"agent-tool": { icon: "·", text: "子代理工具" },
};
