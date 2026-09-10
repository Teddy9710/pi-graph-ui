/**
 * ModelsConfigService tests — 模型配置页的后端契约：
 *   - 校验器：id/baseUrl/api/model id（允许 /，openrouter 式）/字面量密钥→
 *     $VAR 转写/混合模板与换行拒绝/变量名折叠冲突/未知字段保留
 *   - 文件层：models.json 原子写 + 顶层未知键保留 + 损坏拒写 + pi 同款注释
 *     容忍（// 与尾逗号）；settings.json 合并写与陈旧默认清理；.env 合并写
 *     （保留无关行）+ process.env 补丁 + 写失败时不碰 models.json
 *   - apply：busy 守卫、编排默认热替换、持久默认、set_model、运行时快照
 *     兜底（内置 provider）、计划内重启
 *   - 内置 provider 目录：撞名守卫（新建内置 id 覆盖 → 400 / 挂载与既有
 *     条目放行）、loadStatus 冲突警告与 builtinProviders 标记、apply 的
 *     目录+重启通道（挂载条目不在旧快照也放行）、test 的目录 baseUrl/api
 *     回退、内置 id 字面量密钥折到目录 env 名（google → GEMINI_API_KEY）
 *   - test：字面量/引用/草稿三通道、apiKeyRef 仅限已引用变量、URL 校验
 *   - 纯工具：splitModelRef / buildModelProbe / runModelProbe（stub fetch）
 * 全部跑在 tmpdir 上，绝不触碰真实 ~/.pi 与仓库 .env。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltinCatalogFile, RpcCommand, RpcResponse } from "@pi-graph/shared";
import {
	buildModelProbe,
	ModelsConfigService,
	type ModelsBridgeLike,
	type ModelsConfigDeps,
	mergeEnvSecrets,
	runModelProbe,
	splitModelRef,
	toEnvVarName,
	validateProvider,
} from "../src/models-config.ts";

// ============================================================================
// Fakes
// ============================================================================

class FakeBridge extends Object {
	running = true;
	killed = false;
	started = 0;
	requests: RpcCommand[] = [];
	private listeners = new Map<string, Array<(code: number | null, stderr: string) => void>>();
	constructor(private responses: Record<string, RpcResponse | Error> = {}) {
		super();
	}
	request(command: RpcCommand): Promise<RpcResponse> {
		this.requests.push(command);
		const scripted = this.responses[command.type];
		if (scripted instanceof Error) return Promise.reject(scripted);
		if (scripted) return Promise.resolve(scripted);
		return Promise.resolve({ type: "response", command: command.type, success: true, data: null });
	}
	kill(): void {
		this.killed = true;
		this.running = false;
		// 真实 bridge 的 exit 在进程 close 后异步到达
		setTimeout(() => this.emitExit(), 10);
	}
	start(): void {
		this.started++;
		this.running = true;
	}
	/** 测试里手动触发 exit（kill 的异步回声）。 */
	emitExit(): void {
		for (const l of this.listeners.get("exit") ?? []) l(0, "");
		this.listeners.clear();
	}
	once(event: "exit", listener: (code: number | null, stderr: string) => void): unknown {
		const list = this.listeners.get(event) ?? [];
		list.push(listener);
		this.listeners.set(event, list);
		return this;
	}
}

function makeDeps(bridge: FakeBridge, overrides: Partial<ModelsConfigDeps> = {}): ModelsConfigDeps {
	return {
		bridge,
		getOrchDefaults: () => ({ nodeDefault: "deepseek/deepseek-chat", plannerModel: "deepseek/deepseek-chat" }),
		setOrchDefaults: vi.fn(),
		isAgentBusy: () => false,
		isRunBusy: () => false,
		currentPiFile: () => null,
		refreshPiSession: vi.fn(async () => {}),
		broadcastHello: vi.fn(),
		piNoSession: false,
		...overrides,
	};
}

let dir: string;
let envPath: string;

/**
 * 目录 fixture（真实目录的缩影：env-key 三家 + oauth 一家）。真实快照的
 * 结构断言在 builtin-providers.test.ts；这里用受控数据驱动守卫/回退逻辑。
 */
function makeCatalog(): BuiltinCatalogFile {
	return {
		piVersion: "0.84.2-test",
		generatedAt: "2026-09-09T00:00:00.000Z",
		providers: [
			{
				id: "minimax",
				name: "MiniMax",
				baseUrl: "https://api.minimax.io/anthropic",
				apis: ["anthropic-messages"],
				apiKeyEnv: "MINIMAX_API_KEY",
				authKind: "env-key",
				models: [{ id: "MiniMax-M3", reasoning: true, contextWindow: 1000000 }],
			},
			{
				id: "deepseek",
				name: "DeepSeek",
				baseUrl: "https://api.deepseek.com/v1",
				apis: ["openai-completions"],
				apiKeyEnv: "DEEPSEEK_API_KEY",
				authKind: "env-key",
				models: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro", reasoning: true }],
			},
			{
				id: "google",
				name: "Google",
				apis: ["google-generative-ai"],
				apiKeyEnv: "GEMINI_API_KEY",
				authKind: "env-key",
				models: [{ id: "gemini-2.5-pro" }],
			},
			{
				id: "github-copilot",
				name: "GitHub Copilot",
				baseUrl: "https://api.githubcopilot.com",
				apis: ["openai-completions"],
				apiKeyEnv: "GITHUB_COPILOT_TOKEN",
				authKind: "oauth",
				models: [],
			},
		],
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pg-models-"));
	envPath = join(dir, ".env");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("PG_TEST_")) delete process.env[key];
	}
	// fixture 目录的真实 env 名（mergeEnvSecrets / envSet 测试会写入）
	for (const key of ["MINIMAX_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "GITHUB_COPILOT_TOKEN"]) {
		delete process.env[key];
	}
	vi.unstubAllGlobals();
});

// ============================================================================
// 纯工具
// ============================================================================

describe("toEnvVarName", () => {
	it("provider id → 大写蛇形 _API_KEY", () => {
		expect(toEnvVarName("deepseek")).toBe("DEEPSEEK_API_KEY");
		expect(toEnvVarName("my-proxy")).toBe("MY_PROXY_API_KEY");
		expect(toEnvVarName("kimi.k2")).toBe("KIMI_K2_API_KEY");
	});
});

