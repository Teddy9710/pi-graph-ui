/**
 * Built-in orchestration templates that seed the editor canvas.
 * Positions are assigned by the web layer (autoLayoutGraphDef) on seed —
 * templates themselves stay position-free so layout stays one code path.
 */

import type { GraphDef } from "./orchestration.ts";

export interface TemplateDef {
	key: string;
	name: string;
	description: string;
	graph: GraphDef;
}

export const TEMPLATES: TemplateDef[] = [
	{
		key: "research-fanout",
		name: "并行调研 + 汇总",
		description: "3 个 researcher persona 并行调研，1 个汇总节点合成结论（AND-join 演示）",
		graph: {
			name: "并行调研 + 汇总",
			nodes: [
				{
					id: "research-a",
					label: "调研·概念",
					agent: "researcher",
					task: "调研「React Flow v12」的定位与核心概念。基于你已有的知识给出 5 条要点式结论，每条不超过 40 字。不要调用工具。",
				},
				{
					id: "research-b",
					label: "调研·特性",
					agent: "researcher",
					task: "调研「React Flow v12」相对 v11 的主要变化与迁移点。基于你已有的知识给出 5 条要点式结论，每条不超过 40 字。不要调用工具。",
				},
				{
					id: "research-c",
					label: "调研·生态",
					agent: "researcher",
					task: "调研「React Flow」生态：布局库、官方示例、常见坑。基于你已有的知识给出 5 条要点式结论，每条不超过 40 字。不要调用工具。",
				},
				{
					id: "summarizer",
					label: "汇总",
					task: "阅读下方三份调研输出，写一份结构化中文总结，分「## 背景」「## 关键发现」「## 结论与建议」三节。只使用上游输出中的信息，不要编造。",
				},
			],
			edges: [
				{ id: "research-a->summarizer", source: "research-a", target: "summarizer", type: "aggregate" },
				{ id: "research-b->summarizer", source: "research-b", target: "summarizer", type: "aggregate" },
				{ id: "research-c->summarizer", source: "research-c", target: "summarizer", type: "aggregate" },
			],
		},
	},
	{
		key: "pipeline",
		name: "三级流水线",
		description: "大纲 → 扩写 → 审校 的串行链（数据注入与失败跳过演示）",
		graph: {
			name: "三级流水线",
			nodes: [
				{ id: "outline", label: "大纲", task: "为主题「pi coding agent 的架构」写一份大纲：3 个小节，每节列 2-3 个要点。只输出大纲。" },
				{ id: "draft", label: "扩写", task: "根据上游大纲扩写一篇 600 字左右的短文，保持小节结构与要点顺序。" },
				{ id: "polish", label: "审校", task: "审校上游草稿：修正错别字与不通顺的表达，压缩到 500 字以内，不丢失任何要点。" },
			],
			edges: [
				{ id: "outline->draft", source: "outline", target: "draft", type: "input" },
				{ id: "draft->polish", source: "draft", target: "polish", type: "review" },
			],
		},
	},
	{
		key: "blank",
		name: "空白画布",
		description: "单节点起步，自由编排",
		graph: {
			name: "未命名编排",
			nodes: [{ id: "node-1", label: "节点 1", task: "" }],
			edges: [],
		},
	},
];
