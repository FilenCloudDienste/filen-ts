import { log } from "@/lib/log"

// How long an SDK call may stay outstanding before it is reported: far past any healthy round trip.
export const SLOW_SDK_CALL_MS = 30_000

// Logs one warning when `call` has not settled after SLOW_SDK_CALL_MS. Never aborts or retries it: a call
// that never settles is only made visible.
export async function warnIfSlow<T>(call: Promise<T>, scope: string, what: string, id: string): Promise<T> {
	const startedAt = Date.now()
	const timer = setTimeout(() => {
		log.warn(scope, `${what} still outstanding`, id, `${String(Date.now() - startedAt)}ms`)
	}, SLOW_SDK_CALL_MS)

	try {
		return await call
	} finally {
		clearTimeout(timer)
	}
}
