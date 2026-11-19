import { describe, expect, it } from "vitest"
import { createInstance } from "i18next"
import { EN_CATALOGS } from "@/lib/i18n/catalog"
import { activityKeys, bulkResult, progressPercent, runningLine, showsProgress } from "@/lib/activity/activity.logic"

const KEYS = activityKeys("drive:driveTrash")

const name = (item: string): string => `${item}.txt`

describe("activityKeys", () => {
	it("spells the seven keys from one prefix", () => {
		expect(KEYS).toEqual({
			runningNamed: "drive:driveTrashRunningNamed",
			running: "drive:driveTrashRunning",
			doneNamed: "drive:driveTrashDoneNamed",
			done: "drive:driveTrashDone",
			failedNamed: "drive:driveTrashFailedNamed",
			failed: "drive:driveTrashFailed",
			partial: "drive:driveTrashPartial"
		})
	})
})

describe("runningLine", () => {
	it("counts several items, with the action's own values", () => {
		expect(runningLine(KEYS, ["a", "b"], name, { destination: "Photos" })).toEqual({
			key: KEYS.running,
			values: { destination: "Photos", count: 2 }
		})
	})

	it("names a single item through the named key", () => {
		expect(runningLine(KEYS, ["a"], name, { destination: "Photos" })).toEqual({
			key: KEYS.runningNamed,
			values: { destination: "Photos", name: "a.txt" }
		})
	})

	// Russian puts 21 in the plural `one` category: the English catalog registered as "ru" shows which form is picked.
	it("counts 21 items under Russian plural rules instead of naming the first", async () => {
		const i18n = createInstance()

		await i18n.init({ resources: { ru: EN_CATALOGS }, lng: "ru", defaultNS: "common", interpolation: { escapeValue: false } })

		const items = Array.from({ length: 21 }, (_, index) => `item${String(index)}`)
		const running = runningLine(KEYS, items, name)
		const done = bulkResult(KEYS, { succeeded: items, failed: [] }, name)
		const failed = bulkResult(KEYS, { succeeded: [], failed: items.map(item => ({ item, error: "boom" })) }, name)

		for (const line of [running, done?.line, failed?.line]) {
			const text = line === undefined ? "" : i18n.t(line.key, line.values)

			expect(text).toContain("21")
			expect(text).not.toContain("item0.txt")
		}

		const single = runningLine(KEYS, ["a"], name)

		expect(i18n.t(single.key, single.values)).toBe("Moving a.txt to trash")
	})
})

describe("bulkResult", () => {
	it("reports nothing when nothing ran", () => {
		expect(bulkResult(KEYS, { succeeded: [], failed: [] }, name)).toBeNull()
	})

	it("says done when every item succeeded", () => {
		expect(bulkResult(KEYS, { succeeded: ["a", "b"], failed: [] }, name)).toEqual({
			tone: "success",
			line: { key: KEYS.done, values: { count: 2 } },
			failures: []
		})
	})

	it("names the one item done", () => {
		expect(bulkResult(KEYS, { succeeded: ["a"], failed: [] }, name)?.line).toEqual({ key: KEYS.doneNamed, values: { name: "a.txt" } })
	})

	it("says failed, naming the item, when the only item failed", () => {
		const result = bulkResult(KEYS, { succeeded: [], failed: [{ item: "a", error: "boom" }] }, name)

		expect(result?.tone).toBe("error")
		expect(result?.line).toEqual({ key: KEYS.failedNamed, values: { name: "a.txt" } })
		expect(result?.failures).toEqual([{ name: "a.txt", error: "boom" }])
	})

	it("counts every failed item when several failed", () => {
		const result = bulkResult(
			KEYS,
			{
				succeeded: [],
				failed: [
					{ item: "a", error: "boom" },
					{ item: "b", error: "boom" }
				]
			},
			name
		)

		expect(result?.line).toEqual({ key: KEYS.failed, values: { count: 2 } })
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
