import { describe, expect, it } from "vitest"
import { copyJobPercent, copyJobRate, createCopyJob, effectiveBytesDone, isCopyJobRunning, type CopyJob } from "@filen/shared"

type Job = CopyJob<unknown, unknown, unknown, unknown>

function job(overrides: Partial<Job> = {}): Job {
	return { ...createCopyJob("j", { uuid: null, name: "Photos" }, 3), ...overrides }
}

const COPYING: Partial<Job> = { phase: "copyingFiles", totals: { dirs: 0, files: 40, bytes: 1_000 } }

function active(bytesDone: number) {
	return { destUuid: "d", name: "x", size: 500, bytesDone }
}

describe("effectiveBytesDone", () => {
	it("adds the files in flight to the finished bytes", () => {
		expect(effectiveBytesDone({ bytesDone: 100 }, [active(20), active(30)])).toBe(150)
	})

	it("is the finished bytes with nothing in flight", () => {
		expect(effectiveBytesDone({ bytesDone: 100 }, [])).toBe(100)
	})
})

describe("copyJobPercent", () => {
	it("is indeterminate while the scan still grows the total", () => {
		expect(copyJobPercent(job())).toBeNull()
		expect(copyJobPercent(job({ phase: "copyingFiles" }))).toBeNull()
	})

	it("is the share of bytes copied once the total is known, the files in flight included", () => {
		expect(copyJobPercent(job({ ...COPYING, counts: { ...job().counts, bytesDone: 250 } }))).toBe(25)
		expect(copyJobPercent(job({ ...COPYING, counts: { ...job().counts, bytesDone: 250 }, active: [active(50)] }))).toBe(30)
	})

	it("never passes 100", () => {
		expect(copyJobPercent(job({ ...COPYING, counts: { ...job().counts, bytesDone: 900 }, active: [active(400)] }))).toBe(100)
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
