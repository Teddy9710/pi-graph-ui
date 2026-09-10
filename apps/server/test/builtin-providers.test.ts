/**
 * builtin-providers.json（随仓库提交的 pi 内置 provider 目录快照）与加载器
 * 的契约测试。快照由 scripts/generate-builtin-providers.mjs 从已安装 pi-ai
 * dist 生成——这里断言「提交的这份文件」结构完好、关键条目在位（防手改/
 * 合并事故），以及加载/查询纯函数的行为（坏输入降级、大小写敏感匹配）。
 * Service 层用 fixture 目录的交互测试在 models-config.test.ts。
 */

import { describe, expect, it } from "vitest";
import {
	builtinModelExists,
	loadBuiltinCatalog,
	parseBuiltinCatalog,
	toBuiltinProviderInfos,
} from "../src/builtin-providers.ts";

describe("提交的 builtin-providers.json（经 loadBuiltinCatalog 加载）", () => {
	const catalog = loadBuiltinCatalog();

	it("结构完好：≥39 个 provider、版本元信息在位、id 唯一、模型 id 非空", () => {
		expect(catalog.piVersion).not.toBe("unknown");
		expect(catalog.piVersion).toMatch(/^\d+\.\d+\.\d+/);
		expect(catalog.generatedAt).toBeTruthy();
		expect(catalog.providers.length).toBeGreaterThanOrEqual(39);
		const ids = catalog.providers.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const p of catalog.providers) {
			expect(Array.isArray(p.apis)).toBe(true);
			for (const m of p.models) expect(m.id).toBeTruthy();
		}
	});
	it("minimax（国际）/ minimax-cn（国内）双条目——撞名事故的两个当事人", () => {
		const mm = catalog.providers.find((p) => p.id === "minimax")!;
		expect(mm.name).toBe("MiniMax");
		expect(mm.baseUrl).toBe("https://api.minimax.io/anthropic");
		expect(mm.apis).toEqual(["anthropic-messages"]);
		expect(mm.apiKeyEnv).toBe("MINIMAX_API_KEY");
		expect(mm.authKind).toBe("env-key");
		expect(mm.models.map((m) => m.id)).toContain("MiniMax-M3");
		const cn = catalog.providers.find((p) => p.id === "minimax-cn")!;
		expect(cn.baseUrl).toBe("https://api.minimaxi.com/anthropic");
		expect(cn.apiKeyEnv).toBe("MINIMAX_CN_API_KEY");
		expect(cn.authKind).toBe("env-key");
	});
	it("认证分类：anthropic=oauth、amazon-bedrock=custom、env-key 必带合法 apiKeyEnv", () => {
		expect(catalog.providers.find((p) => p.id === "anthropic")!.authKind).toBe("oauth");
		expect(catalog.providers.find((p) => p.id === "amazon-bedrock")!.authKind).toBe("custom");
		for (const p of catalog.providers) {
			if (p.authKind === "env-key") expect(p.apiKeyEnv).toMatch(/^[A-Z_][A-Z0-9_]*$/);
		}
	});
	it("google 的 env 名是 GEMINI_API_KEY（不是 GOOGLE_API_KEY——折叠规则 bug 的当事条目）", () => {
		expect(catalog.providers.find((p) => p.id === "google")!.apiKeyEnv).toBe("GEMINI_API_KEY");
	});
});

describe("builtinModelExists（大小写敏感，与 pi 的精确 id 匹配一致）", () => {
	const catalog = loadBuiltinCatalog();

	it("命中：minimax/MiniMax-M3", () => {
		expect(builtinModelExists(catalog, "minimax", "MiniMax-M3")).toBe(true);
	});
	it("模型 id 大小写不同 = 不同模型（影子条目陷阱的根源）", () => {
		expect(builtinModelExists(catalog, "minimax", "minimax-m3")).toBe(false);
		expect(builtinModelExists(catalog, "minimax", "Minimax-M3")).toBe(false);
	});
	it("provider id 同样大小写敏感；未知 provider → false", () => {
		expect(builtinModelExists(catalog, "MINIMAX", "MiniMax-M3")).toBe(false);
		expect(builtinModelExists(catalog, "nope", "whatever")).toBe(false);
	});
});

describe("parseBuiltinCatalog（坏输入 → null，绝不抛）", () => {
	it("非 JSON / 非对象 / 缺字段 / providers 非数组 / 条目错型 → null", () => {
		expect(parseBuiltinCatalog("{ broken")).toBeNull();
		expect(parseBuiltinCatalog("[]")).toBeNull();
		expect(parseBuiltinCatalog("{}")).toBeNull(); // 缺 piVersion/generatedAt/providers
		expect(parseBuiltinCatalog(JSON.stringify({ piVersion: "1", generatedAt: "x", providers: "not-array" }))).toBeNull();
		expect(
			parseBuiltinCatalog(
				JSON.stringify({
					piVersion: "1",
					generatedAt: "x",
					providers: [{ id: "p" }], // 缺 name/apis/authKind/models
				}),
			),
		).toBeNull();
		expect(
			parseBuiltinCatalog(
				JSON.stringify({
					piVersion: "1",
					generatedAt: "x",
					providers: [{ id: "p", name: "P", apis: [], authKind: "nope", models: [] }], // authKind 非法
				}),
			),
		).toBeNull();
	});
	it("合法最小输入 → 解析", () => {
		const text = JSON.stringify({
			piVersion: "9.9.9",
			generatedAt: "2026-01-01T00:00:00.000Z",
			providers: [
				{ id: "p", name: "P", apis: ["openai-completions"], authKind: "env-key", apiKeyEnv: "P_API_KEY", models: [{ id: "m" }] },
			],
		});
		expect(parseBuiltinCatalog(text)).toMatchObject({ piVersion: "9.9.9", providers: [{ id: "p" }] });
	});
});

describe("toBuiltinProviderInfos（目录快照 + 本机状态标记）", () => {
	const mini = parseBuiltinCatalog(
		JSON.stringify({
			piVersion: "t",
			generatedAt: "t",
			providers: [
				{ id: "p1", name: "P1", apis: [], authKind: "env-key", apiKeyEnv: "PG_TEST_BUILTIN_ENV", models: [] },
				{ id: "p2", name: "P2", apis: [], authKind: "oauth", models: [] },
			],
		}),
	)!;

	it("envSet 跟随 process.env；configuredInFile/authedAtRuntime 跟随传入集合", () => {
		delete process.env.PG_TEST_BUILTIN_ENV;
		const none = toBuiltinProviderInfos(mini, new Set(), new Set());
		expect(none.find((p) => p.id === "p1")).toMatchObject({ envSet: false, configuredInFile: false, authedAtRuntime: false });
		process.env.PG_TEST_BUILTIN_ENV = "x";
		const marked = toBuiltinProviderInfos(mini, new Set(["p1"]), new Set(["p2"]));
		expect(marked.find((p) => p.id === "p1")).toMatchObject({ envSet: true, configuredInFile: true, authedAtRuntime: false });
		expect(marked.find((p) => p.id === "p2")).toMatchObject({ envSet: false, authedAtRuntime: true });
		delete process.env.PG_TEST_BUILTIN_ENV;
	});
});
