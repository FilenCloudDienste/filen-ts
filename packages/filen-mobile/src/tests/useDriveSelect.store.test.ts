import { vi, describe, it, expect, beforeEach } from "vitest"

// The store only depends on zustand + the (type-only) DriveItem import — stub the SDK so the
// type-only import chain never evaluates it.
vi.mock("@filen/sdk-rs", () => ({}))

import useDriveSelectStore, { selectDriveSelectSelection } from "@/features/drive/store/useDriveSelect.store"
import type { DriveItem } from "@/types"

function makeDriveItem(uuid: string): DriveItem {
	return {
		type: "file",
		data: {
			uuid
		}
	} as unknown as DriveItem
}

beforeEach(() => {
	useDriveSelectStore.setState({ sessions: {} })
})

function selection(sessionId: string | undefined): string[] {
	return selectDriveSelectSelection(useDriveSelectStore.getState(), sessionId).map(i => i.data.uuid)
}

describe("useDriveSelectStore select sessions", () => {
	it("opening a session seeds its selection with the preselection", () => {
		useDriveSelectStore.getState().openSession("session-1", [], [makeDriveItem("a")])

		expect(selection("session-1")).toEqual(["a"])
	})

	it("a session opened without a preselection starts empty", () => {
		useDriveSelectStore.getState().openSession("session-1", [makeDriveItem("x")])

		expect(selection("session-1")).toEqual([])
	})

	it("sessions keep separate selections", () => {
		useDriveSelectStore.getState().openSession("session-1", [])
		useDriveSelectStore.getState().openSession("session-2", [], [makeDriveItem("b")])
		useDriveSelectStore.getState().setSelectedItems("session-1", prev => [...prev, makeDriveItem("a")])

		expect(selection("session-1")).toEqual(["a"])
		expect(selection("session-2")).toEqual(["b"])

		// Closing one session never touches another's selection.
		useDriveSelectStore.getState().closeSession("session-1")

		expect(selection("session-1")).toEqual([])
		expect(selection("session-2")).toEqual(["b"])
	})

	it("setting the selection of a closed or unknown session changes nothing", () => {
		const before = useDriveSelectStore.getState()

		useDriveSelectStore.getState().setSelectedItems("gone", [makeDriveItem("a")])

		expect(useDriveSelectStore.getState()).toBe(before)
		expect(selection("gone")).toEqual([])
	})

	it("a missing session or id reads as one stable empty selection", () => {
		const state = useDriveSelectStore.getState()

		expect(selectDriveSelectSelection(state, undefined)).toBe(selectDriveSelectSelection(state, "missing"))
	})

	it("updating the selection keeps the session's items", () => {
		const item = makeDriveItem("x")

		useDriveSelectStore.getState().openSession("session-1", [item])

		const { items, itemUuids } = useDriveSelectStore.getState().sessions["session-1"] ?? {}

		useDriveSelectStore.getState().setSelectedItems("session-1", [makeDriveItem("a")])

		expect(useDriveSelectStore.getState().sessions["session-1"]?.items).toBe(items)
		expect(useDriveSelectStore.getState().sessions["session-1"]?.itemUuids).toBe(itemUuids)
	})
})
