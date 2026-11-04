import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
	acquireDriveLock,
	DRIVE_LOCK_TIMING,
	DRIVE_WRITE,
	driveWriteGrants,
	type LockAnswer,
	lockAnswerOf,
	type LockPost,
	LOCK_SERVER_TTL_MS,
	type LockType,
	LEASE_MARGIN_MS,
	lockWaitNote,
	orphanedLease,
	outputMark,
	outputSince,
	releaseStopped,
	residualBackoff
} from "../../scripts/ci/e2e/driveLock.ts"
import { LIVE_TIMEOUT_MS, LIVE_UPLOAD_MS } from "../../scripts/ci/e2e/chains/common.ts"
import { allWaiting, backOnline, converged, offlineFailure, P11_TURN, P11_TURN_TIMING } from "../../scripts/ci/e2e/chains/offlineListing.ts"
import type { Sample } from "../../scripts/ci/e2e/offlineBlock.ts"

const FAST = { pollMs: 1, acquireMs: 200, refreshMs: 5, capMs: 10_000 }

function answer(overrides: Partial<LockAnswer> = {}): LockAnswer {
	return { acquired: false, refreshed: false, released: false, ...overrides }
}

// A scripted server: `acquireAfter` refusals before the acquire succeeds; every request recorded.
function server(acquireAfter = 0): { post: LockPost; sent: { uuid: string; type: LockType; resource: string }[] } {
	const sent: { uuid: string; type: LockType; resource: string }[] = []
	let refusals = acquireAfter

	const post: LockPost = body => {
		sent.push(body)

		if (body.type === "acquire") {
			return Promise.resolve(answer({ acquired: refusals-- <= 0 }))
		}

		return Promise.resolve(answer(body.type === "refresh" ? { refreshed: true } : { released: true }))
	}

	return { post, sent }
}

describe("e2e drive-write lock", () => {
	it("reads the API's envelope", () => {
		expect(lockAnswerOf(200, { status: true, message: "ok", code: "ok", data: answer({ acquired: true }) })).toEqual(
			answer({ acquired: true })
		)
		expect(() => lockAnswerOf(401, { status: false, message: "Invalid API key.", code: "api_key_not_found" })).toThrow(
			"v3/user/lock answered HTTP 401: api_key_not_found (Invalid API key.)"
		)
		expect(() => lockAnswerOf(502, null)).toThrow("v3/user/lock answered HTTP 502 without its JSON")
	})

	it("polls the acquire, refreshes the lease and releases it once", async () => {
		const { post, sent } = server(2)
		const lock = await acquireDriveLock(post, FAST)

		await new Promise(resolve => setTimeout(resolve, 30))

		const first = await lock.release()

		expect(await lock.release()).toBe(first)
		expect(first).toMatch(/^released after \d+\.\d s$/)
		expect(lock.capped()).toBe(false)
		expect(lock.refreshFailures()).toEqual([])
		expect(sent.slice(0, 3).map(body => body.type)).toEqual(["acquire", "acquire", "acquire"])
		expect(sent.some(body => body.type === "refresh")).toBe(true)
		expect(sent.filter(body => body.type === "release")).toHaveLength(1)
		expect(new Set(sent.map(body => `${body.uuid} ${body.resource}`))).toEqual(new Set([`${lock.uuid} ${DRIVE_WRITE}`]))

		// Nothing is sent once released.
		const count = sent.length

		await new Promise(resolve => setTimeout(resolve, 20))
		expect(sent).toHaveLength(count)
	})

	it("gives up on a lock another client keeps, naming the last answer", async () => {
		const { post } = server(Number.POSITIVE_INFINITY)

		await expect(acquireDriveLock(post, { ...FAST, acquireMs: 20 })).rejects.toThrow(
			"drive-write not acquired within 0.02 s (last: held by another client)"
		)
	})

	it("keeps polling through failed requests", async () => {
		let calls = 0
		const post: LockPost = body => {
			calls++

			if (body.type === "acquire" && calls < 3) {
				return Promise.reject(new Error("v3/user/lock (acquire) did not answer: fetch failed"))
			}

			return Promise.resolve(answer({ acquired: true, released: true }))
		}
		const lock = await acquireDriveLock(post, FAST)

		expect(calls).toBe(3)
		expect(await lock.release()).toMatch(/^released after/)
	})

	it("takes any resource, naming it", async () => {
		const { post, sent } = server()
		const lock = await acquireDriveLock(post, FAST, P11_TURN)

		await lock.release()
		expect(new Set(sent.map(body => body.resource))).toEqual(new Set([P11_TURN]))
		await expect(acquireDriveLock(server(Number.POSITIVE_INFINITY).post, { ...FAST, acquireMs: 20 }, P11_TURN)).rejects.toThrow(
			`${P11_TURN} not acquired within 0.02 s (last: held by another client)`
		)
	})

	it("keeps the P11 turn past P11's longest path and within the server's limits", () => {
		expect(P11_TURN).not.toBe(DRIVE_WRITE)
		// filen-backend userLock.ts: resource 1-128 characters; a lease lapses 60 s after its last refresh.
		expect(P11_TURN.length).toBeLessThanOrEqual(128)
		expect(P11_TURN_TIMING.refreshMs).toBeLessThan(60_000)
		// P11's three sub-steps with their relaunches, and the drive-write cap, fit in the turn's cap.
		expect(P11_TURN_TIMING.capMs).toBeGreaterThan(10 * 60 * 1000)
		expect(P11_TURN_TIMING.acquireMs).toBeGreaterThan(P11_TURN_TIMING.capMs)
	})

	it("releases at the cap and records refused refreshes", async () => {
		const sent: LockType[] = []
		const post: LockPost = body => {
			sent.push(body.type)

			return Promise.resolve(answer({ acquired: true, refreshed: false, released: true }))
		}
		const lock = await acquireDriveLock(post, { ...FAST, capMs: 25 })

		await new Promise(resolve => setTimeout(resolve, 60))

		expect(lock.capped()).toBe(true)
		expect(sent.filter(type => type === "release")).toHaveLength(1)
		expect(lock.refreshFailures()[0]).toMatch(/^refused after/)
		expect(await lock.release()).toMatch(/^released after/)
		expect(sent.filter(type => type === "release")).toHaveLength(1)
	})
})

