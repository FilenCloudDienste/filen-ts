// How the supervisor restarts a crashed native host: after 1 s, doubling per crash up to 5 min. Crashes count within a
// 10-minute window, so ten healthy minutes start the delays over; the fifth crash inside it stops the restarts until
// the user retries or the app launches again.
export const BACKOFF_BASE_MS = 1000
export const BACKOFF_CAP_MS = 5 * 60 * 1000
export const CRASH_WINDOW_MS = 10 * 60 * 1000
export const CRASH_LOOP_COUNT = 5

// `attempt` counts from 0.
export function backoffDelay(attempt: number): number {
	return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt))
}

export interface CrashHistory {
	// Records a crash at `at`: the delay before the next start, or null for a crash loop.
	crashed(at: number): number | null
	reset(): void
}

export function createCrashHistory(): CrashHistory {
	let crashes: number[] = []

	return {
		crashed: at => {
			crashes = crashes.filter(time => at - time < CRASH_WINDOW_MS)
			crashes.push(at)

			return crashes.length >= CRASH_LOOP_COUNT ? null : backoffDelay(crashes.length - 1)
		},
		reset: () => {
			crashes = []
		}
	}
}
