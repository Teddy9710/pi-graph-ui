/**
 * 模型配置服务 + HTTP 子路由 —— 前端「模型配置页」的后端。
 *
 * 管理三处状态（页面是它们唯一的写入方之一，全部原样保留非页面字段）：
 *   ~/.pi/agent/models.json   provider 定义（baseUrl / api / models…）
 *   ~/.pi/agent/settings.json 持久默认模型（defaultProvider + defaultModel）
 *   仓库根 .env               密钥明文（已被 gitignore；models.json 只存 $VAR 引用）
 *
 * 生效路径（新配置只对「之后 spawn 的 pi 进程」可见——子进程在 spawn 时快照
 * 父进程 env，且运行中的 bridge 没有 models.json 热加载）：
 *   - 编排节点 / planner：每次 run 都 spawn 新 pi → 改 process.env 即生效
 *   - 主会话 bridge：模型已在启动快照内 → RPC set_model 即时切换；
 *     新增/修改 provider 或新密钥 → 必须重启 bridge（显式 restartBridge）
 *
 * 密钥安全：GET 永不回传密钥明文（只回 $VAR 引用 + envSet 布尔）；字面量
 * 密钥在保存时被转写成 $VAR 引用，明文只进 .env 与 process.env。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import {
	MODEL_RE,
	type ActiveModelInfo,
	type BuiltinCatalogFile,
	type BuiltinCatalogProvider,
	type ModelConfigProviderInfo,
	type ModelsConfigApplyRequest,
	type ModelsConfigApplyResponse,
	type ModelsConfigResponse,
	type ModelsConfigSaveRequest,
	type ModelsConfigSaveResponse,
	type ModelsConfigTestRequest,
	type ModelsConfigTestResponse,
	type RpcCommand,
	type RpcResponse,
} from "@pi-graph/shared";
import { builtinModelExists, loadBuiltinCatalog, toBuiltinProviderInfos } from "./builtin-providers.ts";

// ============================================================================
// 路径与 env 文件工具
// ============================================================================

/** pi 的 agent 目录（镜像 pi config.ts 的 getAgentDir：环境变量优先）。 */
export function piAgentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR;
	if (override) return override.replace(/^~(?=$|[\\/])/, homedir());
	return join(homedir(), ".pi", "agent");
}

/** 向上找 pnpm-workspace.yaml 所在目录（仓库根）；找不到则退回起点。 */
export function findRepoRoot(start: string): string {
	let dir = start;
	for (let i = 0; i < 8; i++) {
		if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return start;
}

const ENV_LINE_RE = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/;

/**
 * 读 .env 到 process.env（仅未设置的键——shell 显式导出的值优先，与
 * scripts/dev.mjs 的加载器语义一致）。裸 `node src/main.ts` 没有 dev.mjs
 * 帮忙，这里补上同样的加载，密钥才进得了后续 spawn 的 pi 进程。
 */
export function loadDotEnvFile(envPath: string): void {
	if (!existsSync(envPath)) return;
	try {
		for (const line of readFileSync(envPath, "utf8").split("\n")) {
			const m = line.match(ENV_LINE_RE);
			const name = m?.[1];
			if (name && m && process.env[name] === undefined) process.env[name] = m[2] ?? "";
		}
	} catch (err) {
		console.warn(`[models] .env 读取失败（${envPath}）:`, err);
	}
}

/**
 * 把密钥合并进 .env：只改写本次管理的变量，其余行（含注释、空行、别人的
 * 变量）原样保留、顺序不变。值不加引号（加载器不剥引号）。同时写入
 * process.env 让「之后 spawn 的 pi」立即看到。
 */
export function mergeEnvSecrets(envPath: string, secrets: Record<string, string>): string[] {
	const managed = Object.keys(secrets);
	if (managed.length === 0) return [];
	let lines: string[] = [];
	if (existsSync(envPath)) {
		try {
			lines = readFileSync(envPath, "utf8").split("\n");
		} catch {
			lines = []; // 读不动就当空文件重建（写入是原子替换）
		}
	}
	if (lines.length && lines[lines.length - 1] === "") lines.pop();
	const seen = new Set<string>();
	const rewritten = lines.map((line) => {
		const m = line.match(ENV_LINE_RE);
		const name = m?.[1];
		if (!m || !name || !(name in secrets)) return line;
		seen.add(name);
		return `${name}=${secrets[name]}`;
	});
	for (const [name, value] of Object.entries(secrets)) {
		if (!seen.has(name)) rewritten.push(`${name}=${value}`);
	}
	atomicWrite(envPath, rewritten.length ? rewritten.join("\n") + "\n" : "");
	for (const [name, value] of Object.entries(secrets)) process.env[name] = value;
	return managed;
}

function atomicWrite(path: string, content: string): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path);
}

// ============================================================================
// 校验与纯工具
// ============================================================================

const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]{2,63}$/;
const API_KEY_REF_RE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;
/**
 * secrets 通道（写 .env + process.env）绝不接受的变量名：能改变 node/pi
 * 启动与解析行为的环境量。这个通道只为密钥服务，不是任意环境变量注入面。
 */
const DENIED_ENV_VARS = new Set([
	"NODE_OPTIONS",
	"NODE_PATH",
	"PATH",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"DYLD_INSERT_LIBRARIES",
	"HOME",
	"USERPROFILE",
	"APPDATA",
	"PI_BIN",
	"PI_ARGS",
	"PI_CWD",
	"PI_NO_SESSION",
	"PI_CODING_AGENT_DIR",
]);
/** 页面编辑的核心字段；此外的字段（compat/headers/modelOverrides…）原样保留。 */
const CORE_PROVIDER_FIELDS = new Set(["name", "baseUrl", "api", "apiKey", "models"]);

