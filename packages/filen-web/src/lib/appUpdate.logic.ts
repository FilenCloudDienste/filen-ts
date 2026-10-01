// A tab opened before a deploy still references the previous build's hashed chunks, which the new build
// no longer serves, so the first screen it lazily opens afterwards fails to load.
export type StaleChunkAction = "reload" | "prompt" | "none"

// A second failure this soon after reloading means the new build fails too; looping would hide it.
export const STALE_RELOAD_COOLDOWN_MS = 60_000

export function staleChunkAction(input: { online: boolean; busy: boolean; lastReloadAt: number | null; now: number }): StaleChunkAction {
	// Offline, the fetch failed for want of a network, not a newer build, and a reload could not load either.
	if (!input.online) {
		return "none"
	}

	// Running transfers or unsaved edits would be dropped by a reload, so the user decides when.
	if (input.busy) {
		return "prompt"
	}

	if (input.lastReloadAt !== null && input.now - input.lastReloadAt < STALE_RELOAD_COOLDOWN_MS) {
		return "none"
	}

	return "reload"
}
