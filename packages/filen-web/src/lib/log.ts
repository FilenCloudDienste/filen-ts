export type LogLevel = "debug" | "info" | "warn" | "error"

export interface LogEntry {
	t: number
	level: LogLevel
	scope: string
	msg: string
}

const RING_MAX = 500
const ring: LogEntry[] = []

// lib.es5's JSON.stringify signature always claims `string`, but it genuinely returns
// `undefined` at runtime for top-level undefined/functions/symbols — a named helper with
// an explicit wider return type makes that honest at the call site, unlike a local `const`
// annotation (which strict-type-checked lint still narrows back to the literal call type).
function stringifyBigintSafe(v: unknown): string | undefined {
	return JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `${x.toString()}n` : x))
}

function safeInspect(v: unknown): string {
	try {
		return stringifyBigintSafe(v) ?? String(v)
	} catch {
		return String(v)
	}
}

function push(level: LogLevel, scope: string, args: unknown[]): void {
	ring.push({ t: Date.now(), level, scope, msg: args.map(a => (typeof a === "string" ? a : safeInspect(a))).join(" ") })

	if (ring.length > RING_MAX) {
		ring.shift()
	}

	console[level](`[${scope}]`, ...args)
}

export const log = {
	debug: (s: string, ...a: unknown[]) => {
		push("debug", s, a)
	},
	info: (s: string, ...a: unknown[]) => {
		push("info", s, a)
	},
	warn: (s: string, ...a: unknown[]) => {
		push("warn", s, a)
	},
	error: (s: string, ...a: unknown[]) => {
		push("error", s, a)
	},
	dump: (): LogEntry[] => [...ring]
}
