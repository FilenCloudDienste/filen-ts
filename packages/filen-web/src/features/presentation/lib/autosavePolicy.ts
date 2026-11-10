import { AUTOSAVE_IDLE_MS } from "@/features/office/lib/officeAutosave"

// When a deck autosaves. A save of a range-backed deck downloads every part it copies and uploads the whole package,
// so a one-shape edit of a 1.5 GiB deck moves about 3 GiB: autosave is tiered by the package's size. Up to 32 MiB a
// deck autosaves like the other editors (after the user's idle pause, 30 s by default); up to 256 MiB it waits at least five minutes between
// stored saves, and saves only once 1 KiB of net changes piled up or the oldest unsaved change is five minutes old;
// above that, and for an encrypted deck over 64 MiB (sealing holds the package in memory twice), only a save the user
// asks for stores it.

const MiB = 1024 * 1024

export const AUTOSAVE_SMALL_BYTES = 32 * MiB
export const AUTOSAVE_LARGE_BYTES = 256 * MiB
export const AUTOSAVE_ENCRYPTED_BYTES = 64 * MiB
export const AUTOSAVE_THROTTLE_MS = 5 * 60_000
export const AUTOSAVE_MIN_DIRTY_BYTES = 1024
// After an autosave that stored nothing (the upload failed), the next waits the tier's interval, doubled for every
// further failure in a row, up to this: a link too slow or down is not sent the whole package every interval.
export const AUTOSAVE_RETRY_MAX_MS = 30 * 60_000

export type AutosaveTier =
	| { readonly kind: "idle"; readonly idleMs: number; readonly minIntervalMs: number }
	| {
			readonly kind: "throttled"
			readonly idleMs: number
			readonly minIntervalMs: number
			readonly minDirtyBytes: number
			readonly maxDirtyAgeMs: number
	  }
	// Manual save only; `reason` is the notice the editor shows.
	| { readonly kind: "off"; readonly reason: "large" | "encrypted" }

// `idleMs`: the user's pause before an autosave (Settings, Office), for a deck small enough to save like the other
// editors; the larger tiers keep theirs.
export function autosaveTier(packageBytes: number, encrypted: boolean, idleMs: number = AUTOSAVE_IDLE_MS): AutosaveTier {
	if (encrypted && packageBytes > AUTOSAVE_ENCRYPTED_BYTES) {
		return { kind: "off", reason: "encrypted" }
	}

	if (packageBytes > AUTOSAVE_LARGE_BYTES) {
		return { kind: "off", reason: "large" }
	}

	if (packageBytes > AUTOSAVE_SMALL_BYTES) {
		return {
			kind: "throttled",
			idleMs: AUTOSAVE_IDLE_MS,
			minIntervalMs: AUTOSAVE_THROTTLE_MS,
			minDirtyBytes: AUTOSAVE_MIN_DIRTY_BYTES,
			maxDirtyAgeMs: AUTOSAVE_THROTTLE_MS
		}
	}

	return { kind: "idle", idleMs, minIntervalMs: idleMs }
}

// The editor's state as the policy reads it (times in ms on one clock).
export interface AutosaveState {
	readonly now: number
	readonly dirty: boolean
	// The last edit.
	readonly lastEditAt: number
	// The oldest edit not stored yet.
	readonly firstUnsavedAt: number
	// The last save that stored a version; undefined before any.
	readonly lastStoredAt: number | undefined
	// Net bytes dirty against the saved state as the session reports them; undefined when unknown.
	readonly dirtyBytes: number | undefined
	// Saves in a row that stored nothing since the last that did, and when the last of them ended.
	readonly failures?: number
	readonly lastFailedAt?: number
}

// How long until an autosave is due: 0 now, a positive delay to check again after, undefined never (clean, or the
// tier is off).
export function autosaveDueIn(tier: AutosaveTier, state: AutosaveState): number | undefined {
	if (tier.kind === "off" || !state.dirty) {
		return undefined
	}

	const idle = state.lastEditAt + tier.idleMs - state.now
	const spaced = state.lastStoredAt === undefined ? 0 : state.lastStoredAt + tier.minIntervalMs - state.now
	let wait = Math.max(idle, spaced)
	const failures = state.failures ?? 0

	if (failures > 0 && state.lastFailedAt !== undefined) {
		const backoff = Math.min(AUTOSAVE_RETRY_MAX_MS, tier.minIntervalMs * 2 ** Math.min(failures - 1, 16))

		wait = Math.max(wait, state.lastFailedAt + backoff - state.now)
	}

	if (tier.kind === "throttled") {
		const enough = state.dirtyBytes !== undefined && state.dirtyBytes >= tier.minDirtyBytes

		if (!enough) {
			wait = Math.max(wait, state.firstUnsavedAt + tier.maxDirtyAgeMs - state.now)
		}
	}

	return Math.max(0, wait)
}
