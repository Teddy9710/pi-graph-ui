#!/usr/bin/env node
/**
 * 生成 pi 内置 provider 目录快照 → apps/server/src/builtin-providers.json
 *
 * 模型配置页的「＋ 内置」入口、撞名守卫、连接测试回退都依赖这份快照：pi 本身
 * 没有任何机器可读的 provider 目录（RPC 只列已认证 provider、不含 env var 名，
 * --list-models 是纯文本表），唯一的完整数据源是已安装 pi-ai 的 dist——
 *   dist/providers/all.js            builtinProviders() 注册表（权威 40 个）
 *   dist/providers/<id>.js           provider 工厂（id/name/baseUrl/envApiKeyAuth/lazyOAuth）
 *   dist/providers/data/<id>.json    生成的模型目录（按 api 分组、含 contextWindow 等）
 *
 * 快照提交进仓库（展示/预填/守卫数据，非正确性关键），pi 升级后重跑一次即可：
 *   node scripts/generate-builtin-providers.mjs            # 自动定位（npm root -g）
 *   node scripts/generate-builtin-providers.mjs <pi-ai 路径>  # 指定包根或其 dist
 *
 * 校验全部 fail-loud：任何结构对不上（解析断链、缺 id/name、env-key 无变量名、
 * data 文件与注册表不互恰）都非零退出，绝不产出半截目录。
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(SCRIPT_DIR, "../apps/server/src/builtin-providers.json");

/** 注册表下限（防解析断链产出空/残缺目录；上限不设——pi 新增 provider 不应挡重生成）。 */
const MIN_PROVIDERS = 30;

/** 注册表里存在、但没有 data/*.json 的 provider（纯动态目录）。 */
const DATA_MISSING_ALLOWLIST = new Set(["radius"]);

/** 工厂文件里 id/name 用变量计算（createProvider 都进不去）→ 手工钉死。 */
const FILE_META_OVERRIDES = {
	"radius.js": { id: "radius", name: "Radius" },
};

/** authKind 兜底：regex 分类与已知事实冲突时以此为准（belt-and-braces）。 */
const AUTH_KIND_OVERRIDES = {
	"amazon-bedrock": "custom",
	"cloudflare-ai-gateway": "custom",
	"cloudflare-workers-ai": "custom",
	"google-vertex": "custom",
	anthropic: "oauth",
	"github-copilot": "oauth",
	"kimi-coding": "oauth",
	"openai-codex": "oauth",
	openrouter: "oauth",
	radius: "oauth",
	xai: "oauth",
};

/** 无 data 文件的 provider：从工厂里的 Api() 调用名推 apis。 */
const API_FACTORY_NAMES = {
	anthropicMessagesApi: "anthropic-messages",
	openAICompletionsApi: "openai-completions",
	openAIResponsesApi: "openai-responses",
	googleGenerativeAIApi: "google-generative-ai",
	googleVertexApi: "google-vertex",
	bedrockConverseStreamApi: "bedrock-converse-stream",
	azureOpenAIResponsesApi: "azure-openai-responses",
	openAICodexResponsesApi: "openai-codex-responses",
	mistralConversationsApi: "mistral-conversations",
	piMessagesApi: "pi-messages",
};

function fail(message) {
	console.error(`✗ ${message}`);
	process.exit(1);
}