describe("splitModelRef", () => {
	it("按第一个 / 切分（与 pi 的解析一致）", () => {
		expect(splitModelRef("deepseek/deepseek-chat")).toEqual({ provider: "deepseek", modelId: "deepseek-chat" });
	});
	it("拒绝缺边、非法字符、空段", () => {
		expect(splitModelRef("deepseek/")).toBeNull();
		expect(splitModelRef("/model")).toBeNull();
		expect(splitModelRef("deepseek")).toBeNull();
		expect(splitModelRef("a/b c")).toBeNull(); // 空格不匹配 MODEL_RE
	});
});

describe("buildModelProbe", () => {
	it("openai 形态：Bearer + /models，非 /v1 结尾时带回退 URL", () => {
		const probe = buildModelProbe("https://api.deepseek.com/v1", "openai-completions", "sk-x");
		expect(probe.urls).toEqual(["https://api.deepseek.com/v1/models"]);
		expect(probe.headers).toEqual({ Authorization: "Bearer sk-x" });

		const fallback = buildModelProbe("https://proxy.example.com", undefined, "sk-x");
		expect(fallback.urls).toEqual(["https://proxy.example.com/models", "https://proxy.example.com/v1/models"]);
	});
	it("anthropic 形态：x-api-key + anthropic-version + /v1 前缀", () => {
		const probe = buildModelProbe("https://api.anthropic.com", "anthropic-messages", "sk-ant");
		expect(probe.urls).toEqual(["https://api.anthropic.com/v1/models"]);
		expect(probe.headers["x-api-key"]).toBe("sk-ant");
		expect(probe.headers["anthropic-version"]).toBe("2023-06-01");
	});
	it("末尾斜杠被规整", () => {
		const probe = buildModelProbe("https://api.deepseek.com/v1/", "openai-completions", "k");
		expect(probe.urls[0]).toBe("https://api.deepseek.com/v1/models");
	});
});