/**
 * 内置 id 条目上属于「覆盖内置定义」的字段——pi 的 applyModelsJson 对这些
 * 做选择性合并（内置模型继承 baseUrl 却不继承 api，模型 id 大小写不同产生
 * 影子条目），正是 minimax 撞名 404 事故的机制。apiKey/name 不在其列：
 * 仅携带密钥的挂载条目是 pi 官方支持的形态（内置定义原样生效）。
 */
const BUILTIN_OVERRIDE_FIELDS = ["baseUrl", "models", "api", "compat", "headers", "modelOverrides", "oauth", "authHeader"];

/** 条目实际覆盖了哪些内置字段；models: [] 不算（pi 的 !config.models?.length 同语义）。 */
function builtinOverrideFields(entry: Record<string, unknown>): string[] {
	return BUILTIN_OVERRIDE_FIELDS.filter((f) =>
		f === "models" ? Array.isArray(entry.models) && entry.models.length > 0 : entry[f] !== undefined,
	);
}

/** 撞名警告核心文案（save 阻断版与 GET builtinConflict 版共用）。 */
function builtinConflictMessage(builtin: BuiltinCatalogProvider, fields: string[]): string {
	return (
		`与 pi 内置 provider「${builtin.name}」同 id 且覆盖了 ${fields.join(" / ")}。` +
		"合并陷阱：内置模型会继承你的 baseUrl 但不继承 api 字段；模型 id 大小写不同还会产生影子条目。" +
		"只配密钥 → 用「＋ 内置」入口（仅写 apiKey）；自定义 URL/模型 → 换一个 id（如 minimaxcn）"
	);
}

/** provider id → 密钥环境变量名（deepseek → DEEPSEEK_API_KEY）。 */
export function toEnvVarName(providerId: string): string {
	return `${providerId.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_API_KEY`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface ValidatedProvider {
	/** 写回 models.json 的完整对象（高级字段原样；字面量密钥已转 $VAR）。 */
	raw: Record<string, unknown>;
	/** 从字面量密钥提取出的 secrets（var → 明文）。 */
	secret: Record<string, string>;
	info: Omit<ModelConfigProviderInfo, "raw">;
}

/**
 * 校验并规范化一个 provider 条目。字面量 apiKey 在这里被换写成 $VAR 引用。
 * 返回 [result] 或 [null, error]。
 */
export function validateProvider(
	id: string,
	input: unknown,
	issues: string[],
	/**
	 * 字面量密钥折叠的目标变量名：内置 id 必须传目录里的 env 名（pi 读
	 * GEMINI_API_KEY，toEnvVarName 只会折出 GOOGLE_API_KEY → 静默失效）。
	 */
	preferEnvVar?: string,
): [ValidatedProvider] | [null] {
	if (!PROVIDER_ID_RE.test(id)) {
		issues.push(`provider id「${id}」非法：需以字母/数字开头，仅含 字母数字._- 且 ≤64 字符（"/" 会破坏 provider/model 解析）`);
		return [null];
	}
	if (!isPlainObject(input)) {
		issues.push(`provider「${id}」需为对象`);
		return [null];
	}
	const raw: Record<string, unknown> = { ...input };
	const secret: Record<string, string> = {};
	const advancedFields: string[] = [];

	const name = raw.name;
	if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 100)) {
		issues.push(`provider「${id}」的 name 需为 1–100 字符`);
		return [null];
	}
	const baseUrl = raw.baseUrl;
	if (baseUrl !== undefined) {
		if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) {
			issues.push(`provider「${id}」的 baseUrl 需为 http(s) URL`);
			return [null];
		}
		try {
			new URL(baseUrl);
		} catch {
			issues.push(`provider「${id}」的 baseUrl 无法解析`);
			return [null];
		}
	}
	const api = raw.api;
	if (api !== undefined && (typeof api !== "string" || !api.trim() || api.length > 64 || /\s/.test(api))) {
		issues.push(`provider「${id}」的 api 需为不含空白的非空字符串`);
		return [null];
	}
	let apiKeyRef: string | undefined;
	let apiKeyInline = false;
	const apiKey = raw.apiKey;
	if (apiKey !== undefined) {
		if (typeof apiKey !== "string" || !apiKey.trim()) {
			issues.push(`provider「${id}」的 apiKey 需为非空字符串`);
			return [null];
		}
		if (apiKey.startsWith("!")) {
			apiKeyRef = apiKey; // shell 命令形式：仅允许沿用（save 层把关新值）
		} else if (API_KEY_REF_RE.test(apiKey)) {
			apiKeyRef = apiKey;
		} else if (/\$\{?[A-Za-z_][A-Za-z0-9_]*/.test(apiKey) || apiKey.includes("$")) {
			// pi 支持混合模板（如 sk-${VAR}，resolve-config-value 单遍展开）；
			// 页面无法安全转写——静默改成 $VAR 引用会把模板字符串当明文密钥
			// 写进 .env，直接破坏鉴权。含 "$" 的不明形式一律拒绝。
			issues.push(`provider「${id}」的 apiKey 含 $ 引用/模板（页面只支持纯 $VAR 引用与普通明文）——混合模板请手工维护 models.json`);
			return [null];
		} else {
			// 字面量密钥 → $VAR 引用 + 明文进 secrets；models.json 不落明文。
			// 值约束与 secrets 通道一致：换行会向 .env 注入整行变量。
			if (apiKey.length > 4096 || /[\r\n]/.test(apiKey)) {
				issues.push(`provider「${id}」的 apiKey 需为 1–4096 字符且无换行`);
				return [null];
			}
			const varName = preferEnvVar ?? toEnvVarName(id);
			if (!ENV_VAR_RE.test(varName)) {
				// 数字开头的 id（如 4gl）→ "4GL_API_KEY"：pi 的 env 引用规则与
				// .env 解析都要求首字符 [A-Za-z_]，密钥永远无法生效
				issues.push(`provider id「${id}」无法生成合法密钥变量名「${varName}」（须字母/下划线开头）——请改用字母开头的 id`);
				return [null];
			}
			apiKeyInline = true;
			secret[varName] = apiKey;
			apiKeyRef = `$${varName}`;
			raw.apiKey = apiKeyRef;
		}
	}
	const models: ModelConfigProviderInfo["models"] = [];
	const rawModels = raw.models;
	if (rawModels !== undefined) {
		if (!Array.isArray(rawModels) || rawModels.length > 64) {
			issues.push(`provider「${id}」的 models 需为数组（≤64 项）`);
			return [null];
		}
		const seen = new Set<string>();
		for (const m of rawModels) {
			if (!isPlainObject(m) || typeof m.id !== "string" || !MODEL_RE.test(m.id)) {
				issues.push(`provider「${id}」的 model id 非法（需匹配 ${MODEL_RE}——id 会作为 argv 经过 cmd.exe shim）`);
				return [null];
			}
			// model id 允许含 "/"：pi 明确支持 openrouter 式 id（canonical 全串
			// 匹配），而 provider id 禁 "/" 保证 "provider/model" 仍按第一个
			// "/" 无歧义切分（splitModelRef）
			if (seen.has(m.id)) {
				issues.push(`provider「${id}」的 model id「${m.id}」重复`);
				return [null];
			}
			seen.add(m.id);
			if (m.name !== undefined && (typeof m.name !== "string" || !m.name.trim())) {
				issues.push(`provider「${id}」的 model「${m.id}」name 需为非空字符串`);
				return [null];
			}
			models.push(m.name !== undefined ? { id: m.id, name: m.name } : { id: m.id });
		}
	}
	for (const key of Object.keys(raw)) {
		if (!CORE_PROVIDER_FIELDS.has(key)) advancedFields.push(key);
	}
	const envVar = apiKeyRef ? apiKeyRef.replace(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/, "$1") : undefined;
	return [
		{
			raw,
			secret,
			info: {
				name: typeof name === "string" ? name : undefined,
				baseUrl: typeof baseUrl === "string" ? baseUrl : undefined,
				api: typeof api === "string" ? api : undefined,
				apiKeyRef,
				apiKeyInline,
				apiKeyEnvSet: envVar !== undefined && process.env[envVar] !== undefined,
				models,
				advancedFields,
			},
		},
	];
}

