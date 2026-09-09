#!/usr/bin/env node
/**
 * Browser-level verification + screenshots for the session sidebar (对话管理).
 * Drives the real web app against the live dev stack (web :5173, server :8787,
 * real LLM behind pi) with playwright-core + the locally installed chromium.
 *
 * Flow: ＋新对话 → 小明 turn → ＋新对话 → 1+1 turn → switch back to the 小明
 * session via the sidebar → ask 我叫什么名字 → assert the answer mentions 小明
 * (golden) → inline rename → screenshots into docs/images/.
 *
 * Usage: node scripts/verify-sessions-ui.mjs   (expects dev stack running)
 */
import { chromium } from "playwright-core";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Browser resolution: PLAYWRIGHT_CHROMIUM env → this machine's playwright
// cache → playwright-core's own registry lookup.
const CANDIDATES = [
	process.env.PLAYWRIGHT_CHROMIUM,
	resolve(process.env.USERPROFILE ?? process.env.HOME ?? ".", "AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe"),
].filter(Boolean);
const EXECUTABLE = CANDIDATES.find((p) => existsSync(p));
const URL = process.env.WEB_URL ?? "http://localhost:5173";
const IMG_DIR = resolve(import.meta.dirname, "../docs/images");
mkdirSync(IMG_DIR, { recursive: true });

const browser = await chromium.launch(EXECUTABLE ? { executablePath: EXECUTABLE } : {});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 2 });
const deadline = Date.now() + 300000;
const fail = (msg) => {
	console.error("FAIL:", msg);
	process.exitCode = 1;
	throw new Error(msg);
};

async function sendPrompt(text) {
	await page.fill(".pg-input-bar input", text);
	await page.click(".pg-input-bar button:has-text('发送')");
}

/** Wait until a new assistant bubble appears, stops streaming and stays put. */
async function waitSettled(previousCount) {
	while (Date.now() < deadline) {
		const state = await page.evaluate(() => ({
			count: document.querySelectorAll(".pg-chat-row-assistant .pg-chat-bubble").length,
			streaming: document.querySelector(".pg-chat-cursor") !== null,
			busy: document.querySelector('[aria-busy="true"]') !== null,
		}));
		if (state.count > previousCount && !state.streaming && !state.busy) return state.count;
		await page.waitForTimeout(400);
	}
	fail(`assistant never settled (after ${previousCount} bubbles)`);
}

async function lastAssistantText() {
	return page.evaluate(() => {
		const bubbles = [...document.querySelectorAll(".pg-chat-row-assistant .pg-chat-bubble")];
		return bubbles.at(-1)?.textContent ?? "";
	});
}

console.log("open", URL);
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".pg-sessions", { timeout: 30000 });
await page.waitForTimeout(1500); // ws hello + snapshot rebuild

// ── Session 1: introduce 小明 ─────────────────────────────────────────────
await page.click("button:has-text('＋ 新对话')");
await page.waitForTimeout(1200);
let n = await page.evaluate(() => document.querySelectorAll(".pg-chat-row-assistant .pg-chat-bubble").length);
await sendPrompt("请记住：我叫小明。只回复「好的」两个字。");
n = await waitSettled(n);
console.log("turn 1 reply:", JSON.stringify((await lastAssistantText()).slice(0, 40)));

// ── Session 2: switch away ────────────────────────────────────────────────
await page.click("button:has-text('＋ 新对话')");
// The fresh world is confirmed by the placeholder row (sessionId=null).
await page.waitForSelector(".pg-sessions-list .pg-session-item.active:has-text('(新会话')", { timeout: 20000 });
await page.waitForTimeout(600);
n = await page.evaluate(() => document.querySelectorAll(".pg-chat-row-assistant .pg-chat-bubble").length);
await sendPrompt("1+1 等于几？只回答数字");
n = await waitSettled(n);
console.log("turn 2 reply:", JSON.stringify((await lastAssistantText()).slice(0, 40)));

// ── Switch back via the sidebar row that mentions 小明 ─────────────────────
const rows = await page.locator(".pg-session-item").allInnerTexts();
console.log("sidebar rows before switch:", JSON.stringify(rows));
const row = page.locator(".pg-session-item:not(.active)", { hasText: "小明" }).first();
await row.click();
// Switch completes when the sidebar no longer shows 切换中 and the chat
// rebuilt from the archive (小明 user bubble visible again).
await page.waitForSelector(".pg-session-item.active .pg-session-title:has-text('小明')", { timeout: 30000 });
await page.waitForFunction(
	() => [...document.querySelectorAll(".pg-chat-bubble-user")].some((b) => b.textContent.includes("我叫小明")),
	undefined,
	{ timeout: 30000 },
);
console.log("switched back: archive rebuilt in chat");

await page.screenshot({ path: resolve(IMG_DIR, "sessions-switch.png") });

// ── Golden assertion: context survived the round trip ─────────────────────
n = await page.evaluate(() => document.querySelectorAll(".pg-chat-row-assistant .pg-chat-bubble").length);
await sendPrompt("我叫什么名字？只回答名字本身");
await waitSettled(n);
const answer = await lastAssistantText();
console.log("golden answer:", JSON.stringify(answer.slice(0, 40)));
if (!answer.includes("小明")) fail(`context not restored in browser flow — got: ${answer.slice(0, 80)}`);
console.log("PASS: context restored after sidebar switch");

// ── Rename the current session inline ─────────────────────────────────────
// The ✎ cluster is hover-revealed (opacity/pointer-events on li:hover) —
// hover the row first, then the click's hit-target check passes.
await page.locator("li:has(.pg-session-item.active) .pg-session-item").hover();
await page.locator("li:has(.pg-session-item.active) button[title='重命名']").click();
await page.fill(".pg-session-rename", "小明的自我介绍");
await page.keyboard.press("Enter");
await page.waitForSelector(".pg-session-item.active .pg-session-title:has-text('小明的自我介绍')", { timeout: 15000 });
console.log("PASS: rename persisted in sidebar");

await page.screenshot({ path: resolve(IMG_DIR, "sessions-sidebar.png") });

// ── Collapsed rail shot ───────────────────────────────────────────────────
await page.click("button[aria-expanded]");
await page.waitForSelector(".pg-sessions-rail", { timeout: 15000 });
await page.waitForTimeout(400);
await page.screenshot({ path: resolve(IMG_DIR, "sessions-collapsed.png") });

await browser.close();
console.log("\nUI VERIFY OK — screenshots in docs/images/");
