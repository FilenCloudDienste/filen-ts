// Waits before an outbox sends its failed items again, from the last attempt: 30 s, 2 min, 10 min, then
// every 10 min. `step` counts the waits used since an item last landed.
const RESEND_BACKOFF_MS = [30_000, 120_000, 600_000] as const

export function resendDelay(step: number): number {
	return RESEND_BACKOFF_MS[Math.min(step, RESEND_BACKOFF_MS.length - 1)] ?? 600_000
}
