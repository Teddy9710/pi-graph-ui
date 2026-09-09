/**
 * 模型配置页 DTO — server（读写 ~/.pi/agent/models.json 等）与 web（配置页）
 * 之间的 HTTP 契约。纯数据形状，无行为。
 *
 * 安全约定：任何响应都不携带解析后的密钥明文 —— provider 只暴露
 * apiKeyRef（"$VAR" 引用）+ apiKeyEnvSet（变量是否已在环境里），密钥值
 * 只在保存请求里单向流入（写入 .env + process.env），从不回流。
 */

/** pi models.json 里一个 model 条目的核心字段（其余字段原样保留）。 */
export interface ModelConfigModelInfo {
	id: string;
	name?: string;
}

/** GET /api/models —— 单个 provider 的对外形状。 */
export interface ModelConfigProviderInfo {
	/** 显示名（缺省用 provider id）。 */
	name?: string;
	baseUrl?: string;
	/** API 形态，如 "openai-completions" / "anthropic-messages"。 */
	api?: string;
	/** models.json 里的 apiKey 引用（"$VAR" / "${VAR}" / "!cmd"）；字面量密钥不回传。 */
	apiKeyRef?: string;
	/** models.json 里存的是字面量密钥（不入页面；保存时留空则原样保留）。 */
	apiKeyInline: boolean;
	/** apiKeyRef 指向的环境变量是否已在 server 进程里可用。 */
	apiKeyEnvSet: boolean;
	models: ModelConfigModelInfo[];
	/** 原样保留、页面不编辑的高级字段名（compat / headers / modelOverrides…）。 */
	advancedFields: string[];
	/**
	 * provider 的完整原始 JSON（PUT 时原样带回，保全页面不编辑的字段；
	 * 字面量 apiKey 已被置 ""——保存时留 ""/缺省 = 沿用旧值，null = 删除，
	 * 其余（$VAR 引用或新明文）= 覆盖）。
	 */
	raw: Record<string, unknown>;
}

/** GET /api/models —— 主 bridge 当前模型（get_state），pi 不在时为 null。 */
export interface ActiveModelInfo {
	provider: string;
	id: string;
	name?: string;
}

/** GET /api/models 响应。 */
export interface ModelsConfigResponse {
	agentDir: string;
	modelsPath: string;
	/** 密钥落盘的 .env 路径（仓库根，已被 gitignore）。 */
	envPath: string;
	providers: Record<string, ModelConfigProviderInfo>;
	/** 主会话 pi 正在使用的模型；bridge 未运行时 null。 */
	activeModel: ActiveModelInfo | null;
	/** 主 bridge 启动时已认证的模型快照（RPC get_available_models）。 */
	runtimeModels: ActiveModelInfo[];
	/** settings.json 里持久化的默认模型（重启后 pi 的初始模型）。 */
	persistedDefault: { provider: string; modelId: string } | null;
	/** 编排节点 / planner 当前使用的默认模型（server 内存值）。 */
	orchDefaults: { nodeDefault: string; plannerModel: string };
	/** models.json 读取/解析失败的错误信息（provider 列表可能为空）。 */
	configError?: string;
}

/**
 * PUT /api/models 请求体。
 *
 * providers 的值是完整的 provider JSON（页面未编辑的高级字段原样带回），
 * apiKey 允许三种值："$VAR" 引用（原样保留）、字面量密钥（server 会转成
 * "$VAR" 引用并把明文写进 .env / process.env，models.json 不落明文）、
 * 缺省（该 provider 无密钥）。secrets 是「不改 models.json 只更新密钥」
 * 的通道：键为环境变量名。
 */
export interface ModelsConfigSaveRequest {
	providers: Record<string, unknown>;
	secrets?: Record<string, string>;
}

/** PUT /api/models 响应（保存后重新计算的状态，不含密钥明文）。 */
export interface ModelsConfigSaveResponse extends ModelsConfigResponse {
	/** 本次写入 .env / process.env 的变量名（给页面回显「已写入 N 个密钥」）。 */
	writtenSecrets: string[];
}

/** POST /api/models/test —— 按 provider id 测已保存配置，或用草稿字段直测。 */
export type ModelsConfigTestRequest =
	| { provider: string }
	| { baseUrl: string; api?: string; apiKey?: string; apiKeyRef?: string };

/** POST /api/models/test 响应。 */
export interface ModelsConfigTestResponse {
	ok: boolean;
	/** 实际请求的 URL（诊断用；可能经历一次 /v1 回退重试）。 */
	probedUrl?: string;
	/** HTTP 状态码（网络失败时缺省）。 */
	status?: number;
	message: string;
	/** 端点返回的 model id 样例（最多几个）。 */
	sampleModels?: string[];
}

/** POST /api/models/apply 请求。 */
export interface ModelsConfigApplyRequest {
	/** "provider/model"，同时应用于主会话 / 编排默认 / settings.json 持久默认。 */
	activeModel?: string;
	/** 重启主 bridge（新增/修改 provider 或新密钥只对新 pi 进程可见，需重启）。 */
	restartBridge?: boolean;
}

/** POST /api/models/apply 响应。 */
export interface ModelsConfigApplyResponse {
	/** 主会话 RPC set_model 是否成功（bridge 未重启且模型已在快照内）。 */
	chatSwitched: boolean;
	chatSwitchError?: string;
	/** bridge 是否被重启。 */
	restarted: boolean;
	/** 重启后是否恢复了原会话上下文（switch_session 回旧 pi 会话文件）。 */
	contextResumed: boolean;
	restartError?: string;
	/** 编排默认模型是否更新（executor/planner 内存值）。 */
	orchUpdated: boolean;
	/** settings.json 持久默认是否写入。 */
	persisted: boolean;
	/** 写入 process.env / .env 的密钥变量名。 */
	writtenSecrets: string[];
}