describe("P11 listing drop", () => {
	const sample = (waiting: number, offline: number, errors: number, pairs = 3): Sample => ({
		at: 0,
		phases: "",
		offline,
		waiting,
		errors,
		pairs,
		lastErrors: errors,
		rail: "Computer",
		syncAttention: false
	})

	it("holds the staging only while every pair waits for the cloud", () => {
		expect(allWaiting(sample(3, 0, 0))).toBe(true)
		expect(allWaiting(sample(2, 1, 0))).toBe(false)
		expect(allWaiting(sample(3, 0, 1))).toBe(false)
		expect(allWaiting(sample(0, 0, 0, 0))).toBe(false)
	})

	it("is back online before converged: a pair still waiting for the cloud is online", () => {
		expect(backOnline(sample(2, 0, 0))).toBe(true)
		expect(converged(sample(2, 0, 0))).toBe(false)
		expect(backOnline(sample(0, 1, 0))).toBe(false)
		expect(backOnline(sample(0, 0, 1))).toBe(false)
		expect(converged(sample(0, 0, 0))).toBe(true)
		expect(converged({ ...sample(0, 0, 0), lastErrors: 1 })).toBe(false)
	})

	it("names a pair still waiting for the cloud as the regression", () => {
		expect(offlineFailure(sample(1, 2, 0))).toBe(
			"1 of 3 pairs still waiting for the cloud: the listing's wait does not notice the lost network (the regression)"
		)
		expect(offlineFailure(sample(0, 2, 1))).toBe("1 of 3 pairs in error instead of offline")
		expect(offlineFailure(sample(0, 2, 0))).toBe("2 of 3 pairs offline")
	})
})

