import { describe, it, expect } from "vitest"
import { pruneSelectionByUuid } from "@/features/audio/store/usePlaylists.store"

// ---------------------------------------------------------------------------
// #AU-15 — stale-selection purge for the playlists / playlist screens.
//
// pruneSelectionByUuid is the pure core wired into both screens' refetch
// reconciliation effects: given the current selection and the freshest live
// items, it drops any selected item whose uuid is no longer present so a
// pull-to-refresh that removes a remotely-deleted, still-selected
// playlist/track also removes it from the selection (honest header count, no
// phantom bulk-op target). The same helper covers both selection stores
// because playlists and tracks share the same uuid identity model.
// ---------------------------------------------------------------------------

type Selected = { uuid: string; name: string }

const selected: Selected[] = [
	{ uuid: "a", name: "alpha" },
	{ uuid: "b", name: "beta" },
	{ uuid: "c", name: "gamma" }
]

describe("pruneSelectionByUuid — #AU-15 selection ghost purge", () => {
	it("drops selected items whose uuid is gone from the live list", () => {
		// "b" was deleted remotely and is no longer in the refetched data.
		const live = [{ uuid: "a" }, { uuid: "c" }]
		const kept = pruneSelectionByUuid(selected, live)

		expect(kept).toHaveLength(2)
		expect(kept.map(item => item.uuid)).toEqual(["a", "c"])
	})

	it("drops every selected item when the live list is empty", () => {
		expect(pruneSelectionByUuid(selected, [])).toEqual([])
	})

	it("returns the SAME array reference when nothing changed (no-op store write)", () => {
		// All selected uuids still present (live also has an extra "d").
		const live = [{ uuid: "a" }, { uuid: "b" }, { uuid: "c" }, { uuid: "d" }]
		const kept = pruneSelectionByUuid(selected, live)

		expect(kept).toBe(selected)
	})

	it("returns the SAME reference for an empty selection regardless of live items", () => {
		const empty: Selected[] = []

		expect(pruneSelectionByUuid(empty, [{ uuid: "a" }])).toBe(empty)
		expect(pruneSelectionByUuid(empty, [])).toBe(empty)
	})

	it("does not mutate the input selection when pruning", () => {
		const input: Selected[] = [
			{ uuid: "x", name: "x" },
			{ uuid: "y", name: "y" }
		]
		const live = [{ uuid: "x" }]
		const kept = pruneSelectionByUuid(input, live)

		expect(input).toHaveLength(2)
		expect(kept).toHaveLength(1)
		expect(kept[0]).toMatchObject({ uuid: "x" })
	})

	it("matches by uuid, not object reference (live items may be fresh copies)", () => {
		// The refetched live items are different object identities with the same uuids —
		// the surviving selected item must be retained by uuid, not reference equality.
		const live = [
			{ uuid: "a", name: "alpha-refetched" },
			{ uuid: "b", name: "beta-refetched" },
			{ uuid: "c", name: "gamma-refetched" }
		]
		const kept = pruneSelectionByUuid(selected, live)

		expect(kept).toBe(selected)
	})

	it("preserves the original order of the kept selection", () => {
		const live = [{ uuid: "c" }, { uuid: "a" }, { uuid: "b" }]
		const kept = pruneSelectionByUuid(selected, live)

		expect(kept.map(item => item.uuid)).toEqual(["a", "b", "c"])
	})
})