/**
 * GET 出网的原始对象：apiKey 只保留可判别的引用形式（纯 $VAR/${VAR} 或
 * !command）——其余一律换成 ""（客户端把它原样带回 = 沿用旧值，不会把一份
 * 能用的明文密钥误转成失效的 $VAR 引用）。注意不能只看 "$"/"!" 前缀：
 * "$weird" 之类以 $ 开头的字面量密钥同样是明文。
 */
function sanitizeRawForClient(raw: Record<string, unknown>): Record<string, unknown> {
	const copy: Record<string, unknown> = { ...raw };
	const k = copy.apiKey;
	if (typeof k === "string" && !API_KEY_REF_RE.test(k) && !k.startsWith("!")) copy.apiKey = "";
	return copy;
}

/** "provider/model" → {provider, modelId}；先按第一个 "/" 切分（与 pi 一致）。 */
export function splitModelRef(ref: string): { provider: string; modelId: string } | null {
	if (!MODEL_RE.test(ref)) return null;
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return null;
	return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

// ============================================================================
// models.json / settings.json 读写
// ============================================================================

interface ModelsFileState {
	/** 解析后的完整 JSON（含未知顶层键）；文件缺失/损坏时为 null。 */
	parsed: Record<string, unknown> | null;
	providers: Record<string, Record<string, unknown>>;
	error?: string;
}

function readModelsFile(modelsPath: string): ModelsFileState {
	if (!existsSync(modelsPath)) return { parsed: {}, providers: {} };
	let text: string;
	try {
		text = readFileSync(modelsPath, "utf8");
	} catch (err) {
		return { parsed: null, providers: {}, error: `models.json 读取失败: ${(err as Error).message}` };
	}
	let parsed: unknown;
	try {
		// pi 的加载器容忍 BOM + 注释；写入侧只产出纯 JSON，读取侧保持同样宽容
		parsed = JSON.parse(stripBomAndComments(text));
	} catch (err) {
		return { parsed: null, providers: {}, error: `models.json 解析失败: ${(err as Error).message}` };
	}
	if (!isPlainObject(parsed) || !isPlainObject(parsed.providers)) {
		return { parsed: null, providers: {}, error: "models.json 结构非法（需 {providers: {...}}）" };
	}
	const providers: Record<string, Record<string, unknown>> = {};
	for (const [id, p] of Object.entries(parsed.providers)) {
		if (isPlainObject(p)) providers[id] = p;
	}
	return { parsed: parsed as Record<string, unknown>, providers };
}

/**
 * 与 pi 的 stripBom + stripJsonComments 逐字对齐（pi/packages/coding-agent/
 * src/utils/json.ts）：字符串感知的 // 注释剔除 + 尾逗号剔除。刻意不做块
 * 注释剔除——pi 不做，这里比 pi 更宽容只会让「页面能存、pi 读不了」的
 * 文件溜进去。
 */
function stripBomAndComments(input: string): string {
	return input
		.replace(/^﻿/, "")
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail: string | undefined) => (tail ?? (m[0] === '"' ? m : "")) as string);
}

