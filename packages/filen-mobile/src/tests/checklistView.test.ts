import { describe, it, expect, vi } from "vitest"

// checklistView.ts imports useSecureStore (which pulls native modules). The hook isn't exercised
// here — only the pure visibleChecklistIds filter — so stub the secureStore module.
vi.mock("@/lib/secureStore", () => ({ useSecureStore: vi.fn() }))

import { visibleChecklistIds } from "@/features/notes/checklistView"
import { type Checklist } from "@filen/utils"

const parsed: Checklist = [
	{ id: "a", checked: false, content: "one" },
	{ id: "b", checked: true, content: "two" },
	{ id: "c", checked: false, content: "three" },
	{ id: "d", checked: true, content: "four" }
]
const ids = ["a", "b", "c", "d"]

describe("visibleChecklistIds", () => {
	it("returns the same array reference when hideCompleted is off", () => {
		expect(visibleChecklistIds(ids, parsed, false)).toBe(ids)
	})

	it("drops checked items (preserving order) when hideCompleted is on", () => {
		expect(visibleChecklistIds(ids, parsed, true)).toEqual(["a", "c"])
	})

	it("returns an empty array when every item is checked and hideCompleted is on", () => {
		const allChecked: Checklist = parsed.map(item => ({ ...item, checked: true }))

		expect(visibleChecklistIds(ids, allChecked, true)).toEqual([])
	})

	it("preserves the ids order, not the parsed order, when filtering", () => {
		const reordered = ["c", "a", "d", "b"]

		expect(visibleChecklistIds(reordered, parsed, true)).toEqual(["c", "a"])
	})

	it("keeps ids that have no matching parsed item (treated as not completed)", () => {
		expect(visibleChecklistIds(["a", "b", "x"], parsed, true)).toEqual(["a", "x"])
	})
})
