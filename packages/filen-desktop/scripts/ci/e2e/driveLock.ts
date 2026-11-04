import { randomUUID } from "node:crypto"
import { closeSync, openSync, readSync, statSync } from "node:fs"
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
// How long the server keeps a lease nobody refreshes (sdk-rs LOCK_SERVER_TTL): a client that loses the network while it
// holds drive-write cannot release it, so every other client waits that long.
export const LOCK_SERVER_TTL_MS = 60_000

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

// What N's native host logged about drive-write (its lines in the chain's app output, or in main.log). Each line
// carries the host's own UTC timestamp, from the same clock as the harness's. sdk-rs's acquire_lock span also closes
// on a failed acquire and, on some paths, before its request answered (both with an idle time in µs), so a grant is a
// close that waited on the network (an idle time in ms or s) right after a lock request that answered: the poll the
// server granted. The watchdog reports an acquire still waiting, and a pair's pass backoff names its wait.
const NATIVE_TIME = String.raw`native: (\d{4}-\d\d-\d\dT[\d:.]+Z)\s+`
const ACQUIRE_CLOSE = new RegExp(
	String.raw`${NATIVE_TIME}INFO acquire_lock\{resource="drive-write"\}: \S+ close .*time\.idle=[\d.]+(µs|ns|ms|s)\b`
)
// A lock request's span: its id, and whether this line is its close or its failure.
const LOCK_REQUEST = new RegExp(
	String.raw`${NATIVE_TIME}(?:INFO|WARN) (?:\S+:)?http_request\{endpoint=v3/user/lock request_id=(\d+)\}: \S+ (close |request failed)(?: elapsed_ms=(\d+))?`
)
const ACQUIRE_RUNNING = new RegExp(String.raw`${NATIVE_TIME}WARN \S+: operation still running .*op_name="acquire_lock" .*elapsed_ms=(\d+)`)
const RELEASE_FAILED = new RegExp(String.raw`${NATIVE_TIME}WARN \S+: Failed to release lock drive-write`)
// A release attempt that failed in transport and is sent again (sdk-rs sync/lock release_loop); every other release
// line after a failed attempt ends the loop without an answer: given up for the lease's TTL, or failed otherwise.
const RELEASE_RETRYING = "Failed to release lock drive-write, retrying in "
const RELEASE_STOPPED = new RegExp(
	String.raw`${NATIVE_TIME}WARN \S+: (?:Failed to release lock drive-write(?!, retrying in )|Release of lock drive-write unanswered)`
)
const PASS_BACKOFF = new RegExp(
	String.raw`${NATIVE_TIME}WARN \S+: sync pair \S+: \d+ consecutive failure\(s\); waiting (\d+)s before the next pass`
)
// How close after the granting poll's answer the acquire returns.
const GRANT_AFTER_POLL_MS = 50

function matches(output: string, pattern: RegExp): RegExpExecArray[] {
	return output.split("\n").flatMap(line => {
		const match = pattern.exec(line)

		return match === null ? [] : [match]
	})
}

// Every lock request that answered, as the time of its close. A request that failed logs the failure inside its span
// just before the span closes; request ids restart with each launch, so the failure is matched by id and time.
function answeredLockRequests(output: string): number[] {
	const requests = matches(output, LOCK_REQUEST).map(match => ({
		at: Date.parse(match[1] ?? ""),
		id: match[2],
		failure: match[3] !== "close "
	}))
	const failures = requests.filter(request => request.failure)

	return requests
		.filter(
			request =>
				!request.failure &&
				!failures.some(failure => failure.id === request.id && request.at >= failure.at && request.at - failure.at <= 1000)
		)
		.map(request => request.at)
}

// When N got drive-write, in the order logged (epoch ms).
export function driveWriteGrants(output: string): number[] {
	const answered = answeredLockRequests(output)

	return matches(output, ACQUIRE_CLOSE)
		.filter(match => match[2] === "ms" || match[2] === "s")
		.map(match => Date.parse(match[1] ?? ""))
		.filter(at => answered.some(poll => poll <= at && at - poll <= GRANT_AFTER_POLL_MS))
}