/** settings.json 里的持久默认模型（无 / 损坏 → null）。 */
export function readPersistedDefault(agentDir: string): { provider: string; modelId: string } | null {
	const path = join(agentDir, "settings.json");
	if (!existsSync(path)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isPlainObject(parsed)) return null;
		const { defaultProvider, defaultModel } = parsed;
		if (typeof defaultProvider === "string" && typeof defaultModel === "string") {
			return { provider: defaultProvider, modelId: defaultModel };
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * 合并写入 settings.json 的默认模型（保留其他键；键序稳定）。settings.json
 * 同时承载 pi 的其他偏好，绝不能整文件重生成。
 */
export function writePersistedDefault(
	agentDir: string,
	provider: string,
	modelId: string,
): { ok: boolean; error?: string } {
	const path = join(agentDir, "settings.json");
	let merged: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!isPlainObject(parsed)) return { ok: false, error: "settings.json 结构非法，拒绝写入（请先手工修复）" };
			merged = parsed;
		} catch {
			return { ok: false, error: "settings.json 解析失败，拒绝写入（请先手工修复）" };
		}
	}
	merged.defaultProvider = provider;
	merged.defaultModel = modelId;
	try {
		atomicWrite(path, `${JSON.stringify(merged, null, "\t")}\n`);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: `settings.json 写入失败: ${(err as Error).message}` };
	}
}

// ============================================================================
// 连接测试（纯函数构造探测请求 + service 里执行）
// ============================================================================

export interface ModelProbe {
	/** 依次尝试的 URL（一般 1 个；可能带一次 /v1 回退）。 */
	urls: string[];
	headers: Record<string, string>;
}

const trimSlash = (u: string): string => u.replace(/\/+$/, "");

/**
 * 按 api 形态构造「列模型」探测请求。选 GET /models 因为它零 token 消耗、
 * 且绝大多数兼容端点都实现；anthropic 用 x-api-key 头 + /v1 前缀。
 */
export function buildModelProbe(baseUrl: string, api: string | undefined, apiKey: string): ModelProbe {
	const base = trimSlash(baseUrl);
	if (api === "anthropic-messages") {
		const v1 = /\/v\d+$/.test(base) ? base : `${base}/v1`;
		return {
			urls: [`${v1}/models`],
			headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
		};
	}
	// openai-completions / openai-responses / mistral / 未知形态都按 Bearer 试
	const urls = [`${base}/models`];
	if (!/\/v\d+$/.test(base)) urls.push(`${base}/v1/models`);
	return { urls, headers: { Authorization: `Bearer ${apiKey}` } };
}

function extractModelIds(body: unknown): string[] {
	if (!isPlainObject(body)) return [];
	const data = body.data ?? body.models;
	if (!Array.isArray(data)) return [];
	const ids: string[] = [];
	for (const m of data.slice(0, 5)) {
		if (isPlainObject(m) && typeof m.id === "string") ids.push(m.id);
	}
	return ids;
}

// ============================================================================
// Service
// ============================================================================

/** 主 bridge 的最小面（PiBridge 满足它；测试里用假实现）。 */
export interface ModelsBridgeLike {
	readonly running: boolean;
	request(command: RpcCommand): Promise<RpcResponse>;
	kill(): void;
	start(): void;
	/** planned restart 需要等 exit 事件——EventEmitter 的 once。 */
	once(event: "exit", listener: (code: number | null, stderr: string) => void): unknown;
}

export interface ModelsConfigDeps {
	bridge: ModelsBridgeLike;
	/** 编排默认模型（executor.defaultModel / planner.model 的读写口）。 */
	getOrchDefaults(): { nodeDefault: string; plannerModel: string };
	setOrchDefaults(model: string): void;
	isAgentBusy(): boolean;
	isRunBusy(): boolean;
	/** 主 bridge 当前绑定的 pi 会话文件（重启后恢复上下文用）。 */
	currentPiFile(): string | null;
	/** 重启后重探 get_state 并重绑归档。 */
	refreshPiSession(): Promise<void>;
	/** 重启完成后广播 hello（清掉 web 的 pi-exit 红条并重建视图）。 */
	broadcastHello(): void;
	/** 主 bridge 是否 --no-session（是则重启后不恢复上下文）。 */
	piNoSession: boolean;
}

export class ModelsConfigService {
	private readonly deps: ModelsConfigDeps;
	readonly agentDir: string;
	readonly modelsPath: string;
	readonly envPath: string;
	/** 内置 provider 目录快照（缺省从随仓库提交的 builtin-providers.json 加载）。 */
	private readonly builtin: BuiltinCatalogFile;
	private readonly builtinById: Map<string, BuiltinCatalogProvider>;

	constructor(deps: ModelsConfigDeps, agentDir = piAgentDir(), envPath?: string, builtinCatalog?: BuiltinCatalogFile) {
		this.deps = deps;
		this.agentDir = agentDir;
		this.modelsPath = join(agentDir, "models.json");
		this.envPath = envPath ?? join(findRepoRoot(process.cwd()), ".env");
		this.builtin = builtinCatalog ?? loadBuiltinCatalog();
		this.builtinById = new Map(this.builtin.providers.map((p) => [p.id, p]));
	}

	/** bridge RPC + 超时（PiBridge.request 本身没有超时——pi 挂起时 HTTP 不能跟着挂）。 */
	private async rpc(command: RpcCommand, timeoutMs: number): Promise<RpcResponse | null> {
		if (!this.deps.bridge.running) return null;
		try {
			return await Promise.race([
				this.deps.bridge.request(command),
				new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
			]);
		} catch {
			return null;
		}
	}

