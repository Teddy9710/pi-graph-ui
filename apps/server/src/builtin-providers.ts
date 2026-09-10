/**
 * pi 内置 provider 目录加载 —— builtin-providers.json（随仓库提交的静态快照）
 * 的读取与查询。目录由 scripts/generate-builtin-providers.mjs 从已安装 pi-ai
 * 的 dist 生成；快照只服务展示/预填/守卫，缺失或损坏时全部降级为空目录
 * （页面提示、守卫惰性失效），绝不让模型配置页整体 500。
 */

import { readFileSync } from "node:fs";
import type { BuiltinCatalogFile, BuiltinCatalogProvider, BuiltinProviderInfo } from "@pi-graph/shared";

const EMPTY_CATALOG: BuiltinCatalogFile = { piVersion: "unknown", generatedAt: "", providers: [] };

const AUTH_KINDS = new Set(["env-key", "oauth", "custom"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 单个 provider 条目的结构校验（宽松：允许缺省字段，不接受错型）。 */
function isValidProvider(v: unknown): v is BuiltinCatalogProvider {
	if (!isPlainObject(v)) return false;
	if (typeof v.id !== "string" || !v.id) return false;
	if (typeof v.name !== "string" || !v.name) return false;
	if (v.baseUrl !== undefined && typeof v.baseUrl !== "string") return false;
	if (!Array.isArray(v.apis) || v.apis.some((a) => typeof a !== "string")) return false;
	if (v.apiKeyEnv !== undefined && typeof v.apiKeyEnv !== "string") return false;
	if (typeof v.authKind !== "string" || !AUTH_KINDS.has(v.authKind)) return false;
	if (!Array.isArray(v.models) || !v.models.every((m) => isPlainObject(m) && typeof m.id === "string" && m.id)) {
		return false;
	}
	return true;
}

/**
 * 解析目录文本。任何结构问题 → null（生成脚本 fail-loud 保证提交的文件
 * 有效，这里只为防手改/损坏；纯函数，单测直接喂坏输入）。
 */
export function parseBuiltinCatalog(text: string): BuiltinCatalogFile | null {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isPlainObject(data)) return null;
	if (typeof data.piVersion !== "string" || typeof data.generatedAt !== "string") return null;
	if (!Array.isArray(data.providers)) return null;
	const providers = data.providers.filter((p): p is BuiltinCatalogProvider => isValidProvider(p));
	if (providers.length !== data.providers.length) return null;
	return { piVersion: data.piVersion, generatedAt: data.generatedAt, providers };
}

/**
 * 读 builtin-providers.json（import.meta.url 定位，兼容 node / --watch /
 * vitest；不用 JSON import assertion）。失败只 warn——目录是增强数据，
 * 不能拖垮模型配置页。
 */
export function loadBuiltinCatalog(): BuiltinCatalogFile {
	try {
		const text = readFileSync(new URL("./builtin-providers.json", import.meta.url), "utf8");
		return parseBuiltinCatalog(text) ?? warnEmpty();
	} catch {
		return warnEmpty();
	}
}

function warnEmpty(): BuiltinCatalogFile {
	console.warn("[builtin] 内置 provider 目录缺失或损坏——「＋ 内置」入口降级为不可用，其余功能不受影响");
	return EMPTY_CATALOG;
}

/**
 * 目录里是否存在某 provider 的某模型。**大小写敏感**，与 pi 的
 * provider-composer（findIndex(m => m.id === definition.id)）一致：
 * `Minimax-M3` ≠ `MiniMax-M3`，大小写差异在 pi 侧会产生影子条目。
 */
export function builtinModelExists(catalog: BuiltinCatalogFile, providerId: string, modelId: string): boolean {
	return (
		catalog.providers.some((p) => p.id === providerId && p.models.some((m) => m.id === modelId))
	);
}

/**
 * 目录快照 + 本机状态标记 → 页面列表。fileIds 是 models.json 里的 provider
 * id 集合，runtimeIds 是主 bridge 已认证快照里的 provider id 集合（OAuth 的
 * 实际状态只有它知道）。
 */
export function toBuiltinProviderInfos(
	catalog: BuiltinCatalogFile,
	fileIds: Set<string>,
	runtimeIds: Set<string>,
): BuiltinProviderInfo[] {
	return catalog.providers.map((p) => ({
		...p,
		envSet: p.apiKeyEnv !== undefined && process.env[p.apiKeyEnv] !== undefined,
		configuredInFile: fileIds.has(p.id),
		authedAtRuntime: runtimeIds.has(p.id),
	}));
}
