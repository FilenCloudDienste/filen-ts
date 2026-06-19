// A navigation call is deduped if it is identical (same method + same target) to the immediately-
// preceding navigation AND lands within this window — i.e. a double/triple tap or a double-back. ~the
// screen-transition duration; distinct rapid navigation (push A then push B) is never affected.
export const NAV_DEDUPE_WINDOW_MS = 500

export type NavigationRecord = {
	method: string
	key: string
	atMs: number
}

// The dedupe identity of a navigation call is its TARGET (the first argument). Trailing args
// (navigation options such as `animation`) do not change identity — a double-tap is the same
// navigation regardless. No-arg calls (back / dismissAll) key on "".
export function navigationKey(args: unknown[]): string {
	if (args.length === 0) {
		return ""
	}

	const target = args[0]

	return typeof target === "string" ? target : JSON.stringify(target)
}

// Pure: is `next` a rapid duplicate of the immediately-preceding navigation `prev` — same method AND
// same target, landing within `windowMs`? Such a call is a double-fire (double-tap / double-back) and
// is dropped by the guarded router.
export function shouldDedupeNavigation(
	prev: NavigationRecord | null,
	next: { method: string; key: string },
	nowMs: number,
	windowMs: number
): boolean {
	if (!prev) {
		return false
	}

	return prev.method === next.method && prev.key === next.key && nowMs - prev.atMs < windowMs
}
