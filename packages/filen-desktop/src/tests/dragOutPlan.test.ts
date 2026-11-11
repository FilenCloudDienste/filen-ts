import { describe, expect, it } from "vitest"
import { type DragPlanLimits, planEntries, STAGED_LIMITS, WINDOWS_LIMITS } from "../main/dragOut/plan.ts"
import type { NativeTreeEntry } from "../shared/nativeProtocol.ts"

const UNLIMITED: DragPlanLimits = { maxEntries: 10_000, maxBytes: null, maxRelativePathUnits: null }

function file(segments: string[], size = 1, source = 0, listIndex: number | null = null): NativeTreeEntry {
	return { segments, directory: false, size, mtimeMs: 1_000, listIndex, source }
}

function dir(segments: string[], source = 0): NativeTreeEntry {
	return { segments, directory: true, size: 0, mtimeMs: null, listIndex: null, source }
}

function paths(entries: readonly NativeTreeEntry[], limits: DragPlanLimits, platform: "darwin" | "win32" | "linux"): string[] {
	const plan = planEntries(entries, limits, platform)

	if ("refused" in plan) {
		throw new Error(`refused: ${plan.refused.reason}`)
	}

	return plan.entries.map(entry => entry.relativePath)
}

describe("planEntries", () => {
	it("a:b and a_b in one directory become a_b and a_b (1) on win32", () => {
		expect(paths([dir(["d"]), file(["d", "a:b"]), file(["d", "a_b"])], UNLIMITED, "win32")).toEqual(["d", "d\\a_b", "d\\a_b (1)"])
	})

	it("a, a and a (1) become a, a (2) and a (1)", () => {
		expect(paths([file(["a"], 1, 0), file(["a"], 1, 1), file(["a (1)"], 1, 2)], UNLIMITED, "linux")).toEqual(["a", "a (2)", "a (1)"])
	})

	it("keeps the extension and the kind when it suffixes", () => {
		expect(paths([file(["x.txt"], 1, 0), file(["X.txt"], 1, 1), dir(["x.txt"], 2)], UNLIMITED, "darwin")).toEqual([
			"x.txt",
			"X (1).txt",
			"x.txt (1)"
		])
	})

	it("reserved names get the suffix on win32 only", () => {
		const entries = [file(["CON"], 1, 0), file(["nul.txt"], 1, 1)]

		expect(paths(entries, UNLIMITED, "win32")).toEqual(["CON_", "nul_.txt"])
		expect(paths(entries, UNLIMITED, "linux")).toEqual(["CON", "nul.txt"])
	})

	it("names nested segments through their renamed parents", () => {
		expect(paths([dir(["a:b"]), dir(["a:b", "c?"]), file(["a:b", "c?", "e"])], UNLIMITED, "win32")).toEqual([
			"a_b",
			"a_b\\c_",
			"a_b\\c_\\e"
		])
		expect(paths([dir(["a/b"]), file(["a/b", "e"])], UNLIMITED, "linux")).toEqual(["a_b", "a_b/e"])
	})

	it("parents precede children", () => {
		expect(paths([file(["d", "e", "f"]), file(["d", "g"]), dir(["d", "e"]), dir(["d"])], UNLIMITED, "linux")).toEqual([
			"d",
			"d/g",
			"d/e",
			"d/e/f"
		])
	})

	it("keeps empty directories", () => {
		const plan = planEntries([dir(["d"]), dir(["d", "empty"])], UNLIMITED, "linux")

		expect(plan).toEqual({
			entries: [
				{ relativePath: "d", directory: true, size: 0, mtimeMs: null, listIndex: null, source: 0 },
				{ relativePath: "d/empty", directory: true, size: 0, mtimeMs: null, listIndex: null, source: 0 }
			]
		})
	})

	it("259 units pass and 260 are refused with the offending path", () => {
		// "ddd\e\" is 6 units.
		const tree = (name: string) => [dir(["ddd"]), dir(["ddd", "e"]), file(["ddd", "e", name])]

		expect(paths(tree("a".repeat(253)), WINDOWS_LIMITS, "win32")).toEqual(["ddd", "ddd\\e", `ddd\\e\\${"a".repeat(253)}`])
		expect(planEntries(tree("a".repeat(254)), WINDOWS_LIMITS, "win32")).toEqual({
			refused: { reason: "pathTooLong", path: `ddd\\e\\${"a".repeat(254)}` }
		})
		expect(paths(tree("a".repeat(254)), STAGED_LIMITS, "linux")).toHaveLength(3)
	})

	it("counts UTF-16 units, not characters", () => {
		// 63 astral characters: 126 UTF-16 units (252 UTF-8 bytes); with the 135-unit parent, 198 characters but 261 units.
		const parent = "d".repeat(134)
		const astral = "😀".repeat(63)

		expect(planEntries([dir([parent]), file([parent, astral])], WINDOWS_LIMITS, "win32")).toEqual({
			refused: { reason: "pathTooLong", path: `${parent}\\${astral}` }
		})
		expect(paths([dir([parent]), file([parent, "😀".repeat(62)])], WINDOWS_LIMITS, "win32")).toHaveLength(2)
	})

	it("refuses past the entry cap and past the byte cap", () => {
		const many = Array.from({ length: 2_001 }, (_, index) => file([`f${index}`], 1, index))

		expect(planEntries(many, STAGED_LIMITS, "linux")).toEqual({ refused: { reason: "tooMany", entries: 2_001, limit: 2_000 } })
		expect(planEntries(many.slice(0, 2_000), STAGED_LIMITS, "linux")).toEqual({ entries: expect.any(Array) as unknown })

		const half = 256 * 1024 ** 2

		expect(planEntries([file(["a"], half, 0), dir(["d"], 1), file(["d", "b"], half + 1, 1)], STAGED_LIMITS, "linux")).toEqual({
			refused: { reason: "tooLarge", bytes: 2 * half + 1, limit: 512 * 1024 ** 2 }
		})
		expect(planEntries([file(["a"], half, 0), file(["b"], half, 1)], STAGED_LIMITS, "linux")).toEqual({
			entries: expect.any(Array) as unknown
		})
	})

	it("keeps a null mtime and the listIndex", () => {
		const entry: NativeTreeEntry = { segments: ["d", "f"], directory: false, size: 7, mtimeMs: null, listIndex: 4, source: 3 }

		expect(planEntries([dir(["d"], 3), entry], UNLIMITED, "darwin")).toEqual({
			entries: [
				{ relativePath: "d", directory: true, size: 0, mtimeMs: null, listIndex: null, source: 3 },
				{ relativePath: "d/f", directory: false, size: 7, mtimeMs: null, listIndex: 4, source: 3 }
			]
		})
	})
})
