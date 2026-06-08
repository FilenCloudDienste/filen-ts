import { create } from "zustand"

// Coordinates "an in-app native presentation is on screen" across the privacy cover and the biometric
// lock, so neither reacts to the resign-active / background that such a presentation causes. An
// image/document picker, a permission dialog, or the Face ID prompt resigns the app active (and the
// recents snapshot would otherwise be redacted, and the biometric would re-lock) even though the user
// never really left the app.
//
// Every such presentation is funnelled through withSystemPresentation(). While one is active:
//   - the <PrivacyScreen> cover reads activeCount reactively and does NOT show (a render gate), and
//   - the biometric AppState re-lock skips (isReLockSuppressed(), which also covers a short grace
//     window after release so it survives the "AppState→active fires before the picker promise
//     resolves" race).

export const RELOCK_SUPPRESSION_GRACE_MS = 1500

// Pure predicate (exported for tests): is the biometric re-lock currently suppressed?
export function reLockSuppressed(
	activeCount: number,
	lastEndedAt: number,
	now: number,
	graceMs: number = RELOCK_SUPPRESSION_GRACE_MS
): boolean {
	return activeCount > 0 || now - lastEndedAt < graceMs
}

type SystemPresentationStore = {
	activeCount: number
	lastEndedAt: number
	begin: () => void
	end: () => void
}

// Reactive so the privacy cover can subscribe to activeCount (select with `s => s.activeCount > 0`).
export const useSystemPresentationStore = create<SystemPresentationStore>(set => ({
	activeCount: 0,
	lastEndedAt: 0,
	begin() {
		set(state => ({
			activeCount: state.activeCount + 1
		}))
	},
	end() {
		set(state => {
			if (state.activeCount === 0) {
				return state
			}

			const activeCount = state.activeCount - 1

			return {
				activeCount,
				lastEndedAt: activeCount === 0 ? Date.now() : state.lastEndedAt
			}
		})
	}
}))

// Imperative facade for non-React callers (the wrapper + the biometric AppState listener).
export const systemPresentation = {
	begin: (): void => useSystemPresentationStore.getState().begin(),
	end: (): void => useSystemPresentationStore.getState().end(),
	// True while at least one presentation is on screen — used by the privacy cover render gate.
	isActive: (): boolean => useSystemPresentationStore.getState().activeCount > 0,
	// True while a presentation is active OR within the post-release grace window — used by the
	// biometric AppState listener to skip re-locking after returning from an in-app presentation.
	isReLockSuppressed: (now: number = Date.now()): boolean => {
		const { activeCount, lastEndedAt } = useSystemPresentationStore.getState()

		return reLockSuppressed(activeCount, lastEndedAt, now)
	}
}

// Wrap any in-app native presentation (image/document picker, permission prompt, Face ID, document
// scanner, …) so the privacy cover and the biometric re-lock don't react to it.
export async function withSystemPresentation<T>(fn: () => Promise<T>): Promise<T> {
	systemPresentation.begin()

	try {
		return await fn()
	} finally {
		systemPresentation.end()
	}
}

export default systemPresentation