	/** GET：文件 + 运行时三方状态汇总（不含任何密钥明文）。 */
	async loadStatus(): Promise<ModelsConfigResponse> {
		const file = readModelsFile(this.modelsPath);
		const providers: Record<string, ModelConfigProviderInfo> = {};
		for (const [id, raw] of Object.entries(file.providers)) {
			// 已保存的条目走同一个校验器（只取信息，不改文件）；raw 出网前
			// 脱敏（字面量密钥 → ""），页面未编辑的字段随 raw 原样带回
			const [v] = validateProvider(id, raw, [], this.builtinById.get(id)?.apiKeyEnv);
			// 内置 id + 覆盖字段 → 非阻断警告（save 只拦「新建」，存量条目照常）
			const builtin = this.builtinById.get(id);
			const override = builtin ? builtinOverrideFields(raw) : [];
			const conflict =
				builtin && override.length > 0 ? { builtinConflict: builtinConflictMessage(builtin, override) } : {};
			providers[id] = v
				? { ...v.info, ...conflict, raw: sanitizeRawForClient(raw) }
				: { apiKeyInline: false, apiKeyEnvSet: false, models: [], advancedFields: [], ...conflict, raw: sanitizeRawForClient(raw) };
		}
		const state = await this.rpc({ type: "get_state" }, 5000);
		let activeModel: ActiveModelInfo | null = null;
		if (state?.success && isPlainObject(state.data)) {
			const model = state.data.model;
			if (isPlainObject(model) && typeof model.provider === "string" && typeof model.id === "string") {
				activeModel = {
					provider: model.provider,
					id: model.id,
					name: typeof model.name === "string" ? model.name : undefined,
				};
			}
		}
		const available = await this.rpc({ type: "get_available_models" }, 5000);
		const runtimeModels: ActiveModelInfo[] = [];
		if (available?.success && isPlainObject(available.data) && Array.isArray(available.data.models)) {
			for (const m of available.data.models) {
				if (isPlainObject(m) && typeof m.provider === "string" && typeof m.id === "string") {
					runtimeModels.push({
						provider: m.provider,
						id: m.id,
						name: typeof m.name === "string" ? m.name : undefined,
					});
				}
			}
		}
		return {
			agentDir: this.agentDir,
			modelsPath: this.modelsPath,
			envPath: this.envPath,
			providers,
			activeModel,
			runtimeModels,
			persistedDefault: readPersistedDefault(this.agentDir),
			orchDefaults: this.deps.getOrchDefaults(),
			builtinProviders: toBuiltinProviderInfos(this.builtin, new Set(Object.keys(file.providers)), new Set(runtimeModels.map((m) => m.provider))),
			builtinCatalogInfo: { piVersion: this.builtin.piVersion, generatedAt: this.builtin.generatedAt },
			configError: file.error,
		};
	}