describe("e2e drive-write in N's log", () => {
	// Lines as the chain's app output has them (main.log prefixes its own timestamp and level: the same match).
	const grant = (at: string, idle = "98.2ms") =>
		`native: ${at}  INFO acquire_lock{resource="drive-write"}: filen_sdk_rs::sync::lock: close time.busy=25.0µs time.idle=${idle}`
	const attempt =
		'native: 2026-11-03T12:49:13.886735Z  WARN acquire_lock{resource="drive-write"}: filen_sdk_rs::sync::lock: Attempt 7/60: lock request for resource drive-write failed, retrying in 2s: Error of kind Reqwest'
	const running = (at: string, ms: number) =>
		`native: ${at}  WARN filen_sdk_rs::obs: operation still running op_target=filen_sdk_rs::sync::lock op_name="acquire_lock" op_fields= elapsed_ms=${String(ms)}`
	const backoff = (at: string, s: number) =>
		`native: ${at}  WARN filen_sdk_rs::sync_engine::watch: sync pair 2: 3 consecutive failure(s); waiting ${String(s)}s before the next pass`

	const poll = (at: string, id: number) =>
		`native: ${at}  INFO http_request{endpoint=v3/user/lock request_id=${String(id)}}: filen_sdk_rs::auth::http::logging: close time.busy=139µs time.idle=103ms`
	const pollFailed = (at: string, id: number) =>
		`native: ${at}  WARN http_request{endpoint=v3/user/lock request_id=${String(id)}}: filen_sdk_rs::auth::http::logging: request failed elapsed_ms=1583 error=Error of kind Reqwest`

	it("reads when N got drive-write: the acquire's close right after the poll the server answered", () => {
		const output = [
			attempt,
			poll("2026-11-03T12:54:28.076408Z", 39),
			grant("2026-11-03T12:54:28.076534Z", "58.6s"),
			`[2026-11-03T12:54:30.000Z] INFO ${poll("2026-11-03T12:54:29.990000Z", 49)}`,
			`[2026-11-03T12:54:30.000Z] INFO ${grant("2026-11-03T12:54:30.000000Z", "103ms")}`
		].join("\n")

		expect(driveWriteGrants(output)).toEqual([Date.parse("2026-11-03T12:54:28.076Z"), Date.parse("2026-11-03T12:54:30.000Z")])
		expect(driveWriteGrants(attempt)).toEqual([])
	})

	it("never takes for a grant a close in µs, one with no answered poll before it, or one after a failed poll", () => {
		// Closes before any request answered (a launch's), and the close of an acquire whose poll failed offline.
		expect(driveWriteGrants(grant("2026-11-03T12:57:13.483845Z", "27.4µs"))).toEqual([])
		expect(driveWriteGrants(grant("2026-11-03T12:57:13.925182Z", "10.6ms"))).toEqual([])
		expect(
			driveWriteGrants(
				[
					pollFailed("2026-11-03T12:57:15.498160Z", 7),
					poll("2026-11-03T12:57:15.498166Z", 7),
					grant("2026-11-03T12:57:15.498447Z", "19.9ms")
				].join("\n")
			)
		).toEqual([])
		// An answered poll too long before the close is another request's.
		expect(
			driveWriteGrants([poll("2026-11-03T12:57:10.000000Z", 3), grant("2026-11-03T12:57:13.925182Z", "10.6ms")].join("\n"))
		).toEqual([])
	})

	it("finds a lease N's lost network left, while the server still keeps it", () => {
		const output = [
			poll("2026-11-03T12:57:13.769220Z", 3),
			poll("2026-11-03T12:57:13.910538Z", 4),
			pollFailed("2026-11-03T12:57:15.498098Z", 6),
			poll("2026-11-03T12:57:15.498123Z", 6),
			"native: 2026-11-03T12:57:15.498131Z  WARN filen_sdk_rs::sync::lock: Failed to release lock drive-write: Error of kind Reqwest"
		].join("\n")
		const blocked = Date.parse("2026-11-03T12:57:13.750Z")
		const lifted = Date.parse("2026-11-03T12:57:18.100Z")
		const confirmedAt = Date.parse("2026-11-03T12:57:13.910Z")

		expect(orphanedLease(output, blocked, lifted, 10_000)).toEqual({
			failedAt: Date.parse("2026-11-03T12:57:15.498Z"),
			confirmedAt,
			lapsesAt: confirmedAt + LOCK_SERVER_TTL_MS - LEASE_MARGIN_MS
		})
		// Lapsed (or too close to it) by the lift: nothing to tell a release sent again from the TTL by.
		expect(orphanedLease(output, blocked, Date.parse("2026-11-03T12:58:05.000Z"), 10_000)).toBeNull()
		// A release that failed after the lift is not this outage's.
		expect(orphanedLease(output, blocked, Date.parse("2026-11-03T12:57:15.000Z"), 10_000)).toBeNull()
		// Sent (1583 ms before it failed) before the block went in: it may have reached the server.
		expect(orphanedLease(output, Date.parse("2026-11-03T12:57:14.000Z"), lifted, 10_000)).toBeNull()
		expect(orphanedLease(output.split("\n").slice(0, 4).join("\n"), blocked, lifted, 10_000)).toBeNull()
		// No lock request answered before it: no confirmation to date the lease from.
		expect(orphanedLease(output.split("\n").slice(2).join("\n"), blocked, lifted, 10_000)).toBeNull()
	})

	it("tells a release sent again until answered from one whose retries stopped", () => {
		const release = (at: string, text: string) => `native: ${at}  WARN filen_sdk_rs::sync::lock: ${text}`
		const transport = "Error of kind Reqwest: context: v3/user/lock, error: error sending request"
		const retrying = (at: string, pause: string) =>
			release(at, `Failed to release lock drive-write, retrying in ${pause}: ${transport}`)
		const failedAt = Date.parse("2026-11-04T19:09:25.390Z")
		const retried = [
			retrying("2026-11-04T19:09:21.790862Z", "250ms"),
			retrying("2026-11-04T19:09:23.471387Z", "500ms"),
			retrying("2026-11-04T19:09:25.390035Z", "1s")
		]

		// Answered after the lift: nothing more is logged at INFO.
		expect(releaseStopped(retried.join("\n"), failedAt)).toBeNull()
		// Given up once the lease could stand no longer, or unanswered within it.
		const expired = release(
			"2026-11-04T19:10:15.000000Z",
			`Failed to release lock drive-write, the server expires its lease on its own: ${transport}`
		)
		const unanswered = release(
			"2026-11-04T19:10:15.000000Z",
			"Release of lock drive-write unanswered within its lease, the server expires it on its own"
		)

		expect(releaseStopped([...retried, expired].join("\n"), failedAt)).toBe(expired)
		expect(releaseStopped([...retried, unanswered].join("\n"), failedAt)).toBe(unanswered)
		// A release never sent again: its one failure is the last word.
		const once = release("2026-11-04T19:09:25.390035Z", `Failed to release lock drive-write: ${transport}`)

		expect(releaseStopped(once, failedAt)).toBe(once)
		// A stop before the failure that counts is an earlier release's.
		expect(releaseStopped([unanswered.replace("19:10:15", "19:09:20"), ...retried].join("\n"), failedAt)).toBeNull()
	})

	it("matches a failed lock request to its close by id and time, ids restarting with each launch", () => {
		const output = [
			pollFailed("2026-11-03T12:50:00.000000Z", 7),
			poll("2026-11-03T12:50:00.000100Z", 7),
			poll("2026-11-03T12:51:00.000000Z", 7),
			grant("2026-11-03T12:51:00.000200Z", "2.1s")
		].join("\n")

		expect(driveWriteGrants(output)).toEqual([Date.parse("2026-11-03T12:51:00.000Z")])
	})

	it("says whether N was still waiting for drive-write after its last grant", () => {
		expect(
			lockWaitNote(
				[
					poll("2026-11-03T12:57:05.899000Z", 3),
					grant("2026-11-03T12:57:05.900000Z"),
					running("2026-11-03T12:57:56.900000Z", 39_447)
				].join("\n")
			)
		).toBe("N still waiting for drive-write (acquire_lock running 39 s at 2026-11-03T12:57:56.900000Z): another client holds it")
		expect(
			lockWaitNote(
				[
					running("2026-11-03T12:57:56.900000Z", 39_447),
					poll("2026-11-03T12:58:04.990000Z", 9),
					grant("2026-11-03T12:58:05.000000Z")
				].join("\n")
			)
		).toBe("N's log shows no acquire of drive-write still running")
	})

	it("takes what the last pass backoff before a moment still had to run, within a cap", () => {
		const at = Date.parse("2026-11-03T12:57:12.000Z")
		const output = [backoff("2026-11-03T12:56:59.000000Z", 8), backoff("2026-11-03T12:57:03.497000Z", 16)].join("\n")

		expect(residualBackoff(output, at, 60_000)).toBe(7497)
		expect(residualBackoff(output, at, 5000)).toBe(5000)
		// Logged after the moment: not yet a backoff then.
		expect(residualBackoff(backoff("2026-11-03T12:57:13.000000Z", 32), at, 60_000)).toBe(0)
		expect(residualBackoff(backoff("2026-11-03T12:50:00.000000Z", 32), at, 60_000)).toBe(0)
		expect(residualBackoff("", at, 60_000)).toBe(0)
	})

	it("reads what a launch appended to the chain's output since a mark", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "e2e-output-"))
		const file = path.join(dir, "app-output.log")

		try {
			expect(outputMark(file)).toBe(0)
			expect(outputSince(file, 0)).toBe("")
			writeFileSync(file, "before\n")

			const mark = outputMark(file)

			appendFileSync(file, "after µ\n")
			expect(outputSince(file, mark)).toBe("after µ\n")
			expect(outputSince(file, outputMark(file))).toBe("")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("gives a live upload one foreign batch and an orphaned lease on top of the live window", () => {
		expect(LIVE_UPLOAD_MS).toBe(LIVE_TIMEOUT_MS + 60_000 + LOCK_SERVER_TTL_MS)
		expect(DRIVE_LOCK_TIMING.capMs).toBeGreaterThan(LOCK_SERVER_TTL_MS)
	})
})
