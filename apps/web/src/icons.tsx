/**
 * Inline SVG icon set (零依赖) — one drawing grammar for every glyph in the
 * app: 24×24 viewBox, stroke = currentColor, strokeWidth 2, round caps and
 * joins (the lucide conventions, hand-inlined so no runtime dependency).
 *
 * Why not emoji/unicode glyphs: emoji come from the OS font — colored (the
 * design system is monochrome chart-ink), inconsistent across platforms, and
 * unable to inherit the surrounding text color; text symbols (✎ ✕ ↻) each
 * sit on their own baseline. Every icon here is a stroke drawing that scales
 * via the `size` prop (16 for controls, 11-13 for dense meta rows) and dims
 * or recolors with its context.
 *
 * Decorative by contract: each call site pairs the icon with a text label
 * (or title + aria-label on icon-only buttons), so the svg is aria-hidden
 * and stays out of the accessibility tree.
 */

import type { ReactNode, SVGProps } from "react";

const GLYPHS = {
	/** ⚡ auto-orchestration (plan_run). */
	bolt: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />,
	/** ⏹ abort the run/session. */
	stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
	/** ▶ run / replay. */
	play: <path d="m7 4 13 8-13 8V4z" />,
	/** ↻ retry / re-run the failed part. */
	rerun: (
		<>
			<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
			<path d="M21 3v5h-5" />
		</>
	),
	/** ↪ steer the running session. */
	steer: (
		<>
			<path d="m15 10 5 5-5 5" />
			<path d="M4 4v7a4 4 0 0 0 4 4h12" />
		</>
	),
	/** 📜 read-only history replay. */
	history: (
		<>
			<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
			<path d="M3 3v5h5" />
			<path d="M12 7v5l4 2" />
		</>
	),
	/** ☰ sessions. */
	menu: (
		<>
			<path d="M4 6h16" />
			<path d="M4 12h16" />
			<path d="M4 18h16" />
		</>
	),
	/** « collapse the session sidebar. */
	chevronsLeft: (
		<>
			<path d="m11 17-5-5 5-5" />
			<path d="m18 17-5-5 5-5" />
		</>
	),
	/** » expand the session rail. */
	chevronsRight: (
		<>
			<path d="m6 17 5-5-5-5" />
			<path d="m13 17 5-5-5-5" />
		</>
	),
	/** ✎ rename. */
	pencil: (
		<>
			<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
			<path d="m15 5 4 4" />
		</>
	),
	/** ✕ close / delete / rejected. */
	x: (
		<>
			<path d="M18 6 6 18" />
			<path d="m6 6 12 12" />
		</>
	),
	/** ✓ ok / applied. */
	check: <path d="M20 6 9 17l-5-5" />,
	/** ⚠ warning. */
	alert: (
		<>
			<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z" />
			<path d="M12 9v4" />
			<path d="M12 17h.01" />
		</>
	),
	/** ⏭ skipped nodes. */
	skip: (
		<>
			<path d="m5 4 10 8-10 8V4z" />
			<path d="M19 5v14" />
		</>
	),
	/** ⚙ orchestration result injected into the session. */
	gear: (
		<>
			<path d="M20 7h-9" />
			<path d="M14 17H5" />
			<circle cx="17" cy="17" r="3" />
			<circle cx="7" cy="7" r="3" />
		</>
	),
	/** 🔧 tool call. */
	wrench: (
		<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
	),
	/** 👤 user message. */
	user: (
		<>
			<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
			<circle cx="12" cy="7" r="4" />
		</>
	),
	/** 🤖 assistant reply. */
	bot: (
		<>
			<path d="M12 8V4H8" />
			<rect width="16" height="12" x="4" y="8" rx="2" />
			<path d="M2 14h2" />
			<path d="M20 14h2" />
			<path d="M15 13v2" />
			<path d="M9 13v2" />
		</>
	),
	/** 🛰 spawned subagent. */
	orbit: (
		<>
			<circle cx="12" cy="12" r="3" />
			<circle cx="19" cy="5" r="2" />
			<circle cx="5" cy="19" r="2" />
			<path d="M10.4 21.9a10 10 0 0 0 9.941-15.416" />
			<path d="M13.5 2.1a10 10 0 0 0-9.841 15.416" />
		</>
	),
	/** ✳ subagent fan-out call. */
	asterisk: (
		<>
			<path d="M12 6v12" />
			<path d="m17.196 9-10.392 6" />
			<path d="m6.804 9 10.392 6" />
		</>
	),
	/** ◆ session root. */
	diamond: <rect width="7" height="7" x="8.5" y="8.5" rx="1" transform="rotate(45 12 12)" />,
	/** · tool inside a subagent (the dimmest kind). */
	dot: <circle cx="12" cy="12" r="4" />,
	/** → jump to the orchestration tab. */
	arrowRight: (
		<>
			<path d="M5 12h14" />
			<path d="m12 5 7 7-7 7" />
		</>
	),
	/** ← back to the list. */
	arrowLeft: (
		<>
			<path d="m12 19-7-7 7-7" />
			<path d="M19 12H5" />
		</>
	),
	/** ＋ add. */
	plus: (
		<>
			<path d="M5 12h14" />
			<path d="M12 5v14" />
		</>
	),
	/** ↓ jump to the chat tail. */
	toBottom: (
		<>
			<path d="M12 17V3" />
			<path d="m6 11 6 6 6-6" />
			<path d="M19 21H5" />
		</>
	),
} as const satisfies Record<string, ReactNode>;

export type IconName = keyof typeof GLYPHS;

export function Icon({
	name,
	size = 16,
	className,
	...rest
}: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
			className={className ? `pg-ico ${className}` : "pg-ico"}
			{...rest}
		>
			{GLYPHS[name]}
		</svg>
	);
}
