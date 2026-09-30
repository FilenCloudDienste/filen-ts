import { describe, expect, it } from "vitest"
import { ancestryHits, type ParentLookup } from "@filen/shared"

describe("ancestryHits", () => {
	// root > p > a > child > grandchild; `a` is the moved directory.
	const parents = new Map<string, string | null>([
		["p", null],
		["a", "p"],
		["child", "a"],
		["grandchild", "child"]
	])
	const parentOf: ParentLookup = uuid => parents.get(uuid)
	const moved = new Set(["a"])

	it("finds a moved directory anywhere up the walked chain, the target itself included", () => {
		expect(ancestryHits("a", moved, parentOf)).toBe(true)
		expect(ancestryHits("grandchild", moved, parentOf)).toBe(true)
	})

	it("clears a chain that reaches the top without passing one", () => {
		expect(ancestryHits("p", moved, parentOf)).toBe(false)
	})

	it("is unresolved where a link is missing, loops, or runs too deep", () => {
		expect(ancestryHits("orphan", moved, parentOf)).toBe("unresolved")
		expect(ancestryHits("loop", moved, uuid => (uuid === "loop" ? "loop" : undefined))).toBe("unresolved")
		expect(ancestryHits("x0", moved, uuid => `x${String(Number(uuid.slice(1)) + 1)}`)).toBe("unresolved")
	})
})
