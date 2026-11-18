import { describe, expect, it } from "vitest"
import { skippedFileIndexes } from "../preload/skippedIndexes.ts"

describe("skippedFileIndexes", () => {
	it("maps main's path indexes to File indexes and merges them with the Files without a path, sorted", () => {
		// Files 1 and 3 had no path; paths 0..2 are Files 0, 2 and 4, and main skipped paths 2 and 0.
		expect(skippedFileIndexes(5, [0, 2, 4], [1, 3], [2, 0], false)).toEqual([0, 1, 3, 4])
	})

	it("answers only the Files without a path when main skipped none", () => {
		expect(skippedFileIndexes(3, [0, 2], [1], [], false)).toEqual([1])
	})

	it("drops a main index outside the sent paths", () => {
		expect(skippedFileIndexes(2, [1], [0], [5], false)).toEqual([0])
	})

	it("skips every File as a directory when main skipped the directory", () => {
		expect(skippedFileIndexes(4, [], [], [0], true)).toEqual([0, 1, 2, 3])
	})

	it("skips no File as a directory when main skipped nothing", () => {
		expect(skippedFileIndexes(4, [], [], [], true)).toEqual([])
	})
})