describe("runModelProbe", () => {
	it("401 → 密钥被拒绝且不回退", async () => {
		const fetchMock = vi.fn(async () => new Response("denied", { status: 401 }));
		vi.stubGlobal("fetch", fetchMock);
		const res = await runModelProbe(buildModelProbe("https://x.example/v1", undefined, "k"));
		expect(res.ok).toBe(false);
		expect(res.status).toBe(401);
		expect(res.message).toContain("密钥被拒绝");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it("404 → 回退到 /v1/models；成功时提取模型样例", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("nope", { status: 404 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const res = await runModelProbe(buildModelProbe("https://x.example", undefined, "k"));
		expect(res.ok).toBe(true);
		expect(res.probedUrl).toBe("https://x.example/v1/models");
		expect(res.sampleModels).toEqual(["m1", "m2"]);
	});
	it("网络错误 → 中文诊断", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
		const res = await runModelProbe(buildModelProbe("https://x.example/v1", undefined, "k"));
		expect(res.ok).toBe(false);
		expect(res.message).toContain("网络错误");
	});
});

// ============================================================================
// 校验器
// ============================================================================

describe("validateProvider", () => {
	it("完整合法条目 + 高级字段识别", () => {
		const issues: string[] = [];
		const [v] = validateProvider(
			"deepseek",
			{
				name: "DeepSeek",
				baseUrl: "https://api.deepseek.com/v1",
				api: "openai-completions",
				apiKey: "$DEEPSEEK_API_KEY",
				models: [
					{ id: "deepseek-chat", name: "Chat" },
					{ id: "deepseek-reasoner", name: "Reasoner", reasoning: true, cost: { input: 0.14, output: 0.28, cacheRead: 0, cacheWrite: 0 } },
				],
				compat: { thinkingFormat: "deepseek" },
			},
			issues,
		);
		expect(issues).toEqual([]);
		expect(v).not.toBeNull();
		expect(v!.info.advancedFields).toEqual(["compat"]); // compat 不在核心字段集
		expect(v!.raw.compat).toEqual({ thinkingFormat: "deepseek" }); // 原样保留
		expect(v!.info.models).toEqual([
			{ id: "deepseek-chat", name: "Chat" },
			{ id: "deepseek-reasoner", name: "Reasoner" },
		]);
	});
	it("字面量密钥 → 转写为 $VAR 引用并提取 secret；models.json 永不落明文", () => {
		process.env.PG_TEST_KIMI_API_KEY = undefined;
		const issues: string[] = [];
		const [v] = validateProvider("kimi", { baseUrl: "https://x", apiKey: "sk-literal", models: [{ id: "k2" }] }, issues);
		expect(v!.secret).toEqual({ KIMI_API_KEY: "sk-literal" });
		expect(v!.raw.apiKey).toBe("$KIMI_API_KEY");
		expect(v!.info.apiKeyRef).toBe("$KIMI_API_KEY");
		expect(v!.info.apiKeyEnvSet).toBe(false); // process.env 里还没有
	});
	it("已设置的环境变量 → apiKeyEnvSet=true", () => {
		process.env.PG_TEST_SET_API_KEY = "yes";
		const [v] = validateProvider("set", { apiKey: "$PG_TEST_SET_API_KEY" }, []);
		expect(v!.info.apiKeyEnvSet).toBe(true);
	});
	it("${VAR} 花括号形式也识别", () => {
		process.env.PG_TEST_BRACED = "yes";
		const [v] = validateProvider("braced", { apiKey: "${PG_TEST_BRACED}" }, []);
		expect(v!.info.apiKeyEnvSet).toBe(true);
	});
	it("!command 形式原样保留", () => {
		const [v] = validateProvider("cmdprov", { apiKey: "!op read key" }, []);
		expect(v!.raw.apiKey).toBe("!op read key");
		expect(v!.info.apiKeyEnvSet).toBe(false);
	});
	it.each([
		["bad/id", "含 /"], // provider id 带 / 会破坏 provider/model 切分
		["", "空 id"],
	])("非法 provider id「%s」→ issue（%s）", (id) => {
		const issues: string[] = [];
		expect(validateProvider(id, {}, issues)[0]).toBeNull();
		expect(issues.length).toBeGreaterThan(0);
	});
	it.each([
		[{ baseUrl: "ftp://x" }, "协议"],
		[{ baseUrl: "not a url" }, "格式"],
	])("非法 baseUrl → issue", (entry) => {
		const issues: string[] = [];
		expect(validateProvider("p", entry, issues)[0]).toBeNull();
		expect(issues[0]).toContain("baseUrl");
	});
	it("model id 允许 /（openrouter 式 id 是 pi 的正规用法）；重复仍拒绝", () => {
		const issues: string[] = [];
		const [v] = validateProvider("openrouter", { models: [{ id: "meta/llama-3.3-70b-instruct" }] }, issues);
		expect(issues).toEqual([]);
		expect(v!.info.models).toEqual([{ id: "meta/llama-3.3-70b-instruct" }]);
		issues.length = 0;
		expect(validateProvider("p", { models: [{ id: "m" }, { id: "m" }] }, issues)[0]).toBeNull();
		expect(issues[0]).toContain("重复");
	});
	it.each([
		[{ apiKey: "sk-${VAR}" }, "混合模板"],
		[{ apiKey: "$4GL_API_KEY" }, "数字开头的伪引用"],
		[{ apiKey: "k".repeat(4097) }, "超长"],
		[{ apiKey: "sk-1\nEVIL=1" }, "换行"],
	])("apiKey %j → issue（%s）", (entry, label) => {
		const issues: string[] = [];
		expect(validateProvider("p", { ...entry, models: [{ id: "m" }] }, issues)[0]).toBeNull();
		expect(issues.length).toBeGreaterThan(0);
		void label;
	});
	it("数字开头 provider id（4gl）+ 字面量密钥 → issue（4GL_API_KEY 不是合法变量名，密钥永远无法生效）", () => {
		const issues: string[] = [];
		expect(validateProvider("4gl", { apiKey: "sk-1", models: [{ id: "m" }] }, issues)[0]).toBeNull();
		expect(issues[0]).toContain("变量名");
	});
	it("preferEnvVar：内置 id 的字面量密钥折到目录 env 名（google → $GEMINI_API_KEY 而非 $GOOGLE_API_KEY）", () => {
		const issues: string[] = [];
		const [v] = validateProvider("google", { apiKey: "sk-g" }, issues, "GEMINI_API_KEY");
		expect(issues).toEqual([]);
		expect(v!.secret).toEqual({ GEMINI_API_KEY: "sk-g" });
		expect(v!.raw.apiKey).toBe("$GEMINI_API_KEY");
		// 不传 preferEnvVar 时维持旧行为（id 折叠）——兼容自定义 provider
		const [fallback] = validateProvider("google", { apiKey: "sk-g" }, []);
		expect(fallback!.raw.apiKey).toBe("$GOOGLE_API_KEY");
	});
});

// ============================================================================
// .env 合并
// ============================================================================

describe("mergeEnvSecrets", () => {
	it("新文件：写入 KEY=VALUE（无引号）", () => {
		const written = mergeEnvSecrets(envPath, { PG_TEST_NEW_KEY: "sk-1" });
		expect(written).toEqual(["PG_TEST_NEW_KEY"]);
		expect(readFileSync(envPath, "utf8")).toBe("PG_TEST_NEW_KEY=sk-1\n");
		expect(process.env.PG_TEST_NEW_KEY).toBe("sk-1");
	});
	it("已有文件：只改写目标变量，注释/空行/别人的变量原样保留", () => {
		writeFileSync(envPath, "# dev keys\nPORT=9999\n\nPG_TEST_OLD_KEY=sk-old\nEXTRA=keep\n", "utf8");
		mergeEnvSecrets(envPath, { PG_TEST_OLD_KEY: "sk-new", PG_TEST_ADD_KEY: "sk-add" });
		expect(readFileSync(envPath, "utf8")).toBe("# dev keys\nPORT=9999\n\nPG_TEST_OLD_KEY=sk-new\nEXTRA=keep\nPG_TEST_ADD_KEY=sk-add\n");
	});
	it("空 secrets → 不动文件", () => {
		writeFileSync(envPath, "A=1\n", "utf8");
		expect(mergeEnvSecrets(envPath, {})).toEqual([]);
		expect(readFileSync(envPath, "utf8")).toBe("A=1\n");
	});
});

// ============================================================================
// Service：文件读写
// ============================================================================

function makeService(
	bridge: FakeBridge,
	overrides: Partial<ModelsConfigDeps> = {},
	catalog: BuiltinCatalogFile = makeCatalog(),
): ModelsConfigService {
	return new ModelsConfigService(makeDeps(bridge, overrides), dir, envPath, catalog);
}

describe("ModelsConfigService.save", () => {
	it("写入 models.json（tab 缩进）+ 顶层未知键保留 + 字面量密钥进 .env", async () => {
		// deepseek 预写为「既有覆盖条目」——新建的内置 id 覆盖条目会被撞名
		// 守卫拦下（见「内置撞名守卫」组），既有条目照常保存（用户真实场景）
		writeFileSync(
			join(dir, "models.json"),
			JSON.stringify({ providers: { old: { baseUrl: "https://o" }, deepseek: { baseUrl: "https://old" } }, customTop: 1 }),
			"utf8",
		);
		const service = makeService(new FakeBridge());
		const res = await service.save({
			providers: {
				deepseek: { baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", apiKey: "sk-lit", models: [{ id: "deepseek-chat" }] },
			},
		});
		expect(res.status).toBe(200);
		const written = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
		expect(written.customTop).toBe(1); // 未知顶层键不丢
		expect(written.providers.deepseek.apiKey).toBe("$DEEPSEEK_API_KEY"); // 明文转引用
		expect(written.providers).not.toHaveProperty("old"); // 整表替换：没带的 provider 被删除
		expect(readFileSync(envPath, "utf8")).toBe("DEEPSEEK_API_KEY=sk-lit\n");
		expect(res.body).toMatchObject({ writtenSecrets: ["DEEPSEEK_API_KEY"] });
		expect(process.env.DEEPSEEK_API_KEY).toBe("sk-lit");
	});
	it("secrets 通道：不改 models.json 只更新密钥", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { p: { apiKey: "$PG_TEST_S" } } }), "utf8");
		const service = makeService(new FakeBridge());
		const res = await service.save({ providers: { p: { apiKey: "$PG_TEST_S" } }, secrets: { PG_TEST_S: "sk-2" } });
		expect(res.status).toBe(200);
		expect(process.env.PG_TEST_S).toBe("sk-2");
	});
	it("校验失败 → 400 + issues，文件不动", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: {} }), "utf8");
		const service = makeService(new FakeBridge());
		const res = await service.save({ providers: { "bad/id": {} } });
		expect(res.status).toBe(400);
		if ("issues" in res.body) expect(res.body.issues.length).toBeGreaterThan(0);
		expect(JSON.parse(readFileSync(join(dir, "models.json"), "utf8"))).toEqual({ providers: {} });
	});
	it("models.json 损坏 → 409 拒绝覆盖", async () => {
		writeFileSync(join(dir, "models.json"), "{ not json", "utf8");
		const service = makeService(new FakeBridge());
		const res = await service.save({ providers: {} });
		expect(res.status).toBe(409);
	});
	it("非法 secret 名/值 → 400", async () => {
		const service = makeService(new FakeBridge());
		expect((await service.save({ providers: {}, secrets: { "lower-case": "v" } })).status).toBe(400);
		expect((await service.save({ providers: {}, secrets: { PG_TEST_X: "line\nbreak" } })).status).toBe(400);
	});
	it("secrets 通道：敏感变量名（NODE_OPTIONS 等）与未引用变量 → 400（不是任意 env 注入面）", async () => {
		const service = makeService(new FakeBridge());
		const denied = await service.save({ providers: { p: { apiKey: "$NODE_OPTIONS" } }, secrets: { NODE_OPTIONS: "--import=evil" } });
		expect(denied.status).toBe(400);
		if ("error" in denied.body) expect(denied.body.error).toContain("敏感");
		const unref = await service.save({ providers: { p: { apiKey: "$PG_TEST_A" } }, secrets: { PG_TEST_B: "v" } });
		expect(unref.status).toBe(400);
		if ("error" in unref.body) expect(unref.body.error).toContain("未");
	});
	it("字面量密钥含换行 → 400 且 .env 不创建（.env 整行注入防护）", async () => {
		const service = makeService(new FakeBridge());
		const res = await service.save({ providers: { p: { apiKey: "sk-1\nEVIL=1", models: [{ id: "m" }] } } });
		expect(res.status).toBe(400);
		expect(existsSync(envPath)).toBe(false);
	});
	it("密钥变量名折叠冲突（foo.bar 与 foo_bar 都折成 FOO_BAR_API_KEY）→ 400", async () => {
		const service = makeService(new FakeBridge());
		const res = await service.save({
			providers: {
				"foo.bar": { apiKey: "sk-1", models: [{ id: "m" }] },
				foo_bar: { apiKey: "sk-2", models: [{ id: "m" }] },
			},
		});
		expect(res.status).toBe(400);
		if ("issues" in res.body) expect(res.body.issues[0]).toContain("折叠");
	});
	it("!command 密钥：''=原样沿用；新写/改写 → 400（shell 执行面不对页面开放）", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { c: { apiKey: "!op read key", models: [{ id: "m" }] } } }), "utf8");
		const service = makeService(new FakeBridge());
		const status = await service.loadStatus();
		expect(status.providers.c?.raw.apiKey).toBe("!op read key"); // 不脱敏，页面原样带回
		const keep = await service.save({ providers: { c: status.providers.c!.raw } });
		expect(keep.status).toBe(200);
		expect(JSON.parse(readFileSync(join(dir, "models.json"), "utf8")).providers.c.apiKey).toBe("!op read key");
		const added = await service.save({ providers: { c: status.providers.c!.raw, d: { apiKey: "!cmd other" } } });
		expect(added.status).toBe(400);
	});
	it(".env 写失败（envPath 是目录）→ 500 且 models.json 不动（先密钥后配置，反向不销毁唯一明文）", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { old: { baseUrl: "https://o" } } }), "utf8");
		mkdirSync(join(dir, "envblock"));
		const service = new ModelsConfigService(makeDeps(new FakeBridge()), dir, join(dir, "envblock"));
		const res = await service.save({ providers: { p: { apiKey: "sk-x", models: [{ id: "m" }] } } });
		expect(res.status).toBe(500);
		if ("error" in res.body) expect(res.body.error).toContain(".env");
		expect(JSON.parse(readFileSync(join(dir, "models.json"), "utf8"))).toEqual({ providers: { old: { baseUrl: "https://o" } } });
	});
	it("删除持久默认指向的 provider → settings.json 的默认键被清（其他键保留）", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { d: { models: [{ id: "m" }] } } }), "utf8");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "d", defaultModel: "m", theme: "dark" }), "utf8");
		const service = makeService(new FakeBridge());
		expect((await service.save({ providers: {} })).status).toBe(200);
		expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ theme: "dark" });
	});
	it("持久默认的 model 被移除（provider 还在）→ 清除；默认仍有效 → 不动", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { d: { models: [{ id: "m" }, { id: "m2" }] } } }), "utf8");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "d", defaultModel: "gone" }), "utf8");
		const service = makeService(new FakeBridge());
		expect((await service.save({ providers: { d: { models: [{ id: "m" }] } } })).status).toBe(200);
		expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({});
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "d", defaultModel: "m", keep: 1 }), "utf8");
		expect((await service.save({ providers: { d: { models: [{ id: "m" }] } } })).status).toBe(200);
		expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ defaultProvider: "d", defaultModel: "m", keep: 1 });
	});
	it("持久默认指向内置目录 provider（不在 models.json——运行时/目录通道的产物）→ 无关保存不清除", async () => {
		// 用户经「（运行时）/（内置）」选项应用了 google（OAuth 内置，无 models.json
		// 条目），之后只动 deepseek 保存——默认不能被悄悄清掉
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { deepseek: { baseUrl: "https://api.deepseek.com/v1" } } }), "utf8");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "google", defaultModel: "gemini-2.5-pro" }), "utf8");
		const service = makeService(new FakeBridge());
		expect((await service.save({ providers: { deepseek: { baseUrl: "https://api.deepseek.com/v1" } } })).status).toBe(200);
		expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ defaultProvider: "google", defaultModel: "gemini-2.5-pro" });
	});
	it("持久默认指向内置 provider 但 model id 与目录不符（大小写敏感）→ 仍清除", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { d: { models: [{ id: "m" }] } } }), "utf8");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "minimax", defaultModel: "minimax-m3" }), "utf8");
		const service = makeService(new FakeBridge());
		expect((await service.save({ providers: { d: { models: [{ id: "m" }] } } })).status).toBe(200);
		expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({});
	});
	it("密钥携带规则：''/缺省=沿用（并规范化为 $VAR + .env）；null=删除；新明文=覆盖转写", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { p: { apiKey: "sk-keep-me", models: [{ id: "m" }] } } }), "utf8");
		const service = makeService(new FakeBridge());
		// GET 视角：字面量不出网（"" 哨兵 + apiKeyInline 标记）
		const status = await service.loadStatus();
		expect(status.providers.p!.raw.apiKey).toBe("");
		expect(status.providers.p!.apiKeyInline).toBe(true);
		expect(JSON.stringify(status)).not.toContain("sk-keep-me");
		// 页面原样带回 ""（没动密钥）→ 字面量被规范化：models.json 只存 $VAR
		// 引用，明文落 .env（密钥持续可用，且从此不再明文躺在 models.json）
		const keep = await service.save({ providers: { p: status.providers.p!.raw } });
		expect(keep.status).toBe(200);
		expect(JSON.parse(readFileSync(join(dir, "models.json"), "utf8")).providers.p.apiKey).toBe("$P_API_KEY");
		expect(readFileSync(envPath, "utf8")).toBe("P_API_KEY=sk-keep-me\n");
		expect(process.env.P_API_KEY).toBe("sk-keep-me");
		// null → 显式删除
		const removed = await service.save({ providers: { p: { ...status.providers.p!.raw, apiKey: null } } });
		expect(removed.status).toBe(200);
		expect(JSON.parse(readFileSync(join(dir, "models.json"), "utf8")).providers.p.apiKey).toBeUndefined();
	});
});

