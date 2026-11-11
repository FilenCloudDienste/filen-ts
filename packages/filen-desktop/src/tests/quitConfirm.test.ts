import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { createSessionEnd, shouldConfirmQuit, unloadGuardAsks } from "../main/quitConfirm.ts"

const idle = { unloadHolds: 0, nativeTransfers: 0, installingUpdate: false, confirmed: false, sessionEnding: false }

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

	it("never holds an OS session end", () => {
		expect(shouldConfirmQuit({ ...idle, nativeTransfers: 2, sessionEnding: true })).toBe(false)
	})
})

describe("unloadGuardAsks", () => {
	it("asks unless an update installs or the OS session ends", () => {
		expect(unloadGuardAsks({ installingUpdate: false, sessionEnding: false })).toBe(true)
		expect(unloadGuardAsks({ installingUpdate: true, sessionEnding: false })).toBe(false)
		expect(unloadGuardAsks({ installingUpdate: false, sessionEnding: true })).toBe(false)
	})
})

describe("createSessionEnd", () => {
	it("is not ending until an event fires", () => {
		const sessionEnd = createSessionEnd(vi.fn())

		sessionEnd.watchPowerMonitor(new EventEmitter())
		sessionEnd.watchWindow(new EventEmitter())
		expect(sessionEnd.ending()).toBe(false)
	})

	it("ends on powerMonitor's shutdown (macOS, Linux)", () => {
		const onEnd = vi.fn()
		const sessionEnd = createSessionEnd(onEnd)
		const powerMonitor = new EventEmitter()

		sessionEnd.watchPowerMonitor(powerMonitor)
		powerMonitor.emit("shutdown")
		expect(sessionEnd.ending()).toBe(true)
		expect(onEnd).toHaveBeenCalledWith("shutdown")
	})

	it("ends on a window's session-end (Windows), reporting once", () => {
		const onEnd = vi.fn()
		const sessionEnd = createSessionEnd(onEnd)
		const first = new EventEmitter()
		const second = new EventEmitter()

		sessionEnd.watchWindow(first)
		sessionEnd.watchWindow(second)
		first.emit("session-end", { reasons: ["logoff"] })
		second.emit("session-end", { reasons: ["logoff"] })
		expect(sessionEnd.ending()).toBe(true)
		expect(onEnd).toHaveBeenCalledTimes(1)
		expect(onEnd).toHaveBeenCalledWith("session-end")
	})
})
