import { describe, expect, it } from "vitest"
import { activityKeys, bulkResult, progressPercent, runningLine, showsProgress } from "@/lib/activity/activity.logic"

const KEYS = activityKeys("drive:driveTrash")

const name = (item: string): string => `${item}.txt`

describe("activityKeys", () => {
	it("spells the four keys from one prefix", () => {
		expect(KEYS).toEqual({
			running: "drive:driveTrashRunning",
			done: "drive:driveTrashDone",
			failed: "drive:driveTrashFailed",
			partial: "drive:driveTrashPartial"
		})
	})
})

describe("runningLine", () => {
	it("names the first item and counts them all, with the action's own values", () => {
		expect(runningLine(KEYS, ["a", "b"], name, { destination: "Photos" })).toEqual({
			key: KEYS.running,
			values: { destination: "Photos", count: 2, name: "a.txt" }
		})
	})
})

describe("bulkResult", () => {
	it("reports nothing when nothing ran", () => {
		expect(bulkResult(KEYS, { succeeded: [], failed: [] }, name)).toBeNull()
	})

	it("says done when every item succeeded", () => {
		expect(bulkResult(KEYS, { succeeded: ["a", "b"], failed: [] }, name)).toEqual({
			tone: "success",
			line: { key: KEYS.done, values: { count: 2, name: "a.txt" } },
			failures: []
		})
	})

	it("says failed, naming the first, when every item failed", () => {
		const result = bulkResult(KEYS, { succeeded: [], failed: [{ item: "a", error: "boom" }] }, name)

		expect(result?.tone).toBe("error")
		expect(result?.line).toEqual({ key: KEYS.failed, values: { count: 1, name: "a.txt" } })
		expect(result?.failures).toEqual([{ name: "a.txt", error: "boom" }])
	})

	it("counts both sides of a partial run", () => {
		const result = bulkResult(KEYS, { succeeded: ["a", "b"], failed: [{ item: "c", error: "boom" }] }, name)

		expect(result?.line).toEqual({ key: KEYS.partial, values: { count: 2, failed: 1 } })
	})
})

describe("progress", () => {
	it("turns a count or a fraction into a bounded percent", () => {
		expect(progressPercent({ kind: "count", settled: 3, total: 12 })).toBe(25)
		expect(progressPercent({ kind: "count", settled: 0, total: 0 })).toBe(0)
		expect(progressPercent({ kind: "fraction", value: 1.2 })).toBe(100)
	})

	it("shows a count only for several items", () => {
		expect(showsProgress(undefined)).toBe(false)
		expect(showsProgress({ kind: "count", settled: 0, total: 1 })).toBe(false)
		expect(showsProgress({ kind: "count", settled: 0, total: 2 })).toBe(true)
		expect(showsProgress({ kind: "fraction", value: 0 })).toBe(true)
	})
})
