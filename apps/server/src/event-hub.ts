/**
 * EventHub - fan-out pi events to WebSocket clients with:
 * - replay buffer (new clients get the full session history)
 * - per-toolCallId throttling of tool_execution_update (subagent partials carry
 *   the whole messages array and can flood; coalescing keeps the latest)
 */

import type { JsonAgentSessionEvent } from "@pi-graph/shared";

export interface ThrottleOptions {
	/** Min interval between forwarded updates for the same toolCallId. */
	intervalMs: number;
}

type Subscriber = (event: JsonAgentSessionEvent) => void;

export class EventHub {
	private subscribers = new Set<Subscriber>();
	private replay: JsonAgentSessionEvent[] = [];
	/** Last forwarded timestamp per toolCallId. */
	private lastSentAt = new Map<string, number>();
	/** Withheld latest update per toolCallId, plus its flush timer. */
	private withheld = new Map<string, { event: JsonAgentSessionEvent & { type: "tool_execution_update" }; timer: ReturnType<typeof setTimeout> }>();
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
		// A finalized tool flushes its withheld update immediately, in order
		// before the end event.
		if (event.type === "tool_execution_end") this.flushUpdate(event.toolCallId);
		this.deliver(event);
	}

	private ingestThrottled(event: JsonAgentSessionEvent & { type: "tool_execution_update" }): void {
		const id = event.toolCallId;
		const now = Date.now();
		if (now - (this.lastSentAt.get(id) ?? 0) >= this.throttle.intervalMs) {
			this.deliver(event);
			this.lastSentAt.set(id, now);
			return;
		}
		// Within the interval: hold the latest, flush it once the interval
		// elapses (unless a tool_execution_end flushes earlier).
		const existing = this.withheld.get(id);
		if (existing) {
			existing.event = event;
			return;
		}
		const timer = setTimeout(() => {
			const held = this.withheld.get(id);
			this.withheld.delete(id);
			if (held) {
				this.deliver(held.event);
				this.lastSentAt.set(id, Date.now());
			}
		}, this.throttle.intervalMs);
		this.withheld.set(id, { event, timer });
	}

	private flushUpdate(toolCallId: string): void {
		const held = this.withheld.get(toolCallId);
		if (!held) return;
		clearTimeout(held.timer);
		this.withheld.delete(toolCallId);
		// Deliver the withheld partial BEFORE the caller delivers the end event.
		this.deliver(held.event);
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
