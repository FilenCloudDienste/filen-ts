import { vi, describe, it, expect, beforeEach } from "vitest"

// The store only depends on zustand + the (type-only) DriveItem import — stub the SDK so the
// type-only import chain never evaluates it.
vi.mock("@filen/sdk-rs", () => ({}))

import useDriveSelectStore from "@/features/drive/store/useDriveSelect.store"
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
	useDriveSelectStore.getState().endSelectSession()
})

describe("useDriveSelectStore select sessions", () => {
	it("seeds the initial selection on the session's first screen", () => {
		useDriveSelectStore.getState().seedSelectSession("session-1", [makeDriveItem("a")])

		expect(useDriveSelectStore.getState().selectedItems.map(i => i.data.uuid)).toEqual(["a"])
		expect(useDriveSelectStore.getState().seededSelectId).toBe("session-1")
	})

	it("a later screen of the SAME session never reseeds — accumulated selection survives subfolder navigation", () => {
		useDriveSelectStore.getState().seedSelectSession("session-1", [])
		useDriveSelectStore.getState().setSelectedItems([makeDriveItem("a")])

		// Browsing into a subfolder mounts another screen which seeds with the same session id.
		useDriveSelectStore.getState().seedSelectSession("session-1", [])

		expect(useDriveSelectStore.getState().selectedItems.map(i => i.data.uuid)).toEqual(["a"])
	})

	it("a NEW session id reseeds, replacing the previous session's selection", () => {
		useDriveSelectStore.getState().seedSelectSession("session-1", [])
		useDriveSelectStore.getState().setSelectedItems([makeDriveItem("a")])

		useDriveSelectStore.getState().seedSelectSession("session-2", [makeDriveItem("b")])

		expect(useDriveSelectStore.getState().selectedItems.map(i => i.data.uuid)).toEqual(["b"])
		expect(useDriveSelectStore.getState().seededSelectId).toBe("session-2")
	})

	it("endSelectSession clears both the selection and the session marker", () => {
		useDriveSelectStore.getState().seedSelectSession("session-1", [makeDriveItem("a")])
		useDriveSelectStore.getState().endSelectSession()

		expect(useDriveSelectStore.getState().selectedItems).toEqual([])
		expect(useDriveSelectStore.getState().seededSelectId).toBeNull()

		// The next session (even with a reused id) seeds fresh.
		useDriveSelectStore.getState().seedSelectSession("session-1", [makeDriveItem("c")])

		expect(useDriveSelectStore.getState().selectedItems.map(i => i.data.uuid)).toEqual(["c"])
	})
})
