import { describe, it, expect, vi } from "vitest"

// checklistView.ts imports useSecureStore (which pulls native modules). The hook isn't exercised
// here — only the pure visibleChecklistIds filter — so stub the secureStore module.
vi.mock("@/lib/secureStore", () => ({ useSecureStore: vi.fn() }))

import { visibleChecklistIds, isChecklistGhostActive, checklistGhostRowId } from "@/features/notes/checklistView"
import { type Checklist } from "@filen/shared"

const parsed: Checklist = [
	{ id: "a", checked: false, content: "one" },
	{ id: "b", checked: true, content: "two" },
	{ id: "c", checked: false, content: "three" },
	{ id: "d", checked: true, content: "four" }
]

describe("visibleChecklistIds", () => {
	it("returns every id in parsed order when hideCompleted is off", () => {
		expect(visibleChecklistIds(parsed, false)).toEqual(["a", "b", "c", "d"])
	})

	it("drops checked items (preserving order) when hideCompleted is on", () => {
		expect(visibleChecklistIds(parsed, true)).toEqual(["a", "c"])
	})

	it("returns an empty array when every item is checked and hideCompleted is on", () => {
		const allChecked: Checklist = parsed.map(item => ({ ...item, checked: true }))

		expect(visibleChecklistIds(allChecked, true)).toEqual([])
	})

	it("returns an empty array for an unhydrated (empty) checklist", () => {
		expect(visibleChecklistIds([], false)).toEqual([])
	})
})

// ── #80 ghost row ────────────────────────────────────────────────────────────

describe("isChecklistGhostActive", () => {
	it("activates only for an editable, hydrated, fully-hidden list", () => {
		expect(isChecklistGhostActive(true, 0, true, false)).toBe(true)
	})

	it("never activates while visible rows exist (normal hide-completed editing)", () => {
		expect(isChecklistGhostActive(true, 2, true, false)).toBe(false)
	})

	it("never activates with hide-completed off, even for an empty visible set", () => {
		expect(isChecklistGhostActive(true, 0, false, false)).toBe(false)
	})

	it("never activates read-only (nothing is editable there anyway)", () => {
		expect(isChecklistGhostActive(true, 0, true, true)).toBe(false)
	})

	it("never activates on the pre-hydration mount frame (store not yet seeded) — no one-frame ghost flash", () => {
		expect(isChecklistGhostActive(false, 0, true, false)).toBe(false)
	})
})

describe("checklistGhostRowId", () => {
	const seed = "mount-seed"

	it("is stable while no ghost has materialized", () => {
		const parsed: Checklist = [{ id: "a", checked: true, content: "done" }]

		expect(checklistGhostRowId(seed, parsed)).toBe("mount-seed-ghost-0")
		expect(checklistGhostRowId(seed, parsed)).toBe("mount-seed-ghost-0")
	})

	it("derives a FRESH id after a materialized ghost stays in the list (e.g. it got checked off)", () => {
		const parsed: Checklist = [
			{ id: "a", checked: true, content: "done" },
			{ id: "mount-seed-ghost-0", checked: true, content: "typed then checked" }
		]

		expect(checklistGhostRowId(seed, parsed)).toBe("mount-seed-ghost-1")
	})

	it("REUSES the id after a materialized ghost is backspaced away — same React key, focused input survives", () => {
		const before: Checklist = [
			{ id: "a", checked: true, content: "done" },
			{ id: "mount-seed-ghost-0", checked: false, content: "" }
		]
		const afterRemoval = before.filter(i => i.id !== "mount-seed-ghost-0")

		expect(checklistGhostRowId(seed, afterRemoval)).toBe("mount-seed-ghost-0")
	})

	it("ignores other mounts' ghost ids (per-mount seed prefix)", () => {
		const parsed: Checklist = [{ id: "other-seed-ghost-0", checked: false, content: "x" }]

		expect(checklistGhostRowId(seed, parsed)).toBe("mount-seed-ghost-0")
	})
})
