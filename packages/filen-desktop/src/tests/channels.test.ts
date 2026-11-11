import { describe, expect, it } from "vitest"
import {
	CHANNELS,
	DRAG_CALLS,
	dragChannel,
	FILE_PROVIDER_CALLS,
	fileProviderChannel,
	MOUNTS_CALLS,
	mountsChannel,
	SYNC_CALLS,
	syncChannel,
	TRANSFERS_CALLS,
	transfersChannel
} from "../shared/channels.ts"

describe("channels", () => {
	it("drag channel names are unique against SYNC_CALLS, MOUNTS_CALLS, FILE_PROVIDER_CALLS and TRANSFERS_CALLS", () => {
		const names = [
			...Object.values(CHANNELS),
			...SYNC_CALLS.map(syncChannel),
			...MOUNTS_CALLS.map(mountsChannel),
			...FILE_PROVIDER_CALLS.map(fileProviderChannel),
			...TRANSFERS_CALLS.map(transfersChannel),
			...DRAG_CALLS.map(dragChannel)
		]

		expect(DRAG_CALLS).toEqual(["prepare", "begin", "release"])
		expect(CHANNELS.dragState).toBe("drag:state")
		expect(new Set(names).size).toBe(names.length)
	})
})
