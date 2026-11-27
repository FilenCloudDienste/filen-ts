import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Type } from "arktype"

const { stored, writes } = vi.hoisted(() => ({ stored: new Map<string, unknown>(), writes: [] as unknown[] }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string, schema: Type) => {
		const value = stored.get(key)

		return Promise.resolve(value === undefined || schema(value) instanceof Error ? null : value)
	},
	kvSetJson: (key: string, value: unknown) => {
		stored.set(key, structuredClone(value))
		writes.push(value)

		return Promise.resolve()
	}
}))

const KEY = "media.videoResume.v1"
const FILE = { stableUuid: "s1", uuid: "u1", size: 1_000 }
const HOUR = 3_600

type VideoResume = typeof import("@/lib/media/videoResume")
type VideoContinuity = typeof import("@/features/preview/lib/videoContinuity")

// A fresh module per test: the store and its one-shot load are module state, as they are per page.
async function load(): Promise<{ resume: VideoResume; continuity: VideoContinuity }> {
	vi.resetModules()

	const resume = await import("@/lib/media/videoResume")
	const continuity = await import("@/features/preview/lib/videoContinuity")

	await resume.loadVideoResume()

	return { resume, continuity }
}

async function settle(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
}

beforeEach(() => {
	stored.clear()
	writes.length = 0
})

describe("video resume across sessions", () => {
	it("remembers a long video left partway and gives the position back in a later session", async () => {
		const first = await load()

		first.resume.recordVideoResume(FILE, 754, HOUR, false)
		await settle()

		const second = await load()

		expect(second.resume.videoResumeAt(FILE)).toBe(754)
	})

	it("keeps nothing for a short video, one barely started or one near its end", async () => {
		const { resume } = await load()

		resume.recordVideoResume(FILE, 100, 200, false)
		resume.recordVideoResume({ ...FILE, stableUuid: "s2" }, 30, HOUR, false)
		resume.recordVideoResume({ ...FILE, stableUuid: "s3" }, HOUR - 60, HOUR, false)
		await settle()

		expect(resume.videoResumeAt(FILE)).toBeUndefined()
		expect(resume.videoResumeAt({ ...FILE, stableUuid: "s2" })).toBeUndefined()
		expect(resume.videoResumeAt({ ...FILE, stableUuid: "s3" })).toBeUndefined()
		expect(writes).toEqual([])
	})

	it("forgets a video once it was watched to the end", async () => {
		const { resume } = await load()

		resume.recordVideoResume(FILE, 600, HOUR, false)
		resume.recordVideoResume(FILE, HOUR, HOUR, true)
		await settle()

		expect(resume.videoResumeAt(FILE)).toBeUndefined()
		expect(stored.get(KEY)).toEqual([])
	})

	it("starts a replaced file of another size from the top, keeping a new version of the same size", async () => {
		const { resume } = await load()

		resume.recordVideoResume(FILE, 900, HOUR, false)

		expect(resume.videoResumeAt({ ...FILE, uuid: "u2" })).toBe(900)
		expect(resume.videoResumeAt({ ...FILE, uuid: "u2", size: 2_000 })).toBeUndefined()
	})

	it("keeps the most recent entries up to the cap", async () => {
		const { resume } = await load()

		for (let index = 0; index <= resume.VIDEO_RESUME_CAP; index++) {
			resume.recordVideoResume({ stableUuid: `s${String(index)}`, uuid: `u${String(index)}`, size: 1 }, 600, HOUR, false)
		}

		// The first one written went; touching the second kept it past the next write.
		expect(resume.videoResumeAt({ stableUuid: "s0", uuid: "u0", size: 1 })).toBeUndefined()

		resume.recordVideoResume({ stableUuid: "s1", uuid: "u1", size: 1 }, 700, HOUR, false)
		resume.recordVideoResume({ stableUuid: "late", uuid: "late", size: 1 }, 600, HOUR, false)

		expect(resume.videoResumeAt({ stableUuid: "s1", uuid: "u1", size: 1 })).toBe(700)
		expect(resume.videoResumeAt({ stableUuid: "s2", uuid: "u2", size: 1 })).toBeUndefined()
		await settle()
		expect((stored.get(KEY) as unknown[]).length).toBe(resume.VIDEO_RESUME_CAP)
	})

	it("drops a stored value of the wrong shape", async () => {
		stored.set(KEY, [["s1", "u1"]])

		const { resume } = await load()

		expect(resume.videoResumeAt(FILE)).toBeUndefined()
	})
})

describe("the preview's continuity over the resume store", () => {
	it("starts a bound video where an earlier session left it, and says it resumed", async () => {
		const first = await load()

		first.continuity.bindVideoResume("u1", FILE)
		first.continuity.clearVideoPlaybackStates()
		// The overlay's clear runs before the player's unmount records where it stopped.
		first.continuity.setVideoPosition("u1", 754, HOUR)
		await settle()

		const second = await load()

		expect(second.continuity.videoStartTime("u1")).toEqual({ seconds: 0, resumed: false })

		second.continuity.bindVideoResume("u1", FILE)

		expect(second.continuity.videoStartTime("u1")).toEqual({ seconds: 754, resumed: true })
	})

	it("prefers where this session left it", async () => {
		const { continuity } = await load()

		continuity.bindVideoResume("u1", FILE)
		continuity.setVideoPosition("u1", 754, HOUR)

		expect(continuity.videoStartTime("u1")).toEqual({ seconds: 754, resumed: false })
	})

	it("forgets a bound video that ran to its end", async () => {
		const { continuity, resume } = await load()

		continuity.bindVideoResume("u1", FILE)
		continuity.setVideoPosition("u1", 754, HOUR)
		continuity.setVideoPosition("u1", 0, HOUR)

		expect(resume.videoResumeAt(FILE)).toBeUndefined()
	})

	it("keeps an unbound video (another surface's player) to the session", async () => {
		const { continuity, resume } = await load()

		continuity.setVideoPosition("videoEdit:u1", 754, HOUR)

		expect(resume.videoResumeAt(FILE)).toBeUndefined()
		expect(writes).toEqual([])
	})
})