	/** PUT：校验 → 字面量密钥转 $VAR 引用 → 密钥进 .env/env → 原子写 models.json。 */
	async save(body: ModelsConfigSaveRequest): Promise<{ status: number; body: ModelsConfigSaveResponse | { error: string; issues?: string[] } }> {
		const file = readModelsFile(this.modelsPath);
		if (file.error) {
			// 读不到/解析不了的文件绝不能被「整文件重写」悄悄清掉用户数据
			return { status: 409, body: { error: `models.json 已损坏（${file.error}），拒绝覆盖——请先手工修复` } };
		}
		if (!isPlainObject(body?.providers)) {
			return { status: 400, body: { error: "请求体需为 {providers: {...}}" } };
		}
		// 1) 每个 provider 的最终 incoming（密钥携带规则：页面永远看不到
		//    字面量密钥，靠哨兵值衔接）：
		//    apiKey 为 ""/缺省 → 沿用 models.json 里的旧值（页面没动它）
		//    apiKey 为 null    → 显式删除密钥
		//    其余（$VAR 引用或新明文）→ 覆盖
		const incomingById: Record<string, Record<string, unknown>> = {};
		for (const [id, entry] of Object.entries(body.providers)) {
			if (!isPlainObject(entry)) {
				return { status: 400, body: { error: `provider「${id}」需为对象` } };
			}
			const incoming: Record<string, unknown> = { ...entry };
			if (incoming.apiKey === null) delete incoming.apiKey;
			else if (incoming.apiKey === undefined || incoming.apiKey === "") {
				const existing = file.providers[id];
				if (existing && typeof existing.apiKey === "string") incoming.apiKey = existing.apiKey;
				else delete incoming.apiKey;
			} else if (typeof incoming.apiKey === "string" && incoming.apiKey.startsWith("!")) {
				// !command 密钥经 shell 执行：只允许原样沿用，页面/API 一律不能新写
				if (file.providers[id]?.apiKey !== incoming.apiKey) {
					return { status: 400, body: { error: `provider「${id}」的 !command 密钥不允许新增/修改（沿用请留空）——要改请手工编辑 models.json` } };
				}
			}
			incomingById[id] = incoming;
		}
		// 2) secrets 通道校验：变量必须是本次配置里某 provider 正在引用的
		//    $VAR（含携带沿用后的值），且不在敏感名黑名单——它写 .env 和
		//    process.env，不是任意环境变量注入面
		const referencedVars = new Set<string>();
		for (const incoming of Object.values(incomingById)) {
			if (typeof incoming.apiKey === "string") {
				const m = incoming.apiKey.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
				if (m?.[1]) referencedVars.add(m[1]);
			}
		}
		const secrets: Record<string, string> = {};
		if (body.secrets !== undefined) {
			if (!isPlainObject(body.secrets)) return { status: 400, body: { error: "secrets 需为 {变量名: 值}" } };
			for (const [name, value] of Object.entries(body.secrets)) {
				if (!ENV_VAR_RE.test(name) || typeof value !== "string" || !value.trim() || value.length > 4096 || /[\r\n]/.test(value)) {
					return { status: 400, body: { error: `secrets[${name}] 非法（变量名需匹配 ${ENV_VAR_RE}，值需为 1–4096 字符且无换行）` } };
				}
				if (DENIED_ENV_VARS.has(name)) {
					return { status: 400, body: { error: `secrets[${name}] 是敏感变量，不允许经模型配置页写入` } };
				}
				if (!referencedVars.has(name)) {
					return { status: 400, body: { error: `secrets[${name}] 未被任何 provider 的 apiKey 引用（页面只管理被引用的密钥变量）` } };
				}
				secrets[name] = value;
			}
		}
		// 3) 逐个校验 + 密钥变量名折叠冲突检测（foo.bar 与 foo_bar 都折成
		//    FOO_BAR_API_KEY，后写会静默覆盖前写的密钥）
		const issues: string[] = [];
		const validated: Record<string, Record<string, unknown>> = {};
		const secretSources = new Map<string, string>();
		for (const [id, incoming] of Object.entries(incomingById)) {
			const [v] = validateProvider(id, incoming, issues, this.builtinById.get(id)?.apiKeyEnv);
			if (!v) break;
			let collided = false;
			for (const [varName, value] of Object.entries(v.secret)) {
				const prev = secretSources.get(varName);
				if (prev !== undefined && prev !== id) {
					issues.push(`provider「${prev}」与「${id}」的密钥折叠到同一变量 ${varName}（id 里的 . - 会被折叠成 _）——请改用不冲突的 id`);
					collided = true;
					break;
				}
				secretSources.set(varName, id);
				secrets[varName] = value;
			}
			if (collided) break;
			validated[id] = v.raw;
		}
		// 3.5) 内置撞名守卫：新建的内置 id 条目若覆盖 baseUrl/models/api 等
		//      → pi 的选择性合并会制造 404 式事故（minimax 撞名案例），阻断。
		//      纯挂载（仅 apiKey[+name]，pi 官方支持的形态）与磁盘上已有的
		//      覆盖条目不拦——后者由 loadStatus 出非阻断警告（builtinConflict）。
		//      在写盘之前、issues 返回处收口，保证不产生半写状态。
		for (const [id, incoming] of Object.entries(incomingById)) {
			const builtin = this.builtinById.get(id);
			if (!builtin || file.providers[id]) continue;
			const override = builtinOverrideFields(incoming);
			if (override.length > 0) {
				issues.push(`provider「${id}」${builtinConflictMessage(builtin, override)}——已拒绝保存`);
			}
		}
		if (issues.length > 0) return { status: 400, body: { error: "配置校验未通过", issues } };

		// 4) 先写密钥、后写 models.json：.env 写失败时 models.json 仍指向旧
		//    值（自洽可跑）；反过来则会把唯一的明文密钥销毁成悬空引用
		try {
			mergeEnvSecrets(this.envPath, secrets);
		} catch (err) {
			return { status: 500, body: { error: `密钥写入 .env 失败（models.json 未改动）: ${(err as Error).message}` } };
		}
		const next = { ...(file.parsed ?? {}), providers: validated };
		try {
			atomicWrite(this.modelsPath, `${JSON.stringify(next, null, "\t")}\n`);
		} catch (err) {
			return { status: 500, body: { error: `models.json 写入失败（密钥已写入 .env，可直接重试保存）: ${(err as Error).message}` } };
		}
		// 5) 被删/被改的 provider 若正是 settings.json 的持久默认 → 清掉，
		//    否则下次启动 pi / dev.mjs 会拿到一个不存在的默认模型
		this.dropStalePersistedDefault(validated);
		const status = await this.loadStatus();
		return { status: 200, body: { ...status, writtenSecrets: Object.keys(secrets) } };
	}

