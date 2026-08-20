/**
 * EventHub - fan-out pi events to WebSocket clients with:
 * - replay buffer (new clients get the full session history)
 * - per-toolCallId throttling of tool_execution_update (subagent partials carry
 *   the whole messages array and can flood; 100ms coalescing keeps the latest)
 */

import type { JsonAgentSessionEvent } from "@pi-graph/shared";

export interface ThrottleOptions {
	/** Min interval between forwarded updates for the same toolCallId. */
	intervalMs: number;
}

type Subscriber = (event: JsonAgentSessionEvent) => void;

interface PendingUpdate {
	event: JsonAgentSessionEvent & { type: "tool_execution_update" };
	timer: ReturnType<typeof setTimeout> | null;
	lastSentAt: number;
}

export class EventHub {
	private subscribers = new Set<Subscriber>();
	private replay: JsonAgentSessionEvent[] = [];
	private pendingUpdates = new Map<string, PendingUpdate>();
	private readonly throttle: ThrottleOptions;

	constructor(throttle: ThrottleOptions = { intervalMs: 100 }) {
		this.throttle = throttle;
	}

	/** Ingest an event: buffer it, throttle updates, fan out. */
	ingest(event: JsonAgentSessionEvent): void {
		if (event.type === "tool_execution_update") {
			this.ingestThrottled(event);
			return;
		}
		// A finalized tool flushes its pending update immediately (in order
		// before the end event).
		if (event.type === "tool_execution_end") this.flushUpdate(event.toolCallId);
		this.deliver(event);
	}

	private ingestThrottled(event: JsonAgentSessionEvent & { type: "tool_execution_update" }): void {
		const id = event.toolCallId;
		const now = Date.now();
		const existing = this.pendingUpdates.get(id);
		const pending: PendingUpdate = existing ?? { event, timer: null, lastSentAt: 0 };
		pending.event = event; // always keep the latest

		if (now - pending.lastSentAt >= this.throttle.intervalMs) {
			this.deliver(event);
			pending.lastSentAt = now;
			return;
		}
		if (!pending.timer) {
			pending.timer = setTimeout(() => {
				pending.timer = null;
				this.deliver(pending.event);
				pending.lastSentAt = Date.now();
			}, this.throttle.intervalMs);
		}
		this.pendingUpdates.set(id, pending);
	}

	private flushUpdate(toolCallId: string): void {
		const pending = this.pendingUpdates.get(toolCallId);
		if (!pending) return;
		if (pending.timer) clearTimeout(pending.timer);
		this.pendingUpdates.delete(toolCallId);
		if (pending.lastSentAt === 0 || pending.timer) {
			// An update was still withheld - send it before the end event so the
			// client sees the final partial state.
			this.deliver(pending.event);
		}
	}

	/** Deliver to replay buffer + subscribers. */
	private deliver(event: JsonAgentSessionEvent): void {
		this.replay.push(event);
		for (const sub of this.subscribers) sub(event);
	}

	subscribe(sub: Subscriber): () => void {
		this.subscribers.add(sub);
		return () => this.subscribers.delete(sub);
	}

	/** Full event history for newly connected clients. */
	history(): JsonAgentSessionEvent[] {
		return this.replay;
	}
}
