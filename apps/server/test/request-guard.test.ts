/**
 * request-guard tests — #4 的本机信任边界：Host 校验拦 DNS rebinding
 * （公网域名 Host 一律拒绝），Origin 校验拦跨站 WS/fetch（缺 Origin 的
 * 非浏览器客户端放行——e2e 脚本依赖这一条），env 扩展名单生效。
 * guardMiddleware 用真实 Hono app 驱动——安全关键的是接线，不只是谓词。
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { guardMiddleware, isAllowedHost, isAllowedOrigin, parseExtraList } from "../src/request-guard.ts";

describe("parseExtraList", () => {
	it("env 逗号清单 → 小写集合（空白条目丢弃）", () => {
		expect([...parseExtraList("Evil.Com, localhost ,,")].sort()).toEqual(["evil.com", "localhost"]);
		expect(parseExtraList(undefined).size).toBe(0);
	});
});

describe("isAllowedHost", () => {
	it.each([
		["localhost", true],
		["localhost:8787", true],
		["127.0.0.1", true],
		["127.0.0.5:8787", true], // 整个 127/8 都是本机
		["[::1]:8787", true],
		["::1", true],
		["10.0.0.2:80", true],
		["172.16.0.1", true],
		["172.31.255.255", true],
		["192.168.1.5:8787", true], // 局域网访问（手机/另一台机器）
		["169.254.7.7", true],
		["[fe80::1]", true],
		["[fd00::1]", true],
		["myhost.local", true], // mDNS 不可被公网 DNS 重绑定
	])("本机/私网 Host「%s」放行", (host, expected) => {
		expect(isAllowedHost(host, new Set())).toBe(expected);
	});

	it.each([
		["evil.com"], // DNS rebinding：攻击者域名出现在 Host
		["evil.com:8787"],
		["localhost.evil.com"], // 前缀伪装
		["evil.local.com"], // 后缀伪装（.local 必须是结尾）
		["172.32.0.1"], // 172.16/12 之外
		["8.8.8.8"],
		[""], // 空 Host
		[undefined],
	])("公网/畸形 Host「%s」拒绝", (host) => {
		expect(isAllowedHost(host, new Set())).toBe(false);
	});

	it("ALLOWED_HOSTS 扩展名单放行（带/不带端口都认）", () => {
		const extra = parseExtraList("bridge.internal.example");
		expect(isAllowedHost("bridge.internal.example:8787", extra)).toBe(true);
		expect(isAllowedHost("bridge.internal.example", extra)).toBe(true);
	});
});

describe("isAllowedOrigin", () => {
	it.each([
		[undefined], // 非浏览器客户端（e2e 脚本/curl）不发 Origin
		["http://localhost:5173"], // vite dev
		["http://localhost:3000"], // 任意端口
		["https://127.0.0.1:5173"],
		["http://[::1]:5173"],
		["http://192.168.1.5:5173"], // 局域网里另一台机器的前端
	])("Origin「%s」放行", (origin) => {
		expect(isAllowedOrigin(origin, new Set())).toBe(true);
	});

	it.each([
		["https://evil.com"], // 跨站 WS：浏览器必带 Origin
		["https://evil.com:443"],
		["null"], // 沙箱 iframe / 隐私模式的字面量
		["file:///C:/x.html"],
		["chrome-extension://abcdef"],
		[""], // 空串不是合法 URL
	])("Origin「%s」拒绝", (origin) => {
		expect(isAllowedOrigin(origin, new Set())).toBe(false);
	});

	it("TRUSTED_ORIGINS 扩展名单放行", () => {
		expect(isAllowedOrigin("https://ui.example", parseExtraList("https://ui.example"))).toBe(true);
		expect(isAllowedOrigin("https://other.example", parseExtraList("https://ui.example"))).toBe(false);
	});
});

describe("guardMiddleware（HTTP 接线）", () => {
	function makeApp(env?: { allowedHosts?: string; trustedOrigins?: string }) {
		const app = new Hono();
		let handlerRan = false;
		app.use("*", guardMiddleware({ allowedHosts: parseExtraList(env?.allowedHosts), trustedOrigins: parseExtraList(env?.trustedOrigins) }));
		app.post("/api/probe", (c) => {
			handlerRan = true;
			return c.json({ ok: true });
		});
		return { app, ran: () => handlerRan };
	}

	it("跨站简单请求（POST text/plain + 公网 Origin）403 且处理器不执行 —— 密钥外泄链就此截断", async () => {
		const { app, ran } = makeApp();
		const res = await app.request("/api/probe", {
			method: "POST",
			headers: { host: "127.0.0.1:8787", origin: "https://evil.com", "content-type": "text/plain" },
			body: '{"baseUrl":"https://attacker.example","apiKeyRef":"$DEEPSEEK_API_KEY"}',
		});
		expect(res.status).toBe(403);
		expect(ran()).toBe(false);
	});

	it("无 Origin（curl / e2e 脚本）放行，处理器执行", async () => {
		const { app, ran } = makeApp();
		const res = await app.request("/api/probe", {
			method: "POST",
			headers: { host: "127.0.0.1:8787", "content-type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBe(200);
		expect(ran()).toBe(true);
	});

	it.each([
		["http://localhost:5173", "127.0.0.1:8787"], // vite dev 跨端口
		["http://localhost:8787", "localhost:8787"], // 同源 POST 也带 Origin
		["http://192.168.1.5:5173", "192.168.1.5:8787"], // 局域网
	])("本机 Origin「%s」放行", async (origin, host) => {
		const { app, ran } = makeApp();
		const res = await app.request("/api/probe", { method: "POST", headers: { host, origin }, body: "" });
		expect(res.status).toBe(200);
		expect(ran()).toBe(true);
	});

	it("跨站预检 OPTIONS 同样 403（不再只靠省略 ACAO）", async () => {
		const { app, ran } = makeApp();
		const res = await app.request("/api/probe", {
			method: "OPTIONS",
			headers: { host: "127.0.0.1:8787", origin: "https://evil.com", "access-control-request-method": "POST" },
		});
		expect(res.status).toBe(403);
		expect(ran()).toBe(false);
	});

	it("公网 Host（DNS rebinding 签名）403，即使 Origin 缺席", async () => {
		const { app, ran } = makeApp();
		const res = await app.request("/api/probe", { method: "POST", headers: { host: "evil.com" }, body: "" });
		expect(res.status).toBe(403);
		expect(ran()).toBe(false);
	});

	it("TRUSTED_ORIGINS 扩展：公网 Origin 白名单内放行", async () => {
		const { app, ran } = makeApp({ trustedOrigins: "https://ui.example" });
		const ok = await app.request("/api/probe", {
			method: "POST",
			headers: { host: "127.0.0.1:8787", origin: "https://ui.example" },
			body: "",
		});
		expect(ok.status).toBe(200);
		expect(ran()).toBe(true);
		const denied = await app.request("/api/probe", {
			method: "POST",
			headers: { host: "127.0.0.1:8787", origin: "https://other.example" },
			body: "",
		});
		expect(denied.status).toBe(403);
	});
});
