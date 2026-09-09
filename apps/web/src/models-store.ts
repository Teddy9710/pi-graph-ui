/**
 * 模型配置页的数据层 —— 全 HTTP（同会话栏 CRUD 的先例：fetch + res.ok +
 * {error} 解析；WS 的 response 信封 web 端没有处理器，不走路由）。
 *
 * 草稿编辑状态也放在这里（zustand 模块级单例）：ModelsPage 随 tab 切换
 * 卸载重挂，本地 useState 会把未保存的 provider 草稿和已输入的密钥静默
 * 丢掉——对照另两个编辑面（编排图 useOrchStore / 聊天 useStore），编辑
 * 状态都应跨 tab 存活。这里只负责服务器往返与全局状态（config 快照 +
 * 进行中标志 + 每项的连接测试结果）。
 */

import { create } from "zustand";
import type {
	ModelsConfigApplyRequest,
	ModelsConfigApplyResponse,
	ModelsConfigResponse,
	ModelsConfigSaveRequest,
	ModelsConfigTestRequest,
	ModelsConfigTestResponse,
} from "@pi-graph/shared";
import { API_BASE } from "./store.ts";

/** 页面草稿：一个 provider 的编辑态（见 ModelsPage）。 */
export interface Draft {
	/** 列表内的稳定键（新草稿用 uid；已存在项 = provider id）。 */
	key: string;
	id: string;
	isNew: boolean;
	/** provider 完整原始 JSON（高级字段原样携带，PUT 时带回）。 */
	raw: Record<string, unknown>;
	/** 密钥输入（"" = 未改动；不入 models.json，保存时进 secrets/转写）。 */
	keyInput: string;
}

async function apiCall<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${API_BASE}${path}`, init);
	const body = (await res.json().catch(() => null)) as (T & { error?: string; message?: string; issues?: string[] }) | null;
	if (!res.ok || !body) {
		// /test 端点失败时返回 {ok:false,message}（而非 {error}），两边都取
		const detail = body?.error ?? body?.message ?? `HTTP ${res.status}`;
		const issues = body?.issues;
		throw new Error(issues?.length ? `${detail}：${issues.join("；")}` : detail);
	}
	return body;
}

const json = (payload: unknown): RequestInit => ({
	method: "PUT",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(payload),
});

interface ModelsState {
	config: ModelsConfigResponse | null;
	loading: boolean;
	/** load / save 的失败信息（页顶与编辑器都会回显）。 */
	error: string | null;
	saving: boolean;
	applying: boolean;
	/** 最近一次 apply 的结果摘要（成功侧的回显；错误走 error/test 字段）。 */
	applyResult: ModelsConfigApplyResponse | null;
	applyError: string | null;
	/** 连接测试结果，按 tag（provider id 或 "draft"）分桶。 */
	testResults: Record<string, ModelsConfigTestResponse | undefined>;
	testing: Record<string, boolean>;
	/** 草稿（跨 tab 切换存活；dirty=true 时 config 刷新不覆盖草稿）。 */
	drafts: Draft[];
	selectedKey: string | null;
	dirty: boolean;
	load: () => Promise<void>;
	save: (req: ModelsConfigSaveRequest) => Promise<boolean>;
	test: (req: ModelsConfigTestRequest, tag: string) => Promise<void>;
	apply: (req: ModelsConfigApplyRequest) => Promise<ModelsConfigApplyResponse | null>;
	clearApplyFeedback: () => void;
	setDrafts: (drafts: Draft[]) => void;
	setSelectedKey: (key: string | null) => void;
	setDirty: (v: boolean) => void;
}

export const useModelsStore = create<ModelsState>((set, get) => ({
	config: null,
	loading: false,
	error: null,
	saving: false,
	applying: false,
	applyResult: null,
	applyError: null,
	testResults: {},
	testing: {},
	drafts: [],
	selectedKey: null,
	dirty: false,

	load: async () => {
		set({ loading: true, error: null });
		try {
			const config = await apiCall<ModelsConfigResponse>("/api/models");
			set({ config, loading: false });
		} catch (err) {
			set({ error: err instanceof Error ? err.message : "加载失败", loading: false });
		}
	},

	save: async (req) => {
		set({ saving: true, error: null });
		try {
			await apiCall("/api/models", json(req));
			await get().load(); // 保存后以服务器状态为准重建（含 $VAR 转写结果）
			set({ saving: false });
			return true;
		} catch (err) {
			set({ error: err instanceof Error ? err.message : "保存失败", saving: false });
			return false;
		}
	},

	test: async (req, tag) => {
		set((s) => ({ testing: { ...s.testing, [tag]: true } }));
		try {
			const result = await apiCall<ModelsConfigTestResponse>("/api/models/test", {
				...json(req),
				method: "POST",
			});
			set((s) => ({ testing: { ...s.testing, [tag]: false }, testResults: { ...s.testResults, [tag]: result } }));
		} catch (err) {
			set((s) => ({
				testing: { ...s.testing, [tag]: false },
				testResults: {
					...s.testResults,
					[tag]: { ok: false, message: err instanceof Error ? err.message : "测试请求失败" },
				},
			}));
		}
	},

	apply: async (req) => {
		set({ applying: true, applyError: null, applyResult: null });
		try {
			const result = await apiCall<ModelsConfigApplyResponse>("/api/models/apply", {
				...json(req),
				method: "POST",
			});
			set({ applying: false, applyResult: result });
			await get().load(); // 重启/切换后刷新运行时状态
			return result;
		} catch (err) {
			set({ applying: false, applyError: err instanceof Error ? err.message : "应用失败" });
			return null;
		}
	},

	clearApplyFeedback: () => set({ applyResult: null, applyError: null }),
	setDrafts: (drafts) => set({ drafts }),
	setSelectedKey: (selectedKey) => set({ selectedKey }),
	setDirty: (dirty) => set({ dirty }),
}));
