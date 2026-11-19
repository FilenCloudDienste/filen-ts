import { describe, expect, it } from "vitest"
import {
	acquireInstanceLock,
	appIdentity,
	closeAction,
	idleDestroyDue,
	keepsRendererAlive,
	RELAUNCH_LOCK_RETRY_MS,
	RELAUNCH_LOCK_WAIT_MS,
	rendererGoneAction,
	startsHidden
} from "../main/lifecycle.ts"
import { SHUTDOWN_TIMEOUT_MS } from "../main/native/supervisor.ts"

describe("closeAction", () => {
	it.each([
		["darwin", false, false, "hide"],
		["darwin", false, true, "hide"],
		["win32", false, false, "quit"],
		["linux", false, false, "quit"],
		["win32", false, true, "hide"],
		["linux", false, true, "hide"],
		["darwin", true, false, "close"],
		["win32", true, true, "close"]
	] as const)("%s quitting=%s tray=%s → %s", (platform, quitting, minimizeToTray, expected) => {
		expect(closeAction(platform, quitting, minimizeToTray)).toBe(expected)
	})
})

describe("keepsRendererAlive", () => {
	it("lets an idle page go", () => {
		expect(keepsRendererAlive({ unloadHolds: 0, audioPlaying: false, socketNotifications: false })).toBe(false)
	})

	it.each([
		{ unloadHolds: 2, audioPlaying: false, socketNotifications: false },
		{ unloadHolds: 0, audioPlaying: true, socketNotifications: false },
		{ unloadHolds: 0, audioPlaying: false, socketNotifications: true }
	])("keeps %o", state => {
		expect(keepsRendererAlive(state)).toBe(true)
	})
})

describe("startsHidden", () => {
	it("starts with a window by default", () => {
		expect(startsHidden(["/app/Filen"], false, false)).toBe(false)
	})

	it("starts hidden from the login item, the macOS login launch or the pref", () => {
		expect(startsHidden(["/app/Filen", "--hidden"], false, false)).toBe(true)
		expect(startsHidden(["/app/Filen"], false, true)).toBe(true)
		expect(startsHidden(["/app/Filen"], true, false)).toBe(true)
	})
})

describe("appIdentity", () => {
	it("keeps the packaged app's name and directory", () => {
		expect(appIdentity(true)).toEqual({ name: "Filen", userData: "@filen/desktop" })
	})

	it("gives unpackaged runs their own, so their safeStorage entry is separate", () => {
		expect(appIdentity(false)).toEqual({ name: "Filen Dev", userData: "@filen/desktop-dev" })
	})
})

describe("acquireInstanceLock", () => {
	// A lock freed after `freeAfter` ms on a fake clock that only sleeping advances.
	function context(relaunched: boolean, freeAfter: number) {
		let now = 0
		const sleeps: number[] = []

		return {
			sleeps,
			context: {
				request: () => now >= freeAfter,
				relaunched,
				now: () => now,
				sleep: (ms: number) => {
					sleeps.push(ms)
					now += ms
				}
			}
		}
	}

	it("takes a free lock at once", () => {
		const { context: free, sleeps } = context(true, 0)

		expect(acquireInstanceLock(free)).toEqual({ held: true, attempts: 1, waitedMs: 0 })
		expect(sleeps).toEqual([])
	})

	it("gives up at once when not relaunched by the updater (a second launch)", () => {
		const { context: held, sleeps } = context(false, 1000)

		expect(acquireInstanceLock(held)).toEqual({ held: false, attempts: 1, waitedMs: 0 })
		expect(sleeps).toEqual([])
	})

	it("waits for the quitting instance when relaunched by the updater", () => {
		const { context: quitting, sleeps } = context(true, 1500)

		expect(acquireInstanceLock(quitting)).toEqual({ held: true, attempts: 7, waitedMs: 1500 })
		expect(sleeps.every(ms => ms === RELAUNCH_LOCK_RETRY_MS)).toBe(true)
	})

	it("outwaits the quitting instance's native-host stops", () => {
		// A queued stop, then quit's own, each up to the shutdown timeout, then the teardown and the exit.
		expect(RELAUNCH_LOCK_WAIT_MS).toBeGreaterThan(2 * SHUTDOWN_TIMEOUT_MS)
	})

	it("gives up once the wait is over", () => {
		const { context: stuck } = context(true, Number.POSITIVE_INFINITY)
		const result = acquireInstanceLock(stuck)

		expect(result.held).toBe(false)
		expect(result.waitedMs).toBe(RELAUNCH_LOCK_WAIT_MS)
		expect(result.attempts).toBe(RELAUNCH_LOCK_WAIT_MS / RELAUNCH_LOCK_RETRY_MS + 1)
	})
})

describe("idleDestroyDue", () => {
	const hidden = { visible: false, current: true, unloadHolds: 0, audioPlaying: false, socketNotifications: false }

	it("destroys a hidden window with an idle page", () => {
		expect(idleDestroyDue(hidden)).toBe(true)
	})

	it("keeps a visible window", () => {
		expect(idleDestroyDue({ ...hidden, visible: true })).toBe(false)
	})

	// The same question when the timer fires: the page may have taken up work or the window may be gone meanwhile.
	it.each([
		["shown again", { visible: true }],
		["started audio", { audioPlaying: true }],
		["holds an unload", { unloadHolds: 1 }],
		["owns the notification socket", { socketNotifications: true }],
		["was replaced", { current: false }]
	])("keeps the page at fire time when it %s", (_label, change) => {
		expect(idleDestroyDue(hidden)).toBe(true)
		expect(idleDestroyDue({ ...hidden, ...change })).toBe(false)
	})
})

describe("rendererGoneAction", () => {
	it("ignores a clean exit", () => {
		expect(rendererGoneAction("clean-exit", true, false)).toBe("ignore")
		expect(rendererGoneAction("clean-exit", false, true)).toBe("ignore")
	})

	it("reloads a visible window on its first crash", () => {
		expect(rendererGoneAction("crashed", true, false)).toBe("reload")
		expect(rendererGoneAction("oom", true, false)).toBe("reload")
	})

	it("destroys a window whose reload crashed too", () => {
		expect(rendererGoneAction("crashed", true, true)).toBe("destroy")
	})

	it("destroys a hidden window", () => {
		expect(rendererGoneAction("killed", false, false)).toBe("destroy")
	})
})
