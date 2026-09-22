import { describe, it, expect } from "vitest"
import { dirnameOf, pathSegmentDepth } from "@filen/shared"

describe("dirnameOf", () => {
	it("returns the containing directory", () => {
		expect(dirnameOf("a/b/c.txt")).toBe("a/b")
	})

	it("returns null for a top-level entry with no ancestor", () => {
		expect(dirnameOf("a.txt")).toBe(null)
	})

	it("handles leading-slash paths without assuming the convention", () => {
		expect(dirnameOf("/a/b")).toBe("/a")
		expect(dirnameOf("/a")).toBe("")
	})
})

describe("pathSegmentDepth", () => {
	it("matches split(\"/\").length for representative inputs", () => {
		const inputs = ["", "a", "a/b/c", "/a/b"]

		for (const input of inputs) {
			expect(pathSegmentDepth(input)).toBe(input.split("/").length)
		}
	})

	it("returns the expected depth for representative inputs", () => {
		expect(pathSegmentDepth("")).toBe(1)
		expect(pathSegmentDepth("a")).toBe(1)
		expect(pathSegmentDepth("a/b/c")).toBe(3)
		expect(pathSegmentDepth("/a/b")).toBe(3)
	})
})
