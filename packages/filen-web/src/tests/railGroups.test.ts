import { describe, expect, it } from "vitest"
import { activeRailChild, bubbleRailDot, railChildActive, railGroupTarget } from "@/features/shell/lib/railGroups.logic"
import { transfersRingState } from "@/features/transfers/screens/transfers.logic"
import type { Transfer } from "@/features/transfers/store/useTransfersStore"

function transfer(overrides: Partial<Transfer> = {}): Transfer {
	return {
		id: "t1",
		direction: "upload",
		name: "file.txt",
		size: 100,
		bytesTransferred: 0,
		status: "uploading",
		paused: false,
		parentUuid: null,
		startedAt: 0,
		...overrides
	}
}

describe("railChildActive", () => {
	it("matches the single-page children exactly", () => {
		expect(railChildActive("photos", "/photos")).toBe(true)
		expect(railChildActive("playlists", "/playlists")).toBe(true)
		expect(railChildActive("photos", "/photos/x")).toBe(false)
	})

	it("covers the nested routes of the children that have them", () => {
		expect(railChildActive("videos", "/videos")).toBe(true)
		expect(railChildActive("videos", "/videos/library/abc")).toBe(true)
		expect(railChildActive("videos", "/videosx")).toBe(false)
		expect(railChildActive("sync", "/sync/1")).toBe(true)
		expect(railChildActive("sync", "/syncx")).toBe(false)
		expect(railChildActive("mounts", "/mounts/webdav")).toBe(true)
		expect(railChildActive("mounts", "/mountsx")).toBe(false)
	})
})

describe("activeRailChild", () => {
	it("is the child the path is in", () => {
		expect(activeRailChild("media", "/videos/watch/abc")).toBe("videos")
		expect(activeRailChild("media", "/playlists")).toBe("playlists")
		expect(activeRailChild("computer", "/sync/pair-1")).toBe("sync")
		expect(activeRailChild("computer", "/mounts")).toBe("mounts")
	})

	it("is null outside the group", () => {
		expect(activeRailChild("media", "/sync/pair-1")).toBeNull()
		expect(activeRailChild("computer", "/photos")).toBeNull()
		expect(activeRailChild("media", "/drive")).toBeNull()
	})
})

describe("railGroupTarget", () => {
	it("goes to the child used last", () => {
		expect(railGroupTarget("media", "playlists")).toBe("playlists")
		expect(railGroupTarget("computer", "mounts")).toBe("mounts")
	})

	it("goes to the first child before any was used or while the store is read", () => {
		expect(railGroupTarget("media", null)).toBe("photos")
		expect(railGroupTarget("media", undefined)).toBe("photos")
		expect(railGroupTarget("computer", null)).toBe("sync")
	})

	it("ignores a stored value that is not one of the group's children", () => {
		expect(railGroupTarget("media", "sync")).toBe("photos")
		expect(railGroupTarget("computer", "removed")).toBe("sync")
	})
})

describe("bubbleRailDot", () => {
	it("shows the most urgent child dot", () => {
		expect(bubbleRailDot(["busy", "attention"])).toBe("attention")
		expect(bubbleRailDot([null, "busy"])).toBe("busy")
		expect(bubbleRailDot(["attention", null])).toBe("attention")
	})

	it("shows nothing while no child does", () => {
		expect(bubbleRailDot([null, null])).toBeNull()
		expect(bubbleRailDot([])).toBeNull()
	})
})

describe("transfersRingState", () => {
	it("is hidden with no transfers, except on the transfers screen", () => {
		expect(transfersRingState([], false).visible).toBe(false)
		expect(transfersRingState([], true)).toEqual({ visible: true, empty: true, activeCount: 0, percent: 0, failed: false })
	})

	it("shows the aggregate progress of the active transfers", () => {
		expect(
			transfersRingState(
				[
					transfer({ id: "a", size: 100, bytesTransferred: 50 }),
					transfer({ id: "b", size: 300, bytesTransferred: 50, status: "downloading" }),
					transfer({ id: "c", size: 1000, bytesTransferred: 1000, status: "done" })
				],
				false
			)
		).toEqual({ visible: true, empty: false, activeCount: 2, percent: 25, failed: false })
	})

	it("leaves a transfer of unknown size out of the progress", () => {
		expect(
			transfersRingState([transfer({ id: "a", size: 100, bytesTransferred: 40 }), transfer({ id: "z", size: 0 })], false).percent
		).toBe(40)
	})

	it("stays while finished transfers are not cleared, full once nothing is active", () => {
		expect(transfersRingState([transfer({ status: "done", bytesTransferred: 100 })], false)).toEqual({
			visible: true,
			empty: false,
			activeCount: 0,
			percent: 100,
			failed: false
		})
	})

	it("marks a failure, whole or partial, while it stays listed", () => {
		expect(transfersRingState([transfer({ status: "error" })], false).failed).toBe(true)
		expect(transfersRingState([transfer({ status: "completedWithErrors", direction: "copy" })], false).failed).toBe(true)
		expect(transfersRingState([transfer({ id: "a" }), transfer({ id: "b", status: "error" })], false)).toMatchObject({
			activeCount: 1,
			failed: true
		})
	})
})
