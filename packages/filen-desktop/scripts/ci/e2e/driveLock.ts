import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { type } from "arktype"
import { errorMessage, fail } from "../support.ts"

// The account's "drive-write" lock, held by the harness the way another client holds it: sdk-rs's sync engine (and its
// cache's relist) waits for it, so N's first pass after a launch stays waiting for the cloud's listing while the
// harness holds it. Raw POSTs to the gateway's v3/user/lock with the harness session's API key, the shape sdk-rs sends
// (filen-types api/v3/user/lock.rs: {uuid, type, resource}; the answer's data {acquired, released, refreshed}).
// Acquire polls every 2 s for up to 120 s (the server lets a lease lapse 60 s after its last refresh, so a lock left
// behind by a quit app is gone by then); a refresh every 15 s keeps it (sdk-rs's own interval); a hard cap releases
// it 150 s after the acquire whatever the caller does, so a check that stalls never holds the account's drive for long.
// Every request is bounded; the key is never logged (the chain masks it).
// The same API takes any resource name (filen-backend userLock.ts: one key per user and resource), so the harness also
// keeps a lock of its own on the account (P11_TURN, chains/offlineListing.ts) that no client of the product knows.

export const LOCK_URL = "https://gateway.filen.io/v3/user/lock"
export const DRIVE_WRITE = "drive-write"

const REQUEST_TIMEOUT_MS = 15_000

export interface DriveLockTiming {
	pollMs: number
	acquireMs: number
	refreshMs: number
	capMs: number
}

export const DRIVE_LOCK_TIMING: DriveLockTiming = { pollMs: 2000, acquireMs: 120_000, refreshMs: 15_000, capMs: 150_000 }

export type LockType = "acquire" | "refresh" | "release"

export interface LockAnswer {
	acquired: boolean
	refreshed: boolean
	released: boolean
}

// One lock request: the server's answer, or a failure naming what went wrong (never the key).
export type LockPost = (body: { uuid: string; type: LockType; resource: string }) => Promise<LockAnswer>

// The API's envelope: {status, message, code, data}; data is the lock's answer when status is true.
const envelopeSchema = type({
	status: "boolean",
	"message?": "string",
	"code?": "string",
	"data?": { acquired: "boolean", refreshed: "boolean", released: "boolean" }
})

export function lockAnswerOf(httpStatus: number, json: unknown): LockAnswer {
	const answer = envelopeSchema(json)

	if (answer instanceof type.errors) {
		fail(`v3/user/lock answered HTTP ${String(httpStatus)} without its JSON`)
	}

	if (!answer.status || answer.data === undefined) {
		fail(`v3/user/lock answered HTTP ${String(httpStatus)}: ${answer.code ?? "no code"} (${answer.message ?? "no message"})`)
	}

	return answer.data
}

export function lockPost(apiKey: string): LockPost {
	return async body => {
		let response: Response

		try {
			response = await fetch(LOCK_URL, {
				method: "POST",
				headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			})
		} catch (error) {
			fail(`v3/user/lock (${body.type}) did not answer: ${errorMessage(error)}`)
		}

		return lockAnswerOf(response.status, await response.json().catch(() => null))
	}
}

export interface DriveLock {
	readonly uuid: string
	// Since the acquire, until the release (or now while held).
	heldMs(): number
	// Whether the cap released it before release() was called.
	capped(): boolean
	// Refreshes the server refused or that failed, as "<what> after <s>".
	refreshFailures(): readonly string[]
	// Idempotent; resolves with what happened (never throws).
	release(): Promise<string>
}

export async function acquireDriveLock(
	post: LockPost,
	timing: DriveLockTiming = DRIVE_LOCK_TIMING,
	resource: string = DRIVE_WRITE
): Promise<DriveLock> {
	const uuid = randomUUID()
	const body = (lockType: LockType) => ({ uuid, type: lockType, resource })
	const deadline = Date.now() + timing.acquireMs
	let lastRefusal = "refused"

	for (;;) {
		const answer = await post(body("acquire")).catch((error: unknown) => {
			lastRefusal = errorMessage(error)

			return null
		})

		if (answer?.acquired === true) {
			break
		}

		if (answer !== null) {
			lastRefusal = "held by another client"
		}

		if (Date.now() + timing.pollMs > deadline) {
			fail(`${resource} not acquired within ${String(timing.acquireMs / 1000)} s (last: ${lastRefusal})`)
		}

		await sleep(timing.pollMs)
	}

	const acquiredAt = Date.now()
	let releasedAt: number | null = null
	let byCap = false
	let releasing: Promise<string> | null = null
	const failures: string[] = []
	const since = () => `${((Date.now() - acquiredAt) / 1000).toFixed(1)} s`

	const refresher = setInterval(() => {
		void post(body("refresh"))
			.then(answer => {
				if (!answer.refreshed) {
					failures.push(`refused after ${since()}`)
				}
			})
			.catch((error: unknown) => {
				failures.push(`${errorMessage(error)} after ${since()}`)
			})
	}, timing.refreshMs)

	refresher.unref()

	const release = (): Promise<string> => {
		releasing ??= (async () => {
			clearInterval(refresher)
			clearTimeout(cap)
			releasedAt = Date.now()

			const held = `${((releasedAt - acquiredAt) / 1000).toFixed(1)} s`

			try {
				const answer = await post(body("release"))

				return answer.released ? `released after ${held}` : `release refused after ${held} (the lease had lapsed)`
			} catch (error) {
				return `release failed after ${held} (${errorMessage(error)}; the server lets it lapse within 60 s)`
			}
		})()

		return releasing
	}

	const cap = setTimeout(() => {
		byCap = true
		void release()
	}, timing.capMs)

	cap.unref()

	return {
		uuid,
		heldMs: () => (releasedAt ?? Date.now()) - acquiredAt,
		capped: () => byCap,
		refreshFailures: () => failures,
		release
	}
}