// ============================================================================
// 内置撞名守卫（新建的内置 id 覆盖条目 → 400；挂载与既有条目放行）
// ============================================================================

describe("内置撞名守卫", () => {
	it("新建内置 id + baseUrl/api/models → 400，models.json 与 .env 都不动", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: {} }), "utf8");
		const service = makeService(new FakeBridge());
		const res = await service.save({
			providers: {
				minimax: { baseUrl: "https://api.minimax.cn/v1", api: "openai-completions", apiKey: "sk-x", models: [{ id: "Minimax-M3" }] },
			},
		});
		expect(res.status).toBe(400);
		if ("issues" in res.body) {
			expect(res.body.issues[0]).toContain("MiniMax");
			expect(res.body.issues[0]).toContain("已拒绝保存");
		}
		expect(JSON.parse(readFileSync(join(dir, "models.json"), "utf8"))).toEqual({ providers: {} });
		expect(existsSync(envPath)).toBe(false);
	});
	it("仅覆盖非空 models（无 baseUrl）同样拦", async () => {
		const service = makeService(new FakeBridge());
		const res = await service.save({ providers: { minimax: { apiKey: "$MINIMAX_API_KEY", models: [{ id: "MiniMax-M3" }] } } });
		expect(res.status).toBe(400);
	});
	it.each([["compat"], ["headers"], ["modelOverrides"], ["authHeader"]])("高级字段 %s 也是覆盖 → 400", async (field) => {
		const service = makeService(new FakeBridge());
		const res = await service.save({ providers: { minimax: { apiKey: "$MINIMAX_API_KEY", [field]: { x: 1 } } } });
		expect(res.status).toBe(400);
	});
	it("models: [] 不算覆盖（pi 的 !config.models?.length 同语义）→ 200", async () => {
		const service = makeService(new FakeBridge());
		const res = await service.save({ providers: { minimax: { apiKey: "$MINIMAX_API_KEY", models: [] } } });
		expect(res.status).toBe(200);
	});
	it("纯挂载（仅 apiKey）+ secrets → 200，models.json 恰为挂载条目、明文落 .env", async () => {
		const service = makeService(new FakeBridge());
		const res = await service.save({
			providers: { minimax: { apiKey: "$MINIMAX_API_KEY" } },
			secrets: { MINIMAX_API_KEY: "sk-m" },
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(readFileSync(join(dir, "models.json"), "utf8"))).toEqual({
			providers: { minimax: { apiKey: "$MINIMAX_API_KEY" } },
		});
		expect(readFileSync(envPath, "utf8")).toBe("MINIMAX_API_KEY=sk-m\n");
		expect(process.env.MINIMAX_API_KEY).toBe("sk-m");
	});
	it("挂载条目 + name（显示名不算覆盖）→ 200", async () => {
		const service = makeService(new FakeBridge());
		const res = await service.save({ providers: { minimax: { apiKey: "$MINIMAX_API_KEY", name: "MiniMax 国际" } } });
		expect(res.status).toBe(200);
	});
	it("新建 google 挂载 + 字面量密钥 → 折成 $GEMINI_API_KEY 而非 $GOOGLE_API_KEY（env 名以目录为准）", async () => {
		const service = makeService(new FakeBridge());
		const res = await service.save({ providers: { google: { apiKey: "sk-g" } } });
		expect(res.status).toBe(200);
		const written = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
		expect(written.providers.google.apiKey).toBe("$GEMINI_API_KEY");
		expect(readFileSync(envPath, "utf8")).toBe("GEMINI_API_KEY=sk-g\n");
	});
	it("既有挂载条目换密钥 → 200（挂载条目的正常维护路径）", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { minimax: { apiKey: "$MINIMAX_API_KEY" } } }), "utf8");
		const service = makeService(new FakeBridge());
		const res = await service.save({
			providers: { minimax: { apiKey: "$MINIMAX_API_KEY" } },
			secrets: { MINIMAX_API_KEY: "sk-m2" },
		});
		expect(res.status).toBe(200);
		expect(readFileSync(envPath, "utf8")).toBe("MINIMAX_API_KEY=sk-m2\n");
	});
	it("非内置 id 的全量自定义（minimaxcn 式）→ 200 不受守卫影响", async () => {
		const service = makeService(new FakeBridge());
		const res = await service.save({
			providers: { minimaxcn: { baseUrl: "https://api.minimax.cn/v1", api: "openai-completions", apiKey: "sk-x", models: [{ id: "Minimax-M3" }] } },
		});
		expect(res.status).toBe(200);
	});
});

