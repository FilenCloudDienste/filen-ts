import { describe, expect, it } from "vitest"
import {
	acquireDriveLock,
	DRIVE_WRITE,
	type LockAnswer,
	lockAnswerOf,
	type LockPost,
	type LockType
} from "../../scripts/ci/e2e/driveLock.ts"
import { allWaiting, offlineFailure } from "../../scripts/ci/e2e/chains/offlineListing.ts"
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

	it("names a pair still waiting for the cloud as the regression", () => {
		expect(offlineFailure(sample(1, 2, 0))).toBe(
			"1 of 3 pairs still waiting for the cloud: the listing's wait does not notice the lost network (the regression)"
		)
		expect(offlineFailure(sample(0, 2, 1))).toBe("1 of 3 pairs in error instead of offline")
		expect(offlineFailure(sample(0, 2, 0))).toBe("2 of 3 pairs offline")
	})
})
