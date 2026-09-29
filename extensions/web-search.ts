/**
 * pi extension: web search and URL reading via Jina AI Reader/Search.
 *
 * Registers two tools:
 *   - web_search: query the public web (Jina s.jina.ai)
 *   - read_url:   fetch a URL as clean markdown (Jina r.jina.ai)
 *
 * Install:
 *   cp extensions/web-search.ts .pi/extensions/web-search.ts
 * Or symlink:
 *   ln -s ../../extensions/web-search.ts .pi/extensions/web-search.ts
 *
 * Optional env:
 *   JINA_API_KEY      - Bearer token for higher rate limits
 *   JINA_SEARCH_URL   - override search endpoint (default https://s.jina.ai)
 *   JINA_READER_URL   - override reader endpoint (default https://r.jina.ai)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SEARCH_URL = process.env.JINA_SEARCH_URL ?? "https://s.jina.ai";
const READER_URL = process.env.JINA_READER_URL ?? "https://r.jina.ai";

function jinaHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "text/markdown",
		"User-Agent": "pi-graph-ui-web-search/1.0",
	};
	const key = process.env.JINA_API_KEY;
	if (key) headers.Authorization = `Bearer ${key}`;
	return headers;
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
	const res = await fetch(url, { headers: jinaHeaders(), signal });
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`Jina request failed (${res.status}): ${text.slice(0, 500)}`);
	}
	return text;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the public web and return the top results as clean markdown.",
		promptSnippet: "Search the public web for current information",
		promptGuidelines: [
			"Use web_search when the user asks about recent events, people, products, libraries, documentation, or anything that may have changed after the training cutoff.",
			"Use web_search before guessing facts about versions, APIs, or current affairs.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Search query. Use English for better global results; Chinese works for Chinese-language pages.",
			}),
		}),
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Cancelled" }], details: {} };
			}
			const url = `${SEARCH_URL}/${encodeURIComponent(params.query)}`;
			const text = await fetchText(url, signal);
			return {
				content: [{ type: "text", text }],
				details: { query: params.query },
			};
		},
	});

	pi.registerTool({
		name: "read_url",
		label: "Read URL",
		description: "Fetch a web page and return its article content as clean markdown.",
		promptSnippet: "Read a web page as markdown",
		promptGuidelines: [
			"Use read_url when the user provides a URL or when web_search results point to a page that needs deeper reading.",
		],
		parameters: Type.Object({
			url: Type.String({
				description: "Full URL to fetch, e.g. https://example.com/page",
			}),
		}),
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Cancelled" }], details: {} };
			}
			const url = `${READER_URL}/${encodeURIComponent(params.url)}`;
			const text = await fetchText(url, signal);
			return {
				content: [{ type: "text", text }],
				details: { url: params.url },
			};
		},
	});
}
