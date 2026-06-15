import { describe, it, expect, beforeEach } from "vitest"
import { useDriveSearchStore } from "@/features/drive/store/useDriveSearch.store"

describe("useDriveSearchStore", () => {
	beforeEach(() => {
		useDriveSearchStore.setState({ resyncing: false, rootDeleted: false, cacheUnavailable: false })
	})

	it("defaults to all-false", () => {
		const state = useDriveSearchStore.getState()

		expect(state.resyncing).toBe(false)
		expect(state.rootDeleted).toBe(false)
		expect(state.cacheUnavailable).toBe(false)
	})

	it("toggles resyncing", () => {
		useDriveSearchStore.getState().setResyncing(true)

		expect(useDriveSearchStore.getState().resyncing).toBe(true)
	})

	it("toggles rootDeleted and cacheUnavailable independently", () => {
		useDriveSearchStore.getState().setRootDeleted(true)

		expect(useDriveSearchStore.getState().rootDeleted).toBe(true)
		expect(useDriveSearchStore.getState().cacheUnavailable).toBe(false)

		useDriveSearchStore.getState().setCacheUnavailable(true)

		expect(useDriveSearchStore.getState().cacheUnavailable).toBe(true)
		expect(useDriveSearchStore.getState().rootDeleted).toBe(true)
	})
})