	/** settings.json 的持久默认若指向已不存在的 provider/model → 删除该默认（保留其他键）。 */
	private dropStalePersistedDefault(validated: Record<string, Record<string, unknown>>): void {
		const persisted = readPersistedDefault(this.agentDir);
		if (!persisted) return;
		const raw = validated[persisted.provider];
		// 内置 provider 可以不在 models.json 里就当默认（apply 的运行时/目录
		// 通道——OAuth 的 anthropic、挂载重启后的 minimax 都没有自带 models）；
		// 目录里仍有的这个 provider/model 不算失效，否则一次无关保存就会把
		// 用户刚应用的默认悄悄清掉
		let stale = !raw && !builtinModelExists(this.builtin, persisted.provider, persisted.modelId);
		if (!stale && Array.isArray(raw?.models)) {
			stale = !raw.models.some((m) => isPlainObject(m) && m.id === persisted.modelId);
		}
		if (!stale) return;
		const path = join(this.agentDir, "settings.json");
		if (!existsSync(path)) return;
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!isPlainObject(parsed)) return;
			delete parsed.defaultProvider;
			delete parsed.defaultModel;
			atomicWrite(path, `${JSON.stringify(parsed, null, "\t")}\n`);
		} catch {
			// 清不掉就留给下次（apply 写入新默认时会重写这两个键）
		}
	}

	/** POST /test：真实打一次「列模型」端点（零 token），验证 URL 可达 + 密钥被接受。 */
	async test(body: ModelsConfigTestRequest): Promise<{ status: number; body: ModelsConfigTestResponse }> {
		let baseUrl: string | undefined;
		let api: string | undefined;
		let apiKey: string | undefined;
		// 判别：按已保存 provider 测，还是用草稿字段直测（未保存前先验 URL/密钥）
		const byId = body as { provider?: unknown };
		if (typeof byId.provider === "string") {
			const file = readModelsFile(this.modelsPath);
			const raw = file.providers[byId.provider];
			if (!raw) return { status: 404, body: { ok: false, message: `provider「${byId.provider}」不在 models.json 里（先保存）` } };
			// 挂载条目（仅 apiKey）自己没有 baseUrl/api → 回退到内置目录
			// （文件值优先；多 api 形态的内置 provider 只测第一个）
			const builtin = this.builtinById.get(byId.provider);
			baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl : builtin?.baseUrl;
			api = typeof raw.api === "string" ? raw.api : builtin?.apis[0];
			const ref = typeof raw.apiKey === "string" ? raw.apiKey : undefined;
			if (ref?.startsWith("!")) {
				return { status: 400, body: { ok: false, message: "apiKey 为 !command 形式，页面不支持测试——请在终端手动验证" } };
			}
			apiKey = resolveKeyRef(ref);
		} else {
			const draft = body as { baseUrl?: unknown; api?: unknown; apiKey?: unknown; apiKeyRef?: unknown };
			baseUrl = typeof draft.baseUrl === "string" ? draft.baseUrl : undefined;
			api = typeof draft.api === "string" ? draft.api : undefined;
			const literal = typeof draft.apiKey === "string" ? draft.apiKey : undefined;
			const ref = typeof draft.apiKeyRef === "string" ? draft.apiKeyRef : undefined;
			if (ref) {
				// $VAR 解引用仅限 models.json 里已被引用的变量：这个端点会把值
				// 发往请求指定的 URL，不能当任意环境变量的读取器
				const file = readModelsFile(this.modelsPath);
				const referenced = new Set<string>();
				for (const raw of Object.values(file.providers)) {
					if (typeof raw.apiKey === "string") {
						const m = raw.apiKey.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
						if (m?.[1]) referenced.add(m[1]);
					}
				}
				const m = ref.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
				const varName = m?.[1];
				if (!varName || !referenced.has(varName)) {
					return { status: 400, body: { ok: false, message: `apiKeyRef「${ref}」不在 models.json 的密钥引用里——先保存该 provider 再测` } };
				}
			}
			apiKey = literal ?? resolveKeyRef(ref);
		}
		if (!baseUrl) return { status: 400, body: { ok: false, message: "缺少 baseUrl（该 provider 与内置目录都未提供 Base URL——如 Azure/Bedrock 类按模型配置的 provider 无法在此测试）" } };
		if (!/^https?:\/\//.test(baseUrl) || !isValidHttpUrl(baseUrl)) {
			return { status: 400, body: { ok: false, message: "baseUrl 需为合法的 http(s) URL" } };
		}
		if (!apiKey) {
			const refHint = "provider" in body ? "其 $VAR 环境变量未设置" : "未提供 apiKey 且其 $VAR 环境变量未设置";
			return { status: 400, body: { ok: false, message: `无密钥可测（${refHint}）——保存密钥后再试` } };
		}
		return { status: 200, body: await runModelProbe(buildModelProbe(baseUrl, api, apiKey)) };
	}

	/**
	 * POST /apply：应用激活模型 —— 编排默认（内存）+ settings.json 持久默认 +
	 * 主会话 set_model；可选重启主 bridge（新增 provider / 新密钥只有新进程可见）。
	 */
	async apply(body: ModelsConfigApplyRequest): Promise<{ status: number; body: ModelsConfigApplyResponse | { error: string } }> {
		let target: { provider: string; modelId: string } | null = null;
		if (body?.activeModel !== undefined) {
			target = splitModelRef(body.activeModel);
			if (!target) return { status: 400, body: { error: `activeModel「${String(body.activeModel)}」非法（需为 provider/model 且整体匹配 ${MODEL_RE}）` } };
			const file = readModelsFile(this.modelsPath);
			const provider = file.providers[target.provider];
			const inFile = Array.isArray(provider?.models) && provider.models.some((m) => isPlainObject(m) && m.id === target!.modelId);
			if (!inFile) {
				// 内置/OAuth provider（anthropic 等）不在 models.json 里，但只要在
				// 运行 bridge 的已认证快照内，set_model 照样可用——页面下拉框的
				// 「（运行时）」选项正来自于此
				const available = await this.rpc({ type: "get_available_models" }, 5000);
				const inRuntime =
					available?.success === true &&
					isPlainObject(available.data) &&
					Array.isArray(available.data.models) &&
					available.data.models.some((m) => isPlainObject(m) && m.provider === target!.provider && m.id === target!.modelId);
				// 目录+重启通道：新挂载的内置条目不在旧运行时快照里，但勾了
				// 「重启 pi」就会出现在新进程——放行，set_model 打到重启后的
				// bridge（目录匹配大小写敏感，与 pi 的模型 id 精确匹配一致）。
				// 没配密钥则新进程里该 provider 不认证，set_model 会如实报错。
				const inCatalogWithRestart =
					body?.restartBridge === true && builtinModelExists(this.builtin, target.provider, target.modelId);
				if (!inRuntime && !inCatalogWithRestart) {
					return { status: 400, body: { error: `模型 ${target.provider}/${target.modelId} 不在 models.json，也不在 pi 当前可用模型里（内置 provider 需先保存密钥并勾选「重启 pi」）` } };
				}
			}
		}
		if (this.deps.isAgentBusy()) {
			return { status: 409, body: { error: "agent 运行中，等待其停止或先中止后再切换模型" } };
		}
		if (this.deps.isRunBusy()) {
			return { status: 409, body: { error: "编排运行中，先中止编排再切换模型" } };
		}

		const result: ModelsConfigApplyResponse = {
			chatSwitched: false,
			restarted: false,
			contextResumed: false,
			orchUpdated: false,
			persisted: false,
			writtenSecrets: [],
		};

		if (target) {
			this.deps.setOrchDefaults(`${target.provider}/${target.modelId}`);
			result.orchUpdated = true;
			const write = writePersistedDefault(this.agentDir, target.provider, target.modelId);
			result.persisted = write.ok;
			if (!write.ok) result.restartError = write.error;
		}

		if (body?.restartBridge) {
			const restart = await this.restartBridge();
			result.restarted = restart.restarted;
			result.contextResumed = restart.contextResumed;
			if (restart.error) result.restartError = restart.error;
		}

		if (target && !result.chatSwitched) {
			const resp = await this.rpc({ type: "set_model", provider: target.provider, modelId: target.modelId }, 10000);
			if (resp?.success) {
				result.chatSwitched = true;
			} else {
				result.chatSwitchError = resp
					? `set_model 失败: ${resp.error ?? "未知错误"}（新增/修改的 provider 需勾选「重启 pi」后生效）`
					: "bridge 不可用或响应超时（pi 未运行？）";
			}
		}
		return { status: 200, body: result };
	}

	/** 计划内重启：等 exit → start → 恢复原会话上下文 → 重探 → 广播 hello。 */
	private async restartBridge(): Promise<{ restarted: boolean; contextResumed: boolean; error?: string }> {
		const bridge = this.deps.bridge;
		const oldPiFile = this.deps.currentPiFile();
		if (bridge.running) {
			const exited = new Promise<void>((resolve) => {
				bridge.once("exit", () => resolve());
			});
			bridge.kill();
			const exitOk = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8000))]);
			if (!exitOk || bridge.running) {
				return { restarted: false, contextResumed: false, error: "pi 未能在 8 秒内退出，已放弃重启（可稍后手动重启 dev）" };
			}
		}
		bridge.start();
		// rpc 循环就绪前 stdin 写入会被缓冲；get_state 即「就绪探针」
		const ready = await this.rpc({ type: "get_state" }, 15000);
		if (!ready) return { restarted: true, contextResumed: false, error: "pi 已重启但 15 秒内未就绪（检查 /health）" };
		let contextResumed = false;
		if (!this.deps.piNoSession && oldPiFile && existsSync(oldPiFile)) {
			const sw = await this.rpc({ type: "switch_session", sessionPath: oldPiFile }, 10000);
			contextResumed = sw?.success === true;
		}
		await this.deps.refreshPiSession();
		this.deps.broadcastHello();
		return { restarted: true, contextResumed };
	}
}