/** 定位 pi-ai 的 dist/providers 目录（优先级：CLI 参数 > PI_BIN > npm root -g）。 */
function locateProvidersDir() {
	const candidates = [];
	const arg = process.argv[2];
	if (arg) {
		// 包根（含 dist/）或 dist 本身都接受
		candidates.push(join(resolve(arg), "dist", "providers"), join(resolve(arg), "providers"));
	}
	// PI_BIN 若指向某个 node_modules 树内的安装（如 .../node_modules/.bin/pi），向上找
	if (process.env.PI_BIN && process.env.PI_BIN.includes("node_modules")) {
		let dir = resolve(process.env.PI_BIN);
		while (dir !== dirname(dir)) {
			if (existsSync(join(dir, "@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/all.js"))) {
				candidates.push(join(dir, "@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers"));
				break;
			}
			dir = dirname(dir);
		}
	}
	try {
		const npmRoot = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		if (npmRoot) {
			candidates.push(
				join(npmRoot, "@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers"),
				join(npmRoot, "@earendil-works/pi-ai/dist/providers"),
			);
		}
	} catch {
		// npm 不在 PATH：仅靠前面的候选
	}
	for (const dir of candidates) {
		if (existsSync(join(dir, "all.js"))) return dir;
	}
	fail(
		"找不到已安装 pi-ai 的 dist/providers/all.js。用法：\n" +
			"  node scripts/generate-builtin-providers.mjs <路径>   # 指向 pi-ai 包根或其 dist\n" +
			"（默认按 PI_BIN / npm root -g 自动定位）",
	);
}

/** 解析 all.js：builtinProviders() 函数体里的工厂调用，按 import 语句映射到文件。 */
function parseRegistry(allJs) {
	const bodyMatch = allJs.match(/export function builtinProviders\(\)\s*\{([\s\S]*?)\n\}/);
	if (!bodyMatch) fail("dist/providers/all.js 里找不到 builtinProviders() 函数体（pi 结构变了？）");
	const calls = [...bodyMatch[1].matchAll(/(\w+Provider)\(\)/g)].map((m) => m[1]);
	if (calls.length < MIN_PROVIDERS) fail(`注册表只解析到 ${calls.length} 个 provider 工厂（< ${MIN_PROVIDERS}）——大概率解析断链`);
	const fileByFactory = new Map();
	for (const m of allJs.matchAll(/import\s*\{([^}]+)\}\s*from\s*"\.\/([^"]+\.js)"/g)) {
		for (const name of m[1].split(",")) {
			const clean = name.trim();
			if (clean) fileByFactory.set(clean, m[2]);
		}
	}
	const entries = calls.map((factory) => {
		const file = fileByFactory.get(factory);
		if (!file) fail(`注册表工厂 ${factory} 没有对应的 import（all.js 解析不完整）`);
		return { factory, file };
	});
	return entries;
}

/** 从工厂文件抽 provider 元数据（id/name/baseUrl 只认 createProvider 参数块内的字面量）。 */
function extractProviderMeta(src, file) {
	const override = FILE_META_OVERRIDES[file];
	const scopeStart = src.indexOf("createProvider(");
	const scope = scopeStart >= 0 ? src.slice(scopeStart) : src;
	const str = (re) => scope.match(re)?.[1];
	return {
		id: override?.id ?? str(/id:\s*"([^"]+)"/),
		name: override?.name ?? str(/name:\s*"([^"]+)"/),
		baseUrl: str(/baseUrl:\s*"([^"]+)"/),
		envNames: [...src.matchAll(/envApiKeyAuth\(\s*"[^"]*"\s*,\s*\[([^\]]*)\]/g)].flatMap((m) =>
			[...m[1].matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)].map((n) => n[1]),
		),
		hasOAuth: /lazyOAuth\(/.test(src),
	};
}

/** data/<id>.json → apis + 去重后的模型列表（跨 api 组，首个出现者胜）。 */
function extractModels(dataPath) {
	const data = JSON.parse(readFileSync(dataPath, "utf8"));
	const apis = [];
	const models = [];
	const seen = new Set();
	for (const [api, group] of Object.entries(data)) {
		if (!group || typeof group !== "object") continue;
		apis.push(api);
		for (const model of Object.values(group)) {
			if (!model?.id || seen.has(model.id)) continue;
			seen.add(model.id);
			models.push({
				id: model.id,
				...(model.name ? { name: model.name } : {}),
				...(model.reasoning === true ? { reasoning: true } : {}),
				...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
				...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
			});
		}
	}
	return { apis, models };
}