describe("ModelsConfigService.loadStatus", () => {
	it("汇总文件 + bridge 运行时状态（含持久默认与编排默认）", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { deepseek: { apiKey: "$PG_TEST_A" } } }), "utf8");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "deepseek", defaultModel: "deepseek-chat", theme: "dark" }), "utf8");
		const bridge = new FakeBridge({
			get_state: { type: "response", command: "get_state", success: true, data: { model: { provider: "deepseek", id: "deepseek-chat", name: "Chat" } } },
			get_available_models: { type: "response", command: "get_available_models", success: true, data: { models: [{ provider: "deepseek", id: "deepseek-chat" }, { provider: "anthropic", id: "claude-x" }] } },
		});
		const service = makeService(bridge, { getOrchDefaults: () => ({ nodeDefault: "n/m", plannerModel: "p/m" }) });
		const status = await service.loadStatus();
		expect(status.activeModel).toEqual({ provider: "deepseek", id: "deepseek-chat", name: "Chat" });
		expect(status.runtimeModels).toHaveLength(2);
		expect(status.persistedDefault).toEqual({ provider: "deepseek", modelId: "deepseek-chat" });
		expect(status.orchDefaults).toEqual({ nodeDefault: "n/m", plannerModel: "p/m" });
		expect(status.providers.deepseek.apiKeyEnvSet).toBe(false);
		expect(JSON.stringify(status)).not.toMatch(/sk-/); // 永不回传密钥明文
	});
	it("bridge 挂起 → rpc 超时不拖死 HTTP（返回 null 字段）", async () => {
		const slow = new FakeBridge();
		slow.request = () => new Promise(() => {}); // 永不 resolve —— race 计时器兜底
		const service = makeService(slow);
		const status = await service.loadStatus();
		expect(status.activeModel).toBeNull();
		expect(status.runtimeModels).toEqual([]);
	}, 20000);
	it("models.json 带 BOM / // 注释 / 尾逗号（pi 加载器容忍的形式）→ 同样解析", async () => {
		writeFileSync(
			join(dir, "models.json"),
			"﻿{" + '\n  // deepseek 配置\n  "providers": {\n    "p": { "baseUrl": "https://x.example/v1", "apiKey": "$PG_TEST_C", "models": [{"id":"m"},], },\n  },\n}',
			"utf8",
		);
		const status = await makeService(new FakeBridge()).loadStatus();
		expect(status.configError).toBeUndefined();
		expect(status.providers.p?.baseUrl).toBe("https://x.example/v1");
	});
	it("字符串值里的 // 与 https:// 不会被当注释剔除（与 pi 的字符串感知剔除对齐）", async () => {
		writeFileSync(
			join(dir, "models.json"),
			'{ "providers": { "p": { "baseUrl": "https://x.example/v1", "note": "see // not-a-comment", "apiKey": "$PG_TEST_U" } } }',
			"utf8",
		);
		const status = await makeService(new FakeBridge()).loadStatus();
		expect(status.providers.p?.baseUrl).toBe("https://x.example/v1");
		expect(status.providers.p?.advancedFields).toContain("note");
	});
	it("GET 脱敏：不识别的 $ 形式（$0BAD）也不出网——raw.apiKey 换成 \"\"", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { p: { baseUrl: "https://x", apiKey: "$0BAD" } } }), "utf8");
		const status = await makeService(new FakeBridge()).loadStatus();
		expect(status.providers.p?.raw.apiKey).toBe("");
		expect(JSON.stringify(status)).not.toContain("$0BAD");
	});
	it("GET 脱敏：纯 $VAR 与 !command 原样出网（页面要原样带回）", async () => {
		writeFileSync(
			join(dir, "models.json"),
			JSON.stringify({ providers: { a: { apiKey: "$PG_TEST_KEEP" }, c: { apiKey: "!op read key" } } }),
			"utf8",
		);
		const status = await makeService(new FakeBridge()).loadStatus();
		expect(status.providers.a?.raw.apiKey).toBe("$PG_TEST_KEEP");
		expect(status.providers.c?.raw.apiKey).toBe("!op read key");
	});
	it("builtinProviders 标记：envSet / configuredInFile / authedAtRuntime 三方状态", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { minimax: { apiKey: "$MINIMAX_API_KEY" } } }), "utf8");
		delete process.env.MINIMAX_API_KEY;
		const bridge = new FakeBridge({
			get_available_models: {
				type: "response",
				command: "get_available_models",
				success: true,
				data: { models: [{ provider: "minimax", id: "MiniMax-M3" }] },
			},
		});
		const status = await makeService(bridge).loadStatus();
		expect(status.builtinCatalogInfo).toEqual({ piVersion: "0.84.2-test", generatedAt: "2026-09-09T00:00:00.000Z" });
		const minimax = status.builtinProviders.find((p) => p.id === "minimax")!;
		expect(minimax).toMatchObject({ configuredInFile: true, authedAtRuntime: true, envSet: false, authKind: "env-key" });
		const copilot = status.builtinProviders.find((p) => p.id === "github-copilot")!;
		expect(copilot).toMatchObject({ authKind: "oauth", configuredInFile: false, authedAtRuntime: false });
		// env 一设置 → envSet 翻转（目录快照不变，标记是本机状态）
		process.env.MINIMAX_API_KEY = "sk-m";
		const status2 = await makeService(new FakeBridge()).loadStatus();
		expect(status2.builtinProviders.find((p) => p.id === "minimax")!.envSet).toBe(true);
	});
	it("挂载条目（仅 apiKey）不触发 builtinConflict；deepseek 式覆盖条目 → 警告但可正常保存", async () => {
		writeFileSync(
			join(dir, "models.json"),
			JSON.stringify({
				providers: {
					minimax: { apiKey: "$MINIMAX_API_KEY" },
					deepseek: { baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", apiKey: "$DEEPSEEK_API_KEY", models: [{ id: "deepseek-chat" }] },
				},
			}),
			"utf8",
		);
		const service = makeService(new FakeBridge());
		const status = await service.loadStatus();
		expect(status.providers.minimax.builtinConflict).toBeUndefined();
		const conflict = status.providers.deepseek.builtinConflict!;
		expect(conflict).toContain("DeepSeek");
		expect(conflict).toContain("baseUrl");
		// 非阻断：既有覆盖条目照常保存（用户的真实 deepseek 配置不可破）
		const res = await service.save({
			providers: {
				minimax: { apiKey: "$MINIMAX_API_KEY" },
				deepseek: { baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", apiKey: "$DEEPSEEK_API_KEY", models: [{ id: "deepseek-chat" }] },
			},
		});
		expect(res.status).toBe(200);
	});
});

