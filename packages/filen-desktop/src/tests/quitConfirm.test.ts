import { describe, expect, it } from "vitest"
import { shouldConfirmQuit } from "../main/quitConfirm.ts"

const idle = { unloadHolds: 0, nativeTransfers: 0, installingUpdate: false, confirmed: false }

describe("shouldConfirmQuit", () => {
	it("confirms with native transfers and no page holds", () => {
		expect(shouldConfirmQuit({ ...idle, nativeTransfers: 2 })).toBe(true)
		expect(shouldConfirmQuit(idle)).toBe(false)
	})

	it("leaves the confirm to the page's unload guard while it holds something", () => {
		expect(shouldConfirmQuit({ ...idle, nativeTransfers: 2, unloadHolds: 1 })).toBe(false)
	})

	it("does not confirm while installing an update after the user agreed", () => {
		expect(shouldConfirmQuit({ ...idle, nativeTransfers: 2, installingUpdate: true })).toBe(false)
	})

	it("does not confirm twice after the user confirmed", () => {
		expect(shouldConfirmQuit({ ...idle, nativeTransfers: 2, confirmed: true })).toBe(false)
	})
})