function isValidHttpUrl(url: string): boolean {
	try {
		return new URL(url).protocol === "http:" || new URL(url).protocol === "https:";
	} catch {
		return false;
	}
}

/** "$VAR" / "${VAR}" → process.env[VAR]；其他形式原样返回（字面量）。 */
function resolveKeyRef(ref: string | undefined): string | undefined {
	if (!ref) return undefined;
	const m = ref.match(/^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/);
	if (!m) return ref; // 字面量
	const name = m[1] ?? m[2];
	return name ? process.env[name] : undefined;
}

/** 执行探测：依次尝试候选 URL（10s 超时），404/405 时回退下一个。 */
export async function runModelProbe(probe: ModelProbe): Promise<ModelsConfigTestResponse> {
	for (let i = 0; i < probe.urls.length; i++) {
		const url = probe.urls[i]!;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 10000);
		try {
			const res = await fetch(url, { headers: probe.headers, signal: controller.signal });
			if ((res.status === 404 || res.status === 405) && i < probe.urls.length - 1) continue;
			const sampleModels = res.ok ? extractModelIds(await res.json().catch(() => null)) : undefined;
			if (res.ok) {
				return {
					ok: true,
					probedUrl: url,
					status: res.status,
					message: `连接成功（HTTP ${res.status}）${sampleModels?.length ? `，端点模型样例：${sampleModels.join(", ")}` : ""}`,
					sampleModels,
				};
			}
			if (res.status === 401 || res.status === 403) {
				return { ok: false, probedUrl: url, status: res.status, message: `密钥被拒绝（HTTP ${res.status}）——检查密钥是否正确/有效` };
			}
			return { ok: false, probedUrl: url, status: res.status, message: `端点返回 HTTP ${res.status}——检查 Base URL 与 API 类型` };
		} catch (err) {
			const message = err instanceof Error && err.name === "AbortError" ? "请求超时（10s）" : `网络错误: ${(err as Error).message}`;
			if (i < probe.urls.length - 1) continue;
			return { ok: false, probedUrl: url, message };
		} finally {
			clearTimeout(timer);
		}
	}
	return { ok: false, message: "无可用探测 URL" };
}

// ============================================================================
// HTTP 子路由（挂载在 /api/models）
// ============================================================================

export interface ModelsApi {
	service: ModelsConfigService;
}

export function modelsRoutes(api: ModelsApi): Hono {
	const app = new Hono();

	app.get("/", async (c) => c.json(await api.service.loadStatus()));

	app.put("/", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "请求体需为 JSON" }, 400);
		}
		const result = await api.service.save(body as ModelsConfigSaveRequest);
		return c.json(result.body as Record<string, unknown>, result.status as 200 | 400 | 409 | 500);
	});

	app.post("/test", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "请求体需为 JSON" }, 400);
		}
		const result = await api.service.test(body as ModelsConfigTestRequest);
		return c.json(result.body as unknown as Record<string, unknown>, result.status as 200 | 400 | 404);
	});

	app.post("/apply", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			body = {};
		}
		const result = await api.service.apply(body as ModelsConfigApplyRequest);
		return c.json(result.body as Record<string, unknown>, result.status as 200 | 400 | 409);
	});

	return app;
}