// Why N has no drive-write yet: its acquire still running after its last grant (the watchdog's report), or nothing.
export function lockWaitNote(output: string): string {
	const lastGrant = Math.max(0, ...driveWriteGrants(output))
	const waiting = matches(output, ACQUIRE_RUNNING).filter(match => Date.parse(match[1] ?? "") > lastGrant)
	const last = waiting.at(-1)

	return last === undefined
		? "N's log shows no acquire of drive-write still running"
		: `N still waiting for drive-write (acquire_lock running ${String(Math.round(Number(last[2]) / 1000))} s at ${last[1] ?? ""}): another client holds it`
}

// How much of a pass backoff logged before `at` was still to run then (ms, 0 when none), at most `capMs`.
export function residualBackoff(output: string, at: number, capMs: number): number {
	const ends = matches(output, PASS_BACKOFF)
		.map(match => ({ logged: Date.parse(match[1] ?? ""), ends: Date.parse(match[1] ?? "") + Number(match[2]) * 1000 }))
		.filter(backoff => backoff.logged <= at)
		.map(backoff => backoff.ends)

	return Math.min(capMs, Math.max(0, ...ends.map(end => end - at)))
}

// How much earlier than its last confirmation plus the TTL the server may let a lease lapse (the two clocks, the
// request's own time on the wire).
export const LEASE_MARGIN_MS = 5000

export interface OrphanedLease {
	// When N's release failed, and when the server last confirmed the lease (N's last lock request that answered).
	failedAt: number
	confirmedAt: number
	// Before this, only a release N sent again can have freed the lease: the server keeps it until then.
	lapsesAt: number
}

// A drive-write lease N's release could not free because N was cut off at `blockedAt` (sdk-rs sends it again until
// the server answers, but no answer can come while N is cut off), still alive at `lifted` with `minRoomMs` left for N's
// next acquire before it lapses; null otherwise.
// Only a release whose request was sent after the block counts: one sent before it may have reached the server, whose
// answer alone was lost.
export function orphanedLease(output: string, blockedAt: number, lifted: number, minRoomMs: number): OrphanedLease | null {
	const failures = matches(output, LOCK_REQUEST)
		.filter(match => match[3] === "request failed")
		.map(match => ({ at: Date.parse(match[1] ?? ""), sentAt: Date.parse(match[1] ?? "") - Number(match[4] ?? Number.NaN) }))
	const failedAt = Math.max(
		0,
		...matches(output, RELEASE_FAILED)
			.map(match => Date.parse(match[1] ?? ""))
			.filter(at => at >= blockedAt && at <= lifted)
			// The release's own request failed just before it was reported, sent after the block went in.
			.filter(at => failures.some(failure => failure.at <= at && at - failure.at <= 50 && failure.sentAt >= blockedAt))
	)
	const confirmedAt = Math.max(0, ...answeredLockRequests(output).filter(at => at <= failedAt))
	const lapsesAt = confirmedAt + LOCK_SERVER_TTL_MS - LEASE_MARGIN_MS

	return failedAt === 0 || confirmedAt === 0 || lapsesAt - lifted < minRoomMs ? null : { failedAt, confirmedAt, lapsesAt }
}

// Why N's drive-write release that failed at `failedAt` was never answered, or null: the attempt that failed then is not
// one sdk-rs sends again, or a later one stopped the retries (the lease's TTL reached, an attempt unanswered within it,
// a failure other than transport). A retry that was answered logs nothing at INFO, so null is the release sent again.
export function releaseStopped(output: string, failedAt: number): string | null {
	const lines = output.split("\n")
	const failed = lines.find(line => {
		const match = RELEASE_FAILED.exec(line)

		return match !== null && Date.parse(match[1] ?? "") === failedAt
	})

	if (failed !== undefined && !failed.includes(RELEASE_RETRYING)) {
		return failed.trim()
	}

	return (
		lines
			.filter(line => {
				const match = RELEASE_STOPPED.exec(line)

				return match !== null && Date.parse(match[1] ?? "") >= failedAt
			})[0]
			?.trim() ?? null
	)
}

// The chain's app output file is appended by every launch: where it ends now, and what was appended since.
export function outputMark(file: string): number {
	return statSync(file, { throwIfNoEntry: false })?.size ?? 0
}

export function outputSince(file: string, mark: number): string {
	const size = outputMark(file)

	if (size <= mark) {
		return ""
	}

	const fd = openSync(file, "r")

	try {
		const buffer = Buffer.alloc(size - mark)
		const read = readSync(fd, buffer, 0, buffer.length, mark)

		return buffer.subarray(0, read).toString("utf8")
	} finally {
		closeSync(fd)
	}
}