// ============================================================================
// Service：apply 与计划内重启
// ============================================================================

describe("ModelsConfigService.apply", () => {
	it("apply：编排默认热替换 + settings.json 合并写 + set_model", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { deepseek: { models: [{ id: "deepseek-chat" }] } } }), "utf8");
		const bridge = new FakeBridge();
		const setOrch = vi.fn();
		const service = makeService(bridge, { setOrchDefaults: setOrch });
		const res = await service.apply({ activeModel: "deepseek/deepseek-chat" });
		expect(res.status).toBe(200);
		if ("error" in res.body) throw new Error(res.body.error);
		expect(res.body.orchUpdated).toBe(true);
		expect(res.body.chatSwitched).toBe(true);
		expect(setOrch).toHaveBeenCalledWith("deepseek/deepseek-chat");
		expect(bridge.requests.some((c) => c.type === "set_model")).toBe(true);
		const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
		expect(settings).toMatchObject({ defaultProvider: "deepseek", defaultModel: "deepseek-chat" });
	});
	it("settings.json 已有其他键 → 合并保留", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { d: { models: [{ id: "m" }] } } }), "utf8");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "dark", autoUpdate: true }), "utf8");
		const service = makeService(new FakeBridge());
		await service.apply({ activeModel: "d/m" });
		expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({
			theme: "dark",
			autoUpdate: true,
			defaultProvider: "d",
			defaultModel: "m",
		});
	});
	it("agent / 编排运行中 → 409", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { d: { models: [{ id: "m" }] } } }), "utf8");
		const service = makeService(new FakeBridge(), { isAgentBusy: () => true });
		expect((await service.apply({ activeModel: "d/m" })).status).toBe(409);
		const service2 = makeService(new FakeBridge(), { isRunBusy: () => true });
		expect((await service2.apply({ restartBridge: true })).status).toBe(409);
	});
	it("activeModel 不在 models.json → 400", async () => {
		const service = makeService(new FakeBridge());
		const res = await service.apply({ activeModel: "nope/model" });
		expect(res.status).toBe(400);
	});
	it("activeModel 不在 models.json 但在运行时快照（内置/OAuth provider）→ 200 + set_model", async () => {
		const bridge = new FakeBridge({
			get_available_models: {
				type: "response",
				command: "get_available_models",
				success: true,
				data: { models: [{ provider: "anthropic", id: "claude-x" }] },
			},
		});
		const service = makeService(bridge);
		const res = await service.apply({ activeModel: "anthropic/claude-x" });
		expect(res.status).toBe(200);
		if ("error" in res.body) throw new Error(res.body.error);
		expect(res.body.chatSwitched).toBe(true);
		expect(bridge.requests.some((c) => c.type === "set_model")).toBe(true);
	});
	it("挂载条目不在旧运行时快照 + 勾重启 → 目录通道放行：重启 + set_model（回归：旧代码先校验后重启，必 400）", async () => {
		// 模拟「刚保存挂载条目」：models.json 只有 apiKey 挂载，运行 bridge
		// 的已认证快照里没有它（重启前当然没有）
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { minimax: { apiKey: "$MINIMAX_API_KEY" } } }), "utf8");
		const bridge = new FakeBridge({
			get_available_models: { type: "response", command: "get_available_models", success: true, data: { models: [] } },
		});
		const service = makeService(bridge);
		const res = await service.apply({ activeModel: "minimax/MiniMax-M3", restartBridge: true });
		expect(res.status).toBe(200);
		if ("error" in res.body) throw new Error(res.body.error);
		expect(res.body.restarted).toBe(true);
		expect(res.body.chatSwitched).toBe(true); // set_model 打到重启后的 bridge
		expect(bridge.requests.some((c) => c.type === "set_model" && (c as { provider?: string }).provider === "minimax")).toBe(true);
	});
	it("挂载条目不在运行时快照 + 未勾重启 → 400 并提示勾选重启", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { minimax: { apiKey: "$MINIMAX_API_KEY" } } }), "utf8");
		const bridge = new FakeBridge({
			get_available_models: { type: "response", command: "get_available_models", success: true, data: { models: [] } },
		});
		const service = makeService(bridge);
		const res = await service.apply({ activeModel: "minimax/MiniMax-M3" });
		expect(res.status).toBe(400);
		if ("error" in res.body) expect(res.body.error).toContain("重启");
	});
	it("勾了重启但模型 id 大小写与目录不符（minimax-m3 ≠ MiniMax-M3）→ 400（目录匹配大小写敏感）", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { minimax: { apiKey: "$MINIMAX_API_KEY" } } }), "utf8");
		const service = makeService(new FakeBridge());
		const res = await service.apply({ activeModel: "minimax/minimax-m3", restartBridge: true });
		expect(res.status).toBe(400);
	});
	it("restartBridge：kill→exit→start→switch_session（恢复上下文）→refresh→hello", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { d: { models: [{ id: "m" }] } } }), "utf8");
		const piFile = join(dir, "fake-session.jsonl");
		writeFileSync(piFile, "{}", "utf8");
		const bridge = new FakeBridge();
		const refresh = vi.fn(async () => {});
		const hello = vi.fn();
		const service = makeService(bridge, { currentPiFile: () => piFile, refreshPiSession: refresh, broadcastHello: hello });
		const res = await service.apply({ restartBridge: true });
		expect(res.status).toBe(200);
		if ("error" in res.body) throw new Error(res.body.error);
		expect(res.body.restarted).toBe(true);
		expect(res.body.contextResumed).toBe(true);
		expect(bridge.killed).toBe(true);
		expect(bridge.started).toBe(1);
		expect(bridge.requests.some((c) => c.type === "switch_session")).toBe(true);
		expect(refresh).toHaveBeenCalled();
		expect(hello).toHaveBeenCalled();
	});
	it("重启后 pi 未就绪（get_state 无响应）→ 如实报错", async () => {
		const bridge = new FakeBridge();
		bridge.request = () => new Promise(() => {}); // 挂起
		const service = makeService(bridge);
		const res = await service.apply({ restartBridge: true });
		expect(res.status).toBe(200);
		if ("error" in res.body) throw new Error("unreachable");
		expect(res.body.restarted).toBe(true);
		expect(res.body.restartError).toBeTruthy();
	}, 25000);
	it("无 activeModel 的纯重启（bridge 已死）→ 直接 start 拉起", async () => {
		const bridge = new FakeBridge();
		bridge.running = false;
		const service = makeService(bridge);
		const res = await service.apply({ restartBridge: true });
		expect(res.status).toBe(200);
		if ("error" in res.body) throw new Error(res.body.error);
		expect(res.body.restarted).toBe(true);
		expect(bridge.started).toBe(1);
		expect(bridge.killed).toBe(false);
	});
});