const providersDir = locateProvidersDir();
const allJs = readFileSync(join(providersDir, "all.js"), "utf8");
const registry = parseRegistry(allJs);

const providers = [];
for (const { factory, file } of registry) {
	const src = readFileSync(join(providersDir, file), "utf8");
	const meta = extractProviderMeta(src, file);
	if (!meta.id || !meta.name) fail(`${file}：抽不到 id/name（工厂结构与预期不符）`);
	const dataPath = join(providersDir, "data", `${meta.id}.json`);
	let apis = [];
	let models = [];
	if (existsSync(dataPath)) {
		({ apis, models } = extractModels(dataPath));
	} else if (!DATA_MISSING_ALLOWLIST.has(meta.id)) {
		fail(`${meta.id}：没有 data/${meta.id}.json 且不在动态目录 allowlist 里（数据/注册表不互恰）`);
	} else {
		// 纯动态 provider：apis 从工厂里的 XxxApi() 调用名推
		apis = Object.entries(API_FACTORY_NAMES)
			.filter(([call]) => new RegExp(`\\b${call}\\(`).test(src))
			.map(([, api]) => api);
	}
	let authKind = meta.hasOAuth ? "oauth" : meta.envNames.length > 0 ? "env-key" : "custom";
	authKind = AUTH_KIND_OVERRIDES[meta.id] ?? authKind;
	if (authKind === "env-key" && meta.envNames.length === 0) fail(`${meta.id}：env-key 却抽不到 apiKeyEnv`);
	providers.push({
		id: meta.id,
		name: meta.name,
		...(meta.baseUrl ? { baseUrl: meta.baseUrl } : {}),
		apis,
		...(meta.envNames.length > 0 ? { apiKeyEnv: meta.envNames[0] } : {}),
		authKind,
		models,
	});
}

// 互恰校验：data 目录里的每个文件都要对应注册表 provider（排除 .manifest.json 等点文件）
const dataFiles = readdirSync(join(providersDir, "data")).filter((f) => f.endsWith(".json") && !f.startsWith("."));
const registryIds = new Set(providers.map((p) => p.id));
for (const f of dataFiles) {
	const id = f.replace(/\.json$/, "");
	if (!registryIds.has(id)) fail(`data/${f} 不在 builtinProviders() 注册表里（多余数据文件）`);
}
if (dataFiles.length < MIN_PROVIDERS) fail(`data/*.json 只有 ${dataFiles.length} 个（< ${MIN_PROVIDERS}）`);

const ids = providers.map((p) => p.id);
if (new Set(ids).size !== ids.length) fail("provider id 有重复");

// pi 版本：pi-ai 的上两级 = pi-coding-agent 安装根
const piVersion = (() => {
	try {
		const pkg = JSON.parse(readFileSync(join(providersDir, "../../../../../package.json"), "utf8"));
		if (typeof pkg.version === "string") return pkg.version;
	} catch {
		// 位置推不准就标 unknown（不阻断生成——目录数据本身与版本无关）
	}
	return "unknown";
})();

const catalog = { piVersion, generatedAt: new Date().toISOString(), providers: providers.sort((a, b) => a.id.localeCompare(b.id)) };
const text = `${JSON.stringify(catalog, null, "\t")}\n`;
JSON.parse(text); // round-trip：写坏不如不写

writeFileSync(OUTPUT_PATH, text);
const totalModels = catalog.providers.reduce((n, p) => n + p.models.length, 0);
console.log(`✓ 内置 provider 目录已生成 → ${OUTPUT_PATH}`);
console.log(`  ${catalog.providers.length} 个 provider · ${totalModels} 个模型 · ${totalModels ? Math.round(text.length / 1024) : 0} KB · pi ${piVersion}`);
console.log(`  env-key ${catalog.providers.filter((p) => p.authKind === "env-key").length} · oauth ${catalog.providers.filter((p) => p.authKind === "oauth").length} · custom ${catalog.providers.filter((p) => p.authKind === "custom").length}`);
