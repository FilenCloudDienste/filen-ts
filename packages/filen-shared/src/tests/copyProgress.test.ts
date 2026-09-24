import { describe, expect, it } from "vitest"
import { copyJobPercent, copyJobRate, createCopyJob, isCopyJobRunning, type CopyJob } from "@filen/shared"

type Job = CopyJob<unknown, unknown, unknown, unknown>

function job(overrides: Partial<Job> = {}): Job {
	return { ...createCopyJob("j", { uuid: null, name: "Photos" }, 3), ...overrides }
}

const COPYING: Partial<Job> = { phase: "copyingFiles", totals: { dirs: 0, files: 40, bytes: 1_000 } }

function active(bytesDone: number) {
	return { destUuid: "d", name: "x", size: 500, bytesDone }
}

describe("copyJobPercent", () => {
	it("is indeterminate while the scan still grows the total", () => {
		expect(copyJobPercent(job())).toBeNull()
		expect(copyJobPercent(job({ phase: "copyingFiles" }))).toBeNull()
	})

	// The SDK's bytesDone already counts each chunk as it uploads; the in-flight files are not added again.
	it("is the share of bytes copied once the total is known, in-flight chunks counted once", () => {
		expect(copyJobPercent(job({ ...COPYING, counts: { ...job().counts, bytesDone: 250 } }))).toBe(25)
		expect(copyJobPercent(job({ ...COPYING, counts: { ...job().counts, bytesDone: 250 }, active: [active(50)] }))).toBe(25)
	})

	it("never passes 100", () => {
		expect(copyJobPercent(job({ ...COPYING, counts: { ...job().counts, bytesDone: 1_300 } }))).toBe(100)
	})

	it("is full once done, and frozen where a stopped copy left off", () => {
		expect(copyJobPercent(job({ outcome: { status: "done" } }))).toBe(100)
		expect(copyJobPercent(job({ ...COPYING, counts: { ...job().counts, bytesDone: 500 }, outcome: { status: "cancelled" } }))).toBe(50)
	})
})

describe("copyJobRate", () => {
	it("gives speed and seconds left only while bytes move", () => {
		expect(copyJobRate(job({ ...COPYING, bytesPerSecond: 2_000, etaMs: 1_500 }))).toEqual({ bytesPerSecond: 2_000, etaSeconds: 2 })
		expect(copyJobRate(job({ ...COPYING, bytesPerSecond: 2_000, etaMs: null }))).toEqual({ bytesPerSecond: 2_000, etaSeconds: null })
		expect(copyJobRate(job({ ...COPYING, bytesPerSecond: null }))).toBeNull()
		expect(copyJobRate(job({ ...COPYING, bytesPerSecond: 0 }))).toBeNull()
		expect(copyJobRate(job({ ...COPYING, bytesPerSecond: 2_000, paused: true }))).toBeNull()
		expect(copyJobRate(job({ ...COPYING, bytesPerSecond: 2_000, pausing: true }))).toBeNull()
		expect(copyJobRate(job({ bytesPerSecond: 2_000, outcome: { status: "done" } }))).toBeNull()
	})
})

describe("isCopyJobRunning", () => {
	it("is true only until the job settles", () => {
		expect(isCopyJobRunning(job())).toBe(true)
		expect(isCopyJobRunning(job({ outcome: { status: "cancelled" } }))).toBe(false)
	})
})
