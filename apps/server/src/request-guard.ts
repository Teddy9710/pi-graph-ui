/**
 * Local-trust request guards for the HTTP + WS surfaces (#4).
 *
 * The bridge is the highest-privilege process on this box short of a shell:
 * it drives pi RPC subprocesses with the user's model keys and files. Two
 * browser-borne attacks reach a localhost server that has no auth:
 *
 * - **DNS rebinding**: an attacker page at https://evil.com rebinds its DNS
 *   to 127.0.0.1; the request then carries `Host: evil.com` — so the Host
 *   check rejects any public hostname and only passes loopback/private IPs
 *   (or `*.local` mDNS names, which cannot be rebound from public DNS).
 * - **Cross-site WebSocket / fetch**: browsers always attach `Origin` to WS
 *   handshakes and cross-origin HTTP — anything present must be a loopback
 *   dev origin (vite serves the app on :5173 or any other free port).
 *   ABSENT Origin passes: non-browser clients (e2e scripts, curl, Node ws)
 *   don't send one, and an Origin header cannot be forged from a browser.
 *   Enforced BOTH at the WS handshake and by guardMiddleware on every HTTP
 *   request — a CORS allowlist alone would only suppress the readable ACAO
 *   header while CORS-safelisted "simple" requests (POST text/plain, no
 *   preflight) still execute server-side.
 *
 * Both sets extend via env for non-default setups (reverse proxy, remote dev
 * box): `ALLOWED_HOSTS` / `TRUSTED_ORIGINS`, comma-separated.
 */

import type { MiddlewareHandler } from "hono";

/** Normalize an env comma-list into a lowercase lookup set. */
export function parseExtraList(raw: string | undefined): Set<string> {
	return new Set(
		(raw ?? "")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
}

/**
 * Strip the port from a Host header value, keeping IPv6 brackets intact
 * (`localhost:8787` → `localhost`, `[::1]:8787` → `[::1]`, `192.168.1.5` → …).
 */
function stripPort(host: string): string {
	if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1) || host;
	// Exactly one colon followed by digits = the ":port" suffix (dotted
	// names / IPv4). Anything else with a colon is a BARE IPv6 literal
	// ("::1", "fe80::1") — no port to strip.
	if (/^[^:]+:\d+$/.test(host)) return host.replace(/:\d+$/, "");
	return host;
}

/**
 * Is this Host (bare, port-stripped) a local-trust host? Loopback, RFC1918
 * private ranges, link-local, `localhost` and `*.local` pass; public
 * hostnames — the DNS-rebinding signature — fail.
 */
export function isAllowedHost(hostHeader: string | undefined, extra: Set<string>): boolean {
	if (!hostHeader) return false;
	const bare = stripPort(hostHeader.trim().toLowerCase());
	if (bare === "") return false;
	if (extra.has(bare) || extra.has(hostHeader.trim().toLowerCase())) return true;
	if (bare === "localhost" || bare === "::1" || bare === "[::1]") return true;
	if (bare.endsWith(".local")) return true;
	// Dotted-decimal IPv4 (a bare number like `2130706433` is not produced by
	// browsers/Node for loopback and needs no explicit pass here).
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) {
		// The regex guarantees 4 groups; ?? -1 only satisfies the type checker
		// and can never match an allow range.
		const [a = -1, b = -1] = bare.split(".").map(Number);
		return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
	}
	// Bracketed IPv6: loopback/link-local/unique-local prefixes.
	if (/^\[(::1|fe80|fc|fd)[0-9a-f:]*\]$/i.test(bare)) return true;
	return false;
}

/**
 * Is this Origin allowed to talk to the WS / cross-origin HTTP API?
 * Undefined (non-browser client) passes; anything parseable must sit on an
 * allowed host (any port — dev servers pick free ones). Extra entries are
 * matched BOTH as full origin strings ("https://ui.example") and — when the
 * entry is a bare host — as the host part, so either spelling works. The
 * literal string "null" (sandboxed iframe / privacy-stripped fetch) is a
 * browser and fails.
 */
export function isAllowedOrigin(origin: string | undefined, extra: Set<string>): boolean {
	if (origin === undefined) return true;
	if (extra.has(origin.trim().toLowerCase())) return true;
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false; // "null", garbage, non-absolute values
	}
	return isAllowedHost(url.host, extra);
}

/**
 * Shared HTTP admission middleware: Host guard (DNS rebinding) + Origin
 * guard (cross-site) + baseline hardening headers. Extracted from main.ts
 * so the WIRING is unit-testable, not just the predicates.
 *
 * The Origin check mirrors the WS handshake guard because a CORS allowlist
 * cannot stop a determined page: hono's cors() merely omits
 * Access-Control-Allow-Origin for disallowed origins (the response becomes
 * unreadable) while still executing the handler. CORS-safelisted "simple"
 * requests — POST with Content-Type: text/plain, no preflight — therefore
 * reach /api/models/test|apply as drive-by writes: an attacker-steerable
 * outbound probe carrying the user's resolved API key (blind exfiltration),
 * plus blind model switches and bridge restarts. Failing closed on a
 * present-but-untrusted Origin closes the hole; an ABSENT Origin still
 * passes (curl / e2e scripts / same-origin GET navigations send none).
 */
export function guardMiddleware(opts: { allowedHosts: Set<string>; trustedOrigins: Set<string> }): MiddlewareHandler {
	const { allowedHosts, trustedOrigins } = opts;
	return async (c, next) => {
		if (!isAllowedHost(c.req.header("host"), allowedHosts)) {
			return c.json({ error: "拒绝访问：Host 不在本机信任范围（可用 ALLOWED_HOSTS 扩展）" }, 403);
		}
		const origin = c.req.header("origin");
		if (origin !== undefined && !isAllowedOrigin(origin, trustedOrigins)) {
			return c.json({ error: "拒绝访问：Origin 不在信任范围（可用 TRUSTED_ORIGINS 扩展）" }, 403);
		}
		// Clickjacking + MIME sniffing hardening.
		c.header("X-Content-Type-Options", "nosniff");
		c.header("X-Frame-Options", "DENY");
		c.header("Referrer-Policy", "no-referrer");
		// Basic CSP for the snake demo page (served from this origin).
		if (c.req.path === "/snake" || c.req.path === "/") {
			c.header(
				"Content-Security-Policy",
				"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
			);
		}
		await next();
	};
}