// ============================================================================
// settings.json 读写守卫
// ============================================================================

describe("writePersistedDefault / readPersistedDefault（经 service.apply 之外直接验证守卫）", () => {
	it("settings.json 损坏 → 拒写（不清掉用户数据）", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { d: { models: [{ id: "m" }] } } }), "utf8");
		writeFileSync(join(dir, "settings.json"), "{ broken", "utf8");
		const service = makeService(new FakeBridge());
		const res = await service.apply({ activeModel: "d/m" });
		expect(res.status).toBe(200);
		if ("error" in res.body) throw new Error("unreachable");
		expect(res.body.persisted).toBe(false);
		expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe("{ broken");
	});
	it("无 settings.json / 无默认 → read 返回 null", () => {
		const service = makeService(new FakeBridge());
		// loadStatus 不炸即可（内部调 readPersistedDefault）
		void service;
		expect(existsSync(join(dir, "settings.json"))).toBe(false);
	});
});

describe("ModelsConfigService.test", () => {
	it("按 provider 测：models.json 里的配置 + process.env 解引用", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { p: { baseUrl: "https://x.example", api: "openai-completions", apiKey: "$PG_TEST_T" } } }), "utf8");
		process.env.PG_TEST_T = "sk-t";
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const service = makeService(new FakeBridge());
		const res = await service.test({ provider: "p" });
		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(true);
		const [, init] = fetchMock.mock.calls[0]!;
		expect((init as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer sk-t");
	});
	it("环境变量未设置 → 400 明确提示", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { p: { baseUrl: "https://x", apiKey: "$PG_TEST_MISSING" } } }), "utf8");
		delete process.env.PG_TEST_MISSING;
		const service = makeService(new FakeBridge());
		const res = await service.test({ provider: "p" });
		expect(res.status).toBe(400);
		expect(res.body.message).toContain("$VAR");
	});
	it("草稿直测：字面量密钥只进内存请求，不落任何文件", async () => {
		const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const service = makeService(new FakeBridge());
		const res = await service.test({ baseUrl: "https://x.example", apiKey: "sk-draft" });
		expect(res.status).toBe(200);
		expect(existsSync(envPath)).toBe(false);
		expect(existsSync(join(dir, "models.json"))).toBe(false);
	});
	it("草稿直测：baseUrl 非 http(s) → 400；apiKeyRef 未被 models.json 引用 → 400（防环境变量读取器）", async () => {
		const service = makeService(new FakeBridge());
		const ftp = await service.test({ baseUrl: "ftp://x.example", apiKey: "k" });
		expect(ftp.status).toBe(400);
		expect(ftp.body.message).toContain("http(s)");
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { p: { apiKey: "$PG_TEST_R" } } }), "utf8");
		const ref = await service.test({ baseUrl: "https://x.example", apiKeyRef: "$PG_TEST_UNREF" });
		expect(ref.status).toBe(400);
		expect(ref.body.message).toContain("不在 models.json");
	});
	it("草稿直测：apiKeyRef 被 models.json 引用且 env 已设置 → 用 env 值探测", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { p: { apiKey: "$PG_TEST_R" } } }), "utf8");
		process.env.PG_TEST_R = "sk-ref";
		const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const service = makeService(new FakeBridge());
		const res = await service.test({ baseUrl: "https://x.example", apiKeyRef: "$PG_TEST_R" });
		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(true);
		const [, init] = fetchMock.mock.calls[0]!;
		expect((init as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer sk-ref");
	});
	it("按 provider 测：!command 密钥 → 400（页面不支持测试）", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { c: { baseUrl: "https://x", apiKey: "!op read key" } } }), "utf8");
		const res = await makeService(new FakeBridge()).test({ provider: "c" });
		expect(res.status).toBe(400);
		expect(res.body.message).toContain("!command");
	});
	it("挂载条目测试：文件无 baseUrl/api → 回退内置目录（anthropic 形态探测）", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { minimax: { apiKey: "$MINIMAX_API_KEY" } } }), "utf8");
		process.env.MINIMAX_API_KEY = "sk-m";
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "MiniMax-M3" }] }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const res = await makeService(new FakeBridge()).test({ provider: "minimax" });
		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(true);
		expect(res.body.probedUrl).toBe("https://api.minimax.io/anthropic/v1/models");
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://api.minimax.io/anthropic/v1/models");
		expect((init as { headers: Record<string, string> }).headers["x-api-key"]).toBe("sk-m");
	});
	it("挂载条目测试：文件自带 baseUrl/api → 文件值优先于目录", async () => {
		writeFileSync(
			join(dir, "models.json"),
			JSON.stringify({ providers: { minimax: { apiKey: "$MINIMAX_API_KEY", baseUrl: "https://custom.example", api: "openai-completions" } } }),
			"utf8",
		);
		process.env.MINIMAX_API_KEY = "sk-m";
		const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const res = await makeService(new FakeBridge()).test({ provider: "minimax" });
		expect(res.status).toBe(200);
		expect(res.body.probedUrl).toBe("https://custom.example/models");
	});
	it("挂载条目测试：$VAR 未设置 → 400（目录回退救不了缺失的密钥）", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { minimax: { apiKey: "$MINIMAX_API_KEY" } } }), "utf8");
		delete process.env.MINIMAX_API_KEY;
		const res = await makeService(new FakeBridge()).test({ provider: "minimax" });
		expect(res.status).toBe(400);
		expect(res.body.message).toContain("$VAR");
	});
	it("无 baseUrl 的内置（目录也没有）→ 400 带说明（google 按模型提供 URL，无法探测）", async () => {
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { google: { apiKey: "$GEMINI_API_KEY" } } }), "utf8");
		process.env.GEMINI_API_KEY = "sk-g";
		const res = await makeService(new FakeBridge()).test({ provider: "google" });
		expect(res.status).toBe(400);
		expect(res.body.message).toContain("Base URL");
	});
});
